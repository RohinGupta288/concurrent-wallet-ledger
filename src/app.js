/**
 * Builds the Express application (but does not start listening; see server.js).
 * Keeping the app separate from the server lets tests send requests to it
 * directly with Supertest.
 *
 * A request flows through the middleware below from top to bottom.
 */
const express = require("express")
const requestId = require("./middleware/requestId.middleware")
const requestLogger = require("./middleware/requestLogger.middleware")
const { notFoundHandler, errorHandler } = require("./middleware/error.middleware")

const healthRouter = require("./routes/health.routes")
const authRouter = require("./routes/auth.routes")
const accountRouter = require("./routes/account.routes")
const transactionRoutes = require("./routes/transaction.routes")

const app = express()
app.disable("x-powered-by")

// 1. Cross-cutting middleware
app.use(requestId)
app.use(requestLogger)
app.use(express.json({ limit: "10kb" }))

// 2. Routes
app.get("/", (req, res) => {
    res.send("Ledger Service is up and running")
})
app.use(healthRouter)
app.use("/api/auth", authRouter)
app.use("/api/accounts", accountRouter)
app.use("/api/transactions", transactionRoutes)

// 3. Unknown routes and errors (must be registered last)
app.use(notFoundHandler)
app.use(errorHandler)

module.exports = app
