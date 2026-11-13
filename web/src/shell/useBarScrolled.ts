import { useEffect } from 'react'

/** M3 on-scroll: the desktop top bar changes tone once the document scrolls. The state is one attribute on
 *  the shell, so a scroll never re-renders React. */
export function useBarScrolled(active: boolean, pathname: string) {
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('[data-shell]')
    if (!active || !shell) return
    const onScroll = () => shell.toggleAttribute('data-scrolled', window.scrollY > 0)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      shell.removeAttribute('data-scrolled')
    }
  }, [active, pathname])
}
