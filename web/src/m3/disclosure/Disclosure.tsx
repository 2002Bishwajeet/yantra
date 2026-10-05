import { type ReactNode, useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'
import './Disclosure.css'

export type DisclosureProps = {
  /** What the closed row says: the eyebrow, the state, the count. */
  summary: ReactNode
  /** The trigger's word: "Show". */
  action?: string
  className?: string
  defaultOpen?: boolean
  children: ReactNode
}

/** The dashboard's Idle line: an outlined row that opens on a spring. */
export function Disclosure({ summary, action, className, defaultOpen = false, children }: DisclosureProps) {
  const id = useId()
  const [open, setOpen] = useState(defaultOpen)
  // Children mount on the first open and stay, so the close can animate.
  const [seen, setSeen] = useState(defaultOpen)
  return (
    <div className={clsx('m3-disclosure', className)} data-open={open ? '' : undefined}>
      <div className="m3-disclosure__row">
        <div className="m3-disclosure__summary" id={`${id}-summary`}>{summary}</div>
        <button
          type="button"
          className="m3-disclosure__trigger m3-interactive"
          id={`${id}-trigger`}
          aria-labelledby={`${id}-trigger ${id}-summary`}
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          onClick={() => {
            setOpen(!open)
            setSeen(true)
          }}
        >
          {action ?? 'Show'}
          <ChevronDown className="m3-disclosure__chevron" aria-hidden="true" />
        </button>
      </div>
      <div className="m3-disclosure__panel" id={`${id}-panel`} inert={!open}>
        <div className="m3-disclosure__clip">
          {seen && <div className="m3-disclosure__content">{children}</div>}
        </div>
      </div>
    </div>
  )
}
