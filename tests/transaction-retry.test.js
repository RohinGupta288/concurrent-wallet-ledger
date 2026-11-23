/**
 * Unit tests for runInTransaction (src/config/transaction.js) using a real
 * replica set and fake, correctly labelled MongoDB errors.
 */
const mongoose = require("mongoose")
const { runInTransaction } = require("../src/config/transaction")
const AppError = require("../src/utils/AppError")
const { connectTestDB, clearDatabase, closeTestDB } = require("./helpers/db")

const { ClientSession } = mongoose.mongo

beforeAll(connectTestDB)
beforeEach(clearDatabase)
afterAll(closeTestDB)
afterEach(() => jest.restoreAllMocks())

const probe = () => mongoose.connection.collection("retry_probe")

function labelled(label, message = "simulated") {
    const err = new Error(message)
    err.errorLabels = [ label ]
    return err
}

test("retries a TransientTransactionError and keeps only the successful attempt's writes", async () => {
    let calls = 0
    const result = await runInTransaction(async (session) => {
        calls += 1
        await probe().insertOne({ attempt: calls }, { session })
        if (calls < 3) throw labelled("TransientTransactionError", "WriteConflict")
        return "done"
    })

    expect(result).toBe("done")
    expect(calls).toBe(3)
    const docs = await probe().find().toArray()
    expect(docs.map((d) => d.attempt)).toEqual([ 3 ]) // attempts 1 and 2 were rolled back
})

test("gives up after maxAttempts with 503 TRANSACTION_RETRY_EXHAUSTED and writes nothing", async () => {
    let calls = 0
    const attempt = runInTransaction(async (session) => {
        calls += 1
        await probe().insertOne({ attempt: calls }, { session })
        throw labelled("TransientTransactionError")
    }, { maxAttempts: 3 })

    await expect(attempt).rejects.toMatchObject({ statusCode: 503, code: "TRANSACTION_RETRY_EXHAUSTED" })
    expect(calls).toBe(3)
    expect(await probe().countDocuments()).toBe(0)
})

test("never retries a business error (AppError) and rolls back its writes", async () => {
    let calls = 0
    const businessError = new AppError(422, "INSUFFICIENT_FUNDS", "no")
    const attempt = runInTransaction(async (session) => {
        calls += 1
        await probe().insertOne({ x: 1 }, { session })
        throw businessError
    })

    await expect(attempt).rejects.toBe(businessError)
    expect(calls).toBe(1)
    expect(await probe().countDocuments()).toBe(0)
})

test("never retries an unlabelled error", async () => {
    let calls = 0
    await expect(runInTransaction(async () => {
        calls += 1
        throw new Error("bug")
    })).rejects.toThrow("bug")
    expect(calls).toBe(1)
})

test("UnknownTransactionCommitResult: re-sends the commit without re-running the work", async () => {
    const realCommit = ClientSession.prototype.commitTransaction
    let commitCalls = 0
    jest.spyOn(ClientSession.prototype, "commitTransaction").mockImplementation(function (...args) {
        commitCalls += 1
        if (commitCalls === 1) return Promise.reject(labelled("UnknownTransactionCommitResult"))
        return realCommit.apply(this, args)
    })

    let calls = 0
    const result = await runInTransaction(async (session) => {
        calls += 1
        await probe().insertOne({ x: 1 }, { session })
        return "ok"
    })

    expect(result).toBe("ok")
    expect(calls).toBe(1)
    expect(commitCalls).toBe(2)
    expect(await probe().countDocuments()).toBe(1)
})

test("UnknownTransactionCommitResult on every commit attempt -> 503 after a bounded number of commits", async () => {
    let commitCalls = 0
    jest.spyOn(ClientSession.prototype, "commitTransaction").mockImplementation(() => {
        commitCalls += 1
        return Promise.reject(labelled("UnknownTransactionCommitResult"))
    })

    await expect(runInTransaction(async (session) => {
        await probe().insertOne({ x: 1 }, { session })
    })).rejects.toMatchObject({ statusCode: 503, code: "TRANSACTION_RETRY_EXHAUSTED" })
    expect(commitCalls).toBe(3)
})

test("a commit that fails with TransientTransactionError re-runs the whole transaction", async () => {
    const realCommit = ClientSession.prototype.commitTransaction
    let commitCalls = 0
    jest.spyOn(ClientSession.prototype, "commitTransaction").mockImplementation(function (...args) {
        commitCalls += 1
        if (commitCalls === 1) return Promise.reject(labelled("TransientTransactionError"))
        return realCommit.apply(this, args)
    })

    let calls = 0
    await runInTransaction(async (session) => {
        calls += 1
        await probe().insertOne({ attempt: calls }, { session })
    })

    expect(calls).toBe(2)
    const docs = await probe().find().toArray()
    expect(docs.map((d) => d.attempt)).toEqual([ 2 ])
})

test("a real write conflict between two transactions is retried and both succeed", async () => {
    await probe().insertOne({ _id: "counter", value: 0 })
    let totalCalls = 0
    const increment = () => runInTransaction(async (session) => {
        totalCalls += 1
        await probe().updateOne({ _id: "counter" }, { $inc: { value: 1 } }, { session })
        // Hold the write briefly so the two transactions overlap.
        await new Promise((resolve) => setTimeout(resolve, 50))
    })

    await Promise.all([ increment(), increment() ])

    const counter = await probe().findOne({ _id: "counter" })
    expect(counter.value).toBe(2)
    expect(totalCalls).toBeGreaterThan(2) // at least one attempt hit a WriteConflict and was retried
})
