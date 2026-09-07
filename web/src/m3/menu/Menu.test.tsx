import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Link } from '@tanstack/react-router'
import { LogOut, Settings } from 'lucide-react'
import { renderRouted } from '@/test/inRouter'
import { Button } from '../button/Button'
import { Menu, MenuItem, MenuLinkItem, MenuPopup, MenuSeparator, MenuTrigger } from './Menu'

describe('Menu', () => {
  it('opens from its trigger, walks with the arrow keys and fires an item', async () => {
    const onSettings = vi.fn()
    render(
      <Menu>
        <MenuTrigger render={<Button variant="text" />}>Account</MenuTrigger>
        <MenuPopup>
          <MenuItem icon={<Settings />} onClick={onSettings}>
            Settings
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<LogOut />} tone="error" disabled>
            Sign out
          </MenuItem>
        </MenuPopup>
      </Menu>,
    )
    const trigger = screen.getByRole('button', { name: 'Account' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    const items = screen.getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Settings', 'Sign out'])
    expect(items[1].getAttribute('aria-disabled')).toBe('true')
    // A click opens the menu on its first item; the arrows walk from there.
    await waitFor(() => expect(document.activeElement).toBe(items[0]))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(items[1]))
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    await waitFor(() => expect(document.activeElement).toBe(items[0]))
    fireEvent.click(items[0])
    expect(onSettings).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('closes on Escape and hands focus back to the trigger', async () => {
    render(
      <Menu>
        <MenuTrigger render={<Button variant="text" />}>More</MenuTrigger>
        <MenuPopup>
          <MenuItem>Rename</MenuItem>
        </MenuPopup>
      </Menu>,
    )
    const trigger = screen.getByRole('button', { name: 'More' })
    trigger.focus()
    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('holds a link item that the router routes', async () => {
    await renderRouted(
      <Menu>
        <MenuTrigger render={<Button variant="text" />}>Account</MenuTrigger>
        <MenuPopup>
          <MenuLinkItem icon={<Settings />} render={<Link to="/" />}>
            Settings
          </MenuLinkItem>
        </MenuPopup>
      </Menu>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    await screen.findByRole('menu')
    const item = screen.getByRole('menuitem', { name: 'Settings' })
    expect(item.tagName).toBe('A')
    expect(item.getAttribute('href')).toBe('/')
  })
})
