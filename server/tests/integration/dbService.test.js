/**
 * Integration tests against a real MySQL.
 *
 * Enabled with DB_INTEGRATION=1 and a DB_* config pointing at a throwaway
 * database, which is how CI and `docker compose` run them. Skipped otherwise so
 * `npm test` stays runnable with no services.
 *
 * These tests TRUNCATE the sync tables, so point them at a test database.
 */
const ENABLED = process.env.DB_INTEGRATION === '1'
const describeDb = ENABLED ? describe : describe.skip

describeDb('dbService against MySQL', () => {
  let db
  let pool
  let readFingerprint

  const rowsWith = (count, overrides = {}) =>
    Array.from({ length: count }, (_, i) => ({
      id: `row-${i}`,
      updated_at: new Date('2024-06-01T00:00:00.000Z'),
      checksum: `sum-${i}`,
      deleted: 0,
      ...overrides
    }))

  beforeAll(async () => {
    db = require('../../services/dbService')
    ;({ pool } = require('../../config/db'))
    ;({ readFingerprint } = require('../../services/changeDetector'))
    await db.initSchema()
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE ${db.SYNC_TABLE}`)
    await pool.query(`TRUNCATE TABLE ${db.SYNC_LOGS_TABLE}`)
    await pool.query(`TRUNCATE TABLE ${db.CONFLICT_LOGS_TABLE}`)
    await pool.query(`TRUNCATE TABLE ${db.METRICS_TABLE}`)
    await pool.query(`DELETE FROM ${db.METADATA_TABLE}`)
  })

  afterAll(async () => {
    await pool.end()
  })

  describe('schema', () => {
    it('is idempotent, so a restart does not fail', async () => {
      await expect(db.initSchema()).resolves.not.toThrow()
    })

    it('creates every table the engine needs', async () => {
      const [rows] = await pool.query(
        `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()`
      )
      const names = rows.map(r => r.t)
      expect(names).toEqual(
        expect.arrayContaining([
          db.SYNC_TABLE,
          db.SYNC_LOGS_TABLE,
          db.CONFLICT_LOGS_TABLE,
          db.METADATA_TABLE,
          db.METRICS_TABLE
        ])
      )
    })
  })

  describe('dynamic columns', () => {
    it('adds a column for a new sheet header', async () => {
      await db.ensureColumnsForHeaders(['id', 'updated_at', 'First Name'])
      expect(await db.getExistingColumns()).toContain('first_name')
    })

    it('does not fail when the column already exists', async () => {
      await db.ensureColumnsForHeaders(['id', 'Email'])
      await expect(db.ensureColumnsForHeaders(['id', 'Email'])).resolves.not.toThrow()
    })

    it('adds a column on upsert when a row carries an unseen field', async () => {
      await db.upsertRows([
        { id: '1', updated_at: new Date(), checksum: 'a', deleted: 0, surprise_field: 'hello' }
      ])

      expect(await db.getExistingColumns()).toContain('surprise_field')
      const [rows] = await pool.query(`SELECT surprise_field FROM ${db.SYNC_TABLE} WHERE id = '1'`)
      expect(rows[0].surprise_field).toBe('hello')
    })
  })

  describe('column order and readable view', () => {
    const columnOrder = async () => {
      const [rows] = await pool.query(
        `SELECT COLUMN_NAME AS c FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ORDINAL_POSITION`,
        [db.SYNC_TABLE]
      )
      return rows.map(r => r.c)
    }

    it('orders the table as id, data columns, updated_at, deleted', async () => {
      await db.ensureColumnsForHeaders(['id', 'value', 'updated_at', 'deleted'])
      const order = await columnOrder()

      expect(order[0]).toBe('id')
      expect(order.indexOf('value')).toBeLessThan(order.indexOf('updated_at'))
      expect(order.indexOf('updated_at')).toBeLessThan(order.indexOf('deleted'))
    })

    it('keeps updated_at a real DATETIME so date comparisons still work', async () => {
      const [rows] = await pool.query(
        `SELECT DATA_TYPE AS t FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND COLUMN_NAME = 'updated_at'`,
        [db.SYNC_TABLE]
      )
      expect(rows[0].t).toBe('datetime')
    })

    it('exposes a view with the readable time in sheet column order', async () => {
      await db.ensureColumnsForHeaders(['id', 'value', 'updated_at', 'deleted'])
      await pool.query(
        `INSERT INTO ${db.SYNC_TABLE} (id, value, updated_at, deleted, checksum)
         VALUES ('1', 'Alpha', '2026-09-09 16:39:12', 0, 'x')`
      )

      const [rows] = await pool.query(`SELECT * FROM ${db.READABLE_VIEW}`)
      expect(Object.keys(rows[0])).toEqual(['id', 'value', 'updated_at', 'deleted'])
      expect(rows[0].updated_at).toBe('4:39:12 PM, 9 Sep 2026')
    })
  })

  describe('upsert', () => {
    it('writes every row of a multi-row batch', async () => {
      // Regression guard: the previous implementation built placeholders for a
      // single row while passing parameters for all of them, so only the first
      // row was ever written.
      await db.upsertRows(rowsWith(50))

      const [[{ count }]] = await pool.query(`SELECT COUNT(*) AS count FROM ${db.SYNC_TABLE}`)
      expect(Number(count)).toBe(50)
    })

    it('splits a batch larger than the chunk size into several statements', async () => {
      const total = db.CHUNK_SIZE * 2 + 25
      const result = await db.upsertRows(rowsWith(total))

      expect(result.batches).toBe(3)
      const [[{ count }]] = await pool.query(`SELECT COUNT(*) AS count FROM ${db.SYNC_TABLE}`)
      expect(Number(count)).toBe(total)
    })

    it('updates an existing row rather than duplicating it', async () => {
      await db.upsertRows([{ id: '1', updated_at: new Date(), checksum: 'first', deleted: 0 }])
      await db.upsertRows([{ id: '1', updated_at: new Date(), checksum: 'second', deleted: 0 }])

      const [rows] = await pool.query(`SELECT checksum FROM ${db.SYNC_TABLE}`)
      expect(rows).toHaveLength(1)
      expect(rows[0].checksum).toBe('second')
    })

    it('substitutes now for an invalid updated_at instead of rejecting the row', async () => {
      await db.upsertRows([{ id: '1', updated_at: 'not-a-date', checksum: 'a', deleted: 0 }])

      const [rows] = await pool.query(`SELECT updated_at FROM ${db.SYNC_TABLE}`)
      expect(rows[0].updated_at).toBeInstanceOf(Date)
    })

    it('rolls back the whole batch when one row is bad', async () => {
      await db.upsertRows(rowsWith(3))

      const bad = rowsWith(3, {})
      bad.push({ id: null, updated_at: new Date(), checksum: 'x', deleted: 0 })

      await expect(db.upsertRows(bad)).rejects.toThrow()

      const [[{ count }]] = await pool.query(`SELECT COUNT(*) AS count FROM ${db.SYNC_TABLE}`)
      expect(Number(count)).toBe(3)
    })

    it('is a no-op for an empty batch', async () => {
      await expect(db.upsertRows([])).resolves.toEqual({ written: 0, batches: 0 })
    })
  })

  describe('delete', () => {
    it('deletes many ids at once', async () => {
      await db.upsertRows(rowsWith(10))
      await db.deleteRows(['row-1', 'row-2', 'row-3'])

      const [[{ count }]] = await pool.query(`SELECT COUNT(*) AS count FROM ${db.SYNC_TABLE}`)
      expect(Number(count)).toBe(7)
    })

    it('is a no-op for an empty id list', async () => {
      await db.upsertRows(rowsWith(3))
      await db.deleteRows([])

      const [[{ count }]] = await pool.query(`SELECT COUNT(*) AS count FROM ${db.SYNC_TABLE}`)
      expect(Number(count)).toBe(3)
    })
  })

  describe('active rows', () => {
    it('excludes rows flagged deleted', async () => {
      await db.upsertRows([
        { id: 'live', updated_at: new Date(), checksum: 'a', deleted: 0 },
        { id: 'gone', updated_at: new Date(), checksum: 'b', deleted: 1 }
      ])

      const active = await db.getActiveRows()
      expect(active.map(r => r.id)).toEqual(['live'])
      expect(await db.getAllRows()).toHaveLength(2)
    })
  })

  describe('logs and metrics', () => {
    it('batch-writes sync logs', async () => {
      await db.writeSyncLogs([
        { row_id: '1', source: 'sheet', action: 'insert', status: 'success', message: null },
        { row_id: '2', source: 'db', action: 'delete', status: 'success', message: null }
      ])

      const logs = await db.getRecentSyncLogs(10)
      expect(logs).toHaveLength(2)
      expect(logs[0].row_id).toBe('2')
    })

    it('batch-writes conflict logs', async () => {
      await db.writeConflictLogs([
        {
          row_id: '1',
          sheet_updated_at: new Date('2024-06-02T00:00:00Z'),
          db_updated_at: new Date('2024-06-01T00:00:00Z'),
          winner: 'sheet',
          details: null
        }
      ])

      const [rows] = await pool.query(`SELECT winner FROM ${db.CONFLICT_LOGS_TABLE}`)
      expect(rows[0].winner).toBe('sheet')
    })

    it('records and reads back a sync metric', async () => {
      await db.recordSyncMetric({
        reason: 'sheet-webhook',
        rowsProcessed: 120,
        rowsWritten: 100,
        durationMs: 800,
        latencyMs: 1500
      })

      const metrics = await db.getRecentMetrics(10)
      expect(metrics).toHaveLength(1)
      expect(metrics[0].rows_processed).toBe(120)
      expect(metrics[0].latency_ms).toBe(1500)
    })

    it('stores a null latency for a sync with no originating edit', async () => {
      await db.recordSyncMetric({ reason: 'manual', rowsProcessed: 1, rowsWritten: 1, durationMs: 10 })
      const metrics = await db.getRecentMetrics(1)
      expect(metrics[0].latency_ms).toBeNull()
    })
  })

  describe('metadata', () => {
    it('round-trips a value', async () => {
      await db.setMetadata('last_sync_time', '2024-06-01T00:00:00.000Z')
      expect(await db.getMetadata('last_sync_time')).toBe('2024-06-01T00:00:00.000Z')
    })

    it('overwrites an existing key rather than erroring', async () => {
      await db.setMetadata('k', 'one')
      await db.setMetadata('k', 'two')
      expect(await db.getMetadata('k')).toBe('two')
    })

    it('returns null for an unknown key', async () => {
      expect(await db.getMetadata('nope')).toBeNull()
    })

    it('stores a synced id list large enough for a real sheet', async () => {
      const ids = Array.from({ length: 5000 }, (_, i) => `row-${i}`)
      await db.setMetadata('synced_row_ids', JSON.stringify(ids))

      expect(JSON.parse(await db.getMetadata('synced_row_ids'))).toHaveLength(5000)
    })
  })

  describe('change detection fingerprint', () => {
    it('changes when a row is added', async () => {
      const before = await readFingerprint()
      await db.upsertRows(rowsWith(1))
      const after = await readFingerprint()

      expect(after.rowCount).toBe(before.rowCount + 1)
    })

    it('changes when a row content changes but the row count does not', async () => {
      await db.upsertRows([{ id: '1', updated_at: new Date(), checksum: 'before', deleted: 0 }])
      const before = await readFingerprint()

      await db.upsertRows([{ id: '1', updated_at: new Date(), checksum: 'after', deleted: 0 }])
      const after = await readFingerprint()

      expect(after.rowCount).toBe(before.rowCount)
      expect(after.contentHash).not.toBe(before.contentHash)
    })

    it('is stable when nothing changes, so no sync is triggered', async () => {
      await db.upsertRows(rowsWith(5))
      const a = await readFingerprint()
      const b = await readFingerprint()

      expect(b).toEqual(a)
    })
  })
})
