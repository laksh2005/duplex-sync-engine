const { sanitizeColumnName, getDynamicColumns, RESERVED_COLUMNS } = require('../../utils/columns')

describe('sanitizeColumnName', () => {
  it('lowercases and underscores arbitrary header text', () => {
    expect(sanitizeColumnName('First Name')).toBe('first_name')
    expect(sanitizeColumnName('  Email Address  ')).toBe('email_address')
    expect(sanitizeColumnName('Total ($)')).toBe('total_')
  })

  it('prefixes headers that start with a digit so they are valid identifiers', () => {
    expect(sanitizeColumnName('2024 Revenue')).toBe('col_2024_revenue')
  })

  it('falls back to a placeholder for empty or symbol-only headers', () => {
    expect(sanitizeColumnName('')).toBe('col_unnamed')
    expect(sanitizeColumnName('   ')).toBe('col_unnamed')
    expect(sanitizeColumnName(null)).toBe('col_unnamed')
  })

  it('strips characters that would need quoting in SQL', () => {
    expect(sanitizeColumnName('name`; DROP TABLE users--')).toBe('name_drop_table_users_')
  })
})

describe('getDynamicColumns', () => {
  it('returns non-reserved headers with their original label', () => {
    expect(getDynamicColumns(['id', 'First Name', 'email'])).toEqual([
      { key: 'first_name', header: 'First Name' },
      { key: 'email', header: 'email' }
    ])
  })

  it('excludes every reserved column', () => {
    expect(getDynamicColumns(RESERVED_COLUMNS)).toEqual([])
  })

  it('drops blank headers', () => {
    expect(getDynamicColumns(['id', '', '   ', 'name'])).toEqual([{ key: 'name', header: 'name' }])
  })

  it('keeps only the first header that maps to a given column key', () => {
    expect(getDynamicColumns(['First Name', 'first name', 'FIRST_NAME'])).toEqual([
      { key: 'first_name', header: 'First Name' }
    ])
  })
})
