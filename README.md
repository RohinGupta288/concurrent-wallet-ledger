# Concurrent Wallet Ledger

A backend for a simple digital wallet, written in Node.js, Express and MongoDB.
Users sign up, open a wallet in INR and send money to each other. The part I
cared about most is correctness: transfers are atomic, two requests at the same
time cannot overspend a wallet, a retried request never pays twice, and every
rupee can be traced through a double-entry ledger.

The money is simulated. There is no payment gateway or bank behind it, and it
is not meant for production use.

## Why I built this

A naive wallet API reads the balance, checks it, and then writes the new
balance. That works until two requests arrive together. If a wallet has
Rs. 1500 and two Rs. 1000 transfers come in at the same moment, both read
Rs. 1500, both pass the check, and the wallet ends at -Rs. 500. Network retries
can also send the same payment twice, and a crash between "debit A" and
"credit B" can make money disappear.

This project handles all three cases and has tests that try to break each one.

## Tech stack

- Node.js 22, Express 5
- MongoDB 8.0 running as a replica set (needed for multi-document transactions)
- Mongoose 9
- JWT (jsonwebtoken) for auth, bcryptjs for password hashing
- Jest and Supertest for tests, mongodb-memory-server to run a real mongod in tests
- autocannon for the load test
- GitHub Actions for CI

## How it works

```
client --HTTP + Bearer JWT--> Express app
                                 |
          requestId -> requestLogger -> json parser -> routes -> error handler
                                 |
                  auth middleware (verifies the JWT, loads the user)
                                 |
                  controllers (validate input, shape the response)
                                 |
                  services: transfer, ledger (postDoubleEntry), funding,
                            history, reconciliation
                                 |
                  runInTransaction (MongoDB transaction with bounded retries)
                                 |
                  MongoDB replica set: users, accounts, transactions, ledgers
```

The main ideas:

**Money is stored in paise as integers.** Rs. 500 is stored as 50000. No
floating point anywhere near money. Amounts are capped at 10,00,000 rupees per
transfer and balances are capped well below the safe integer limit.

**Every transfer is one database transaction.** A transfer inserts the
transaction record, inserts one DEBIT and one CREDIT ledger entry, decrements
the sender and increments the receiver. If anything fails, all of it is rolled
back. A failed transfer leaves nothing behind.

**Overdrafts are blocked by the database, not by JavaScript.** The debit is a
conditional update:

```js
updateOne({ _id: from, status: "ACTIVE", balance: { $gte: amount } },
          { $inc: { balance: -amount } })
```

Two transfers from the same wallet both write the same document, so MongoDB
lets one commit and aborts the other with a write conflict. The aborted one is
retried (at most 10 attempts, with random backoff), sees the new balance and
gets rejected with INSUFFICIENT_FUNDS if the money is gone. No locks or mutexes
in the app. If the retries run out the API returns 503 and nothing is applied.

**Idempotency keys stop double payments.** Every transfer request carries an
idempotencyKey picked by the client. The key is stored on the transaction with
a unique index on (user, key). Sending the same request again returns the
original result with `idempotentReplay: true` and moves no money. Reusing a key
with a different amount or destination returns 409. This also covers the case
where the commit succeeds but the client never gets the response.

**Double-entry ledger.** CREDIT adds to a balance, DEBIT subtracts. For every
account, stored balance = credits - debits. Simulated money enters through a
single SYSTEM_FUNDING account whose balance goes negative, so the sum of all
balances is always zero. Ledger entries cannot be updated or deleted through
the app.

**Reconciliation.** `npm run reconcile` reads everything from one consistent
snapshot and checks every rule above: two entries per transaction with the
right accounts and amounts, no orphan entries, every stored balance matches the
ledger, no negative wallets, debits equal credits, balances sum to zero. It
only reports problems, it never changes data.

More detail is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Features

- Register, login, logout (token revocation) and a /me endpoint
- One INR wallet per user, enforced with a unique index
- Wallets can be ACTIVE or FROZEN. Frozen wallets cannot send or receive
- Transfers between wallets, only from your own wallet
- Paginated transaction history and transaction details
- Idempotent transfers with safe retries
- Reconciliation CLI with exit codes (0 pass, 1 fail, 2 could not run)
- Structured JSON logs with a request id on every response. Passwords, tokens
  and request bodies are never logged
- Health check that also checks the database
- Dev scripts to seed demo users, add money and freeze wallets. There is no
  public endpoint that creates money or freezes wallets

## Setup (Windows, PowerShell)

You need Node.js 22 and Git. MongoDB does not need to be installed, the project
can start a local one for you.

```powershell
winget install --id OpenJS.NodeJS.22 --exact --source winget
winget install --id Git.Git --exact --source winget
```

Clone and install:

```powershell
git clone https://github.com/RohinGupta288/concurrent-wallet-ledger.git
cd concurrent-wallet-ledger
npm ci
```

Create the .env file and put a random JWT secret in it:

```powershell
Copy-Item .env.example .env
$secret = node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
(Get-Content .env) -replace '^JWT_SECRET=.*', "JWT_SECRET=$secret" | Set-Content .env -Encoding ascii
```

The server refuses to start if the placeholder secret is still there.

If PowerShell says running scripts is disabled, run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| NODE_ENV | development | development, test or production |
| PORT | 3000 | HTTP port |
| MONGO_URI | required | Must be a replica set, e.g. mongodb://127.0.0.1:27017/backend-ledger?replicaSet=rs0 |
| JWT_SECRET | required | At least 32 characters |
| JWT_EXPIRES_IN | 1d | Token lifetime, like 15m, 1h or 1d |
| BCRYPT_SALT_ROUNDS | 10 | Between 4 and 15 |
| LOG_LEVEL | info | debug, info, warn, error or silent |
| TXN_MAX_ATTEMPTS | 10 | Max attempts for a transaction that hits write conflicts |
| TEST_MONGO_URI | not set | Run the tests against your own replica set (database name must contain "test") |
| DEV_DB_PORT | 27017 | Port for npm run db:dev |
| DEV_DB_DIR | ./.data | Data folder for npm run db:dev |

### MongoDB

Transactions only work on a replica set, and the app checks this on startup.
The easiest way is the bundled dev database:

```powershell
npm run db:dev
```

This starts mongod 8.0 as a single node replica set called rs0 on port 27017
and keeps data in .data/. Leave the terminal open, Ctrl+C stops it.

If you would rather install MongoDB as a Windows service (I have not tested
these steps on my machine):

```powershell
winget install --id MongoDB.Server --exact --version 8.0.23 --source winget
winget install --id MongoDB.Shell --exact --source winget
Add-Content "C:\Program Files\MongoDB\Server\8.0\bin\mongod.cfg" "`nreplication:`n  replSetName: rs0"
Restart-Service MongoDB
mongosh --quiet --eval 'rs.initiate({ _id: "rs0", members: [ { _id: 0, host: "127.0.0.1:27017" } ] })'
```

## Running it

With the database running, in a second terminal:

```powershell
npm start
```

You should see `db.connected` and `server.started` in the logs. Check it:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

Then add the demo users (safe to run more than once):

```powershell
npm run seed
```

| Email | Password | Starting balance |
|---|---|---|
| alice@example.com | Password@123 | Rs. 10,000 |
| bob@example.com | Password@123 | Rs. 5,000 |
| charlie@example.com | Password@123 | Rs. 2,000 |

Other dev scripts. They only run with NODE_ENV set to development or test and
a database on localhost:

```powershell
npm run fund -- --email alice@example.com --amount 2500 --key topup-alice-001
npm run wallet:status -- --email bob@example.com --status FROZEN
npm run wallet:status -- --email bob@example.com --status ACTIVE
```

## API

All amounts are integers in paise. Routes marked "yes" need the header
`Authorization: Bearer <token>`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | /health | no | 200 when the app and the database are up |
| POST | /api/auth/register | no | name, email, password (8 to 72 bytes) |
| POST | /api/auth/login | no | returns a token |
| POST | /api/auth/logout | yes | revokes the current token |
| GET | /api/auth/me | yes | current user |
| POST | /api/accounts | yes | create your wallet (409 if you already have one) |
| GET | /api/accounts | yes | your wallet |
| GET | /api/accounts/:accountId | yes | wallet details, 404 if it is not yours |
| GET | /api/accounts/balance/:accountId | yes | balance only |
| POST | /api/transactions | yes | fromAccount, toAccount, amount, idempotencyKey |
| GET | /api/transactions?page=1&limit=20 | yes | your history, newest first |
| GET | /api/transactions/:transactionId | yes | one transaction you took part in |

Errors always look like this:

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "Insufficient funds in your wallet", "requestId": "..." } }
```

Status codes used: 400 bad input, 401 not logged in, 403 not your wallet,
404 not found, 409 conflict (duplicate email, wallet exists, key reused),
413 body too large, 415 unsupported encoding, 422 business rule (insufficient
funds, frozen wallet, balance limit), 503 too much contention, retry with the
same key.

### Example in PowerShell

Invoke-RestMethod throws on errors, so this small helper prints the error body
instead:

```powershell
$base = "http://localhost:3000"
function Invoke-Api($Method, $Path, $Token, $Body) {
    $params = @{ Method = $Method; Uri = "$base$Path"; ContentType = "application/json" }
    if ($Token) { $params.Headers = @{ Authorization = "Bearer $Token" } }
    if ($Body)  { $params.Body = ($Body | ConvertTo-Json) }
    try { Invoke-RestMethod @params }
    catch { "HTTP $([int]$_.Exception.Response.StatusCode): $($_.ErrorDetails.Message)" }
}

$alice = Invoke-Api Post "/api/auth/login" $null @{ email = "alice@example.com"; password = "Password@123" }
$bob   = Invoke-Api Post "/api/auth/login" $null @{ email = "bob@example.com"; password = "Password@123" }
$aliceWallet = (Invoke-Api Get "/api/accounts" $alice.token).accounts[0]
$bobWallet   = (Invoke-Api Get "/api/accounts" $bob.token).accounts[0]

# send Rs. 500 from Alice to Bob
$transfer = @{ fromAccount = $aliceWallet.id; toAccount = $bobWallet.id; amount = 50000; idempotencyKey = "demo-" + [guid]::NewGuid() }
Invoke-Api Post "/api/transactions" $alice.token $transfer

# same request again: no new payment, idempotentReplay is True
(Invoke-Api Post "/api/transactions" $alice.token $transfer).idempotentReplay

# same key, different amount: 409 IDEMPOTENCY_KEY_REUSED
$changed = $transfer.Clone(); $changed.amount = 99
Invoke-Api Post "/api/transactions" $alice.token $changed

# more than she has: 422 INSUFFICIENT_FUNDS
Invoke-Api Post "/api/transactions" $alice.token @{ fromAccount = $aliceWallet.id; toAccount = $bobWallet.id; amount = 100000000; idempotencyKey = "demo-" + [guid]::NewGuid() }

# spending Bob's wallet with Alice's token: 403 SOURCE_WALLET_NOT_OWNED
Invoke-Api Post "/api/transactions" $alice.token @{ fromAccount = $bobWallet.id; toAccount = $aliceWallet.id; amount = 100; idempotencyKey = "demo-" + [guid]::NewGuid() }

Invoke-Api Get "/api/accounts/balance/$($aliceWallet.id)" $alice.token
Invoke-Api Get "/api/transactions?page=1&limit=5" $alice.token
```

A successful transfer returns something like:

```json
{
  "transaction": {
    "id": "6b05963e5ca7fec3f680c7e5",
    "type": "TRANSFER",
    "fromAccount": "6b04ce1c573220ec5d8794f5",
    "toAccount": "6b04ce1c573220ec5d879507",
    "amount": 50000,
    "currency": "INR",
    "status": "COMPLETED",
    "idempotencyKey": "demo-0da52ed6-9625-4803-ab3c-143bce8b6cec",
    "createdAt": "2026-11-24T13:50:54.451Z"
  },
  "idempotentReplay": false
}
```

The same calls work in Postman. Log in, copy the token and set it as a Bearer
token on the other requests.

## Tests

```powershell
npm test
npx jest tests/concurrency.test.js --runInBand
```

There are 251 tests and they all pass locally. They run against a real
MongoDB replica set that the test setup starts by itself, so no .env is needed.
The full run takes one to a few minutes depending on the machine.

What they cover:

- auth: validation, duplicate emails, wrong passwords, expired, forged and revoked tokens
- wallets: one per user even under concurrent requests, owner-only access
- transfers: every rejection case, plus injected failures halfway through a
  transfer to prove nothing partial is saved
- concurrency: two Rs. 1000 transfers from Rs. 1500 (exactly one wins), 25
  transfers racing for the same balance, criss-cross transfers, 10 identical
  requests with the same key (one transfer)
- idempotency: replays, key reuse, and the case where a commit happened but
  the response was lost
- reconciliation: 17 different kinds of deliberately corrupted data, each one
  detected

The money tests check the database afterwards (balances, counts, ledger
totals) and run reconciliation, not just the HTTP status codes.

CI runs `npm ci` and `npm test` on every push (.github/workflows/ci.yml).

Details and the list of things I could not verify are in
[docs/TEST_REPORT.md](docs/TEST_REPORT.md).

## Reconciliation

```powershell
npm run reconcile
npm run reconcile -- --json
```

Output from my dev database after the load tests and manual testing:

```
Wallets checked:       85
Transactions checked:  4693
Ledger entries:        9386
Total debit:           801904878 paise
Total credit:          801904878 paise
Inconsistencies:       0
Result:                PASS
```

## Load test

```powershell
npm run perf
npm run perf -- --connections 20 --duration 30 --json > my-run.json
```

It starts its own server, creates 20 throwaway users and runs three scenarios
with autocannon: balance reads, transfers between separate wallet pairs, and
transfers all from one wallet. After that it checks every idempotency key
against the database and runs reconciliation. It only runs against a local
database and is capped at 50 connections and 60 seconds.

Results on my laptop (i7-1260P, 16 GB RAM, plugged in), 10 connections for
10 seconds per scenario:

| Scenario | Requests/s | Avg latency | p95 latency | Errors |
|---|---|---|---|---|
| Balance read | 368 | 27 ms | 44 ms | 0% |
| Transfers, separate wallets | 161 | 62 ms | 105 ms | 0% |
| Transfers, all from one wallet | 64 | 146 ms | 718 ms | 0.47% (503) |

On battery the numbers were 3 to 4 times lower. The 503s in the last scenario
are transfers that hit write conflicts 10 times in a row. None of them were
saved, so retrying them with the same key is safe. Every run passed the
correctness checks. All runs are in [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Project structure

```
src/
  server.js            starts everything: config, database, HTTP server
  app.js               express app and middleware order
  config/              env.js, db.js, transaction.js (runInTransaction)
  middleware/          request id, request log, auth, errors
  routes/              URL to controller
  controllers/         auth, account, transaction, health
  services/            transfer, ledger, funding, history, reconciliation
  models/              user, account, transaction, ledger, token blacklist
  utils/               AppError, logger, validators, money
scripts/               db:dev, seed, fund, wallet:status, reconcile, perf
tests/                 jest tests and helpers
docs/                  architecture, test report, performance, audit, plan
```

## Known limitations

- Simulated money only. No rate limiting, refresh tokens, admin roles or
  account recovery.
- Many transfers from the same wallet at once get slower, and a few may get a
  503 under heavy load (safe to retry with the same key).
- History uses page numbers, so items can shift between pages while new
  transfers come in.
- Reconciliation loads everything into memory, which is fine at this size but
  would not scale to a large ledger.
- The ledger is protected from edits in the app layer, not by database
  permissions. Reconciliation would catch a direct edit.
- Only tested on a single node replica set.
- Registering an existing email returns 409, and a transfer to a frozen
  wallet says so, which means both can be probed.

## Credits and license

This started from
[ankurdotio/backend-ledger](https://github.com/ankurdotio/backend-ledger), and
the original commits are kept in the history. The original had the Express and
Mongoose setup, JWT login and logout, the account, transaction and ledger
models and a first version of the transfer endpoint. I rewrote the transfer
flow and added the stored balances, funding account, idempotency, retries,
reconciliation, logging, tests, CI, the load test and the docs. The full list
of what changed and why is in [docs/AUDIT.md](docs/AUDIT.md).

The original repository has no LICENSE file. The "license": "ISC" line in
package.json is just the npm default and I left it as it was. I have not added
a license on the original author's behalf.
