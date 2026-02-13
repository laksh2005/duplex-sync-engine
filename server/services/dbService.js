const { pool, getConnection } = require('../config/db')
const { getDynamicColumns, RESERVED_COLUMNS } = require('../utils/columns')
const { logError } = require('../utils/logger')

const SYNC_TABLE = 'synced_rows'
const SYNC_LOGS_TABLE = 'sync_logs'
const CONFLICT_LOGS_TABLE = 'conflict_logs'
const METADATA_TABLE = 'metadata'

function quoteId(name) {
  return '`' + String(name).replace(/`/g, '``') + '`'
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
        KEY idx_row_id (row_id)
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
  } finally {
    conn.release()
  }
}

async function getExistingColumns() {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`,
    [SYNC_TABLE]
  )
  return rows.map(r => r.COLUMN_NAME)
}

async function ensureColumnsForHeaders(headers) {
  const dynamicColumns = getDynamicColumns(headers)
  if (!dynamicColumns.length) {
    return
  }
  const existing = await getExistingColumns()
  const toAdd = dynamicColumns.filter(c => !existing.includes(c.key))
  if (!toAdd.length) {
    return
  }
  const alters = toAdd
    .map(c => `ADD COLUMN ${quoteId(c.key)} varchar(255) NULL`)
    .join(', ')
  await pool.query(`ALTER TABLE ${SYNC_TABLE} ${alters}`)
}

async function getAllRows() {
  const [rows] = await pool.query(`SELECT * FROM ${SYNC_TABLE}`)
  return rows
}

async function getActiveRows() {
  const [rows] = await pool.query(`SELECT * FROM ${SYNC_TABLE} WHERE deleted = 0`)
  return rows
}

async function upsertRows(rows) {
  if (!rows.length) {
    return
  }
  const conn = await getConnection()
  try {
    await conn.beginTransaction()

    const existingColumns = await getExistingColumns()
    const dynamicKeys = Object.keys(
      rows.reduce((acc, row) => {
        Object.keys(row).forEach(key => {
          if (!RESERVED_COLUMNS.includes(key)) {
            acc[key] = true
          }
        })
        return acc
      }, {})
    )

    const toAdd = dynamicKeys.filter(k => !existingColumns.includes(k))
    if (toAdd.length) {
      const alters = toAdd.map(k => `ADD COLUMN ${quoteId(k)} varchar(255) NULL`).join(', ')
      await conn.query(`ALTER TABLE ${SYNC_TABLE} ${alters}`)
    }

    const columns = ['id', 'updated_at', 'checksum', 'deleted', ...dynamicKeys]
    const quotedColumns = columns.map(quoteId)
    const placeholders = columns.map(() => '?').join(', ')
    const updates = columns
      .filter(c => c !== 'id')
      .map(c => `${quoteId(c)}=VALUES(${quoteId(c)})`)
      .join(', ')

    const sql = `INSERT INTO ${SYNC_TABLE} (${quotedColumns.join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`

    const batch = rows.map(row =>
      columns.map(col => {
        if (col === 'updated_at') {
          // Ensure updated_at is always a valid Date object
          if (row[col] instanceof Date) {
            return row[col]
          }
          if (row[col] != null) {
            const date = new Date(row[col])
            // If date is invalid, use current date
            return isNaN(date.getTime()) ? new Date() : date
          }
          // Default to current date if null/undefined
          return new Date()
        }
        return row[col] != null ? row[col] : null
      })
    )

    await conn.query(sql, batch.flat())

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    logError(err)
    throw err
  } finally {
    conn.release()
  }
}

async function deleteRow(id) {
  await pool.query(`DELETE FROM ${SYNC_TABLE} WHERE id = ?`, [id])
}

async function writeSyncLog(entry) {
  const { row_id, source, action, status, message } = entry
  try {
    await pool.query(
      `INSERT INTO ${SYNC_LOGS_TABLE} (row_id, source, action, status, message) VALUES (?, ?, ?, ?, ?)`,
      [row_id || null, source || null, action || null, status || null, message || null]
    )
  } catch (err) {
    logError(err)
  }
}

async function writeConflictLog(entry) {
  const { row_id, sheet_updated_at, db_updated_at, winner, details } = entry
  try {
    await pool.query(
      `INSERT INTO ${CONFLICT_LOGS_TABLE} (row_id, sheet_updated_at, db_updated_at, winner, details) VALUES (?, ?, ?, ?, ?)`,
      [row_id || null, sheet_updated_at || null, db_updated_at || null, winner || null, details || null]
    )
  } catch (err) {
    logError(err)
  }
}

async function getMetadata(key) {
  const [rows] = await pool.query(`SELECT \`value\` FROM ${METADATA_TABLE} WHERE \`key\` = ?`, [key])
  if (!rows.length) {
    return null
  }
  return rows[0].value
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
  getAllRows,
  getActiveRows,
  upsertRows,
  deleteRow,
  writeSyncLog,
  writeConflictLog,
  getMetadata,
  setMetadata,
  SYNC_TABLE,
  SYNC_LOGS_TABLE,
  CONFLICT_LOGS_TABLE,
  METADATA_TABLE
}

