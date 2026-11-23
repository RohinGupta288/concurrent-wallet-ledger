/**
 * Module G: transaction history (GET /api/transactions, GET /api/transactions/:id).
 */
const request = require("supertest")
const app = require("../src/app")
const accountModel = require("../src/models/account.model")
const { connectTestDB, clearDatabase, closeTestDB } = require("./helpers/db")
const { registerUser, registerUserWithWallet } = require("./helpers/auth")
const { fund, newKey, sendTransfer } = require("./helpers/money")

beforeAll(connectTestDB)
beforeEach(clearDatabase)
afterAll(closeTestDB)

let alice
let bob
let charlie
beforeEach(async () => {
    alice = await registerUserWithWallet({ name: "Alice Secret", email: "alice-history@example.test" })
    bob = await registerUserWithWallet({ name: "Bob Secret", email: "bob-history@example.test" })
    charlie = await registerUserWithWallet()
    await fund(alice.wallet.id, 100000)
})

const history = (user, query = "") => request(app).get(`/api/transactions${query}`).set(user.auth)

test("lists my transactions newest first with direction and counterparty", async () => {
    const t1 = await sendTransfer(alice, { to: bob.wallet.id, amount: 1000 }).expect(201)
    const t2 = await sendTransfer(bob, { to: alice.wallet.id, amount: 400 }).expect(201)
    await sendTransfer(bob, { to: charlie.wallet.id, amount: 100 }).expect(201) // not Alice's

    const res = await history(alice)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ page: 1, limit: 20, total: 3, totalPages: 1 })
    const system = await accountModel.findOne({ type: "SYSTEM_FUNDING" })
    expect(res.body.items).toEqual([
        {
            transactionId: t2.body.transaction.id,
            type: "TRANSFER",
            direction: "CREDIT",
            amount: 400,
            currency: "INR",
            status: "COMPLETED",
            counterpartyAccountId: bob.wallet.id,
            createdAt: expect.any(String),
        },
        expect.objectContaining({
            transactionId: t1.body.transaction.id, direction: "DEBIT", amount: 1000, counterpartyAccountId: bob.wallet.id,
        }),
        expect.objectContaining({
            type: "FUNDING", direction: "CREDIT", amount: 100000, counterpartyAccountId: String(system._id),
        }),
    ])
})

test("pages are complete, ordered and never overlap", async () => {
    for (let i = 1; i <= 24; i++) {
        await sendTransfer(alice, { to: bob.wallet.id, amount: i, key: newKey() }).expect(201)
    }
    // 24 transfers + 1 funding = 25 items.

    const pages = []
    for (const page of [ 1, 2, 3, 4 ]) {
        const res = await history(alice, `?page=${page}&limit=10`)
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ page, limit: 10, total: 25, totalPages: 3 })
        pages.push(res.body.items)
    }

    expect(pages.map((p) => p.length)).toEqual([ 10, 10, 5, 0 ])
    const all = pages.flat()
    expect(new Set(all.map((item) => item.transactionId)).size).toBe(25)
    // Newest first: the transfer amounts were 1..24, so page 1 starts with 24.
    expect(all.slice(0, 24).map((item) => item.amount)).toEqual(Array.from({ length: 24 }, (_, i) => 24 - i))
    expect(all[ 24 ].type).toBe("FUNDING")
    const times = all.map((item) => Date.parse(item.createdAt))
    expect(times).toEqual([ ...times ].sort((a, b) => b - a))
})

test("each user sees only their own wallet's transactions", async () => {
    await sendTransfer(alice, { to: bob.wallet.id, amount: 500 }).expect(201)

    const forCharlie = await history(charlie)
    expect(forCharlie.body.items).toEqual([])
    expect(forCharlie.body.total).toBe(0)

    const forBob = await history(bob)
    expect(forBob.body.items).toHaveLength(1)
    expect(forBob.body.items[ 0 ]).toMatchObject({ direction: "CREDIT", counterpartyAccountId: alice.wallet.id })
})

test("history never exposes another user's personal data or internal fields", async () => {
    await sendTransfer(alice, { to: bob.wallet.id, amount: 500 }).expect(201)
    const res = await history(bob)
    const body = JSON.stringify(res.body)

    for (const secret of [ "Alice Secret", "alice-history@example.test", alice.user.id ]) {
        expect(body).not.toContain(secret)
    }
    expect(body).not.toMatch(/requestHash|initiatedBy|idempotencyKey/)
})

test("a user without a wallet gets an empty history", async () => {
    const dave = await registerUser()
    const res = await history(dave)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ items: [], page: 1, limit: 20, total: 0, totalPages: 0 })
})

test.each([
    [ "?page=0" ], [ "?page=-1" ], [ "?page=abc" ], [ "?page=1.5" ], [ "?page=1&page=2" ],
    [ "?limit=0" ], [ "?limit=101" ], [ "?limit=ten" ],
])("invalid pagination %s -> 400", async (query) => {
    const res = await history(alice, query)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
})

test("requires authentication", async () => {
    expect((await request(app).get("/api/transactions")).status).toBe(401)
})

describe("GET /api/transactions/:transactionId", () => {
    test("the sender sees full details including their idempotency key", async () => {
        const key = newKey()
        const sent = await sendTransfer(alice, { to: bob.wallet.id, amount: 750, key }).expect(201)

        const res = await request(app).get(`/api/transactions/${sent.body.transaction.id}`).set(alice.auth)
        expect(res.status).toBe(200)
        expect(res.body.transaction).toEqual({
            transactionId: sent.body.transaction.id,
            type: "TRANSFER",
            direction: "DEBIT",
            amount: 750,
            currency: "INR",
            status: "COMPLETED",
            counterpartyAccountId: bob.wallet.id,
            fromAccount: alice.wallet.id,
            toAccount: bob.wallet.id,
            idempotencyKey: key,
            createdAt: expect.any(String),
        })
    })

    test("the receiver sees it as a CREDIT, without the sender's idempotency key", async () => {
        const sent = await sendTransfer(alice, { to: bob.wallet.id, amount: 750 }).expect(201)

        const res = await request(app).get(`/api/transactions/${sent.body.transaction.id}`).set(bob.auth)
        expect(res.status).toBe(200)
        expect(res.body.transaction.direction).toBe("CREDIT")
        expect(res.body.transaction.idempotencyKey).toBeUndefined()
    })

    test("a transaction my wallet was not part of -> 404", async () => {
        const sent = await sendTransfer(alice, { to: bob.wallet.id, amount: 750 }).expect(201)

        const res = await request(app).get(`/api/transactions/${sent.body.transaction.id}`).set(charlie.auth)
        expect(res.status).toBe(404)
        expect(res.body.error.code).toBe("TRANSACTION_NOT_FOUND")
    })

    test("unknown id -> 404, malformed id -> 400, no auth -> 401", async () => {
        const unknown = await request(app).get("/api/transactions/aaaaaaaaaaaaaaaaaaaaaaaa").set(alice.auth)
        expect(unknown.status).toBe(404)

        const malformed = await request(app).get("/api/transactions/xyz").set(alice.auth)
        expect(malformed.status).toBe(400)
        expect(malformed.body.error.code).toBe("INVALID_ID")

        expect((await request(app).get("/api/transactions/aaaaaaaaaaaaaaaaaaaaaaaa")).status).toBe(401)
    })
})
