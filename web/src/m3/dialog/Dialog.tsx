import type { ReactNode } from 'react'
import { Dialog as Base } from '@base-ui/react/dialog'
import { clsx } from 'clsx'
import './Dialog.css'

export const Dialog = Base.Root
export const DialogTrigger = Base.Trigger
export const DialogClose = Base.Close

export type DialogPopupProps = Base.Popup.Props & {
  title: ReactNode
  description?: ReactNode
  /** The buttons, right-aligned: Cancel then the verb. */
  actions?: ReactNode
  children?: ReactNode
}

/** The basic dialog: 28 px radius on surface-container-low, the title as its
 *  name, the description as its account, the row it confirms in between. */
export function DialogPopup(props: DialogPopupProps) {
  const { title, description, actions, className, children, ...rest } = props
  return (
    <Base.Portal>
      <Base.Backdrop className="m3-scrim" />
      <Base.Viewport className="m3-dialog__viewport">
        <Base.Popup className={clsx('m3-dialog', className)} {...rest}>
          <div className="m3-dialog__head">
            <Base.Title className="m3-dialog__title">{title}</Base.Title>
            {description ? (
              <Base.Description className="m3-dialog__description">{description}</Base.Description>
            ) : null}
          </div>
          {children}
          {actions ? <div className="m3-dialog__actions">{actions}</div> : null}
        </Base.Popup>
      </Base.Viewport>
    </Base.Portal>
  )
}
