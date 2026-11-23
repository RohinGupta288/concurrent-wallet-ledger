/**
 * MongoDB connection management.
 *
 * MongoDB multi-document transactions only work on a replica set (or sharded
 * cluster), never on a standalone server. This file therefore refuses to start
 * against a standalone server instead of silently losing atomicity.
 */
const mongoose = require("mongoose")
const logger = require("../utils/logger")

// Load every model so syncIndexes() below knows about all of them.
require("../models/user.model")
require("../models/account.model")
require("../models/transaction.model")
require("../models/ledger.model")
require("../models/blackList.model")

async function connectToDB(uri) {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 })

    const hello = await mongoose.connection.db.admin().command({ hello: 1 })
    if (!hello.setName) {
        await mongoose.disconnect()
        throw new Error(
            "MongoDB is running as a standalone server, but this app needs a replica set " +
            "for multi-document transactions. See README.md > 'MongoDB setup'."
        )
    }

    // Make the database's indexes match the schemas. The unique indexes are
    // business rules (one wallet per user, one idempotency key per user...), so
    // they must exist before the first request is served.
    await mongoose.connection.syncIndexes()

    logger.info("db.connected", { database: mongoose.connection.name, replicaSet: hello.setName })
}

async function disconnectFromDB() {
    await mongoose.disconnect()
}

/**
 * Used by GET /health. Never throws; reports what it could determine.
 */
async function checkDBHealth() {
    if (mongoose.connection.readyState !== 1) {
        return { connected: false, replicaSet: null }
    }
    try {
        const hello = await mongoose.connection.db.admin().command({ hello: 1 })
        return { connected: true, replicaSet: hello.setName || null }
    } catch (err) {
        return { connected: false, replicaSet: null }
    }
}

module.exports = { connectToDB, disconnectFromDB, checkDBHealth }
