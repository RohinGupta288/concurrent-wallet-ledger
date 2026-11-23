/**
 * Helpers for creating users, auth headers and wallets in tests.
 */
const request = require("supertest")
const app = require("../../src/app")

let counter = 0

/** Registers a new user through the API and returns { user, token, password, auth }. */
async function registerUser(overrides = {}) {
    counter += 1
    const body = {
        name: `Test User ${counter}`,
        email: `user${counter}-${Date.now()}@example.test`,
        password: "correct-horse-battery",
        ...overrides,
    }
    const res = await request(app).post("/api/auth/register").send(body)
    if (res.status !== 201) {
        throw new Error(`registerUser failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
    return {
        user: res.body.user,
        token: res.body.token,
        password: body.password,
        auth: { Authorization: `Bearer ${res.body.token}` },
    }
}

/** Registers a user and creates their wallet through the API. Returns { ...registerUser(), wallet }. */
async function registerUserWithWallet(overrides = {}) {
    const registered = await registerUser(overrides)
    const res = await request(app).post("/api/accounts").set(registered.auth)
    if (res.status !== 201) {
        throw new Error(`create wallet failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
    return { ...registered, wallet: res.body.account }
}

module.exports = { registerUser, registerUserWithWallet }
