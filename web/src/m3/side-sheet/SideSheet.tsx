import type { ComponentPropsWithRef, ReactNode } from 'react'
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

/** The docked 420 px side sheet: in the flow, never modal, closed with its
 *  own button or Escape. */
export function SideSheet(props: SideSheetProps) {
  const { title, open, onClose, actions, className, children, ...rest } = props
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
        <h2 className="m3-side-sheet__title">{title}</h2>
        {actions}
        <IconButton label={`Close ${title}`} onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <div className="m3-side-sheet__body">{children}</div>
    </aside>
  )
}
