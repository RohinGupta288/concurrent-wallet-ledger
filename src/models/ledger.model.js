/**
 * Ledger entries: the permanent, append-only history of every balance change.
 *
 * Sign convention (unchanged from the original project):
 *   CREDIT increases an account's balance, DEBIT decreases it, so
 *   balance = sum(CREDIT amounts) - sum(DEBIT amounts).
 *
 * Every transaction has exactly two entries with the same amount: one DEBIT on
 * the source and one CREDIT on the destination ("double entry"). Hence across
 * the whole ledger, total debits always equal total credits.
 *
 * Entries are never edited or deleted. A mistake would be fixed by a new,
 * opposite transaction, never by changing history. The hooks below block
 * updates and deletes made through Mongoose. They cannot stop someone with
 * direct database access, which is why reconciliation exists
 * (services/reconciliation.service.js).
 */
const mongoose = require("mongoose")
const { isValidAmount } = require("../utils/money")

const ledgerSchema = new mongoose.Schema({
    account: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "account",
        required: [ true, "Ledger must be associated with an account" ],
        index: true,
        immutable: true,
    },
    amount: {
        type: Number,
        required: [ true, "Amount is required for creating a ledger entry" ],
        immutable: true,
        validate: { validator: isValidAmount, message: "amount must be a positive integer number of paise" },
    },
    transaction: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "transaction",
        required: [ true, "Ledger must be associated with a transaction" ],
        immutable: true,
    },
    type: {
        type: String,
        enum: {
            values: [ "CREDIT", "DEBIT" ],
            message: "Type can be either CREDIT or DEBIT",
        },
        required: [ true, "Ledger type is required" ],
        immutable: true,
    },
}, {
    // Entries are never updated, so only a creation time is meaningful.
    timestamps: { createdAt: true, updatedAt: false },
})

// At most one DEBIT and one CREDIT per transaction.
ledgerSchema.index({ transaction: 1, type: 1 }, { unique: true, name: "one_debit_one_credit_per_transaction" })

function preventLedgerModification() {
    throw new Error("Ledger entries are immutable and cannot be modified or deleted")
}

// Query-level operations (Model.updateOne(...), Model.deleteMany(...), ...).
for (const operation of [
    "updateOne", "updateMany", "replaceOne",
    "deleteOne", "deleteMany",
    "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete",
]) {
    ledgerSchema.pre(operation, preventLedgerModification)
}
// Document-level operations (entry.deleteOne(), entry.save() after a change).
ledgerSchema.pre("deleteOne", { document: true, query: false }, preventLedgerModification)
ledgerSchema.pre("save", function () {
    if (!this.isNew) preventLedgerModification()
})
// Model.bulkWrite() can contain updates and deletes.
ledgerSchema.pre("bulkWrite", function (ops) {
    const onlyInserts = ops.every((op) => Object.keys(op)[ 0 ] === "insertOne")
    if (!onlyInserts) preventLedgerModification()
})

const ledgerModel = mongoose.model("ledger", ledgerSchema)

module.exports = ledgerModel
