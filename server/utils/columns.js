const RESERVED_COLUMNS = ['id', 'updated_at', 'checksum', 'deleted']

function sanitizeColumnName(name) {
  const trimmed = String(name || '').trim().toLowerCase()
  let normalized = trimmed.replace(/[^a-z0-9]+/g, '_')
  if (/^[0-9]/.test(normalized)) {
    normalized = `col_${normalized}`
  }
  if (!normalized) {
    normalized = 'col_unnamed'
  }
  return normalized
}

function getDynamicColumns(headers) {
  const result = []
  headers.forEach(header => {
    const original = String(header || '').trim()
    if (!original) {
      return
    }
    const key = sanitizeColumnName(original)
    if (!RESERVED_COLUMNS.includes(key) && !result.find(c => c.key === key)) {
      result.push({ key, header: original })
    }
  })
  return result
}

module.exports = {
  RESERVED_COLUMNS,
  sanitizeColumnName,
  getDynamicColumns
}

