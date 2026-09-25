const { pool } = require('../config/db')
const { SYNC_TABLE } = require('./dbService')
const { syncEvents } = require('./syncEngine')
const { logError, logInfo } = require('../utils/logger')

const POLL_INTERVAL_MS = Number(process.env.DB_POLL_INTERVAL_MS || 5000)

let timer = null
let baseline = null
let enqueue = null
let syncing = false

/**
 * Cheap summary of the table's contents. BIT_XOR over the row checksums catches
 * edits, the count catches inserts and deletes, and MAX(updated_at) gives us an
 * approximate edit time for the latency measurement. One indexed scan rather
 * than pulling every row across the wire on each tick.
 */
async function readFingerprint() {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS row_count,
            COALESCE(BIT_XOR(CRC32(checksum)), 0) AS content_hash,
            UNIX_TIMESTAMP(MAX(updated_at)) AS max_updated_at
     FROM ${SYNC_TABLE}`
  )
  const row = rows[0] || {}
  return {
    rowCount: Number(row.row_count || 0),
    contentHash: String(row.content_hash || 0),
    maxUpdatedAt: row.max_updated_at ? Number(row.max_updated_at) * 1000 : null
  }
}

function differs(a, b) {
  if (!a || !b) {
    return false
  }
  // contentHash alone misses an edit that leaves the checksum column stale,
  // which happens for any write that does not go through this app's own
  // upsert path (a manual UPDATE, a script, another service). maxUpdatedAt
  // catches that case: any edit that bumps updated_at is visible even when
  // the row's checksum was never recomputed.
  return a.rowCount !== b.rowCount || a.contentHash !== b.contentHash || a.maxUpdatedAt !== b.maxUpdatedAt
}

/**
 * True when some row carries an updated_at at or after the moment a sync read
 * the table, meaning it was written by someone else while that sync ran.
 * Compared at whole-second precision because MySQL's datetime drops the
 * fraction; the cost is at most one redundant sync when a sync's own write
 * lands in the same second it started.
 */
function editedDuringSync(fingerprint, startedAt) {
  if (!fingerprint || !fingerprint.maxUpdatedAt || !startedAt) {
    return false
  }
  return fingerprint.maxUpdatedAt >= Math.floor(startedAt / 1000) * 1000
}

function changedAtFor(fingerprint) {
  // Prefer the row's own updated_at as the edit time when it is plausibly
  // recent, otherwise fall back to detection time. Either way the reported
  // latency includes the polling delay, which is the honest number for a
  // polled source.
  const now = Date.now()
  const max = fingerprint.maxUpdatedAt
  return max && max <= now && now - max < POLL_INTERVAL_MS * 4 ? max : now
}

async function tick() {
  // A sync writes to this table itself. Polling mid-sync would mistake those
  // writes for a user edit and queue a redundant sync.
  if (syncing) {
    return
  }
  try {
    const current = await readFingerprint()

    if (!baseline) {
      baseline = current
      return
    }

    if (!differs(baseline, current)) {
      return
    }

    // Baseline moves before enqueuing so a slow sync does not cause the same
    // change to be reported on every subsequent tick.
    baseline = current

    logInfo(`db change detected (rows=${current.rowCount}), queueing sync`)
    await enqueue({ reason: 'db-poll', changedAt: changedAtFor(current) })
  } catch (err) {
    logError(err)
  }
}

async function onSyncSettled({ startedAt } = {}) {
  try {
    const current = await readFingerprint()
    baseline = current
    // Re-baselining alone would silently absorb a DB edit made while the sync
    // was running, since the sync read the table before it happened.
    if (editedDuringSync(current, startedAt)) {
      logInfo('db edited during sync, queueing follow-up')
      await enqueue({ reason: 'db-poll', changedAt: changedAtFor(current) })
    }
  } catch (err) {
    logError(err)
  } finally {
    syncing = false
  }
}

function onSyncStarted() {
  syncing = true
}

function startChangeDetector(enqueueSync) {
  if (timer || POLL_INTERVAL_MS <= 0) {
    return
  }
  enqueue = enqueueSync

  syncEvents.on('started', onSyncStarted)
  syncEvents.on('settled', onSyncSettled)

  timer = setInterval(() => {
    tick().catch(logError)
  }, POLL_INTERVAL_MS)

  if (timer.unref) {
    timer.unref()
  }

  logInfo(`db change detector polling every ${POLL_INTERVAL_MS}ms`)
}

function stopChangeDetector() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  syncEvents.off('started', onSyncStarted)
  syncEvents.off('settled', onSyncSettled)
  baseline = null
  syncing = false
}

module.exports = {
  startChangeDetector,
  stopChangeDetector,
  readFingerprint,
  differs,
  editedDuringSync,
  POLL_INTERVAL_MS
}
