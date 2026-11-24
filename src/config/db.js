/**
 * MongoDB connection management.
 *
 * MongoDB multi-document transactions only work on a replica set (or sharded
 * cluster), never on a standalone server. This file therefore refuses to start
 * against a standalone server instead of silently losing atomicity.
 */
const mongoose = require("mongoose")
const logger = require("../utils/logger")

// Load every model so ensureIndexes() below knows about all of them.
require("../models/user.model")
require("../models/account.model")
require("../models/transaction.model")
require("../models/ledger.model")
require("../models/blackList.model")

/**
 * Creates every index declared in the schemas that is missing. The unique
 * indexes are business rules (one wallet per user, one use per idempotency
 * key...), so they must exist before the first request is served.
 *
 * It never DROPS an index. (Mongoose's syncIndexes() would drop any index the
 * running code does not declare, e.g. one created by a newer version of the app
 * during a rolling deploy.)
 */
async function ensureIndexes() {
    for (const model of Object.values(mongoose.models)) {
        await model.createIndexes()
    }
}

/**
 * Connects and checks that the server is a replica set.
 * `{ createIndexes: false }` is for read-only tools (npm run reconcile), which
 * must not change the database at all, not even its indexes.
 */
async function connectToDB(uri, { createIndexes = true } = {}) {
    await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10000,
        // Indexes are created explicitly below (or not at all), never implicitly.
        autoIndex: false,
        // Hand the driver Node's own `os` module. Otherwise the driver loads it
        // with a dynamic import(), which Jest's test sandbox rejects, and the
        // connection handshake then fails. Behaviour is identical otherwise.
        runtimeAdapters: { os: require("os") },
    })

    const hello = await mongoose.connection.db.admin().command({ hello: 1 })
    if (!hello.setName) {
        await mongoose.disconnect()
        throw new Error(
            "MongoDB is running as a standalone server, but this app needs a replica set " +
            "for multi-document transactions. See README.md, section 8."
        )
    }

    if (createIndexes) {
        await ensureIndexes()
    }

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

module.exports = { connectToDB, disconnectFromDB, checkDBHealth, ensureIndexes }
