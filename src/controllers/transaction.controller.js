/**
 * Transaction endpoints (/api/transactions).
 *
 * Controllers stay thin: validate the request, call a service, shape the
 * response. The money logic lives in src/services/.
 */
const AppError = require("../utils/AppError")
const { validateTransfer, validatePagination, isObjectIdString } = require("../utils/validators")
const { transfer } = require("../services/transfer.service")
const { toPublicTransaction } = require("../services/ledger.service")
const { listHistory, getTransactionForUser } = require("../services/history.service")

/**
 * POST /api/transactions
 * Body: { fromAccount, toAccount, amount (integer paise), idempotencyKey }
 *
 * 201 - transfer completed now
 * 200 - same idempotency key and same request as an earlier completed
 *       transfer: the stored result is returned and no money moves
 *       (`idempotentReplay: true`)
 */
async function createTransaction(req, res) {
    const input = validateTransfer(req.body)
    const { transaction, replay } = await transfer({ userId: req.user._id, ...input })

    res.locals.transactionId = String(transaction._id) // picked up by the request logger
    res.status(replay ? 200 : 201).json({
        transaction: toPublicTransaction(transaction),
        idempotentReplay: replay,
    })
}

/** GET /api/transactions?page=1&limit=20 - my wallet's history, newest first. */
async function listTransactions(req, res) {
    const { page, limit } = validatePagination(req.query)
    const history = await listHistory({ userId: req.user._id, page, limit })
    res.status(200).json(history)
}

/** GET /api/transactions/:transactionId - one transaction my wallet took part in. */
async function getTransaction(req, res) {
    const { transactionId } = req.params
    if (!isObjectIdString(transactionId)) {
        throw new AppError(400, "INVALID_ID", "transactionId must be a 24-character hex id")
    }
    const transaction = await getTransactionForUser({ userId: req.user._id, transactionId })
    res.locals.transactionId = transaction.transactionId
    res.status(200).json({ transaction })
}

module.exports = {
    createTransaction,
    listTransactions,
    getTransaction,
}
