/**
 * Module B: wallets (/api/accounts).
 */
const request = require("supertest")
const app = require("../src/app")
const accountModel = require("../src/models/account.model")
const { connectTestDB, clearDatabase, closeTestDB } = require("./helpers/db")
const { registerUser, registerUserWithWallet } = require("./helpers/auth")

beforeAll(connectTestDB)
beforeEach(clearDatabase)
afterAll(closeTestDB)

describe("POST /api/accounts", () => {
    test("creates an ACTIVE INR wallet with balance 0", async () => {
        const { user, auth } = await registerUser()
        const res = await request(app).post("/api/accounts").set(auth)

        expect(res.status).toBe(201)
        expect(res.body.account).toEqual({
            id: expect.stringMatching(/^[0-9a-f]{24}$/),
            currency: "INR",
            balance: 0,
            status: "ACTIVE",
            createdAt: expect.any(String),
        })

        const stored = await accountModel.findById(res.body.account.id).lean()
        expect(stored.type).toBe("WALLET")
        expect(String(stored.user)).toBe(user.id)
        expect(stored.balance).toBe(0)
    })

    test("ignores client-supplied fields such as balance, status or user", async () => {
        const other = await registerUser()
        const { user, auth } = await registerUser()
        const res = await request(app).post("/api/accounts").set(auth)
            .send({ balance: 999999, status: "FROZEN", user: other.user.id, currency: "USD", type: "SYSTEM_FUNDING" })

        expect(res.status).toBe(201)
        expect(res.body.account.balance).toBe(0)
        expect(res.body.account.status).toBe("ACTIVE")
        expect(res.body.account.currency).toBe("INR")
        const stored = await accountModel.findById(res.body.account.id).lean()
        expect(String(stored.user)).toBe(user.id)
        expect(stored.type).toBe("WALLET")
    })

    test("a second wallet for the same user is rejected with 409 WALLET_EXISTS", async () => {
        const { user, auth } = await registerUserWithWallet()
        const res = await request(app).post("/api/accounts").set(auth)

        expect(res.status).toBe(409)
        expect(res.body.error.code).toBe("WALLET_EXISTS")
        expect(await accountModel.countDocuments({ user: user.id })).toBe(1)
    })

    test("concurrent create requests produce exactly one wallet (database unique index)", async () => {
        const { user, auth } = await registerUser()
        const results = await Promise.all(
            Array.from({ length: 8 }, () => request(app).post("/api/accounts").set(auth))
        )
        const statuses = results.map((r) => r.status).sort()

        expect(statuses).toEqual([ 201, 409, 409, 409, 409, 409, 409, 409 ])
        expect(await accountModel.countDocuments({ user: user.id })).toBe(1)
    })

    test("a frozen wallet still counts as the user's one wallet", async () => {
        const { wallet, auth } = await registerUserWithWallet()
        await accountModel.updateOne({ _id: wallet.id }, { status: "FROZEN" })

        const res = await request(app).post("/api/accounts").set(auth)
        expect(res.status).toBe(409)
    })

    test("requires authentication", async () => {
        const res = await request(app).post("/api/accounts")

        expect(res.status).toBe(401)
        expect(await accountModel.countDocuments()).toBe(0)
    })
})

describe("GET /api/accounts", () => {
    test("lists only the current user's wallet", async () => {
        const alice = await registerUserWithWallet()
        await registerUserWithWallet()

        const res = await request(app).get("/api/accounts").set(alice.auth)
        expect(res.status).toBe(200)
        expect(res.body.accounts).toEqual([ alice.wallet ])
    })

    test("returns an empty list before a wallet exists", async () => {
        const { auth } = await registerUser()
        const res = await request(app).get("/api/accounts").set(auth)

        expect(res.status).toBe(200)
        expect(res.body.accounts).toEqual([])
    })
})

describe("GET /api/accounts/:accountId and /balance/:accountId", () => {
    test("returns the owner's wallet details and balance", async () => {
        const { wallet, auth } = await registerUserWithWallet()

        const details = await request(app).get(`/api/accounts/${wallet.id}`).set(auth)
        expect(details.status).toBe(200)
        expect(details.body.account).toEqual(wallet)

        const balance = await request(app).get(`/api/accounts/balance/${wallet.id}`).set(auth)
        expect(balance.status).toBe(200)
        expect(balance.body).toEqual({ accountId: wallet.id, balance: 0, currency: "INR" })
    })

    test("returns the stored balance", async () => {
        const { wallet, auth } = await registerUserWithWallet()
        await accountModel.updateOne({ _id: wallet.id }, { balance: 150000 })

        const res = await request(app).get(`/api/accounts/balance/${wallet.id}`).set(auth)
        expect(res.body.balance).toBe(150000)
    })

    test("another user's wallet is 404 on both routes (no existence leak)", async () => {
        const alice = await registerUserWithWallet()
        const bob = await registerUserWithWallet()

        for (const path of [ `/api/accounts/${alice.wallet.id}`, `/api/accounts/balance/${alice.wallet.id}` ]) {
            const res = await request(app).get(path).set(bob.auth)
            expect(res.status).toBe(404)
            expect(res.body.error.code).toBe("WALLET_NOT_FOUND")
            expect(JSON.stringify(res.body)).not.toContain(alice.user.id)
        }
    })

    test("an unknown id is 404 and a malformed id is 400", async () => {
        const { auth } = await registerUserWithWallet()

        const unknown = await request(app).get("/api/accounts/aaaaaaaaaaaaaaaaaaaaaaaa").set(auth)
        expect(unknown.status).toBe(404)

        const malformed = await request(app).get("/api/accounts/not-an-id").set(auth)
        expect(malformed.status).toBe(400)
        expect(malformed.body.error.code).toBe("INVALID_ID")
    })

    test("the system funding account is never returned to users", async () => {
        const { auth } = await registerUserWithWallet()
        const system = await accountModel.create({ type: "SYSTEM_FUNDING" })

        const res = await request(app).get(`/api/accounts/${system._id}`).set(auth)
        expect(res.status).toBe(404)
    })

    test("requires authentication", async () => {
        const { wallet } = await registerUserWithWallet()
        const res = await request(app).get(`/api/accounts/${wallet.id}`)

        expect(res.status).toBe(401)
    })
})
