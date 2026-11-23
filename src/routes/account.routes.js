const express = require("express")
const { authMiddleware } = require("../middleware/auth.middleware")
const accountController = require("../controllers/account.controller")

const router = express.Router()

// Every wallet route requires a logged-in user.
router.use(authMiddleware)

/** POST /api/accounts - create my wallet (one per user; 409 WALLET_EXISTS). */
router.post("/", accountController.createAccountController)

/** GET /api/accounts - list my wallets. */
router.get("/", accountController.getUserAccountsController)

/** GET /api/accounts/balance/:accountId - balance of my wallet. */
router.get("/balance/:accountId", accountController.getAccountBalanceController)

/** GET /api/accounts/:accountId - details of my wallet. */
router.get("/:accountId", accountController.getAccountController)

module.exports = router
