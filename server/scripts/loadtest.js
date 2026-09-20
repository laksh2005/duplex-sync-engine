#!/usr/bin/env node
/**
 * Measures the two parts of a sync that actually scale with row count: the
 * planner (pure CPU) and the batched MySQL write path.
 *
 * The Google Sheets leg is deliberately excluded. It is a fixed number of API
 * calls regardless of row count and is dominated by network round trips, so
 * including it would measure Google's latency rather than this engine.
 *
 * Usage:
 *   node scripts/loadtest.js                # 10,000 rows
 *   node scripts/loadtest.js --rows 50000
 *   node scripts/loadtest.js --rows 10000 --skip-db
 */
require('../config/env')

const { computeSyncPlan } = require('../services/syncPlanner')
const { computeChecksum } = require('../utils/checksum')

function parseArgs(argv) {
  const args = { rows: 10000, skipDb: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--rows') {
      args.rows = Number(argv[i + 1]) || args.rows
      i += 1
    }
    if (argv[i] === '--skip-db') {
      args.skipDb = true
    }
  }
  return args
}

function makeRows(count, prefix) {
  return Array.from({ length: count }, (_, i) => {
    const row = {
      id: `${prefix}-${i}`,
      updated_at: new Date(Date.now() - i * 1000),
      deleted: 0,
      name: `Person ${i}`,
      email: `person${i}@example.com`,
      city: i % 2 === 0 ? 'Delhi' : 'Mumbai'
    }
    row.checksum = computeChecksum(row)
    return row
  })
}

function rate(rows, ms) {
  return ms > 0 ? Math.round(rows / (ms / 1000)) : 0
}

function report(label, rows, ms) {
  console.log(
    `  ${label.padEnd(34)} ${String(rows).padStart(7)} rows  ` +
      `${(ms / 1000).toFixed(2).padStart(7)}s  ${String(rate(rows, ms)).padStart(8)} rows/s`
  )
}

async function timeIt(fn) {
  const start = process.hrtime.bigint()
  const value = await fn()
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, value }
}

async function runPlannerBenchmarks(count) {
  console.log(`\nPlanner (pure, no I/O)`)

  const sheetRows = makeRows(count, 'row')

  const allNew = await timeIt(() => computeSyncPlan({ sheetRows, dbRows: [], lastSyncedIds: null }))
  report('all new, first sync', count, allNew.ms)

  const dbRows = sheetRows.map(row => ({ ...row }))
  const knownIds = new Set(sheetRows.map(r => r.id))

  const noChanges = await timeIt(() => computeSyncPlan({ sheetRows, dbRows, lastSyncedIds: knownIds }))
  report('steady state, no changes', count, noChanges.ms)

  const conflicted = dbRows.map(row => ({ ...row, checksum: `${row.checksum}-differs` }))
  const allConflicts = await timeIt(() =>
    computeSyncPlan({ sheetRows, dbRows: conflicted, lastSyncedIds: knownIds })
  )
  report('every row conflicting', count, allConflicts.ms)

  return { allNew: allNew.ms, noChanges: noChanges.ms, allConflicts: allConflicts.ms }
}

async function runDbBenchmarks(count) {
  const db = require('../services/dbService')
  const { pool } = require('../config/db')

  console.log(`\nMySQL write path (chunk size ${db.CHUNK_SIZE})`)

  await db.initSchema()
  await pool.query(`DELETE FROM ${db.SYNC_TABLE} WHERE id LIKE 'load-%'`)

  const rows = makeRows(count, 'load')

  const insert = await timeIt(() => db.upsertRows(rows))
  report(`insert (${insert.value.batches} statements)`, count, insert.ms)

  const update = await timeIt(() =>
    db.upsertRows(rows.map(row => ({ ...row, name: `${row.name} updated` })))
  )
  report('update the same rows', count, update.ms)

  const read = await timeIt(() => db.getAllRows())
  report('read all rows back', read.value.length, read.ms)

  const remove = await timeIt(() => db.deleteRows(rows.map(r => r.id)))
  report('delete', count, remove.ms)

  await pool.end()

  return { insert: insert.ms, update: update.ms, read: read.ms, remove: remove.ms }
}

async function main() {
  const { rows, skipDb } = parseArgs(process.argv.slice(2))

  console.log(`parity load test`)
  console.log(`rows: ${rows.toLocaleString()}   node: ${process.version}`)

  const planner = await runPlannerBenchmarks(rows)

  let dbResults = null
  if (skipDb) {
    console.log('\nMySQL write path skipped (--skip-db)')
  } else {
    try {
      dbResults = await runDbBenchmarks(rows)
    } catch (err) {
      console.log(`\nMySQL write path skipped: ${err.message}`)
      console.log('  Start MySQL (docker compose up mysql) or pass --skip-db.')
    }
  }

  console.log('\nHeadline')
  console.log(`  planner: ${rows.toLocaleString()} rows in ${(planner.allNew / 1000).toFixed(2)}s`)
  if (dbResults) {
    console.log(`  MySQL insert: ${rows.toLocaleString()} rows in ${(dbResults.insert / 1000).toFixed(2)}s`)
    const endToEnd = planner.allNew + dbResults.insert
    console.log(
      `  plan + write: ${rows.toLocaleString()} rows in ${(endToEnd / 1000).toFixed(2)}s ` +
        `(${rate(rows, endToEnd).toLocaleString()} rows/s)`
    )
  }
  console.log('')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
