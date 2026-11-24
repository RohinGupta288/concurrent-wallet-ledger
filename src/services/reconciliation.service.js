/**
 * Reconciliation: an independent audit of the books.
 *
 * reconcile() re-derives everything from the raw data and reports every rule
 * that is broken. It NEVER modifies data: a discrepancy in financial records
 * must be investigated by a human, not silently "fixed".
 *
 * Consistent view
 * ---------------
 * All reads use one MongoDB *snapshot session*, so they see the database at a
 * single point in time even while transfers keep running. Without it, we
 * could read the transactions, then a transfer commits, then we read the
 * ledger, and we would report a false mismatch.
 *
 * Rules checked (each failure is one entry in `inconsistencies`)
 * ----------------------------------------------------------
 * Per transaction:
 *   MISSING_ENTRY / EXTRA_ENTRY     exactly one DEBIT and one CREDIT entry
 *   WRONG_ACCOUNT                   DEBIT on fromAccount, CREDIT on toAccount
 *   AMOUNT_MISMATCH                 both entry amounts equal the transaction amount
 *   MISSING_ACCOUNT                 fromAccount and toAccount exist
 *   INVALID_FUNDING                 FUNDING goes from SYSTEM_FUNDING to a wallet
 *   TRANSFER_TOUCHES_SYSTEM         TRANSFER goes from a wallet to a wallet
 *   INVALID_AMOUNT / INVALID_STATUS positive integer amount, status COMPLETED
 * Per ledger entry:
 *   ORPHAN_ENTRY                    its transaction and account exist
 *   INVALID_AMOUNT                  positive integer amount
 * Per account:
 *   BALANCE_MISMATCH                stored balance = credits - debits
 *   NEGATIVE_WALLET_BALANCE         a wallet never holds less than 0
 * Whole system:
 *   UNBALANCED_LEDGER               total DEBIT amount = total CREDIT amount
 *   SUM_OF_BALANCES_NOT_ZERO        all balances add up to 0
 *   SYSTEM_FUNDING_MISMATCH         SYSTEM_FUNDING balance = -(sum of FUNDING amounts)
 *   MULTIPLE_SYSTEM_ACCOUNTS        at most one SYSTEM_FUNDING account
 *
 * Scale: this loads accounts, transactions and ledger entries into memory,
 * which is simple to read and fine for this project's data sizes (hundreds of
 * thousands of entries). A very large ledger would aggregate in the database
 * or reconcile incrementally from a checkpoint instead.
 */
const mongoose = require("mongoose")
const accountModel = require("../models/account.model")
const transactionModel = require("../models/transaction.model")
const ledgerModel = require("../models/ledger.model")

const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0

async function readSnapshot() {
    const session = await mongoose.startSession({ snapshot: true })
    try {
        // The first read fixes the snapshot time; every later read in this
        // session uses that same time. So it must finish before the others start.
        const accounts = await accountModel.find().session(session).lean()
        const [ transactions, entries ] = await Promise.all([
            transactionModel.find().session(session).lean(),
            ledgerModel.find().session(session).lean(),
        ])
        return { accounts, transactions, entries }
    } finally {
        await session.endSession()
    }
}

async function reconcile() {
    const { accounts, transactions, entries } = await readSnapshot()
    const inconsistencies = []
    const report = (check, message, ids = {}) => inconsistencies.push({ check, message, ...ids })

    const accountsById = new Map(accounts.map((a) => [ String(a._id), a ]))
    const transactionsById = new Map(transactions.map((t) => [ String(t._id), t ]))

    // ---- Ledger entries: totals, per-account sums, grouping by transaction ----
    let totalDebit = 0
    let totalCredit = 0
    const derivedBalance = new Map() // accountId -> credits - debits
    const entriesByTransaction = new Map()

    for (const entry of entries) {
        const entryId = String(entry._id)
        const accountId = String(entry.account)
        const transactionId = String(entry.transaction)

        if (!isPositiveInteger(entry.amount)) {
            report("INVALID_AMOUNT", `Ledger entry has invalid amount ${JSON.stringify(entry.amount)}`, { entryId })
            continue
        }
        if (entry.type === "DEBIT") totalDebit += entry.amount
        else if (entry.type === "CREDIT") totalCredit += entry.amount

        if (!accountsById.has(accountId)) {
            report("ORPHAN_ENTRY", "Ledger entry points to an account that does not exist", { entryId, accountId })
        }
        if (!transactionsById.has(transactionId)) {
            report("ORPHAN_ENTRY", "Ledger entry points to a transaction that does not exist", { entryId, transactionId })
        }

        const signed = entry.type === "CREDIT" ? entry.amount : -entry.amount
        derivedBalance.set(accountId, (derivedBalance.get(accountId) || 0) + signed)

        if (!entriesByTransaction.has(transactionId)) entriesByTransaction.set(transactionId, [])
        entriesByTransaction.get(transactionId).push(entry)
    }

    // ---- Transactions: each one must be a correct double entry ----
    let totalFunded = 0
    for (const transaction of transactions) {
        const transactionId = String(transaction._id)
        const ids = { transactionId }
        const from = accountsById.get(String(transaction.fromAccount))
        const to = accountsById.get(String(transaction.toAccount))

        if (!isPositiveInteger(transaction.amount)) {
            report("INVALID_AMOUNT", `Transaction has invalid amount ${JSON.stringify(transaction.amount)}`, ids)
        }
        if (transaction.status !== "COMPLETED") {
            report("INVALID_STATUS", `Transaction has status ${JSON.stringify(transaction.status)}`, ids)
        }
        if (!from) report("MISSING_ACCOUNT", "fromAccount does not exist", { ...ids, accountId: String(transaction.fromAccount) })
        if (!to) report("MISSING_ACCOUNT", "toAccount does not exist", { ...ids, accountId: String(transaction.toAccount) })

        if (transaction.type === "FUNDING") {
            if (isPositiveInteger(transaction.amount)) totalFunded += transaction.amount
            if ((from && from.type !== "SYSTEM_FUNDING") || (to && to.type !== "WALLET")) {
                report("INVALID_FUNDING", "FUNDING must move money from SYSTEM_FUNDING to a wallet", ids)
            }
        } else if (from && to && (from.type !== "WALLET" || to.type !== "WALLET")) {
            report("TRANSFER_TOUCHES_SYSTEM", "TRANSFER must move money between two wallets", ids)
        }

        const own = entriesByTransaction.get(transactionId) || []
        for (const type of [ "DEBIT", "CREDIT" ]) {
            const ofType = own.filter((e) => e.type === type)
            if (ofType.length === 0) {
                report("MISSING_ENTRY", `Transaction has no ${type} entry`, ids)
                continue
            }
            if (ofType.length > 1) {
                report("EXTRA_ENTRY", `Transaction has ${ofType.length} ${type} entries`, ids)
            }
            const expectedAccount = String(type === "DEBIT" ? transaction.fromAccount : transaction.toAccount)
            for (const entry of ofType) {
                if (String(entry.account) !== expectedAccount) {
                    report("WRONG_ACCOUNT", `${type} entry is on the wrong account`, { ...ids, entryId: String(entry._id) })
                }
                if (entry.amount !== transaction.amount) {
                    report("AMOUNT_MISMATCH",
                        `${type} entry amount ${entry.amount} differs from transaction amount ${transaction.amount}`,
                        { ...ids, entryId: String(entry._id) })
                }
            }
        }
    }

    // ---- Accounts: stored balance must match the ledger ----
    let sumOfBalances = 0
    let walletsChecked = 0
    const systemAccounts = accounts.filter((a) => a.type === "SYSTEM_FUNDING")
    for (const account of accounts) {
        const accountId = String(account._id)
        const expected = derivedBalance.get(accountId) || 0
        if (account.type === "WALLET") walletsChecked += 1

        if (!Number.isSafeInteger(account.balance)) {
            report("BALANCE_MISMATCH", `Stored balance ${JSON.stringify(account.balance)} is not an integer`, { accountId })
            continue
        }
        sumOfBalances += account.balance
        if (account.balance !== expected) {
            report("BALANCE_MISMATCH", `Stored balance ${account.balance} but ledger says ${expected}`, { accountId })
        }
        if (account.type === "WALLET" && account.balance < 0) {
            report("NEGATIVE_WALLET_BALANCE", `Wallet balance is ${account.balance}`, { accountId })
        }
    }

    // ---- Whole system ----
    if (totalDebit !== totalCredit) {
        report("UNBALANCED_LEDGER", `Total debits ${totalDebit} differ from total credits ${totalCredit}`)
    }
    if (sumOfBalances !== 0) {
        report("SUM_OF_BALANCES_NOT_ZERO", `All balances add up to ${sumOfBalances}, expected 0`)
    }
    if (systemAccounts.length > 1) {
        report("MULTIPLE_SYSTEM_ACCOUNTS", `Found ${systemAccounts.length} SYSTEM_FUNDING accounts`)
    }
    const systemBalance = systemAccounts.reduce((sum, a) => sum + (Number.isSafeInteger(a.balance) ? a.balance : 0), 0)
    if (systemBalance !== -totalFunded) {
        report("SYSTEM_FUNDING_MISMATCH",
            `SYSTEM_FUNDING balance is ${systemBalance}, expected -${totalFunded} (minus the total funded)`)
    }

    return {
        status: inconsistencies.length === 0 ? "PASS" : "FAIL",
        checkedAt: new Date().toISOString(),
        walletsChecked,
        accountsChecked: accounts.length,
        transactionsChecked: transactions.length,
        ledgerEntriesChecked: entries.length,
        totalDebit,
        totalCredit,
        totalFunded,
        inconsistencyCount: inconsistencies.length,
        inconsistencies,
    }
}

module.exports = { reconcile }
