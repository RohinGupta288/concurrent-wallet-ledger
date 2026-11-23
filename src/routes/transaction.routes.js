const { Router } = require("express")
const { authMiddleware } = require("../middleware/auth.middleware")
const transactionController = require("../controllers/transaction.controller")

const transactionRoutes = Router()

// Every transaction route requires a logged-in user.
transactionRoutes.use(authMiddleware)

/** POST /api/transactions - transfer money from my wallet to another wallet. */
transactionRoutes.post("/", transactionController.createTransaction)

module.exports = transactionRoutes
