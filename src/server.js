/**
 * Process entry point (`npm start`).
 *
 * Order matters: validate configuration -> connect to MongoDB -> start
 * listening. The server never accepts requests before the database (and its
 * unique indexes) is ready.
 */
const { config, validateConfig } = require("./config/env")
const { connectToDB, disconnectFromDB } = require("./config/db")
const app = require("./app")
const logger = require("./utils/logger")

async function start() {
    validateConfig()
    await connectToDB(config.mongoUri)

    // Express 5 also calls this callback when listening FAILS, passing the
    // error; that case is logged by the 'error' handler below.
    const server = app.listen(config.port, (err) => {
        if (err) return
        logger.info("server.started", { port: config.port, nodeEnv: config.nodeEnv })
    })
    // e.g. EADDRINUSE when another process already uses the port: fail loudly.
    server.on("error", async (err) => {
        logger.error("server.listen_failed", { code: err.code, message: err.message })
        await disconnectFromDB()
        process.exit(1)
    })

    // Graceful shutdown: stop accepting connections, let in-flight requests
    // finish, then close the database connection.
    let shuttingDown = false
    function shutdown(signal) {
        if (shuttingDown) return
        shuttingDown = true
        logger.info("server.stopping", { signal })
        server.close(async () => {
            await disconnectFromDB()
            logger.info("server.stopped")
            process.exit(0)
        })
    }
    process.on("SIGINT", () => shutdown("SIGINT"))
    process.on("SIGTERM", () => shutdown("SIGTERM"))
}

// A bug outside any request (e.g. a promise nobody awaited). The process
// state may be broken, so log it as one JSON line and exit; a process
// manager or the developer restarts the server.
process.on("unhandledRejection", (reason) => {
    logger.error("process.unhandled_rejection", {
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
    })
    process.exit(1)
})

start().catch((err) => {
    logger.error("server.start_failed", { message: err.message })
    process.exit(1)
})
