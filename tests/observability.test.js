/**
 * Module I: structured logs, request IDs and safe error responses.
 *
 * captureLogs() records every line the logger writes, so tests can check what
 * IS logged (request id, user id, transaction id, error code) and what is
 * NEVER logged (passwords, JWTs, secrets, request bodies, query strings).
 */
const request = require("supertest")
const app = require("../src/app")
const logger = require("../src/utils/logger")
const accountModel = require("../src/models/account.model")
const { runInTransaction } = require("../src/config/transaction")
const { connectTestDB, clearDatabase, closeTestDB } = require("./helpers/db")
const { registerUserWithWallet } = require("./helpers/auth")
const { fund, sendTransfer } = require("./helpers/money")

beforeAll(connectTestDB)
beforeEach(clearDatabase)
afterAll(closeTestDB)

let lines
let savedLevel
beforeEach(() => {
    lines = []
    savedLevel = process.env.LOG_LEVEL
    process.env.LOG_LEVEL = "debug"
    const capture = (line) => lines.push(String(line))
    jest.spyOn(console, "log").mockImplementation(capture)
    jest.spyOn(console, "error").mockImplementation(capture)
})
afterEach(() => {
    process.env.LOG_LEVEL = savedLevel
    jest.restoreAllMocks()
})

const parsed = () => lines.map((line) => JSON.parse(line)) // every line must be valid JSON
const requestLogs = () => parsed().filter((l) => l.event === "http.request")
// The 'finish' event can fire just after Supertest resolves; wait one tick.
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe("request log lines", () => {
    test("a transfer is logged with request id, user id, transaction id and timing", async () => {
        const alice = await registerUserWithWallet()
        const bob = await registerUserWithWallet()
        await fund(alice.wallet.id, 10000)
        lines = []

        const res = await sendTransfer(alice, { to: bob.wallet.id, amount: 500 }).expect(201)
        await settle()

        const [ entry ] = requestLogs()
        expect(entry).toEqual({
            time: expect.any(String),
            level: "info",
            event: "http.request",
            requestId: res.headers[ "x-request-id" ],
            method: "POST",
            path: "/api/transactions",
            status: 201,
            durationMs: expect.any(Number),
            userId: alice.user.id,
            transactionId: res.body.transaction.id,
        })
    })

    test("a rejected transfer is logged with its error code and no transaction id", async () => {
        const alice = await registerUserWithWallet()
        const bob = await registerUserWithWallet()
        lines = []

        await sendTransfer(alice, { to: bob.wallet.id, amount: 500 }).expect(422)
        await settle()

        const [ entry ] = requestLogs()
        expect(entry).toMatchObject({ status: 422, errorCode: "INSUFFICIENT_FUNDS", userId: alice.user.id })
        expect(entry.transactionId).toBeUndefined()
    })

    test("query strings are not logged", async () => {
        const alice = await registerUserWithWallet()
        lines = []

        await request(app).get("/api/transactions?page=1&limit=5&note=private").set(alice.auth).expect(200)
        await settle()

        expect(requestLogs()[ 0 ].path).toBe("/api/transactions")
        expect(lines.join("\n")).not.toMatch(/limit=|private/)
    })

    test("every response, including errors, carries a request id that matches the error body", async () => {
        for (const res of [
            await request(app).get("/no-such-route"),
            await request(app).get("/api/accounts"),
            await request(app).post("/api/auth/login").send({}),
        ]) {
            expect(res.headers[ "x-request-id" ]).toMatch(/^[0-9a-f-]{36}$/)
            expect(res.body.error.requestId).toBe(res.headers[ "x-request-id" ])
        }
    })
})

describe("sensitive data never reaches the logs", () => {
    test("passwords, JWTs, the JWT secret and request bodies are absent from all log output", async () => {
        const password = "Very-Secret-Pass-123"
        const email = "observed@example.test"

        const registered = await request(app).post("/api/auth/register")
            .send({ name: "Observed", email, password }).expect(201)
        const token = registered.body.token
        const auth = { Authorization: `Bearer ${token}` }
        await request(app).post("/api/auth/login").send({ email, password: "Wrong-Password-999" }).expect(401)
        const login = await request(app).post("/api/auth/login").send({ email, password }).expect(200)
        await request(app).post("/api/accounts").set(auth).expect(201)
        await request(app).get("/api/auth/me").set(auth).expect(200)
        await request(app).post("/api/auth/login").set("Content-Type", "application/json")
            .send(`{"email":"${email}","password":"${password}"`).expect(400) // malformed JSON
        await request(app).post("/api/auth/logout").set(auth).expect(200)
        await request(app).get("/api/auth/me").set(auth).expect(401) // revoked token
        await settle()

        const output = lines.join("\n")
        expect(lines.length).toBeGreaterThanOrEqual(8)
        for (const secret of [
            password, "Wrong-Password-999", token, login.body.token, process.env.JWT_SECRET, "Bearer", "eyJ",
        ]) {
            expect(output).not.toContain(secret)
        }
        expect(output).not.toMatch(/\$2[aby]\$/) // no bcrypt hashes
        expect(output).not.toContain(email) // no request bodies / personal data
    })

    test("the logger redacts fields with sensitive names", () => {
        logger.info("test.redaction", { password: "p", authToken: "t", jwtSecret: "s", Authorization: "a", userId: "u1" })

        expect(parsed()[ 0 ]).toMatchObject({
            event: "test.redaction",
            password: "[REDACTED]",
            authToken: "[REDACTED]",
            jwtSecret: "[REDACTED]",
            Authorization: "[REDACTED]",
            userId: "u1",
        })
    })
})

describe("unexpected errors", () => {
    test("500 hides internals from the client but logs the stack with the request id", async () => {
        const alice = await registerUserWithWallet()
        jest.spyOn(accountModel, "find").mockImplementation(() => {
            throw new Error("internal detail: something broke at layer 7")
        })
        lines = []

        const res = await request(app).get("/api/accounts").set(alice.auth)
        await settle()

        expect(res.status).toBe(500)
        expect(res.body).toEqual({
            error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId: res.headers[ "x-request-id" ] },
        })
        expect(JSON.stringify(res.body)).not.toMatch(/internal detail|\.js:\d+|stack/)

        const errorLog = parsed().find((l) => l.event === "http.unhandled_error")
        expect(errorLog).toMatchObject({
            level: "error",
            requestId: res.headers[ "x-request-id" ],
            message: "internal detail: something broke at layer 7",
            stack: expect.stringContaining("Error: internal detail"),
        })
        expect(requestLogs()[ 0 ]).toMatchObject({ status: 500, errorCode: "INTERNAL_ERROR" })
    })

    test("a deliberate 503 (retries exhausted) is a warning with its code, not a crash with a stack", async () => {
        const alice = await registerUserWithWallet()
        const bob = await registerUserWithWallet()
        await fund(alice.wallet.id, 10000)
        const mongoose = require("mongoose")
        jest.spyOn(mongoose.mongo.ClientSession.prototype, "commitTransaction").mockImplementation(() => {
            const err = new Error("simulated")
            err.errorLabels = [ "TransientTransactionError" ]
            return Promise.reject(err)
        })
        const { config } = require("../src/config/env")
        const saved = config.txnMaxAttempts
        config.txnMaxAttempts = 1
        lines = []
        try {
            const res = await sendTransfer(alice, { to: bob.wallet.id, amount: 100 })
            await settle()
            expect(res.status).toBe(503)

            const logs = parsed()
            expect(logs.some((l) => l.event === "http.unhandled_error")).toBe(false)
            expect(logs.find((l) => l.event === "http.server_error_response")).toMatchObject({
                level: "warn", status: 503, errorCode: "TRANSACTION_RETRY_EXHAUSTED", requestId: res.headers[ "x-request-id" ],
            })
            expect(JSON.stringify(logs)).not.toContain("stack")
        } finally {
            config.txnMaxAttempts = saved
        }
    })

    test("client errors (4xx) are not logged as server errors", async () => {
        await request(app).get("/api/accounts").expect(401)
        await settle()

        expect(parsed().some((l) => l.level === "error")).toBe(false)
    })
})

describe("transaction retry logging", () => {
    test("a retried transaction logs the attempt and the reason", async () => {
        let calls = 0
        await runInTransaction(async () => {
            calls += 1
            if (calls === 1) {
                const err = new Error("simulated")
                err.codeName = "WriteConflict"
                err.errorLabels = [ "TransientTransactionError" ]
                throw err
            }
        })

        expect(parsed().find((l) => l.event === "txn.retry")).toMatchObject({ attempt: 1, reason: "WriteConflict" })
    })
})

describe("LOG_LEVEL", () => {
    test("warn hides info; silent hides everything", () => {
        process.env.LOG_LEVEL = "warn"
        logger.info("hidden.info")
        logger.warn("shown.warn")
        process.env.LOG_LEVEL = "silent"
        logger.error("hidden.error")

        expect(parsed().map((l) => l.event)).toEqual([ "shown.warn" ])
    })
})
