import { useSyncExternalStore } from 'react'

let open = 0
const listeners = new Set<() => void>()

/** Marks a Connect sheet as open until the returned release runs. */
export function holdConnect(): () => void {
  open += 1
  listeners.forEach((it) => it())
  return () => {
    open -= 1
    listeners.forEach((it) => it())
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** True while a Connect sheet is open. A screen keeps drawing its Connect row then, because
 *  the sign-in landing flips the grant and the row owns the sheet. */
export const useConnecting = () => useSyncExternalStore(subscribe, () => open > 0, () => false)
