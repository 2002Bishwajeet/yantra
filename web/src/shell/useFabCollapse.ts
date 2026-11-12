import { useEffect } from 'react'

/** M3: the extended FAB collapses to its icon while the page scrolls down and expands on scroll up or at the top.
 *  The state is one attribute on the shell, so a scroll never re-renders React. */
export function useFabCollapse(active: boolean, pathname: string) {
  useEffect(() => {
    const main = document.querySelector<HTMLElement>('[data-shell="phone"] .shell__main')
    const shell = main?.closest<HTMLElement>('[data-shell]')
    if (!active || !main || !shell) return
    let last = main.scrollTop
    const onScroll = () => {
      const top = main.scrollTop
      const delta = top - last
      if (top <= 8 || delta < -4) shell.removeAttribute('data-fab-collapsed')
      else if (delta > 4) shell.setAttribute('data-fab-collapsed', '')
      if (Math.abs(delta) > 4 || top <= 8) last = top
    }
    main.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      main.removeEventListener('scroll', onScroll)
      shell.removeAttribute('data-fab-collapsed')
    }
  }, [active, pathname])
}
