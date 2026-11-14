import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

  /** Y-379: the account menu answered neither the pointer nor the arrow keys,
   *  because `.m3-menu-item` was the one control the shared state layer had
   *  missed. Both kinds of item wear it now; `settings.spec.ts` paints it. */
  it('gives both kinds of item the library’s state layer', async () => {
    await renderRouted(
      <Menu>
        <MenuTrigger render={<Button variant="text" />}>Account</MenuTrigger>
        <MenuPopup>
          <MenuItem>Rename</MenuItem>
          <MenuLinkItem render={<Link to="/" />}>Settings</MenuLinkItem>
        </MenuPopup>
      </Menu>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    await screen.findByRole('menu')
    for (const item of screen.getAllByRole('menuitem')) {
      expect(item.className).toContain('m3-interactive')
    }
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

describe('a disabled item (CSS read as text; jsdom applies none)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/m3/menu/Menu.css'), 'utf8')
  const rule = /\.m3-menu-item\[data-disabled\] \{([^}]*)\}/.exec(css)
  const toneAt = css.indexOf('.m3-menu-item[data-tone="error"] {')

  it('draws on-surface at 38 % with full opacity, so an error tone does not fade to pink', () => {
    expect(rule?.[1]).toMatch(/opacity: 1;/)
    expect(rule?.[1]).toMatch(/color-mix\(in srgb, var\(--md-sys-color-on-surface\) 38%, transparent\)/)
  })

  it('comes after the tone rule so it wins at equal specificity', () => {
    expect(css.indexOf('.m3-menu-item[data-disabled] {')).toBeGreaterThan(toneAt)
  })
})
