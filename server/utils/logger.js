const SILENT = process.env.LOG_SILENT === '1' || process.env.NODE_ENV === 'test'

function stamp() {
  return new Date().toISOString()
}

function logError(err) {
  if (!err || SILENT) {
    return
  }
  console.error(`[${stamp()}] error:`, err instanceof Error ? err.stack || err.message : err)
}

function logInfo(message) {
  if (SILENT) {
    return
  }
  console.log(`[${stamp()}] ${message}`)
}

function logWarn(message) {
  if (SILENT) {
    return
  }
  console.warn(`[${stamp()}] warn: ${message}`)
}

module.exports = {
  logError,
  logInfo,
  logWarn
}
