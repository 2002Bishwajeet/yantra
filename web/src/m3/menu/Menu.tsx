import type { ReactNode } from 'react'
import { Menu as Base } from '@base-ui/react/menu'
import { clsx } from 'clsx'
import './Menu.css'

export const Menu = Base.Root
export const MenuTrigger = Base.Trigger

export type MenuPopupProps = Base.Popup.Props & {
  side?: Base.Positioner.Props['side']
  align?: Base.Positioner.Props['align']
  children: ReactNode
}

/** The avatar and overflow menus: surface-container, 48 px items. */
export function MenuPopup(props: MenuPopupProps) {
  const { side, align, className, ...rest } = props
  return (
    <Base.Portal>
      <Base.Positioner className="m3-menu__positioner" side={side ?? 'bottom'} align={align ?? 'end'} sideOffset={4}>
        <Base.Popup className={clsx('m3-menu', className)} {...rest} />
      </Base.Positioner>
    </Base.Portal>
  )
}

export type MenuItemProps = Base.Item.Props & {
  icon?: ReactNode
  tone?: 'default' | 'error'
  children: ReactNode
}

export function MenuItem(props: MenuItemProps) {
  const { icon, tone, className, children, ...rest } = props
  return (
    <Base.Item className={clsx('m3-menu-item', className)} data-tone={tone ?? 'default'} {...rest}>
      {icon ? (
        <span className="m3-menu-item__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </Base.Item>
  )
}

export type MenuLinkItemProps = Base.LinkItem.Props & {
  icon?: ReactNode
  children: ReactNode
}

/** An item that navigates; `render={<Link/>}` gives it the route. */
export function MenuLinkItem(props: MenuLinkItemProps) {
  const { icon, className, children, ...rest } = props
  return (
    <Base.LinkItem className={clsx('m3-menu-item', className)} {...rest}>
      {icon ? (
        <span className="m3-menu-item__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </Base.LinkItem>
  )
}

export function MenuSeparator() {
  return <Base.Separator className="m3-menu__separator" />
}
