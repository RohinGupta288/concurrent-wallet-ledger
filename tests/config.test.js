/**
 * Configuration validation and replica-set enforcement.
 */
const { validateConfig } = require("../src/config/env")
const { connectToDB } = require("../src/config/db")
const { MongoMemoryServer } = require("mongodb-memory-server")

const validConfig = {
    mongoUri: "mongodb://127.0.0.1:27017/x?replicaSet=rs0",
    jwtSecret: "a".repeat(32),
    port: 3000,
    bcryptSaltRounds: 10,
    txnMaxAttempts: 5,
}

describe("validateConfig", () => {
    test("accepts a complete configuration", () => {
        expect(() => validateConfig(validConfig)).not.toThrow()
    })

    test("rejects a missing MONGO_URI", () => {
        expect(() => validateConfig({ ...validConfig, mongoUri: undefined })).toThrow(/MONGO_URI/)
    })

    test("rejects a missing or short JWT_SECRET", () => {
        expect(() => validateConfig({ ...validConfig, jwtSecret: undefined })).toThrow(/JWT_SECRET/)
        expect(() => validateConfig({ ...validConfig, jwtSecret: "short" })).toThrow(/JWT_SECRET/)
    })

    test("rejects out-of-range numeric settings", () => {
        expect(() => validateConfig({ ...validConfig, port: 0 })).toThrow(/PORT/)
        expect(() => validateConfig({ ...validConfig, bcryptSaltRounds: 2 })).toThrow(/BCRYPT_SALT_ROUNDS/)
        expect(() => validateConfig({ ...validConfig, txnMaxAttempts: 0 })).toThrow(/TXN_MAX_ATTEMPTS/)
    })
})

describe("connectToDB", () => {
    test("refuses a standalone (non-replica-set) MongoDB server", async () => {
        const standalone = await MongoMemoryServer.create()
        try {
            await expect(connectToDB(standalone.getUri("standalone-test"))).rejects.toThrow(/replica set/)
        } finally {
            await standalone.stop()
        }
    })
})
