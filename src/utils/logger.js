/**
 * Minimal structured logger.
 *
 * Each log line is one JSON object, e.g.
 *   {"time":"2026-11-24T10:00:00.000Z","level":"info","event":"http.request","status":200}
 * JSON lines are easy to search and to feed into log tools later.
 *
 * Never pass passwords, tokens, secrets or request bodies to this logger.
 * LOG_LEVEL controls verbosity: debug | info | warn | error | silent.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

function isEnabled(level) {
    const configured = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info
    return LEVELS[level] >= configured
}

function log(level, event, fields = {}) {
    if (!isEnabled(level)) {
        return
    }
    const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })
    if (level === "error" || level === "warn") {
        console.error(line)
    } else {
        console.log(line)
    }
}

module.exports = {
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
}
