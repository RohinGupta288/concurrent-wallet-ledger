/**
 * runInTransaction(work): run `work(session)` inside a MongoDB multi-document
 * transaction, with a BOUNDED number of retries.
 *
 * Why retries are needed
 * ----------------------
 * MongoDB does not make one transaction wait for another. If two transactions
 * try to change the same document (e.g. two transfers from the same wallet),
 * the second one fails immediately with a "WriteConflict" error that carries
 * the label "TransientTransactionError". Such an error means "nothing was
 * applied; it is safe to run the whole transaction again". On the retry the
 * transaction sees the other transfer's committed result (e.g. the lower
 * balance) and decides again.
 *
 * Commit outcome unknown
 * ----------------------
 * If the network fails during commit, the driver reports
 * "UnknownTransactionCommitResult": the commit may or may not have happened.
 * Re-sending the commit is safe (it cannot apply twice), so we retry it a few
 * times. If we still cannot tell, we give up with 503 and the client retries
 * the HTTP request with the SAME idempotency key: if the first attempt did
 * commit, the key is already used and the stored result is replayed; if not,
 * the transfer runs normally. Either way the money moves at most once.
 *
 * Rules for `work`
 * ----------------
 * - Pass `{ session }` to every database call, or it runs outside the
 *   transaction.
 * - Do nothing except database work (no emails, no HTTP calls), because `work`
 *   may run several times.
 * - Throw to abort. An AppError (e.g. INSUFFICIENT_FUNDS) is passed through
 *   unchanged and never retried.
 *
 * Unlike the driver's session.withTransaction(), which keeps retrying for up
 * to 120 seconds, this loop is limited by TXN_MAX_ATTEMPTS (default 10).
 */
const mongoose = require("mongoose")
const AppError = require("../utils/AppError")
const logger = require("../utils/logger")
const { config } = require("./env")

const MAX_COMMIT_ATTEMPTS = 3

function hasErrorLabel(err, label) {
    if (!err) return false
    if (typeof err.hasErrorLabel === "function") return err.hasErrorLabel(label)
    return Array.isArray(err.errorLabels) && err.errorLabels.includes(label)
}

function retryExhaustedError() {
    return new AppError(
        503,
        "TRANSACTION_RETRY_EXHAUSTED",
        "The database was too busy to complete this request. It was either not applied, " +
        "or its outcome is unknown. Retry with the same idempotency key."
    )
}

/** Random wait that grows with each attempt: up to 50, 100, 200, 400, 800, then 1000 ms. */
function backoff(attempt) {
    const maxDelayMs = Math.min(1000, 25 * 2 ** attempt)
    return new Promise((resolve) => setTimeout(resolve, Math.random() * maxDelayMs))
}

async function commitWithRetry(session) {
    for (let commitAttempt = 1; ; commitAttempt++) {
        try {
            await session.commitTransaction()
            return
        } catch (err) {
            const unknown = hasErrorLabel(err, "UnknownTransactionCommitResult")
            if (unknown && commitAttempt < MAX_COMMIT_ATTEMPTS) {
                logger.warn("txn.commit_retry", { commitAttempt, reason: err.codeName || err.message })
                continue
            }
            throw err
        }
    }
}

async function runInTransaction(work, { maxAttempts = config.txnMaxAttempts } = {}) {
    const session = await mongoose.startSession()
    try {
        for (let attempt = 1; ; attempt++) {
            session.startTransaction({
                readConcern: { level: "snapshot" }, // every read sees one consistent point in time
                writeConcern: { w: "majority" },    // committed data survives a primary failover
            })

            try {
                const result = await work(session)
                await commitWithRetry(session)
                return result
            } catch (err) {
                if (session.inTransaction()) {
                    await session.abortTransaction().catch(() => {})
                }

                if (hasErrorLabel(err, "TransientTransactionError")) {
                    if (attempt < maxAttempts) {
                        logger.info("txn.retry", { attempt, reason: err.codeName || err.message })
                        await backoff(attempt)
                        continue
                    }
                    logger.warn("txn.retry_exhausted", { attempts: attempt, reason: err.codeName || err.message })
                    throw retryExhaustedError()
                }
                if (hasErrorLabel(err, "UnknownTransactionCommitResult")) {
                    logger.warn("txn.commit_outcome_unknown", { reason: err.codeName || err.message })
                    throw retryExhaustedError()
                }
                throw err
            }
        }
    } finally {
        await session.endSession()
    }
}

module.exports = { runInTransaction, hasErrorLabel }
