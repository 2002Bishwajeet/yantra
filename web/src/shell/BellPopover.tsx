import { useEffect, useState } from 'react'
import { Popover, PopoverPopup, PopoverTrigger } from '@/m3/popover/Popover'
import { Bell } from './Bell'
import { NotificationsList } from './Notifications'

export function BellPopover(props: { openOnMount?: boolean }) {
  // Opens two frames after mount, not defaultOpen: a popover born open skips
  // the enter spring.
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!props.openOnMount) return
    // Two frames: the closed popup must be styled once, or the spring has no start.
    let b = 0
    const a = requestAnimationFrame(() => {
      b = requestAnimationFrame(() => setOpen(true))
    })
    return () => {
      cancelAnimationFrame(a)
      cancelAnimationFrame(b)
    }
  }, [props.openOnMount])
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger render={<Bell />} />
      <PopoverPopup showTitle title="Notifications">
        <NotificationsList />
      </PopoverPopup>
    </Popover>
  )
}
