/**
 * Database-level rules on the account, transaction and ledger models.
 * These rules hold no matter which code path writes the data.
 */
const mongoose = require("mongoose")
const accountModel = require("../src/models/account.model")
const transactionModel = require("../src/models/transaction.model")
const ledgerModel = require("../src/models/ledger.model")
const { connectTestDB, clearDatabase, closeTestDB } = require("./helpers/db")

beforeAll(connectTestDB)
beforeEach(clearDatabase)
afterAll(closeTestDB)

const newId = () => new mongoose.Types.ObjectId()

describe("account model", () => {
    test("a wallet requires an owner", async () => {
        await expect(accountModel.create({ type: "WALLET" })).rejects.toThrow(/must belong to a user/)
    })

    test("one wallet per user is enforced by a unique index", async () => {
        const user = newId()
        await accountModel.create({ user })
        await expect(accountModel.create({ user })).rejects.toMatchObject({ code: 11000 })
    })

    test("only one SYSTEM_FUNDING account can exist", async () => {
        await accountModel.create({ type: "SYSTEM_FUNDING" })
        await expect(accountModel.create({ type: "SYSTEM_FUNDING" })).rejects.toMatchObject({ code: 11000 })
    })

    test("rejects non-INR currency, unknown status and fractional or negative wallet balances", async () => {
        await expect(accountModel.create({ user: newId(), currency: "USD" })).rejects.toThrow(/INR/)
        await expect(accountModel.create({ user: newId(), status: "CLOSED" })).rejects.toThrow(/ACTIVE or FROZEN/)
        await expect(accountModel.create({ user: newId(), balance: 10.5 })).rejects.toThrow(/integer/)
        await expect(accountModel.create({ user: newId(), balance: -1 })).rejects.toThrow(/never negative/)
    })

    test("the system funding account may hold a negative balance", async () => {
        const system = await accountModel.create({ type: "SYSTEM_FUNDING", balance: -500 })
        expect(system.balance).toBe(-500)
    })
})

describe("transaction model", () => {
    const base = () => ({
        type: "TRANSFER",
        fromAccount: newId(),
        toAccount: newId(),
        amount: 100,
        idempotencyKey: "key-12345",
        requestHash: "hash",
    })

    test("an idempotency key can be used once per user, but different users may share it", async () => {
        const alice = newId()
        const bob = newId()
        await transactionModel.create({ ...base(), initiatedBy: alice })
        await expect(transactionModel.create({ ...base(), initiatedBy: alice })).rejects.toMatchObject({ code: 11000 })
        await expect(transactionModel.create({ ...base(), initiatedBy: bob })).resolves.toBeDefined()
    })

    test("amount must be a positive integer", async () => {
        for (const amount of [ 0, -5, 1.5 ]) {
            await expect(transactionModel.create({ ...base(), amount })).rejects.toThrow(/positive integer/)
        }
    })

    test("only COMPLETED is a valid status", async () => {
        await expect(transactionModel.create({ ...base(), status: "PENDING" })).rejects.toThrow(/completed/)
    })
})

describe("ledger model", () => {
    async function createEntry(type = "DEBIT") {
        return ledgerModel.create({ account: newId(), transaction: newId(), type, amount: 100 })
    }

    test("at most one DEBIT and one CREDIT per transaction", async () => {
        const transaction = newId()
        await ledgerModel.create({ account: newId(), transaction, type: "DEBIT", amount: 100 })
        await ledgerModel.create({ account: newId(), transaction, type: "CREDIT", amount: 100 })
        await expect(
            ledgerModel.create({ account: newId(), transaction, type: "DEBIT", amount: 100 })
        ).rejects.toMatchObject({ code: 11000 })
    })

    test("amount must be a positive integer", async () => {
        await expect(
            ledgerModel.create({ account: newId(), transaction: newId(), type: "DEBIT", amount: 0.5 })
        ).rejects.toThrow(/positive integer/)
    })

    test.each([
        [ "updateOne", (id) => ledgerModel.updateOne({ _id: id }, { amount: 1 }) ],
        [ "updateMany", () => ledgerModel.updateMany({}, { amount: 1 }) ],
        [ "replaceOne", (id) => ledgerModel.replaceOne({ _id: id }, { amount: 1 }) ],
        [ "findOneAndUpdate", (id) => ledgerModel.findOneAndUpdate({ _id: id }, { amount: 1 }) ],
        [ "findOneAndReplace", (id) => ledgerModel.findOneAndReplace({ _id: id }, { amount: 1 }) ],
        [ "deleteOne", (id) => ledgerModel.deleteOne({ _id: id }) ],
        [ "deleteMany", () => ledgerModel.deleteMany({}) ],
        [ "findOneAndDelete", (id) => ledgerModel.findOneAndDelete({ _id: id }) ],
        [ "bulkWrite (delete)", (id) => ledgerModel.bulkWrite([ { deleteOne: { filter: { _id: id } } } ]) ],
    ])("blocks %s", async (name, operation) => {
        const entry = await createEntry()
        await expect(operation(entry._id)).rejects.toThrow(/immutable/)

        const stored = await ledgerModel.findById(entry._id).lean()
        expect(stored.amount).toBe(100)
    })

    test("blocks document.deleteOne() and saving a changed document", async () => {
        const entry = await createEntry()
        await expect(entry.deleteOne()).rejects.toThrow(/immutable/)

        entry.set("type", "CREDIT") // ignored: field is immutable...
        await expect(entry.save()).rejects.toThrow(/immutable/) // ...and saving is blocked anyway

        expect(await ledgerModel.countDocuments()).toBe(1)
    })

    test("bulkWrite with only inserts is allowed", async () => {
        await ledgerModel.bulkWrite([
            { insertOne: { document: { account: newId(), transaction: newId(), type: "DEBIT", amount: 1 } } },
        ])
        expect(await ledgerModel.countDocuments()).toBe(1)
    })
})
