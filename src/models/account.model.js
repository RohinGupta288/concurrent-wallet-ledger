/**
 * An account holds money. There are two kinds:
 *
 *   WALLET          - belongs to one user. Its balance can never go below 0.
 *   SYSTEM_FUNDING  - exactly one in the whole database, owned by nobody.
 *                     It is the source of all money that enters the simulation
 *                     (see services/funding.service.js). Funding debits it, so
 *                     its balance is NEGATIVE: exactly minus the total ever
 *                     funded. That keeps the books balanced:
 *                     sum of all balances = 0.
 *
 * `balance` is a stored integer (paise). It is only ever changed together with
 * ledger entries inside one database transaction (services/ledger.service.js),
 * and reconciliation checks that it always equals credits - debits.
 */
const mongoose = require("mongoose")

const ACCOUNT_TYPES = [ "WALLET", "SYSTEM_FUNDING" ]
const ACCOUNT_STATUSES = [ "ACTIVE", "FROZEN" ]

const accountSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: { values: ACCOUNT_TYPES, message: "type must be WALLET or SYSTEM_FUNDING" },
        default: "WALLET",
        immutable: true,
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "user",
        // Only wallets have an owner.
        required: [
            function () { return this.type === "WALLET" },
            "A wallet must belong to a user",
        ],
        immutable: true,
    },
    status: {
        type: String,
        enum: { values: ACCOUNT_STATUSES, message: "status must be ACTIVE or FROZEN" },
        default: "ACTIVE",
    },
    currency: {
        type: String,
        enum: { values: [ "INR" ], message: "Only INR is supported" },
        default: "INR",
        immutable: true,
    },
    balance: {
        type: Number,
        default: 0,
        validate: {
            validator: function (value) {
                if (!Number.isSafeInteger(value)) return false
                return this.type !== "WALLET" || value >= 0
            },
            message: "balance must be an integer number of paise (and never negative for a wallet)",
        },
    },
}, {
    timestamps: true,
})

// One wallet per user, enforced by the database itself. A frozen wallet still
// counts. "partial" means the rule only applies to documents with type WALLET.
accountSchema.index(
    { user: 1 },
    { unique: true, partialFilterExpression: { type: "WALLET" }, name: "one_wallet_per_user" }
)

// At most one SYSTEM_FUNDING account.
accountSchema.index(
    { type: 1 },
    { unique: true, partialFilterExpression: { type: "SYSTEM_FUNDING" }, name: "one_system_funding_account" }
)

const accountModel = mongoose.model("account", accountSchema)

module.exports = accountModel
