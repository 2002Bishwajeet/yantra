import { useSyncExternalStore } from 'react'

/** Whether the daemon last said this device holds no passkey session
 *  (ADR-0044). Any 401 sets it, and a finished sign-in clears it. It is the
 *  browser's own state, so it lives here and not in the query cache. */
let out = false
const listeners = new Set<() => void>()

function set(next: boolean) {
  if (out === next) return
  out = next
  for (const listener of listeners) listener()
}

export const signedOut = () => set(true)
export const signedIn = () => set(false)

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useSignedOut = () => useSyncExternalStore(subscribe, () => out)
