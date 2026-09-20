const { getRecentMetrics, getRecentSyncLogs } = require('../services/dbService')
const { getRunnerStatus } = require('../services/runner')

function percentile(sortedValues, p) {
  if (!sortedValues.length) {
    return null
  }
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1)
  return sortedValues[Math.max(0, index)]
}

function summarize(rows) {
  if (!rows.length) {
    return { samples: 0 }
  }

  const latencies = rows
    .map(r => r.latency_ms)
    .filter(v => v != null)
    .map(Number)
    .sort((a, b) => a - b)

  const durations = rows.map(r => Number(r.duration_ms)).sort((a, b) => a - b)

  // Throughput is measured only over syncs that actually moved rows; counting
  // no-op syncs would make the number meaningless.
  const working = rows.filter(r => Number(r.rows_processed) > 0 && Number(r.duration_ms) > 0)
  const rowsPerSecond = working.length
    ? Math.round(
        working.reduce((acc, r) => acc + (Number(r.rows_processed) / Number(r.duration_ms)) * 1000, 0) /
          working.length
      )
    : null

  return {
    samples: rows.length,
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length ? latencies[latencies.length - 1] : null,
      samples: latencies.length
    },
    durationMs: {
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations[durations.length - 1]
    },
    rowsPerSecond,
    totalRowsProcessed: rows.reduce((acc, r) => acc + Number(r.rows_processed), 0),
    lastSyncAt: rows[0] ? rows[0].created_at : null
  }
}

async function getMetrics(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500)
    const rows = await getRecentMetrics(limit)
    res.json({
      summary: summarize(rows),
      runner: await getRunnerStatus(),
      recent: rows
    })
  } catch (err) {
    res.status(500).json({ error: 'failed_to_load_metrics' })
  }
}

async function getActivity(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    res.json({ logs: await getRecentSyncLogs(limit) })
  } catch (err) {
    res.status(500).json({ error: 'failed_to_load_activity' })
  }
}

module.exports = {
  getMetrics,
  getActivity,
  summarize
}
