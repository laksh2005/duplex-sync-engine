const { differs } = require('../../services/changeDetector')

const base = { rowCount: 3, contentHash: 'abc', maxUpdatedAt: 1000 }

describe('changeDetector.differs', () => {
  it('is false when nothing changed', () => {
    expect(differs(base, { ...base })).toBe(false)
  })

  it('is true when row count changes', () => {
    expect(differs(base, { ...base, rowCount: 4 })).toBe(true)
  })

  it('is true when the content hash changes', () => {
    expect(differs(base, { ...base, contentHash: 'xyz' })).toBe(true)
  })

  it('is true when only maxUpdatedAt changes', () => {
    // Regression: a write that bumps updated_at without recomputing the
    // checksum column (a manual SQL edit, a script, anything outside this
    // app's own upsert path) must still be detected. contentHash alone
    // missed this because it hashes the checksum column, not the row's
    // real content.
    expect(differs(base, { ...base, maxUpdatedAt: 2000 })).toBe(true)
  })

  it('is false when either side is missing, so the first tick just seeds the baseline', () => {
    expect(differs(null, base)).toBe(false)
    expect(differs(base, null)).toBe(false)
  })
})
