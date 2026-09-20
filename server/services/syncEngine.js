const EventEmitter = require('events')
const { fetchSheet, toRowObjects, writeRowsToSheet } = require('./sheetService')
const {
  initSchema,
  ensureColumnsForHeaders,
  getAllRows,
  upsertRows,
  deleteRows,
  writeSyncLogs,
  writeConflictLogs,
  getMetadata,
  setMetadata
} = require('./dbService')
const { computeSyncPlan } = require('./syncPlanner')
const { broadcastStatus, broadcastSyncEvent, broadcastConflictEvent } = require('../websocket')
const { logError } = require('../utils/logger')
const { getDynamicColumns } = require('../utils/columns')

const LAST_SYNC_KEY = 'last_sync_time'
const SYNCED_IDS_KEY = 'synced_row_ids'

// Lets the DB change detector re-baseline after a sync, so the writes a sync
// makes are never mistaken for a user edit and re-trigger another sync.
const syncEvents = new EventEmitter()

async function initSyncEngine() {
  await initSchema()
}

async function readLastSyncedIds() {
  try {
    const raw = await getMetadata(SYNCED_IDS_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : null
  } catch (err) {
    logError(err)
    return null
  }
}

/**
 * Runs one full sync pass: read both sides, plan the diff, apply it, persist
 * the logs. Returns a summary the caller can turn into metrics. Throws on
 * failure so the queue can retry it.
 */
async function executeSync({ reason = 'manual', changedAt = null } = {}) {
  const startedAt = Date.now()
  broadcastStatus({ status: 'syncing', reason })

  const lastSyncedIds = await readLastSyncedIds()
  const { headers, rows: rawSheetRows } = await fetchSheet()

  if (!headers || !headers.length) {
    const lastSyncTime = await getMetadata(LAST_SYNC_KEY)
    broadcastStatus({ status: 'idle', lastSyncTime })
    const skipped = { skipped: true, reason: 'empty_sheet', durationMs: Date.now() - startedAt }
    syncEvents.emit('completed', skipped)
    return skipped
  }

  await ensureColumnsForHeaders(headers)

  const sheetRows = toRowObjects(headers, rawSheetRows)
  const dbRows = await getAllRows()
  const plan = computeSyncPlan({ sheetRows, dbRows, lastSyncedIds })

  if (plan.deleteFromDb.length) {
    await deleteRows(plan.deleteFromDb)
  }
  if (plan.upserts.length) {
    await upsertRows(plan.upserts)
  }

  const sheetHeaders = ['id', 'updated_at', 'deleted', ...getDynamicColumns(headers).map(c => c.header)]
  await writeRowsToSheet(sheetHeaders, plan.sheetRows)

  await writeSyncLogs(plan.events.map(event => ({ ...event, status: 'success', message: null })))
  await writeConflictLogs(plan.conflicts)

  plan.events.forEach(event => broadcastSyncEvent({ id: event.row_id, source: event.source, action: event.action }))
  plan.conflicts.forEach(conflict => broadcastConflictEvent({ id: conflict.row_id, ...conflict }))

  const finishedAt = Date.now()
  const lastSyncTime = new Date(finishedAt).toISOString()
  await setMetadata(LAST_SYNC_KEY, lastSyncTime)
  await setMetadata(SYNCED_IDS_KEY, JSON.stringify(plan.sheetRows.map(row => String(row.id))))

  const durationMs = finishedAt - startedAt
  const rowsProcessed = plan.sheetRows.length + plan.deleteFromDb.length

  broadcastStatus({ status: 'idle', lastSyncTime })

  const result = {
    skipped: false,
    reason,
    stats: plan.stats,
    rowsProcessed,
    rowsWritten: plan.upserts.length,
    durationMs,
    // How long it took from the originating edit to the sync landing, which is
    // the number that actually matters for "is this real time".
    latencyMs: changedAt ? finishedAt - Number(changedAt) : null,
    lastSyncTime
  }

  syncEvents.emit('completed', result)
  return result
}

module.exports = {
  initSyncEngine,
  executeSync,
  syncEvents,
  LAST_SYNC_KEY,
  SYNCED_IDS_KEY
}
