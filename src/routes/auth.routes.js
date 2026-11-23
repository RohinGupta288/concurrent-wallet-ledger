const express = require("express")
const authController = require("../controllers/auth.controller")
const { authMiddleware } = require("../middleware/auth.middleware")

const router = express.Router()

/* POST /api/auth/register - public */
router.post("/register", authController.userRegisterController)

/* POST /api/auth/login - public */
router.post("/login", authController.userLoginController)

/* POST /api/auth/logout - protected: revokes the current token */
router.post("/logout", authMiddleware, authController.userLogoutController)

/* GET /api/auth/me - protected: current user's profile */
router.get("/me", authMiddleware, authController.getCurrentUserController)

module.exports = router
