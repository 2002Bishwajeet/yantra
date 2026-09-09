import type { Reading } from '@/api/hooks'
import { ago } from '@/lib/time'

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The boards' duration face: `3h 41m` for a session, an age under an hour,
 *  and D3 §5.7's date past a day. */
export function elapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < MINUTE) return `${s}s`
  if (s < HOUR) return `${Math.floor(s / MINUTE)}m`
  if (s < DAY) {
    const hours = Math.floor(s / HOUR)
    const minutes = Math.floor((s % HOUR) / MINUTE)
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`
  }
  return ago(s).text
}

/** Whether `elapsed` still counts, or has given the day instead. A date takes
 *  no `ago` after it: the boards write `opened 3d ago` beside `opened 9 Jun`. */
export function isAge(seconds: number): boolean {
  return seconds < DAY
}

/** D3 §4.3: the page's age is the **oldest** of its reads, never an average.
 *  `null` while any read is still pending or was never made. */
export function oldest(reads: Reading<unknown>[]): number | null {
  let age: number | null = null
  for (const read of reads) {
    if (read.looked === 'pending' || read.looked === 'never') return null
    age = Math.max(age ?? 0, read.age_seconds)
  }
  return age
}
