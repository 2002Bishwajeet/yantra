import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { mount, unmount } from './harness'

afterEach(() => {
  cleanup()
  unmount()
})

const DESTINATIONS = ['Dashboard', 'Fleet', 'Machines', 'Usage']

const nav = () => within(screen.getByRole('navigation', { name: 'Main' }))

describe('the desktop shell', () => {
  it('has the four destinations as pills, the open one current', async () => {
    mount('desktop', '/fleet')
    await screen.findByRole('heading', { level: 1, name: 'Fleet' })
    for (const label of DESTINATIONS) expect(nav().getByRole('link', { name: label })).toBeTruthy()
    expect(nav().getByRole('link', { name: 'Fleet' }).getAttribute('aria-current')).toBe('page')
    expect(nav().getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBeNull()
    expect(document.querySelector('[data-shell]')?.getAttribute('data-shell')).toBe('desktop')
  })

  it('draws the sessions rail on / and /new and nowhere else', async () => {
    mount('desktop')
    const rail = await screen.findByRole('complementary', { name: 'Sessions' })
    expect(await within(rail).findByRole('link', { name: /api/ })).toBeTruthy()
    expect(within(rail).getByRole('region', { name: 'Live' })).toBeTruthy()
    expect(within(rail).getByRole('link', { name: 'All sessions →' }).getAttribute('href')).toBe('/fleet')

    fireEvent.click(nav().getByRole('link', { name: 'Machines' }))
    await screen.findByRole('heading', { level: 1, name: 'Machines' })
    expect(screen.queryByRole('complementary', { name: 'Sessions' })).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: 'Yantra' }))
    expect(await screen.findByRole('complementary', { name: 'Sessions' })).toBeTruthy()
  })

  it('counts unseen events and GitHub items on the bell', async () => {
    mount('desktop')
    // Four events, none seen, plus one review and one issue.
    expect(await screen.findByRole('button', { name: /Notifications\s*6 unread/ })).toBeTruthy()
  })

  it('offers Settings and About from the avatar', async () => {
    mount('desktop')
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Settings' }).getAttribute('href')).toBe('/settings')
    expect(within(menu).getByRole('menuitem', { name: 'About' }).getAttribute('href')).toBe('/settings/about')
  })

  it('says nothing is at a path nothing routes', async () => {
    mount('desktop', '/nope')
    expect(await screen.findByText(/Nothing is at/)).toBeTruthy()
  })
})

describe('the tablet shell', () => {
  it('has a rail with the New FAB on top and no pill group', async () => {
    mount('tablet', '/usage')
    await screen.findByRole('heading', { level: 1, name: 'Usage' })
    const rail = nav()
    for (const label of DESTINATIONS) expect(rail.getByRole('link', { name: label })).toBeTruthy()
    expect(rail.getByRole('link', { name: 'Usage' }).getAttribute('aria-current')).toBe('page')
    expect(rail.getByRole('link', { name: 'New session' }).getAttribute('href')).toBe('/new')
    expect(document.querySelector('.m3-pill-group')).toBeNull()
    expect(screen.queryByRole('complementary', { name: 'Sessions' })).toBeNull()
  })

  it('opens notifications as a side sheet', async () => {
    mount('tablet')
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' })
    // A hidden aside has no accessible name to query by.
    expect(document.querySelector<HTMLElement>('aside[aria-label="Notifications"]')?.hidden).toBe(true)
    fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }))
    const sheet = screen.getByRole('complementary', { name: 'Notifications' })
    expect(sheet.hidden).toBe(false)
    expect(await within(sheet).findByText('api is waiting for trust')).toBeTruthy()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close Notifications' }))
    expect(sheet.hidden).toBe(true)
  })
})

describe('the phone shell', () => {
  it('has a bottom bar, a FAB, and the app bar as the heading', async () => {
    mount('phone', '/machines')
    await screen.findAllByRole('heading', { level: 1, name: 'Machines' })
    const bar = nav()
    for (const label of DESTINATIONS) expect(bar.getByRole('link', { name: label })).toBeTruthy()
    expect(bar.getByRole('link', { name: 'Machines' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'New session' }).getAttribute('href')).toBe('/new')
    expect(screen.getByRole('banner').querySelector('h1')?.textContent).toBe('Machines')
    expect(screen.getByRole('link', { name: /Notifications/ }).getAttribute('href')).toBe('/notifications')
  })

  it('pushes settings: a back arrow, no bar, no FAB', async () => {
    mount('phone', '/settings')
    await waitFor(() => expect(screen.getByRole('banner').querySelector('h1')?.textContent).toBe('Settings'))
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'New session' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(location.pathname).toBe('/'))
  })

  it('opens notifications as a pushed screen', async () => {
    mount('phone', '/notifications')
    await waitFor(() => expect(screen.getByRole('banner').querySelector('h1')?.textContent).toBe('Notifications'))
    expect(await screen.findByText('api is waiting for trust')).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
  })
})
