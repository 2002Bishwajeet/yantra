import { Link } from '@tanstack/react-router'
import { Info, MessagesSquare, Settings as SettingsIcon } from 'lucide-react'
import { Menu, MenuLinkItem, MenuPopup } from '@/m3/menu/Menu'
import { guardOutsidePress, useReady, type PopupProps } from './useReady'

/** The avatar's menu, without its trigger: the shell owns that element. */
export function AccountMenu(props: PopupProps) {
  // Never born open: a menu born open skips the enter transition and takes no focus.
  const ready = useReady()
  return (
    <Menu onOpenChange={guardOutsidePress(props)} open={props.open && ready}>
      {/* A LinkItem stays open by default, and the open menu's inert layer then covers the page. */}
      <MenuPopup anchor={props.anchor} finalFocus={props.anchor}>
        <MenuLinkItem closeOnClick icon={<MessagesSquare />} render={<Link to="/rooms" />}>
          Rooms
        </MenuLinkItem>
        <MenuLinkItem closeOnClick icon={<SettingsIcon />} render={<Link to="/settings" />}>
          Settings
        </MenuLinkItem>
        <MenuLinkItem
          closeOnClick
          icon={<Info />}
          render={<Link params={{ category: 'about' }} to="/settings/$category" />}
        >
          About
        </MenuLinkItem>
      </MenuPopup>
    </Menu>
  )
}
