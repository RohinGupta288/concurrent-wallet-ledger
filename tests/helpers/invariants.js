/**
 * Checks the accounting rules directly against the database, independently of
 * the application code under test. Call it at the end of any test that moves
 * money:
 *
 *   await expectBooksBalanced()
 *
 * Rules checked:
 *   1. Every transaction has exactly 2 ledger entries (ledger count = 2 x transactions).
 *   2. Total DEBIT amount = total CREDIT amount.
 *   3. Every account's stored balance = its credits - its debits.
 *   4. The sum of all balances is 0 (money is only moved, never created).
 *   5. No wallet balance is negative.
 */
const accountModel = require("../../src/models/account.model")
const transactionModel = require("../../src/models/transaction.model")
const ledgerModel = require("../../src/models/ledger.model")

async function expectBooksBalanced() {
    const [ accounts, transactionCount, entries ] = await Promise.all([
        accountModel.find().lean(),
        transactionModel.countDocuments(),
        ledgerModel.find().lean(),
    ])

    expect(entries.length).toBe(2 * transactionCount)

    const totals = { DEBIT: 0, CREDIT: 0 }
    const derived = new Map()
    for (const entry of entries) {
        totals[ entry.type ] += entry.amount
        const key = String(entry.account)
        const signed = entry.type === "CREDIT" ? entry.amount : -entry.amount
        derived.set(key, (derived.get(key) || 0) + signed)
    }
    expect(totals.DEBIT).toBe(totals.CREDIT)

    let sumOfBalances = 0
    for (const account of accounts) {
        expect({ account: String(account._id), balance: account.balance })
            .toEqual({ account: String(account._id), balance: derived.get(String(account._id)) || 0 })
        if (account.type === "WALLET") expect(account.balance).toBeGreaterThanOrEqual(0)
        sumOfBalances += account.balance
    }
    expect(sumOfBalances).toBe(0)

    return { transactionCount, entryCount: entries.length, totalDebit: totals.DEBIT, totalCredit: totals.CREDIT }
}

/** Current stored balance of one account. */
async function balanceOf(accountId) {
    const account = await accountModel.findById(accountId).lean()
    return account.balance
}

module.exports = { expectBooksBalanced, balanceOf }
