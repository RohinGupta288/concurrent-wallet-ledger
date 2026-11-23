/**
 * npm run wallet:status -- --email bob@example.com --status FROZEN
 * npm run wallet:status -- --email bob@example.com --status ACTIVE
 *
 * Freezes or unfreezes a user's wallet (development/demo only; there is
 * intentionally no HTTP endpoint for this). A frozen wallet can neither send
 * nor receive money. Its balance and history are untouched.
 */
const { parseArgs } = require("node:util")
const userModel = require("../src/models/user.model")
const accountModel = require("../src/models/account.model")
const { normalizeEmail } = require("../src/utils/validators")
const { runScript } = require("./script-helpers")

const USAGE = "Usage: npm run wallet:status -- --email <email> --status ACTIVE|FROZEN"

runScript(async () => {
    const { values } = parseArgs({
        options: { email: { type: "string" }, status: { type: "string" } },
    })
    const email = normalizeEmail(values.email)
    const status = (values.status || "").toUpperCase()
    if (!email || ![ "ACTIVE", "FROZEN" ].includes(status)) {
        console.error(USAGE)
        return 1
    }

    const user = await userModel.findOne({ email })
    const wallet = user && await accountModel.findOneAndUpdate(
        { type: "WALLET", user: user._id },
        { $set: { status } },
        { new: true }
    )
    if (!wallet) {
        console.error(`No wallet found for ${email}.`)
        return 1
    }
    console.log(`Wallet ${wallet._id} of ${email} is now ${wallet.status}.`)
})
