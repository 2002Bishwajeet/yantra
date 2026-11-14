import { Link } from '@tanstack/react-router'
import { Info, KeyRound, MessagesSquare, Settings as SettingsIcon } from 'lucide-react'
import { REFUSED } from '@/lib/github'
import { Badge } from '@/m3/badge/Badge'
import { Menu, MenuLinkItem, MenuPopup } from '@/m3/menu/Menu'
import { guardOutsidePress, useReady, type PopupProps } from './useReady'

/** The avatar's menu, without its trigger: the shell owns that element. */
export function AccountMenu(props: PopupProps & { refused: boolean; update: boolean }) {
  // Never born open: a menu born open skips the enter transition and takes no focus.
  const ready = useReady()
  return (
    <Menu onOpenChange={guardOutsidePress(props)} open={props.open && ready}>
      {/* A LinkItem stays open by default, and the open menu's inert layer then covers the page. */}
      <MenuPopup anchor={props.anchor} finalFocus={props.anchor} keepMounted>
        {props.refused ? (
          <MenuLinkItem
            closeOnClick
            icon={<KeyRound />}
            render={<Link params={{ category: 'providers' }} to="/settings/$category" />}
          >
            <span>{REFUSED} · sign in again</span>
          </MenuLinkItem>
        ) : null}
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
          {props.update ? <Badge label="Update available" /> : null}
        </MenuLinkItem>
      </MenuPopup>
    </Menu>
  )
}
