/**
 * A transaction is the logical record of one money movement:
 * "amount paise moved from fromAccount to toAccount".
 * The actual bookkeeping lives in exactly two ledger entries (one DEBIT, one
 * CREDIT) that point back to this document.
 *
 *   TRANSFER - a user moving money from their wallet to another wallet.
 *   FUNDING  - development-only money entering from the SYSTEM_FUNDING account.
 *
 * Only COMPLETED transactions are ever stored. A transfer that fails (not
 * enough money, frozen wallet, crash halfway) is rolled back by the database
 * transaction, so it leaves no record at all.
 *
 * Idempotency: (initiatedBy, idempotencyKey) is unique, so the same user can
 * never apply the same key twice, even with two requests at the same moment.
 * Keys are scoped per user: Alice and Bob can both use "rent-2026-11".
 * `requestHash` remembers what the key was used for, so reusing a key for a
 * different transfer can be detected and rejected.
 */
const mongoose = require("mongoose")
const { isValidAmount } = require("../utils/money")

const transactionSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: { values: [ "TRANSFER", "FUNDING" ], message: "type must be TRANSFER or FUNDING" },
        required: true,
        immutable: true,
    },
    fromAccount: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "account",
        required: true,
        immutable: true,
    },
    toAccount: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "account",
        required: true,
        immutable: true,
    },
    amount: {
        type: Number,
        required: true,
        immutable: true,
        validate: { validator: isValidAmount, message: "amount must be a positive integer number of paise" },
    },
    status: {
        type: String,
        enum: { values: [ "COMPLETED" ], message: "Only completed transactions are stored" },
        default: "COMPLETED",
    },
    // The user who asked for the transfer; null for FUNDING (done by a script).
    initiatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "user",
        default: null,
        immutable: true,
    },
    idempotencyKey: {
        type: String,
        required: true,
        immutable: true,
    },
    // sha256 of "type|fromAccount|toAccount|amount" (computeRequestHash in services/ledger.service.js).
    requestHash: {
        type: String,
        required: true,
        immutable: true,
    },
}, {
    timestamps: true,
})

transactionSchema.index(
    { initiatedBy: 1, idempotencyKey: 1 },
    { unique: true, name: "one_use_per_idempotency_key" }
)

// Transaction history: "everything that touched my wallet, newest first".
transactionSchema.index({ fromAccount: 1, createdAt: -1, _id: -1 })
transactionSchema.index({ toAccount: 1, createdAt: -1, _id: -1 })

const transactionModel = mongoose.model("transaction", transactionSchema)

module.exports = transactionModel
