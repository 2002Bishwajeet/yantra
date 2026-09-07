import { useState } from 'react'
import type { Band, WorkRow } from '@/work'

/** D3 §4.4: rows update in place every 5 s, and **the order recomputes only
 *  when you ask**. Between the change and the tap a row shows its true state
 *  inside the group it had when the order was last computed, and the Reorder
 *  pill is what stops that being a lie.
 *
 *  Two things are never held. A row nobody has seen before takes its live
 *  band at once, and a row still in *Not read yet* leaves it the moment its
 *  first read arrives — holding it there would say *unread* about something
 *  that has been read (R-23). */
export function useHeldBands(rows: WorkRow[]) {
  // Not the bands, or every poll would re-seed and nothing would be held.
  const seeds = rows
    .map((row) => `${row.id} ${row.band === 'unknown' ? 'unread' : 'read'}`)
    .sort()
    .join('\n')
  const [held, setHeld] = useState(() => ({ seeds, bands: seed({}, rows) }))
  // Adjusting state during the render, React's own answer to a changed input.
  const bands = held.seeds === seeds ? held.bands : seed(held.bands, rows)
  if (held.seeds !== seeds) setHeld({ seeds, bands })

  return {
    placed: rows.map((row) => ({ ...row, band: bands[row.id] ?? row.band })),
    changed: rows.filter((row) => bands[row.id] && bands[row.id] !== row.band).length,
    reorder: () =>
      setHeld({
        seeds,
        bands: Object.fromEntries(rows.map((row) => [row.id, row.band])),
      }),
  }
}

function seed(was: Record<string, Band>, rows: WorkRow[]): Record<string, Band> {
  const now: Record<string, Band> = {}
  for (const row of rows) {
    const kept = was[row.id] ?? (row.band === 'unknown' ? null : row.band)
    if (kept) now[row.id] = kept
  }
  return now
}
