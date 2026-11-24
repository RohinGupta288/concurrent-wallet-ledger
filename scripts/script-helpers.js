/**
 * Shared plumbing for the command-line scripts in this folder.
 *
 * runScript(main, options):
 *   - development safety guard (skipped only for the read-only reconcile.js,
 *     which passes { readOnly: true }). The other scripts create money, change
 *     wallet status or generate load, and exist only for local development:
 *       * NODE_ENV must be "development" (the default when unset) or "test";
 *         "production", "staging", "prod", ... are refused;
 *       * MONGO_URI must point at this machine (127.0.0.1 / localhost / ::1).
 *   - validates .env and connects to MongoDB (replica set required). A
 *     read-only script connects without creating indexes, so it changes
 *     nothing in the database.
 *   - runs main(); its return value becomes the exit code (default 0)
 *   - prints errors readably and exits with options.errorExitCode (default 1)
 *   - always disconnects
 */
const { config, validateConfig } = require("../src/config/env")
const { connectToDB, disconnectFromDB } = require("../src/config/db")
const AppError = require("../src/utils/AppError")

const DEVELOPMENT_ENVIRONMENTS = [ "development", "test" ]
const LOCAL_HOSTS = [ "127.0.0.1", "localhost", "::1", "[::1]" ]

/** The host names in a mongodb:// or mongodb+srv:// URI (a replica set URI may list several). */
function mongoHosts(uri) {
    const withoutScheme = String(uri).replace(/^mongodb(\+srv)?:\/\//, "")
    const authority = withoutScheme.split(/[/?]/)[ 0 ]
    const hostList = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority
    return hostList.split(",").map((host) => {
        if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1) // [::1]:27017
        return host.split(":")[ 0 ]
    })
}

function isLocalDatabase(uri) {
    const hosts = mongoHosts(uri)
    return hosts.length > 0 && hosts.every((host) => LOCAL_HOSTS.includes(host.toLowerCase()))
}

/** Exits with code 1 unless this is clearly a local development or test setup. */
function refuseOutsideDevelopment() {
    const nodeEnv = process.env.NODE_ENV || "development"
    if (!DEVELOPMENT_ENVIRONMENTS.includes(nodeEnv)) {
        console.error(`Refusing to run: this development script only runs with NODE_ENV=development or test (got "${nodeEnv}").`)
        process.exit(1)
    }
    if (config.mongoUri && !isLocalDatabase(config.mongoUri)) {
        console.error(`Refusing to run: this development script only runs against a local database (MONGO_URI hosts: ${mongoHosts(config.mongoUri).join(", ")}).`)
        process.exit(1)
    }
}

async function runScript(main, { readOnly = false, errorExitCode = 1 } = {}) {
    if (!readOnly) refuseOutsideDevelopment()
    // Scripts print their own output. Show only warnings and errors from the
    // app's JSON logger (they go to stderr), so stdout stays clean, e.g. for
    // `npm run reconcile -- --json`.
    process.env.LOG_LEVEL = "warn"
    let exitCode = 0
    try {
        validateConfig()
        await connectToDB(config.mongoUri, { createIndexes: !readOnly })
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

module.exports = { runScript, isLocalDatabase, mongoHosts }
