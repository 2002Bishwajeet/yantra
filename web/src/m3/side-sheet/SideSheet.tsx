import { type ComponentPropsWithRef, type ReactNode, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { clsx } from 'clsx'
import { IconButton } from '../icon-button/IconButton'
import './SideSheet.css'

export type SideSheetProps = ComponentPropsWithRef<'aside'> & {
  title: string
  open: boolean
  onClose: () => void
  /** Beside the title: the Unread / All pills. */
  actions?: ReactNode
  children: ReactNode
}

/** The 420 px side sheet, narrower when the window is: never modal, closed
 *  with its own button or Escape. Where it sits is the caller's — the shell
 *  floats it over the tablet's page (finding 106). */
export function SideSheet(props: SideSheetProps) {
  const { title, open, onClose, actions, className, children, ...rest } = props
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open) {
      opener.current = document.activeElement as HTMLElement | null
      heading.current?.focus()
    } else if (opener.current?.isConnected) {
      opener.current.focus()
      opener.current = null
    }
  }, [open])
  return (
    <aside
      className={clsx('m3-side-sheet', className)}
      aria-label={title}
      hidden={!open}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
      {...rest}
    >
      <div className="m3-side-sheet__head">
        <h2 className="m3-side-sheet__title" tabIndex={-1} ref={heading}>
          {title}
        </h2>
        {actions}
        <IconButton label={`Close ${title}`} onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <div className="m3-side-sheet__body">{children}</div>
    </aside>
  )
}
