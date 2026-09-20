const { Queue } = require('bullmq')
const { createRedisConnection } = require('../config/redis')

const QUEUE_NAME = 'duplex-sync'
const JOB_NAME = 'full-sync'

// A sync is a full reconcile of both sides, so two pending syncs are never
// better than one. All triggers therefore share a single job id: while a job is
// waiting, further triggers collapse into it. That is the batching win, and it
// is what stops a 50-cell paste from queueing 50 syncs.
const DEDUPE_JOB_ID = 'full-sync'

// Short debounce so a burst of onEdit webhooks settles before the sync reads
// the sheet, rather than syncing mid-paste.
const DEBOUNCE_MS = Number(process.env.SYNC_DEBOUNCE_MS || 750)

const DIRTY_KEY = 'duplex:sync:dirty'
const CHANGED_AT_KEY = 'duplex:sync:changed_at'

// An unclaimed edit timestamp older than this is meaningless for latency.
const CHANGED_AT_TTL_SECONDS = Number(process.env.SYNC_CHANGED_AT_TTL_SECONDS || 900)

let queue = null
let connection = null

function getQueue() {
  if (!queue) {
    connection = createRedisConnection('queue')
    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: Number(process.env.SYNC_JOB_ATTEMPTS || 5),
        backoff: { type: 'exponential', delay: 1000 },
        // The deduped job id can only be reused once the job leaves the
        // keyspace, so completed jobs must not be retained under that id.
        removeOnComplete: true,
        removeOnFail: { count: 100 }
      }
    })
  }
  return queue
}

function getConnection() {
  getQueue()
  return connection
}

/**
 * Marks the system dirty and schedules a sync. Setting the marker before adding
 * the job is what makes triggers safe against the add being deduped away: a
 * trigger that lands while a sync is already running leaves the marker set, and
 * the processor picks it up when it finishes.
 */
async function enqueueSync({ reason = 'manual', changedAt = null } = {}) {
  const q = getQueue()
  const redis = getConnection()

  // GETSET tells us atomically whether an unclaimed trigger was already
  // pending. BullMQ's add() returns the pre-existing job when a job id is
  // reused, so it cannot answer that question on its own.
  const previous = await redis.getset(DIRTY_KEY, reason)

  if (changedAt) {
    // NX keeps the earliest edit in a burst, so latency is measured from the
    // first change rather than the last. The TTL matters: if a process dies
    // between setting this and claiming it, the next sync would otherwise
    // attribute all the dead time to edit-to-sync latency. Losing the marker
    // just means that one sync reports no latency sample.
    await redis.set(CHANGED_AT_KEY, String(changedAt), 'EX', CHANGED_AT_TTL_SECONDS, 'NX')
  }

  const job = await q.add(JOB_NAME, { reason }, { jobId: DEDUPE_JOB_ID, delay: DEBOUNCE_MS })

  return {
    queued: true,
    mode: 'bullmq',
    jobId: job ? job.id : DEDUPE_JOB_ID,
    deduped: previous !== null
  }
}

/** Atomically takes ownership of the pending change markers. */
async function claimPendingChange(redis) {
  const [reason, changedAt] = await Promise.all([redis.getdel(DIRTY_KEY), redis.getdel(CHANGED_AT_KEY)])
  return { reason, changedAt: changedAt ? Number(changedAt) : null }
}

async function hasPendingChange(redis) {
  return (await redis.exists(DIRTY_KEY)) === 1
}

async function getQueueStatus() {
  const q = getQueue()
  const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')
  return { mode: 'bullmq', queue: QUEUE_NAME, counts }
}

async function closeQueue() {
  if (queue) {
    await queue.close()
    queue = null
  }
  if (connection) {
    await connection.quit().catch(() => connection.disconnect())
    connection = null
  }
}

module.exports = {
  QUEUE_NAME,
  JOB_NAME,
  DEDUPE_JOB_ID,
  DEBOUNCE_MS,
  DIRTY_KEY,
  CHANGED_AT_KEY,
  getQueue,
  getConnection,
  enqueueSync,
  claimPendingChange,
  hasPendingChange,
  getQueueStatus,
  closeQueue
}
