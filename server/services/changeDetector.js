const { pool } = require('../config/db')
const { SYNC_TABLE } = require('./dbService')
const { syncEvents } = require('./syncEngine')
const { logError, logInfo } = require('../utils/logger')

const POLL_INTERVAL_MS = Number(process.env.DB_POLL_INTERVAL_MS || 5000)

let timer = null
let baseline = null
let enqueue = null

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
  return a.rowCount !== b.rowCount || a.contentHash !== b.contentHash
}

async function refreshBaseline() {
  try {
    baseline = await readFingerprint()
  } catch (err) {
    logError(err)
  }
}

async function tick() {
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

    // Prefer the row's own updated_at as the edit time when it is plausibly
    // recent, otherwise fall back to detection time. Either way the reported
    // latency includes the polling delay, which is the honest number for a
    // polled source.
    const now = Date.now()
    const changedAt =
      current.maxUpdatedAt && current.maxUpdatedAt <= now && now - current.maxUpdatedAt < POLL_INTERVAL_MS * 4
        ? current.maxUpdatedAt
        : now

    logInfo(`db change detected (rows=${current.rowCount}), queueing sync`)
    await enqueue({ reason: 'db-poll', changedAt })
  } catch (err) {
    logError(err)
  }
}

function startChangeDetector(enqueueSync) {
  if (timer || POLL_INTERVAL_MS <= 0) {
    return
  }
  enqueue = enqueueSync

  // A sync writes to the table itself. Re-baselining once it finishes stops
  // those writes from looking like a user edit and triggering another sync.
  syncEvents.on('completed', () => {
    refreshBaseline().catch(logError)
  })

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
  baseline = null
}

module.exports = {
  startChangeDetector,
  stopChangeDetector,
  readFingerprint,
  refreshBaseline,
  POLL_INTERVAL_MS
}
