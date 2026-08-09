import type { ReactNode } from 'react'
import { go } from '@/router'

/** A real `<a>`, so a middle click, a long press and a screen reader all get a
 *  URL — only the plain left click is taken over. */
export function Link({
  to,
  className,
  children,
}: {
  to: string
  className?: string
  children: ReactNode
}) {
  return (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return
        event.preventDefault()
        go(to)
      }}
    >
      {children}
    </a>
  )
}
