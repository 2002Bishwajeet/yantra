import { useEffect, useState } from 'react'
import type { Looked } from './api'

// The daemon refreshes every 30 s, so this buys no fresher data — it keeps the
// age on screen ticking.
const POLL_MS = 5_000

const failed = (error: string) =>
  ({ looked: 'failed', age_seconds: 0, error }) as const

// Outside the hook because the React Compiler bails out of any function whose
// try/catch holds a conditional, and this one needs both. Null means aborted.
async function look<T>(
  path: string,
  signal: AbortSignal,
): Promise<Looked<T> | null> {
  try {
    const response = await fetch(path, { signal })
    // Every fleet state answers 200, so a non-200 is a fact about this browser
    // reaching the daemon and never about the fleet's health.
    if (!response.ok) return failed(`${path} answered ${response.status}`)
    return (await response.json()) as Looked<T>
  } catch (cause) {
    return signal.aborted ? null : failed(String(cause))
  }
}

/** Never throws: a dead daemon becomes the same `failed` envelope the daemon
 *  itself produces, so the page has one failure path rather than two. */
export function useLooked<T>(path: string): Looked<T> {
  const [answer, setAnswer] = useState<Looked<T>>({ looked: 'never' })

  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      const next = await look<T>(path, abort.signal)
      if (!next) return
      setAnswer(next)
      timer = setTimeout(() => void tick(), POLL_MS)
    }
    void tick()

    return () => {
      abort.abort()
      clearTimeout(timer)
    }
  }, [path])

  return answer
}
