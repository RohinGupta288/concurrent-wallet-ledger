const mongoose = require("mongoose")

/**
 * Revoked (logged-out) JWTs.
 *
 * Only a SHA-256 hash of the token is stored, so a leak of this collection
 * cannot be used to log in. Each row is deleted automatically by MongoDB's TTL
 * monitor once the token would have expired anyway (`expireAfterSeconds: 0`
 * means "delete when the date in expiresAt has passed").
 */
const tokenBlacklistSchema = new mongoose.Schema({
    tokenHash: {
        type: String,
        required: [ true, "Token hash is required to blacklist a token" ],
        unique: true,
    },
    expiresAt: {
        type: Date,
        required: true,
    },
}, {
    timestamps: true,
})

tokenBlacklistSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

const tokenBlackListModel = mongoose.model("tokenBlackList", tokenBlacklistSchema)

module.exports = tokenBlackListModel
