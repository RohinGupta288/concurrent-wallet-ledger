const crypto = require("crypto")
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")
const userModel = require("../models/user.model")
const tokenBlackListModel = require("../models/blackList.model")
const AppError = require("../utils/AppError")
const { validateRegistration, validateLogin } = require("../utils/validators")
const { config } = require("../config/env")

/**
 * Used when a login email does not exist, so that "unknown email" and "wrong
 * password" take the same time (bcrypt runs in both cases) and an attacker
 * cannot discover which emails are registered by timing responses.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("dummy-password-for-timing", config.bcryptSaltRounds)

function signToken(user) {
    return jwt.sign(
        { userId: String(user._id) },
        config.jwtSecret,
        {
            algorithm: "HS256",
            expiresIn: config.jwtExpiresIn,
            // A unique id per token, so logging out one session never revokes another.
            jwtid: crypto.randomUUID(),
        }
    )
}

/** The only user fields ever sent to clients. */
function toPublicUser(user) {
    return {
        id: String(user._id),
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
    }
}

/**
 * POST /api/auth/register
 * Body: { name, email, password }
 */
async function userRegisterController(req, res) {
    const { name, email, password } = validateRegistration(req.body)

    let user
    try {
        user = await userModel.create({ name, email, password })
    } catch (err) {
        // The unique index on email is the real duplicate check: it also
        // catches two registrations for the same email arriving at once.
        if (err.code === 11000) {
            throw new AppError(409, "DUPLICATE_EMAIL", "An account with this email already exists")
        }
        throw err
    }

    res.status(201).json({ user: toPublicUser(user), token: signToken(user) })
}

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
async function userLoginController(req, res) {
    const { email, password } = validateLogin(req.body)

    const user = await userModel.findOne({ email }).select("+password")
    const passwordMatches = await bcrypt.compare(password, user ? user.password : DUMMY_PASSWORD_HASH)

    if (!user || !passwordMatches) {
        // Same message for both cases: do not reveal which emails exist.
        throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect")
    }

    res.status(200).json({ user: toPublicUser(user), token: signToken(user) })
}

/**
 * POST /api/auth/logout  (protected)
 * Revokes the token used for this request until it would have expired.
 */
async function userLogoutController(req, res) {
    const { tokenHash, expiresAt } = req.auth

    // Upsert keeps logout idempotent: logging out twice is not an error.
    await tokenBlackListModel.updateOne(
        { tokenHash },
        { $setOnInsert: { tokenHash, expiresAt } },
        { upsert: true }
    )

    res.status(200).json({ message: "Logged out successfully" })
}

/**
 * GET /api/auth/me  (protected)
 */
async function getCurrentUserController(req, res) {
    res.status(200).json({ user: toPublicUser(req.user) })
}

module.exports = {
    userRegisterController,
    userLoginController,
    userLogoutController,
    getCurrentUserController,
}
