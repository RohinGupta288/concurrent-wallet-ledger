# Implementation Plan: Concurrent-Safe Digital Wallet & Double-Entry Ledger

Companion to [AUDIT.md](AUDIT.md). This plan was approved on 2026-11-24 with the adjustments listed in §6.

**Priority order:** Correctness → Security → Simplicity → Testability → Maintainability → Performance.

---

## 1. Decisions

| Topic | Decision |
|---|---|
| Runtime | Node.js 22 LTS (`.nvmrc`), `engines.node >= 20.19.0` |
| Runtime deps | Keep the locked express 5.2, mongoose 9.1, bcryptjs 3, jsonwebtoken 9, dotenv 17. Remove nodemailer, cookie-parser, cookieparser. **No new runtime deps.** |
| Dev deps | jest 30, supertest 7, mongodb-memory-server 11 (MongoDB **8.0.32** binary), autocannon 9, nodemon 3 |
| Test/CI database | `MongoMemoryReplSet`: a real `mongod` in single-node replica-set mode. Optional `TEST_MONGO_URI` override (the DB name must contain `test`) |
| Dev database | MongoDB 8.0 Community installed as a single-node replica set (documented), **or** `npm run db:dev` (spawns the downloaded `mongod` with `--replSet rs0` and a persistent `.data/` directory) |
| Auth transport | `Authorization: Bearer <JWT>` only (HS256 pinned) |
| Money | Integer paise only, JSON numbers only (no strings, no fractions). 1 ≤ amount ≤ 100,000,000 paise (₹10,00,000) per operation. Wallet balance cap 10¹³ paise |
| Git | Branch `feature/wallet-ledger`, one local commit per milestone, no pushes |

## 2. Target structure

```
src/
  app.js                      Express app (middleware, routes, error handling)
  server.js                   Process entry: validate config, connect DB, listen, graceful shutdown
  config/env.js               Load + validate environment variables
  config/db.js                Connect, verify replica set, sync indexes, health check
  config/transaction.js       runInTransaction(): bounded retry loop for MongoDB transactions
  models/                     user, account, transaction, ledger, blackList
  routes/                     auth, account, transaction, health
  controllers/                auth, account, transaction, health
  services/                   ledger (double-entry posting), transfer, funding, history, reconciliation
  middleware/                 auth, requestId, requestLogger, error
  utils/                      AppError, logger, validators, money
scripts/                      dev-db, seed, fund-wallet, set-wallet-status, reconcile, perf
tests/                        globalSetup/Teardown, setupEnv, helpers/, *.test.js
docs/                         AUDIT, IMPLEMENTATION_PLAN, START_HERE, LEARNING_GUIDE, ARCHITECTURE, TEST_REPORT
.github/workflows/ci.yml
```

## 3. Data model and invariants

**Account:** `user` (required for `WALLET`), `type: WALLET | SYSTEM_FUNDING`, `status: ACTIVE | FROZEN`, `currency: "INR"`, `balance` (integer paise).
- Partial unique index `{user:1}` where `type = WALLET` enforces one wallet per user.
- Partial unique index `{type:1}` where `type = SYSTEM_FUNDING` means a single system account.

**Transaction:** the logical record. `type: TRANSFER | FUNDING`, `fromAccount`, `toAccount`, `amount`, `status: COMPLETED`, `initiatedBy` (user, `null` for funding), `idempotencyKey`, `requestHash`, timestamps.
- Unique `{initiatedBy:1, idempotencyKey:1}`.
- History indexes on `fromAccount` / `toAccount` + `createdAt`.
- Only committed operations have records; failures roll back completely.

**Ledger entry:** `account`, `transaction`, `type: DEBIT | CREDIT`, `amount`, `createdAt`; all fields immutable.
- Unique `{transaction:1, type:1}`.

**Sign convention:** CREDIT increases an account's balance and DEBIT decreases it, so `balance = Σ credits − Σ debits`.

**Why the system funding account may be negative:** simulated money has to enter the system from somewhere without breaking double entry.
- Funding a wallet with ₹100 posts DEBIT `SYSTEM_FUNDING` ₹100 and CREDIT wallet ₹100.
- The system account's balance is therefore exactly **−(total money ever issued)**. A negative number here is the expected bookkeeping value: it shows how much simulated money is in circulation.
- User wallets hold real (simulated) spendable value, so they must never go below zero. Every wallet debit is guarded by `balance >= amount`. The system account's debit is the only unguarded one, and it is reachable only from dev-only CLI scripts, never over HTTP.

**Invariants (checked by tests and reconciliation):**
1. Each committed transaction has exactly 2 ledger entries: one DEBIT on `fromAccount`, one CREDIT on `toAccount`, each equal to `transaction.amount`.
2. Σ all debits = Σ all credits; Σ all account balances = 0.
3. For each account, stored `balance` = ledger-derived balance.
4. No wallet balance is negative.
5. `FUNDING` transactions debit the system account; `TRANSFER` transactions never touch it; the system balance = −Σ FUNDING amounts.
6. No orphan entries (missing transaction or account) and no duplicate entries.

## 4. Transfer algorithm and concurrency strategy

1. Validate input (ObjectIds, `from ≠ to`, integer amount within limits, idempotency key 8–128 chars `[A-Za-z0-9_.:-]`). Compute `requestHash = sha256(from|to|amount)`.
2. Idempotency fast path: look up `(userId, key)`. Same hash → replay (HTTP 200, `idempotentReplay: true`). Different hash → 409 `IDEMPOTENCY_KEY_REUSED`.
3. `runInTransaction(async (session) => …)`, where the callback contains only DB work (retry-safe):
   1. Load the source → 404 / 403 (not owner) / 422 `WALLET_FROZEN`. Load the destination → 404 / 422.
   2. Insert the Transaction record (the unique index guards duplicate keys).
   3. Conditional debit: `updateOne({_id: from, status: ACTIVE, balance: {$gte: amount}}, {$inc: {balance: -amount}})`. If nothing matched, re-read to report `INSUFFICIENT_FUNDS` or `WALLET_FROZEN`.
   4. Conditional credit: `updateOne({_id: to, status: ACTIVE, balance: {$lte: CAP - amount}}, {$inc: {balance: +amount}})`.
   5. Insert the DEBIT + CREDIT ledger entries. Commit.
4. On E11000 for the idempotency index (a concurrent duplicate won), load the winner and replay or return 409.

**Why races are impossible:** two transfers from the same wallet must both write the *same* account document. MongoDB allows only one in-progress transaction to write a document. The other receives a `WriteConflict` (labelled `TransientTransactionError`), is aborted, and is retried from the beginning. The retry sees the committed balance, so the `$gte` guard rejects an overdraft. Transfers on disjoint wallets don't conflict and run in parallel. No in-memory locks are used.

**Bounded retries (`src/config/transaction.js`):**
- At most `TXN_MAX_ATTEMPTS` (default 10; originally planned as 5, raised after measurement in M4: on this machine 5-way contention on one document already needed up to 5 attempts and 40-way needed 9) attempts on `TransientTransactionError`, with full-jitter exponential backoff capped at 1 s, so the worst case is bounded (about 5.5 s of waiting).
- `commitTransaction` is retried at most 3 times on `UnknownTransactionCommitResult`.
- When the limit is exhausted, the API returns 503 `TRANSACTION_RETRY_EXHAUSTED`: "retry with the same idempotency key".

**Uncertain commit outcomes:** if the client never learns whether a commit succeeded, it retries with the same key. Either the earlier attempt committed, and the unique index plus replay return it without moving money again, or it didn't, and the retry executes once. Nothing persists for a failed attempt, so a key is only "consumed" by a committed transfer.

## 5. API

| Method & path | Auth | Purpose |
|---|---|---|
| POST `/api/auth/register` | – | Create a user → 201 `{user, token}`; 409 `DUPLICATE_EMAIL` |
| POST `/api/auth/login` | – | → 200 `{user, token}`; 401 `INVALID_CREDENTIALS` |
| POST `/api/auth/logout` | ✔ | Revoke the current token |
| GET `/api/auth/me` | ✔ | Current user's profile |
| POST `/api/accounts` | ✔ | Create the INR wallet; 409 `WALLET_EXISTS` |
| GET `/api/accounts` | ✔ | List my wallet(s) |
| GET `/api/accounts/:accountId` | ✔ | Wallet details (owner only, else 404) |
| GET `/api/accounts/balance/:accountId` | ✔ | Balance (owner only) |
| POST `/api/transactions` | ✔ | Transfer `{fromAccount, toAccount, amount, idempotencyKey}` |
| GET `/api/transactions?page=&limit=` | ✔ | My wallet's history, newest first |
| GET `/api/transactions/:transactionId` | ✔ | Detail (only if my wallet is a party, else 404) |
| GET `/health` | – | App + DB status → 200 / 503 |

**Error format:** `{ "error": { "code", "message", "details"?, "requestId" } }`. Status codes:
- 400: validation
- 401: authentication
- 403: not the owner
- 404: not found
- 409: conflict
- 413: payload too large
- 422: business rule (insufficient funds, frozen)
- 500: unexpected; stack traces are never sent to clients
- 503: retry exhausted or DB down

## 6. Approved adjustments (review of 2026-11-24)

1. Full engineering depth is kept: concurrency, idempotency, double entry, reconciliation, security, tests, CI, and performance testing.
2. Add `docs/START_HERE.md`: a concise guide following one transfer end to end, the 10–15 key files and functions, and a two-day sequence. `LEARNING_GUIDE.md` stays as the full reference.
3. Four review stages; work stops for review at each boundary or on a significant blocker.
4. Node/MongoDB compatibility is verified. Transaction retries are bounded. Duplicates stay safe after uncertain commits. Concurrency tests assert database invariants.
5. The reason the system funding account may go negative is documented (§3), and reconciliation checks it explicitly.
6. Beginner-friendly code: plain functions, a single `AppError` class, no new runtime dependencies.
7. Attribution is preserved. The `ISC` field is not treated as a license (see AUDIT §1).

## 7. Milestones and stages

| Stage | # | Milestone | Depends on | Verification |
|---|---|---|---|---|
| **1 Foundation** | M0 | AUDIT.md + IMPLEMENTATION_PLAN.md | – | Files exist and match the approved plan |
| | M1 | Foundation: deps, env config, DB connect + replica-set check, server/app split, AppError, error + 404 handler, JSON logger, request IDs, `/health`, `.env.example`, `.gitignore`, Jest harness, `scripts/dev-db.js`; remove the email service | M0 | `npm test` (health/error/config tests); `npm run db:dev` + `npm start` + `GET /health` → 200 |
| | M2 | Auth: validators, user model fixes, register/login/logout/me, Bearer-only middleware, hashed blacklist; remove system-user funding endpoint | M1 | `tests/auth.test.js` |
| **2 Core wallet & transfers** | M3 | Account/transaction/ledger models, `money.js`, wallet endpoints | M2 | `tests/wallet.test.js`, `tests/money.test.js` |
| | M4 | `ledger.service` (double-entry posting), `funding.service`, seed / fund / status scripts | M3 | `tests/funding.test.js`; seed run twice gives the same balances |
| | M5 | `config/transaction.js` (bounded retry), `transfer.service`, transfer endpoint | M4 | `tests/transfer.test.js`, `tests/idempotency.test.js`, `tests/transaction-retry.test.js`, including injected-failure rollback |
| | M6 | Concurrency suite | M5 | `tests/concurrency.test.js`: DB invariants after every scenario |
| | M7 | History list + detail with pagination | M5 | `tests/history.test.js` |
| **3 Reliability & tooling** | M8 | Reconciliation service + CLI | M5 | `tests/reconciliation.test.js` with intentionally corrupted data; exit codes |
| | M9 | Observability polish | M5 | `tests/observability.test.js`: request IDs, no stack in production, no secrets in logs |
| | M10 | GitHub Actions CI | M6 | Workflow file reviewed; status unverified until pushed to the user's own repo |
| | M11 | Performance test script + measured results | M8 | Actual numbers recorded |
| **4 Docs & final** | M12 | README, START_HERE, LEARNING_GUIDE, ARCHITECTURE, TEST_REPORT, CONTRIBUTING.md | M11 | Each documented command executed |
| | M13 | Final audit + requirement matrix | all | Full suite green, reconcile PASS, no TODO/stub |

## 8. Risks and assumptions

- The first test run downloads a MongoDB binary (~100 MB). A proxy or antivirus can block it; the fallback is `TEST_MONGO_URI` pointing at an installed replica set.
- The repo lives under OneDrive, so syncing `node_modules/` and `.data/` can be slow. Pausing sync or moving the folder helps.
- Ledger immutability and "only committed records" are enforced in the application and Mongoose layer, not by database roles. Reconciliation is the detection backstop.
- Performance numbers come from a single machine running both the load generator and the server, so they are indicative only.
- No upstream LICENSE exists (see AUDIT §1).

## 9. Progress

| # | Status | Notes |
|---|---|---|
| M0 | ✅ Done | |
| M1 | ✅ Done | 12 tests pass; db:dev start/stop/restart and `npm start` + `/health` verified manually |
| M2 | ✅ Done | 36 tests pass (24 auth); manual register/login/me/logout against dev DB; system funding endpoint removed (funding returns in M4 as a dev-only script) |
| M3 | ✅ Done | 107 tests pass (wallet API, model rules incl. ledger immutability hooks, money unit tests); POST /api/transactions is non-functional until M5 replaces it |
| M4 | ✅ Done | 123 tests pass (16 funding incl. concurrent + same-key races, seed twice, production refusal); scripts run manually against dev DB; `runInTransaction` added here (needed by funding), TXN_MAX_ATTEMPTS default raised 5 -> 10 after measuring contention |
| M5 | ✅ Done | 174 tests pass (transfer 29, idempotency 14 incl. both uncertain-commit cases, retry loop 8 incl. a real WriteConflict); mutation check (debit outside session) caught by the atomicity test; manual HTTP run against dev DB |
| M6 | ✅ Done | 184 tests pass; concurrency suite (10 scenarios, DB invariants after each) passed 9/9 repeated runs; removing the balance guards makes the 3 double-spend tests fail; reconcile PASS assertion added to the invariant helper in M8 |
| M7 | ✅ Done | 202 tests pass (18 history: ordering, page boundaries, per-user visibility, no PII, detail 404s); explain() shows SORT_MERGE over both history indexes (no collection scan, no in-memory sort) |
| M8 | ✅ Done | 226 tests pass (23 reconciliation: 15 corruption kinds detected, read-only check, CLI exit codes 0/1/2 and --json); reconcile() now asserted PASS inside every expectBooksBalanced() call, incl. all concurrency scenarios, plus 6 audits run during 30 in-flight transfers |
| M9 | ✅ Done | 236 tests pass (10 observability: log fields per request, error codes, no query strings, no passwords/JWTs/secret/bodies in any log line, field-name redaction, 500 hides internals but logs stack + request id, retry logs, LOG_LEVEL); unhandledRejection handler in server.js |
| M10 | ✅ Done locally, ⚠️ unverified on GitHub | Workflow parsed with js-yaml; CI simulated from a clean `git archive HEAD` export outside OneDrive with no .env: `npm ci` (MongoDB binary landed in MONGOMS_DOWNLOAD_DIR, the cached path) + `npm test` -> 236/236 in 96 s. Simulation ran on Windows; the workflow runs on ubuntu-24.04, so it stays unverified until pushed to a repo you own |
| M11 | ⬜ | |
| M12 | ⬜ | |
| M13 | ⬜ | |
