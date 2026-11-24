/**
 * npm run reconcile            human-readable report
 * npm run reconcile -- --json  machine-readable report
 *
 * Audits the books (see src/services/reconciliation.service.js) and exits with
 *   0  PASS - every rule holds
 *   1  FAIL - at least one inconsistency was found
 *   2  the check could not run (e.g. database unreachable)
 *
 * Read-only: it never changes data, not even indexes (it connects with
 * { createIndexes: false }), so unlike the other scripts it may be run against
 * a production or remote database.
 */
const { parseArgs } = require("node:util")
const { reconcile } = require("../src/services/reconciliation.service")
const { formatPaise } = require("../src/utils/money")
const { runScript } = require("./script-helpers")

const MAX_LISTED = 50

function printReport(result) {
    console.log("Ledger reconciliation")
    console.log("---------------------")
    console.log(`Checked at:            ${result.checkedAt}`)
    console.log(`Wallets checked:       ${result.walletsChecked}`)
    console.log(`Accounts checked:      ${result.accountsChecked} (wallets + system funding account)`)
    console.log(`Transactions checked:  ${result.transactionsChecked}`)
    console.log(`Ledger entries:        ${result.ledgerEntriesChecked}`)
    console.log(`Total debit:           ${formatPaise(result.totalDebit)} (${result.totalDebit} paise)`)
    console.log(`Total credit:          ${formatPaise(result.totalCredit)} (${result.totalCredit} paise)`)
    console.log(`Total funded:          ${formatPaise(result.totalFunded)}`)
    console.log(`Inconsistencies:       ${result.inconsistencyCount}`)
    for (const item of result.inconsistencies.slice(0, MAX_LISTED)) {
        const { check, message, ...ids } = item
        const where = Object.entries(ids).map(([ k, v ]) => `${k}=${v}`).join(" ")
        console.log(`  - [${check}] ${message}${where ? `  (${where})` : ""}`)
    }
    if (result.inconsistencyCount > MAX_LISTED) {
        console.log(`  ... and ${result.inconsistencyCount - MAX_LISTED} more (use --json for the full list)`)
    }
    console.log(`Result:                ${result.status}`)
}

runScript(async () => {
    const { values } = parseArgs({ options: { json: { type: "boolean", default: false } } })
    const result = await reconcile()
    if (values.json) {
        console.log(JSON.stringify(result, null, 2))
    } else {
        printReport(result)
    }
    return result.status === "PASS" ? 0 : 1
}, { readOnly: true, errorExitCode: 2 })
