const { pool, getConnection } = require('../config/db')
const { getDynamicColumns, RESERVED_COLUMNS } = require('../utils/columns')
const { logError } = require('../utils/logger')

const SYNC_TABLE = 'synced_rows'
const SYNC_LOGS_TABLE = 'sync_logs'
const CONFLICT_LOGS_TABLE = 'conflict_logs'
const METADATA_TABLE = 'metadata'
const METRICS_TABLE = 'sync_metrics'

// Rows per INSERT statement. Keeps each statement well under max_allowed_packet
// while still making large syncs a handful of round trips instead of thousands.
const CHUNK_SIZE = Number(process.env.SYNC_CHUNK_SIZE || 500)

function quoteId(name) {
  return '`' + String(name).replace(/`/g, '``') + '`'
}

function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

async function initSchema() {
  const conn = await getConnection()
  try {
    await conn.query(
      `CREATE TABLE IF NOT EXISTS ${SYNC_TABLE} (
        id varchar(255) PRIMARY KEY,
        updated_at datetime NOT NULL,
        checksum varchar(64) NOT NULL,
        deleted tinyint(1) NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )

    await conn.query(
      `CREATE TABLE IF NOT EXISTS ${SYNC_LOGS_TABLE} (
        id bigint unsigned NOT NULL AUTO_INCREMENT,
        row_id varchar(255),
        source varchar(16),
        action varchar(32),
        status varchar(16),
        message text,
        created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_row_id (row_id),
        KEY idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )

    await conn.query(
      `CREATE TABLE IF NOT EXISTS ${CONFLICT_LOGS_TABLE} (
        id bigint unsigned NOT NULL AUTO_INCREMENT,
        row_id varchar(255),
        sheet_updated_at datetime,
        db_updated_at datetime,
        winner varchar(16),
        details text,
        created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_row_id (row_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )

    await conn.query(
      `CREATE TABLE IF NOT EXISTS ${METADATA_TABLE} (
        \`key\` varchar(255) NOT NULL,
        \`value\` text,
        updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`key\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )

    await conn.query(
      `CREATE TABLE IF NOT EXISTS ${METRICS_TABLE} (
        id bigint unsigned NOT NULL AUTO_INCREMENT,
        reason varchar(32),
        rows_processed int unsigned NOT NULL DEFAULT 0,
        rows_written int unsigned NOT NULL DEFAULT 0,
        duration_ms int unsigned NOT NULL DEFAULT 0,
        latency_ms int unsigned NULL,
        created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )
  } finally {
    conn.release()
  }
}

async function getExistingColumns(conn = pool) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`,
    [SYNC_TABLE]
  )
  return rows.map(r => r.COLUMN_NAME)
}

async function addMissingColumns(conn, keys) {
  const existing = await getExistingColumns(conn)
  const toAdd = keys.filter(key => !existing.includes(key))
  if (!toAdd.length) {
    return
  }
  const alters = toAdd.map(key => `ADD COLUMN ${quoteId(key)} varchar(255) NULL`).join(', ')
  await conn.query(`ALTER TABLE ${SYNC_TABLE} ${alters}`)
}

const COLUMN_DEFINITIONS = {
  id: 'varchar(255) NOT NULL',
  updated_at: 'datetime NOT NULL',
  deleted: 'tinyint(1) NOT NULL DEFAULT 0',
  checksum: 'varchar(64) NOT NULL'
}

async function getColumnsInOrder(conn = pool) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ORDINAL_POSITION`,
    [SYNC_TABLE]
  )
  return rows.map(r => r.COLUMN_NAME)
}

/**
 * Physically orders the table as id, the sheet's data columns, any columns
 * the sheet no longer has, then updated_at, deleted and checksum, so a plain
 * SELECT * reads the same way the sheet and dashboard do. Only runs an ALTER
 * when the order is actually wrong, since reordering rebuilds the table.
 */
async function reorderColumns(dynamicKeys) {
  const current = await getColumnsInOrder()
  const reserved = ['id', 'updated_at', 'deleted', 'checksum']
  const orphans = current.filter(c => !reserved.includes(c) && !dynamicKeys.includes(c))
  const desired = ['id', ...dynamicKeys.filter(k => current.includes(k)), ...orphans, 'updated_at', 'deleted', 'checksum']

  if (desired.join(',') === current.join(',')) {
    return false
  }

  const moves = desired
    .slice(1)
    .map((col, i) => `MODIFY COLUMN ${quoteId(col)} ${COLUMN_DEFINITIONS[col] || 'varchar(255) NULL'} AFTER ${quoteId(desired[i])}`)
  await pool.query(`ALTER TABLE ${SYNC_TABLE} ${moves.join(', ')}`)
  return true
}

// MySQL keeps updated_at as a real DATETIME, since conflict resolution and
// change detection compare it as a date. This view is the human-facing read
// of the same table: sheet column order, readable time.
const READABLE_VIEW = 'synced_rows_view'
let viewSignature = null

async function refreshReadableView(dynamicKeys) {
  const signature = dynamicKeys.join(',')
  if (signature === viewSignature) {
    return
  }
  const dataColumns = dynamicKeys.map(quoteId).join(', ')
  await pool.query(
    `CREATE OR REPLACE VIEW ${READABLE_VIEW} AS SELECT id${dataColumns ? `, ${dataColumns}` : ''},
       DATE_FORMAT(updated_at, '%l:%i:%s %p, %e %b %Y') AS updated_at, deleted
     FROM ${SYNC_TABLE}`
  )
  viewSignature = signature
}

async function ensureColumnsForHeaders(headers) {
  const dynamicKeys = getDynamicColumns(headers).map(c => c.key)
  if (dynamicKeys.length) {
    await addMissingColumns(pool, dynamicKeys)
  }
  await reorderColumns(dynamicKeys)
  await refreshReadableView(dynamicKeys)
}

async function getAllRows() {
  const [rows] = await pool.query(`SELECT * FROM ${SYNC_TABLE}`)
  return rows
}

async function getActiveRows() {
  const [rows] = await pool.query(`SELECT * FROM ${SYNC_TABLE} WHERE deleted = 0`)
  return rows
}

function normalizeUpdatedAt(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date() : value
  }
  if (value == null) {
    return new Date()
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

/**
 * Upserts rows in chunks inside a single transaction. Chunking matters at scale:
 * one statement per row turns a 10K row sync into 10K round trips.
 */
async function upsertRows(rows) {
  if (!rows.length) {
    return { written: 0, batches: 0 }
  }

  const dynamicKeys = [
    ...new Set(
      rows.flatMap(row => Object.keys(row).filter(key => !RESERVED_COLUMNS.includes(key)))
    )
  ]

  const conn = await getConnection()
  try {
    await conn.beginTransaction()
    await addMissingColumns(conn, dynamicKeys)

    const columns = ['id', 'updated_at', 'checksum', 'deleted', ...dynamicKeys]
    const quotedColumns = columns.map(quoteId).join(', ')
    const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`
    const updates = columns
      .filter(col => col !== 'id')
      .map(col => `${quoteId(col)}=VALUES(${quoteId(col)})`)
      .join(', ')

    const batches = chunk(rows, CHUNK_SIZE)
    for (const batch of batches) {
      const sql =
        `INSERT INTO ${SYNC_TABLE} (${quotedColumns}) ` +
        `VALUES ${batch.map(() => rowPlaceholder).join(', ')} ` +
        `ON DUPLICATE KEY UPDATE ${updates}`

      const params = batch.flatMap(row =>
        columns.map(col => {
          if (col === 'updated_at') {
            return normalizeUpdatedAt(row[col])
          }
          if (col === 'deleted') {
            return row[col] ? 1 : 0
          }
          return row[col] != null ? row[col] : null
        })
      )

      await conn.query(sql, params)
    }

    await conn.commit()
    return { written: rows.length, batches: batches.length }
  } catch (err) {
    await conn.rollback()
    logError(err)
    throw err
  } finally {
    conn.release()
  }
}

async function deleteRows(ids) {
  if (!ids.length) {
    return { deleted: 0 }
  }
  for (const batch of chunk(ids, CHUNK_SIZE)) {
    await pool.query(
      `DELETE FROM ${SYNC_TABLE} WHERE id IN (${batch.map(() => '?').join(', ')})`,
      batch
    )
  }
  return { deleted: ids.length }
}

async function writeSyncLogs(entries) {
  if (!entries.length) {
    return
  }
  try {
    for (const batch of chunk(entries, CHUNK_SIZE)) {
      await pool.query(
        `INSERT INTO ${SYNC_LOGS_TABLE} (row_id, source, action, status, message) VALUES ${batch
          .map(() => '(?, ?, ?, ?, ?)')
          .join(', ')}`,
        batch.flatMap(e => [e.row_id || null, e.source || null, e.action || null, e.status || null, e.message || null])
      )
    }
  } catch (err) {
    // Logging must never fail a sync that otherwise succeeded.
    logError(err)
  }
}

async function writeConflictLogs(entries) {
  if (!entries.length) {
    return
  }
  try {
    for (const batch of chunk(entries, CHUNK_SIZE)) {
      await pool.query(
        `INSERT INTO ${CONFLICT_LOGS_TABLE} (row_id, sheet_updated_at, db_updated_at, winner, details) VALUES ${batch
          .map(() => '(?, ?, ?, ?, ?)')
          .join(', ')}`,
        batch.flatMap(e => [
          e.row_id || null,
          e.sheet_updated_at || null,
          e.db_updated_at || null,
          e.winner || null,
          e.details || null
        ])
      )
    }
  } catch (err) {
    logError(err)
  }
}

async function recordSyncMetric({ reason, rowsProcessed, rowsWritten, durationMs, latencyMs }) {
  try {
    await pool.query(
      `INSERT INTO ${METRICS_TABLE} (reason, rows_processed, rows_written, duration_ms, latency_ms) VALUES (?, ?, ?, ?, ?)`,
      [reason || null, rowsProcessed || 0, rowsWritten || 0, durationMs || 0, latencyMs != null ? latencyMs : null]
    )
  } catch (err) {
    logError(err)
  }
}

async function getRecentMetrics(limit = 50) {
  const [rows] = await pool.query(
    `SELECT reason, rows_processed, rows_written, duration_ms, latency_ms, created_at
     FROM ${METRICS_TABLE} ORDER BY id DESC LIMIT ?`,
    [Number(limit)]
  )
  return rows
}

async function getRecentSyncLogs(limit = 50) {
  const [rows] = await pool.query(
    `SELECT row_id, source, action, status, created_at FROM ${SYNC_LOGS_TABLE} ORDER BY id DESC LIMIT ?`,
    [Number(limit)]
  )
  return rows
}

async function getMetadata(key) {
  const [rows] = await pool.query(`SELECT \`value\` FROM ${METADATA_TABLE} WHERE \`key\` = ?`, [key])
  return rows.length ? rows[0].value : null
}

async function setMetadata(key, value) {
  await pool.query(
    `INSERT INTO ${METADATA_TABLE} (\`key\`, \`value\`) VALUES (?, ?) ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`,
    [key, value]
  )
}

module.exports = {
  initSchema,
  ensureColumnsForHeaders,
  getExistingColumns,
  getAllRows,
  getActiveRows,
  upsertRows,
  deleteRows,
  writeSyncLogs,
  writeConflictLogs,
  recordSyncMetric,
  getRecentMetrics,
  getRecentSyncLogs,
  getMetadata,
  setMetadata,
  CHUNK_SIZE,
  SYNC_TABLE,
  SYNC_LOGS_TABLE,
  CONFLICT_LOGS_TABLE,
  METADATA_TABLE,
  METRICS_TABLE,
  READABLE_VIEW
}
