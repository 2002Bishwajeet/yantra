import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Link } from '@tanstack/react-router'
import { renderRouted } from '@/test/inRouter'
import { Switch } from '../switch/Switch'
import { List, ListChevron, ListItem, ListValue } from './List'

describe('List', () => {
  it('is a list of items with their lines and values', () => {
    render(
      <List>
        <ListItem headline="Clone home" supporting="~/Github" trailing={<ListValue>Set</ListValue>} />
        <ListItem headline="Push to phone" trailing={<Switch label="Push to phone" defaultChecked />} />
      </List>,
    )
    expect(screen.getByRole('list')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('~/Github')).toBeTruthy()
    expect(screen.getByText('Set')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Push to phone', checked: true })).toBeTruthy()
  })

  it('is a button when it opens a sheet', () => {
    const onClick = vi.fn()
    render(
      <List>
        <ListItem headline="GitHub" render={<button type="button" />} onClick={onClick} trailing={<ListChevron />} />
      </List>,
    )
    const item = screen.getByRole('button', { name: 'GitHub' })
    item.focus()
    fireEvent.click(item)
    expect(onClick).toHaveBeenCalledOnce()
    expect(item.className).toContain('m3-interactive')
  })

  /** The `<li>` sits outside the control (List.tsx) so a trailing switch is
   *  a stop of its own rather than a control inside a control. jsdom plays no
   *  Tab, so both stops are proven focusable and neither contains the other. */
  it('keeps a trailing switch as its own focus stop beside a row control', () => {
    render(
      <List>
        <ListItem
          headline="Push to phone"
          render={<button type="button" />}
          trailing={<Switch label="Push to phone" />}
        />
      </List>,
    )
    const row = screen.getByRole('button', { name: 'Push to phone' })
    const toggle = screen.getByRole('switch', { name: 'Push to phone' })
    expect(row.contains(toggle)).toBe(false)
    expect(row.tabIndex).toBe(0)
    expect(toggle.tabIndex).toBe(0)
    row.focus()
    expect(document.activeElement).toBe(row)
    toggle.focus()
    expect(document.activeElement).toBe(toggle)
  })

  it('is a link when it pushes a screen', async () => {
    await renderRouted(
      <List>
        <ListItem headline="Appearance" supporting="Clean · sage · System" render={<Link to="/" />} trailing={<ListChevron />} />
      </List>,
    )
    expect(screen.getByRole('link', { name: /Appearance/ }).getAttribute('href')).toBe('/')
  })
})
