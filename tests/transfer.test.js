/**
 * Module D: atomic transfers (POST /api/transactions).
 * Every test checks the response AND the database afterwards.
 */
const request = require("supertest")
const app = require("../src/app")
const accountModel = require("../src/models/account.model")
const transactionModel = require("../src/models/transaction.model")
const ledgerModel = require("../src/models/ledger.model")
const { MAX_BALANCE_PAISE } = require("../src/utils/money")
const { connectTestDB, clearDatabase, closeTestDB } = require("./helpers/db")
const { registerUser, registerUserWithWallet } = require("./helpers/auth")
const { fund, newKey, sendTransfer } = require("./helpers/money")
const { expectBooksBalanced, balanceOf } = require("./helpers/invariants")

beforeAll(connectTestDB)
beforeEach(clearDatabase)
afterAll(closeTestDB)
afterEach(() => jest.restoreAllMocks())

let alice
let bob
beforeEach(async () => {
    alice = await registerUserWithWallet()
    bob = await registerUserWithWallet()
    await fund(alice.wallet.id, 150000) // ₹1500
})

/** Balances, transfer count and ledger size, to prove a failed request changed nothing. */
async function snapshot() {
    return {
        alice: await balanceOf(alice.wallet.id),
        bob: await balanceOf(bob.wallet.id),
        transfers: await transactionModel.countDocuments({ type: "TRANSFER" }),
        entries: await ledgerModel.countDocuments(),
    }
}

describe("successful transfer", () => {
    test("moves money, records one TRANSFER with one DEBIT and one CREDIT", async () => {
        const key = newKey()
        const res = await sendTransfer(alice, { to: bob.wallet.id, amount: 40000, key })

        expect(res.status).toBe(201)
        expect(res.body).toEqual({
            idempotentReplay: false,
            transaction: {
                id: expect.stringMatching(/^[0-9a-f]{24}$/),
                type: "TRANSFER",
                fromAccount: alice.wallet.id,
                toAccount: bob.wallet.id,
                amount: 40000,
                currency: "INR",
                status: "COMPLETED",
                idempotencyKey: key,
                createdAt: expect.any(String),
            },
        })

        expect(await balanceOf(alice.wallet.id)).toBe(110000)
        expect(await balanceOf(bob.wallet.id)).toBe(40000)

        const stored = await transactionModel.findById(res.body.transaction.id).lean()
        expect(String(stored.initiatedBy)).toBe(alice.user.id)
        const entries = await ledgerModel.find({ transaction: stored._id }).lean()
        expect(entries.map((e) => [ e.type, String(e.account), e.amount ]).sort()).toEqual([
            [ "CREDIT", bob.wallet.id, 40000 ],
            [ "DEBIT", alice.wallet.id, 40000 ],
        ])
        await expectBooksBalanced()
    })

    test("can spend the exact full balance, leaving 0", async () => {
        const res = await sendTransfer(alice, { to: bob.wallet.id, amount: 150000 })

        expect(res.status).toBe(201)
        expect(await balanceOf(alice.wallet.id)).toBe(0)
        expect(await balanceOf(bob.wallet.id)).toBe(150000)
        await expectBooksBalanced()
    })

    test("the response never exposes internal fields", async () => {
        const res = await sendTransfer(alice, { to: bob.wallet.id, amount: 100 })

        expect(JSON.stringify(res.body)).not.toMatch(/requestHash|initiatedBy|password|email/)
    })
})

describe("rejected transfers change nothing", () => {
    test("insufficient funds -> 422 INSUFFICIENT_FUNDS", async () => {
        const before = await snapshot()
        const res = await sendTransfer(alice, { to: bob.wallet.id, amount: 150001 })

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe("INSUFFICIENT_FUNDS")
        expect(await snapshot()).toEqual(before)
    })

    test("an empty wallet cannot send anything", async () => {
        const res = await sendTransfer(bob, { to: alice.wallet.id, amount: 1 })

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe("INSUFFICIENT_FUNDS")
    })

    test.each([
        [ "zero", 0 ],
        [ "negative", -100 ],
        [ "fractional", 10.5 ],
        [ "numeric string", "100" ],
        [ "null", null ],
        [ "boolean", true ],
        [ "above the per-transfer limit", 100_000_001 ],
        [ "unsafe integer", 2 ** 53 + 2 ],
    ])("%s amount -> 400 VALIDATION_ERROR", async (label, amount) => {
        const before = await snapshot()
        const res = await sendTransfer(alice, { to: bob.wallet.id, amount })

        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe("VALIDATION_ERROR")
        expect(res.body.error.details.amount).toBeDefined()
        expect(await snapshot()).toEqual(before)
    })

    test("missing fields are all reported", async () => {
        const res = await request(app).post("/api/transactions").set(alice.auth).send({})

        expect(res.status).toBe(400)
        expect(Object.keys(res.body.error.details).sort())
            .toEqual([ "amount", "fromAccount", "idempotencyKey", "toAccount" ])
    })

    test("a non-object body (array) -> 400", async () => {
        const res = await request(app).post("/api/transactions").set(alice.auth).send([ 1, 2 ])

        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe("VALIDATION_ERROR")
    })

    test("operator injection in ids -> 400", async () => {
        const res = await sendTransfer(alice, { to: { $ne: null }, from: { $ne: null }, amount: 100 })

        expect(res.status).toBe(400)
        expect(res.body.error.details.fromAccount).toBeDefined()
        expect(res.body.error.details.toAccount).toBeDefined()
    })

    test("transfer to yourself -> 400 (case-insensitive id comparison)", async () => {
        const res = await sendTransfer(alice, { to: alice.wallet.id.toUpperCase(), amount: 100 })

        expect(res.status).toBe(400)
        expect(res.body.error.details.toAccount).toMatch(/different/)
    })

    test("unknown destination -> 404 DESTINATION_WALLET_NOT_FOUND", async () => {
        const before = await snapshot()
        const res = await sendTransfer(alice, { to: "aaaaaaaaaaaaaaaaaaaaaaaa", amount: 100 })

        expect(res.status).toBe(404)
        expect(res.body.error.code).toBe("DESTINATION_WALLET_NOT_FOUND")
        expect(await snapshot()).toEqual(before)
    })

    test("the SYSTEM_FUNDING account is not a valid destination", async () => {
        const system = await accountModel.findOne({ type: "SYSTEM_FUNDING" })
        const res = await sendTransfer(alice, { to: String(system._id), amount: 100 })

        expect(res.status).toBe(404)
    })

    test("spending from someone else's wallet -> 403 SOURCE_WALLET_NOT_OWNED", async () => {
        const before = await snapshot()
        // Bob tries to move Alice's money to himself.
        const res = await sendTransfer(bob, { from: alice.wallet.id, to: bob.wallet.id, amount: 100 })

        expect(res.status).toBe(403)
        expect(res.body.error.code).toBe("SOURCE_WALLET_NOT_OWNED")
        expect(await snapshot()).toEqual(before)
    })

    test("a non-existent source gets the same 403 (no existence leak)", async () => {
        const res = await sendTransfer(alice, { from: "bbbbbbbbbbbbbbbbbbbbbbbb", to: bob.wallet.id, amount: 100 })

        expect(res.status).toBe(403)
        expect(res.body.error.code).toBe("SOURCE_WALLET_NOT_OWNED")
    })

    test("a user without a wallet gets 403", async () => {
        const carol = await registerUser()
        const res = await request(app).post("/api/transactions").set(carol.auth)
            .send({ fromAccount: alice.wallet.id, toAccount: bob.wallet.id, amount: 1, idempotencyKey: newKey() })

        expect(res.status).toBe(403)
    })

    test("frozen source -> 422 WALLET_FROZEN (fromAccount)", async () => {
        await accountModel.updateOne({ _id: alice.wallet.id }, { status: "FROZEN" })
        const before = await snapshot()
        const res = await sendTransfer(alice, { to: bob.wallet.id, amount: 100 })

        expect(res.status).toBe(422)
        expect(res.body.error).toMatchObject({ code: "WALLET_FROZEN", details: { account: "fromAccount" } })
        expect(await snapshot()).toEqual(before)
    })

    test("frozen destination -> 422 WALLET_FROZEN (toAccount)", async () => {
        await accountModel.updateOne({ _id: bob.wallet.id }, { status: "FROZEN" })
        const before = await snapshot()
        const res = await sendTransfer(alice, { to: bob.wallet.id, amount: 100 })

        expect(res.status).toBe(422)
        expect(res.body.error).toMatchObject({ code: "WALLET_FROZEN", details: { account: "toAccount" } })
        expect(await snapshot()).toEqual(before)
    })

    test("a destination at the balance cap -> 422 BALANCE_LIMIT_EXCEEDED, source untouched", async () => {
        // Direct write to reach the cap; the books are deliberately not balanced in this test.
        await accountModel.updateOne({ _id: bob.wallet.id }, { balance: MAX_BALANCE_PAISE - 50 })
        const res = await sendTransfer(alice, { to: bob.wallet.id, amount: 100 })

        expect(res.status).toBe(422)
        expect(res.body.error.code).toBe("BALANCE_LIMIT_EXCEEDED")
        expect(await balanceOf(alice.wallet.id)).toBe(150000)
        expect(await transactionModel.countDocuments({ type: "TRANSFER" })).toBe(0)
    })

    test("requires authentication", async () => {
        const res = await request(app).post("/api/transactions")
            .send({ fromAccount: alice.wallet.id, toAccount: bob.wallet.id, amount: 100, idempotencyKey: newKey() })

        expect(res.status).toBe(401)
        expect(await balanceOf(alice.wallet.id)).toBe(150000)
    })
})

describe("atomicity: a crash halfway leaves no trace", () => {
    test("failure while writing ledger entries -> 500, no transfer record, balances unchanged", async () => {
        jest.spyOn(ledgerModel, "insertMany").mockRejectedValueOnce(new Error("simulated crash in insertMany"))
        const before = await snapshot()

        const res = await sendTransfer(alice, { to: bob.wallet.id, amount: 40000 })

        expect(res.status).toBe(500)
        expect(res.body.error.code).toBe("INTERNAL_ERROR")
        expect(JSON.stringify(res.body)).not.toContain("simulated crash") // internals are not leaked
        expect(await snapshot()).toEqual(before)
        await expectBooksBalanced()
    })

    test("failure AFTER the source was debited (during the credit) -> debit rolled back", async () => {
        const realUpdateOne = accountModel.updateOne
        let calls = 0
        jest.spyOn(accountModel, "updateOne").mockImplementation(function (...args) {
            calls += 1
            if (calls === 2) return Promise.reject(new Error("simulated crash during credit"))
            return realUpdateOne.apply(this, args)
        })
        const before = await snapshot()

        const res = await sendTransfer(alice, { to: bob.wallet.id, amount: 40000 })

        expect(calls).toBe(2) // the debit really ran inside the transaction
        expect(res.status).toBe(500)
        jest.restoreAllMocks()
        expect(await snapshot()).toEqual(before)
        await expectBooksBalanced()
    })

    test("after a failed attempt, the same key works once the problem is gone", async () => {
        const key = newKey()
        jest.spyOn(ledgerModel, "insertMany").mockRejectedValueOnce(new Error("simulated crash"))
        expect((await sendTransfer(alice, { to: bob.wallet.id, amount: 100, key })).status).toBe(500)

        const retry = await sendTransfer(alice, { to: bob.wallet.id, amount: 100, key })
        expect(retry.status).toBe(201)
        expect(await balanceOf(bob.wallet.id)).toBe(100)
        await expectBooksBalanced()
    })
})
