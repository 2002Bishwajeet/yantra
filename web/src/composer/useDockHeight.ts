import { useEffect, useRef, type RefObject } from 'react'

/**
 * The dock is sticky, so a taller one (a plan, an error, a long draft) covers what is behind it.
 * Composer.css reads `--composer-dock-height` for scroll-padding, which keeps a focused control clear (WCAG 2.4.11).
 * `onResize` runs after each measure, for a caller that carries its reader to the end again.
 */
export function useDockHeight(dock: RefObject<HTMLElement | null>, onResize?: (dock: HTMLElement) => void) {
  const latest = useRef(onResize)
  latest.current = onResize
  useEffect(() => {
    const box = dock.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    const watching = new ResizeObserver(() => {
      root.style.setProperty('--composer-dock-height', `${box.offsetHeight}px`)
      latest.current?.(box)
    })
    watching.observe(box)
    // The page can grow after the dock draws (a list loads) and would leave its last block under the dock.
    const page = box.closest('.m3-page')
    if (page) watching.observe(page)
    return () => {
      watching.disconnect()
      root.style.removeProperty('--composer-dock-height')
    }
  }, [dock])
}
