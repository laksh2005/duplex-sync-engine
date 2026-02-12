const { getSheetsClient } = require('../config/google')
const { getDynamicColumns, sanitizeColumnName } = require('../utils/columns')
const { computeChecksum } = require('../utils/checksum')

function getSheetConfig() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID
  const range = process.env.GOOGLE_SHEET_RANGE || 'Sheet1'
  return { spreadsheetId, range }
}

async function fetchSheet() {
  const sheets = await getSheetsClient()
  const { spreadsheetId, range } = getSheetConfig()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  })
  const values = res.data.values || []
  if (!values.length) {
    return { headers: [], rows: [] }
  }
  const headers = values[0]
  const rows = values.slice(1)
  return { headers, rows }
}

function toRowObjects(headers, rows) {
  const objects = []
  const dynamicColumns = getDynamicColumns(headers)
  const headerIndex = headers.reduce((acc, header, idx) => {
    const key = sanitizeColumnName(header)
    acc[key] = idx
    return acc
  }, {})
  const idColKey = headerIndex.id != null ? 'id' : headerIndex.row_id != null ? 'row_id' : null
  const idIndex = idColKey != null ? headerIndex[idColKey] : -1
  if (idIndex < 0) {
    return objects
  }
  rows.forEach(cells => {
    const idRaw = idIndex >= 0 && cells[idIndex] != null ? cells[idIndex] : undefined
    const id = idRaw != null && String(idRaw).trim() !== '' ? String(idRaw).trim() : undefined
    if (!id) {
      return
    }
    const updatedIndex = headerIndex.updated_at
    const deletedIndex = headerIndex.deleted
    const updatedRaw = updatedIndex != null ? cells[updatedIndex] : undefined
    const updatedAt = updatedRaw ? new Date(updatedRaw) : new Date()
    const deletedRaw = deletedIndex != null ? cells[deletedIndex] : undefined
    const deleted = deletedRaw === '1' || deletedRaw === 1 || deletedRaw === true ? 1 : 0
    const obj = { id: String(id), updated_at: updatedAt, deleted }
    dynamicColumns.forEach(col => {
      const idx = headerIndex[col.key]
      obj[col.key] = idx != null ? cells[idx] || null : null
    })
    obj.checksum = computeChecksum(obj)
    objects.push(obj)
  })
  return objects
}

async function writeRowsToSheet(headers, rows) {
  const sheets = await getSheetsClient()
  const { spreadsheetId, range } = getSheetConfig()
  const finalHeaders = headers
  const values = [finalHeaders]
  rows.forEach(row => {
    const cells = []
    finalHeaders.forEach(header => {
      const key = sanitizeColumnName(header)
      if (key === 'id') {
        cells.push(row.id != null ? String(row.id) : '')
      } else if (key === 'updated_at') {
        cells.push(row.updated_at ? new Date(row.updated_at).toISOString() : '')
      } else if (key === 'deleted') {
        cells.push(row.deleted ? '1' : '0')
      } else {
        cells.push(row[key] != null ? String(row[key]) : '')
      }
    })
    values.push(cells)
  })
  // Clear range first so that rows we no longer include (e.g. deleted from DB) are removed from the sheet
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range
  })
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: {
      values
    }
  })
}

module.exports = {
  fetchSheet,
  toRowObjects,
  writeRowsToSheet
}

