/**
 * npm run seed
 *
 * Creates demo users with wallets and funds them. Safe to run any number of
 * times: existing users and wallets are reused, and every funding uses a fixed
 * idempotency key, so balances never grow on a second run.
 *
 * Demo logins (development only):
 *   alice@example.com / Password@123   wallet funded with ₹10,000
 *   bob@example.com   / Password@123   wallet funded with ₹5,000
 *   charlie@example.com / Password@123 wallet funded with ₹2,000
 */
const userModel = require("../src/models/user.model")
const accountModel = require("../src/models/account.model")
const { fundWallet } = require("../src/services/funding.service")
const { formatPaise } = require("../src/utils/money")
const { runScript } = require("./script-helpers")

const DEMO_PASSWORD = "Password@123"
const DEMO_USERS = [
    { name: "Alice", email: "alice@example.com", fundingPaise: 1_000_000, fundingKey: "seed-alice-initial-v1" },
    { name: "Bob", email: "bob@example.com", fundingPaise: 500_000, fundingKey: "seed-bob-initial-v1" },
    { name: "Charlie", email: "charlie@example.com", fundingPaise: 200_000, fundingKey: "seed-charlie-initial-v1" },
]

async function findOrCreate(model, filter, create) {
    const existing = await model.findOne(filter)
    if (existing) return existing
    try {
        return await model.create(create)
    } catch (err) {
        if (err.code === 11000) return model.findOne(filter) // created concurrently
        throw err
    }
}

/** Creates/reuses the demo data. Returns one summary row per demo user. */
async function seed() {
    const rows = []
    for (const demo of DEMO_USERS) {
        const user = await findOrCreate(
            userModel,
            { email: demo.email },
            { name: demo.name, email: demo.email, password: DEMO_PASSWORD }
        )
        const wallet = await findOrCreate(
            accountModel,
            { type: "WALLET", user: user._id },
            { type: "WALLET", user: user._id }
        )
        const { created } = await fundWallet({
            walletId: wallet._id,
            amount: demo.fundingPaise,
            idempotencyKey: demo.fundingKey,
        })
        const fresh = await accountModel.findById(wallet._id)
        rows.push({
            email: demo.email,
            walletId: String(wallet._id),
            balance: fresh.balance,
            funding: created ? "applied" : "already applied",
        })
    }
    return rows
}

if (require.main === module) {
    runScript(async () => {
        const rows = await seed()
        console.table(rows.map((row) => ({ ...row, balance: formatPaise(row.balance) })))
        console.log(`Demo password for all users: ${DEMO_PASSWORD}`)
    })
}

module.exports = { seed, DEMO_USERS, DEMO_PASSWORD }
