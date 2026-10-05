import type { ReactNode } from 'react'
import { Dialog as Base } from '@base-ui/react/dialog'
import { clsx } from 'clsx'
import { X } from 'lucide-react'
import { IconButton } from '../icon-button/IconButton'
import './Dialog.css'

export const Dialog = Base.Root
export const DialogTrigger = Base.Trigger
export const DialogClose = Base.Close

export type DialogPopupProps = Base.Popup.Props & {
  title: ReactNode
  description?: ReactNode
  /** Drawn left of the title and description, such as a tile. */
  leading?: ReactNode
  /** The accessible name of a close button on the right of the head. */
  dismiss?: string
  /** The buttons, right-aligned: Cancel then the verb. */
  actions?: ReactNode
  children?: ReactNode
}

/** The basic dialog: 28 px radius on surface-container-low, the title as its
 *  name, the description as its account, the row it confirms in between. */
export function DialogPopup(props: DialogPopupProps) {
  const { title, description, leading, dismiss, actions, className, children, ...rest } = props
  return (
    <Base.Portal>
      <Base.Backdrop className="m3-scrim" />
      <Base.Viewport className="m3-dialog__viewport">
        <Base.Popup className={clsx('m3-dialog', className)} {...rest}>
          <div className="m3-dialog__head" data-framed={leading || dismiss ? '' : undefined}>
            {leading}
            <div className="m3-dialog__text">
              <Base.Title className="m3-dialog__title">{title}</Base.Title>
              {description ? (
                <Base.Description className="m3-dialog__description">{description}</Base.Description>
              ) : null}
            </div>
            {dismiss ? (
              <Base.Close render={<IconButton className="m3-dialog__dismiss" label={dismiss} />}>
                <X />
              </Base.Close>
            ) : null}
          </div>
          {children}
          {actions ? <div className="m3-dialog__actions">{actions}</div> : null}
        </Base.Popup>
      </Base.Viewport>
    </Base.Portal>
  )
}
