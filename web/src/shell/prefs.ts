import { useSyncExternalStore } from 'react'

/** ADR-0024 §5: preferences are browser-local, one versioned key. The shell
 *  reads `seenAt`, `theme`, `density` and `seed`; Y-350's Appearance and
 *  General pages write the rest. `index.html` reads the same key before the
 *  first paint, so keep the shape and the key in step with that script. */
export type Prefs = {
  v: 1
  /** The newest notification `at` (Unix seconds) the owner has seen. */
  seenAt: number | null
  theme: 'light' | 'dark' | 'system'
  density: 'clean' | 'compact'
  /** A seed hex other than sage; null is sage, and loads no colour engine. */
  seed: string | null
  /** General's rows, which Y-350 narrows. */
  general: Record<string, unknown>
}

export const PREFS_KEY = 'yantra.prefs'

const DEFAULTS: Prefs = {
  v: 1,
  seenAt: null,
  theme: 'system',
  density: 'clean',
  seed: null,
  general: {},
}

const listeners = new Set<() => void>()
let held: Prefs | null = null

function read(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && (parsed as Prefs).v === 1) {
      return { ...DEFAULTS, ...(parsed as Partial<Prefs>), v: 1 }
    }
  } catch {
    // A private window, or a browser that refuses site data: the defaults.
  }
  return DEFAULTS
}

export function readPrefs(): Prefs {
  held ??= read()
  return held
}

export function writePrefs(patch: Partial<Omit<Prefs, 'v'>>) {
  held = { ...readPrefs(), ...patch }
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(held))
  } catch {
    // Kept in memory for this page, which is the most that can be done.
  }
  for (const notify of listeners) notify()
}

function subscribe(notify: () => void) {
  listeners.add(notify)
  // Another tab wrote: drop the copy, so the next read is the file's.
  const storage = (event: StorageEvent) => {
    if (event.key === PREFS_KEY || event.key === null) {
      held = null
      notify()
    }
  }
  window.addEventListener('storage', storage)
  return () => {
    listeners.delete(notify)
    window.removeEventListener('storage', storage)
  }
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, readPrefs, readPrefs)
}
