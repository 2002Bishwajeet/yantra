/** The three rules a path box needs, kept out of the component so they can be
 *  read as arithmetic rather than as a picker.
 *
 *  **The trailing slash is the whole grammar.** `/code/` names what is inside
 *  `/code`, and `/code` names what is inside `/`. That one character is how
 *  typing walks a level, and it is why the box needs no second control to press
 *  (D4 §4.2, amended 2026-08-11). */

/** One spelling per directory, so `/code` and `/code/` are one cache key rather
 *  than two ssh round trips. The root keeps its slash, being all it has. */
export function trimSlash(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}

/** The directory a typed path names — the text before its last `/`. `null` for
 *  anything not absolute, because Yantra never composes a path (D4 §3). */
export function dirOf(path: string): string | null {
  if (!path.startsWith('/')) return null
  const cut = path.lastIndexOf('/')
  return cut === 0 ? '/' : trimSlash(path.slice(0, cut))
}

/** What is being typed *within* that directory, which is the filter and not a
 *  place. `/code/si` is `/code` filtered by `si`, never a listing of `/code/si`. */
export function tailOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
