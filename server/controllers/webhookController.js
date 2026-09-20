const crypto = require('crypto')
const { enqueueSync } = require('../services/runner')
const { logInfo, logWarn } = require('../utils/logger')

const SECRET = process.env.WEBHOOK_SECRET || ''

// Rejects an edit timestamp that is wildly out of step with our clock, so a bad
// client cannot poison the latency numbers with a far-past or future value.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) {
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}

function isAuthorized(req) {
  if (!SECRET) {
    return false
  }
  const provided = req.get('x-webhook-secret') || (req.body && req.body.secret) || ''
  return Boolean(provided) && timingSafeEqual(provided, SECRET)
}

function normalizeChangedAt(raw) {
  const now = Date.now()
  const value = Number(raw)
  if (!raw || Number.isNaN(value)) {
    return now
  }
  if (Math.abs(now - value) > MAX_CLOCK_SKEW_MS) {
    return now
  }
  return value
}

/**
 * Receives an edit notification from the Google Apps Script onEdit trigger.
 * Returns immediately: the sync itself happens on the queue, because Apps
 * Script gives the trigger a short execution budget.
 */
async function sheetWebhook(req, res) {
  if (!SECRET) {
    logWarn('sheet webhook called but WEBHOOK_SECRET is not set; refusing')
    return res.status(503).json({ error: 'webhook_not_configured' })
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const body = req.body || {}
  const changedAt = normalizeChangedAt(body.changedAt)

  try {
    const queued = await enqueueSync({ reason: 'sheet-webhook', changedAt })
    logInfo(`sheet webhook accepted (range=${body.range || 'n/a'}, deduped=${Boolean(queued.deduped)})`)
    return res.status(202).json({ status: 'accepted', changedAt, ...queued })
  } catch (err) {
    return res.status(500).json({ error: 'failed_to_schedule_sync' })
  }
}

function webhookHealth(req, res) {
  res.json({ configured: Boolean(SECRET) })
}

module.exports = {
  sheetWebhook,
  webhookHealth
}
