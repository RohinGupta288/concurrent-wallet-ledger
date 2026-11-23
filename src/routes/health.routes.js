const express = require("express")
const healthController = require("../controllers/health.controller")

const router = express.Router()

/* GET /health - public; reports app + database status */
router.get("/health", healthController.getHealthController)

module.exports = router
