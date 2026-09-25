# Parity

Two-way sync between Google Sheets and MySQL, keeping both sides identical. Edit either side and both converge, automatically, within about a second.

Sheet edits push over a webhook, database edits are picked up by a change detector, and every sync runs through a Redis-backed queue that batches bursts, retries failures and keeps exactly one sync in flight at a time.

```
Google Sheet                                              MySQL
     |                                                      |
     | onEdit (Apps Script)                    change poller |
     v                                                      v
  POST /api/webhook/sheet  ----> [ BullMQ queue ] <----------
                                        |
                                   sync worker
                                        |
                          read both sides, plan the diff,
                           apply it, write both sides back
                                        |
                                  WebSocket /ws
                                        |
                                  React dashboard
```

## What it does

- **Automatic, both directions.** An installable Apps Script `onEdit` trigger posts to the server the moment a cell changes. The database side is polled with a cheap fingerprint query. Neither side needs a human to press anything.
- **Bursts collapse into one sync.** Pasting 500 rows fires many triggers; they dedupe into a single sync rather than 500 of them.
- **Survives failure.** Jobs retry five times with exponential backoff. A trigger arriving mid-sync is never dropped.
- **Flexible schema.** The first sheet row is headers. You need an `id` column. Every other column is created in MySQL automatically, including ones added later.
- **Conflicts resolved and logged.** When a row changes on both sides, the newer `updated_at` wins. Ties go to the database. Every conflict is written to `conflict_logs` and broadcast live.
- **Measured.** Edit-to-sync latency and rows per second are recorded for every run and exposed at `/api/metrics`.

## Measured performance

From `npm run loadtest` and the end-to-end suite, on a single container running MySQL 8, Redis 7 and Node 22:

| Workload | Result |
| --- | --- |
| Plan and write 10,000 new rows | 0.27s (about 37,000 rows/sec) |
| Plan and write 50,000 new rows | 0.96s (about 52,000 rows/sec) |
| Diff 50,000 rows (planner only) | 0.03s |
| Edit-to-sync latency, default settings | about 830ms p50 |
| Edit-to-sync latency, `SYNC_DEBOUNCE_MS=50` | about 130ms p50 |
| Sync duration, small sheet | about 10ms |

Latency is dominated by the debounce window, which is the deliberate tradeoff that lets a burst of edits collapse into one sync. Lower `SYNC_DEBOUNCE_MS` for faster reaction, raise it to do less work under heavy editing.

Reproduce with:

```bash
cd server
npm run loadtest -- --rows 50000
```

## Quick start

### Docker, everything at once

```bash
cp server/.env.example server/.env    # fill in the Google Sheets values
docker compose up --build
```

Dashboard on http://localhost:8080, API on http://localhost:4000/api/health.

This brings up MySQL, Redis, the API, a dedicated sync worker and nginx serving the dashboard.

### Running it directly

```bash
cd server && npm install && cp .env.example .env    # then fill it in
npm start                                           # API plus inline worker

cd ../client && npm install && npm run dev
```

Redis is optional. Without `REDIS_URL` the server falls back to an in-process runner that coalesces triggers the same way, which is enough for local development.

### Full local walkthrough, no Docker (Windows)

The order that actually works end to end, running MySQL and Redis directly instead of in containers.

1. **MySQL.** Install MySQL 8 (MySQL Installer, Server component). Set a root password during setup. Then create the database:
   ```sql
   CREATE DATABASE parity;
   ```
   Everything else (tables, columns) is created automatically on first run.

2. **Redis, via WSL.** Windows has no native Redis build, so install it inside WSL:
   ```powershell
   wsl --install
   ```
   Then inside the Ubuntu shell it opens:
   ```bash
   sudo apt update && sudo apt install -y redis-server
   sudo service redis-server start
   redis-cli ping   # expect PONG
   ```
   WSL2 shares `localhost` with Windows, so `REDIS_URL=redis://localhost:6379` in `.env` just works. Redis does not survive a reboot automatically, run `sudo service redis-server start` again each time.

3. **`server/.env`.** Copy `server/.env.example` to `server/.env` and fill in: your MySQL password, `DB_NAME=parity`, the three `GOOGLE_*` values from your service account's JSON key, `REDIS_URL=redis://localhost:6379`, and a generated `WEBHOOK_SECRET`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

4. **Start the app.**
   ```bash
   cd server && npm install && npm start
   cd client && npm install && npm run dev
   ```
   Open the dashboard, click **Sync Now**, confirm the Sheet and MySQL panels match.

5. **A public tunnel**, so Google can reach your local server for push sync. Either works, no signup needed for the second:
   ```bash
   ngrok http 4000
   # or, with no account at all:
   ssh -R 80:localhost:4000 nokey@localhost.run
   ```
   Copy the `https://...` forwarding URL it prints. It changes every time the tunnel restarts, so this has to be redone whenever that terminal is closed and reopened.

6. **Apps Script**, see "Turning on push sync" below, using the tunnel URL from step 5 as `SYNC_WEBHOOK_URL`.

7. **Verify both directions.** Edit a cell in the Sheet, watch the server terminal log `sheet webhook accepted` then `sync ok` within about a second. Then run an `UPDATE ... SET updated_at = NOW()` against `synced_rows` in MySQL directly, and watch it appear in the Sheet within `DB_POLL_INTERVAL_MS`.

## Google Sheets setup

1. Create a Google Cloud service account, enable the Sheets API, and download a JSON key.
2. Share your sheet with the service account's client email, as an Editor.
3. Put `GOOGLE_SHEET_ID`, `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY` in `server/.env`. Keep the `\n` escapes in the private key exactly as they appear in the JSON.
4. Give the sheet an `id` column. An `updated_at` column is recommended, since conflict resolution uses it.

### Turning on push sync

1. Generate a secret and put it in `server/.env` as `WEBHOOK_SECRET`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. In the sheet, open Extensions > Apps Script and paste in [`server/apps-script/onEdit.gs`](server/apps-script/onEdit.gs).
3. In Project Settings > Script Properties add `SYNC_WEBHOOK_URL` (your server's `/api/webhook/sheet`) and `SYNC_WEBHOOK_SECRET` (the same secret).
4. Run `installTrigger()` once and accept the permission prompt.

It has to be an installable trigger. A plain `onEdit(e)` function runs unauthorized and is not allowed to make outbound requests, so it cannot reach your server. `installTrigger()` creates the right kind.

The server needs to be reachable from Google. For local development, tunnel it with ngrok or similar.

## How a sync works

Every sync is a full reconcile rather than an incremental patch, which keeps it correct even if the server was down while edits happened.

1. Read the sheet and the table.
2. `computeSyncPlan()` decides, per row id, what should happen. It is a pure function, which is why the interesting logic can be tested without either system running.
3. Apply the plan: chunked upserts, batched deletes, one sheet rewrite.
4. Record the logs, the metric and the set of ids that existed after this sync.

That last set is what makes deletes work. A row present in the sheet but absent from the table is new if it was not in the last synced set, and deleted from the database if it was.

| Situation | Result |
| --- | --- |
| Only in sheet, not seen before | Insert into MySQL |
| Only in sheet, was synced before | Deleted in MySQL, so remove from sheet |
| Only in MySQL, not seen before | Add to sheet |
| Only in MySQL, was synced before | Deleted in sheet, so delete from MySQL |
| In both, checksums match | Nothing |
| In both, checksums differ | Newer `updated_at` wins, conflict logged |

Checksums are SHA-256 over the row's content, ignoring `updated_at`, so touching a row without changing it is not treated as an edit.

### Why the queue matters

A sync rewrites the entire sheet, so two running concurrently would race and could resurrect rows the other just deleted. The worker runs at concurrency 1, and every trigger shares a single job id so pending triggers collapse into one.

Deduping alone would lose a trigger that arrives while a sync is already running, so triggers also set a dirty marker in Redis. The worker claims it when the job starts and re-queues on completion if it was set again. No edit is silently dropped.

## Tests

99 tests, 56 unit and 43 integration.

```bash
cd server
npm run test:unit          # no services needed

# integration and end-to-end, needs MySQL and Redis
DB_INTEGRATION=1 REDIS_URL=redis://localhost:6379 npm run test:integration
```

- **Unit** covers the planner across every branch including a 10,000 row case, conflict tie-breaks and unparseable timestamps, checksum stability, header sanitization, and webhook authentication.
- **Integration** runs against real MySQL and Redis: schema, dynamic columns, chunked upserts, transaction rollback, queue dedupe and retry budget.
- **End-to-end** drives the real path from HTTP webhook through the queue, worker, planner, MySQL and back to the sheet, with only the Google Sheets API replaced by an in-memory sheet.

CI runs lint, unit tests, integration tests against service containers, the client build, the load test, and builds both Docker images.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness |
| `GET /api/data/sheet` | Headers and rows from the sheet |
| `GET /api/data/db` | Active rows from MySQL |
| `GET /api/sync/meta` | Last sync time and runner status |
| `POST /api/sync/force` | Queue a sync manually |
| `POST /api/webhook/sheet` | Apps Script edit notification, needs `x-webhook-secret` |
| `GET /api/metrics` | Latency percentiles, throughput, recent runs |
| `GET /api/metrics/activity` | Recent per-row sync log |
| `WS /ws` | Live `status`, `sync_event` and `conflict_event` |

## Configuration

Everything lives in `server/.env`, documented in [`server/.env.example`](server/.env.example). The ones worth knowing:

| Variable | Default | Effect |
| --- | --- | --- |
| `REDIS_URL` | unset | Unset falls back to the in-process runner |
| `SYNC_DEBOUNCE_MS` | `750` | Burst collapsing window, the main latency lever |
| `SYNC_CHUNK_SIZE` | `500` | Rows per INSERT statement |
| `SYNC_JOB_ATTEMPTS` | `5` | Retries before a sync is marked failed |
| `DB_POLL_INTERVAL_MS` | `5000` | Database change check interval, `0` disables |
| `WEBHOOK_SECRET` | unset | Required for push sync, endpoint refuses without it |
| `RUN_WORKER_INLINE` | `1` | Set `0` when running a separate worker process |

## Layout

```
parity/
├── docker-compose.yml          MySQL, Redis, API, worker, dashboard
├── .github/workflows/ci.yml    lint, tests, load test, image builds
├── client/                     Vite + React dashboard, nginx image
└── server/
    ├── apps-script/onEdit.gs   paste into the sheet
    ├── config/                 env, MySQL pool, Google auth, Redis
    ├── queue/                  BullMQ queue, worker, job processor
    ├── services/
    │   ├── syncPlanner.js      pure diff logic, the testable core
    │   ├── syncEngine.js       reads, plans, applies, measures
    │   ├── changeDetector.js   MySQL-side polling
    │   ├── runner.js           queue or in-process, chosen by config
    │   ├── sheetService.js     Google Sheets read and write
    │   └── dbService.js        chunked, batched MySQL access
    ├── scripts/loadtest.js     throughput benchmark
    └── tests/                  unit, integration, end-to-end
```

## Stack

Node.js, Express, BullMQ on Redis, MySQL 8, Google Sheets API, WebSockets, React, Tailwind, Docker Compose, GitHub Actions.
