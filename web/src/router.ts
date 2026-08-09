import { useSyncExternalStore } from 'react'

/** Three routes and a fourth state that is not one. `nowhere` exists because
 *  [`web.rs`](../../crates/yantrad/src/web.rs) falls every unknown path back to
 *  `index.html`, so a typed URL arrives here as a page rather than a 404 — and
 *  drawing the fleet for it would make the address bar a lie. */
export type Route =
  | { at: 'fleet' }
  | { at: 'machine'; machine: string }
  | { at: 'workspace'; name: string }
  | { at: 'nowhere'; path: string }

export const machinePath = (machine: string) =>
  `/m/${encodeURIComponent(machine)}`
export const workspacePath = (name: string) => `/w/${encodeURIComponent(name)}`

/** A hand-typed `%zz` is not a name, and `decodeURIComponent` throws on it. */
function readable(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

export function match(path: string): Route {
  const parts = path.split('/').filter((one) => one !== '')
  if (parts.length === 0) return { at: 'fleet' }

  const [head, tail] = parts
  const name = parts.length === 2 && tail !== undefined ? readable(tail) : null
  if (name !== null && name !== '') {
    if (head === 'm') return { at: 'machine', machine: name }
    if (head === 'w') return { at: 'workspace', name }
  }
  return { at: 'nowhere', path }
}

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}

const here = () => location.pathname

/** `pushState` fires no event, so a navigation the page makes has to tell the
 *  subscribers itself; the back button is the half the browser announces. */
export function go(path: string) {
  if (path === location.pathname) return
  history.pushState(null, '', path)
  for (const listener of listeners) listener()
}

export function useRoute(): Route {
  return match(useSyncExternalStore(subscribe, here))
}
