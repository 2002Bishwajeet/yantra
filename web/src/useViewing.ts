import { useEffect } from 'react'

/** How often an open tab says so. Half of `WATCHED` in
 *  [`crates/yantrad/src/notify.rs`](../../crates/yantrad/src/notify.rs), so one
 *  beacon lost to a flaky network does not start a push to a phone the person
 *  is holding. */
const BEACON_MS = 20_000

/** D3 §13. **The page says it is being looked at; the daemon stops pushing what
 *  the page is already showing.**
 *
 *  It is an explicit beacon rather than "any `/api` read means presence",
 *  because a background tab polls every 5 s and is not a person watching. The
 *  Page Visibility API is what tells the two apart, and it is the only thing
 *  that does — a phone locked with the tab open fires `visibilitychange`.
 *
 *  **A failure is silence, not an error.** The worst it costs is a notification
 *  you were going to get anyway, and a banner about it would be noise on every
 *  page. */
export function useViewing() {
  useEffect(() => {
    let stop = false

    const beacon = () => {
      if (stop || document.visibilityState !== 'visible') return
      void fetch('/api/viewing', { method: 'POST' }).catch(() => {})
    }

    beacon()
    const timer = setInterval(beacon, BEACON_MS)
    document.addEventListener('visibilitychange', beacon)
    return () => {
      stop = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', beacon)
    }
  }, [])
}
