import { useEffect } from 'react'

/** iOS shrinks only the visual viewport for the keyboard; this publishes the gap so the phone shell and the dock can clear it. */
export function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    // Reads 0 where interactive-widget=resizes-content already shrank innerHeight, so nothing counts twice.
    const update = () => root.style.setProperty('--m3-keyboard-inset', `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`)
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      root.style.removeProperty('--m3-keyboard-inset')
    }
  }, [])
}
