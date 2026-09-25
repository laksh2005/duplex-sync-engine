/**
 * Full path test: HTTP webhook -> BullMQ queue -> worker -> planner -> MySQL
 * -> sheet write-back -> metrics.
 *
 * Everything is real except the Google Sheets API, which is replaced by an
 * in-memory sheet that reads and writes in the same shape the real one does.
 * That keeps the round trip honest: what a sync writes back is what the next
 * sync reads.
 *
 * Needs DB_INTEGRATION=1, a MySQL and a Redis.
 */
const ENABLED = process.env.DB_INTEGRATION === '1' && Boolean(process.env.REDIS_URL)
const describeE2E = ENABLED ? describe : describe.skip

// The name must start with "mock" for jest to allow the hoisted factory below
// to close over it. It is only read once a test requires the module, which is
// well after this initializer runs.
let mockSheet = { headers: [], rows: [] }

jest.mock('../../services/sheetService', () => {
  const actual = jest.requireActual('../../services/sheetService')
  const { sanitizeColumnName } = jest.requireActual('../../utils/columns')
  const { formatReadable } = jest.requireActual('../../utils/time')

  const read = async () => ({ headers: [...mockSheet.headers], rows: mockSheet.rows.map(r => [...r]) })

  return {
    ...actual,
    fetchSheet: jest.fn(read),
    fetchSheetCached: jest.fn(read),
    writeRowsToSheet: jest.fn(async (headers, rows) => {
      // Mirrors the real serializer so the round trip stays faithful.
      mockSheet.headers = [...headers]
      mockSheet.rows = rows.map(row =>
        headers.map(header => {
          const key = sanitizeColumnName(header)
          if (key === 'id') return row.id != null ? String(row.id) : ''
          if (key === 'updated_at') return row.updated_at ? formatReadable(row.updated_at) : ''
          if (key === 'deleted') return row.deleted ? '1' : '0'
          return row[key] != null ? String(row[key]) : ''
        })
      )
    })
  }
})

describeE2E('end to end: webhook to MySQL and back', () => {
  const HEADERS = ['id', 'updated_at', 'deleted', 'name', 'city']
  const SECRET = 'e2e-secret'

  let request
  let app
  let db
  let pool
  let runner
  let syncEvents
  let sheetService

  const cell = (id, name, city, updatedAt = '2024-06-01T00:00:00.000Z') => [
    id,
    updatedAt,
    '0',
    name,
    city
  ]

  /** Resolves on the next completed sync, so tests never poll blindly. */
  const nextSync = (timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for sync')), timeoutMs)
      syncEvents.once('completed', result => {
        clearTimeout(timer)
        resolve(result)
      })
    })

  const triggerWebhook = (changedAt = Date.now()) =>
    request(app).post('/api/webhook/sheet').set('x-webhook-secret', SECRET).send({ changedAt })

  const dbRowsById = async () => {
    const rows = await db.getAllRows()
    return rows.reduce((acc, row) => {
      acc[row.id] = row
      return acc
    }, {})
  }

  const sheetIds = () => mockSheet.rows.map(r => r[mockSheet.headers.indexOf('id')])
  const sheetCell = (rowIndex, header) => mockSheet.rows[rowIndex][mockSheet.headers.indexOf(header)]

  beforeAll(async () => {
    process.env.WEBHOOK_SECRET = SECRET
    // Short by default so the suite is quick; override to measure latency at
    // the production debounce.
    process.env.SYNC_DEBOUNCE_MS = process.env.SYNC_DEBOUNCE_MS || '50'
    // The API process runs the worker itself here.
    process.env.RUN_WORKER_INLINE = '1'
    // The detector would fire on our own writes mid-test; triggers are explicit.
    process.env.DB_POLL_INTERVAL_MS = '0'

    request = require('supertest')
    app = require('../../app')
    db = require('../../services/dbService')
    ;({ pool } = require('../../config/db'))
    runner = require('../../services/runner')
    ;({ syncEvents } = require('../../services/syncEngine'))
    sheetService = require('../../services/sheetService')

    await db.initSchema()
    await runner.initRunner()
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${db.SYNC_TABLE}`)
    await pool.query(`TRUNCATE TABLE ${db.METRICS_TABLE}`)
    await pool.query(`TRUNCATE TABLE ${db.SYNC_LOGS_TABLE}`)
    await pool.query(`DELETE FROM ${db.METADATA_TABLE}`)

    mockSheet = { headers: [...HEADERS], rows: [] }
    sheetService.fetchSheet.mockClear()
    sheetService.writeRowsToSheet.mockClear()
  })

  afterAll(async () => {
    await runner.shutdownRunner()
    await pool.end()
  })

  it('carries a sheet row through the webhook into MySQL', async () => {
    mockSheet.rows = [cell('1', 'Alice', 'Delhi'), cell('2', 'Bob', 'Mumbai')]

    const done = nextSync()
    await triggerWebhook().expect(202)
    const result = await done

    expect(result.skipped).toBe(false)
    expect(result.stats.inserts).toBe(2)

    const rows = await dbRowsById()
    expect(Object.keys(rows).sort()).toEqual(['1', '2'])
    expect(rows['1'].name).toBe('Alice')
    expect(rows['2'].city).toBe('Mumbai')
  })

  it('creates MySQL columns for headers it has never seen', async () => {
    mockSheet.headers = [...HEADERS, 'Loyalty Tier']
    mockSheet.rows = [[...cell('1', 'Alice', 'Delhi'), 'gold']]

    const done = nextSync()
    await triggerWebhook().expect(202)
    await done

    expect(await db.getExistingColumns()).toContain('loyalty_tier')
    expect((await dbRowsById())['1'].loyalty_tier).toBe('gold')
  })

  it('pushes a DB-only row back into the sheet', async () => {
    await db.upsertRows([
      {
        id: '99',
        updated_at: new Date('2024-06-01T00:00:00.000Z'),
        checksum: 'seeded',
        deleted: 0,
        name: 'FromDb',
        city: 'Pune'
      }
    ])

    const done = nextSync()
    await triggerWebhook().expect(202)
    await done

    expect(sheetIds()).toContain('99')
  })

  it('records an edit-to-sync latency measured from the webhook timestamp', async () => {
    mockSheet.rows = [cell('1', 'Alice', 'Delhi')]

    const changedAt = Date.now() - 400
    const done = nextSync()
    await triggerWebhook(changedAt).expect(202)
    const result = await done

    expect(result.latencyMs).toBeGreaterThanOrEqual(400)
    // Upper bound guards against a stale changed_at marker from an earlier run
    // being claimed here, which would report dead time as edit latency.
    expect(result.latencyMs).toBeLessThan(400 + 15000)

    const metrics = await db.getRecentMetrics(5)
    expect(metrics[0].latency_ms).toBeGreaterThanOrEqual(400)
    expect(metrics[0].latency_ms).toBeLessThan(400 + 15000)
    expect(metrics[0].reason).toBe('sheet-webhook')
  })

  it('collapses a burst of webhook calls into a single sync', async () => {
    mockSheet.rows = [cell('1', 'Alice', 'Delhi')]

    const done = nextSync()
    await Promise.all(Array.from({ length: 20 }, () => triggerWebhook().expect(202)))
    await done

    // Let any surplus job that was going to run do so.
    await new Promise(resolve => setTimeout(resolve, 1200))

    const metrics = await db.getRecentMetrics(50)
    expect(metrics.length).toBeLessThanOrEqual(2)
  })

  it('settles: a second sync over unchanged data writes nothing', async () => {
    mockSheet.rows = [cell('1', 'Alice', 'Delhi'), cell('2', 'Bob', 'Mumbai')]

    let done = nextSync()
    await triggerWebhook().expect(202)
    await done

    done = nextSync()
    await triggerWebhook().expect(202)
    const second = await done

    expect(second.stats).toEqual({ inserts: 0, updates: 0, deletes: 0, conflicts: 0, unchanged: 2 })
    expect(second.rowsWritten).toBe(0)
  })

  it('deletes from MySQL when the row disappears from the sheet', async () => {
    mockSheet.rows = [cell('1', 'Alice', 'Delhi'), cell('2', 'Bob', 'Mumbai')]

    let done = nextSync()
    await triggerWebhook().expect(202)
    await done

    mockSheet.rows = mockSheet.rows.filter(row => row[0] !== '2')

    done = nextSync()
    await triggerWebhook().expect(202)
    const result = await done

    expect(result.stats.deletes).toBe(1)
    expect(Object.keys(await dbRowsById())).toEqual(['1'])
  })

  it('removes the row from the sheet when it is deleted from MySQL', async () => {
    mockSheet.rows = [cell('1', 'Alice', 'Delhi'), cell('2', 'Bob', 'Mumbai')]

    let done = nextSync()
    await triggerWebhook().expect(202)
    await done

    await db.deleteRows(['2'])

    done = nextSync()
    await triggerWebhook().expect(202)
    await done

    expect(sheetIds()).toEqual(['1'])
  })

  it('resolves a genuine two-sided conflict in favour of the newer edit', async () => {
    mockSheet.rows = [cell('1', 'Alice', 'Delhi')]

    let done = nextSync()
    await triggerWebhook().expect(202)
    await done

    // Both sides change the same row; the sheet edit is newer.
    await db.upsertRows([
      {
        id: '1',
        updated_at: new Date('2024-06-02T00:00:00.000Z'),
        checksum: 'db-version',
        deleted: 0,
        name: 'AliceFromDb',
        city: 'Delhi'
      }
    ])
    // cell() builds rows in HEADERS order, so reset the headers too: the sync
    // above rewrote the sheet in its own column order.
    mockSheet.headers = [...HEADERS]
    mockSheet.rows = [cell('1', 'AliceFromSheet', 'Delhi', '2024-06-03T00:00:00.000Z')]

    done = nextSync()
    await triggerWebhook().expect(202)
    const result = await done

    expect(result.stats.conflicts).toBe(1)
    expect((await dbRowsById())['1'].name).toBe('AliceFromSheet')
    expect(sheetCell(0, 'name')).toBe('AliceFromSheet')
  })

  it('survives a large sheet in one pass', async () => {
    mockSheet.rows = Array.from({ length: 2000 }, (_, i) =>
      cell(String(i), `Person ${i}`, i % 2 ? 'Delhi' : 'Mumbai')
    )

    const done = nextSync(40000)
    await triggerWebhook().expect(202)
    const result = await done

    expect(result.stats.inserts).toBe(2000)
    const [[{ count }]] = await pool.query(`SELECT COUNT(*) AS count FROM ${db.SYNC_TABLE}`)
    expect(Number(count)).toBe(2000)
  }, 60000)

  it('reports the run through /api/metrics', async () => {
    mockSheet.rows = [cell('1', 'Alice', 'Delhi')]

    const done = nextSync()
    await triggerWebhook().expect(202)
    await done

    const res = await request(app).get('/api/metrics').expect(200)
    expect(res.body.summary.samples).toBeGreaterThan(0)
    expect(res.body.runner.mode).toBe('bullmq')
  })
  it('writes the sheet back as id, data columns, updated_at, deleted', async () => {
    mockSheet.rows = [cell('1', 'Alice', 'Delhi')]

    const done = nextSync()
    await triggerWebhook().expect(202)
    await done

    expect(mockSheet.headers).toEqual(['id', 'name', 'city', 'updated_at', 'deleted'])
  })

  it('writes updated_at to the sheet as readable text that reads back to the same instant', async () => {
    mockSheet.rows = [cell('1', 'Alice', 'Delhi', '2026-09-09T11:09:12.000Z')]

    let done = nextSync()
    await triggerWebhook().expect(202)
    await done

    expect(sheetCell(0, 'updated_at')).toMatch(/^\d{1,2}:\d{2}:\d{2} [AP]M, \d{1,2} [A-Z][a-z]{2} \d{4}$/)

    // A second pass must parse that text back exactly, or the row would look
    // changed on every sync.
    done = nextSync()
    await triggerWebhook().expect(202)
    const second = await done
    expect(second.stats.unchanged).toBe(1)
    expect(second.rowsWritten).toBe(0)
  })

  it('does not erase a sheet edit that lands while a sync is running', async () => {
    mockSheet.rows = [cell('1', 'Alice', 'Delhi')]
    let done = nextSync()
    await triggerWebhook().expect(202)
    await done

    // The first read of the next sync sees the sheet as-is; by the second read
    // (just before the sheet is rewritten) the user has typed a new value.
    const original = sheetService.fetchSheet.getMockImplementation()
    let calls = 0
    sheetService.fetchSheet.mockImplementation(async () => {
      calls += 1
      if (calls === 2) {
        mockSheet.rows[0][mockSheet.headers.indexOf('name')] = 'EditedMidSync'
        mockSheet.rows[0][mockSheet.headers.indexOf('updated_at')] = new Date(Date.now() + 1000).toISOString()
      }
      return original()
    })

    try {
      done = nextSync(20000)
      await triggerWebhook().expect(202)
      await done
    } finally {
      sheetService.fetchSheet.mockImplementation(original)
    }

    expect(sheetCell(0, 'name')).toBe('EditedMidSync')
    expect((await dbRowsById())['1'].name).toBe('EditedMidSync')
  }, 30000)
})
