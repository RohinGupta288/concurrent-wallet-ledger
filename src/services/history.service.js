/**
 * Transaction history for the current user's wallet.
 *
 * A user only ever sees transactions in which their own wallet is the source
 * or the destination. Asking for any other transaction id returns 404.
 *
 * Responses show the other side only as a wallet id (counterpartyAccountId),
 * never the other user's name, email or user id.
 */
const accountModel = require("../models/account.model")
const transactionModel = require("../models/transaction.model")
const AppError = require("../utils/AppError")

/**
 * One transaction as seen from `walletId`:
 *   direction DEBIT  = money left my wallet
 *   direction CREDIT = money arrived in my wallet
 */
function toHistoryItem(transaction, walletId) {
    const outgoing = String(transaction.fromAccount) === String(walletId)
    return {
        transactionId: String(transaction._id),
        type: transaction.type,
        direction: outgoing ? "DEBIT" : "CREDIT",
        amount: transaction.amount,
        currency: "INR",
        status: transaction.status,
        counterpartyAccountId: String(outgoing ? transaction.toAccount : transaction.fromAccount),
        createdAt: transaction.createdAt,
    }
}

function involving(walletId) {
    return { $or: [ { fromAccount: walletId }, { toAccount: walletId } ] }
}

async function findUserWallet(userId) {
    return accountModel.findOne({ type: "WALLET", user: userId })
}

/**
 * Newest first. Ties on createdAt (same millisecond) are broken by _id, so the
 * order is always the same and pages never overlap.
 */
async function listHistory({ userId, page, limit }) {
    const wallet = await findUserWallet(userId)
    if (!wallet) {
        return { items: [], page, limit, total: 0, totalPages: 0 }
    }

    const filter = involving(wallet._id)
    const [ transactions, total ] = await Promise.all([
        transactionModel.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        transactionModel.countDocuments(filter),
    ])

    return {
        items: transactions.map((t) => toHistoryItem(t, wallet._id)),
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
    }
}

/** Detail of one transaction, only if the user's wallet took part in it. */
async function getTransactionForUser({ userId, transactionId }) {
    const wallet = await findUserWallet(userId)
    const transaction = wallet && await transactionModel
        .findOne({ _id: transactionId, ...involving(wallet._id) })
        .lean()
    if (!transaction) {
        throw new AppError(404, "TRANSACTION_NOT_FOUND", "Transaction not found")
    }

    const detail = {
        ...toHistoryItem(transaction, wallet._id),
        fromAccount: String(transaction.fromAccount),
        toAccount: String(transaction.toAccount),
    }
    // The idempotency key is the sender's own label; only the sender sees it.
    if (transaction.initiatedBy && String(transaction.initiatedBy) === String(userId)) {
        detail.idempotencyKey = transaction.idempotencyKey
    }
    return detail
}

module.exports = { listHistory, getTransactionForUser, toHistoryItem }
