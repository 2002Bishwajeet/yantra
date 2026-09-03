import { useEffect, useState } from 'react'

/** The instant a page read on request should measure its stamp against, moved
 *  once a second. A clock, not a read: it asks the daemon nothing (D3 §11.4's
 *  amendment, D5 §4.3).
 *
 *  **It returns the instant rather than only re-rendering**, and that is the
 *  whole reason it works: the React Compiler memoises a `<Stamp>` whose props
 *  did not change, so a hook that only bumped a counter left `/usage` reading
 *  `0s` for as long as the page was open. */
export function useTick(on: boolean): number {
  const [now, tick] = useState(() => Date.now())

  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => tick(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [on])

  return now
}
