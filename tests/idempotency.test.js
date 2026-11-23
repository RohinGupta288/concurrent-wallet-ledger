/**
 * Module F: idempotency of POST /api/transactions.
 * Rule: one idempotency key = at most one completed transfer, per user.
 */
const mongoose = require("mongoose")
const transactionModel = require("../src/models/transaction.model")
const { connectTestDB, clearDatabase, closeTestDB } = require("./helpers/db")
const { registerUserWithWallet } = require("./helpers/auth")
const { fund, newKey, sendTransfer } = require("./helpers/money")
const { expectBooksBalanced, balanceOf } = require("./helpers/invariants")

const { ClientSession } = mongoose.mongo

beforeAll(connectTestDB)
beforeEach(clearDatabase)
afterAll(closeTestDB)
afterEach(() => jest.restoreAllMocks())

let alice
let bob
let charlie
beforeEach(async () => {
    alice = await registerUserWithWallet()
    bob = await registerUserWithWallet()
    charlie = await registerUserWithWallet()
    await fund(alice.wallet.id, 100000)
    await fund(bob.wallet.id, 100000)
})

const transfersBy = (user) => transactionModel.countDocuments({ type: "TRANSFER", initiatedBy: user.user.id })

test("repeating a request with the same key replays the result and moves money once", async () => {
    const key = newKey()
    const first = await sendTransfer(alice, { to: bob.wallet.id, amount: 2500, key })
    const second = await sendTransfer(alice, { to: bob.wallet.id, amount: 2500, key })
    const third = await sendTransfer(alice, { to: bob.wallet.id, amount: 2500, key })

    expect(first.status).toBe(201)
    expect(first.body.idempotentReplay).toBe(false)
    for (const replay of [ second, third ]) {
        expect(replay.status).toBe(200)
        expect(replay.body.idempotentReplay).toBe(true)
        expect(replay.body.transaction).toEqual(first.body.transaction)
    }
    expect(await balanceOf(alice.wallet.id)).toBe(97500)
    expect(await balanceOf(bob.wallet.id)).toBe(102500)
    expect(await transfersBy(alice)).toBe(1)
    await expectBooksBalanced()
})

test("a replay still works after the balance changed (it is not re-validated)", async () => {
    const key = newKey()
    await sendTransfer(alice, { to: bob.wallet.id, amount: 100000, key }).expect(201)
    expect(await balanceOf(alice.wallet.id)).toBe(0)

    const replay = await sendTransfer(alice, { to: bob.wallet.id, amount: 100000, key })
    expect(replay.status).toBe(200)
    expect(replay.body.idempotentReplay).toBe(true)
})

test.each([
    [ "different amount", { amount: 9999 } ],
    [ "different destination", { to: "charlie" } ],
])("reusing a key with a %s -> 409 IDEMPOTENCY_KEY_REUSED, nothing moves", async (label, change) => {
    const key = newKey()
    await sendTransfer(alice, { to: bob.wallet.id, amount: 2500, key }).expect(201)

    const to = change.to === "charlie" ? charlie.wallet.id : bob.wallet.id
    const res = await sendTransfer(alice, { to, amount: change.amount || 2500, key })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED")
    expect(await balanceOf(alice.wallet.id)).toBe(97500)
    expect(await balanceOf(charlie.wallet.id)).toBe(0)
    expect(await transfersBy(alice)).toBe(1)
})

test("keys are scoped per user: two users may use the same key independently", async () => {
    const key = "shared-key-rent-2026-11"
    const fromAlice = await sendTransfer(alice, { to: charlie.wallet.id, amount: 1000, key })
    const fromBob = await sendTransfer(bob, { to: charlie.wallet.id, amount: 3000, key })

    expect(fromAlice.status).toBe(201)
    expect(fromBob.status).toBe(201)
    expect(fromBob.body.transaction.id).not.toBe(fromAlice.body.transaction.id)
    expect(await balanceOf(charlie.wallet.id)).toBe(4000)
    await expectBooksBalanced()
})

test("another user cannot read a transfer by reusing its key", async () => {
    const key = newKey()
    await sendTransfer(alice, { to: bob.wallet.id, amount: 1000, key }).expect(201)

    // Bob replays Alice's exact body and key: he is not the owner of the source wallet.
    const res = await sendTransfer(bob, { from: alice.wallet.id, to: bob.wallet.id, amount: 1000, key })
    expect(res.status).toBe(403)
    expect(res.body.transaction).toBeUndefined()
})

test("a rejected request does not consume its key", async () => {
    const key = newKey()
    const tooMuch = await sendTransfer(charlie, { to: alice.wallet.id, amount: 5000, key })
    expect(tooMuch.status).toBe(422)

    await fund(charlie.wallet.id, 5000)
    const retry = await sendTransfer(charlie, { to: alice.wallet.id, amount: 5000, key })
    expect(retry.status).toBe(201)
    expect(await balanceOf(charlie.wallet.id)).toBe(0)
})

test.each([
    [ "missing", undefined ],
    [ "too short", "abc" ],
    [ "too long", "k".repeat(129) ],
    [ "invalid characters", "key with spaces!" ],
    [ "not a string", 12345678 ],
])("idempotencyKey %s -> 400", async (label, key) => {
    const res = await sendTransfer(alice, { to: bob.wallet.id, amount: 100, key: key === undefined ? null : key })

    expect(res.status).toBe(400)
    expect(res.body.error.details.idempotencyKey).toBeDefined()
})

describe("uncertain commit outcome", () => {
    function unknownCommitResult() {
        const err = new Error("simulated network error during commit")
        err.errorLabels = [ "UnknownTransactionCommitResult" ]
        return err
    }

    test("commit happened but the server never learned it: 503, then a retry with the same key replays", async () => {
        const realCommit = ClientSession.prototype.commitTransaction
        jest.spyOn(ClientSession.prototype, "commitTransaction").mockImplementation(async function (...args) {
            await realCommit.apply(this, args) // the commit really succeeds...
            throw unknownCommitResult()        // ...but the reply is "lost"
        })
        const key = newKey()

        const first = await sendTransfer(alice, { to: bob.wallet.id, amount: 7000, key })
        expect(first.status).toBe(503)
        expect(first.body.error.code).toBe("TRANSACTION_RETRY_EXHAUSTED")

        jest.restoreAllMocks()
        const retry = await sendTransfer(alice, { to: bob.wallet.id, amount: 7000, key })
        expect(retry.status).toBe(200)
        expect(retry.body.idempotentReplay).toBe(true)

        // Money moved exactly once.
        expect(await balanceOf(alice.wallet.id)).toBe(93000)
        expect(await balanceOf(bob.wallet.id)).toBe(107000)
        expect(await transfersBy(alice)).toBe(1)
        await expectBooksBalanced()
    })

    test("commit did not happen: 503, then a retry with the same key executes once", async () => {
        jest.spyOn(ClientSession.prototype, "commitTransaction").mockRejectedValue(unknownCommitResult())
        const key = newKey()

        const first = await sendTransfer(alice, { to: bob.wallet.id, amount: 7000, key })
        expect(first.status).toBe(503)
        jest.restoreAllMocks()
        expect(await balanceOf(alice.wallet.id)).toBe(100000) // nothing applied

        const retry = await sendTransfer(alice, { to: bob.wallet.id, amount: 7000, key })
        expect(retry.status).toBe(201)
        expect(await balanceOf(alice.wallet.id)).toBe(93000)
        expect(await transfersBy(alice)).toBe(1)
        await expectBooksBalanced()
    })
})
