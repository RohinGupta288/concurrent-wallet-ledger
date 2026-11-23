/**
 * Development-only funding: how simulated money enters the system.
 *
 * There is no HTTP endpoint for this. Only the scripts in scripts/ call it,
 * and they refuse to run when NODE_ENV=production.
 *
 * Funding is an ordinary double-entry transaction of type FUNDING:
 *     DEBIT  SYSTEM_FUNDING   (its balance goes further below 0)
 *     CREDIT the user's wallet
 * so the sum of all balances stays exactly 0 and reconciliation can check
 * funding with the same rules as transfers.
 *
 * Each funding needs an idempotency key, so running a script twice with the
 * same key does not add the money twice. Funding keys belong to no user
 * (initiatedBy = null).
 */
const accountModel = require("../models/account.model")
const { runInTransaction } = require("../config/transaction")
const AppError = require("../utils/AppError")
const { isValidAmount } = require("../utils/money")
const { isObjectIdString, isValidIdempotencyKey, validationError, AMOUNT_RULE, IDEMPOTENCY_KEY_RULE } = require("../utils/validators")
const { computeRequestHash, findIdempotentReplay, postDoubleEntry } = require("./ledger.service")

/**
 * Returns the single SYSTEM_FUNDING account, creating it the first time.
 * The unique index "one_system_funding_account" guarantees there is only one
 * even if two scripts run at the same moment.
 */
async function getOrCreateSystemAccount() {
    try {
        return await accountModel.findOneAndUpdate(
            { type: "SYSTEM_FUNDING" },
            { $setOnInsert: { type: "SYSTEM_FUNDING", status: "ACTIVE", currency: "INR", balance: 0 } },
            { upsert: true, new: true }
        )
    } catch (err) {
        // Two simultaneous upserts: one inserted, the other hit the unique index.
        if (err.code === 11000) return accountModel.findOne({ type: "SYSTEM_FUNDING" })
        throw err
    }
}

/**
 * Adds `amount` paise to a wallet. Returns { transaction, created }, where
 * created is false when this idempotency key had already been applied.
 */
async function fundWallet({ walletId: rawWalletId, amount, idempotencyKey }) {
    const walletId = String(rawWalletId).toLowerCase() // accepts an ObjectId or a string
    const errors = {}
    if (!isObjectIdString(walletId)) errors.walletId = "walletId must be a wallet id"
    if (!isValidAmount(amount)) errors.amount = AMOUNT_RULE
    if (!isValidIdempotencyKey(idempotencyKey)) errors.idempotencyKey = IDEMPOTENCY_KEY_RULE
    if (Object.keys(errors).length > 0) throw validationError(errors)

    const system = await getOrCreateSystemAccount()
    const requestHash = computeRequestHash({
        type: "FUNDING", fromAccount: system._id, toAccount: walletId, amount,
    })

    return runInTransaction(async (session) => {
        const replay = await findIdempotentReplay(session, { initiatedBy: null, idempotencyKey, requestHash })
        if (replay) return { transaction: replay, created: false }

        const wallet = await accountModel.findOne({ _id: walletId, type: "WALLET" }).session(session)
        if (!wallet) throw new AppError(404, "WALLET_NOT_FOUND", "Wallet not found")
        if (wallet.status !== "ACTIVE") {
            throw new AppError(422, "WALLET_FROZEN", "The wallet is frozen")
        }
        const source = await accountModel.findById(system._id).session(session)

        const transaction = await postDoubleEntry(session, {
            type: "FUNDING",
            source,
            destination: wallet,
            amount,
            initiatedBy: null,
            idempotencyKey,
            requestHash,
        })
        return { transaction, created: true }
    })
}

module.exports = { fundWallet, getOrCreateSystemAccount }
