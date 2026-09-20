const { Worker } = require('bullmq')
const { createRedisConnection } = require('../config/redis')
const { QUEUE_NAME, getQueue, hasPendingChange, enqueueSync } = require('./syncQueue')
const { processSyncJob } = require('./processor')
const { broadcastStatus } = require('../websocket')
const { logError, logInfo, logWarn } = require('../utils/logger')

let worker = null
let workerConnection = null

function startWorker() {
  if (worker) {
    return worker
  }

  workerConnection = createRedisConnection('worker')

  // Concurrency is deliberately 1. A sync reconciles the whole sheet against
  // the whole table and rewrites the sheet, so two running at once would race
  // and could resurrect rows the other just deleted.
  worker = new Worker(QUEUE_NAME, job => processSyncJob(job, workerConnection), {
    connection: workerConnection,
    concurrency: 1
  })

  worker.on('completed', async job => {
    try {
      // A trigger that arrived while this job was running was deduped away,
      // but it left the dirty marker set. Pick it up now that the job id is
      // free again, so no edit is ever silently dropped.
      if (await hasPendingChange(workerConnection)) {
        logInfo(`follow-up sync queued after job=${job.id}`)
        await enqueueSync({ reason: 'follow-up' })
      }
    } catch (err) {
      logError(err)
    }
  })

  worker.on('failed', (job, err) => {
    const attempt = job ? job.attemptsMade : 0
    const max = job && job.opts ? job.opts.attempts : 0
    logWarn(`sync job=${job ? job.id : '?'} failed on attempt ${attempt}/${max}: ${err.message}`)
    if (job && attempt >= max) {
      broadcastStatus({ status: 'error' })
    }
  })

  worker.on('error', err => logError(err))

  // The detector runs here rather than in the API process: it re-baselines off
  // the sync-completed event, which only fires where executeSync actually runs.
  require('../services/changeDetector').startChangeDetector(enqueueSync)

  logInfo(`sync worker started (queue=${QUEUE_NAME}, concurrency=1)`)
  return worker
}

async function stopWorker() {
  require('../services/changeDetector').stopChangeDetector()
  if (worker) {
    await worker.close()
    worker = null
  }
  if (workerConnection) {
    await workerConnection.quit().catch(() => workerConnection.disconnect())
    workerConnection = null
  }
}

module.exports = { startWorker, stopWorker }

// Allow `npm run worker` to run this file as a standalone process.
if (require.main === module) {
  require('../config/env')

  const { initSyncEngine } = require('../services/syncEngine')

  initSyncEngine()
    .then(() => {
      getQueue()
      startWorker()
    })
    .catch(err => {
      logError(err)
      process.exit(1)
    })

  const shutdown = async signal => {
    logInfo(`worker received ${signal}, shutting down`)
    await stopWorker().catch(logError)
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
