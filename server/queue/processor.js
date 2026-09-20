const { executeSync } = require('../services/syncEngine')
const { recordSyncMetric } = require('../services/dbService')
const { claimPendingChange } = require('./syncQueue')
const { logInfo } = require('../utils/logger')

/**
 * Runs one sync job. The trigger details come from the Redis markers rather
 * than the job payload, because several triggers may have collapsed into this
 * single job and we want the earliest of them for the latency measurement.
 */
async function processSyncJob(job, redis) {
  const claimed = await claimPendingChange(redis)
  const reason = claimed.reason || (job.data && job.data.reason) || 'queued'

  const result = await executeSync({ reason, changedAt: claimed.changedAt })

  if (!result.skipped) {
    await recordSyncMetric({ ...result, reason })
    logInfo(
      `sync ok job=${job.id} attempt=${job.attemptsMade + 1} reason=${reason} ` +
        `rows=${result.rowsProcessed} written=${result.rowsWritten} duration=${result.durationMs}ms` +
        (result.latencyMs != null ? ` latency=${result.latencyMs}ms` : '')
    )
  }

  return result
}

module.exports = { processSyncJob }
