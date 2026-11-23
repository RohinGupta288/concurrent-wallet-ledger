/**
 * Helpers for moving money in tests.
 */
const crypto = require("crypto")
const request = require("supertest")
const app = require("../../src/app")
const { fundWallet } = require("../../src/services/funding.service")

/** Funds a wallet through the real funding service (amount in paise). */
async function fund(walletId, amount) {
    return fundWallet({ walletId, amount, idempotencyKey: `test-fund-${crypto.randomUUID()}` })
}

/** A fresh, valid idempotency key. */
function newKey() {
    return `test-${crypto.randomUUID()}`
}

/** Sends POST /api/transactions; `key` defaults to a fresh one. Returns the Supertest response. */
function sendTransfer(sender, { to, amount, key = newKey(), from = sender.wallet.id }) {
    return request(app)
        .post("/api/transactions")
        .set(sender.auth)
        .send({ fromAccount: from, toAccount: to, amount, idempotencyKey: key })
}

module.exports = { fund, newKey, sendTransfer }
