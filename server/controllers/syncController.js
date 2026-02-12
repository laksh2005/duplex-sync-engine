const { forceSync } = require('../services/syncEngine')
const { getMetadata } = require('../services/dbService')

async function forceSyncHandler(req, res) {
  try {
    await forceSync()
    res.json({ status: 'scheduled' })
  } catch (err) {
    res.status(500).json({ error: 'failed_to_schedule_sync' })
  }
}

async function getMeta(req, res) {
  try {
    const lastSyncTime = await getMetadata('last_sync_time')
    res.json({ lastSyncTime })
  } catch (err) {
    res.status(500).json({ error: 'failed_to_load_metadata' })
  }
}

module.exports = {
  forceSyncHandler,
  getMeta
}

