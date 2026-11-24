# Architecture

This document describes the system **as it is implemented** in this
repository. Every rule below points to the file that enforces it.

It is an educational, simulated-money backend (INR in integer paise). It is
not a production payment system; see [Known limitations](../README.md#17-known-limitations).

Contents:

1. [System components](#1-system-components)
2. [Request flow](#2-request-flow)
3. [Database models](#3-database-models)
4. [Transaction lifecycle](#4-transaction-lifecycle)
5. [Concurrency strategy](#5-concurrency-strategy)
6. [Idempotency design](#6-idempotency-design)
7. [Ledger invariants and reconciliation](#7-ledger-invariants-and-reconciliation)
8. [Error handling](#8-error-handling)
9. [Logging](#9-logging)
10. [Security boundaries](#10-security-boundaries)
11. [Design trade-offs](#11-design-trade-offs)

---

## 1. System components

One Node.js process (a "monolith") talks to one MongoDB replica set. There is
no cache, queue or second service.

```
             HTTP (JSON, Authorization: Bearer <JWT>)
 client ───────────────────────────────────────────────►  Node.js 22 process
 (Postman,                                               ┌──────────────────────────┐
  PowerShell,                                            │ Express 5 app            │
  tests)                                                 │  middleware → routes →   │
                                                         │  controllers → services  │
                                                         │  Mongoose 9 models       │
                                                         └────────────┬─────────────┘
                                                                      │ MongoDB driver
                                                                      │ (sessions, transactions)
                                                         ┌────────────▼─────────────┐
                                                         │ MongoDB 8.0 replica set  │
                                                         │ "rs0" (1 node locally)   │
                                                         │ users, accounts,         │
                                                         │ transactions, ledgers,   │
                                                         │ tokenblacklists          │
                                                         └──────────────────────────┘
 CLI scripts (scripts/*.js) ── same models and services ──┘
   seed, fund, wallet:status, reconcile, perf, db:dev
```

| Layer | Folder | Responsibility |
|---|---|---|
| Entry point | `src/server.js` | Validate config, connect to MongoDB, listen, graceful shutdown |
| App | `src/app.js` | Builds the Express app: middleware order, route mounting, error handler |
| Config | `src/config/` | `env.js` (settings), `db.js` (connect, replica-set check, indexes), `transaction.js` (`runInTransaction`, bounded retries) |
| Middleware | `src/middleware/` | Request id, request log, Bearer-JWT auth, 404 and error → JSON |
| Routes | `src/routes/` | URL → controller function |
| Controllers | `src/controllers/` | Validate input, call a service, shape the HTTP response |
| Services | `src/services/` | Business rules: `transfer`, `fundWallet`, `postDoubleEntry`, `listHistory`, `reconcile` |
| Models | `src/models/` | Mongoose schemas, validators, unique indexes, ledger immutability hooks |
| Utils | `src/utils/` | `AppError`, JSON `logger`, `validators`, `money` |
| Scripts | `scripts/` | Development tools (refuse `NODE_ENV=production`, except read-only `reconcile`) |

## 2. Request flow

Middleware runs in the order it is registered in `src/app.js`:

```
request
  │
  ├─ requestId          (src/middleware/requestId.middleware.js)  req.id, X-Request-Id header
  ├─ requestLogger      (src/middleware/requestLogger.middleware.js) logs one line on 'finish'
  ├─ express.json()     body ≤ 10 kB; bad JSON → 400 MALFORMED_JSON, too big → 413
  ├─ router             /health, /api/auth, /api/accounts, /api/transactions
  │    ├─ authMiddleware (src/middleware/auth.middleware.js)   protected routes only
  │    └─ controller → service → models → MongoDB
  ├─ notFoundHandler    unknown route → 404 ROUTE_NOT_FOUND
  └─ errorHandler       any thrown error → { error: { code, message, details?, requestId } }
```

Express 5 forwards errors thrown in `async` handlers to `errorHandler`, so
controllers and services simply `throw new AppError(status, code, message)`.

### API surface

| Method & path | Auth | Controller → service |
|---|---|---|
| `GET /`, `GET /health` | – | `getHealthController` → `checkDBHealth` |
| `POST /api/auth/register` | – | `userRegisterController` |
| `POST /api/auth/login` | – | `userLoginController` |
| `POST /api/auth/logout` | ✔ | `userLogoutController` |
| `GET /api/auth/me` | ✔ | `getCurrentUserController` |
| `POST /api/accounts` | ✔ | `createAccountController` |
| `GET /api/accounts` | ✔ | `getUserAccountsController` |
| `GET /api/accounts/:accountId` | ✔ | `getAccountController` → `findOwnWallet` |
| `GET /api/accounts/balance/:accountId` | ✔ | `getAccountBalanceController` → `findOwnWallet` |
| `POST /api/transactions` | ✔ | `createTransaction` → `transfer` |
| `GET /api/transactions?page&limit` | ✔ | `listTransactions` → `listHistory` |
| `GET /api/transactions/:transactionId` | ✔ | `getTransaction` → `getTransactionForUser` |

There is deliberately **no** HTTP endpoint that creates money or freezes a
wallet. Those are `scripts/fund-wallet.js` and `scripts/set-wallet-status.js`.

## 3. Database models

Five collections. Money is always an integer number of paise
(`src/utils/money.js`: one amount ≤ `MAX_AMOUNT_PAISE` = 100,000,000;
a wallet balance ≤ `MAX_BALANCE_PAISE` = 10¹³).

```
 user ─1───0..1─ account (WALLET) ─┐
                                   │ fromAccount / toAccount
 account (SYSTEM_FUNDING, ≤1) ─────┤
                                   ▼
                              transaction ─1───2─ ledger entry (DEBIT + CREDIT)
 tokenBlackList (hash of revoked JWT, TTL)
```

| Model (file) | Key fields | Database-enforced rules |
|---|---|---|
| `user` (`user.model.js`) | `email` (lowercase), `name`, `password` (bcrypt hash, `select: false`) | unique `email` |
| `account` (`account.model.js`) | `type` WALLET \| SYSTEM_FUNDING, `user`, `status` ACTIVE \| FROZEN, `currency` INR, `balance` | partial unique `one_wallet_per_user` ({user} where type=WALLET); partial unique `one_system_funding_account` |
| `transaction` (`transaction.model.js`) | `type` TRANSFER \| FUNDING, `fromAccount`, `toAccount`, `amount`, `status` COMPLETED, `initiatedBy` (user or null), `idempotencyKey`, `requestHash` | unique `one_use_per_idempotency_key` ({initiatedBy, idempotencyKey}); history indexes on {fromAccount, createdAt, _id} and {toAccount, createdAt, _id} |
| `ledger` (`ledger.model.js`) | `account`, `transaction`, `type` DEBIT \| CREDIT, `amount`, `createdAt` | unique `one_debit_one_credit_per_transaction` ({transaction, type}); Mongoose hooks block every update/delete path |
| `tokenBlackList` (`blackList.model.js`) | `tokenHash` (sha256), `expiresAt` | unique `tokenHash`; TTL index deletes the row when the token would have expired |

**Sign convention:** CREDIT increases a balance, DEBIT decreases it, so
`balance = Σ credits − Σ debits`. Funding debits `SYSTEM_FUNDING` (its balance
becomes negative, exactly minus the total funded) and credits a wallet, so
**the sum of all balances is always 0**.

**Why a stored balance *and* a ledger?** The stored `balance` makes reads O(1)
and gives the database a single document to guard with a conditional update
(section 5). The ledger is the history that proves the balance. Reconciliation
checks that they agree.

`connectToDB()` (`src/config/db.js`) calls `ensureIndexes()` before the
server listens, so the unique indexes (which are business rules) always
exist. It only **creates** missing indexes and never drops one the running
code doesn't declare, which is safe during a rolling deploy. The read-only
`npm run reconcile` skips index creation entirely.

## 4. Transaction lifecycle

A transfer is `POST /api/transactions` with
`{ fromAccount, toAccount, amount, idempotencyKey }`.

```
createTransaction (transaction.controller.js)
  └─ validateTransfer(body)            400 on any invalid field (validators.js)
  └─ transfer({ userId: req.user._id, ...input })        (transfer.service.js)
       ├─ requestHash = sha256("TRANSFER|from|to|amount")
       └─ runInTransaction(async session => {            (config/transaction.js)
            ├─ findIdempotentReplay  → same key+hash: return stored txn (replay)
            │                          same key, other hash: 409 IDEMPOTENCY_KEY_REUSED
            ├─ source = findOne({_id: from, type: WALLET, user: userId})  else 403
            ├─ destination = findOne({_id: to, type: WALLET})              else 404
            ├─ both ACTIVE                                                 else 422 WALLET_FROZEN
            ├─ source.balance ≥ amount                                     else 422 INSUFFICIENT_FUNDS
            └─ postDoubleEntry(session, …)                (ledger.service.js)
                 1. transactionModel.create([...])        unique key index guards duplicates
                 2. ledgerModel.insertMany([DEBIT, CREDIT])
                 3. updateOne({_id: from, status: ACTIVE, balance ≥ amount}, $inc −amount)
                 4. updateOne({_id: to, type: WALLET, status: ACTIVE, balance ≤ cap−amount}, $inc +amount)
          })  → commit (writeConcern majority)
  └─ 201 { transaction, idempotentReplay: false }   or 200 { …, idempotentReplay: true }
```

All five writes are in **one MongoDB multi-document transaction**
(`readConcern: snapshot`, `writeConcern: majority`). If anything throws
(a business error, a crash, a lost connection), `runInTransaction` aborts and
**none** of the writes become visible. Failed transfers therefore leave no
transaction record, no ledger entries and no balance change. This is tested by
injecting failures in `tests/transfer.test.js` ("atomicity: a crash halfway
leaves no trace").

The work inside the transaction is database-only (no e-mail, no HTTP call, no
sleep), so it is short and safe to re-run.

### Bounded retries: `runInTransaction(work)`

| Error from MongoDB | Meaning | What `runInTransaction` does |
|---|---|---|
| label `TransientTransactionError` (e.g. `WriteConflict`) | Nothing was applied | Abort, wait a random 0…min(1000, 25·2^attempt) ms, run `work` again; at most `TXN_MAX_ATTEMPTS` (default 10) attempts, then **503 `TRANSACTION_RETRY_EXHAUSTED`** |
| label `UnknownTransactionCommitResult` on commit | Commit may or may not have happened | Re-send the commit (it cannot apply twice), up to `MAX_COMMIT_ATTEMPTS` = 3; still unknown → **503 `TRANSACTION_RETRY_EXHAUSTED`** |
| `AppError` (e.g. `INSUFFICIENT_FUNDS`) | A business decision | Abort and pass the error through; never retried |
| anything else | A bug or outage | Abort and pass through (→ 500); never retried |

The session is always ended in a `finally` block. The 503 message tells the
client to retry with the **same idempotency key**. That is safe because of
section 6: if the earlier attempt did commit, the retry replays it. If it did
not, the retry executes once. Both cases are tested in
`tests/idempotency.test.js` ("uncertain commit outcome") and
`tests/concurrency.test.js`.

## 5. Concurrency strategy

The rule "a wallet never goes below 0" is enforced by **the database**, not
by application memory. There are no in-process locks or mutexes.

1. **Conditional atomic update.** The debit is one operation:
   `updateOne({ _id, status: "ACTIVE", balance: { $gte: amount } }, { $inc: { balance: -amount } })`.
   MongoDB checks the condition and applies the change together, so a check
   can never be separated from its write.
2. **Document-level write conflicts.** Two concurrent transfers from the same
   wallet both write that wallet's document. MongoDB lets only one in-progress
   transaction modify a document. The other gets a `WriteConflict` (a
   `TransientTransactionError`) and `runInTransaction` re-runs it from the
   start. The re-run reads the committed, lower balance, and the checks
   decide again, for example 422 `INSUFFICIENT_FUNDS`.
3. **Snapshot reads.** All reads inside the transaction see one point in time,
   and any conflicting concurrent write forces a retry. So the ownership,
   frozen and balance checks are never based on stale data that is then
   committed.

Worked example (tested: "₹1500 wallet, two simultaneous ₹1000 transfers"):

```
 T1: read A=150000 ─ checks ok ─ insert txn/entries ─ debit A (−100000) ─ credit B ─ COMMIT ✔
 T2: read A=150000 ─ checks ok ─ insert txn/entries ─ debit A ✖ WriteConflict (T1 owns A)
     abort, back off, retry:
 T2': read A=50000 ─ balance < 100000 → 422 INSUFFICIENT_FUNDS (nothing written)
 final: A = 50000 (₹500), exactly one transfer, ledger balanced
```

Transfers between **disjoint** wallets touch different documents and run in
parallel without conflicts. A **hot** wallet (many concurrent transfers from
one wallet) serializes through retries. That costs latency, and under very
heavy contention some requests use up all attempts and get a 503 that applied
nothing. The benchmark measured this (`docs/PERFORMANCE.md`).

Freezing a wallet (`scripts/set-wallet-status.js`) writes the same account
document, so a freeze and an in-flight transfer also conflict. The transfer is
then either fully before the freeze or rejected after it (tested).

## 6. Idempotency design

Clients send an `idempotencyKey` (8–128 chars `[A-Za-z0-9_.:-]`) with every
transfer.

* **Scope:** keys belong to the authenticated user. The unique index is
  `{ initiatedBy, idempotencyKey }`, so two users may use the same key, and
  one user can never read another's transaction by guessing a key. Funding uses
  `initiatedBy: null`.
* **Fingerprint:** `requestHash = sha256("TYPE|fromAccount|toAccount|amount")`
  (`computeRequestHash`, `src/services/ledger.service.js`).
* **Decision**, made *inside* the transaction by `findIdempotentReplay`:

  | Stored transaction for (user, key) | Result |
  |---|---|
  | none | execute the transfer → 201 |
  | same `requestHash` | return the stored transaction → 200, `idempotentReplay: true`, no money moves, no re-validation |
  | different `requestHash` | 409 `IDEMPOTENCY_KEY_REUSED` |

* **Concurrent duplicates:** two requests with the same key both insert a
  transaction with the same unique key. One commits and the other gets a write
  conflict or duplicate-key error. The conflict is retried, sees the committed
  one, and replays. The duplicate-key path in `transfer()`'s `catch` also
  answers as a replay (or 409). Tested: "10 simultaneous identical requests →
  one transfer".
* **Failed requests do not consume the key.** Only committed transfers are
  stored, so after a 4xx/5xx a retry with the same key is evaluated again.
  That is safe, because nothing was applied.
* **Interrupted commits:** see the table in section 4. With a 503 the client
  does not know whether the transfer happened. Retrying with the same key
  resolves it.

## 7. Ledger invariants and reconciliation

Invariants, and where each is enforced:

| # | Invariant | Prevented by | Detected by `reconcile()` as |
|---|---|---|---|
| 1 | Every committed transfer has one transaction record | single DB transaction | – |
| 2 | …and exactly one DEBIT and one CREDIT entry | `postDoubleEntry` + unique `{transaction, type}` | `MISSING_ENTRY`, `EXTRA_ENTRY` |
| 3 | DEBIT on `fromAccount`, CREDIT on `toAccount`, amounts equal the transaction | `postDoubleEntry` | `WRONG_ACCOUNT`, `AMOUNT_MISMATCH` |
| 4 | Entries are never changed | Mongoose hooks in `ledger.model.js` | (a changed entry shows up as 3 or 6) |
| 5 | Failed transfers leave nothing | transaction abort | (would appear as 2/6) |
| 6 | Stored balance = Σ credits − Σ debits | balance updates in the same transaction | `BALANCE_MISMATCH` |
| 7 | Wallets never negative | `$gte` guard + schema validator | `NEGATIVE_WALLET_BALANCE` |
| 8 | Σ debits = Σ credits; Σ balances = 0 | double entry | `UNBALANCED_LEDGER`, `SUM_OF_BALANCES_NOT_ZERO` |
| 9 | SYSTEM_FUNDING = −Σ funding; only one; transfers never touch it | partial unique index, wallet-only queries | `SYSTEM_FUNDING_MISMATCH`, `MULTIPLE_SYSTEM_ACCOUNTS`, `TRANSFER_TOUCHES_SYSTEM`, `INVALID_FUNDING` |
| 10 | References exist, amounts are positive integers, types and status are valid | schemas, validators | `ORPHAN_ENTRY`, `MISSING_ACCOUNT`, `INVALID_AMOUNT`, `INVALID_TYPE`, `INVALID_STATUS` |

`reconcile()` (`src/services/reconciliation.service.js`) is an independent
audit. It reads all accounts, transactions and ledger entries through one
**snapshot session**, so it sees a consistent point in time even while
transfers run, then re-derives everything and lists every broken rule
(17 check codes). **It never modifies data, including indexes.**
`npm run reconcile` prints the report and exits
0 (PASS), 1 (FAIL) or 2 (could not run). Each corruption type is created
directly in the database and shown to be detected in
`tests/reconciliation.test.js`. Every money-moving test also runs `reconcile()`
afterwards (`tests/helpers/invariants.js`).

The hooks cannot stop someone with direct database access (the native driver
bypasses Mongoose). That is exactly the case reconciliation exists to detect.

## 8. Error handling

Every error response has one shape (`src/middleware/error.middleware.js`):

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "Insufficient funds in your wallet", "requestId": "…", "details": { } } }
```

| Status | Codes |
|---|---|
| 400 | `VALIDATION_ERROR` (with per-field `details`), `MALFORMED_JSON`, `INVALID_ID`, `BAD_REQUEST` (other unreadable bodies) |
| 401 | `UNAUTHENTICATED`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `INVALID_CREDENTIALS` |
| 403 | `SOURCE_WALLET_NOT_OWNED` |
| 404 | `ROUTE_NOT_FOUND`, `WALLET_NOT_FOUND`, `DESTINATION_WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` |
| 409 | `DUPLICATE_EMAIL`, `WALLET_EXISTS`, `IDEMPOTENCY_KEY_REUSED`, `DUPLICATE_RESOURCE` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` (unknown body charset or `Content-Encoding`) |
| 422 | `INSUFFICIENT_FUNDS`, `WALLET_FROZEN`, `BALANCE_LIMIT_EXCEEDED` |
| 500 | `INTERNAL_ERROR`: generic message only; the stack is logged server-side with the request id |
| 503 | `TRANSACTION_RETRY_EXHAUSTED` (transfer), health `unavailable` |

Stack traces are never sent to clients in any environment.

## 9. Logging

`src/utils/logger.js` writes one JSON object per line (info and debug to
stdout, warn and error to stderr), filtered by `LOG_LEVEL`. Each request
produces one `http.request` line with `requestId, method, path` (no query
string), `status, durationMs, userId, transactionId, errorCode`. Other events
include `txn.retry`, `txn.retry_exhausted`, `txn.commit_retry`,
`http.unhandled_error` (with stack), `http.server_error_response` (warn, no
stack) and `process.unhandled_rejection`.

Never logged: headers (they hold the JWT), request bodies (passwords), query
strings. As a safety net, a field whose name matches
`password|token|secret|authorization|cookie` is replaced with `"[REDACTED]"`.
`tests/observability.test.js` captures all output during a register, login,
logout session and asserts that no password, token, secret, bcrypt hash or
email appears.

## 10. Security boundaries

| Boundary | Implementation |
|---|---|
| Authentication | `Authorization: Bearer <JWT>` only. Cookies are ignored, which removes CSRF on money routes. `jwt.verify` is pinned to `HS256`, and `alg: none` and foreign secrets are rejected. `JWT_SECRET` must be ≥ 32 chars or the app refuses to start |
| Revocation | Logout stores **sha256(token)** until the token's `exp`. Each token has a unique `jti`, so logging out one session does not revoke others. A deleted user's token gives 401 |
| Passwords | bcrypt (cost `BCRYPT_SALT_ROUNDS`, default 10), 8–72 bytes; never returned (`select: false`); login runs bcrypt even for unknown emails, so response time does not reveal which emails exist |
| Authorization | The source wallet must match `{ _id, type: WALLET, user: req.user._id }`: ownership comes from the JWT, never from the body. Reading another user's wallet or transaction returns 404, so ids are not confirmed to exist |
| Input | Every field is type-checked before it reaches a query (`src/utils/validators.js`), which blocks `{"$gt": ""}`-style operator injection. Ids must be 24-hex strings. Amounts must be JSON integers. Body ≤ 10 kB |
| Money creation | No HTTP endpoint. `seed`, `fund`, `wallet:status` and `perf` run only with `NODE_ENV` `development`/`test` **and** a `MONGO_URI` on this machine (`scripts/script-helpers.js`). Only the read-only `reconcile` may run elsewhere |
| Startup config | `validateConfig()` refuses a missing or short `JWT_SECRET`, the `.env.example` placeholder secret, an invalid `JWT_EXPIRES_IN` and out-of-range numbers |
| Data exposure | Responses use explicit `toPublic*` mappers. History shows the other side only as a wallet id. A transaction's idempotency key is shown only to its initiator |
| Secrets | `.env` is git-ignored; `.env.example` holds placeholders only |

Accepted disclosures: registering an existing email returns 409, and a
transfer to a frozen wallet returns `WALLET_FROZEN` for `toAccount`. Any user
with a wallet can therefore learn whether an email is registered or a wallet
is frozen. Both are ordinary product behaviour (the payer must be told why the
payment failed), and without rate limiting they could be probed in bulk.

Not implemented (out of scope for this project): rate limiting / login
throttling, refresh tokens, TLS termination, admin roles, account recovery.

## 11. Design trade-offs

| Decision | Why | Cost |
|---|---|---|
| Stored balance + ledger | O(1) balance reads; one document to guard against overdraft | Two sources of truth, so reconciliation is needed |
| Conditional update + transaction, no locks | Correct across processes and servers; no lock service | Hot wallets serialize through retries (latency, occasional 503) |
| Bounded retry loop instead of `withTransaction()` | The driver's helper retries for up to 120 s; a request should fail fast and clearly | Under extreme contention clients see 503 and must retry with the same key |
| Idempotency record = the transaction itself | No separate idempotency table to keep in sync; the unique index makes duplicates impossible | Failed requests are not remembered (by design: nothing was applied) |
| Snapshot reads, majority writes | Consistent checks; committed data survives a primary failover | Slightly slower commits than `w: 1` |
| Page-number pagination | Simplest to use and explain | Items can shift between pages while new transfers arrive; cursor pagination would fix it |
| In-memory reconciliation | Easiest to read and verify | Memory grows with the ledger; a large system would aggregate in the database or reconcile incrementally |
| Single currency, single wallet per user | Scope control | Not a general multi-account ledger |
| Mongoose-level ledger immutability | Simple | Bypassed by direct DB access; database roles would be needed for real enforcement |
