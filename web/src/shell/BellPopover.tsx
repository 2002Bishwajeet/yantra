import { Popover, PopoverPopup } from '@/m3/popover/Popover'
import { NotificationsList } from './Notifications'
import { guardOutsidePress, useReady, type PopupProps } from './useReady'

/** The bell's popover, without its trigger: the shell owns that element. */
export function BellPopup(props: PopupProps) {
  // Never born open: a popover born open skips the enter spring.
  const ready = useReady()
  return (
    <Popover onOpenChange={guardOutsidePress(props)} open={props.open && ready}>
      <PopoverPopup anchor={props.anchor} finalFocus={props.anchor} showTitle title="Notifications">
        <NotificationsList />
      </PopoverPopup>
    </Popover>
  )
}
