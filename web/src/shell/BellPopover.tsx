import { useEffect, useState } from 'react'
import { Popover, PopoverPopup, PopoverTrigger } from '@/m3/popover/Popover'
import { Bell } from './Bell'
import { NotificationsList } from './Notifications'

export function BellPopover(props: { openOnMount?: boolean }) {
  // Opens one effect after mount, not defaultOpen: a popover born open skips
  // the enter spring.
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(props.openOnMount ?? false), [props.openOnMount])
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger render={<Bell />} />
      <PopoverPopup showTitle title="Notifications">
        <NotificationsList />
      </PopoverPopup>
    </Popover>
  )
}
