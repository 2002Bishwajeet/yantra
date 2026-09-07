import { useEffect, useSyncExternalStore } from 'react'

// A screen the route cannot name at head time (Setup under `/`, a not-found
// sentence) tells the phone app bar its name here.
let current: string | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const set = (title: string | null) => {
  current = title
  for (const listener of listeners) listener()
}

export function useScreenTitle(title: string) {
  useEffect(() => {
    set(title)
    return () => set(null)
  }, [title])
}

export const useScreenTitleOverride = () =>
  useSyncExternalStore(subscribe, () => current, () => null)
