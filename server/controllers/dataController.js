const { fetchSheet, toRowObjects } = require('../services/sheetService')
const { getActiveRows } = require('../services/dbService')
const { getDynamicColumns } = require('../utils/columns')

async function getSheetData(req, res) {
  try {
    const { headers, rows } = await fetchSheet()
    const objects = toRowObjects(headers, rows)
    res.json({ headers, rows: objects })
  } catch (err) {
    res.status(500).json({ error: 'failed_to_load_sheet_data' })
  }
}

function getAllowedColumnKeys(headers) {
  if (!headers || !headers.length) return null
  const dynamic = getDynamicColumns(headers)
  const keys = new Set(['id', 'updated_at', 'deleted'])
  dynamic.forEach(c => keys.add(c.key))
  return keys
}

async function getDbData(req, res) {
  try {
    const rows = await getActiveRows()
    let headers = null
    try {
      const sheet = await fetchSheet()
      headers = sheet.headers
    } catch (_) {}
    const allowedKeys = getAllowedColumnKeys(headers)
    const rowsWithoutChecksum = rows.map(row => {
      const { checksum, ...rest } = row
      if (allowedKeys) {
        const filtered = {}
        Object.keys(rest).forEach(k => {
          if (allowedKeys.has(k)) filtered[k] = rest[k]
        })
        return filtered
      }
      return rest
    })
    res.json({ rows: rowsWithoutChecksum })
  } catch (err) {
    res.status(500).json({ error: 'failed_to_load_db_data' })
  }
}

module.exports = {
  getSheetData,
  getDbData
}

