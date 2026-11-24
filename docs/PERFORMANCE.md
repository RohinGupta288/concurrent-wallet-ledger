# Performance test results

These are measured numbers from `npm run perf` (`scripts/perf.js`). The raw
output of every run is in [`perf-results/`](perf-results/). Nothing here was
estimated or extrapolated.

**Read these as "how this code behaves on one busy laptop", not as a capacity
figure.** The server, MongoDB and the load generator all ran on the same
machine, which was on battery and running other applications.

## How the test works

1. The real server (`src/server.js`) starts as a **separate process** on a
   free local port, so the load generator does not share its CPU thread.
2. 20 disposable users (`perf-<runId>-N@example.test`) register through the
   API, create wallets and are funded through the normal funding service.
3. Each scenario runs autocannon with a **2 s warm-up (not measured)**, then
   **10 concurrent connections for 10 s**.
4. Every single response time is recorded. Average, p50, p95 and p99 are
   computed from those values (nearest-rank percentiles).
5. Afterwards the script checks correctness:
   - every acknowledged (201) transfer is stored;
   - the only extra stored transfers are the in-flight requests the load
     generator dropped when a phase's time ran out (at most 1 per connection
     per transfer phase, so at most 40 here);
   - `reconcile()` must PASS.

   It exits 1 if any check fails.

Safety limits: it refuses `NODE_ENV=production` and any non-local `MONGO_URI`,
and caps runs at 50 connections and 60 s per scenario.

| Scenario | What it measures |
|---|---|
| GET balance (own wallet) | Authenticated read: JWT check, revocation lookup, user lookup, wallet lookup |
| POST transfer, 10 disjoint wallet pairs | Transfers where users 0–9 pay users 10–19, so concurrent requests rarely touch the same wallet |
| POST transfer, one hot sender wallet | Every transfer debits the **same** wallet: worst-case write contention, handled by bounded retries |

Amounts are 1 paise and every request uses a new idempotency key, so each
request is a real transfer.

## Test conditions (2026-11-24)

| | |
|---|---|
| Machine | Laptop, 12th Gen Intel Core i7-1260P (16 logical cores), 15.7 GB RAM (1.9–2.6 GB free during runs) |
| Power | **On battery** (21% → 19% charge across the runs); CPU 43–54% busy with other applications before each run |
| OS | Windows 11 (NT 10.0.26300), x64 |
| Runtime | Node.js v22.23.5; MongoDB 8.0.32, single-node replica set, started by `npm run db:dev` |
| Server settings | `LOG_LEVEL=warn` (per-request info logs off), `TXN_MAX_ATTEMPTS=10`, transactions use snapshot reads and majority writes |
| Load | 10 connections, 10 s per scenario after a 2 s warm-up; 20 users |

## Results

### Run 1: database data folder outside OneDrive

| Scenario | Requests | Throughput | Avg | p50 | p95 | p99 | Max | Error rate | Status codes |
|---|---|---|---|---|---|---|---|---|---|
| GET balance | 895 | 89.5 req/s | 111.59 ms | 79.73 ms | 289.29 ms | 495.91 ms | 552.25 ms | 0% | 200 × 895 |
| Transfer, disjoint pairs | 370 | 37.0 req/s | 268.09 ms | 205.20 ms | 606.40 ms | 998.71 ms | 1134.00 ms | 0% | 201 × 370 |
| Transfer, one hot wallet | 141 | 14.1 req/s | 651.63 ms | 264.69 ms | 2911.10 ms | 3662.15 ms | 3941.03 ms | 2.13% | 201 × 138, 503 × 3 |

Correctness: 598 transfers acknowledged, 635 stored (37 cut off at phase ends, limit 40), reconciliation **PASS**.

### Run 2: same setup, repeated

| Scenario | Requests | Throughput | Avg | p50 | p95 | p99 | Max | Error rate | Status codes |
|---|---|---|---|---|---|---|---|---|---|
| GET balance | 961 | 96.1 req/s | 104.03 ms | 80.17 ms | 258.27 ms | 306.99 ms | 473.41 ms | 0% | 200 × 961 |
| Transfer, disjoint pairs | 409 | 40.9 req/s | 246.17 ms | 180.88 ms | 523.08 ms | 802.39 ms | 1122.10 ms | 0% | 201 × 409 |
| Transfer, one hot wallet | 139 | 13.9 req/s | 630.99 ms | 203.72 ms | 2672.50 ms | 4787.73 ms | 4980.20 ms | 0% | 201 × 139 |

Correctness: 651 acknowledged, 690 stored (39 cut off, limit 40), reconciliation **PASS**.

### Run 3: database data folder inside the OneDrive-synced project folder

| Scenario | Requests | Throughput | Avg | p50 | p95 | p99 | Max | Error rate | Status codes |
|---|---|---|---|---|---|---|---|---|---|
| GET balance | 1163 | 116.3 req/s | 86.20 ms | 68.73 ms | 191.88 ms | 345.80 ms | 467.48 ms | 0% | 200 × 1163 |
| Transfer, disjoint pairs | 569 | 56.9 req/s | 174.77 ms | 107.95 ms | 491.60 ms | 654.64 ms | 708.44 ms | 0% | 201 × 569 |
| Transfer, one hot wallet | 240 | 24.0 req/s | 389.11 ms | 81.27 ms | 2092.68 ms | 3704.71 ms | 3957.77 ms | 0.83% | 201 × 238, 503 × 2 |

Correctness: 917 acknowledged, 954 stored (37 cut off, limit 40), reconciliation **PASS**.

There were no connection errors and no timeouts in any run.

## What the numbers show

- **Correctness held under load.** In all three runs no acknowledged transfer
  was missing and reconciliation passed: no money was created or lost and no
  wallet went negative.
- **Contention costs latency, not correctness.** With every transfer hitting
  one wallet, the median stays in the same range as the disjoint-pairs case
  (81–265 ms vs 108–205 ms), but p95 rises to about 2.1–2.9 s. Conflicting transactions back off and retry, and
  each retry waits up to 1 s. A few requests (0.83–2.13%) used all 10
  attempts and got **503 `TRANSACTION_RETRY_EXHAUSTED`**. Those applied
  nothing, and a client can retry them with the same idempotency key (see
  `tests/concurrency.test.js`).
- **Run-to-run variance is large on this machine.** Throughput for the same
  scenario differed by up to about 54% between runs (37.0 vs 56.9 req/s for
  disjoint transfers). Run 3, with the data folder inside OneDrive, was the
  *fastest*, so these runs do **not** show a measurable effect of the data
  folder's location. The likely cause of the variance is the laptop itself
  (battery power, background CPU load), but that was not isolated.

## Limitations

- One machine, on battery, with background applications; nothing was
  isolated or pinned. Expect very different numbers on a desktop, a server or
  CI hardware.
- The latencies have not been profiled, so where the time goes is unknown.
  Plausible contributors include about 10 database round trips per transfer
  (authentication, idempotency check, 2 wallet reads, 3 inserts, 2
  conditional updates, commit) and the journaled majority commit. These are
  hypotheses, not findings.
- Short runs (10 s per scenario) at a single concurrency level (10
  connections); no soak test, no ramp.
- Single-node replica set; a multi-node replica set adds replication latency
  to majority commits.

## Reproducing

```powershell
npm run db:dev                       # terminal 1: local replica set
npm run perf                         # terminal 2: 10 connections x 10 s per scenario
npm run perf -- --connections 20 --duration 30 --json > my-run.json
```
