const { checkDBHealth } = require("../config/db")

/**
 * GET /health
 * 200 when the app and its MongoDB replica set are reachable, 503 otherwise.
 */
async function getHealthController(req, res) {
    const database = await checkDBHealth()
    const healthy = database.connected && Boolean(database.replicaSet)

    res.status(healthy ? 200 : 503).json({
        status: healthy ? "ok" : "unavailable",
        uptimeSeconds: Math.round(process.uptime()),
        database,
    })
}

module.exports = { getHealthController }
