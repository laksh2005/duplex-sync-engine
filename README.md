# duplex-sync-engine

Two-way sync between Google Sheets and MySQL with a simple dashboard. Change data in either place, tap **Sync Now**, and both stay in sync.

## Features

- **Manual sync** — One button sync. No background polling.
- **Bidirectional** — Insert or delete in the Sheet or in MySQL; after sync both sides match.
- **Flexible schema** — First row of the sheet is headers. You need an `id` (or `row_id`) column; other columns are synced as-is and become MySQL columns automatically.
- **Conflict handling** — When the same row changes in both places, last-write-wins by `updated_at`; conflicts are logged and broadcast over WebSockets.
- **Live dashboard** — React UI shows Sheet and MySQL side-by-side, sync status, last sync time, and recent activity.

## Stack

- **Backend:** Node.js, Express, MySQL (mysql2), Google Sheets API, WebSockets (ws)
- **Frontend:** Vite, React, Tailwind CSS, lucide-react
- **Database:** Tables created on first run (`synced_rows`, `sync_logs`, `conflict_logs`, `metadata`)

## Project structure

```
duplex-sync-engine/
├── client/                 # Vite + React dashboard
│   └── src/
│       ├── App.jsx
│       ├── App.css
│       └── main.jsx
├── server/
│   ├── config/             # DB and Google API config
│   ├── controllers/         # HTTP handlers (data, sync)
│   ├── routes/              # /api/data, /api/sync
│   ├── services/            # sheetService, dbService, syncEngine, conflictResolver
│   ├── websocket/           # WebSocket server (/ws)
│   ├── utils/               # checksum, columns, logger
│   ├── app.js
│   └── server.js
├── docker-compose.yml      # Optional: MySQL
└── README.md
```

## Google Sheet setup

1. First row = headers. Include a column that normalizes to `id` or `row_id` (e.g. "Id", "ID", "row_id").
2. Optional: `updated_at` (ISO date) and `deleted` (1/0). If missing, they are managed by the sync.
3. Share the sheet with the service account email (Editor).
4. Set `GOOGLE_SHEET_ID` and optionally `GOOGLE_SHEET_RANGE` (default `Sheet1`) in server `.env`.

## Environment (server)

Create `server/.env` from the template and set:

- **DB:** `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- **Google:** `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY` (escape newlines as `\n`), `GOOGLE_SHEET_ID`, `GOOGLE_SHEET_RANGE`
- **Server:** `PORT` (default `4000`)

## Run

**Backend**

```bash
cd server
npm install
npm start
```

**Frontend**

```bash
cd client
npm install
npm run dev
```

Open the dashboard (e.g. `http://localhost:5173`). Use **Sync Now** to run a sync; the UI refetches and shows Sheet and MySQL data.

**Optional: MySQL via Docker**

```bash
docker-compose up -d
```

Then point `DB_*` in `server/.env` at the container.

## API

- `GET /api/data/sheet` — Headers and rows from the Google Sheet
- `GET /api/data/db` — Rows from MySQL (active only; no internal columns like `checksum`)
- `GET /api/sync/meta` — `lastSyncTime`
- `POST /api/sync/force` — Run a sync (manual)

WebSocket at `/ws` broadcasts `status` (idle/syncing/error), `sync_event`, and `conflict_event` so the UI can update in real time.

## Sync behavior

- **Row only in Sheet** → Insert into MySQL and keep in sheet (or remove from sheet if it was previously deleted in MySQL).
- **Row only in MySQL** → Add to sheet and keep in DB (or delete from DB if it was previously removed from the sheet).
- **Row in both** → If content differs, resolve by `updated_at` (last-write-wins), write winner to both, log conflict.
- **Deleted in one place** → After sync, the row is removed from the other (sheet is cleared and rewritten; DB row is deleted when the row was removed from the sheet).

The engine tracks which row IDs were present after the last successful sync so it can tell “new row” from “deleted on the other side.”


