import { useEffect, useRef, useState } from 'react'

const KEY = 'yantra.chat.draft.'
const DELAY = 300

/** The words this browser kept for `id`, or none. */
export function recallDraft(id: string): string {
  try {
    return localStorage.getItem(KEY + id) ?? ''
  } catch {
    // A private window, or a browser that refuses site data.
    return ''
  }
}

export function keepDraft(id: string, text: string) {
  try {
    if (text === '') localStorage.removeItem(KEY + id)
    else localStorage.setItem(KEY + id, text)
  } catch {
    // Held for this page only, which is the most that can be done.
  }
}

/** The key a thread keeps its draft under; a chat with no thread yet keeps it per workspace. */
export const draftId = (workspace: string, thread: string | null) => thread ?? `workspace/${workspace}`

/** The draft for `id`: it loads what the browser kept, falling back to `seed`
 *  (the issue's text) only when nothing was kept, and writes after a pause. */
export function useDraft(id: string, seed = '') {
  const [text, setText] = useState(() => recallDraft(id) || seed)
  const latest = useRef({ id, text })
  const prior = useRef(id)

  useEffect(() => {
    latest.current = { id, text }
  })

  // A first turn names the thread: the words typed since move to its key.
  useEffect(() => {
    if (prior.current === id) return
    keepDraft(prior.current, '')
    prior.current = id
  }, [id])

  useEffect(() => {
    const write = window.setTimeout(() => keepDraft(id, text), DELAY)
    return () => window.clearTimeout(write)
  }, [id, text])

  // A reload inside the pause must not lose the last words.
  useEffect(() => {
    const flush = () => keepDraft(latest.current.id, latest.current.text)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  return [text, setText] as const
}
