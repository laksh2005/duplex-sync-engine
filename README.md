# duplex-sync-engine

Two-way sync between Google Sheets and MySQL with a simple dashboard. Change data in either place, tap **Sync Now**, and both stay in sync.

## Features

- **Manual sync** — One button sync. No background polling.
- **Bidirectional** — Insert or delete in the Sheet or in MySQL; after sync both sides match.
- **Flexible schema** — First row of the sheet is headers. You need an `id` (or `row_id`) column; other columns are synced as-is and become MySQL columns automatically.
- **Conflict handling** — When the same row changes in both places, last-write-wins by `updated_at`; conflicts are logged and broadcast over WebSockets.
- **Live dashboard** — React UI shows Sheet and MySQL side-by-side, sync status, last sync time, and recent activity.
- 
## Sync behavior

- **Row only in Sheet** → Insert into MySQL and keep in sheet (or remove from sheet if it was previously deleted in MySQL).
- **Row only in MySQL** → Add to sheet and keep in DB (or delete from DB if it was previously removed from the sheet).
- **Row in both** → If content differs, resolve by `updated_at` (last-write-wins), write winner to both, log conflict.
- **Deleted in one place** → After sync, the row is removed from the other (sheet is cleared and rewritten; DB row is deleted when the row was removed from the sheet).
- The engine tracks which row IDs were present after the last successful sync so it can tell “new row” from “deleted on the other side.”
  
## Stack

- **Backend:** Node.js, Express, Google Sheets API, WebSockets
- **Frontend:** React, Tailwind CSS
- **Database:** MySQL

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
└── README.md
```

## API

- `GET /api/data/sheet` — Headers and rows from the Google Sheet
- `GET /api/data/db` — Active rows from MySQL
- `GET /api/sync/meta` — `lastSyncTime`
- `POST /api/sync/force` — Run a sync (manual)
- WebSocket at `/ws` broadcasts `status` (idle/syncing/error), `sync_event`, and `conflict_event` so the UI can update in real time.
