const crypto = require('crypto')

function canonicalizeRow(row) {
  const entries = Object.entries(row).filter(([key]) => key !== 'updated_at' && key !== 'checksum')
  const sorted = entries.sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0))
  return JSON.stringify(sorted)
}

function computeChecksum(row) {
  const canonical = canonicalizeRow(row)
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

module.exports = {
  computeChecksum
}

