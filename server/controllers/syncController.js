const { enqueueSync, getRunnerStatus } = require('../services/runner')
const { getMetadata } = require('../services/dbService')
const { LAST_SYNC_KEY } = require('../services/syncEngine')

async function forceSyncHandler(req, res) {
  try {
    const result = await enqueueSync({ reason: 'manual', changedAt: Date.now() })
    res.json({ status: 'scheduled', ...result })
  } catch (err) {
    res.status(500).json({ error: 'failed_to_schedule_sync' })
  }
}

async function getMeta(req, res) {
  try {
    const lastSyncTime = await getMetadata(LAST_SYNC_KEY)
    res.json({ lastSyncTime, runner: await getRunnerStatus() })
  } catch (err) {
    res.status(500).json({ error: 'failed_to_load_metadata' })
  }
}

module.exports = {
  forceSyncHandler,
  getMeta
}
