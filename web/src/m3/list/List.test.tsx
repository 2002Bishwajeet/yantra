import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Link } from '@tanstack/react-router'
import { renderRouted } from '@/test/inRouter'
import { Switch } from '../switch/Switch'
import { List, ListChevron, ListItem, ListValue } from './List'

afterEach(cleanup)

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

  it('is a link when it pushes a screen', async () => {
    await renderRouted(
      <List>
        <ListItem headline="Appearance" supporting="Clean · sage · System" render={<Link to="/" />} trailing={<ListChevron />} />
      </List>,
    )
    expect(screen.getByRole('link', { name: /Appearance/ }).getAttribute('href')).toBe('/')
  })
})
