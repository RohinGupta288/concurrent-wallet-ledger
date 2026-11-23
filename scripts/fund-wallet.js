/**
 * npm run fund -- --email alice@example.com --amount 2500 --key topup-alice-001
 *
 * Adds simulated money (in rupees, up to 2 decimals) to a user's wallet.
 * Development only. Re-running with the same --key does nothing the second
 * time; using the same --key with a different amount or wallet is rejected.
 */
const { parseArgs } = require("node:util")
const userModel = require("../src/models/user.model")
const accountModel = require("../src/models/account.model")
const { fundWallet } = require("../src/services/funding.service")
const { parseRupees, formatPaise } = require("../src/utils/money")
const { normalizeEmail } = require("../src/utils/validators")
const { runScript } = require("./script-helpers")

const USAGE = "Usage: npm run fund -- --email <email> --amount <rupees> --key <idempotency-key>"

runScript(async () => {
    const { values } = parseArgs({
        options: { email: { type: "string" }, amount: { type: "string" }, key: { type: "string" } },
    })
    const email = normalizeEmail(values.email)
    const amount = parseRupees(values.amount ?? "")
    if (!email || amount === null || !values.key) {
        console.error(USAGE)
        return 1
    }

    const user = await userModel.findOne({ email })
    const wallet = user && await accountModel.findOne({ type: "WALLET", user: user._id })
    if (!wallet) {
        console.error(`No wallet found for ${email}. Register and create a wallet first (or run npm run seed).`)
        return 1
    }

    const { transaction, created } = await fundWallet({ walletId: wallet._id, amount, idempotencyKey: values.key })
    const fresh = await accountModel.findById(wallet._id)
    console.log(created
        ? `Funded ${formatPaise(amount)} to ${email} (transaction ${transaction._id}).`
        : `Key "${values.key}" was already applied (transaction ${transaction._id}); nothing changed.`)
    console.log(`Wallet balance: ${formatPaise(fresh.balance)}`)
})
