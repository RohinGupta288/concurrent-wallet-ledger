/**
 * Shared plumbing for the command-line scripts in this folder.
 *
 * runScript(main):
 *   - refuses to run when NODE_ENV=production (these scripts create money or
 *     change wallet status; they exist only for local development and demos)
 *   - validates .env and connects to MongoDB (replica set required)
 *   - runs main(), prints errors readably, sets the exit code, disconnects
 */
const { config, validateConfig } = require("../src/config/env")
const { connectToDB, disconnectFromDB } = require("../src/config/db")
const AppError = require("../src/utils/AppError")

function refuseInProduction() {
    if (process.env.NODE_ENV === "production") {
        console.error("Refusing to run: this development script must never run with NODE_ENV=production.")
        process.exit(1)
    }
}

async function runScript(main) {
    refuseInProduction()
    let exitCode = 0
    try {
        validateConfig()
        await connectToDB(config.mongoUri)
        exitCode = (await main()) || 0
    } catch (err) {
        if (err instanceof AppError) {
            console.error(`Error ${err.code}: ${err.message}`)
            if (err.details) console.error(err.details)
        } else {
            console.error(err.message)
        }
        exitCode = 1
    } finally {
        await disconnectFromDB().catch(() => {})
    }
    process.exitCode = exitCode
}

module.exports = { refuseInProduction, runScript }
