/**
 * An error that we throw on purpose, carrying everything needed for the HTTP
 * response. The central error handler (middleware/error.middleware.js) turns it
 * into JSON:
 *
 *   throw new AppError(422, "INSUFFICIENT_FUNDS", "Insufficient balance")
 *   -> HTTP 422 { "error": { "code": "INSUFFICIENT_FUNDS", "message": "...", "requestId": "..." } }
 *
 * `code` is a stable machine-readable string clients can rely on;
 * `message` is for humans; `details` is optional extra data (e.g. field errors).
 */
class AppError extends Error {
    constructor(statusCode, code, message, details) {
        super(message)
        this.name = "AppError"
        this.statusCode = statusCode
        this.code = code
        this.details = details
    }
}

module.exports = AppError
