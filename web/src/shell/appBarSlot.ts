import { useSyncExternalStore } from 'react'

// The phone app bar holds a box a pushed screen portals its verbs into (Y-757).
let slot: HTMLElement | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The ref of the box: the bar passes it, a null call clears it. */
export function setAppBarSlot(element: HTMLElement | null) {
  slot = element
  for (const listener of listeners) listener()
}

export const useAppBarSlot = () => useSyncExternalStore(subscribe, () => slot, () => null)
