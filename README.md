# Concurrent-Safe Digital Wallet & Double-Entry Ledger

An educational backend for a **simulated** INR wallet: users register, open
one wallet, and send money to other wallets. Every movement is recorded with
double-entry bookkeeping inside a MongoDB transaction. Concurrent requests
cannot overspend a wallet, retries cannot apply a payment twice, and a
reconciliation tool proves that the books balance.

> **No real money.** There are no payment gateways or bank integrations.
> Money enters only through a development script. This is a portfolio and
> learning project, **not a production payment system** (see
> [Known limitations](#17-known-limitations)).

New to Node.js or MongoDB? Start with **[docs/START_HERE.md](docs/START_HERE.md)**.

Contents:

1. [Project overview](#1-project-overview)
2. [Problem being solved](#2-problem-being-solved)
3. [Technology stack](#3-technology-stack)
4. [Architecture diagram](#4-architecture-diagram)
5. [Main features](#5-main-features)
6. [Setup prerequisites](#6-setup-prerequisites)
7. [Windows PowerShell setup](#7-windows-powershell-setup)
8. [MongoDB installation and configuration](#8-mongodb-installation-and-configuration)
9. [Environment variables](#9-environment-variables)
10. [Starting the backend](#10-starting-the-backend)
11. [Seeding simulated wallets](#11-seeding-simulated-wallets)
12. [API endpoint reference](#12-api-endpoint-reference)
13. [Example API requests and responses](#13-example-api-requests-and-responses)
14. [Running tests](#14-running-tests)
15. [Running reconciliation](#15-running-reconciliation)
16. [Running the performance test](#16-running-the-performance-test)
17. [Known limitations](#17-known-limitations)

Also: [Documentation map](#documentation-map) · [Attribution and license](#attribution-and-license)

---

## 1. Project overview

| | |
|---|---|
| What | REST API: authentication, one INR wallet per user, transfers, transaction history, reconciliation |
| Money | Integer **paise** (₹1 = 100 paise), never floating point |
| Core guarantees | Atomic transfers, no overdrafts under concurrency, idempotent retries, immutable double-entry ledger, read-only reconciliation |
| Shape | One Node.js process + one MongoDB replica set (a simple monolith) |
| Tests | 251 automated tests (Jest + Supertest) against a real MongoDB replica set |

## 2. Problem being solved

A naive wallet does `read balance → check → write` from application code.
With two simultaneous ₹1,000 transfers from a ₹1,500 wallet, both requests
read ₹1,500, both pass the check, and the wallet ends up at −₹500. A network
retry can also send the same payment twice, and a crash between "debit A" and
"credit B" can make money disappear.

This project shows how a small backend avoids all three:

* **Atomicity:** all writes of a transfer happen in one MongoDB
  multi-document transaction, or none do.
* **Concurrency safety:** the debit is a conditional update
  (`balance ≥ amount`) that the database checks and applies in one step.
  Conflicting transactions are retried a bounded number of times.
* **Idempotency:** every transfer carries a client-chosen key, unique per
  user in the database. A repeat returns the stored result instead of paying
  again.
* **Auditability:** every transfer writes one DEBIT and one CREDIT ledger
  entry. `npm run reconcile` re-derives every balance from the ledger and
  reports any discrepancy without changing anything.

## 3. Technology stack

| Technology | Version | Used for |
|---|---|---|
| Node.js | 22 LTS (`.nvmrc`; needs ≥ 20.19) | JavaScript runtime |
| Express | 5.2 | HTTP server, routing, middleware |
| MongoDB | 8.0 (single-node replica set) | Database with multi-document transactions |
| Mongoose | 9.1 | Schemas, validation, indexes, sessions |
| jsonwebtoken | 9 | JWT (HS256) authentication |
| bcryptjs | 3 | Password hashing |
| dotenv | 17 | Loads `.env` |
| Jest + Supertest | 30 / 7 | Tests (dev) |
| mongodb-memory-server | 11.4 (MongoDB 8.0.32) | Real `mongod` for tests and `npm run db:dev` (dev) |
| autocannon | 9 | Load test (dev) |
| nodemon | 3 | Auto-restart in development (dev) |
| GitHub Actions | – | CI (`.github/workflows/ci.yml`) |

No Redis, queues, Docker or microservices.

## 4. Architecture diagram

```
 client (Postman / PowerShell / tests)
   │  HTTP JSON + "Authorization: Bearer <JWT>"
   ▼
 ┌──────────────────────── Node.js process (src/server.js) ───────────────────────┐
 │ src/app.js                                                                       │
 │   requestId → requestLogger → express.json → routes → errorHandler               │
 │                                   │                                              │
 │   routes/        auth   accounts   transactions   health                         │
 │                    │       │            │                                        │
 │   middleware/   authMiddleware (Bearer JWT, revocation check, user lookup)       │
 │                    │       │            │                                        │
 │   controllers/  auth    account    transaction  (validate input, shape output)   │
 │                                         │                                        │
 │   services/                 transfer ─► ledger.postDoubleEntry ◄─ funding        │
 │                             history     reconciliation                           │
 │                                         │                                        │
 │   config/transaction.js     runInTransaction (snapshot reads, majority commit,   │
 │                             bounded retries)                                     │
 │   models/                   user · account · transaction · ledger · blackList    │
 └─────────────────────────────────────────┼────────────────────────────────────────┘
                                           ▼
                         MongoDB 8.0 replica set "rs0"
 scripts/: db:dev · seed · fund · wallet:status · reconcile · perf (same models/services)
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 5. Main features

* **Auth:** register, login, logout (token revocation), `GET /me`. Bearer JWT
  only (no cookies, so no CSRF), HS256 pinned, bcrypt-hashed passwords,
  validated and normalized input.
* **Wallets:** one INR wallet per user (unique index), ACTIVE/FROZEN status,
  owner-only access (another user's wallet returns 404).
* **Transfers:** `POST /api/transactions`. Source ownership comes from the JWT.
  Amounts are validated integers. A transfer is rejected for self-transfer, a
  missing destination, a frozen wallet, insufficient funds or the balance cap.
  It is atomic.
* **Concurrency:** conditional debit plus MongoDB write-conflict detection,
  with bounded jittered retries (`TXN_MAX_ATTEMPTS`) and a clear 503 when they
  run out.
* **Idempotency:** per-user unique key. A replay gives 200; a different
  payload gives 409. Duplicates arriving at the same moment apply once. It is
  safe after an uncertain commit.
* **Double-entry ledger:** one DEBIT and one CREDIT per transaction, entries
  immutable. A single SYSTEM_FUNDING account is the source of all simulated
  money, so Σ balances = 0.
* **History:** paginated, newest first, direction relative to your wallet,
  and no other user's personal data.
* **Reconciliation:** `npm run reconcile` runs 17 kinds of checks on a consistent
  snapshot, never writes, and exits 0, 1 or 2.
* **Observability:** JSON log lines with request id, user id, transaction id
  and duration; secrets are never logged. `GET /health` checks the database.
* **Dev tooling:** seed, fund and freeze scripts (local development database only), a
  zero-install dev database, a bounded load test, and CI.

## 6. Setup prerequisites

| Tool | Why | Check |
|---|---|---|
| Windows 10/11 with PowerShell 5.1+ | All commands below are PowerShell | `$PSVersionTable.PSVersion` |
| **Node.js 22 LTS** (npm included) | Runs the app | `node -v` → `v22.x` |
| Git | Clone the repository | `git --version` |
| MongoDB 8.0 as a **replica set** | Transactions need a replica set | Option A needs nothing extra (see section 8) |
| Internet on first install | npm packages; the ~100 MB `mongod` download for tests and `db:dev` | |

Install with winget (from an elevated PowerShell if prompted):

```powershell
winget install --id OpenJS.NodeJS.22 --exact --source winget
winget install --id Git.Git --exact --source winget
# close and reopen PowerShell so node, npm and git are on PATH
node -v
npm -v
```

> The winget package ids above were checked with `winget show` on 2026-11-24.
> The installs themselves were not re-run on the verification machine, which
> already had Node v22.23.5 and npm 10.9.9.

## 7. Windows PowerShell setup

```powershell
git clone <your-fork-url> backend-ledger      # or the upstream URL
cd backend-ledger
npm ci                                        # installs exactly what package-lock.json lists
Copy-Item .env.example .env

# Replace the placeholder JWT secret with a random 96-character one
$secret = node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
(Get-Content .env) -replace '^JWT_SECRET=.*', "JWT_SECRET=$secret" | Set-Content .env -Encoding ascii
```

> **OneDrive / Dropbox:** if the project folder is synced, `node_modules` and
> the local database files get synced too. Consider a non-synced folder, or set
> `DEV_DB_DIR` (section 9) so the database files live elsewhere.

If PowerShell blocks `npm` with "running scripts is disabled", run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use `npm.cmd`
instead of `npm`.

## 8. MongoDB installation and configuration

Transfers use multi-document transactions, and MongoDB only supports those on
a **replica set**. The app checks this at startup and refuses a standalone
server (`connectToDB` in `src/config/db.js`).

### Option A: zero-install development database (recommended for learning)

```powershell
npm run db:dev
```

This starts a real `mongod` 8.0.32 (the binary that `mongodb-memory-server`
downloads during `npm ci`) as single-node replica set `rs0` on
`127.0.0.1:27017`, storing data in `.data/mongodb` (git-ignored). **Leave this
terminal open**, and press **Ctrl+C** to stop MongoDB cleanly. Expected output:

```
MongoDB mongod-x64-win32-8.0.32.exe is running as replica set "rs0".
  MONGO_URI=mongodb://127.0.0.1:27017/backend-ledger?replicaSet=rs0
  data: ...\backend-ledger\.data\mongodb
  log:  ...\backend-ledger\.data\mongod.log
Press Ctrl+C to stop.
```

### Option B: MongoDB Community Server as a Windows service

> Not executed on the verification machine (MongoDB Server was not installed
> there). These are the standard steps; adjust paths to your install.

```powershell
# 8.0.x keeps you on the version the tests use (winget's default is newer)
winget install --id MongoDB.Server --exact --version 8.0.23 --source winget
winget install --id MongoDB.Shell --exact --source winget

# Enable replication in the service's config file (elevated PowerShell)
$cfg = "C:\Program Files\MongoDB\Server\8.0\bin\mongod.cfg"
Add-Content $cfg "`nreplication:`n  replSetName: rs0"
Restart-Service MongoDB

# One-time: turn the server into a single-node replica set
mongosh --quiet --eval 'rs.initiate({ _id: "rs0", members: [ { _id: 0, host: "127.0.0.1:27017" } ] })'
mongosh --quiet --eval 'rs.status().ok'     # 1
```

Use the same `MONGO_URI` as in Option A. Don't run both options on port 27017
at the same time.

## 9. Environment variables

Copy `.env.example` to `.env` (section 7). `.env` is git-ignored; never commit
it. The app validates these at startup (`validateConfig`, `src/config/env.js`)
and exits with a list of problems if any is invalid.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production`. The dev scripts run only with `development` or `test` |
| `PORT` | `3000` | HTTP port |
| `MONGO_URI` | – (required) | Must point at a replica set, e.g. `mongodb://127.0.0.1:27017/backend-ledger?replicaSet=rs0` |
| `JWT_SECRET` | – (required) | ≥ 32 characters; generate as in section 7 |
| `JWT_EXPIRES_IN` | `1d` | Token lifetime (`15m`, `1h`, `1d`, …) |
| `BCRYPT_SALT_ROUNDS` | `10` | 4–15 |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `TXN_MAX_ATTEMPTS` | `10` | 1–20; attempts per transaction on write conflicts |
| `TEST_MONGO_URI` | unset | Run tests against your own replica set instead of the automatic one. The database name **must contain `test`** (tests delete all data) |
| `DEV_DB_PORT` | `27017` | Port for `npm run db:dev` |
| `DEV_DB_DIR` | `./.data` | Data folder for `npm run db:dev` |

## 10. Starting the backend

With MongoDB running (section 8), in a **second** terminal:

```powershell
npm start            # or: npm run dev  (restarts on file changes)
```

Expected log lines:

```
{"time":"…","level":"info","event":"db.connected","database":"backend-ledger","replicaSet":"rs0"}
{"time":"…","level":"info","event":"server.started","port":3000,"nodeEnv":"development"}
```

Health check:

```powershell
Invoke-RestMethod http://localhost:3000/health
# status uptimeSeconds database
# ------ ------------- --------
# ok                32 @{connected=True; replicaSet=rs0}
```

`/health` returns 503 with `"status": "unavailable"` when the database is
unreachable. Stop the server with Ctrl+C (graceful shutdown).

## 11. Seeding simulated wallets

```powershell
npm run seed
```

This creates (or reuses) three demo users, each with a wallet, and funds them
through the SYSTEM_FUNDING account. It is safe to run repeatedly: each funding
uses a fixed idempotency key, so balances never grow on a second run.

| Email | Password | Initial funding |
|---|---|---|
| `alice@example.com` | `Password@123` | ₹10,000 |
| `bob@example.com` | `Password@123` | ₹5,000 |
| `charlie@example.com` | `Password@123` | ₹2,000 |

Other development scripts. Like `seed`, they run only when `NODE_ENV` is `development` or `test` **and** `MONGO_URI` points at this machine (`127.0.0.1`, `localhost` or `::1`):

```powershell
# Add simulated money (rupees, up to 2 decimals); the same --key never applies twice
npm run fund -- --email alice@example.com --amount 2500 --key topup-alice-001

# Freeze / unfreeze a wallet (a frozen wallet can neither send nor receive)
npm run wallet:status -- --email bob@example.com --status FROZEN
npm run wallet:status -- --email bob@example.com --status ACTIVE
```

## 12. API endpoint reference

Base URL `http://localhost:3000`. JSON in and out. Amounts are integer paise.
✔ = requires `Authorization: Bearer <token>`.

| Method | Path | Auth | Body / query | Success | Typical errors |
|---|---|---|---|---|---|
| GET | `/health` | – | – | 200 | 503 |
| POST | `/api/auth/register` | – | `name`, `email`, `password` (8–72 bytes) | 201 `{user, token}` | 400, 409 `DUPLICATE_EMAIL` |
| POST | `/api/auth/login` | – | `email`, `password` | 200 `{user, token}` | 400, 401 `INVALID_CREDENTIALS` |
| POST | `/api/auth/logout` | ✔ | – | 200 | 401 |
| GET | `/api/auth/me` | ✔ | – | 200 `{user}` | 401 |
| POST | `/api/accounts` | ✔ | – | 201 `{account}` | 409 `WALLET_EXISTS` |
| GET | `/api/accounts` | ✔ | – | 200 `{accounts: [...]}` (0 or 1) | 401 |
| GET | `/api/accounts/:accountId` | ✔ | – | 200 `{account}` | 400 `INVALID_ID`, 404 `WALLET_NOT_FOUND` |
| GET | `/api/accounts/balance/:accountId` | ✔ | – | 200 `{accountId, balance, currency}` | 400, 404 |
| POST | `/api/transactions` | ✔ | `fromAccount`, `toAccount`, `amount`, `idempotencyKey` | 201 new / 200 replay | 400, 403 `SOURCE_WALLET_NOT_OWNED`, 404 `DESTINATION_WALLET_NOT_FOUND`, 409 `IDEMPOTENCY_KEY_REUSED`, 422 `INSUFFICIENT_FUNDS` / `WALLET_FROZEN` / `BALANCE_LIMIT_EXCEEDED`, 503 `TRANSACTION_RETRY_EXHAUSTED` |
| GET | `/api/transactions` | ✔ | `?page=1&limit=20` (limit ≤ 100) | 200 `{items, page, limit, total, totalPages}` | 400 |
| GET | `/api/transactions/:transactionId` | ✔ | – | 200 `{transaction}` | 400, 404 `TRANSACTION_NOT_FOUND` |

Rules worth knowing:

* `amount` must be a JSON **integer** from 1 to 100,000,000 paise (₹10 lakh).
  `"100"`, `1.5` and `-1` are rejected.
* `idempotencyKey`: 8–128 characters from `A–Z a–z 0–9 _ . : -`. Use a new
  one (e.g. a GUID) per payment, and **reuse it only to retry the same
  payment**. A 503 means "retry with the same key".
* Another user's wallet or transaction returns **404**, so ids are not
  confirmed to exist.
* Every error has the shape `{"error": {"code", "message", "requestId", "details"?}}`.
  Every response has an `X-Request-Id` header that matches the server log line.

## 13. Example API requests and responses

Run after `npm run seed`, with the server on port 3000. Every command and
output below was executed against this project on 2026-11-24. Ids,
timestamps and balances will differ for you.

PowerShell's `Invoke-RestMethod` throws on 4xx/5xx. This helper prints the
status and JSON error body instead:

```powershell
$base = "http://localhost:3000"
function Invoke-Api($Method, $Path, $Token, $Body) {
    $params = @{ Method = $Method; Uri = "$base$Path"; ContentType = "application/json" }
    if ($Token) { $params.Headers = @{ Authorization = "Bearer $Token" } }
    if ($Body)  { $params.Body = ($Body | ConvertTo-Json) }
    try { Invoke-RestMethod @params }
    catch { "HTTP $([int]$_.Exception.Response.StatusCode): $($_.ErrorDetails.Message)" }
}
```

**Log in and find the wallets**

```powershell
$alice = Invoke-Api Post "/api/auth/login" $null @{ email = "alice@example.com"; password = "Password@123" }
$bob   = Invoke-Api Post "/api/auth/login" $null @{ email = "bob@example.com";   password = "Password@123" }
$aliceWallet = (Invoke-Api Get "/api/accounts" $alice.token).accounts[0]
$bobWallet   = (Invoke-Api Get "/api/accounts" $bob.token).accounts[0]
$aliceWallet | ConvertTo-Json
```

```json
{ "id": "6b04ce1c573220ec5d8794f5", "currency": "INR", "balance": 975000, "status": "ACTIVE", "createdAt": "2026-11-23T23:37:00.263Z" }
```

**Transfer ₹500 (50,000 paise) from Alice to Bob**

```powershell
$key = "demo-" + [guid]::NewGuid()
$transfer = @{ fromAccount = $aliceWallet.id; toAccount = $bobWallet.id; amount = 50000; idempotencyKey = $key }
Invoke-Api Post "/api/transactions" $alice.token $transfer | ConvertTo-Json
```

```json
{
  "transaction": {
    "id": "6b05963e5ca7fec3f680c7e5", "type": "TRANSFER",
    "fromAccount": "6b04ce1c573220ec5d8794f5", "toAccount": "6b04ce1c573220ec5d879507",
    "amount": 50000, "currency": "INR", "status": "COMPLETED",
    "idempotencyKey": "demo-0da52ed6-9625-4803-ab3c-143bce8b6cec",
    "createdAt": "2026-11-24T13:50:54.451Z"
  },
  "idempotentReplay": false
}
```

**Retry the same request (no second payment) and reuse the key for a different amount**

```powershell
(Invoke-Api Post "/api/transactions" $alice.token $transfer).idempotentReplay   # True  (HTTP 200)
$changed = $transfer.Clone(); $changed.amount = 99
Invoke-Api Post "/api/transactions" $alice.token $changed
```

```
True
HTTP 409: {"error":{"code":"IDEMPOTENCY_KEY_REUSED","message":"This idempotency key was already used for a different request","requestId":"ef1b4549-c4db-4407-b7ad-cba5e57acb3a"}}
```

**Rejected transfers**

```powershell
# Overdraft
Invoke-Api Post "/api/transactions" $alice.token @{ fromAccount = $aliceWallet.id; toAccount = $bobWallet.id; amount = 100000000; idempotencyKey = "demo-" + [guid]::NewGuid() }
# Spending Bob's wallet with Alice's token
Invoke-Api Post "/api/transactions" $alice.token @{ fromAccount = $bobWallet.id; toAccount = $aliceWallet.id; amount = 100; idempotencyKey = "demo-" + [guid]::NewGuid() }
# Frozen destination
npm run wallet:status -- --email bob@example.com --status FROZEN
Invoke-Api Post "/api/transactions" $alice.token @{ fromAccount = $aliceWallet.id; toAccount = $bobWallet.id; amount = 100; idempotencyKey = "demo-" + [guid]::NewGuid() }
npm run wallet:status -- --email bob@example.com --status ACTIVE
```

```
HTTP 422: {"error":{"code":"INSUFFICIENT_FUNDS","message":"Insufficient funds in your wallet","requestId":"8ca7b3b4-…"}}
HTTP 403: {"error":{"code":"SOURCE_WALLET_NOT_OWNED","message":"fromAccount must be your own wallet","requestId":"3433067f-…"}}
HTTP 422: {"error":{"code":"WALLET_FROZEN","message":"The destination wallet is frozen","requestId":"89eb7e89-…","details":{"account":"toAccount"}}}
```

**Balance, history and one transaction**

```powershell
Invoke-Api Get "/api/accounts/balance/$($aliceWallet.id)" $alice.token | ConvertTo-Json -Compress
$history = Invoke-Api Get "/api/transactions?page=1&limit=3" $alice.token
$history.items[0] | ConvertTo-Json -Compress
Invoke-Api Get "/api/transactions/$($history.items[0].transactionId)" $alice.token | ConvertTo-Json
```

```json
{"accountId":"6b04ce1c573220ec5d8794f5","balance":925000,"currency":"INR"}
{"transactionId":"6b05963e5ca7fec3f680c7e5","type":"TRANSFER","direction":"DEBIT","amount":50000,"currency":"INR","status":"COMPLETED","counterpartyAccountId":"6b04ce1c573220ec5d879507","createdAt":"2026-11-24T13:50:54.451Z"}
```

**Register a new user, create a wallet, log out**

```powershell
$dana = Invoke-Api Post "/api/auth/register" $null @{ name = "Dana"; email = "dana@example.com"; password = "Dana-Pass-2026" }
(Invoke-Api Post "/api/accounts" $dana.token).account | ConvertTo-Json -Compress   # balance 0, ACTIVE
Invoke-Api Post "/api/accounts" $dana.token                                         # HTTP 409 WALLET_EXISTS
Invoke-Api Post "/api/auth/logout" $dana.token
Invoke-Api Get "/api/auth/me" $dana.token                                           # HTTP 401 INVALID_TOKEN (revoked)
```

Postman works the same way: `POST /api/auth/login`, copy `token`, then set
**Authorization → Bearer Token** on every other request.

> PowerShell 5.1 strips text in angle brackets from error messages, so the
> 401 message `Missing 'Authorization: Bearer <token>' header` shows as
> `…Bearer ' header` there. The server sends the full text.

## 14. Running tests

```powershell
npm test                                          # all 251 tests, one file at a time (--runInBand)
npx jest tests/concurrency.test.js --runInBand    # one file
npx jest -t "double spending" --runInBand         # tests whose name matches
```

`tests/globalSetup.js` starts a throw-away MongoDB 8.0.32 **replica set**
(never a standalone server), so the tests exercise real transactions. No
`.env` is needed; `tests/setupEnv.js` sets safe test values. Last local run:
**251 passed, 0 failed, 14 suites**. See
[docs/TEST_REPORT.md](docs/TEST_REPORT.md) for details and for what is not
verified. Full-suite time varies a lot by machine and power state (49 s to
385 s on the verification laptop; 79–112 s on AC power).

CI: `.github/workflows/ci.yml` runs `npm ci` and `npm test` on Ubuntu for
every push and pull request. **It has not yet run on GitHub**; it will run
the first time this branch is pushed to a repository you own.

## 15. Running reconciliation

```powershell
npm run reconcile             # human-readable report
npm run reconcile -- --json   # machine-readable
$LASTEXITCODE                 # 0 = PASS, 1 = FAIL, 2 = could not run
```

Output from the development database on 2026-11-24:

```
Ledger reconciliation
---------------------
Wallets checked:       44
Accounts checked:      45 (wallets + system funding account)
Transactions checked:  1064
Ledger entries:        2128
Total debit:           ₹4018261.42 (401826142 paise)
Total credit:          ₹4018261.42 (401826142 paise)
Total funded:          ₹4017501.25
Inconsistencies:       0
Result:                PASS
```

It reads one consistent snapshot, so it is safe to run while the server is
handling transfers. It **never modifies data**, not even indexes: discrepancies are reported
for a human to investigate. The checks are listed in
[docs/ARCHITECTURE.md §7](docs/ARCHITECTURE.md#7-ledger-invariants-and-reconciliation).

## 16. Running the performance test

```powershell
npm run db:dev                                   # terminal 1 (if not already running)
npm run perf                                     # terminal 2: 10 connections × 10 s per scenario
npm run perf -- --connections 20 --duration 30 --json > my-run.json
```

The script starts its own server process on a free port, creates 20 disposable
`perf-<runId>-N@example.test` users, and measures throughput, average, p50,
p95 and p99 latency and error rate for: a balance read, transfers between
disjoint wallet pairs, and transfers all from one "hot" wallet. Afterwards it
checks, idempotency key by key, that every acknowledged (201) transfer is
stored and no rejected one is, and that reconciliation passes. Limits: local database only, at most 50 connections and 60 s.

Measured results, conditions and caveats are in
[docs/PERFORMANCE.md](docs/PERFORMANCE.md). On one laptop, at 10 connections,
they ranged from 14 to 368 req/s depending on scenario and power state
(battery with background load vs AC power).
They describe that machine, not a capacity figure.

## 17. Known limitations

* **Simulated money only, not production-ready.** No rate limiting or login
  throttling, no refresh tokens, no TLS (run behind a reverse proxy), no admin
  roles, no account recovery, no multi-currency. Registration answers 409 for
  an existing email, and a transfer reports a frozen destination, so both
  facts can be probed (there is no rate limiting to slow that down).
* **Hot-wallet contention:** many simultaneous transfers from one wallet
  serialize through retries. Under heavy load a few requests return 503
  `TRANSACTION_RETRY_EXHAUSTED`. Nothing is applied, and the client should
  retry with the same key.
* **Page-number pagination:** items can shift between pages while new
  transfers arrive; `total` is counted separately from the page.
* **Reconciliation loads all data into memory.** That suits this project's
  scale; a large ledger would need database-side aggregation or incremental
  checkpoints.
* **Ledger immutability is enforced in Mongoose**, not by database roles:
  someone with direct database access could change entries. Reconciliation
  would detect it.
* **Failed requests are not recorded.** Only committed transactions are
  stored, so there is no audit trail of rejected attempts beyond the logs.
* **Single-node replica set** locally and in tests. Multi-node behaviour
  (failover, replication lag) has not been tested.
* **CI has not run on GitHub yet.** Performance figures come from one laptop.
* `npm audit` reports **0** vulnerabilities in runtime dependencies. It still
  lists moderate advisories for `glob` and `minimatch`, which are
  development-only dependencies of Jest and nodemon (never loaded by the
  server). The suggested `--force` fix would downgrade Jest, so it was not
  applied. `npm ci` also prints a deprecation notice for `glob@10`.

---

## Documentation map

| File | Read it for |
|---|---|
| [docs/START_HERE.md](docs/START_HERE.md) | **First read.** The whole project in two days, for someone new to JavaScript, Node.js and MongoDB |
| [docs/LEARNING_GUIDE.md](docs/LEARNING_GUIDE.md) | Full reference: fundamentals, code walkthroughs, exercises, 20 interview questions |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, models, transaction lifecycle, concurrency, idempotency, invariants, security |
| [docs/TEST_REPORT.md](docs/TEST_REPORT.md) | What was tested and verified, and what was not |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Benchmark method and measured results |
| [docs/AUDIT.md](docs/AUDIT.md) | Defects found in the original code |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Milestones and progress |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Conventions for changing the code |

## Attribution and license

This project is derived from
**[ankurdotio/backend-ledger](https://github.com/ankurdotio/backend-ledger)**
by **ankurdotio**, whose 11 original commits (January 2026) are preserved in
this repository's history. The original provided the Express and Mongoose
skeleton, JWT register/login/logout with token blacklisting, the account,
transaction and immutable ledger models with the CREDIT/DEBIT convention, and
a first transfer endpoint with an idempotency key.

The changes made here are listed in [docs/AUDIT.md](docs/AUDIT.md) and
[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). In summary: the
transfer path was rewritten to be atomic, concurrency-safe and idempotent; a
stored balance, the SYSTEM_FUNDING account and the ledger invariants were
added; auth was hardened; e-mail notifications and the public money-creation
endpoint were removed; and reconciliation, structured logging, tests, CI, a
benchmark and documentation were added.

**License:** the upstream repository contains **no LICENSE file**.
`package.json` has `"license": "ISC"`, which npm adds by default; it is a
metadata field, not a license grant, and it has been left unchanged. No
license file has been added on the original author's behalf. Without an
explicit license, default copyright applies to the original code. **Confirm
reuse terms with the original author before publishing or redistributing
this project.**
