import type { ComponentPropsWithRef, ReactNode } from 'react'
import { X } from 'lucide-react'
import { clsx } from 'clsx'
import { IconButton } from '../icon-button/IconButton'
import './Snackbar.css'

export type SnackbarProps = ComponentPropsWithRef<'div'> & {
  /** `alert` interrupts; `status` waits its turn. */
  tone?: 'status' | 'alert'
  action?: { label: string; onClick: () => void }
  onClose?: () => void
  children: ReactNode
}

/** M3's snackbar on inverse-surface. The caller positions it. */
export function Snackbar(props: SnackbarProps) {
  const { tone, action, onClose, className, children, ...rest } = props
  return (
    <div className={clsx('m3-snackbar', className)} role={tone ?? 'status'} {...rest}>
      <span className="m3-snackbar__text">{children}</span>
      {action ? (
        <button type="button" className="m3-snackbar__action m3-interactive" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
      {onClose ? (
        <IconButton label="Dismiss" className="m3-snackbar__close" onClick={onClose}>
          <X />
        </IconButton>
      ) : null}
    </div>
  )
}
