/**
 * Module H: reconciliation (services/reconciliation.service.js, scripts/reconcile.js).
 *
 * Each corruption test damages correct data directly through the native
 * MongoDB collection (bypassing the app and its immutability hooks, as a
 * buggy script or a manual database edit would) and checks that reconcile()
 * detects it.
 */
const path = require("path")
const { spawnSync } = require("child_process")
const mongoose = require("mongoose")
const accountModel = require("../src/models/account.model")
const transactionModel = require("../src/models/transaction.model")
const ledgerModel = require("../src/models/ledger.model")
const { reconcile } = require("../src/services/reconciliation.service")
const { connectTestDB, clearDatabase, closeTestDB } = require("./helpers/db")
const { registerUserWithWallet } = require("./helpers/auth")
const { fund, sendTransfer } = require("./helpers/money")

beforeAll(connectTestDB)
beforeEach(clearDatabase)
afterAll(closeTestDB)

// Native collections: writes here skip Mongoose validation and hooks.
const rawAccounts = () => accountModel.collection
const rawTransactions = () => transactionModel.collection
const rawLedger = () => ledgerModel.collection

let alice
let bob
let charlie
let transfer // the alice -> bob transfer document
beforeEach(async () => {
    alice = await registerUserWithWallet()
    bob = await registerUserWithWallet()
    charlie = await registerUserWithWallet()
    await fund(alice.wallet.id, 100000)
    await fund(bob.wallet.id, 50000)
    const res = await sendTransfer(alice, { to: bob.wallet.id, amount: 10000 }).expect(201)
    await sendTransfer(bob, { to: charlie.wallet.id, amount: 5000 }).expect(201)
    await sendTransfer(charlie, { to: alice.wallet.id, amount: 1000 }).expect(201)
    transfer = await transactionModel.findById(res.body.transaction.id).lean()
})

const checksOf = (result) => [ ...new Set(result.inconsistencies.map((i) => i.check)) ].sort()
const entryOf = (type, transactionId = transfer._id) => rawLedger().findOne({ transaction: transactionId, type })

test("correct data -> PASS with accurate totals", async () => {
    const result = await reconcile()

    expect(result).toMatchObject({
        status: "PASS",
        walletsChecked: 3,
        accountsChecked: 4, // 3 wallets + SYSTEM_FUNDING
        transactionsChecked: 5, // 2 fundings + 3 transfers
        ledgerEntriesChecked: 10,
        totalDebit: 166000,
        totalCredit: 166000,
        totalFunded: 150000,
        inconsistencyCount: 0,
        inconsistencies: [],
    })
})

test("an empty database -> PASS", async () => {
    await clearDatabase()
    expect((await reconcile()).status).toBe("PASS")
})

describe("detects corrupted data", () => {
    test("a deleted ledger entry", async () => {
        await rawLedger().deleteOne({ _id: (await entryOf("CREDIT"))._id })
        const result = await reconcile()

        expect(result.status).toBe("FAIL")
        expect(checksOf(result)).toEqual([ "BALANCE_MISMATCH", "MISSING_ENTRY", "UNBALANCED_LEDGER" ])
        expect(result.inconsistencies).toContainEqual(expect.objectContaining({
            check: "MISSING_ENTRY", transactionId: String(transfer._id),
        }))
    })

    test("an extra (duplicate) ledger entry", async () => {
        // The unique index normally makes this impossible; drop it to simulate damage.
        await rawLedger().dropIndex("one_debit_one_credit_per_transaction")
        try {
            const credit = await entryOf("CREDIT")
            await rawLedger().insertOne({ ...credit, _id: new mongoose.Types.ObjectId() })
            const result = await reconcile()

            expect(result.status).toBe("FAIL")
            // Bob's ledger now shows 10000 more than his stored balance, and credits exceed debits.
            expect(checksOf(result)).toEqual([ "BALANCE_MISMATCH", "EXTRA_ENTRY", "UNBALANCED_LEDGER" ])
        } finally {
            await clearDatabase()
            await ledgerModel.syncIndexes()
        }
    })

    test("a ledger entry amount that differs from its transaction (unbalanced journal)", async () => {
        await rawLedger().updateOne({ _id: (await entryOf("CREDIT"))._id }, { $set: { amount: 10001 } })
        const result = await reconcile()

        expect(checksOf(result)).toEqual([ "AMOUNT_MISMATCH", "BALANCE_MISMATCH", "UNBALANCED_LEDGER" ])
    })

    test("a transaction amount changed after the fact", async () => {
        await rawTransactions().updateOne({ _id: transfer._id }, { $set: { amount: 99 } })
        const result = await reconcile()

        expect(checksOf(result)).toEqual([ "AMOUNT_MISMATCH" ])
        expect(result.inconsistencies.filter((i) => i.check === "AMOUNT_MISMATCH")).toHaveLength(2)
    })

    test("a tampered stored balance (money created out of nothing)", async () => {
        await rawAccounts().updateOne({ _id: new mongoose.Types.ObjectId(bob.wallet.id) }, { $inc: { balance: 100 } })
        const result = await reconcile()

        expect(checksOf(result)).toEqual([ "BALANCE_MISMATCH", "SUM_OF_BALANCES_NOT_ZERO" ])
        expect(result.inconsistencies[ 0 ]).toMatchObject({ check: "BALANCE_MISMATCH", accountId: bob.wallet.id })
    })

    test("a negative wallet balance", async () => {
        await rawAccounts().updateOne({ _id: new mongoose.Types.ObjectId(charlie.wallet.id) }, { $set: { balance: -1 } })
        const result = await reconcile()

        expect(checksOf(result)).toEqual([ "BALANCE_MISMATCH", "NEGATIVE_WALLET_BALANCE", "SUM_OF_BALANCES_NOT_ZERO" ])
    })

    test("orphan entries: their transaction was deleted", async () => {
        await rawTransactions().deleteOne({ _id: transfer._id })
        const result = await reconcile()

        expect(checksOf(result)).toEqual([ "ORPHAN_ENTRY" ])
        expect(result.inconsistencies).toHaveLength(2) // the DEBIT and the CREDIT
    })

    test("an orphan entry pointing to an account that does not exist", async () => {
        const debit = await entryOf("DEBIT")
        await rawLedger().updateOne({ _id: debit._id }, { $set: { account: new mongoose.Types.ObjectId() } })
        const result = await reconcile()

        expect(checksOf(result)).toEqual([ "BALANCE_MISMATCH", "ORPHAN_ENTRY", "WRONG_ACCOUNT" ])
    })

    test("a transaction whose wallet was deleted", async () => {
        await rawAccounts().deleteOne({ _id: new mongoose.Types.ObjectId(charlie.wallet.id) })
        const result = await reconcile()

        // Charlie's ₹40 disappeared with the wallet, so the balances no longer add up to 0.
        expect(checksOf(result)).toEqual([ "MISSING_ACCOUNT", "ORPHAN_ENTRY", "SUM_OF_BALANCES_NOT_ZERO" ])
    })

    test("an entry booked on the wrong (but existing) account", async () => {
        await rawLedger().updateOne({ _id: (await entryOf("CREDIT"))._id },
            { $set: { account: new mongoose.Types.ObjectId(charlie.wallet.id) } })
        const result = await reconcile()

        expect(checksOf(result)).toEqual([ "BALANCE_MISMATCH", "WRONG_ACCOUNT" ])
    })

    test("a non-integer entry amount", async () => {
        await rawLedger().updateOne({ _id: (await entryOf("DEBIT"))._id }, { $set: { amount: 0.5 } })
        const result = await reconcile()

        expect(checksOf(result)).toEqual(expect.arrayContaining([ "INVALID_AMOUNT", "UNBALANCED_LEDGER" ]))
    })

    test("a self-consistent TRANSFER that spends from the SYSTEM_FUNDING account", async () => {
        // Perfectly balanced, but breaks the rule that only FUNDING may touch the system account.
        const system = await accountModel.findOne({ type: "SYSTEM_FUNDING" }).lean()
        const fake = new mongoose.Types.ObjectId()
        await rawTransactions().insertOne({
            _id: fake, type: "TRANSFER", fromAccount: system._id, toAccount: new mongoose.Types.ObjectId(charlie.wallet.id),
            amount: 700, status: "COMPLETED", initiatedBy: null, idempotencyKey: "corrupt-1", requestHash: "x",
        })
        await rawLedger().insertMany([
            { account: system._id, transaction: fake, type: "DEBIT", amount: 700 },
            { account: new mongoose.Types.ObjectId(charlie.wallet.id), transaction: fake, type: "CREDIT", amount: 700 },
        ])
        await rawAccounts().updateOne({ _id: system._id }, { $inc: { balance: -700 } })
        await rawAccounts().updateOne({ _id: new mongoose.Types.ObjectId(charlie.wallet.id) }, { $inc: { balance: 700 } })

        const result = await reconcile()
        expect(checksOf(result)).toEqual([ "SYSTEM_FUNDING_MISMATCH", "TRANSFER_TOUCHES_SYSTEM" ])
    })

    test("a FUNDING that does not come from the SYSTEM_FUNDING account", async () => {
        await rawTransactions().updateOne({ _id: transfer._id }, { $set: { type: "FUNDING" } })
        const result = await reconcile()

        expect(checksOf(result)).toEqual([ "INVALID_FUNDING", "SYSTEM_FUNDING_MISMATCH" ])
    })

    test("a transaction with a status other than COMPLETED", async () => {
        await rawTransactions().updateOne({ _id: transfer._id }, { $set: { status: "PENDING" } })
        expect(checksOf(await reconcile())).toEqual([ "INVALID_STATUS" ])
    })

    test("a second SYSTEM_FUNDING account", async () => {
        await rawAccounts().dropIndex("one_system_funding_account")
        try {
            await rawAccounts().insertOne({ type: "SYSTEM_FUNDING", status: "ACTIVE", currency: "INR", balance: 0 })
            expect(checksOf(await reconcile())).toEqual([ "MULTIPLE_SYSTEM_ACCOUNTS" ])
        } finally {
            await clearDatabase()
            await accountModel.syncIndexes()
        }
    })
})

test("reconcile never modifies data, even when it finds problems", async () => {
    await rawAccounts().updateOne({ _id: new mongoose.Types.ObjectId(bob.wallet.id) }, { $inc: { balance: 100 } })
    const dump = async () => JSON.stringify(await Promise.all([
        rawAccounts().find().sort({ _id: 1 }).toArray(),
        rawTransactions().find().sort({ _id: 1 }).toArray(),
        rawLedger().find().sort({ _id: 1 }).toArray(),
    ]))
    const before = await dump()

    expect((await reconcile()).status).toBe("FAIL")
    expect(await dump()).toBe(before)
})

describe("npm run reconcile (CLI)", () => {
    // Each case starts a new Node process; allow for slow machines.
    jest.setTimeout(120000)

    const runCli = (args = [], env = {}) => spawnSync(
        process.execPath,
        [ path.join(__dirname, "..", "scripts", "reconcile.js"), ...args ],
        { env: { ...process.env, ...env }, encoding: "utf8", timeout: 90000 }
    )

    test("PASS -> exit code 0 and a readable report", () => {
        const result = runCli()

        expect(result.status).toBe(0)
        expect(result.stdout).toMatch(/Transactions checked:\s+5/)
        expect(result.stdout).toMatch(/Total debit:\s+₹1660\.00 \(166000 paise\)/)
        expect(result.stdout).toMatch(/Result:\s+PASS/)
    })

    test("FAIL -> exit code 1 and the inconsistencies are listed", async () => {
        await rawAccounts().updateOne({ _id: new mongoose.Types.ObjectId(bob.wallet.id) }, { $inc: { balance: 100 } })
        const result = runCli()

        expect(result.status).toBe(1)
        expect(result.stdout).toMatch(/\[BALANCE_MISMATCH\]/)
        expect(result.stdout).toMatch(/Result:\s+FAIL/)
    })

    test("--json prints only machine-readable JSON on stdout", () => {
        const result = runCli([ "--json" ])

        expect(result.status).toBe(0)
        expect(JSON.parse(result.stdout)).toMatchObject({ status: "PASS", transactionsChecked: 5 })
    })

    test("is allowed in production because it is read-only", () => {
        const result = runCli([], { NODE_ENV: "production" })

        expect(result.status).toBe(0)
        expect(result.stdout).toMatch(/PASS/)
    })

    test("exit code 2 when the check cannot run", () => {
        const result = runCli([], { MONGO_URI: "" })

        expect(result.status).toBe(2)
        expect(result.stderr).toMatch(/MONGO_URI/)
    })
})
