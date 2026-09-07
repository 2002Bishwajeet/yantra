import { useSyncExternalStore } from 'react'

/** Material's window size classes, at the brief's three widths: compact under
 *  600, medium and expanded to 1239, large from 1240. The shell reads this
 *  once; the router never does (ADR-0024, consequences). */
export type FormFactor = 'phone' | 'tablet' | 'desktop'

const DESKTOP = '(min-width: 1240px)'
const TABLET = '(min-width: 600px)'

function subscribe(notify: () => void) {
  const queries = [matchMedia(DESKTOP), matchMedia(TABLET)]
  for (const query of queries) query.addEventListener('change', notify)
  return () => {
    for (const query of queries) query.removeEventListener('change', notify)
  }
}

function snapshot(): FormFactor {
  if (matchMedia(DESKTOP).matches) return 'desktop'
  if (matchMedia(TABLET).matches) return 'tablet'
  return 'phone'
}

export function useFormFactor(): FormFactor {
  return useSyncExternalStore(subscribe, snapshot, () => 'desktop')
}
