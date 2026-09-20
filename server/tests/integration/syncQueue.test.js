/**
 * Exercises the real BullMQ queue against a real Redis. Skipped when REDIS_URL
 * is not set so the default `npm test` run stays broker-free.
 */
const REDIS_URL = process.env.REDIS_URL || ''
const describeQueue = REDIS_URL ? describe : describe.skip

describeQueue('sync queue (BullMQ + Redis)', () => {
  let syncQueue
  let Worker
  let connection

  beforeAll(() => {
    process.env.SYNC_DEBOUNCE_MS = '50'
    syncQueue = require('../../queue/syncQueue')
    ;({ Worker } = require('bullmq'))
  })

  beforeEach(async () => {
    connection = syncQueue.getConnection()
    await syncQueue.getQueue().obliterate({ force: true })
    await connection.del(syncQueue.DIRTY_KEY, syncQueue.CHANGED_AT_KEY)
  })

  afterAll(async () => {
    await syncQueue.getQueue().obliterate({ force: true }).catch(() => {})
    await syncQueue.closeQueue()
  })

  it('collapses a burst of triggers into a single queued job', async () => {
    for (let i = 0; i < 25; i += 1) {
      await syncQueue.enqueueSync({ reason: 'webhook', changedAt: Date.now() })
    }

    const counts = await syncQueue.getQueue().getJobCounts('waiting', 'delayed', 'active')
    expect(counts.waiting + counts.delayed + counts.active).toBe(1)
  })

  it('reports that later triggers in a burst were deduped', async () => {
    const first = await syncQueue.enqueueSync({ reason: 'webhook', changedAt: Date.now() })
    const second = await syncQueue.enqueueSync({ reason: 'webhook', changedAt: Date.now() })

    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
  })

  it('keeps the earliest changedAt in a burst so latency covers the first edit', async () => {
    const earliest = Date.now() - 5000
    await syncQueue.enqueueSync({ reason: 'webhook', changedAt: earliest })
    await syncQueue.enqueueSync({ reason: 'webhook', changedAt: Date.now() })

    const claimed = await syncQueue.claimPendingChange(connection)
    expect(claimed.changedAt).toBe(earliest)
  })

  it('leaves a dirty marker that survives the job being deduped away', async () => {
    await syncQueue.enqueueSync({ reason: 'webhook', changedAt: Date.now() })
    expect(await syncQueue.hasPendingChange(connection)).toBe(true)

    await syncQueue.claimPendingChange(connection)
    expect(await syncQueue.hasPendingChange(connection)).toBe(false)
  })

  it('runs a queued job through a worker and passes the claimed trigger through', async () => {
    const seen = []
    const worker = new Worker(
      syncQueue.QUEUE_NAME,
      async job => {
        const claimed = await syncQueue.claimPendingChange(connection)
        seen.push({ jobId: job.id, ...claimed })
      },
      { connection: syncQueue.getConnection(), concurrency: 1 }
    )

    const changedAt = Date.now()
    await syncQueue.enqueueSync({ reason: 'webhook', changedAt })

    await new Promise(resolve => worker.once('completed', resolve))
    await worker.close()

    expect(seen).toHaveLength(1)
    expect(seen[0].reason).toBe('webhook')
    expect(seen[0].changedAt).toBe(changedAt)
  })

  it('retries a failing job with the configured attempt budget', async () => {
    let attempts = 0
    const worker = new Worker(
      syncQueue.QUEUE_NAME,
      async () => {
        attempts += 1
        throw new Error('boom')
      },
      { connection: syncQueue.getConnection(), concurrency: 1 }
    )

    await syncQueue.getQueue().add(
      syncQueue.JOB_NAME,
      { reason: 'test' },
      { jobId: 'retry-test', attempts: 3, backoff: { type: 'fixed', delay: 10 }, removeOnComplete: true }
    )

    await new Promise(resolve => {
      worker.on('failed', (job, err) => {
        if (job && job.attemptsMade >= 3) resolve(err)
      })
    })
    await worker.close()

    expect(attempts).toBe(3)
  })

  it('frees the deduped job id once the job completes, so the next trigger queues', async () => {
    // Mirrors the real processor, which claims the trigger markers on start.
    const worker = new Worker(
      syncQueue.QUEUE_NAME,
      async () => {
        await syncQueue.claimPendingChange(connection)
      },
      { connection: syncQueue.getConnection(), concurrency: 1 }
    )

    await syncQueue.enqueueSync({ reason: 'first', changedAt: Date.now() })
    await new Promise(resolve => worker.once('completed', resolve))

    const next = await syncQueue.enqueueSync({ reason: 'second', changedAt: Date.now() })
    await worker.close()

    expect(next.deduped).toBe(false)
  })
})
