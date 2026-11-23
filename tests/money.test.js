/**
 * Unit tests for src/utils/money.js (no database needed).
 */
const { MAX_AMOUNT_PAISE, isValidAmount, parseRupees, formatPaise } = require("../src/utils/money")

describe("isValidAmount", () => {
    test.each([ 1, 100, 150000, MAX_AMOUNT_PAISE ])("accepts %p", (value) => {
        expect(isValidAmount(value)).toBe(true)
    })

    test.each([
        0, -1, 1.5, 0.1, MAX_AMOUNT_PAISE + 1, 2 ** 53,
        "100", "1e3", null, undefined, true, NaN, Infinity, [ 100 ], { value: 100 },
    ])("rejects %p", (value) => {
        expect(isValidAmount(value)).toBe(false)
    })
})

describe("parseRupees", () => {
    test.each([
        [ "1500", 150000 ],
        [ "1500.5", 150050 ],
        [ "1500.50", 150050 ],
        [ "0.01", 1 ],
        [ " 25 ", 2500 ],
    ])("%p -> %p paise", (text, paise) => {
        expect(parseRupees(text)).toBe(paise)
    })

    test.each([ "1.234", "-5", "abc", "", "1e3", "1,000", "10.", ".5" ])("rejects %p", (text) => {
        expect(parseRupees(text)).toBeNull()
    })
})

describe("formatPaise", () => {
    test.each([
        [ 150050, "₹1500.50" ],
        [ 5, "₹0.05" ],
        [ 0, "₹0.00" ],
        [ -2500, "-₹25.00" ],
    ])("%p -> %p", (paise, text) => {
        expect(formatPaise(paise)).toBe(text)
    })
})
