/**
 * npm run perf [-- --connections 10 --duration 10]
 *
 * A small, bounded, reproducible load test of a LOCAL server.
 *
 *   1. Starts the real server (src/server.js) as a separate process on a free
 *      port, so the load generator does not share its CPU thread.
 *   2. Creates disposable users perf-<runId>-N@example.test with funded wallets.
 *   3. Runs each scenario with autocannon: a short warm-up (not measured), then
 *      a fixed number of concurrent connections for a fixed duration.
 *   4. Reports, per scenario: requests, throughput, average latency, p95
 *      latency (computed from every single response time), status codes and
 *      error rate.
 *   5. Checks correctness afterwards, idempotency key by key: every 201 is
 *      stored, no 4xx is stored, 503s are reported (expected: none stored),
 *      only requests cut off when a phase ended may be stored without an
 *      answer, and reconciliation must PASS. Exits 1 otherwise.
 *
 * Safety limits: only NODE_ENV=development/test and a local MONGO_URI
 * (scripts/script-helpers.js), at most 50 connections and 60 seconds per scenario.
 *
 * The numbers describe this machine only (server, database and load generator
 * all run on it); they are not a capacity guarantee.
 */
const os = require("os")
const net = require("net")
const path = require("path")
const crypto = require("crypto")
const { spawn } = require("child_process")
const { parseArgs } = require("node:util")
const autocannon = require("autocannon")
const mongoose = require("mongoose")
const { config } = require("../src/config/env")
const transactionModel = require("../src/models/transaction.model")
const { fundWallet } = require("../src/services/funding.service")
const { reconcile } = require("../src/services/reconciliation.service")
const { runScript } = require("./script-helpers")

const USERS = 20
const WARMUP_SECONDS = 2
const FUNDING_PER_USER = 10_000_000 // ₹1,00,000 each; transfers move 1 paise

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer()
        probe.once("error", reject)
        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address()
            probe.close(() => resolve(port))
        })
    })
}

async function startServer(port) {
    const child = spawn(process.execPath, [ path.join(__dirname, "..", "src", "server.js") ], {
        env: { ...process.env, PORT: String(port), LOG_LEVEL: "warn" },
        stdio: [ "ignore", "inherit", "inherit" ],
    })
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error("Server process exited during startup")
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`)
            if (res.status === 200) return child
        } catch (err) { /* not listening yet */ }
        await new Promise((resolve) => setTimeout(resolve, 250))
    }
    child.kill()
    throw new Error("Server did not become healthy within 60 s")
}

async function api(base, method, route, { token, body } = {}) {
    const res = await fetch(base + route, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    })
    const json = await res.json()
    if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${JSON.stringify(json)}`)
    return json
}

async function createPerfUsers(base, runId) {
    const users = []
    for (let i = 0; i < USERS; i++) {
        const { user, token } = await api(base, "POST", "/api/auth/register", {
            body: { name: `Perf ${i}`, email: `perf-${runId}-${i}@example.test`, password: crypto.randomUUID() },
        })
        const { account } = await api(base, "POST", "/api/accounts", { token })
        await fundWallet({ walletId: account.id, amount: FUNDING_PER_USER, idempotencyKey: `perf-${runId}-fund-${i}` })
        users.push({ id: user.id, token, walletId: account.id })
    }
    return users
}

/** p-th percentile by the nearest-rank method on a sorted array. */
function percentile(sorted, p) {
    if (sorted.length === 0) return 0
    const rank = Math.ceil((p / 100) * sorted.length)
    return sorted[ Math.min(sorted.length, Math.max(1, rank)) - 1 ]
}

/**
 * Runs one autocannon phase. `nextRequest(n)` returns { method, path, token, body }.
 * Returns every response's status and latency, autocannon's own counters and,
 * for transfers, the idempotency key of every answered request grouped by
 * status (`keysByStatus`), used by the correctness check.
 *
 * Keys are matched to responses through autocannon's per-connection `context`:
 * each connection has at most one request in flight (no pipelining), and
 * onResponse runs before that connection builds its next request.
 */
function runPhase(base, { connections, duration, nextRequest }) {
    let n = 0
    const latencies = []
    const statuses = {}
    const keysByStatus = {}
    const instance = autocannon({
        url: base,
        connections,
        duration,
        pipelining: 1,
        requests: [ {
            setupRequest: (req, context) => {
                const r = nextRequest(n++)
                context.idempotencyKey = r.body ? r.body.idempotencyKey : undefined
                return {
                    ...req,
                    method: r.method,
                    path: r.path,
                    headers: { "content-type": "application/json", authorization: `Bearer ${r.token}` },
                    body: r.body ? JSON.stringify(r.body) : undefined,
                }
            },
            onResponse: (status, body, context) => {
                if (!context.idempotencyKey) return
                if (!keysByStatus[ status ]) keysByStatus[ status ] = []
                keysByStatus[ status ].push(context.idempotencyKey)
            },
        } ],
    })
    instance.on("response", (client, statusCode, resBytes, responseTime) => {
        latencies.push(responseTime)
        statuses[ statusCode ] = (statuses[ statusCode ] || 0) + 1
    })
    return instance.then((result) => ({ result, latencies, statuses, keysByStatus }))
}

/**
 * Compares what clients were told with what the database holds, key by key.
 *   - every 201 key must be stored (an acknowledged transfer may never be lost);
 *   - every 4xx key must NOT be stored (a rejection applied nothing);
 *   - a 503 key should not be stored; if one is, its commit outcome was unknown
 *     (allowed by design: a same-key retry would replay it), so it is reported;
 *   - a stored key with no answer at all was cut off when a phase's time ran
 *     out: at most one per connection per transfer phase.
 */
function checkKeys(answered, storedKeys, maxCutOff) {
    const stored = new Set(storedKeys)
    const count = (keys, wantStored) => keys.filter((k) => stored.has(k) === wantStored).length
    const acknowledged = answered[ 201 ] || []
    const rejected4xx = Object.entries(answered).filter(([ s ]) => s >= 400 && s < 500).flatMap(([ , keys ]) => keys)
    const retryExhausted503 = answered[ 503 ] || []
    const answeredKeys = new Set(Object.values(answered).flat())
    const cutOffStored = storedKeys.filter((k) => !answeredKeys.has(k)).length

    const result = {
        acknowledged201: acknowledged.length,
        acknowledgedButMissing: count(acknowledged, false),
        rejected4xx: rejected4xx.length,
        rejectedButStored: count(rejected4xx, true),
        retryExhausted503: retryExhausted503.length,
        retryExhausted503ButStored: count(retryExhausted503, true),
        transfersStored: storedKeys.length,
        storedWithoutAnyResponse: cutOffStored,
        maxPossibleCutOff: maxCutOff,
    }
    result.ok = result.acknowledgedButMissing === 0 && result.rejectedButStored === 0 && cutOffStored <= maxCutOff
    return result
}

function summarize(name, expectedStatus, { result, latencies, statuses }, durationSeconds) {
    const sorted = [ ...latencies ].sort((a, b) => a - b)
    const responses = sorted.length
    const failed = responses - (statuses[ expectedStatus ] || 0) + result.errors
    const attempted = responses + result.errors
    return {
        scenario: name,
        connections: result.connections,
        durationSeconds,
        requests: responses,
        throughputRps: Number((responses / durationSeconds).toFixed(1)),
        avgLatencyMs: Number((sorted.reduce((a, b) => a + b, 0) / (responses || 1)).toFixed(2)),
        p50LatencyMs: Number(percentile(sorted, 50).toFixed(2)),
        p95LatencyMs: Number(percentile(sorted, 95).toFixed(2)),
        p99LatencyMs: Number(percentile(sorted, 99).toFixed(2)),
        maxLatencyMs: Number((sorted[ sorted.length - 1 ] || 0).toFixed(2)),
        statusCodes: statuses,
        connectionErrors: result.errors,
        timeouts: result.timeouts,
        errorRatePercent: Number((attempted ? (100 * failed) / attempted : 0).toFixed(2)),
    }
}

async function environment() {
    const cpus = os.cpus()
    const build = await mongoose.connection.db.admin().command({ buildInfo: 1 })
    return {
        date: new Date().toISOString(),
        os: `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
        cpu: `${cpus[ 0 ].model.trim()}, ${cpus.length} logical cores`,
        memoryGB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
        freeMemoryGB: Number((os.freemem() / 1024 ** 3).toFixed(1)),
        node: process.version,
        mongodb: build.version,
        serverLogLevel: "warn",
        txnMaxAttempts: config.txnMaxAttempts,
    }
}

runScript(async () => {
    const { values } = parseArgs({
        options: {
            connections: { type: "string", default: "10" },
            duration: { type: "string", default: "10" },
            json: { type: "boolean", default: false },
        },
    })
    const connections = Number(values.connections)
    const duration = Number(values.duration)
    if (!Number.isInteger(connections) || connections < 1 || connections > 50 ||
        !Number.isInteger(duration) || duration < 1 || duration > 60) {
        console.error("Usage: npm run perf -- [--connections 1-50] [--duration 1-60] [--json]")
        return 1
    }
    // runScript() has already refused NODE_ENV=production and non-local databases.

    const runId = crypto.randomBytes(4).toString("hex")
    const port = await freePort()
    const server = await startServer(port)
    const base = `http://127.0.0.1:${port}`
    const results = []
    const answered = {} // status -> idempotency keys, over all transfer phases (warm-up included)

    try {
        console.error(`perf run ${runId}: creating ${USERS} funded users...`)
        const users = await createPerfUsers(base, runId)
        let keyCounter = 0
        const key = () => `perf-${runId}-${keyCounter++}`

        const scenarios = [
            {
                name: "GET balance (own wallet)",
                expectedStatus: 200,
                nextRequest: (n) => {
                    const u = users[ n % USERS ]
                    return { method: "GET", path: `/api/accounts/balance/${u.walletId}`, token: u.token }
                },
            },
            {
                // Disjoint pairs: users 0-9 pay users 10-19, so no wallet is both
                // a sender and a receiver; concurrent requests rarely share a document.
                name: "POST transfer, 10 disjoint wallet pairs",
                expectedStatus: 201,
                nextRequest: (n) => {
                    const pair = n % (USERS / 2)
                    const from = users[ pair ]
                    const to = users[ pair + USERS / 2 ]
                    return {
                        method: "POST", path: "/api/transactions", token: from.token,
                        body: { fromAccount: from.walletId, toAccount: to.walletId, amount: 1, idempotencyKey: key() },
                    }
                },
            },
            {
                name: "POST transfer, one hot sender wallet",
                expectedStatus: 201,
                nextRequest: (n) => {
                    const from = users[ 0 ]
                    const to = users[ 1 + (n % (USERS - 1)) ]
                    return {
                        method: "POST", path: "/api/transactions", token: from.token,
                        body: { fromAccount: from.walletId, toAccount: to.walletId, amount: 1, idempotencyKey: key() },
                    }
                },
            },
        ]

        for (const scenario of scenarios) {
            console.error(`  ${scenario.name}: warm-up ${WARMUP_SECONDS}s, then ${connections} connections x ${duration}s`)
            const warmup = await runPhase(base, { connections, duration: WARMUP_SECONDS, nextRequest: scenario.nextRequest })
            const measured = await runPhase(base, { connections, duration, nextRequest: scenario.nextRequest })
            for (const phase of [ warmup, measured ]) {
                for (const [ status, keys ] of Object.entries(phase.keysByStatus)) {
                    answered[ status ] = (answered[ status ] || []).concat(keys)
                }
            }
            results.push(summarize(scenario.name, scenario.expectedStatus, measured, duration))
        }

        // Correctness after load, key by key (checkKeys). When a phase's time is
        // up, autocannon drops the requests still in flight; the server may
        // still complete those. Give them a moment to finish first.
        await new Promise((resolve) => setTimeout(resolve, 3000))
        const transferPhases = 2 * scenarios.filter((s) => s.expectedStatus === 201).length // warm-up + measured
        const storedKeys = (await transactionModel.find(
            { type: "TRANSFER", initiatedBy: { $in: users.map((u) => new mongoose.Types.ObjectId(u.id)) } },
            { idempotencyKey: 1 }
        ).lean()).map((t) => t.idempotencyKey)
        const keyCheck = checkKeys(answered, storedKeys, connections * transferPhases)
        const reconciliation = await reconcile()
        const report = {
            runId,
            environment: await environment(),
            settings: { connections, durationSeconds: duration, warmupSeconds: WARMUP_SECONDS, users: USERS },
            results,
            correctness: {
                ...keyCheck,
                reconciliation: reconciliation.status,
                inconsistencyCount: reconciliation.inconsistencyCount,
            },
        }

        if (values.json) {
            console.log(JSON.stringify(report, null, 2))
        } else {
            console.log(`\nEnvironment: ${JSON.stringify(report.environment)}`)
            console.log(`Settings:    ${JSON.stringify(report.settings)}\n`)
            console.table(results.map((r) => ({
                scenario: r.scenario,
                requests: r.requests,
                "req/s": r.throughputRps,
                "avg ms": r.avgLatencyMs,
                "p95 ms": r.p95LatencyMs,
                "p99 ms": r.p99LatencyMs,
                "error %": r.errorRatePercent,
                statuses: JSON.stringify(r.statusCodes),
            })))
            console.log(`Correctness: ${JSON.stringify(report.correctness)}`)
        }

        const correct = keyCheck.ok && reconciliation.status === "PASS"
        if (!correct) console.error("CORRECTNESS CHECK FAILED after load")
        return correct ? 0 : 1
    } finally {
        server.kill("SIGTERM")
    }
})
