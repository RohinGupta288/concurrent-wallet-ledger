# Repository Audit: backend-ledger (pre-refactor)

**Audited revision:** `b6bbfc5` ("Add health check route to confirm service status"), branch `main`
**Upstream:** https://github.com/ankurdotio/backend-ledger (11 commits, sole author: ankurdotio)
**Audit date:** 2026-11-24
**Scope:** every tracked file: 19 files, about 900 lines.

> This audit describes the repository *as cloned*, before any modification. Later
> changes are tracked in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

---

## 1. Licensing and attribution

- The upstream repository contains **no LICENSE file**, so no explicit license is granted.
- `package.json` has `"license": "ISC"`. That field is metadata that npm generates by default. **It is not a license grant**, and this project does not treat it as one.
- What follows from that:
  - The original author's code is credited in the README.
  - The `license` field is left unchanged.
  - No LICENSE file is added on the author's behalf.
  - Anyone who wants to publish or redistribute this derivative work should obtain permission or an explicit license from the original author first.

## 2. What the project already implements

| Area | Files | What it does |
|---|---|---|
| Bootstrap | `server.js`, `src/app.js`, `src/config/db.js` | Express 5 app on hard-coded port 3000; Mongoose connection started (not awaited) |
| Registration / login / logout | `src/controllers/auth.controller.js`, `src/routes/auth.routes.js` | bcrypt-hashed passwords, JWT (3 days) returned in body and set as a cookie; logout writes the raw token to a blacklist |
| Auth middleware | `src/middleware/auth.middleware.js` | Reads the token from cookie or `Authorization: Bearer`, checks the blacklist, loads the user; second variant for "system users" |
| Users | `src/models/user.model.js` | Email lowercased + trimmed, password `select:false`, `systemUser` flag |
| Accounts | `src/models/account.model.js`, `src/controllers/account.controller.js` | Create account (unlimited per user), list own accounts, balance derived from ledger aggregation (ownership checked ✔) |
| Ledger | `src/models/ledger.model.js` | Entries `{account, amount, transaction, type: DEBIT/CREDIT}`; fields `immutable`; query hooks block update/delete ✔ |
| Transactions | `src/models/transaction.model.js`, `src/controllers/transaction.controller.js` | Transfer endpoint with idempotency key; "system initial funds" endpoint |
| Email | `src/services/email.service.js` | nodemailer + Gmail OAuth: registration and transaction emails |
| Token blacklist | `src/models/blackList.model.js` | Raw tokens, TTL 3 days |

Missing entirely: tests, README, `.env.example`, CI, input validation, centralized error handling, structured logging, DB health check, reconciliation, transaction history, concurrency protection, stored balances.

## 3. Critical defects (financial correctness or security)

| # | Defect | Location | Impact |
|---|---|---|---|
| C1 | **Overdraft race / double spend.** The balance is computed from a ledger aggregation *before* the DB transaction starts, and the transfer then only *inserts* new ledger documents. Two concurrent transfers both pass the check. Even if the check were moved inside a MongoDB transaction, snapshot isolation would still allow write skew, because the two transactions write *different* documents and never conflict. | `transaction.controller.js:98-140` | Wallets can go negative; money is created from nothing |
| C2 | **No ownership check on the source account.** `fromAccount` comes from the request body and is never compared with `req.user`. | `transaction.controller.js:35-47` | Any logged-in user can spend from any wallet |
| C3 | **15-second `setTimeout` inside an open DB transaction.** | `transaction.controller.js:131-133` | Transactions held open, contention, timeouts |
| C4 | **Session leak and no rollback.** `session` is declared inside `try`; the `catch` never calls `abortTransaction()` or `endSession()`. Transient errors are not retried. The error response falsely says the transaction is "Pending". | `transaction.controller.js:107-157` | Leaked sessions; misleading client state |
| C5 | **Public money-creation endpoint.** `POST /api/transactions/system/initial-funds` lets a `systemUser` mint any amount, with no amount validation, no error handling (an unhandled rejection leaves the session open), and an ambiguous lookup of the system account (`findOne({ user })`). The `transaction` document is saved only at the end, so a failure between the ledger inserts and `save` is unhandled. | `transaction.controller.js:170-237`, `transaction.routes.js:19` | Unbounded value creation over HTTP |
| C6 | **Plaintext password written to logs** on every login: `console.log(password, this.password)`. | `user.model.js:48` | Credential leak |
| C7 | **Amount validation is just `!amount`.** Fractions (`0.1`), numeric strings (`"100"`, coerced in `balance < amount`), and unsafe integers are accepted. Amounts are stored as floating-point `Number`s with no integer rule. | `transaction.controller.js:29`, models | Floating-point money, inconsistent data |
| C8 | **Idempotency is incorrect.** (a) The key is unique *globally*, not per user, so a different user who reuses a key gets back **someone else's transaction object**. (b) The lookup and insert are separate steps (check-then-act race), which only the index catches, and its error is then reported as "Pending". (c) A key reused with *different* parameters returns the old transaction instead of a conflict. (d) `PENDING`/`FAILED`/`REVERSED` states are never written consistently. | `transaction.controller.js:53-83`, `transaction.model.js:30-35` | Data leak; wrong replay semantics |
| C9 | **No centralized error handler.** Any thrown error (duplicate email E11000, invalid ObjectId CastError, malformed JSON) falls through to Express's default handler, which returns HTML and includes the stack trace outside production. | `src/app.js` | Information disclosure, inconsistent API |

## 4. High / medium severity

- **Deleted-user tokens crash requests.** `authMiddleware` sets `req.user = null` when the user no longer exists, and downstream code then throws a TypeError.
- **CSRF surface.** The JWT is set in a cookie that is not `httpOnly`, and cookies are accepted as authentication for state-changing POSTs (including money transfer).
- **Raw JWTs are stored in the blacklist**, so a database leak exposes usable tokens.
- **Logout is unauthenticated.** Any string sent to it gets written into the blacklist collection.
- **Registration is unvalidated** (missing fields, password rules). Its duplicate check is check-then-act: a concurrent duplicate reaches the unique index and becomes an unhandled 500. `unique: [true, "..."]` is not a validator, so its message is never shown.
- **Query-operator injection is possible.** `{"email": {"$gt": ""}}` reaches `findOne` because inputs are never type-checked, which enables user enumeration.
- **No stored balance.** Every balance read scans the account's ledger entries, and there is nothing to reconcile the ledger *against*.
- **Unlimited accounts per user.** No DB constraint.
- **Email service problems:**
  - `transporter.verify()` makes a network call at import time.
  - The app needs Gmail OAuth credentials to run cleanly.
  - Amounts are shown with `$` even though the currency is INR.
  - The email send is awaited after the DB commit on the request path.
- **Ledger immutability is Mongoose-only.** It blocks `updateOne`/`deleteMany`/etc. but not the native driver, `bulkWrite`, or document `deleteOne`. This is acceptable for the project, but it must be documented, and reconciliation is the backstop.
- **Startup.** The DB connection is not awaited before `listen`, the port is hard-coded, and `JWT_SECRET` is not checked at startup.

## 5. Low severity / hygiene

- `cookieparser@0.1.0` is an accidental, unused dependency (next to `cookie-parser`).
- `"main": "index.js"` points to a file that does not exist. The `test` script fails on purpose.
- The `CLOSED` account status exists in the enum, but no code path uses it.
- Ledger entries have no timestamps.
- Every route has an unhandled promise path, because no route uses try/catch and there is no error middleware.

## 6. Reuse decisions

| Component | Decision | Reason |
|---|---|---|
| Express app + routes/controllers layout | **Keep** | Clear and conventional |
| `user.model.js` (hash hook, `select:false`, email normalization, `comparePassword`) | **Keep, fix** | Remove the password log and `systemUser`; add length rules |
| `account.model.js` (status, currency, timestamps) | **Keep, extend** | Add `type`, stored integer `balance`, DB-level one-wallet-per-user index |
| `ledger.model.js` (immutable fields, hooks, DEBIT/CREDIT convention) | **Keep, extend** | Add integer validation, timestamps, unique `(transaction, type)` |
| `transaction.model.js` | **Keep, extend** | Add `type`, `initiatedBy`, `requestHash`; per-user idempotency index |
| `blackList.model.js` (TTL idea) | **Keep, fix** | Store a SHA-256 of the token; expire at the token's own expiry |
| `auth.controller.js`, `auth.middleware.js` | **Rewrite internals** | Validation, Bearer-only, error handling, deleted-user check |
| `transaction.controller.js` | **Replace** | The logic moves into `services/` with a correct concurrency design |
| `config/db.js`, `server.js` | **Rewrite** | Await the connection, verify a replica set, build indexes, shut down gracefully |
| `email.service.js` + nodemailer | **Remove** | Email notification is explicitly out of scope; it also blocked running without Gmail credentials |
| `/system/initial-funds` + `authSystemUserMiddleware` + `systemUser` | **Remove** | Replaced by a dev-only, idempotent funding script that posts balanced entries against an explicit system funding account |
| `cookie-parser`, `cookieparser` | **Remove** | Bearer-only authentication removes the CSRF surface |

## 7. Environment findings (developer machine)

| Tool | Found | Required | Action |
|---|---|---|---|
| Node.js | v20.15.0 | ≥ 20.19.0 (`mongodb@7` / `bson@7` engines) | Upgraded to **v22.23.5** via `winget install OpenJS.NodeJS.22` |
| npm | 10.7.0 | bundled with Node | Now 10.9.9 |
| MongoDB | not installed | replica set (transactions) | Tests: `mongodb-memory-server` replica set. Dev: install MongoDB 8.0 Community as a replica set, or `npm run db:dev` |
| Docker | not installed | not required | — |
