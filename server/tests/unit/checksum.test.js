const { computeChecksum } = require('../../utils/checksum')

describe('computeChecksum', () => {
  it('is stable for the same content', () => {
    const row = { id: '1', name: 'alice', email: 'a@example.com' }
    expect(computeChecksum(row)).toBe(computeChecksum({ ...row }))
  })

  it('does not depend on key order', () => {
    expect(computeChecksum({ id: '1', a: 'x', b: 'y' })).toBe(computeChecksum({ b: 'y', id: '1', a: 'x' }))
  })

  it('changes when a value changes', () => {
    expect(computeChecksum({ id: '1', name: 'alice' })).not.toBe(computeChecksum({ id: '1', name: 'bob' }))
  })

  it('ignores updated_at so a touch without an edit is not a change', () => {
    const base = { id: '1', name: 'alice' }
    const a = computeChecksum({ ...base, updated_at: '2024-01-01T00:00:00.000Z' })
    const b = computeChecksum({ ...base, updated_at: '2025-01-01T00:00:00.000Z' })
    expect(a).toBe(b)
  })

  it('ignores an existing checksum field so it can be recomputed in place', () => {
    const base = { id: '1', name: 'alice' }
    expect(computeChecksum({ ...base, checksum: 'stale' })).toBe(computeChecksum(base))
  })

  it('returns a sha256 hex digest', () => {
    expect(computeChecksum({ id: '1' })).toMatch(/^[a-f0-9]{64}$/)
  })
})
