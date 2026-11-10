import { useEffect, useId, useRef, useSyncExternalStore } from 'react'
import { keyOf, matchChord, type LoopId } from '@/screens/session/keys'

/** A verb of the coding loop that the Chat on screen can run. `run` opens the dialog that
 *  asks, where the verb needs one, so a palette or a chord never merges in one step. */
export type LoopCommand = { id: Exclude<LoopId, 'issue'>; disabled: boolean; reason: string | null; run: () => void }

const sources = new Map<string, readonly LoopCommand[]>()
const listeners = new Set<() => void>()
let snapshot: readonly LoopCommand[] = []

function publish() {
  snapshot = [...sources.values()].flat()
  for (const one of listeners) one()
}

export function useLoopCommands(): readonly LoopCommand[] {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify)
      return () => void listeners.delete(notify)
    },
    () => snapshot,
  )
}

/** The Chat registers its verbs while it is mounted. `run` may change on every render; the
 *  registry re-publishes only when an enabled state or a reason does. */
export function useRegisterLoopCommands(commands: readonly Omit<LoopCommand, 'run'>[], run: (id: LoopCommand['id']) => void) {
  const owner = useId()
  const latest = useRef(run)
  useEffect(() => {
    latest.current = run
  })
  const shape = JSON.stringify(commands)
  useEffect(() => {
    const now: readonly Omit<LoopCommand, 'run'>[] = JSON.parse(shape)
    sources.set(owner, now.map((one) => ({ ...one, run: () => latest.current(one.id) })))
    publish()
    return () => {
      sources.delete(owner)
      publish()
    }
  }, [owner, shape])
}

export const PALETTE_EVENT = 'yantra:palette'

/** Opens the palette with a query in it, as the issue chord does. */
export const openPalette = (query: string) => document.dispatchEvent(new CustomEvent(PALETTE_EVENT, { detail: query }))

/** The chords for the loop verbs; the shell binds them once, and a verb the page does not register does nothing. */
export function useLoopChords() {
  useEffect(() => {
    const pressed = (event: KeyboardEvent) => {
      const id = matchChord(event)
      if (id === null) return
      // The browser would bookmark the page on Ctrl+D.
      event.preventDefault()
      if (id === 'issue') return openPalette(keyOf('issue').label)
      const command = snapshot.find((one) => one.id === id)
      if (command && !command.disabled) command.run()
    }
    document.addEventListener('keydown', pressed)
    return () => document.removeEventListener('keydown', pressed)
  }, [])
}
