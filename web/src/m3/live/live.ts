type Said = { text: string; turn: number }

let said: Said = { text: '', turn: 0 }
const listeners = new Set<() => void>()

export function subscribe(notify: () => void) {
  listeners.add(notify)
  return () => {
    listeners.delete(notify)
  }
}

export const read = () => said

/** Say `text` in the region the shell mounted at boot. A region that already
 *  exists is the one a screen reader watches, so the words are a change rather
 *  than a mount — which is what `role="alert"` on a surface drawn with its own
 *  text cannot promise (finding 111). */
export function announce(text: string) {
  if (text === '') return
  said = { text, turn: said.turn + 1 }
  for (const notify of listeners) notify()
}
