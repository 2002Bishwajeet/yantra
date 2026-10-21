import { useCallback, useEffect, useRef, useState } from 'react'

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
 *  (the issue's text) only when nothing was kept, and writes after a pause.
 *  The seed and a recalled prompt are not the reader's words, so they are kept only once edited. */
export function useDraft(id: string, seed = '') {
  const [draft, setDraft] = useState(() => {
    const kept = recallDraft(id)
    return kept ? { text: kept, own: true } : { text: seed, own: seed === '' }
  })
  const { text, own } = draft
  const latest = useRef({ id, text, own })
  const prior = useRef(id)

  useEffect(() => {
    latest.current = { id, text, own }
  })

  // A first turn names the thread: the words typed since move to its key.
  useEffect(() => {
    if (prior.current === id) return
    keepDraft(prior.current, '')
    prior.current = id
  }, [id])

  // An empty draft always writes: it removes a kept one, as a send does.
  useEffect(() => {
    if (!own && text !== '') return
    const write = window.setTimeout(() => keepDraft(id, text), DELAY)
    return () => window.clearTimeout(write)
  }, [id, text, own])

  // A reload inside the pause must not lose the last words.
  useEffect(() => {
    const flush = () => {
      const { id: at, text: words, own: mine } = latest.current
      if (mine || words === '') keepDraft(at, words)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  const set = useCallback(
    (next: string | ((now: string) => string)) =>
      setDraft((now) => ({ text: typeof next === 'function' ? next(now.text) : next, own: true })),
    [],
  )
  const recall = useCallback((next: string) => setDraft({ text: next, own: false }), [])

  return [text, set, recall] as const
}
