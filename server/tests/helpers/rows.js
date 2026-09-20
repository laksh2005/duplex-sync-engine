const { computeChecksum } = require('../../utils/checksum')

// Builds a row shaped the way sheetService/dbService produce them, with a
// checksum derived from the content so equality checks behave realistically.
function makeRow({ id, updated_at = '2024-01-01T00:00:00.000Z', deleted = 0, ...fields }) {
  const row = { id: String(id), updated_at: new Date(updated_at), deleted, ...fields }
  row.checksum = computeChecksum(row)
  return row
}

function idsOf(rows) {
  return rows.map(row => String(row.id))
}

module.exports = { makeRow, idsOf }
