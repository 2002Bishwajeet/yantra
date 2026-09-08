import { SideSheet } from '@/m3/side-sheet/SideSheet'
import { NotificationsList } from './Notifications'

export function NotificationsSheet(props: { id: string; open: boolean; onClose: () => void }) {
  const { id, open, onClose } = props
  return (
    <SideSheet className="shell__sheet" id={id} onClose={onClose} open={open} title="Notifications">
      <NotificationsList onOpen={onClose} />
    </SideSheet>
  )
}
