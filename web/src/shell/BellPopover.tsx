import { Popover, PopoverPopup, PopoverTrigger } from '@/m3/popover/Popover'
import { Bell } from './Bell'
import { NotificationsList } from './Notifications'

export function BellPopover() {
  return (
    <Popover>
      <PopoverTrigger render={<Bell />} />
      <PopoverPopup showTitle title="Notifications">
        <NotificationsList />
      </PopoverPopup>
    </Popover>
  )
}
