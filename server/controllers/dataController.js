const { fetchSheet, toRowObjects } = require('../services/sheetService')
const { getActiveRows } = require('../services/dbService')

async function getSheetData(req, res) {
  try {
    const { headers, rows } = await fetchSheet()
    const objects = toRowObjects(headers, rows)
    res.json({ headers, rows: objects })
  } catch (err) {
    res.status(500).json({ error: 'failed_to_load_sheet_data' })
  }
}

async function getDbData(req, res) {
  try {
    const rows = await getActiveRows()
    const rowsWithoutChecksum = rows.map(({ checksum, ...row }) => row)
    res.json({ rows: rowsWithoutChecksum })
  } catch (err) {
    res.status(500).json({ error: 'failed_to_load_db_data' })
  }
}

module.exports = {
  getSheetData,
  getDbData
}

