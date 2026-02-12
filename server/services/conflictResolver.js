function resolveConflict(sheetRow, dbRow) {
  const sheetUpdated = sheetRow.updated_at ? new Date(sheetRow.updated_at) : new Date(0)
  const dbUpdated = dbRow.updated_at ? new Date(dbRow.updated_at) : new Date(0)
  const sheetTime = sheetUpdated.getTime()
  const dbTime = dbUpdated.getTime()
  const sheetValid = !Number.isNaN(sheetTime)
  const dbValid = !Number.isNaN(dbTime)
  if (!sheetValid && !dbValid) {
    return { winner: 'db', resolved: dbRow, sheetUpdated, dbUpdated }
  }
  if (!sheetValid) {
    return { winner: 'db', resolved: dbRow, sheetUpdated, dbUpdated }
  }
  if (!dbValid) {
    return { winner: 'sheet', resolved: sheetRow, sheetUpdated, dbUpdated }
  }
  if (sheetTime === dbTime) {
    return {
      winner: 'db',
      resolved: dbRow,
      sheetUpdated,
      dbUpdated
    }
  }
  if (sheetTime > dbTime) {
    return {
      winner: 'sheet',
      resolved: sheetRow,
      sheetUpdated,
      dbUpdated
    }
  }
  return {
    winner: 'db',
    resolved: dbRow,
    sheetUpdated,
    dbUpdated
  }
}

module.exports = {
  resolveConflict
}

