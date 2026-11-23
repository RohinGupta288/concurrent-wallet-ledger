/**
 * Module A: registration, login, logout, profile and token handling.
 * Each test checks the HTTP response AND, where relevant, the database state.
 */
const request = require("supertest")
const jwt = require("jsonwebtoken")
const app = require("../src/app")
const userModel = require("../src/models/user.model")
const tokenBlackListModel = require("../src/models/blackList.model")
const { connectTestDB, clearDatabase, closeTestDB } = require("./helpers/db")
const { registerUser } = require("./helpers/auth")

beforeAll(connectTestDB)
beforeEach(clearDatabase)
afterAll(closeTestDB)

const validUser = { name: "Alice", email: "alice@example.test", password: "correct-horse-battery" }

describe("POST /api/auth/register", () => {
    test("creates a user, returns a token, never returns the password", async () => {
        const res = await request(app).post("/api/auth/register").send(validUser)

        expect(res.status).toBe(201)
        expect(res.body.user).toEqual({
            id: expect.any(String),
            name: "Alice",
            email: "alice@example.test",
            createdAt: expect.any(String),
        })
        expect(typeof res.body.token).toBe("string")
        expect(JSON.stringify(res.body)).not.toMatch(/password|\$2[aby]\$/)

        // Database: the password is stored only as a bcrypt hash.
        const stored = await userModel.findOne({ email: "alice@example.test" }).select("+password")
        expect(stored.password).toMatch(/^\$2[aby]\$/)
        expect(stored.password).not.toBe(validUser.password)
    })

    test("normalizes email (trim + lowercase)", async () => {
        const res = await request(app).post("/api/auth/register")
            .send({ ...validUser, email: "  Alice@Example.TEST  " })

        expect(res.status).toBe(201)
        expect(res.body.user.email).toBe("alice@example.test")
    })

    test("rejects a duplicate email with 409, case-insensitively", async () => {
        await request(app).post("/api/auth/register").send(validUser).expect(201)
        const res = await request(app).post("/api/auth/register")
            .send({ ...validUser, email: "ALICE@example.test" })

        expect(res.status).toBe(409)
        expect(res.body.error.code).toBe("DUPLICATE_EMAIL")
        expect(await userModel.countDocuments()).toBe(1)
    })

    test("concurrent duplicate registrations create exactly one user (unique index)", async () => {
        const attempts = await Promise.all(
            Array.from({ length: 5 }, () => request(app).post("/api/auth/register").send(validUser))
        )
        const statuses = attempts.map((r) => r.status).sort()

        expect(statuses).toEqual([ 201, 409, 409, 409, 409 ])
        expect(await userModel.countDocuments({ email: validUser.email })).toBe(1)
    })

    test("lists every invalid field in a 400 VALIDATION_ERROR", async () => {
        const res = await request(app).post("/api/auth/register")
            .send({ name: "", email: "not-an-email", password: "short" })

        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe("VALIDATION_ERROR")
        expect(Object.keys(res.body.error.details).sort()).toEqual([ "email", "name", "password" ])
        expect(await userModel.countDocuments()).toBe(0)
    })

    test("rejects non-string values (operator injection) with 400", async () => {
        const res = await request(app).post("/api/auth/register")
            .send({ name: "Eve", email: { $gt: "" }, password: "correct-horse-battery" })

        expect(res.status).toBe(400)
        expect(res.body.error.details.email).toBeDefined()
    })

    test("rejects passwords longer than bcrypt's 72-byte limit", async () => {
        const res = await request(app).post("/api/auth/register")
            .send({ ...validUser, password: "a".repeat(73) })

        expect(res.status).toBe(400)
        expect(res.body.error.details.password).toBeDefined()
    })

    test("rejects a missing body", async () => {
        const res = await request(app).post("/api/auth/register")

        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe("VALIDATION_ERROR")
    })
})

describe("POST /api/auth/login", () => {
    beforeEach(async () => {
        await request(app).post("/api/auth/register").send(validUser).expect(201)
    })

    test("returns a token for correct credentials (email is case-insensitive)", async () => {
        const res = await request(app).post("/api/auth/login")
            .send({ email: "ALICE@example.test", password: validUser.password })

        expect(res.status).toBe(200)
        expect(res.body.user.email).toBe("alice@example.test")
        const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET)
        expect(decoded.userId).toBe(res.body.user.id)
    })

    test("rejects a wrong password with 401 INVALID_CREDENTIALS", async () => {
        const res = await request(app).post("/api/auth/login")
            .send({ email: validUser.email, password: "wrong-password" })

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe("INVALID_CREDENTIALS")
        expect(res.body.token).toBeUndefined()
    })

    test("gives the same response for an unknown email (no account enumeration)", async () => {
        const res = await request(app).post("/api/auth/login")
            .send({ email: "nobody@example.test", password: "whatever-password" })

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe("INVALID_CREDENTIALS")
    })

    test("rejects operator injection in email with 400", async () => {
        const res = await request(app).post("/api/auth/login")
            .send({ email: { $gt: "" }, password: validUser.password })

        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe("VALIDATION_ERROR")
    })
})

describe("GET /api/auth/me and token validation", () => {
    test("returns the profile for a valid token", async () => {
        const { user, auth } = await registerUser()
        const res = await request(app).get("/api/auth/me").set(auth)

        expect(res.status).toBe(200)
        expect(res.body.user).toEqual(user)
    })

    test("401 UNAUTHENTICATED without a token", async () => {
        const res = await request(app).get("/api/auth/me")

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe("UNAUTHENTICATED")
    })

    test("401 UNAUTHENTICATED for a non-Bearer Authorization header", async () => {
        const { token } = await registerUser()
        const res = await request(app).get("/api/auth/me").set("Authorization", `Token ${token}`)

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe("UNAUTHENTICATED")
    })

    test("cookies are not accepted as authentication", async () => {
        const { token } = await registerUser()
        const res = await request(app).get("/api/auth/me").set("Cookie", `token=${token}`)

        expect(res.status).toBe(401)
    })

    test("401 INVALID_TOKEN for a garbage token", async () => {
        const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer not.a.jwt")

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe("INVALID_TOKEN")
    })

    test("401 INVALID_TOKEN for a token signed with a different secret", async () => {
        const { user } = await registerUser()
        const forged = jwt.sign({ userId: user.id }, "some-other-secret-that-is-long-enough-123")
        const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${forged}`)

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe("INVALID_TOKEN")
    })

    test("401 INVALID_TOKEN for an unsigned (alg: none) token", async () => {
        const { user } = await registerUser()
        const unsigned = jwt.sign({ userId: user.id }, null, { algorithm: "none" })
        const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${unsigned}`)

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe("INVALID_TOKEN")
    })

    test("401 TOKEN_EXPIRED for an expired token", async () => {
        const { user } = await registerUser()
        const expired = jwt.sign(
            { userId: user.id, exp: Math.floor(Date.now() / 1000) - 60 },
            process.env.JWT_SECRET
        )
        const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${expired}`)

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe("TOKEN_EXPIRED")
    })

    test("401 INVALID_TOKEN when the user has been deleted", async () => {
        const { user, auth } = await registerUser()
        await userModel.deleteOne({ _id: user.id })
        const res = await request(app).get("/api/auth/me").set(auth)

        expect(res.status).toBe(401)
        expect(res.body.error.code).toBe("INVALID_TOKEN")
    })
})

describe("POST /api/auth/logout", () => {
    test("revokes the token; the database stores only its hash", async () => {
        const { token, auth } = await registerUser()

        const res = await request(app).post("/api/auth/logout").set(auth)
        expect(res.status).toBe(200)

        const after = await request(app).get("/api/auth/me").set(auth)
        expect(after.status).toBe(401)
        expect(after.body.error.code).toBe("INVALID_TOKEN")

        const rows = await tokenBlackListModel.find().lean()
        expect(rows).toHaveLength(1)
        expect(rows[ 0 ].tokenHash).toMatch(/^[0-9a-f]{64}$/)
        expect(JSON.stringify(rows)).not.toContain(token)
        expect(rows[ 0 ].expiresAt.getTime()).toBeGreaterThan(Date.now())
    })

    test("does not revoke the user's other sessions", async () => {
        const { user, password, auth } = await registerUser()
        const second = await request(app).post("/api/auth/login").send({ email: user.email, password })

        await request(app).post("/api/auth/logout").set(auth).expect(200)

        const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${second.body.token}`)
        expect(res.status).toBe(200)
    })

    test("requires authentication (cannot write arbitrary blacklist rows)", async () => {
        const res = await request(app).post("/api/auth/logout").set("Authorization", "Bearer garbage")

        expect(res.status).toBe(401)
        expect(await tokenBlackListModel.countDocuments()).toBe(0)
    })
})
