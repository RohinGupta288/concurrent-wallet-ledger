/**
 * Centralized error handling.
 *
 * Express 5 forwards errors thrown inside async route handlers to these
 * functions automatically, so controllers can simply `throw`.
 * Every error becomes the same JSON shape:
 *
 *   { "error": { "code": "...", "message": "...", "details": {...}?, "requestId": "..." } }
 *
 * Stack traces are logged on the server for unexpected errors and are never
 * sent to clients.
 */
const mongoose = require("mongoose")
const AppError = require("../utils/AppError")
const logger = require("../utils/logger")

function notFoundHandler(req, res, next) {
    next(new AppError(404, "ROUTE_NOT_FOUND", `Route ${req.method} ${req.path} does not exist`))
}

/**
 * Converts any error into an AppError. Known library errors get a sensible
 * status; everything else is an unexpected 500.
 */
function toAppError(err) {
    if (err instanceof AppError) {
        return err
    }
    // Thrown by express.json() for bad request bodies.
    if (err.type === "entity.parse.failed") {
        return new AppError(400, "MALFORMED_JSON", "Request body is not valid JSON")
    }
    if (err.type === "entity.too.large") {
        return new AppError(413, "PAYLOAD_TOO_LARGE", "Request body is too large")
    }
    if (err instanceof mongoose.Error.ValidationError) {
        const details = {}
        for (const [ field, fieldError ] of Object.entries(err.errors)) {
            details[ field ] = fieldError.message
        }
        return new AppError(400, "VALIDATION_ERROR", "Request validation failed", details)
    }
    if (err instanceof mongoose.Error.CastError) {
        return new AppError(400, "INVALID_ID", `Invalid value for ${err.path}`)
    }
    if (err.code === 11000) {
        return new AppError(409, "DUPLICATE_RESOURCE", "Resource already exists")
    }
    return new AppError(500, "INTERNAL_ERROR", "An unexpected error occurred")
}

// Express recognises error handlers by their four parameters, so `next` must
// stay in the signature even though it is unused.
function errorHandler(err, req, res, next) {
    const appError = toAppError(err)

    if (appError.statusCode >= 500) {
        // Unexpected: log full detail server-side only.
        logger.error("http.unhandled_error", {
            requestId: req.id,
            name: err.name,
            message: err.message,
            stack: err.stack,
        })
    }

    res.locals.errorCode = appError.code
    const body = { error: { code: appError.code, message: appError.message, requestId: req.id } }
    if (appError.details !== undefined) {
        body.error.details = appError.details
    }
    res.status(appError.statusCode).json(body)
}

module.exports = { notFoundHandler, errorHandler }
