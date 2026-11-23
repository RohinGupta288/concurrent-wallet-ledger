/**
 * Database helpers shared by all test files.
 *
 * Tests run one file at a time (`jest --runInBand`) against one test database.
 * Each file connects in beforeAll, wipes data in beforeEach and disconnects in afterAll.
 */
const mongoose = require("mongoose")
const { connectToDB, disconnectFromDB } = require("../../src/config/db")

async function connectTestDB() {
    const uri = process.env.MONGO_URI
    const dbName = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, "http://")).pathname.slice(1)
    if (!dbName.includes("test")) {
        // Safety net: tests delete everything, so never run against a real database.
        throw new Error(`Refusing to run tests against database "${dbName}": its name must contain "test"`)
    }
    await connectToDB(uri)
}

/**
 * Deletes all documents but keeps collections and indexes.
 * Uses the native driver on purpose: the ledger model blocks deletes through
 * Mongoose (entries are immutable), but tests need a clean slate.
 */
async function clearDatabase() {
    const collections = await mongoose.connection.db.collections()
    await Promise.all(collections.map((collection) => collection.deleteMany({})))
}

async function closeTestDB() {
    await disconnectFromDB()
}

module.exports = { connectTestDB, clearDatabase, closeTestDB }
