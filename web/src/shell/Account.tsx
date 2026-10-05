import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Info, Settings as SettingsIcon, User } from 'lucide-react'
import { IconButton } from '@/m3/icon-button/IconButton'
import { Menu, MenuLinkItem, MenuPopup, MenuTrigger } from '@/m3/menu/Menu'

/** The avatar and its menu. A generic mark rather than an initial: nothing
 *  on the wire names the person (inventory §C). */
export function Account(props: { openOnMount?: boolean }) {
  // Opens one effect after mount, not defaultOpen: a menu born open skips the
  // enter transition, and the arrow keys would find no focus inside it.
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(props.openOnMount ?? false), [props.openOnMount])
  return (
    <Menu onOpenChange={setOpen} open={open}>
      <MenuTrigger render={<IconButton label="Account" variant="tonal" />}>
        <User />
      </MenuTrigger>
      <MenuPopup>
        <MenuLinkItem icon={<SettingsIcon />} render={<Link to="/settings" />}>
          Settings
        </MenuLinkItem>
        <MenuLinkItem
          icon={<Info />}
          render={<Link params={{ category: 'about' }} to="/settings/$category" />}
        >
          About
        </MenuLinkItem>
      </MenuPopup>
    </Menu>
  )
}
