import { useEffect, useState } from 'react'

/** True once the page is idle and `load` has resolved. A failed load stays false,
 *  so the click path and its error boundary still report the failure. */
export function useIdle(load?: () => Promise<unknown>): boolean {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    const arm = () => void Promise.resolve(load?.()).then(() => setIdle(true), () => {})
    if (!('requestIdleCallback' in window)) {
      const id = setTimeout(arm, 1000)
      return () => clearTimeout(id)
    }
    const id = requestIdleCallback(arm, { timeout: 3000 })
    return () => cancelIdleCallback(id)
  }, [load])
  return idle
}
