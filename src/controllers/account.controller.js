/**
 * Wallet endpoints (/api/accounts).
 *
 * A user can only ever see their own wallet. Asking for someone else's wallet
 * returns 404 (not 403) so the API does not reveal which wallet ids exist.
 *
 * There is deliberately no endpoint to add money or to freeze a wallet; those
 * are development scripts (scripts/fund-wallet.js, scripts/set-wallet-status.js).
 */
const accountModel = require("../models/account.model")
const AppError = require("../utils/AppError")
const { isObjectIdString } = require("../utils/validators")

/** The fields a client may see. Balance is an integer number of paise. */
function toPublicAccount(account) {
    return {
        id: String(account._id),
        currency: account.currency,
        balance: account.balance,
        status: account.status,
        createdAt: account.createdAt,
    }
}

/** Loads a wallet owned by the current user, or throws 400/404. */
async function findOwnWallet(req) {
    const { accountId } = req.params
    if (!isObjectIdString(accountId)) {
        throw new AppError(400, "INVALID_ID", "accountId must be a 24-character hex id")
    }
    const account = await accountModel.findOne({ _id: accountId, type: "WALLET", user: req.user._id })
    if (!account) {
        throw new AppError(404, "WALLET_NOT_FOUND", "Wallet not found")
    }
    return account
}

/** POST /api/accounts - create the current user's single INR wallet. */
async function createAccountController(req, res) {
    try {
        const account = await accountModel.create({ type: "WALLET", user: req.user._id })
        res.status(201).json({ account: toPublicAccount(account) })
    } catch (err) {
        // The unique index "one_wallet_per_user" decides, even when two
        // requests arrive at the same moment.
        if (err.code === 11000) {
            throw new AppError(409, "WALLET_EXISTS", "You already have a wallet")
        }
        throw err
    }
}

/** GET /api/accounts - the current user's wallets (zero or one). */
async function getUserAccountsController(req, res) {
    const accounts = await accountModel.find({ type: "WALLET", user: req.user._id })
    res.status(200).json({ accounts: accounts.map(toPublicAccount) })
}

/** GET /api/accounts/:accountId */
async function getAccountController(req, res) {
    const account = await findOwnWallet(req)
    res.status(200).json({ account: toPublicAccount(account) })
}

/** GET /api/accounts/balance/:accountId */
async function getAccountBalanceController(req, res) {
    const account = await findOwnWallet(req)
    res.status(200).json({
        accountId: String(account._id),
        balance: account.balance,
        currency: account.currency,
    })
}

module.exports = {
    createAccountController,
    getUserAccountsController,
    getAccountController,
    getAccountBalanceController,
}
