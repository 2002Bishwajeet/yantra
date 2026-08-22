/** D3 §5.7, one clock. Under 24 hours a time reads as an age; from 24 hours it
 *  reads as a date. The boundary is arbitrary and is chosen here once, so four
 *  components do not choose it four times. */

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** `title` is the exact timestamp as its source wrote it; `iso` is the machine
 *  value for `<time dateTime>`. */
export type Reading = { text: string; iso: string; title: string }

/** An age the daemon already counted. The instant is derived from the render,
 *  so the title is exact to the second the reading arrived. */
export function ago(seconds: number, now = Date.now()): Reading {
  const at = new Date(now - seconds * 1000)
  const iso = at.toISOString()
  return { text: spell(seconds, at), iso, title: iso }
}

// D3 §5.7 forbids guessing a remote clock's timezone, so a stamp that names no
// zone is a wall-clock reading rather than an instant — tmux formats `created`
// on the far machine's clock, and `new Date` would read it on the browser's.
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i

/** A timestamp another program wrote. `null` where no instant can be read out
 *  of it, which is the caller's cue to show the string as it arrived. */
export function at(stamp: string, now = Date.now()): Reading | null {
  if (!ZONED.test(stamp)) return null
  const when = new Date(stamp)
  if (Number.isNaN(when.getTime())) return null
  return {
    text: spell((now - when.getTime()) / 1000, when),
    iso: when.toISOString(),
    title: stamp,
  }
}

function spell(seconds: number, at: Date): string {
  if (seconds >= DAY) return day(at)
  if (seconds >= HOUR) return `${Math.floor(seconds / HOUR)}h`
  if (seconds >= MINUTE) return `${Math.floor(seconds / MINUTE)}m`
  return `${Math.max(0, Math.floor(seconds))}s`
}

// Composed rather than taken from `toLocaleDateString`, whose order follows the
// reader's locale: D3 names the format `7 Jul`, and only the month is localised.
function day(at: Date): string {
  const month = at.toLocaleDateString(undefined, { month: 'short' })
  return `${at.getDate()} ${month}`
}
