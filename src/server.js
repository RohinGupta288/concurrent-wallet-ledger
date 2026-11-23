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

    const server = app.listen(config.port, () => {
        logger.info("server.started", { port: config.port, nodeEnv: config.nodeEnv })
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

start().catch((err) => {
    logger.error("server.start_failed", { message: err.message })
    process.exit(1)
})
