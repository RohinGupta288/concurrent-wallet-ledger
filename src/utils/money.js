/**
 * Money rules.
 *
 * All money is stored and moved as an INTEGER number of paise
 * (1 rupee = 100 paise). Integers avoid floating-point surprises such as
 * 0.1 + 0.2 !== 0.3, which would slowly corrupt balances.
 *
 * JavaScript numbers are exact for integers up to Number.MAX_SAFE_INTEGER
 * (about 9 * 10^15). The limits below keep every amount and balance far below
 * that, so additions and subtractions are always exact.
 */

/** Largest amount allowed in one transfer or funding: 1,00,00,000 paise = ₹10,00,000 (10 lakh). */
const MAX_AMOUNT_PAISE = 100_000_000

/** Largest balance a wallet may hold: 10^13 paise = ₹1,00,000 crore. */
const MAX_BALANCE_PAISE = 10_000_000_000_000

/**
 * True when `value` is a JSON integer between 1 and MAX_AMOUNT_PAISE.
 * Strings ("100"), fractions (1.5), booleans, NaN and Infinity are rejected:
 * the API never guesses what a client meant.
 */
function isValidAmount(value) {
    return Number.isSafeInteger(value) && value >= 1 && value <= MAX_AMOUNT_PAISE
}

/**
 * Converts a rupee string typed on the command line ("1500" or "1500.50")
 * into paise (150000 or 150050) without using floating-point maths.
 * Returns null for anything else. Used by the development scripts only.
 */
function parseRupees(text) {
    const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(text).trim())
    if (!match) return null
    const rupees = Number(match[ 1 ])
    const paise = Number((match[ 2 ] || "").padEnd(2, "0"))
    return rupees * 100 + paise
}

/** Formats paise for humans: 150050 -> "₹1500.50", -2500 -> "-₹25.00". */
function formatPaise(paise) {
    const sign = paise < 0 ? "-" : ""
    const abs = Math.abs(paise)
    const rupees = Math.floor(abs / 100)
    const rest = String(abs % 100).padStart(2, "0")
    return `${sign}₹${rupees}.${rest}`
}

module.exports = {
    MAX_AMOUNT_PAISE,
    MAX_BALANCE_PAISE,
    isValidAmount,
    parseRupees,
    formatPaise,
}
