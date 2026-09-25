// Human-readable timestamps for the sheet, e.g. "4:39:12 PM, 9 Sep 2026".
//
// The readable form carries no timezone, so formatting and parsing both take an
// explicit IANA zone (the spreadsheet's own). Seconds are kept on purpose: at
// minute precision two edits in the same minute would tie, and ties resolve
// in the database's favour.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const READABLE_PATTERN =
  /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*,?\s*(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})\s*$/i

function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(date)
  const out = {}
  parts.forEach(p => {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  })
  return out
}

// Milliseconds the zone is ahead of UTC at the given instant.
function zoneOffset(timestamp, timeZone) {
  const p = zonedParts(new Date(timestamp), timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(timestamp / 1000) * 1000
}

// Wall-clock time in a zone to the real instant. The second pass corrects for
// a DST change sitting between the guess and the answer.
function zonedToInstant({ year, month, day, hour, minute, second }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const first = guess - zoneOffset(guess, timeZone)
  return new Date(guess - zoneOffset(first, timeZone))
}

function formatReadable(value, timeZone = systemTimeZone()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const p = zonedParts(date, timeZone)
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12
  const period = p.hour < 12 ? 'AM' : 'PM'
  const mm = String(p.minute).padStart(2, '0')
  const ss = String(p.second).padStart(2, '0')
  const month = MONTHS[p.month - 1]
  return `${hour12}:${mm}:${ss} ${period}, ${p.day} ${month[0].toUpperCase()}${month.slice(1)} ${p.year}`
}

function parseReadable(text, timeZone) {
  const m = READABLE_PATTERN.exec(String(text))
  if (!m) {
    return null
  }
  const [, h, min, sec, period, day, monthName, year] = m
  const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) + 1
  let hour = Number(h)
  if (!month || hour < 1 || hour > 12) {
    return null
  }
  if (period.toLowerCase() === 'p' && hour !== 12) hour += 12
  if (period.toLowerCase() === 'a' && hour === 12) hour = 0
  return zonedToInstant(
    { year: Number(year), month, day: Number(day), hour, minute: Number(min), second: Number(sec || 0) },
    timeZone
  )
}

/**
 * Accepts the readable form, ISO strings and Date objects. Returns null for
 * anything blank or unparseable so callers choose their own fallback.
 */
function parseTimestamp(value, timeZone = systemTimeZone()) {
  if (value == null || value === '') {
    return null
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  const readable = parseReadable(value, timeZone)
  if (readable) {
    return readable
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

module.exports = {
  formatReadable,
  parseTimestamp,
  systemTimeZone
}
