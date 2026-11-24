# Test report

Status of verification after milestone M13 (2026-11-24), on branch
`feature/wallet-ledger`. This report separates what was **executed and
observed** from what is only implemented or claimed. Nothing here is
inferred from "the tests pass" alone.

| | |
|---|---|
| Automated tests | **251 passed, 0 failed**, 14 suites (Jest exit 0, 112 s), at commit 0fc167c |
| Application startup + `/health` | Verified from a fresh `git archive` export: `npm ci`, `.env` setup per README, `npm start` → `db.connected`, `server.started`, `/health` 200 `ok`, replica set `rs0` |
| README API walkthrough | Every request in README §13 executed against that server; every status code and error code as documented |
| Reconciliation (dev DB) | **PASS**: 85 wallets, 4,693 transactions, 9,386 ledger entries, debit = credit = 801,904,878 paise, 0 inconsistencies |
| Benchmark | 4 runs recorded (`docs/PERFORMANCE.md`); run 4 checked key by key: 0 acknowledged transfers missing, 0 of the 503s stored, reconcile PASS |
| Code review | Separate read-only review pass over the whole codebase; no critical or high findings; medium and low findings fixed (see "Audit") |
| GitHub Actions | Workflow reviewed and parsed; CI simulated locally. **Not run on GitHub: unverified** |
| Production readiness | **Not claimed.** Educational, simulated-money project |

## 1. Environment

| | |
|---|---|
| Machine | Windows 11 laptop, Intel i7-1260P (16 logical cores), 15.7 GB RAM; repository inside a OneDrive-synced folder |
| Runtime | Node.js v22.23.5, npm 10.9.9, PowerShell 5.1 |
| Database | MongoDB 8.0.32 single-node replica set: `mongodb-memory-server` for tests, `npm run db:dev` for development |
| Key dependencies (after `npm audit fix`) | express 5.2.1, mongoose 9.13.0 (driver 7.9.1), jsonwebtoken 9, bcryptjs 3, jest 30, autocannon 9 |
| Not available | MongoDB Community Server and mongosh were not installed; Postman was not used; no Linux machine (CI runs on ubuntu-24.04) |

## 2. Commands executed and their results

| Command | Result |
|---|---|
| `npm test` (`jest --runInBand`), final run | 251/251 passed, Jest exit 0, 112 s |
| `npm test`, after the audit fixes (commit 9134269) | 251/251 passed, exit 0, 79 s |
| `npm test`, after M11 (commit 5010f4f) | 237/237 passed, exit 0, 49 s |
| `git archive` → `npm ci` (fresh copy outside OneDrive) | exit 0 in 1 min 53 s; `npm audit --omit=dev`: 0 vulnerabilities |
| `node src/server.js` with the `.env.example` placeholder secret | refused: `JWT_SECRET still has the placeholder value…`, exit 1 |
| README §7 secret generation + replacement commands | `.env` updated, 96-character secret |
| `npm start` (fresh copy) | `db.connected` (rs0), `server.started` port 3000 |
| second `node src/server.js` on the same port | `server.listen_failed` EADDRINUSE, exit 1 (after the fix in commit 0fc167c; before it, a misleading `server.started` line was logged first) |
| `Invoke-RestMethod http://localhost:3000/health` | 200 `{"status":"ok","database":{"connected":true,"replicaSet":"rs0"}}` |
| `npm run db:dev` | replica set `rs0` on 127.0.0.1:27017 |
| `npm run seed` (repeat) | exit 0; all three fundings "already applied", balances unchanged |
| README §13 walkthrough (PowerShell) | login; `/me`; transfer 201; same key 200 `idempotentReplay: true`; same key + other amount 409 `IDEMPOTENCY_KEY_REUSED`; overdraft 422 `INSUFFICIENT_FUNDS`; other user's source 403 `SOURCE_WALLET_NOT_OWNED`; other user's wallet 404; no token 401; balance; history (page 1 of 2); detail |
| Registration walkthrough | register 201; wallet 201 balance 0; second wallet 409; duplicate email 409; wrong password 401; logout then reuse token 401 `INVALID_TOKEN` (revoked) |
| `npm run fund -- --email … --amount 250.50 --key …` | exit 0, ₹250.50 funded |
| `npm run wallet:status … FROZEN`, transfer to that wallet, then `… ACTIVE` | 422 `WALLET_FROZEN` (`toAccount`), then unfrozen |
| `npm run reconcile` / `-- --json` / with `NODE_ENV=production` | PASS, exit 0 in all three |
| `npm run perf` (10 connections × 10 s, `--json`) | exit 0; results in `docs/perf-results/2026-11-24-run4-ac-power.json` |
| `npm run perf -- --connections 5 --duration 3` (smoke run before the changes) | exit 0, correctness PASS (numbers not recorded as a result) |
| `npm audit fix` | runtime advisories fixed (see §6); `npm audit --omit=dev`: 0 vulnerabilities |
| `grep` for `TODO\|FIXME\|XXX\|HACK\|stub\|not implemented` in `src scripts tests .github` | no matches |
| `git ls-files` / `git check-ignore` | `.env`, `.data/`, `.vscode/` ignored and untracked |
| `winget show` for the README package ids | `OpenJS.NodeJS.22`, `Git.Git`, `MongoDB.Server` (8.0.23 available), `MongoDB.Shell` exist; installs not executed |

## 3. Tests implemented

251 tests in 14 files. Every money-moving test ends with
`expectBooksBalanced()` (`tests/helpers/invariants.js`): it checks
transaction and ledger counts, Σ debits = Σ credits, Σ balances = 0, and that
`reconcile()` returns PASS.

| File | Tests | What it covers |
|---|---|---|
| `app.test.js` | 9 | `/health` ok and 503 when the DB is down; JSON 404; malformed JSON 400; 413; **415 for an unsupported charset or encoding (new)**; request-id echo and sanitizing |
| `config.test.js` | 7 | config validation incl. **placeholder secret and `JWT_EXPIRES_IN` (new)**; refuses a standalone MongoDB |
| `auth.test.js` | 24 | register (normalization, duplicate incl. concurrent, validation, operator injection, 72-byte limit); login (case-insensitive, wrong password, unknown email same response); token checks (missing, non-Bearer, cookie ignored, garbage, wrong secret, `alg: none`, expired, deleted user); logout (hash stored, other sessions unaffected, requires auth) |
| `wallet.test.js` | 14 | create (ACTIVE, INR, 0; client fields ignored); duplicate and concurrent creation → one wallet; frozen still counts; owner-only reads (404 for others, 400 malformed); system account hidden |
| `models.test.js` | 22 | schema rules and unique indexes; ledger immutability on every update/delete path; **`ensureIndexes()` creates missing indexes and never drops unknown ones (new)** |
| `money.test.js` | 36 | `isValidAmount`, `parseRupees`, `formatPaise` |
| `funding.test.js` | 22 | funding is balanced; same key no-op; different payload 409; frozen and unknown wallet; concurrent fundings; seed twice; **dev scripts refuse non-development `NODE_ENV` (production, staging, prod) and non-local databases; local-host detection (new)** |
| `transfer.test.js` | 29 | success incl. full balance; every rejection (insufficient, invalid amounts, self, missing destination, system account as destination, non-owned or unknown source 403, no wallet, frozen source/destination, balance cap, auth); **injected failures roll everything back**; key reusable after a failed attempt |
| `idempotency.test.js` | 14 | replay; replay after balance change; per-user scope; no cross-user read via key; rejected request doesn't consume the key; **uncertain commit both ways** (committed → retry replays; not committed → retry executes once) |
| `transaction-retry.test.js` | 8 | `runInTransaction`: transient retry, exhaustion → 503 with nothing written, no retry of AppErrors or unlabelled errors, commit-unknown re-sends only the commit, bounded commits, a real WriteConflict |
| `concurrency.test.js` | 11 | 2×₹1000 from ₹1500 → exactly one; 10×; 25×₹10 from ₹100 → exactly 10; one-to-many; many-to-one; criss-cross; 10 identical keys → one transfer; same key with different amounts → one; reconcile during 30 in-flight transfers; freeze during transfers; retry exhaustion → 503s apply nothing and are safe to retry |
| `history.test.js` | 18 | ordering, pagination boundaries, direction, per-user visibility, no personal data, detail 404s, idempotency key only for the sender |
| `reconciliation.test.js` | 26 | clean PASS with exact totals; empty DB; **17 kinds of corruption** each detected with the exact check codes (incl. **unknown transaction and entry types (new)**); read-only on FAIL; CLI exit 0/1/2, `--json`, allowed in production, **creates and drops no indexes (new)** |
| `observability.test.js` | 11 | log fields; no query strings; no password, token, secret, bcrypt hash or email in any log line; redaction; 500 hides internals; 503 logged as a warning; retry logging; `LOG_LEVEL` |

### Tests that failed

* **Final run:** 0 failed.
* **During M13:** after `npm audit fix` upgraded the MongoDB driver to
  7.9.1, every database test failed with `MongooseServerSelectionError:
  Missing required sub-document 'driver' in the client metadata document`
  (80 of 86 in the affected files). Cause: driver 7.9 loads Node's `os` module
  with a dynamic `import()`, which Jest's VM sandbox rejects, so the
  handshake metadata was empty. The app outside Jest was unaffected
  (`npm run reconcile` worked). Fix: `connectToDB` passes the driver's
  documented `runtimeAdapters: { os }` option. All tests passed afterwards.
* **During M8–M11:** on battery power, one full run had 4 timing
  failures (spawned scripts and heavy-contention tests hitting timeouts or
  503s); the money invariants held. The tests were hardened in commit 79f84db
  without weakening any invariant.

### Mutation checks (do the tests detect real bugs?)

| Mutation | Result |
|---|---|
| Remove both balance guards (`$gte` filter and the funds check) | the 3 double-spend tests fail (M6) |
| Debit `updateOne` without `{ session }` | the "failure AFTER the source was debited" atomicity test fails (M5) |
| Make the idempotency index non-unique (M13) | **only** the model test for the unique index fails. Concurrent duplicate transfers are *also* serialized by the write conflict on the shared source wallet, so the index is defence in depth, not the only guard. |

## 4. Audit

A separate read-only review pass re-examined the code without relying on
the test results. It checked: ownership and authorization; atomicity;
overdraft prevention; idempotency under concurrent duplicates; uncertain
commits; bounded retries; reconciliation; authentication; error handling and
data exposure; remaining races.

**Confirmed correct (traced):** every account, history and detail query is
scoped by `req.user._id`; all money writes happen inside one snapshot
transaction with majority commit, and any throw aborts all of them; every
decision is backed by a document the transaction writes or by a unique index
(no write skew); concurrent duplicate keys resolve to one transfer; commit
retries can't double-apply, and a same-key retry after a 503 replays or
executes once; retries are bounded (attempts 1–20, commits ≤ 3, 1 s backoff
cap) and the session is always ended; JWT is pinned to HS256 with expiry,
hashed revocation and deleted-user handling; login timing doesn't reveal
emails; inputs are type-checked; stacks are never sent to clients.

| Finding (severity) | Action |
|---|---|
| `connectToDB` ran `syncIndexes()`, which **drops** undeclared indexes, including when the "read-only" reconcile CLI connected (medium) | Fixed: `ensureIndexes()` only creates; reconcile creates nothing; tests added |
| Unsupported body charset/encoding → 500 with a stack log (low) | Fixed: 415 `UNSUPPORTED_MEDIA_TYPE`; tests added |
| Perf correctness check compared totals only (low) | Fixed: key-by-key check; run 4 recorded with it |
| Dev-script production guard was an exact string match (low) | Fixed: only `development`/`test`, and only a local `MONGO_URI`; tests added |
| Reconcile ignored unknown `type` values (low) | Fixed: `INVALID_TYPE`; tests added |
| Transfer reveals whether a destination wallet is frozen (low) | Accepted and documented (ARCHITECTURE §10): any sender with 1 paise could probe anyway, and payers need the reason |
| Stale "default 5" comment; `JWT_EXPIRES_IN` unvalidated (info) | Fixed |
| Concurrent reads on one snapshot session (plausible) | Changed to sequential reads |
| `fundWallet` has no duplicate-key fallback; a frozen SYSTEM_FUNDING account would report `INSUFFICIENT_FUNDS`; an unlabelled commit error gives 500 although the commit may have applied (info) | Not changed: practically unreachable (there's no way to freeze the system account; a same-key retry still replays). Listed here |

**Benchmark 503s:** the review traced them to `runInTransaction` running
out of attempts on `WriteConflict` (transaction aborted, nothing applied). The
run-4 server log confirms it: 4 × `txn.retry_exhausted`, all `reason:
"WriteConflict"`, none `txn.commit_outcome_unknown`. The key-by-key check
found 0 of the 503 keys stored. **Conclusion: safe retry-exhaustion
responses, not hidden bugs.** They cost availability under extreme
single-wallet contention (0.47–2.13% of requests in that scenario).

Found during the final verification itself: Express 5 calls the `listen`
callback on failure too, so a port conflict logged `server.started` before
`server.listen_failed`. Fixed in 0fc167c and verified manually.

## 5. Requirement matrix

**VERIFIED** = executed and observed in this project (automated test and/or
manual run). **IMPLEMENTED BUT UNVERIFIED** = code or docs exist but haven't
been run here.

| Area | Requirement | Status | Evidence |
|---|---|---|---|
| A1 | Registration: validation, normalized email, DB-unique, hashed, no hash in responses, clear errors | VERIFIED | auth.test.js; manual |
| A2 | Login with JWT; invalid credentials; expired/invalid tokens; nothing sensitive logged | VERIFIED | auth.test.js, observability.test.js; manual |
| A3 | Current-user profile | VERIFIED | `GET /api/auth/me` test + manual |
| A4 | All wallet/transaction routes authenticated; ownership from the JWT | VERIFIED | 401/403/404 tests; manual 403/404 |
| B1 | One INR wallet per user, DB-enforced | VERIFIED | unique index; concurrent-create test; manual 409 |
| B2 | View wallet id, currency, balance, status, createdAt | VERIFIED | wallet.test.js; manual |
| B3 | Integer paise; reject fractions, unsafe, negative, over-limit | VERIFIED | money.test.js, transfer.test.js |
| B4 | ACTIVE/FROZEN; frozen can't send or receive; no public freeze endpoint | VERIFIED | transfer tests; manual freeze script |
| B5 | Safe, repeat-safe, balanced dev funding via SYSTEM_FUNDING; no public money API | VERIFIED | funding.test.js; seed twice; script guard tests |
| C | Double entry: 1 record + 2 entries per transfer, balanced, immutable, balances = ledger, no floats | VERIFIED | every money test + reconcile; models.test.js |
| D | Atomic transfer with all validation rules; session handling; no slow work in transactions | VERIFIED | transfer.test.js incl. injected failures |
| E | Concurrency: no double spend, no lost updates, retries only when safe; 5 mandatory scenarios | VERIFIED | concurrency.test.js (DB invariants); mutation check |
| F | Idempotency: replay, conflict on different payload, concurrent duplicates, per-user scope, DB uniqueness, failure semantics documented | VERIFIED | idempotency.test.js, concurrency.test.js; ARCHITECTURE §6 |
| G | History: own transactions only, fields, pagination, newest first, no PII | VERIFIED | history.test.js; manual |
| H | Reconciliation CLI: all checks, required output, non-zero exit on FAIL, never modifies, detects corrupted data | VERIFIED | reconciliation.test.js; manual PASS |
| I | Central JSON errors with correct statuses; no stacks to clients; structured logs with required fields; no secrets; health endpoint | VERIFIED | app.test.js, observability.test.js; manual |
| J | Jest + Supertest on a real replica set, all required categories, deterministic, DB state verified, `npm test` works | VERIFIED | 251 tests; §3 |
| K | GitHub Actions: checkout, Node from `.nvmrc`, `npm ci`, replica-set-capable MongoDB, `npm test`, fails on failure, no secrets needed | **IMPLEMENTED BUT UNVERIFIED** | workflow parsed; simulated locally on Windows (`npm ci` + `npm test` on a clean export with no `.env`); has never run on GitHub |
| L | Bounded, reproducible perf test with throughput, avg, p95, error rate; real results and conditions | VERIFIED | docs/PERFORMANCE.md; 4 runs with raw JSON |
| Docs | README, ARCHITECTURE, TEST_REPORT, PERFORMANCE, CONTRIBUTING.md | VERIFIED (content) | commands in README §7, §9–16 executed; see exceptions below |
| Docs | README §6 winget installs, §8 Option B (MongoDB service + `rs.initiate`) | **IMPLEMENTED BUT UNVERIFIED** | package ids checked with `winget show`; installs not executed |
| Ops | Graceful shutdown on Ctrl+C (SIGINT) | **IMPLEMENTED BUT UNVERIFIED** | code reviewed; a Windows Ctrl+C was not sent to the server during final verification |
| Scope | No frontend, microservices, Kafka, Redis, Docker, gateways, e-mail, admin UI | VERIFIED | dependency list; code layout |

Nothing is NOT IMPLEMENTED or BLOCKED.

## 6. Unverified behaviour and environment limitations

* **CI on GitHub** has not run. `origin` is the upstream author's repository,
  and nothing was pushed. It will run on the first push to a repository you
  own; until then, treat it as unverified.
* **Linux:** all execution was on Windows. CI targets ubuntu-24.04.
* **Multi-node replica sets** (failover, replication lag, majority commit
  latency across nodes) were not tested; everything ran on one node.
* **MongoDB Community Server installation** (README §8 Option B) wasn't
  executed; the verified path is `npm run db:dev`.
* **Timing on this laptop varies a lot** (full suite 49–385 s; benchmark
  throughput 3–4× higher on AC power than on battery). The timing-sensitive
  tests accept and retry 503s instead of loosening invariants.
* **Dependencies:** `npm audit fix` updated mongoose 9.1.5 → 9.13.0,
  body-parser 2.2.2 → 2.4.0, path-to-regexp 8.3.0 → 8.4.2 and proxy-addr
  2.0.7 → 2.0.8 within the existing semver ranges (no package.json changes).
  Runtime audit: 0 vulnerabilities. Remaining: moderate advisories in
  `glob`/`minimatch`, which are development-only dependencies of Jest and
  nodemon. The `--force` fix would downgrade Jest, so it was not applied.
* **Development database contents:** it holds the demo users, manual-test
  users (`dana-*@example.com`) and benchmark users (`perf-*@example.test`).
  Delete the `.data` folder (with `db:dev` stopped) to start clean.

## 7. Reconciliation result (development database, final)

```
Wallets checked:       85
Accounts checked:      86 (wallets + system funding account)
Transactions checked:  4693
Ledger entries:        9386
Total debit:           ₹8019048.78 (801904878 paise)
Total credit:          ₹8019048.78 (801904878 paise)
Total funded:          ₹8017752.75
Inconsistencies:       0
Result:                PASS        (exit code 0)
```

This database has absorbed four benchmark runs (including 503s and
phase-end cut-offs), many manual transfers, a freeze and unfreeze, and
funding runs.

## 8. Performance results

See [PERFORMANCE.md](PERFORMANCE.md). Summary at 10 connections × 10 s per
scenario:

| Scenario | Runs 1–3 (battery, busy CPU) | Run 4 (AC power) |
|---|---|---|
| GET balance | 89.5–116.3 req/s, p95 192–289 ms, 0% errors | 368.4 req/s, p95 44 ms, 0% |
| Transfer, disjoint pairs | 37.0–56.9 req/s, p95 492–606 ms, 0% | 161.0 req/s, p95 105 ms, 0% |
| Transfer, one hot wallet | 13.9–24.0 req/s, p95 2.1–2.9 s, 0–2.13% (503s) | 63.7 req/s, p95 718 ms, 0.47% (503s) |

Correctness held after every run (reconciliation PASS; in run 4, no
acknowledged transfer missing and no 503 stored). These numbers describe one
laptop, not capacity.
