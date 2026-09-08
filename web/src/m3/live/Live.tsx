import { useSyncExternalStore } from 'react'
import { read, subscribe } from './live'

/** Two regions taking turns, because the same sentence written into one region
 *  twice is not a change and a second identical error would go unsaid. The one
 *  that gains the text is announced; the one that loses it is not, since a live
 *  region reads additions and text changes and not removals. */
export function LiveRegion() {
  const now = useSyncExternalStore(subscribe, read, read)
  const first = now.turn % 2 === 1
  return (
    <>
      <p aria-atomic="true" aria-live="assertive" className="m3-sr-only" data-live="">
        {first ? now.text : ''}
      </p>
      <p aria-atomic="true" aria-live="assertive" className="m3-sr-only" data-live="">
        {first ? '' : now.text}
      </p>
    </>
  )
}
