const { formatReadable, parseTimestamp } = require('../../utils/time')

const IST = 'Asia/Kolkata'

describe('formatReadable', () => {
  it('formats in the given zone as "h:mm:ss AM, d Mon yyyy"', () => {
    expect(formatReadable(new Date('2026-09-09T11:09:12Z'), IST)).toBe('4:39:12 PM, 9 Sep 2026')
  })

  it('renders midnight and noon as 12, not 0', () => {
    expect(formatReadable(new Date('2026-09-08T18:30:05Z'), IST)).toBe('12:00:05 AM, 9 Sep 2026')
    expect(formatReadable(new Date('2026-09-09T06:30:00Z'), IST)).toBe('12:00:00 PM, 9 Sep 2026')
  })

  it('returns an empty string for an invalid date', () => {
    expect(formatReadable('nope', IST)).toBe('')
  })
})

describe('parseTimestamp', () => {
  it('round-trips the readable form exactly, to the second', () => {
    const d = new Date('2026-09-09T11:09:12Z')
    expect(parseTimestamp(formatReadable(d, IST), IST).toISOString()).toBe(d.toISOString())
  })

  it('reads the looser typed form, like "4:39pm on 9th sep 2026"', () => {
    expect(parseTimestamp('4:39pm on 9th sep 2026', IST).toISOString()).toBe('2026-09-09T11:09:00.000Z')
  })

  it('treats the readable form as wall-clock time in the given zone', () => {
    const text = '4:39:12 PM, 9 Sep 2026'
    expect(parseTimestamp(text, 'UTC').toISOString()).toBe('2026-09-09T16:39:12.000Z')
    expect(parseTimestamp(text, IST).toISOString()).toBe('2026-09-09T11:09:12.000Z')
  })

  it('round-trips across a DST change', () => {
    const d = new Date('2026-03-29T01:30:00Z')
    expect(parseTimestamp(formatReadable(d, 'Europe/London'), 'Europe/London').toISOString()).toBe(d.toISOString())
  })

  it('still accepts ISO strings from older rows and SQL', () => {
    expect(parseTimestamp('2026-09-25T08:15:55.000Z', IST).toISOString()).toBe('2026-09-25T08:15:55.000Z')
  })

  it('passes a valid Date through and rejects blanks and garbage', () => {
    const d = new Date('2026-01-01T00:00:00Z')
    expect(parseTimestamp(d, IST)).toBe(d)
    expect(parseTimestamp('', IST)).toBeNull()
    expect(parseTimestamp(null, IST)).toBeNull()
    expect(parseTimestamp('not a date', IST)).toBeNull()
  })

  it('rejects an impossible hour instead of guessing', () => {
    expect(parseTimestamp('13:00 PM, 9 Sep 2026', IST)).toBeNull()
  })
})
