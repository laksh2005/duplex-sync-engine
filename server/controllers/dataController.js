const { fetchSheetCached, toRowObjects } = require('../services/sheetService')
const { getActiveRows } = require('../services/dbService')
const { getDynamicColumns } = require('../utils/columns')
const { logError } = require('../utils/logger')

async function getSheetData(req, res) {
  try {
    const { headers, rows } = await fetchSheetCached()
    res.json({ headers, rows: toRowObjects(headers, rows) })
  } catch (err) {
    logError(err)
    res.status(500).json({ error: 'failed_to_load_sheet_data' })
  }
}

// The DB table accumulates a column for every header the sheet has ever had, so
// the dashboard is shown only the columns the sheet currently defines.
function getAllowedColumnKeys(headers) {
  if (!headers || !headers.length) {
    return null
  }
  const keys = new Set(['id', 'updated_at', 'deleted'])
  getDynamicColumns(headers).forEach(column => keys.add(column.key))
  return keys
}

async function getDbData(req, res) {
  try {
    const rows = await getActiveRows()

    let headers = null
    try {
      headers = (await fetchSheetCached()).headers
    } catch (err) {
      // The DB view is still useful when the sheet is unreachable; fall back to
      // showing whatever columns the table has.
      logError(err)
    }

    const allowedKeys = getAllowedColumnKeys(headers)

    const visibleRows = rows.map(row => {
      const projected = {}
      Object.keys(row).forEach(key => {
        if (key === 'checksum') {
          return
        }
        if (!allowedKeys || allowedKeys.has(key)) {
          projected[key] = row[key]
        }
      })
      return projected
    })

    res.json({ rows: visibleRows })
  } catch (err) {
    logError(err)
    res.status(500).json({ error: 'failed_to_load_db_data' })
  }
}

module.exports = {
  getSheetData,
  getDbData,
  getAllowedColumnKeys
}
