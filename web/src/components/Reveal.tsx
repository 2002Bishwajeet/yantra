import type { ReactNode } from 'react'
import {
  Collapsible,
  CollapsibleContent,
} from '@/components/ui/collapsible'

/** The panel, and nothing else. Its button stays in the entry chunk so the
 *  first tap fetches Base UI's collapsible rather than the first paint —
 *  Y-167's `Overflow` rule applied to a disclosure, and 11 kB gzip of it.
 *  Mounted already open, because the button is what decides that. */
export function Reveal({ children }: { children: ReactNode }) {
  return (
    <Collapsible open>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  )
}
