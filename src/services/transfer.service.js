/**
 * Wallet-to-wallet transfers.
 *
 * transfer() runs every check and every write inside ONE database transaction
 * (runInTransaction), so a transfer is all-or-nothing:
 *
 *   1. Idempotency: was this key already used by this user?
 *        same request      -> return the stored transaction (a "replay")
 *        different request -> 409 IDEMPOTENCY_KEY_REUSED
 *   2. The source must be the caller's own wallet          (else 403)
 *   3. The destination must be an existing wallet          (else 404)
 *   4. Both wallets must be ACTIVE                          (else 422 WALLET_FROZEN)
 *   5. The source must hold at least `amount`              (else 422 INSUFFICIENT_FUNDS)
 *   6. postDoubleEntry(): transaction record, DEBIT + CREDIT entries and both
 *      balance updates (ledger.service.js)
 *
 * Steps 1-5 read from the transaction's snapshot. If another transfer changes
 * one of these wallets before we commit, MongoDB reports a write conflict,
 * runInTransaction() starts again from step 1, and the checks are repeated
 * against the new data. So a check can never be based on a stale balance.
 *
 * Nothing is stored for a failed transfer, so its idempotency key stays unused
 * and the client may safely retry with it.
 */
const accountModel = require("../models/account.model")
const transactionModel = require("../models/transaction.model")
const { runInTransaction } = require("../config/transaction")
const AppError = require("../utils/AppError")
const { computeRequestHash, findIdempotentReplay, postDoubleEntry } = require("./ledger.service")

/**
 * @param {object} input  validated by validateTransfer() (src/utils/validators.js)
 * @returns {Promise<{ transaction, replay: boolean }>}
 */
async function transfer({ userId, fromAccount, toAccount, amount, idempotencyKey }) {
    const requestHash = computeRequestHash({ type: "TRANSFER", fromAccount, toAccount, amount })

    try {
        return await runInTransaction(async (session) => {
            const replay = await findIdempotentReplay(session, { initiatedBy: userId, idempotencyKey, requestHash })
            if (replay) return { transaction: replay, replay: true }

            // Ownership comes from the JWT (userId), never from the request body.
            const source = await accountModel
                .findOne({ _id: fromAccount, type: "WALLET", user: userId })
                .session(session)
            if (!source) {
                throw new AppError(403, "SOURCE_WALLET_NOT_OWNED", "fromAccount must be your own wallet")
            }

            const destination = await accountModel
                .findOne({ _id: toAccount, type: "WALLET" })
                .session(session)
            if (!destination) {
                throw new AppError(404, "DESTINATION_WALLET_NOT_FOUND", "Destination wallet not found")
            }

            if (source.status !== "ACTIVE") {
                throw new AppError(422, "WALLET_FROZEN", "Your wallet is frozen", { account: "fromAccount" })
            }
            if (destination.status !== "ACTIVE") {
                throw new AppError(422, "WALLET_FROZEN", "The destination wallet is frozen", { account: "toAccount" })
            }
            if (source.balance < amount) {
                throw new AppError(422, "INSUFFICIENT_FUNDS", "Insufficient funds in your wallet")
            }

            const transaction = await postDoubleEntry(session, {
                type: "TRANSFER",
                source,
                destination,
                amount,
                initiatedBy: userId,
                idempotencyKey,
                requestHash,
            })
            return { transaction, replay: false }
        })
    } catch (err) {
        // Safety net for a duplicate-key error on the idempotency index (another
        // request with the same key won the race): answer like a replay.
        if (err.code === 11000 && err.keyPattern && err.keyPattern.idempotencyKey) {
            const existing = await transactionModel.findOne({ initiatedBy: userId, idempotencyKey })
            if (existing && existing.requestHash === requestHash) {
                return { transaction: existing, replay: true }
            }
            throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different request")
        }
        throw err
    }
}

module.exports = { transfer }
