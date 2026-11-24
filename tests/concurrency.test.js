/**
 * Module E: concurrency safety.
 *
 * Every scenario fires real HTTP requests at the same time with Promise.all
 * (no sleeps, no artificial ordering) and then checks the DATABASE, not just
 * the status codes: exact balances, number of transactions and ledger entries,
 * and that the books balance (expectBooksBalanced).
 */
const accountModel = require("../src/models/account.model")
const transactionModel = require("../src/models/transaction.model")
const { config } = require("../src/config/env")
const { reconcile } = require("../src/services/reconciliation.service")
const { connectTestDB, clearDatabase, closeTestDB } = require("./helpers/db")
const { registerUserWithWallet } = require("./helpers/auth")
const { fund, newKey, sendTransfer } = require("./helpers/money")
const { expectBooksBalanced, balanceOf } = require("./helpers/invariants")

// Contended requests may back off and retry for several seconds on a slow machine.
jest.setTimeout(120000)

beforeAll(connectTestDB)
beforeEach(clearDatabase)
afterAll(closeTestDB)

const countStatuses = (responses) => responses.reduce((counts, r) => {
    counts[ r.status ] = (counts[ r.status ] || 0) + 1
    return counts
}, {})

const transferCount = () => transactionModel.countDocuments({ type: "TRANSFER" })

describe("double spending is impossible", () => {
    test("₹1500 wallet, two simultaneous ₹1000 transfers -> exactly one succeeds, balance ₹500", async () => {
        const alice = await registerUserWithWallet()
        const bob = await registerUserWithWallet()
        const charlie = await registerUserWithWallet()
        await fund(alice.wallet.id, 150000)

        const responses = await Promise.all([
            sendTransfer(alice, { to: bob.wallet.id, amount: 100000 }),
            sendTransfer(alice, { to: charlie.wallet.id, amount: 100000 }),
        ])

        expect(responses.map((r) => r.status).sort()).toEqual([ 201, 422 ])
        expect(responses.find((r) => r.status === 422).body.error.code).toBe("INSUFFICIENT_FUNDS")
        expect(await balanceOf(alice.wallet.id)).toBe(50000)
        expect(await balanceOf(bob.wallet.id) + await balanceOf(charlie.wallet.id)).toBe(100000)
        expect(await transferCount()).toBe(1)
        await expectBooksBalanced()
    })

    test("₹1500 wallet, ten simultaneous ₹1000 transfers -> exactly one succeeds", async () => {
        const alice = await registerUserWithWallet()
        const bob = await registerUserWithWallet()
        await fund(alice.wallet.id, 150000)

        const responses = await Promise.all(
            Array.from({ length: 10 }, () => sendTransfer(alice, { to: bob.wallet.id, amount: 100000 }))
        )

        expect(countStatuses(responses)).toEqual({ 201: 1, 422: 9 })
        expect(await balanceOf(alice.wallet.id)).toBe(50000)
        expect(await balanceOf(bob.wallet.id)).toBe(100000)
        expect(await transferCount()).toBe(1)
        await expectBooksBalanced()
    })

    test("₹100 wallet, 25 simultaneous ₹10 transfers -> exactly 10 succeed, balance exactly 0", async () => {
        const alice = await registerUserWithWallet()
        const bob = await registerUserWithWallet()
        await fund(alice.wallet.id, 10000)

        const responses = await Promise.all(
            Array.from({ length: 25 }, () => sendTransfer(alice, { to: bob.wallet.id, amount: 1000 }))
        )

        expect(countStatuses(responses)).toEqual({ 201: 10, 422: 15 })
        expect(await balanceOf(alice.wallet.id)).toBe(0)
        expect(await balanceOf(bob.wallet.id)).toBe(10000)
        expect(await transferCount()).toBe(10)
        await expectBooksBalanced()
    })
})

describe("valid concurrent transfers all succeed with exact totals", () => {
    test("one sender, 10 simultaneous transfers to 10 different receivers", async () => {
        const alice = await registerUserWithWallet()
        const receivers = await Promise.all(Array.from({ length: 10 }, () => registerUserWithWallet()))
        await fund(alice.wallet.id, 100000)

        const responses = await Promise.all(
            receivers.map((receiver, i) => sendTransfer(alice, { to: receiver.wallet.id, amount: 1000 * (i + 1) }))
        )

        expect(countStatuses(responses)).toEqual({ 201: 10 })
        expect(await balanceOf(alice.wallet.id)).toBe(100000 - 55000) // 1000 + 2000 + ... + 10000
        for (const [ i, receiver ] of receivers.entries()) {
            expect(await balanceOf(receiver.wallet.id)).toBe(1000 * (i + 1))
        }
        await expectBooksBalanced()
    })

    test("10 senders, simultaneous transfers to the same receiver", async () => {
        const receiver = await registerUserWithWallet()
        const senders = await Promise.all(Array.from({ length: 10 }, () => registerUserWithWallet()))
        for (const sender of senders) await fund(sender.wallet.id, 5000)

        const responses = await Promise.all(
            senders.map((sender) => sendTransfer(sender, { to: receiver.wallet.id, amount: 3000 }))
        )

        expect(countStatuses(responses)).toEqual({ 201: 10 })
        expect(await balanceOf(receiver.wallet.id)).toBe(30000)
        for (const sender of senders) expect(await balanceOf(sender.wallet.id)).toBe(2000)
        await expectBooksBalanced()
    })

    test("criss-cross A->B, B->A and C->D at the same time, several rounds", async () => {
        const [ a, b, c, d ] = await Promise.all(Array.from({ length: 4 }, () => registerUserWithWallet()))
        for (const user of [ a, b, c ]) await fund(user.wallet.id, 50000)

        const rounds = 5
        const requests = []
        for (let i = 0; i < rounds; i++) {
            requests.push(sendTransfer(a, { to: b.wallet.id, amount: 1000 }))
            requests.push(sendTransfer(b, { to: a.wallet.id, amount: 300 }))
            requests.push(sendTransfer(c, { to: d.wallet.id, amount: 700 }))
        }
        const responses = await Promise.all(requests)

        expect(countStatuses(responses)).toEqual({ 201: 3 * rounds })
        expect(await balanceOf(a.wallet.id)).toBe(50000 - rounds * 1000 + rounds * 300)
        expect(await balanceOf(b.wallet.id)).toBe(50000 + rounds * 1000 - rounds * 300)
        expect(await balanceOf(c.wallet.id)).toBe(50000 - rounds * 700)
        expect(await balanceOf(d.wallet.id)).toBe(rounds * 700)
        expect(await transferCount()).toBe(3 * rounds)
        await expectBooksBalanced()
    })
})

describe("concurrent duplicates", () => {
    test("10 simultaneous identical requests (same key) -> one transfer, the rest are replays", async () => {
        const alice = await registerUserWithWallet()
        const bob = await registerUserWithWallet()
        await fund(alice.wallet.id, 100000)
        const key = newKey()

        const responses = await Promise.all(
            Array.from({ length: 10 }, () => sendTransfer(alice, { to: bob.wallet.id, amount: 2500, key }))
        )

        expect(countStatuses(responses)).toEqual({ 201: 1, 200: 9 })
        expect(new Set(responses.map((r) => r.body.transaction.id)).size).toBe(1)
        expect(responses.filter((r) => r.body.idempotentReplay)).toHaveLength(9)
        expect(await balanceOf(alice.wallet.id)).toBe(97500)
        expect(await balanceOf(bob.wallet.id)).toBe(2500)
        expect(await transferCount()).toBe(1)
        await expectBooksBalanced()
    })

    test("simultaneous requests reusing one key with different amounts -> exactly one transfer", async () => {
        const alice = await registerUserWithWallet()
        const bob = await registerUserWithWallet()
        await fund(alice.wallet.id, 100000)
        const key = newKey()

        const responses = await Promise.all(
            Array.from({ length: 6 }, (_, i) => sendTransfer(alice, { to: bob.wallet.id, amount: 1000 + i, key }))
        )

        expect(countStatuses(responses)).toEqual({ 201: 1, 409: 5 })
        const winner = responses.find((r) => r.status === 201).body.transaction
        expect(await balanceOf(bob.wallet.id)).toBe(winner.amount)
        expect(await transferCount()).toBe(1)
        await expectBooksBalanced()
    })
})

describe("reconciliation while money is moving", () => {
    test("reconcile() run during 30 in-flight transfers always sees a consistent snapshot (PASS)", async () => {
        const users = await Promise.all(Array.from({ length: 8 }, () => registerUserWithWallet()))
        for (const user of users) await fund(user.wallet.id, 100000)

        const planned = Array.from({ length: 30 }, (_, i) => ({
            from: users[ i % 8 ], to: users[ (i + 1) % 8 ], amount: 100 + i, key: newKey(),
        }))
        const transfers = planned.map((t) => sendTransfer(t.from, { to: t.to.wallet.id, amount: t.amount, key: t.key }))
        const audits = Array.from({ length: 6 }, () => reconcile())
        const results = await Promise.all([ ...transfers, ...audits ])

        const responses = results.slice(0, 30)
        const reports = results.slice(30)
        // What this test is about: every audit taken mid-flight is consistent.
        for (const report of reports) {
            expect(report.inconsistencies).toEqual([])
            expect(report.status).toBe("PASS")
        }
        // Each transfer completed, or (only if its retry budget ran out on a slow
        // machine) returned 503 having applied nothing.
        for (const r of responses) expect([ 201, 503 ]).toContain(r.status)
        expect(await transferCount()).toBe(responses.filter((r) => r.status === 201).length)
        await expectBooksBalanced()

        // Retrying the 503s one by one with their own keys completes everything exactly once.
        for (const [ i, r ] of responses.entries()) {
            if (r.status === 503) {
                const t = planned[ i ]
                await sendTransfer(t.from, { to: t.to.wallet.id, amount: t.amount, key: t.key }).expect(201)
            }
        }
        expect(await transferCount()).toBe(30)
        await expectBooksBalanced()
    })
})

describe("other concurrent changes", () => {
    test("freezing a wallet while transfers are in flight: each transfer is all-or-nothing", async () => {
        const alice = await registerUserWithWallet()
        const bob = await registerUserWithWallet()
        await fund(alice.wallet.id, 100000)

        const [ freeze, ...responses ] = await Promise.all([
            accountModel.updateOne({ _id: bob.wallet.id }, { status: "FROZEN" }),
            ...Array.from({ length: 10 }, () => sendTransfer(alice, { to: bob.wallet.id, amount: 1000 })),
        ])

        expect(freeze.modifiedCount).toBe(1)
        const completed = responses.filter((r) => r.status === 201).length
        for (const r of responses) {
            expect([ 201, 422 ]).toContain(r.status)
            if (r.status === 422) expect(r.body.error.code).toBe("WALLET_FROZEN")
        }
        expect(await balanceOf(bob.wallet.id)).toBe(completed * 1000)
        expect(await balanceOf(alice.wallet.id)).toBe(100000 - completed * 1000)
        expect(await transferCount()).toBe(completed)
        await expectBooksBalanced()
    })

    test("when retries run out under heavy contention: 503s apply nothing and are safe to retry with the same key", async () => {
        const alice = await registerUserWithWallet()
        const bob = await registerUserWithWallet()
        await fund(alice.wallet.id, 100000)
        const keys = Array.from({ length: 20 }, () => newKey())

        const savedAttempts = config.txnMaxAttempts
        config.txnMaxAttempts = 1 // no retries at all: any write conflict becomes a 503
        let first
        try {
            first = await Promise.all(keys.map((key) => sendTransfer(alice, { to: bob.wallet.id, amount: 1000, key })))
        } finally {
            config.txnMaxAttempts = savedAttempts
        }

        const counts = countStatuses(first)
        expect(counts[ 503 ]).toBeGreaterThan(0)
        expect((counts[ 201 ] || 0) + counts[ 503 ]).toBe(20) // nothing else, e.g. no 500
        // Only the 201s moved money.
        expect(await transferCount()).toBe(counts[ 201 ] || 0)
        expect(await balanceOf(bob.wallet.id)).toBe((counts[ 201 ] || 0) * 1000)
        await expectBooksBalanced()

        // The client retries every request with its original key, one at a time.
        const retried = []
        for (const key of keys) retried.push(await sendTransfer(alice, { to: bob.wallet.id, amount: 1000, key }))
        for (const [ i, r ] of retried.entries()) {
            expect(r.status).toBe(first[ i ].status === 201 ? 200 : 201) // done ones replay, failed ones run now
        }
        expect(await transferCount()).toBe(20)
        expect(await balanceOf(alice.wallet.id)).toBe(80000)
        expect(await balanceOf(bob.wallet.id)).toBe(20000)
        await expectBooksBalanced()
    })
})
