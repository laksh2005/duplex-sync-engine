const { fetchSheet, toRowObjects, writeRowsToSheet } = require('./sheetService')
const {
  initSchema,
  ensureColumnsForHeaders,
  getAllRows,
  upsertRows,
  deleteRow,
  writeSyncLog,
  writeConflictLog,
  getMetadata,
  setMetadata
} = require('./dbService')
const { resolveConflict } = require('./conflictResolver')
const { broadcastStatus, broadcastSyncEvent, broadcastConflictEvent } = require('../websocket')
const { logError } = require('../utils/logger')
const { getDynamicColumns, sanitizeColumnName } = require('../utils/columns')

let syncing = false
let scheduled = false

function scheduleSync(reason) {
  if (scheduled) {
    return
  }
  scheduled = true
  setTimeout(() => {
    runSync(reason).catch(logError)
  }, 200)
}

async function startSyncLoop() {
  await initSchema()
}

async function runSync(reason) {
  if (syncing) {
    scheduled = true
    return
  }
  syncing = true
  scheduled = false
  broadcastStatus({ status: 'syncing', reason })
  try {
    const lastSync = await getMetadata('last_sync_time')
    let lastSyncedIds = null
    try {
      const syncedIdsRaw = await getMetadata('synced_row_ids')
      if (syncedIdsRaw) {
        const arr = JSON.parse(syncedIdsRaw)
        lastSyncedIds = Array.isArray(arr) ? new Set(arr) : null
      }
    } catch (_) {
      lastSyncedIds = null
    }
    const { headers, rows: sheetRowsRaw } = await fetchSheet()
    if (!headers || !headers.length) {
      broadcastStatus({ status: 'idle', lastSyncTime: await getMetadata('last_sync_time') })
      return
    }
    await ensureColumnsForHeaders(headers)
    const sheetRows = toRowObjects(headers, sheetRowsRaw)
    const dbRows = await getAllRows()
    const dbById = dbRows.reduce((acc, row) => {
      acc[String(row.id)] = row
      return acc
    }, {})
    const sheetById = sheetRows.reduce((acc, row) => {
      acc[String(row.id)] = row
      return acc
    }, {})
    const allIds = new Set([...Object.keys(dbById), ...Object.keys(sheetById)])
    const upserts = []
    const idsToDeleteFromDb = []
    const finalRowsForSheet = []
    const dynamicColumns = getDynamicColumns(headers)
    const headerKeys = ['id', 'updated_at', 'deleted', ...dynamicColumns.map(c => c.header)]
    allIds.forEach(id => {
      const sheetRow = sheetById[id]
      const dbRow = dbById[id]
      if (sheetRow && !dbRow) {
        // Row in sheet but not in DB: either new in sheet, or deleted from DB
        if (lastSyncedIds && lastSyncedIds.has(id)) {
          // Was synced before → user deleted from DB → remove from sheet (don't add to finalRowsForSheet)
          writeSyncLog({ row_id: id, source: 'db', action: 'delete', status: 'success', message: null })
          broadcastSyncEvent({ id, source: 'db', action: 'delete' })
          return
        }
        upserts.push(sheetRow)
        writeSyncLog({ row_id: id, source: 'sheet', action: 'insert', status: 'success', message: null })
        broadcastSyncEvent({ id, source: 'sheet', action: 'insert' })
        finalRowsForSheet.push(sheetRow)
        return
      }
      if (!sheetRow && dbRow) {
        if (dbRow.deleted) {
          writeSyncLog({ row_id: id, source: 'db', action: 'delete', status: 'success', message: null })
          broadcastSyncEvent({ id, source: 'db', action: 'delete' })
          return
        }
        if (lastSyncedIds && lastSyncedIds.has(id)) {
          // Was synced before but now only in DB → user deleted from sheet → delete from DB
          idsToDeleteFromDb.push(id)
          writeSyncLog({ row_id: id, source: 'sheet', action: 'delete', status: 'success', message: null })
          broadcastSyncEvent({ id, source: 'sheet', action: 'delete' })
          return
        }
        finalRowsForSheet.push(dbRow)
        writeSyncLog({ row_id: id, source: 'db', action: 'insert', status: 'success', message: null })
        broadcastSyncEvent({ id, source: 'db', action: 'insert' })
        upserts.push(dbRow)
        return
      }
      if (sheetRow && dbRow) {
        if (sheetRow.checksum === dbRow.checksum) {
          finalRowsForSheet.push(dbRow)
          return
        }
        const resolution = resolveConflict(sheetRow, dbRow)
        const resolved = resolution.resolved
        const winner = resolution.winner
        writeConflictLog({
          row_id: id,
          sheet_updated_at: resolution.sheetUpdated,
          db_updated_at: resolution.dbUpdated,
          winner,
          details: null
        })
        broadcastConflictEvent({
          id,
          sheet_updated_at: resolution.sheetUpdated,
          db_updated_at: resolution.dbUpdated,
          winner
        })
        writeSyncLog({
          row_id: id,
          source: winner,
          action: 'update',
          status: 'success',
          message: null
        })
        broadcastSyncEvent({ id, source: winner, action: 'update' })
        upserts.push(resolved)
        finalRowsForSheet.push(resolved)
      }
    })
    for (const id of idsToDeleteFromDb) {
      await deleteRow(id)
    }
    if (upserts.length) {
      await upsertRows(upserts)
    }
    const headersForSheet = headerKeys
    await writeRowsToSheet(headersForSheet, finalRowsForSheet)
    const now = new Date().toISOString()
    await setMetadata('last_sync_time', now)
    await setMetadata('synced_row_ids', JSON.stringify(finalRowsForSheet.map(r => r.id)))
    broadcastStatus({ status: 'idle', lastSyncTime: now })
  } catch (err) {
    logError(err)
    broadcastStatus({ status: 'error' })
  } finally {
    syncing = false
    if (scheduled) {
      scheduled = false
      runSync('queued').catch(logError)
    }
  }
}

async function forceSync() {
  scheduleSync('manual')
}

module.exports = {
  startSyncLoop,
  forceSync
}

