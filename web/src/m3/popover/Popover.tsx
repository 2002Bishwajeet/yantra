import type { ReactNode } from 'react'
import { Popover as Base } from '@base-ui/react/popover'
import { clsx } from 'clsx'
import './Popover.css'

export const Popover = Base.Root
export const PopoverTrigger = Base.Trigger
export const PopoverClose = Base.Close

export type PopoverPopupProps = Base.Popup.Props & {
  /** The popup's accessible name. */
  title: string
  /** Drawn beside the title; omit to keep the title for readers only. */
  showTitle?: boolean
  side?: Base.Positioner.Props['side']
  align?: Base.Positioner.Props['align']
  children: ReactNode
}

/** The notifications popover: 420 wide, surface-container-low, hairline. */
export function PopoverPopup(props: PopoverPopupProps) {
  const { title, showTitle, side, align, className, children, ...rest } = props
  return (
    <Base.Portal>
      <Base.Positioner className="m3-popover__positioner" side={side ?? 'bottom'} align={align ?? 'end'} sideOffset={8}>
        <Base.Popup className={clsx('m3-popover', className)} {...rest}>
          <Base.Title className={showTitle ? 'm3-popover__title' : 'm3-sr-only'}>{title}</Base.Title>
          {children}
        </Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  )
}
