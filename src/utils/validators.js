/**
 * Request-body validation.
 *
 * Every value from a client is checked for its *type* before it reaches a
 * database query. This matters in MongoDB: if `email` were allowed to be an
 * object such as {"$gt": ""}, a query like findOne({ email }) would match
 * any user ("query operator injection"). Accepting only plain strings and
 * numbers prevents that.
 *
 * Each validate* function returns cleaned values or throws one
 * AppError(400, "VALIDATION_ERROR") listing every invalid field.
 */
const AppError = require("./AppError")

// Pragmatic email shape check: something@something.tld, no spaces.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const NAME_MAX_LENGTH = 100
const PASSWORD_MIN_LENGTH = 8
const PASSWORD_MAX_BYTES = 72 // bcrypt ignores everything after 72 bytes

/**
 * True for a 24-character hex string such as "665f1c2e9b1d4a3f8c0e1234".
 * (mongoose.isValidObjectId also accepts any 12-character string, which is
 * too loose for checking request input.)
 */
function isObjectIdString(value) {
    return typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value)
}

function validationError(details) {
    return new AppError(400, "VALIDATION_ERROR", "Request validation failed", details)
}

function requireJsonObject(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw validationError({ body: "Request body must be a JSON object" })
    }
}

/** Lower-cases and trims an email; returns null when it is not a valid email string. */
function normalizeEmail(value) {
    if (typeof value !== "string") return null
    const email = value.trim().toLowerCase()
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) return null
    return email
}

function validateRegistration(body) {
    requireJsonObject(body)
    const errors = {}

    const name = typeof body.name === "string" ? body.name.trim() : ""
    if (name.length === 0 || name.length > NAME_MAX_LENGTH) {
        errors.name = `name is required (1-${NAME_MAX_LENGTH} characters)`
    }

    const email = normalizeEmail(body.email)
    if (!email) {
        errors.email = "a valid email address is required"
    }

    const password = body.password
    if (typeof password !== "string" ||
        password.length < PASSWORD_MIN_LENGTH ||
        Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
        errors.password = `password must be a string of ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_BYTES} characters`
    }

    if (Object.keys(errors).length > 0) throw validationError(errors)
    return { name, email, password }
}

function validateLogin(body) {
    requireJsonObject(body)
    const errors = {}

    if (typeof body.email !== "string" || body.email.trim() === "") {
        errors.email = "email is required"
    }
    if (typeof body.password !== "string" || body.password === "") {
        errors.password = "password is required"
    }

    if (Object.keys(errors).length > 0) throw validationError(errors)
    // An invalid email shape cannot belong to any user; normalize what we can.
    return { email: body.email.trim().toLowerCase(), password: body.password }
}

module.exports = {
    isObjectIdString,
    validationError,
    requireJsonObject,
    normalizeEmail,
    validateRegistration,
    validateLogin,
}
