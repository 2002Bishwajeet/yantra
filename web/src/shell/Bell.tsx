import { Bell as BellIcon } from 'lucide-react'
import { Badge } from '@/m3/badge/Badge'
import { IconButton, type IconButtonProps } from '@/m3/icon-button/IconButton'
import { useEntries } from './useEntries'

export function Bell(props: Omit<IconButtonProps, 'label' | 'badge' | 'children'>) {
  const { badge } = useEntries()
  return (
    <IconButton
      badge={badge > 0 ? <Badge count={badge} label={`${badge} unread`} /> : undefined}
      label="Notifications"
      variant="tonal"
      {...props}
    >
      <BellIcon />
    </IconButton>
  )
}
