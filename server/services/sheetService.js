const { getSheetsClient } = require('../config/google')
const { getDynamicColumns, sanitizeColumnName } = require('../utils/columns')
const { computeChecksum } = require('../utils/checksum')
const { formatReadable, parseTimestamp, systemTimeZone } = require('../utils/time')

function getSheetConfig() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID
  let range = (process.env.GOOGLE_SHEET_RANGE || 'Sheet1').trim()
  if (!range.includes('!')) {
    range = `${range}!A:Z`
  }
  return { spreadsheetId, range }
}

// Readable timestamps carry no zone, so they are shown and read in the local
// time of the machine running the server (IST on a laptop in India).
// SYNC_TIMEZONE overrides it, e.g. when the server runs in a UTC container.
function displayTimeZone() {
  return (process.env.SYNC_TIMEZONE || '').trim() || systemTimeZone()
}

async function fetchSheet() {
  const sheets = await getSheetsClient()
  const { spreadsheetId, range } = getSheetConfig()
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range })
  const timeZone = displayTimeZone()
  const values = res.data.values || []
  if (!values.length) {
    return { headers: [], rows: [], timeZone }
  }
  return { headers: values[0], rows: values.slice(1), timeZone }
}

// The dashboard hits /data/sheet and /data/db at the same time and both need
// the sheet headers. A short TTL plus in-flight sharing collapses that into one
// Google API call, which matters now that the dashboard refreshes on every
// sync. The sync engine deliberately does not use this: it must always read
// the sheet fresh.
const READ_CACHE_TTL_MS = Number(process.env.SHEET_CACHE_TTL_MS || 2000)
let cache = null
let inFlight = null

async function fetchSheetCached() {
  if (cache && Date.now() - cache.at < READ_CACHE_TTL_MS) {
    return cache.value
  }
  if (inFlight) {
    return inFlight
  }

  inFlight = fetchSheet()
    .then(value => {
      cache = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

function clearSheetCache() {
  cache = null
}

function toRowObjects(headers, rows, timeZone = displayTimeZone()) {
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
    const updatedAt = parseTimestamp(updatedRaw, timeZone) || new Date()
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

async function writeRowsToSheet(headers, rows, timeZone = displayTimeZone()) {
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
        cells.push(row.updated_at ? formatReadable(row.updated_at, timeZone) : '')
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

  // Anything we just wrote makes a cached read stale.
  clearSheetCache()
}

// id first, then the data columns, then the bookkeeping columns.
function orderedSheetHeaders(headers) {
  return ['id', ...getDynamicColumns(headers).map(c => c.header), 'updated_at', 'deleted']
}

module.exports = {
  orderedSheetHeaders,
  fetchSheet,
  fetchSheetCached,
  clearSheetCache,
  toRowObjects,
  writeRowsToSheet
}

