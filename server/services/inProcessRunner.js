const { executeSync } = require('./syncEngine')
const { broadcastStatus } = require('../websocket')
const { logError, logInfo } = require('../utils/logger')

// Fallback runner used when Redis is not configured. Keeps a single sync in
// flight and coalesces anything that arrives while one is running, so a burst
// of sheet edits collapses into one follow-up pass instead of a queue of them.
let running = false
let pending = null

async function drain() {
  if (running || !pending) {
    return
  }
  running = true
  const job = pending
  pending = null

  try {
    const result = await executeSync(job)
    if (!result.skipped) {
      logInfo(
        `sync ok reason=${job.reason} rows=${result.rowsProcessed} duration=${result.durationMs}ms` +
          (result.latencyMs != null ? ` latency=${result.latencyMs}ms` : '')
      )
    }
  } catch (err) {
    if (err.code === 'SHEET_CHANGED') {
      // Someone edited mid-sync; run again against the fresh sheet.
      logInfo('sheet changed during sync, requeueing')
      pending = pending || job
    } else {
      logError(err)
      broadcastStatus({ status: 'error' })
    }
  } finally {
    running = false
    if (pending) {
      drain().catch(logError)
    }
  }
}

function enqueueSync({ reason = 'manual', changedAt = null } = {}) {
  // Keep the oldest pending change timestamp so latency reflects the first edit
  // in a coalesced burst rather than the last one.
  const earliestChangedAt =
    pending && pending.changedAt && changedAt
      ? Math.min(Number(pending.changedAt), Number(changedAt))
      : (pending && pending.changedAt) || changedAt

  pending = { reason, changedAt: earliestChangedAt }
  setImmediate(() => drain().catch(logError))
  return { queued: true, mode: 'in-process' }
}

async function initRunner() {
  return { mode: 'in-process' }
}

async function shutdownRunner() {
  pending = null
}

function getRunnerStatus() {
  return { mode: 'in-process', running, pending: Boolean(pending) }
}

module.exports = {
  enqueueSync,
  initRunner,
  shutdownRunner,
  getRunnerStatus
}
