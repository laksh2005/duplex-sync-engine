// Indirection point for "how does a sync actually get run".
//
// With REDIS_URL set, syncs go through a BullMQ queue: triggers are deduped and
// debounced into batches, jobs retry with backoff, and the worker can run in a
// separate process. Without it, an in-process coalescing runner is used instead
// so local dev and the unit test suite need no broker.
const { isRedisEnabled } = require('../config/redis')
const inProcess = require('./inProcessRunner')
const { logInfo } = require('../utils/logger')

const useQueue = isRedisEnabled()
const queueModule = useQueue ? require('../queue/syncQueue') : null

// The API process runs the worker itself unless a dedicated worker is deployed
// alongside it, which is how docker compose runs things.
const runWorkerInline = useQueue && process.env.RUN_WORKER_INLINE !== '0'

async function initRunner() {
  if (!useQueue) {
    await inProcess.initRunner()
    // The detector must live in the process that runs syncs, so it can
    // re-baseline on completion.
    require('./changeDetector').startChangeDetector(enqueueSync)
    logInfo('sync runner: in-process (set REDIS_URL to use the queue)')
    return { mode: 'in-process' }
  }

  queueModule.getQueue()

  if (runWorkerInline) {
    require('../queue/worker').startWorker()
  }

  logInfo(`sync runner: bullmq (inline worker=${runWorkerInline})`)
  return { mode: 'bullmq', inlineWorker: runWorkerInline }
}

async function enqueueSync(payload) {
  return useQueue ? queueModule.enqueueSync(payload) : inProcess.enqueueSync(payload)
}

async function getRunnerStatus() {
  return useQueue ? queueModule.getQueueStatus() : inProcess.getRunnerStatus()
}

async function shutdownRunner() {
  if (!useQueue) {
    return inProcess.shutdownRunner()
  }
  if (runWorkerInline) {
    await require('../queue/worker').stopWorker()
  }
  await queueModule.closeQueue()
}

module.exports = {
  enqueueSync,
  initRunner,
  shutdownRunner,
  getRunnerStatus,
  usesQueue: useQueue
}
