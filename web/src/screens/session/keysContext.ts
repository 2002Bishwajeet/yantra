import { createContext, type RefObject } from 'react'

export type Keys = {
  send: (bytes: number[]) => void
  focus: () => void
  /** Arms Ctrl for the next key, as a phone's key row needs. */
  ctrl: () => void
}

/** The socket's handle for whatever the terminal draws under the pane (the
 *  phone's key row) — a ref, since the socket is not there until the effect
 *  runs. */
export const KeysContext = createContext<RefObject<Keys | null>>({ current: null })
