/**
 * Authentication middleware for protected routes.
 *
 * Expects the header `Authorization: Bearer <JWT>`. On success it sets
 *   req.user  - the authenticated user document (without password)
 *   req.auth  - { tokenHash, expiresAt } used by logout
 * and calls next(). Otherwise it throws a 401 AppError.
 *
 * Tokens are only read from the Authorization header, never from cookies:
 * browsers attach cookies automatically, which would let another website
 * trigger money transfers on a logged-in user's behalf (CSRF).
 */
const crypto = require("crypto")
const jwt = require("jsonwebtoken")
const mongoose = require("mongoose")
const userModel = require("../models/user.model")
const tokenBlackListModel = require("../models/blackList.model")
const AppError = require("../utils/AppError")
const { config } = require("../config/env")

function readBearerToken(req) {
    const header = req.get("Authorization")
    if (!header) return null
    const [ scheme, token ] = header.split(" ")
    if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null
    return token
}

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex")
}

async function authMiddleware(req, res, next) {
    const token = readBearerToken(req)
    if (!token) {
        throw new AppError(401, "UNAUTHENTICATED", "Missing 'Authorization: Bearer <token>' header")
    }

    let payload
    try {
        // Pin the algorithm so a forged token cannot choose a weaker one.
        payload = jwt.verify(token, config.jwtSecret, { algorithms: [ "HS256" ] })
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            throw new AppError(401, "TOKEN_EXPIRED", "Authentication token has expired; log in again")
        }
        throw new AppError(401, "INVALID_TOKEN", "Authentication token is invalid")
    }

    if (typeof payload.userId !== "string" || !mongoose.isValidObjectId(payload.userId)) {
        throw new AppError(401, "INVALID_TOKEN", "Authentication token is invalid")
    }

    const tokenHash = hashToken(token)
    if (await tokenBlackListModel.exists({ tokenHash })) {
        throw new AppError(401, "INVALID_TOKEN", "Authentication token has been revoked")
    }

    const user = await userModel.findById(payload.userId)
    if (!user) {
        throw new AppError(401, "INVALID_TOKEN", "The user for this token no longer exists")
    }

    req.user = user
    req.auth = { tokenHash, expiresAt: new Date(payload.exp * 1000) }
    next()
}

module.exports = { authMiddleware }
