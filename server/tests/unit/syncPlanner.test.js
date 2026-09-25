const { computeSyncPlan } = require('../../services/syncPlanner')
const { makeRow, idsOf } = require('../helpers/rows')

describe('computeSyncPlan', () => {
  describe('first sync (no prior state)', () => {
    it('inserts a sheet-only row into the DB and keeps it in the sheet', () => {
      const sheetRow = makeRow({ id: '1', name: 'alice' })
      const plan = computeSyncPlan({ sheetRows: [sheetRow], dbRows: [], lastSyncedIds: null })

      expect(idsOf(plan.upserts)).toEqual(['1'])
      expect(idsOf(plan.sheetRows)).toEqual(['1'])
      expect(plan.deleteFromDb).toEqual([])
      expect(plan.events).toEqual([{ row_id: '1', source: 'sheet', action: 'insert' }])
      expect(plan.stats.inserts).toBe(1)
    })

    it('adds a DB-only row to the sheet', () => {
      const dbRow = makeRow({ id: '2', name: 'bob' })
      const plan = computeSyncPlan({ sheetRows: [], dbRows: [dbRow], lastSyncedIds: null })

      expect(idsOf(plan.sheetRows)).toEqual(['2'])
      expect(idsOf(plan.upserts)).toEqual(['2'])
      expect(plan.events).toEqual([{ row_id: '2', source: 'db', action: 'insert' }])
    })

    it('treats null lastSyncedIds as no prior knowledge, never as a deletion', () => {
      const plan = computeSyncPlan({
        sheetRows: [makeRow({ id: '1', name: 'a' })],
        dbRows: [makeRow({ id: '2', name: 'b' })],
        lastSyncedIds: null
      })

      expect(plan.deleteFromDb).toEqual([])
      expect(plan.stats.deletes).toBe(0)
      expect(idsOf(plan.sheetRows).sort()).toEqual(['1', '2'])
    })
  })

  describe('deletions', () => {
    it('removes a row from the sheet when it was synced before and is now gone from the DB', () => {
      const sheetRow = makeRow({ id: '1', name: 'alice' })
      const plan = computeSyncPlan({
        sheetRows: [sheetRow],
        dbRows: [],
        lastSyncedIds: new Set(['1'])
      })

      expect(plan.sheetRows).toEqual([])
      expect(plan.upserts).toEqual([])
      expect(plan.events).toEqual([{ row_id: '1', source: 'db', action: 'delete' }])
      expect(plan.stats.deletes).toBe(1)
    })

    it('deletes from the DB when a previously synced row is gone from the sheet', () => {
      const dbRow = makeRow({ id: '1', name: 'alice' })
      const plan = computeSyncPlan({
        sheetRows: [],
        dbRows: [dbRow],
        lastSyncedIds: new Set(['1'])
      })

      expect(plan.deleteFromDb).toEqual(['1'])
      expect(plan.sheetRows).toEqual([])
      expect(plan.events).toEqual([{ row_id: '1', source: 'sheet', action: 'delete' }])
    })

    it('drops a DB row flagged deleted without writing it back to the sheet', () => {
      const dbRow = makeRow({ id: '1', name: 'alice', deleted: 1 })
      const plan = computeSyncPlan({ sheetRows: [], dbRows: [dbRow], lastSyncedIds: null })

      expect(plan.sheetRows).toEqual([])
      expect(plan.deleteFromDb).toEqual([])
      expect(plan.events).toEqual([{ row_id: '1', source: 'db', action: 'delete' }])
    })
  })

  describe('unchanged rows', () => {
    it('does nothing when checksums match on both sides', () => {
      const row = makeRow({ id: '1', name: 'alice' })
      const plan = computeSyncPlan({
        sheetRows: [{ ...row }],
        dbRows: [{ ...row }],
        lastSyncedIds: new Set(['1'])
      })

      expect(plan.upserts).toEqual([])
      expect(plan.events).toEqual([])
      expect(plan.conflicts).toEqual([])
      expect(plan.stats.unchanged).toBe(1)
      expect(idsOf(plan.sheetRows)).toEqual(['1'])
    })
  })

  describe('conflicts', () => {
    it('lets the newer sheet edit win and records the conflict', () => {
      const sheetRow = makeRow({ id: '1', name: 'from-sheet', updated_at: '2024-06-02T00:00:00.000Z' })
      const dbRow = makeRow({ id: '1', name: 'from-db', updated_at: '2024-06-01T00:00:00.000Z' })

      const plan = computeSyncPlan({ sheetRows: [sheetRow], dbRows: [dbRow], lastSyncedIds: new Set(['1']) })

      expect(plan.upserts[0].name).toBe('from-sheet')
      expect(plan.sheetRows[0].name).toBe('from-sheet')
      expect(plan.events).toEqual([{ row_id: '1', source: 'sheet', action: 'update' }])
      expect(plan.conflicts).toHaveLength(1)
      expect(plan.conflicts[0].winner).toBe('sheet')
      expect(plan.stats.conflicts).toBe(1)
    })

    it('lets the newer DB edit win', () => {
      const sheetRow = makeRow({ id: '1', name: 'from-sheet', updated_at: '2024-06-01T00:00:00.000Z' })
      const dbRow = makeRow({ id: '1', name: 'from-db', updated_at: '2024-06-02T00:00:00.000Z' })

      const plan = computeSyncPlan({ sheetRows: [sheetRow], dbRows: [dbRow], lastSyncedIds: new Set(['1']) })

      expect(plan.upserts[0].name).toBe('from-db')
      expect(plan.events[0].source).toBe('db')
      expect(plan.conflicts[0].winner).toBe('db')
    })

    it('breaks an exact timestamp tie in favour of the DB', () => {
      const at = '2024-06-01T00:00:00.000Z'
      const plan = computeSyncPlan({
        sheetRows: [makeRow({ id: '1', name: 'from-sheet', updated_at: at })],
        dbRows: [makeRow({ id: '1', name: 'from-db', updated_at: at })],
        lastSyncedIds: new Set(['1'])
      })

      expect(plan.conflicts[0].winner).toBe('db')
      expect(plan.upserts[0].name).toBe('from-db')
    })
  })

  describe('ordering and determinism', () => {
    it('keeps sheet order and appends DB-only rows sorted by id', () => {
      const plan = computeSyncPlan({
        sheetRows: [makeRow({ id: 'c' }), makeRow({ id: 'a' })],
        dbRows: [makeRow({ id: 'z' }), makeRow({ id: 'b' })],
        lastSyncedIds: null
      })

      expect(idsOf(plan.sheetRows)).toEqual(['c', 'a', 'b', 'z'])
    })

    it('produces identical output for identical input', () => {
      const input = {
        sheetRows: [makeRow({ id: '2', name: 'b' }), makeRow({ id: '1', name: 'a' })],
        dbRows: [makeRow({ id: '3', name: 'c' })],
        lastSyncedIds: new Set(['1'])
      }

      expect(computeSyncPlan(input)).toEqual(computeSyncPlan(input))
    })
  })

  describe('mixed workload', () => {
    it('handles inserts, deletes, conflicts and no-ops in one pass', () => {
      const unchanged = makeRow({ id: 'same', name: 'x' })

      const plan = computeSyncPlan({
        sheetRows: [
          makeRow({ id: 'new-in-sheet', name: 'n' }),
          { ...unchanged },
          makeRow({ id: 'conflicted', name: 'sheet-wins', updated_at: '2024-06-02T00:00:00.000Z' }),
          makeRow({ id: 'deleted-in-db', name: 'gone' })
        ],
        dbRows: [
          { ...unchanged },
          makeRow({ id: 'conflicted', name: 'db-loses', updated_at: '2024-06-01T00:00:00.000Z' }),
          makeRow({ id: 'new-in-db', name: 'm' }),
          makeRow({ id: 'deleted-in-sheet', name: 'gone too' })
        ],
        lastSyncedIds: new Set(['same', 'conflicted', 'deleted-in-db', 'deleted-in-sheet'])
      })

      expect(plan.stats).toEqual({ inserts: 2, updates: 1, deletes: 2, conflicts: 1, unchanged: 1 })
      expect(plan.deleteFromDb).toEqual(['deleted-in-sheet'])
      expect(idsOf(plan.sheetRows)).toEqual(['new-in-sheet', 'same', 'conflicted', 'new-in-db'])
    })
  })

  describe('input hygiene', () => {
    it('returns an empty plan for empty input', () => {
      const plan = computeSyncPlan({})
      expect(plan.upserts).toEqual([])
      expect(plan.sheetRows).toEqual([])
      expect(plan.events).toEqual([])
      expect(plan.stats).toEqual({ inserts: 0, updates: 0, deletes: 0, conflicts: 0, unchanged: 0 })
    })

    it('matches numeric and string ids across the two sides', () => {
      const plan = computeSyncPlan({
        sheetRows: [{ id: 7, updated_at: new Date(), deleted: 0, checksum: 'same' }],
        dbRows: [{ id: '7', updated_at: new Date(), deleted: 0, checksum: 'same' }],
        lastSyncedIds: null
      })

      expect(plan.sheetRows).toHaveLength(1)
      expect(plan.stats.unchanged).toBe(1)
    })

    it('keeps the first row when the sheet has a duplicate id', () => {
      // A stray row typed further down with a clashing id must not overwrite
      // the real row it collides with.
      const plan = computeSyncPlan({
        sheetRows: [makeRow({ id: '68', value: 'original' }), makeRow({ id: '68', value: 'stray' })],
        dbRows: [],
        lastSyncedIds: null
      })

      expect(plan.sheetRows).toHaveLength(1)
      expect(plan.sheetRows[0].value).toBe('original')
    })

    it('ignores rows without an id', () => {
      const plan = computeSyncPlan({
        sheetRows: [{ name: 'no id' }, makeRow({ id: '1' })],
        dbRows: [],
        lastSyncedIds: null
      })

      expect(idsOf(plan.sheetRows)).toEqual(['1'])
    })
  })

  describe('scale', () => {
    it('plans 10k rows without falling over', () => {
      const sheetRows = Array.from({ length: 10000 }, (_, i) => makeRow({ id: String(i), name: `row-${i}` }))
      const plan = computeSyncPlan({ sheetRows, dbRows: [], lastSyncedIds: null })

      expect(plan.upserts).toHaveLength(10000)
      expect(plan.stats.inserts).toBe(10000)
    })
  })
})
