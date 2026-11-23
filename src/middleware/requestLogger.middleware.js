/**
 * Logs one structured line per HTTP request when the response is finished.
 *
 * Logged: request ID, method, path (without query string), status, duration,
 * the authenticated user ID and, for money operations, the transaction ID
 * (controllers put it in res.locals.transactionId) and error code.
 * Never logged: headers (they contain the JWT), request bodies (passwords), query strings.
 */
const logger = require("../utils/logger")

function requestLogger(req, res, next) {
    const startedAt = process.hrtime.bigint()

    res.on("finish", () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
        logger.info("http.request", {
            requestId: req.id,
            method: req.method,
            path: req.originalUrl.split("?")[ 0 ],
            status: res.statusCode,
            durationMs: Math.round(durationMs * 10) / 10,
            userId: req.user ? String(req.user._id) : undefined,
            transactionId: res.locals.transactionId,
            errorCode: res.locals.errorCode,
        })
    })

    next()
}

module.exports = requestLogger
