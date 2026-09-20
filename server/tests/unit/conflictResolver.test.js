const { resolveConflict } = require('../../services/conflictResolver')

const sheetRow = { id: '1', name: 'sheet', updated_at: '2024-06-02T00:00:00.000Z' }
const dbRow = { id: '1', name: 'db', updated_at: '2024-06-01T00:00:00.000Z' }

describe('resolveConflict', () => {
  it('picks the side with the newer updated_at', () => {
    expect(resolveConflict(sheetRow, dbRow).winner).toBe('sheet')
    expect(resolveConflict({ ...sheetRow, updated_at: '2024-05-01T00:00:00.000Z' }, dbRow).winner).toBe('db')
  })

  it('returns the winning row as resolved', () => {
    expect(resolveConflict(sheetRow, dbRow).resolved).toBe(sheetRow)
  })

  it('breaks ties in favour of the DB', () => {
    const at = '2024-06-01T00:00:00.000Z'
    const result = resolveConflict({ ...sheetRow, updated_at: at }, { ...dbRow, updated_at: at })
    expect(result.winner).toBe('db')
  })

  it('prefers the side with a usable timestamp when the other is unparseable', () => {
    expect(resolveConflict({ ...sheetRow, updated_at: 'not-a-date' }, dbRow).winner).toBe('db')
    expect(resolveConflict(sheetRow, { ...dbRow, updated_at: 'not-a-date' }).winner).toBe('sheet')
  })

  it('falls back to the DB when neither side has a usable timestamp', () => {
    const result = resolveConflict({ ...sheetRow, updated_at: 'nope' }, { ...dbRow, updated_at: 'nope' })
    expect(result.winner).toBe('db')
  })

  it('treats a missing timestamp as the epoch rather than throwing', () => {
    const result = resolveConflict({ ...sheetRow, updated_at: null }, dbRow)
    expect(result.winner).toBe('db')
    expect(result.sheetUpdated.getTime()).toBe(0)
  })

  it('reports both timestamps it compared', () => {
    const result = resolveConflict(sheetRow, dbRow)
    expect(result.sheetUpdated).toBeInstanceOf(Date)
    expect(result.dbUpdated).toBeInstanceOf(Date)
    expect(result.sheetUpdated.getTime()).toBeGreaterThan(result.dbUpdated.getTime())
  })
})
