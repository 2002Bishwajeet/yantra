import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'
import { mountSettings, unmountSettings } from './harness'

afterEach(() => {
  cleanup()
  unmountSettings()
})

describe('the settings screen', () => {
  it('draws the category list beside General on a desktop', async () => {
    mountSettings('desktop', '/settings')
    const nav = await screen.findByRole('navigation', { name: 'Settings' })
    expect(within(nav).getAllByRole('link').map((one) => one.textContent)).toEqual([
      'General',
      'Notifications',
      'Providers',
      'Agents',
      'Appearance',
      'Access',
      'About',
    ])
    expect(within(nav).getByRole('link', { name: 'General' }).getAttribute('aria-current')).toBe('page')
    expect(await screen.findByRole('heading', { level: 2, name: 'General' })).toBeTruthy()
    expect(screen.getByText('Home directory for clones')).toBeTruthy()
  })

  it('marks the open category and draws only it', async () => {
    mountSettings('tablet', '/settings/about')
    const nav = await screen.findByRole('navigation', { name: 'Settings' })
    expect(within(nav).getByRole('link', { name: 'About' }).getAttribute('aria-current')).toBe('page')
    expect(within(nav).getByRole('link', { name: 'General' }).getAttribute('aria-current')).toBeNull()
    expect(await screen.findByRole('heading', { level: 2, name: 'About' })).toBeTruthy()
    expect(screen.queryByText('Home directory for clones')).toBeNull()
  })

  it('is an index of rows on a phone, each pushing its category', async () => {
    mountSettings('phone', '/settings')
    const row = await screen.findByRole('link', { name: 'Providers' })
    expect(row.getAttribute('href')).toBe('/settings/providers')
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull()
    expect(screen.queryByText('Home directory for clones')).toBeNull()
  })

  it('draws one category on a phone with no list beside it', async () => {
    mountSettings('phone', '/settings/agents')
    expect(await screen.findByText('Claude Code')).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull()
  })

  it('says a category it does not know is nowhere', async () => {
    mountSettings('desktop', '/settings/plugins')
    expect(await screen.findByText(/Nothing is at \/settings\/plugins/)).toBeTruthy()
  })
})
