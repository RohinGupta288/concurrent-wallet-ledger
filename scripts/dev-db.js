/**
 * `npm run db:dev`: zero-install local MongoDB for development.
 *
 * Starts a real `mongod` process (MongoDB 8.0, the same binary the tests use,
 * downloaded by mongodb-memory-server) as a single-node replica set named
 * "rs0", storing data persistently in ./.data/mongodb. Leave this terminal
 * open while you work; press Ctrl+C to stop MongoDB cleanly.
 *
 * Prefer a normal MongoDB Community installation if you can (see README.md);
 * this script is the fallback when you cannot install software system-wide.
 */
const path = require("path")
const fs = require("fs")
const { spawn } = require("child_process")
const { MongoClient } = require("mongoose").mongo // the MongoDB driver bundled with Mongoose
const { MongoBinary } = require("mongodb-memory-server")

const PORT = Number(process.env.DEV_DB_PORT || 27017)
const REPLICA_SET = "rs0"
// DEV_DB_DIR moves the data folder, e.g. out of a OneDrive/Dropbox-synced
// project folder: sync clients may lock or upload a live database's files.
const ROOT = process.env.DEV_DB_DIR ? path.resolve(process.env.DEV_DB_DIR) : path.join(__dirname, "..", ".data")
const DATA_DIR = path.join(ROOT, "mongodb")
const LOG_FILE = path.join(ROOT, "mongod.log")

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForServer(client) {
    // mongod needs a moment to start; retry the connection for up to ~30s.
    for (let attempt = 1; attempt <= 60; attempt++) {
        try {
            await client.connect()
            await client.db("admin").command({ ping: 1 })
            return
        } catch (err) {
            await delay(500)
        }
    }
    throw new Error(`mongod did not start on port ${PORT}; see ${LOG_FILE}`)
}

async function initiateReplicaSet(admin) {
    try {
        await admin.command({
            replSetInitiate: { _id: REPLICA_SET, members: [ { _id: 0, host: `127.0.0.1:${PORT}` } ] },
        })
        console.log("Replica set initialised (first run).")
    } catch (err) {
        if (err.codeName !== "AlreadyInitialized") throw err
    }
    // Wait until this node has been elected primary and accepts writes.
    for (let attempt = 1; attempt <= 60; attempt++) {
        const hello = await admin.command({ hello: 1 })
        if (hello.isWritablePrimary) return
        await delay(500)
    }
    throw new Error("Replica set did not elect a primary in time")
}

async function main() {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const binary = await MongoBinary.getPath()

    const mongod = spawn(binary, [
        "--dbpath", DATA_DIR,
        "--port", String(PORT),
        "--bind_ip", "127.0.0.1",
        "--replSet", REPLICA_SET,
        "--logpath", LOG_FILE,
        "--logappend",
    ], { stdio: "inherit" })

    mongod.on("exit", (code) => {
        console.log(`mongod exited (code ${code}).`)
        process.exit(code ?? 0)
    })

    // directConnection: talk to this one node even before the replica set exists.
    const directUrl = `mongodb://127.0.0.1:${PORT}/?directConnection=true`
    const client = new MongoClient(directUrl)
    try {
        await waitForServer(client)
        await initiateReplicaSet(client.db("admin"))
    } catch (err) {
        mongod.kill()
        throw err
    } finally {
        await client.close()
    }

    console.log("")
    console.log(`MongoDB ${path.basename(binary)} is running as replica set "${REPLICA_SET}".`)
    console.log(`  MONGO_URI=mongodb://127.0.0.1:${PORT}/backend-ledger?replicaSet=${REPLICA_SET}`)
    console.log(`  data: ${DATA_DIR}`)
    console.log(`  log:  ${LOG_FILE}`)
    console.log("Press Ctrl+C to stop.")

    // Ctrl+C: ask mongod to shut down cleanly via the admin "shutdown" command
    // (on Windows, killing the process would skip the clean shutdown).
    // The 'exit' handler above then ends this script.
    let stopping = false
    const stop = async () => {
        if (stopping) return
        stopping = true
        console.log("Stopping mongod...")
        const admin = new MongoClient(directUrl)
        try {
            await admin.connect()
            await admin.db("admin").command({ shutdown: 1 })
        } catch (err) {
            // Expected: mongod closes the connection while it shuts down.
        } finally {
            await admin.close().catch(() => {})
        }
    }
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
}

main().catch((err) => {
    console.error(`db:dev failed: ${err.message}`)
    process.exit(1)
})
