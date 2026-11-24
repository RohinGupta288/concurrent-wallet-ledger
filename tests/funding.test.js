/**
 * Development funding (services/funding.service.js) and the scripts that use it.
 */
const path = require("path")
const { spawnSync } = require("child_process")
const accountModel = require("../src/models/account.model")
const transactionModel = require("../src/models/transaction.model")
const ledgerModel = require("../src/models/ledger.model")
const { fundWallet } = require("../src/services/funding.service")
const { seed } = require("../scripts/seed")
const { connectTestDB, clearDatabase, closeTestDB } = require("./helpers/db")
const { registerUserWithWallet } = require("./helpers/auth")
const { expectBooksBalanced, balanceOf } = require("./helpers/invariants")

beforeAll(connectTestDB)
beforeEach(clearDatabase)
afterAll(closeTestDB)

describe("fundWallet", () => {
    test("credits the wallet, debits SYSTEM_FUNDING and writes one balanced FUNDING transaction", async () => {
        const { wallet } = await registerUserWithWallet()
        const { transaction, created } = await fundWallet({ walletId: wallet.id, amount: 150000, idempotencyKey: "fund-test-0001" })

        expect(created).toBe(true)
        expect(transaction.type).toBe("FUNDING")
        expect(transaction.initiatedBy).toBeNull()
        expect(await balanceOf(wallet.id)).toBe(150000)

        const system = await accountModel.findOne({ type: "SYSTEM_FUNDING" }).lean()
        expect(system.balance).toBe(-150000)
        expect(String(transaction.fromAccount)).toBe(String(system._id))

        const entries = await ledgerModel.find({ transaction: transaction._id }).lean()
        expect(entries.map((e) => [ e.type, String(e.account), e.amount ]).sort()).toEqual([
            [ "CREDIT", wallet.id, 150000 ],
            [ "DEBIT", String(system._id), 150000 ],
        ])
        await expectBooksBalanced()
    })

    test("the same key with the same request is a no-op on repeat", async () => {
        const { wallet } = await registerUserWithWallet()
        const first = await fundWallet({ walletId: wallet.id, amount: 5000, idempotencyKey: "fund-repeat-01" })
        const second = await fundWallet({ walletId: wallet.id, amount: 5000, idempotencyKey: "fund-repeat-01" })

        expect(second.created).toBe(false)
        expect(String(second.transaction._id)).toBe(String(first.transaction._id))
        expect(await balanceOf(wallet.id)).toBe(5000)
        expect(await transactionModel.countDocuments()).toBe(1)
        await expectBooksBalanced()
    })

    test("the same key with a different amount or wallet is rejected with 409", async () => {
        const a = await registerUserWithWallet()
        const b = await registerUserWithWallet()
        await fundWallet({ walletId: a.wallet.id, amount: 5000, idempotencyKey: "fund-reuse-01" })

        await expect(fundWallet({ walletId: a.wallet.id, amount: 6000, idempotencyKey: "fund-reuse-01" }))
            .rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" })
        await expect(fundWallet({ walletId: b.wallet.id, amount: 5000, idempotencyKey: "fund-reuse-01" }))
            .rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" })
        expect(await balanceOf(b.wallet.id)).toBe(0)
    })

    test.each([ 0, -100, 10.5, "500", 100_000_001 ])("rejects amount %p", async (amount) => {
        const { wallet } = await registerUserWithWallet()
        await expect(fundWallet({ walletId: wallet.id, amount, idempotencyKey: "fund-bad-amount" }))
            .rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_ERROR" })
        expect(await transactionModel.countDocuments()).toBe(0)
    })

    test("rejects a frozen wallet (422) and an unknown wallet (404), leaving no records", async () => {
        const { wallet } = await registerUserWithWallet()
        await accountModel.updateOne({ _id: wallet.id }, { status: "FROZEN" })

        await expect(fundWallet({ walletId: wallet.id, amount: 100, idempotencyKey: "fund-frozen-1" }))
            .rejects.toMatchObject({ statusCode: 422, code: "WALLET_FROZEN" })
        await expect(fundWallet({ walletId: "aaaaaaaaaaaaaaaaaaaaaaaa", amount: 100, idempotencyKey: "fund-missing" }))
            .rejects.toMatchObject({ statusCode: 404 })

        expect(await transactionModel.countDocuments()).toBe(0)
        expect(await ledgerModel.countDocuments()).toBe(0)
        await expectBooksBalanced()
    })

    test("cannot fund the system account itself", async () => {
        await fundWallet({ walletId: (await registerUserWithWallet()).wallet.id, amount: 1, idempotencyKey: "fund-setup-01" })
        const system = await accountModel.findOne({ type: "SYSTEM_FUNDING" })

        await expect(fundWallet({ walletId: system._id, amount: 100, idempotencyKey: "fund-system-1" }))
            .rejects.toMatchObject({ statusCode: 404 })
    })

    test("concurrent fundings: one system account, exact totals, books balanced", async () => {
        const { wallet } = await registerUserWithWallet()
        const results = await Promise.all(
            Array.from({ length: 10 }, (_, i) =>
                fundWallet({ walletId: wallet.id, amount: 1000 + i, idempotencyKey: `fund-parallel-${i}` }))
        )

        expect(results.every((r) => r.created)).toBe(true)
        expect(await accountModel.countDocuments({ type: "SYSTEM_FUNDING" })).toBe(1)
        expect(await balanceOf(wallet.id)).toBe(10 * 1000 + 45)
        await expectBooksBalanced()
    })

    test("concurrent fundings with the same key apply exactly once", async () => {
        const { wallet } = await registerUserWithWallet()
        const results = await Promise.all(
            Array.from({ length: 6 }, () => fundWallet({ walletId: wallet.id, amount: 700, idempotencyKey: "fund-same-key" }))
        )

        expect(results.filter((r) => r.created)).toHaveLength(1)
        expect(new Set(results.map((r) => String(r.transaction._id))).size).toBe(1)
        expect(await balanceOf(wallet.id)).toBe(700)
        await expectBooksBalanced()
    })
})

describe("seed script", () => {
    test("running seed twice gives identical balances and no duplicate data", async () => {
        const first = await seed()
        const second = await seed()

        expect(second.map((r) => [ r.email, r.walletId, r.balance ]))
            .toEqual(first.map((r) => [ r.email, r.walletId, r.balance ]))
        expect(first.map((r) => r.funding)).toEqual([ "applied", "applied", "applied" ])
        expect(second.map((r) => r.funding)).toEqual([ "already applied", "already applied", "already applied" ])
        expect(first.map((r) => r.balance)).toEqual([ 1_000_000, 500_000, 200_000 ])
        expect(await transactionModel.countDocuments()).toBe(3)
        await expectBooksBalanced()
    })
})

describe("development scripts refuse to run outside local development", () => {
    // Each case starts a new Node process; allow for slow machines.
    jest.setTimeout(120000)

    const scripts = [
        [ "seed.js", [] ],
        [ "fund-wallet.js", [ "--email", "a@example.com", "--amount", "10", "--key", "prod-check-1" ] ],
        [ "set-wallet-status.js", [ "--email", "a@example.com", "--status", "FROZEN" ] ],
        [ "perf.js", [ "--duration", "1" ] ],
    ]
    const run = (script, args, env) => spawnSync(process.execPath, [ path.join(__dirname, "..", "scripts", script), ...args ], {
        env: { ...process.env, ...env },
        encoding: "utf8",
        timeout: 90000,
    })

    test.each(scripts)("%s refuses NODE_ENV=production and other non-development values", async (script, args) => {
        for (const nodeEnv of [ "production", "staging", "prod" ]) {
            const result = run(script, args, { NODE_ENV: nodeEnv })
            expect(result.status).toBe(1)
            expect(result.stderr).toMatch(/Refusing to run.*NODE_ENV/)
        }
        expect(await accountModel.countDocuments()).toBe(0) // nothing was created
    })

    test.each(scripts)("%s refuses a database that is not on this machine", async (script, args) => {
        const result = run(script, args, { MONGO_URI: "mongodb://db.example.com:27017/backend-ledger?replicaSet=rs0" })
        expect(result.status).toBe(1)
        expect(result.stderr).toMatch(/Refusing to run.*local database/)
    })

    test("local-database detection", () => {
        const { isLocalDatabase } = require("../scripts/script-helpers")
        expect(isLocalDatabase("mongodb://127.0.0.1:27017/x?replicaSet=rs0")).toBe(true)
        expect(isLocalDatabase("mongodb://localhost,127.0.0.1:27018/x")).toBe(true)
        expect(isLocalDatabase("mongodb://user:pa%40ss@[::1]:27017/x")).toBe(true)
        expect(isLocalDatabase("mongodb://127.0.0.1:27017,db.example.com:27017/x")).toBe(false)
        expect(isLocalDatabase("mongodb+srv://cluster0.example.mongodb.net/x")).toBe(false)
        expect(isLocalDatabase("mongodb://127.0.0.1.evil.com/x")).toBe(false)
    })
})
