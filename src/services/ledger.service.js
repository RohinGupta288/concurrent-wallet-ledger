/**
 * The one place where money moves: postDoubleEntry().
 *
 * Both transfers (transfer.service.js) and development funding
 * (funding.service.js) call it, so every money movement follows the same rules.
 * It must run inside runInTransaction() (src/config/transaction.js): either all
 * five writes below happen, or none of them do.
 *
 *   1. insert the transaction record
 *   2. insert the DEBIT ledger entry  } one insertMany
 *   3. insert the CREDIT ledger entry }
 *   4. debit the source balance    (guarded: never below 0 for a wallet)
 *   5. credit the destination      (guarded: wallet must be ACTIVE and below the cap)
 *
 * Why the guarded update prevents double spending
 * ----------------------------------------------
 * Step 4 is a single conditional update:
 *     updateOne({ _id, status: "ACTIVE", balance: { $gte: amount } },
 *               { $inc: { balance: -amount } })
 * The check and the change happen together inside the database. Two
 * concurrent transfers from the same wallet both write this one document, and
 * MongoDB allows only one transaction to change a document at a time: the
 * other gets a WriteConflict and is retried by runInTransaction(). The retry
 * sees the new, lower balance, so the condition fails and the transfer is
 * rejected with INSUFFICIENT_FUNDS. A balance can therefore never go negative.
 *
 * The SYSTEM_FUNDING account is the single exception: it is debited without
 * the balance condition, because it represents money entering the simulation
 * and its balance is meant to be negative (minus the total funded).
 */
const crypto = require("crypto")
const accountModel = require("../models/account.model")
const transactionModel = require("../models/transaction.model")
const ledgerModel = require("../models/ledger.model")
const AppError = require("../utils/AppError")
const { MAX_BALANCE_PAISE } = require("../utils/money")

/**
 * Fingerprint of what an idempotency key was used for. Reusing a key with a
 * different type, source, destination or amount is detected by comparing it.
 */
function computeRequestHash({ type, fromAccount, toAccount, amount }) {
    return crypto.createHash("sha256")
        .update(`${type}|${fromAccount}|${toAccount}|${amount}`)
        .digest("hex")
}

/**
 * Looks up an earlier transaction that used the same idempotency key.
 * Returns null if the key is unused, the stored transaction if it was used for
 * the same request, and throws 409 if it was used for a different request.
 */
async function findIdempotentReplay(session, { initiatedBy, idempotencyKey, requestHash }) {
    const existing = await transactionModel
        .findOne({ initiatedBy, idempotencyKey })
        .session(session)
    if (!existing) return null
    if (existing.requestHash !== requestHash) {
        throw new AppError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "This idempotency key was already used for a different request"
        )
    }
    return existing
}

/**
 * Moves `amount` paise from `source` to `destination` (both account documents
 * loaded in this session) and records it. Returns the new transaction document.
 */
async function postDoubleEntry(session, { type, source, destination, amount, initiatedBy, idempotencyKey, requestHash }) {
    // The inserts come first and the two balance updates last. Inside a
    // transaction the order does not change the result (all or nothing), but
    // it shortens the time this transaction "owns" the balance documents that
    // concurrent transfers compete for, so fewer of them conflict and retry.

    // The transaction record. Its unique (initiatedBy, idempotencyKey) index
    // is the final guard against the same key being applied twice.
    const [ transaction ] = await transactionModel.create([ {
        type,
        fromAccount: source._id,
        toAccount: destination._id,
        amount,
        initiatedBy,
        idempotencyKey,
        requestHash,
    } ], { session })

    // Exactly one DEBIT and one CREDIT with the same amount.
    await ledgerModel.insertMany([
        { account: source._id, transaction: transaction._id, type: "DEBIT", amount },
        { account: destination._id, transaction: transaction._id, type: "CREDIT", amount },
    ], { session })

    // Debit the source: check and change in ONE database operation.
    const debitFilter = { _id: source._id, status: "ACTIVE" }
    if (source.type === "WALLET") {
        debitFilter.balance = { $gte: amount }
    }
    const debit = await accountModel.updateOne(debitFilter, { $inc: { balance: -amount } }, { session })
    if (debit.modifiedCount !== 1) {
        // The caller already checked status and balance in this same snapshot,
        // so this is a safety net; throwing aborts all the writes above.
        throw new AppError(422, "INSUFFICIENT_FUNDS", "Insufficient funds in the source wallet")
    }

    // Credit the destination.
    const credit = await accountModel.updateOne(
        { _id: destination._id, type: "WALLET", status: "ACTIVE", balance: { $lte: MAX_BALANCE_PAISE - amount } },
        { $inc: { balance: amount } },
        { session }
    )
    if (credit.modifiedCount !== 1) {
        throw new AppError(422, "BALANCE_LIMIT_EXCEEDED", "The destination wallet cannot hold this amount")
    }

    return transaction
}

/** The fields of a transaction a client may see. */
function toPublicTransaction(transaction) {
    return {
        id: String(transaction._id),
        type: transaction.type,
        fromAccount: String(transaction.fromAccount),
        toAccount: String(transaction.toAccount),
        amount: transaction.amount,
        currency: "INR",
        status: transaction.status,
        idempotencyKey: transaction.idempotencyKey,
        createdAt: transaction.createdAt,
    }
}

module.exports = {
    computeRequestHash,
    findIdempotentReplay,
    postDoubleEntry,
    toPublicTransaction,
}
