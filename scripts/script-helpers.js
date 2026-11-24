/**
 * Shared plumbing for the command-line scripts in this folder.
 *
 * runScript(main, options):
 *   - refuses to run when NODE_ENV=production, unless the script is read-only
 *     and passes { allowProduction: true } (only reconcile.js does). The other
 *     scripts create money or change wallet status and exist only for local
 *     development and demos.
 *   - validates .env and connects to MongoDB (replica set required)
 *   - runs main(); its return value becomes the exit code (default 0)
 *   - prints errors readably and exits with options.errorExitCode (default 1)
 *   - always disconnects
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

async function runScript(main, { allowProduction = false, errorExitCode = 1 } = {}) {
    if (!allowProduction) refuseInProduction()
    // Scripts print their own output. Show only warnings and errors from the
    // app's JSON logger (they go to stderr), so stdout stays clean, e.g. for
    // `npm run reconcile -- --json`.
    process.env.LOG_LEVEL = "warn"
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
        exitCode = errorExitCode
    } finally {
        await disconnectFromDB().catch(() => {})
    }
    process.exitCode = exitCode
}

module.exports = { refuseInProduction, runScript }
