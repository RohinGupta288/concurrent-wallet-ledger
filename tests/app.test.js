/**
 * Foundation tests: health endpoint, consistent error format, request IDs.
 */
const request = require("supertest")
const mongoose = require("mongoose")
const app = require("../src/app")
const { connectTestDB, closeTestDB } = require("./helpers/db")

beforeAll(connectTestDB)
afterAll(closeTestDB)

describe("GET /health", () => {
    test("reports ok when MongoDB replica set is reachable", async () => {
        const res = await request(app).get("/health")

        expect(res.status).toBe(200)
        expect(res.body.status).toBe("ok")
        expect(res.body.database.connected).toBe(true)
        expect(typeof res.body.database.replicaSet).toBe("string")
    })
})

describe("error handling", () => {
    test("unknown route returns JSON 404 with code and request id", async () => {
        const res = await request(app).get("/api/does-not-exist")

        expect(res.status).toBe(404)
        expect(res.body.error.code).toBe("ROUTE_NOT_FOUND")
        expect(res.body.error.requestId).toBe(res.headers[ "x-request-id" ])
    })

    test("malformed JSON body returns 400 MALFORMED_JSON, not an HTML stack trace", async () => {
        const res = await request(app)
            .post("/api/auth/login")
            .set("Content-Type", "application/json")
            .send("{ not json")

        expect(res.status).toBe(400)
        expect(res.headers[ "content-type" ]).toMatch(/application\/json/)
        expect(res.body.error.code).toBe("MALFORMED_JSON")
        expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js/) // no stack frames
    })

    test("oversized body returns 413", async () => {
        const res = await request(app)
            .post("/api/auth/login")
            .send({ email: "a@example.com", password: "x".repeat(20 * 1024) })

        expect(res.status).toBe(413)
        expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE")
    })

    test.each([
        [ "an unsupported charset", { "Content-Type": "application/json; charset=bogus-xyz" } ],
        [ "an unsupported Content-Encoding", { "Content-Type": "application/json", "Content-Encoding": "foo" } ],
    ])("%s returns 415, not a 500 server error", async (name, headers) => {
        const res = await request(app).post("/api/auth/login").set(headers).send("{}")

        expect(res.status).toBe(415)
        expect(res.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE")
    })
})

describe("request ids", () => {
    test("a safe incoming X-Request-Id is echoed back", async () => {
        const res = await request(app).get("/health").set("X-Request-Id", "client-abc-123")
        expect(res.headers[ "x-request-id" ]).toBe("client-abc-123")
    })

    test("an unsafe incoming X-Request-Id is replaced by a generated UUID", async () => {
        const res = await request(app).get("/health").set("X-Request-Id", "bad id with spaces\" {}")
        expect(res.headers[ "x-request-id" ]).toMatch(/^[0-9a-f-]{36}$/)
    })
})

// Keep this last: it disconnects the database on purpose.
describe("GET /health when the database is down", () => {
    test("returns 503", async () => {
        await mongoose.disconnect()
        const res = await request(app).get("/health")

        expect(res.status).toBe(503)
        expect(res.body.status).toBe("unavailable")
        expect(res.body.database.connected).toBe(false)
    })
})
