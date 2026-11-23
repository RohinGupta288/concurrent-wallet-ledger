/**
 * Runs once before the whole test suite.
 *
 * Starts a throw-away single-node MongoDB *replica set* (real mongod binary,
 * downloaded by mongodb-memory-server) so that tests exercise genuine
 * multi-document transactions. A standalone server is never used.
 *
 * Set TEST_MONGO_URI to use an existing replica set instead.
 */
const { MongoMemoryReplSet } = require("mongodb-memory-server")

module.exports = async function globalSetup() {
    if (process.env.TEST_MONGO_URI) {
        process.env.MONGO_URI = process.env.TEST_MONGO_URI
        return
    }

    const replSet = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: "wiredTiger" },
    })
    globalThis.__MONGO_REPLSET__ = replSet
    process.env.MONGO_URI = replSet.getUri("backend-ledger-test")
}
