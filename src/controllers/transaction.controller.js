/**
 * Transaction endpoints (/api/transactions).
 *
 * Controllers stay thin: validate the request, call a service, shape the
 * response. The money logic lives in src/services/.
 */
const { validateTransfer } = require("../utils/validators")
const { transfer } = require("../services/transfer.service")
const { toPublicTransaction } = require("../services/ledger.service")

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

module.exports = {
    createTransaction,
}
