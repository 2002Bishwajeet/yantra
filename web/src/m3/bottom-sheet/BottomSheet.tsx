import type { ReactNode } from 'react'
import { Drawer } from '@base-ui/react/drawer'
import { clsx } from 'clsx'
import '../dialog/Dialog.css'
import './BottomSheet.css'

export type BottomSheetProps = Drawer.Root.Props

/** A modal bottom sheet on Base UI's Drawer: swipe down dismisses. */
export function BottomSheet(props: BottomSheetProps) {
  return <Drawer.Root swipeDirection="down" {...props} />
}

export const BottomSheetTrigger = Drawer.Trigger
export const BottomSheetClose = Drawer.Close

export type BottomSheetPopupProps = Drawer.Popup.Props & {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}

/** The sheet itself: drag handle, 28 px top corners, safe-area padding. */
export function BottomSheetPopup(props: BottomSheetPopupProps) {
  const { title, description, actions, className, children, ...rest } = props
  return (
    <Drawer.Portal>
      <Drawer.Backdrop className="m3-scrim m3-bottom-sheet__scrim" />
      <Drawer.Viewport className="m3-bottom-sheet__viewport">
        <Drawer.Popup className={clsx('m3-bottom-sheet', className)} {...rest}>
          <div className="m3-bottom-sheet__handle-row">
            <span className="m3-bottom-sheet__handle" aria-hidden="true" />
          </div>
          <Drawer.Content className="m3-bottom-sheet__content">
            <div className="m3-dialog__head">
              <Drawer.Title className="m3-dialog__title">{title}</Drawer.Title>
              {description ? (
                <Drawer.Description className="m3-dialog__description">{description}</Drawer.Description>
              ) : null}
            </div>
            {children}
            {actions ? <div className="m3-dialog__actions">{actions}</div> : null}
          </Drawer.Content>
        </Drawer.Popup>
      </Drawer.Viewport>
    </Drawer.Portal>
  )
}
