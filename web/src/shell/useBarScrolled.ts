import { useEffect } from 'react'

/** M3 on-scroll: the top bar changes tone once the page scrolls. The scroller is the document on the desktop and
 *  `.shell__main` on the phone (Y-670). The state is one attribute on the shell, so a scroll never re-renders React. */
export function useBarScrolled(factor: 'phone' | 'tablet' | 'desktop', pathname: string) {
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('[data-shell]')
    // The tablet draws a rail and no top bar, so it has nothing to tone.
    if (factor === 'tablet' || !shell) return
    const main = document.querySelector<HTMLElement>('.shell__main')
    const scroller: HTMLElement | Window | null = factor === 'phone' ? main : window
    if (!scroller) return
    const top = () => (scroller === window ? window.scrollY : (scroller as HTMLElement).scrollTop)
    const onScroll = () => shell.toggleAttribute('data-scrolled', top() > 0)
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      shell.removeAttribute('data-scrolled')
    }
  }, [factor, pathname])
}
