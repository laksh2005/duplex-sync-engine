const { resolveConflict } = require('./conflictResolver')

const ACTION = {
  INSERT: 'insert',
  UPDATE: 'update',
  DELETE: 'delete'
}

const SOURCE = {
  SHEET: 'sheet',
  DB: 'db'
}

function indexById(rows) {
  const map = new Map()
  rows.forEach(row => {
    if (row && row.id != null) {
      map.set(String(row.id), row)
    }
  })
  return map
}

// Decides what a single row id needs, given its presence on each side and
// whether the last successful sync knew about it. Returns null when the row
// should simply disappear from both sides.
function planRow(id, sheetRow, dbRow, knownFromLastSync) {
  if (sheetRow && !dbRow) {
    if (knownFromLastSync) {
      // Present last sync, now gone from the DB: the DB side deleted it.
      return { kind: 'drop', event: { row_id: id, source: SOURCE.DB, action: ACTION.DELETE } }
    }
    return {
      kind: 'keep',
      row: sheetRow,
      upsert: true,
      event: { row_id: id, source: SOURCE.SHEET, action: ACTION.INSERT }
    }
  }

  if (!sheetRow && dbRow) {
    if (dbRow.deleted) {
      return { kind: 'drop', event: { row_id: id, source: SOURCE.DB, action: ACTION.DELETE } }
    }
    if (knownFromLastSync) {
      // Present last sync, now gone from the sheet: the sheet side deleted it.
      return {
        kind: 'drop',
        deleteFromDb: true,
        event: { row_id: id, source: SOURCE.SHEET, action: ACTION.DELETE }
      }
    }
    return {
      kind: 'keep',
      row: dbRow,
      upsert: true,
      event: { row_id: id, source: SOURCE.DB, action: ACTION.INSERT }
    }
  }

  if (sheetRow.checksum === dbRow.checksum) {
    return { kind: 'keep', row: dbRow, upsert: false, unchanged: true }
  }

  const resolution = resolveConflict(sheetRow, dbRow)
  return {
    kind: 'keep',
    row: resolution.resolved,
    upsert: true,
    event: { row_id: id, source: resolution.winner, action: ACTION.UPDATE },
    conflict: {
      row_id: id,
      sheet_updated_at: resolution.sheetUpdated,
      db_updated_at: resolution.dbUpdated,
      winner: resolution.winner
    }
  }
}

/**
 * Pure planning step: works out everything a sync needs to do without touching
 * MySQL, Google Sheets or the websocket layer. Everything here is derived from
 * its arguments, which is what makes the sync logic testable in isolation.
 *
 * Sheet rows keep their existing order and DB-only rows are appended by id, so
 * the same inputs always produce the same sheet layout.
 */
function computeSyncPlan({ sheetRows = [], dbRows = [], lastSyncedIds = null }) {
  const sheetById = indexById(sheetRows)
  const dbById = indexById(dbRows)
  const knownIds = lastSyncedIds instanceof Set ? lastSyncedIds : null

  const orderedIds = [...sheetById.keys()]
  const dbOnlyIds = [...dbById.keys()].filter(id => !sheetById.has(id)).sort()
  orderedIds.push(...dbOnlyIds)

  const plan = {
    upserts: [],
    deleteFromDb: [],
    sheetRows: [],
    events: [],
    conflicts: [],
    stats: { inserts: 0, updates: 0, deletes: 0, conflicts: 0, unchanged: 0 }
  }

  orderedIds.forEach(id => {
    const decision = planRow(id, sheetById.get(id), dbById.get(id), Boolean(knownIds && knownIds.has(id)))

    if (decision.kind === 'keep') {
      plan.sheetRows.push(decision.row)
      if (decision.upsert) {
        plan.upserts.push(decision.row)
      }
      if (decision.unchanged) {
        plan.stats.unchanged += 1
      }
    }

    if (decision.deleteFromDb) {
      plan.deleteFromDb.push(id)
    }

    if (decision.event) {
      plan.events.push(decision.event)
      if (decision.event.action === ACTION.INSERT) plan.stats.inserts += 1
      if (decision.event.action === ACTION.UPDATE) plan.stats.updates += 1
      if (decision.event.action === ACTION.DELETE) plan.stats.deletes += 1
    }

    if (decision.conflict) {
      plan.conflicts.push(decision.conflict)
      plan.stats.conflicts += 1
    }
  })

  return plan
}

module.exports = {
  computeSyncPlan,
  ACTION,
  SOURCE
}
