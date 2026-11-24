/**
 * Environment configuration.
 *
 * Reads settings from process.env (populated from the .env file by dotenv) and
 * exposes them as one plain object. Every other file imports settings from
 * here instead of reading process.env directly, so all configuration lives in
 * one place.
 */
require("dotenv").config({ quiet: true })

const config = {
    nodeEnv: process.env.NODE_ENV || "development",
    port: Number(process.env.PORT || 3000),
    mongoUri: process.env.MONGO_URI,
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "1d",
    bcryptSaltRounds: Number(process.env.BCRYPT_SALT_ROUNDS || 10),
    // Upper bound on attempts for one MongoDB transaction (see config/transaction.js).
    txnMaxAttempts: Number(process.env.TXN_MAX_ATTEMPTS || 10),
}

/**
 * Throws a descriptive error if required settings are missing or unsafe.
 * Called once at startup (server.js and CLI scripts) so the process fails fast
 * instead of failing later on the first request.
 */
function validateConfig(cfg = config) {
    const problems = []

    if (!cfg.mongoUri) {
        problems.push("MONGO_URI is required (e.g. mongodb://127.0.0.1:27017/backend-ledger?replicaSet=rs0)")
    }
    if (!cfg.jwtSecret || cfg.jwtSecret.length < 32) {
        problems.push("JWT_SECRET is required and must be at least 32 characters long")
    } else if (cfg.jwtSecret.startsWith("replace-me")) {
        problems.push("JWT_SECRET still has the placeholder value from .env.example; generate a random one (see README.md, section 7)")
    }
    // A number of seconds, or a number followed by s, m, h or d (e.g. 900, 15m, 1d).
    // Anything else would make every login fail inside jwt.sign().
    if (typeof cfg.jwtExpiresIn !== "string" || !/^[1-9]\d*[smhd]?$/.test(cfg.jwtExpiresIn)) {
        problems.push("JWT_EXPIRES_IN must be a positive whole number of seconds, optionally followed by s, m, h or d (e.g. 15m, 1h, 1d)")
    }
    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
        problems.push("PORT must be an integer between 1 and 65535")
    }
    if (!Number.isInteger(cfg.bcryptSaltRounds) || cfg.bcryptSaltRounds < 4 || cfg.bcryptSaltRounds > 15) {
        problems.push("BCRYPT_SALT_ROUNDS must be an integer between 4 and 15")
    }
    if (!Number.isInteger(cfg.txnMaxAttempts) || cfg.txnMaxAttempts < 1 || cfg.txnMaxAttempts > 20) {
        problems.push("TXN_MAX_ATTEMPTS must be an integer between 1 and 20")
    }

    if (problems.length > 0) {
        throw new Error(`Invalid configuration:\n  - ${problems.join("\n  - ")}`)
    }
}

config.isProduction = config.nodeEnv === "production"

module.exports = { config, validateConfig }
