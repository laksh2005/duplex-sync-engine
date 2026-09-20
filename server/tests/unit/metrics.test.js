const { summarize } = require('../../controllers/metricsController')

const sample = (overrides = {}) => ({
  reason: 'sheet-webhook',
  rows_processed: 100,
  rows_written: 100,
  duration_ms: 1000,
  latency_ms: 500,
  created_at: '2024-06-01T00:00:00.000Z',
  ...overrides
})

describe('metrics summarize', () => {
  it('reports nothing for an empty history', () => {
    expect(summarize([])).toEqual({ samples: 0 })
  })

  it('computes latency percentiles', () => {
    const rows = [100, 200, 300, 400, 500].map(latency_ms => sample({ latency_ms }))
    const result = summarize(rows)

    expect(result.latencyMs.p50).toBe(300)
    expect(result.latencyMs.p95).toBe(500)
    expect(result.latencyMs.max).toBe(500)
    expect(result.latencyMs.samples).toBe(5)
  })

  it('ignores syncs with no latency sample, such as manual runs', () => {
    const result = summarize([sample({ latency_ms: null }), sample({ latency_ms: 200 })])
    expect(result.latencyMs.samples).toBe(1)
    expect(result.latencyMs.p50).toBe(200)
  })

  it('computes rows per second from duration', () => {
    const result = summarize([sample({ rows_processed: 5000, duration_ms: 2000 })])
    expect(result.rowsPerSecond).toBe(2500)
  })

  it('excludes no-op syncs from throughput so the number stays meaningful', () => {
    const result = summarize([
      sample({ rows_processed: 1000, duration_ms: 1000 }),
      sample({ rows_processed: 0, duration_ms: 50 })
    ])
    expect(result.rowsPerSecond).toBe(1000)
  })

  it('returns null throughput when no sync moved any rows', () => {
    expect(summarize([sample({ rows_processed: 0 })]).rowsPerSecond).toBeNull()
  })

  it('totals rows processed across the window', () => {
    const result = summarize([sample({ rows_processed: 10 }), sample({ rows_processed: 32 })])
    expect(result.totalRowsProcessed).toBe(42)
  })

  it('reports the most recent sync time from the head of the list', () => {
    const result = summarize([sample({ created_at: 'newest' }), sample({ created_at: 'older' })])
    expect(result.lastSyncAt).toBe('newest')
  })
})
