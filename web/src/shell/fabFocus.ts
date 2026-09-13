import { useLayoutEffect, useRef, type FocusEvent } from 'react'

const FAB = '.shell__fab, .shell__rail-fab'

/** Keeps a keyboard reader's place when the FAB's action changes. A swap that
 *  replaces the element (a link becomes a button) puts focus on the new FAB; a
 *  FAB that goes away hands it to the page's `[data-fab-return]` status line,
 *  or to the page. Focus the reader moved elsewhere is left alone. */
export function useFabFocus(key: string) {
  const held = useRef(false)
  useLayoutEffect(() => {
    if (!held.current) return
    const now = document.activeElement
    if (now !== null && now !== document.body && now.isConnected) return
    held.current = false
    const next =
      document.querySelector<HTMLElement>(FAB) ??
      document.querySelector<HTMLElement>('main [data-fab-return]') ??
      document.querySelector<HTMLElement>('main')
    next?.focus()
  }, [key])
  return {
    onFocus: () => {
      held.current = true
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const left = event.currentTarget
      // A FAB removed while focused may blur on its way out; that is not the
      // reader leaving it.
      queueMicrotask(() => {
        if (left.isConnected) held.current = false
      })
    },
  }
}

export type FabFocus = ReturnType<typeof useFabFocus>
