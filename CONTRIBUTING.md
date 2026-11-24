# Contributing

Conventions for changing this repository.

## What this is

An educational, **simulated-money** wallet backend: Node.js 22, Express 5,
Mongoose 9, MongoDB 8.0 **replica set**, JWT, Jest. INR only, stored as
integer paise. It is a simple monolith; keep it that way (no Redis, queues,
microservices, extra layers or new runtime dependencies without a clear
need). It isn't production-ready, and docs must never claim it is.

Reference docs: `docs/ARCHITECTURE.md` (how it works), `docs/START_HERE.md`
and `docs/LEARNING_GUIDE.md` (learning material, which must match the code),
`docs/TEST_REPORT.md` (what is verified).

## Commands (Windows PowerShell)

```powershell
npm ci                         # install from the lockfile
npm run db:dev                 # local MongoDB 8.0 replica set on 127.0.0.1:27017 (keep running)
npm start                      # API on :3000 (needs .env; see .env.example)
npm run seed                   # demo users alice/bob/charlie@example.com, Password@123
npm test                       # full suite (jest --runInBand, real in-memory replica set)
npx jest tests/<file>.test.js --runInBand
npm run reconcile              # read-only ledger audit; exit 0 PASS / 1 FAIL / 2 error
npm run perf                   # bounded local load test (development DB only)
```

The full suite takes about 1–6 minutes depending on the machine (it is
slow on battery power). Run it after every change that touches `src/`.

## Rules that protect money correctness

1. **Money moves only in `postDoubleEntry()`** (`src/services/ledger.service.js`),
   and only inside `runInTransaction()` (`src/config/transaction.js`).
   Every movement is one transaction record + one DEBIT + one CREDIT + both
   balance updates.
2. **Every database call inside a transaction passes the session**
   (`{ session }` or `.session(session)`). A call without it escapes the
   rollback.
3. **`work` functions do database work only.** No HTTP calls, e-mail, sleeps
   or in-memory side effects: they may run up to `TXN_MAX_ATTEMPTS` times.
4. **Wallet debits stay conditional** (`balance: { $gte: amount }`,
   `status: "ACTIVE"`). Never replace them with read-check-write in
   JavaScript.
5. **Ownership comes from `req.user._id`**, never from the request body.
   Other users' resources answer 404 (reads) or 403 `SOURCE_WALLET_NOT_OWNED`
   (transfer source).
6. **Validate types before querying** (`src/utils/validators.js`): strings
   are strings, ids are 24-hex, amounts are `isValidAmount()` integers.
7. **Ledger entries are immutable.** Fix mistakes with new transactions,
   never by editing history. Reconciliation reports and never repairs.
8. **Unique indexes are business rules** (`one_wallet_per_user`,
   `one_system_funding_account`, `one_use_per_idempotency_key`,
   `one_debit_one_credit_per_transaction`). `ensureIndexes()` creates them;
   never switch back to `syncIndexes()` at startup (it drops indexes).
9. **No public money creation or freezing.** Funding and status changes are
   scripts guarded by `runScript()` (development/test `NODE_ENV` and a local
   `MONGO_URI` only).
10. **Never log** passwords, tokens, the JWT secret, request bodies, headers
    or query strings. Use `logger` with explicit safe fields.

## Testing conventions

* Tests run against a real replica set (`tests/globalSetup.js`); never a
  standalone server or mocks of MongoDB.
* Money tests must assert **database state** (balances, counts) and end with
  `await expectBooksBalanced()` (`tests/helpers/invariants.js`), which also
  requires `reconcile()` to PASS.
* Concurrency tests use `Promise.all` for real contention, never sleeps.
  On slow machines a 503 `TRANSACTION_RETRY_EXHAUSTED` is legitimate; retry
  it with the same idempotency key rather than loosening invariants.
* Check Jest's real exit code. Don't pipe `jest` into `tail` or `head`
  without keeping the exit status.

## Reporting results

* Report tests, CI, startup checks and benchmarks as passing only after
  running them and reading their output. CI (`.github/workflows/ci.yml`)
  counts as verified only once it has run on GitHub.
* Never invent performance numbers. `docs/PERFORMANCE.md` holds measured
  runs with their raw JSON in `docs/perf-results/`.
* Keep `docs/TEST_REPORT.md` and the learning docs in sync with the code.

## Git

* Work on a feature branch; one focused commit per change; do not push
  unless asked.
* Never commit `.env`, `.data/`, `.vscode/` or credentials.
* Keep the original author's attribution (README "Attribution and
  license"). The upstream repo has no LICENSE file; don't add one on the
  author's behalf.
