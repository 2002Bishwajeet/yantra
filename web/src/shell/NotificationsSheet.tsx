import { SideSheet } from '@/m3/side-sheet/SideSheet'
import { NotificationsList } from './Notifications'

export function NotificationsSheet(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props
  return (
    <SideSheet className="shell__sheet" onClose={onClose} open={open} title="Notifications">
      <NotificationsList onOpen={onClose} />
    </SideSheet>
  )
}
