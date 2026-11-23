const { Router } = require("express")
const { authMiddleware } = require("../middleware/auth.middleware")
const transactionController = require("../controllers/transaction.controller")

const transactionRoutes = Router()

// Every transaction route requires a logged-in user.
transactionRoutes.use(authMiddleware)

/** POST /api/transactions - transfer money from my wallet to another wallet. */
transactionRoutes.post("/", transactionController.createTransaction)

/** GET /api/transactions?page=1&limit=20 - my wallet's history, newest first. */
transactionRoutes.get("/", transactionController.listTransactions)

/** GET /api/transactions/:transactionId - details, if my wallet took part. */
transactionRoutes.get("/:transactionId", transactionController.getTransaction)

module.exports = transactionRoutes
