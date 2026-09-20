process.env.WEBHOOK_SECRET = 'test-secret'

const request = require('supertest')

// The webhook must not actually run a sync in tests; we only care that it
// authenticates and hands a well-formed trigger to the runner.
jest.mock('../../services/runner', () => ({
  enqueueSync: jest.fn(async () => ({ queued: true, mode: 'test', deduped: false })),
  getRunnerStatus: jest.fn(async () => ({ mode: 'test' })),
  initRunner: jest.fn(),
  shutdownRunner: jest.fn()
}))

const { enqueueSync } = require('../../services/runner')
const app = require('../../app')

const post = body => request(app).post('/api/webhook/sheet').send(body)

describe('POST /api/webhook/sheet', () => {
  it('rejects a request with no secret', async () => {
    await post({ changedAt: Date.now() }).expect(401)
    expect(enqueueSync).not.toHaveBeenCalled()
  })

  it('rejects a wrong secret', async () => {
    await request(app)
      .post('/api/webhook/sheet')
      .set('x-webhook-secret', 'nope')
      .send({ changedAt: Date.now() })
      .expect(401)

    expect(enqueueSync).not.toHaveBeenCalled()
  })

  it('rejects a secret of the same length that differs', async () => {
    await request(app)
      .post('/api/webhook/sheet')
      .set('x-webhook-secret', 'test-secreX')
      .send({})
      .expect(401)
  })

  it('accepts a valid secret in the header and queues a sync', async () => {
    const changedAt = Date.now()
    const res = await request(app)
      .post('/api/webhook/sheet')
      .set('x-webhook-secret', 'test-secret')
      .send({ changedAt, range: 'A2:B2' })
      .expect(202)

    expect(res.body.status).toBe('accepted')
    expect(enqueueSync).toHaveBeenCalledWith({ reason: 'sheet-webhook', changedAt })
  })

  it('accepts the secret in the body too, for clients that cannot set headers', async () => {
    await post({ secret: 'test-secret', changedAt: Date.now() }).expect(202)
    expect(enqueueSync).toHaveBeenCalled()
  })

  it('falls back to now when changedAt is missing', async () => {
    const before = Date.now()
    await request(app).post('/api/webhook/sheet').set('x-webhook-secret', 'test-secret').send({}).expect(202)

    const { changedAt } = enqueueSync.mock.calls[0][0]
    expect(changedAt).toBeGreaterThanOrEqual(before)
  })

  it('ignores a changedAt far outside our clock, so latency cannot be poisoned', async () => {
    const before = Date.now()
    await request(app)
      .post('/api/webhook/sheet')
      .set('x-webhook-secret', 'test-secret')
      .send({ changedAt: 1 })
      .expect(202)

    const { changedAt } = enqueueSync.mock.calls[0][0]
    expect(changedAt).toBeGreaterThanOrEqual(before)
  })

  it('ignores a non-numeric changedAt', async () => {
    await request(app)
      .post('/api/webhook/sheet')
      .set('x-webhook-secret', 'test-secret')
      .send({ changedAt: 'yesterday' })
      .expect(202)

    expect(Number.isNaN(enqueueSync.mock.calls[0][0].changedAt)).toBe(false)
  })

  it('reports that the webhook is configured', async () => {
    const res = await request(app).get('/api/webhook/health').expect(200)
    expect(res.body.configured).toBe(true)
  })
})

describe('GET /api/health', () => {
  it('reports ok', async () => {
    const res = await request(app).get('/api/health').expect(200)
    expect(res.body.status).toBe('ok')
  })
})
