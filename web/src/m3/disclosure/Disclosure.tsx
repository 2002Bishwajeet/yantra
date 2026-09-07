import type { ReactNode } from 'react'
import { Collapsible } from '@base-ui/react/collapsible'
import { ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'
import './Disclosure.css'

export type DisclosureProps = Collapsible.Root.Props & {
  /** What the closed row says: the eyebrow, the state, the count. */
  summary: ReactNode
  /** The trigger's word: "Show". */
  action?: string
  children: ReactNode
}

/** The dashboard's Idle line: an outlined row that opens on a spring. */
export function Disclosure(props: DisclosureProps) {
  const { summary, action, className, children, ...rest } = props
  return (
    <Collapsible.Root className={clsx('m3-disclosure', className)} {...rest}>
      <div className="m3-disclosure__row">
        <div className="m3-disclosure__summary">{summary}</div>
        <Collapsible.Trigger className="m3-disclosure__trigger m3-interactive">
          {action ?? 'Show'}
          <ChevronDown className="m3-disclosure__chevron" aria-hidden="true" />
        </Collapsible.Trigger>
      </div>
      <Collapsible.Panel className="m3-disclosure__panel">
        <div className="m3-disclosure__content">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}
