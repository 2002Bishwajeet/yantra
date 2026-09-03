import type { ReactNode } from 'react'

/** The route's own heading, which D3 §5.2 says every route has exactly one of.
 *  `1.5rem` is the largest of §5.4's four sizes and the only place it is used. */
export function Title({ children }: { children: ReactNode }) {
  return (
    <h1 className="font-heading text-2xl leading-tight font-semibold">
      {children}
    </h1>
  )
}
