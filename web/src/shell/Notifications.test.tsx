import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { Event } from '@/api'
import * as contract from '@/contract.gen'
import { mount, unmount } from './harness'
import { readPrefs } from './prefs'

afterEach(() => {
  cleanup()
  unmount()
})

async function open() {
  fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }))
  return within(await screen.findByRole('dialog', { name: 'Notifications' }))
}

const joined: Event = {
  at: 1785522900,
  kind: 'joined',
  workspace: null,
  machine: 'pi-5',
  said: 'pi-5 joined as biswa, but the ssh config logs in there as someone-else, so Yantra cannot reach it until the owner edits that config',
  commands: [],
  user: 'biswa',
  kept: false,
  logs_in_as: 'someone-else',
}
const installStopped: Event = {
  at: 1785522850,
  kind: 'install_stopped',
  workspace: null,
  machine: 'pi-5',
  said: 'pi-5: tmux left for you — run `sudo apt-get install -y tmux` on pi-5',
  commands: ['sudo apt-get install -y tmux'],
}

describe('notifications on the desktop', () => {
  it('opens as a popover, newest first, with Answer on a trust prompt', async () => {
    mount('desktop')
    const popover = await open()
    const rows = await popover.findAllByRole('listitem')
    // The issue's `updated_at` is the newest instant in the fixtures.
    expect(rows[0]!.textContent).toContain('Issue assigned: yantra#118')
    expect(rows.at(-1)!.textContent).toContain('api is waiting for trust')
    const answer = popover.getByRole('link', { name: 'Answer' })
    expect(answer.getAttribute('href')).toBe('/w/api?view=chat')
    expect(popover.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings/notifications')
  })

  it('Mark all read moves the seen mark and empties Unread', async () => {
    mount('desktop')
    const popover = await open()
    await popover.findAllByRole('listitem')
    fireEvent.click(popover.getByRole('button', { name: 'Mark all read' }))
    expect(readPrefs().seenAt).toBe(1786471773)
    expect(JSON.parse(localStorage.getItem('yantra.prefs')!).seenAt).toBe(1786471773)
    expect(await popover.findByText('Nothing unread.')).toBeTruthy()
    // The GitHub items still count: they have no read state of their own.
    await waitFor(() => expect(screen.getByRole('button', { name: /Notifications\s*2 unread/ })).toBeTruthy())
    fireEvent.click(popover.getByRole('radio', { name: 'All' }))
    // Y-399's fixture `joined` event is the eighth (contract.gen.ts).
    expect((await popover.findAllByRole('listitem')).length).toBe(8)
  })
})

describe('install and join rows (Y-399)', () => {
  it('shows the full warning, the commands via Copyable, a machine tile and Open', async () => {
    mount('desktop', '/', {
      overrides: { '/api/notifications': { body: { looked: 'ok', age_seconds: 0, data: [joined, installStopped] } } },
    })
    const popover = await open()
    const items = await popover.findAllByRole('listitem')

    const joinedItem = items.find((item) => item.textContent?.includes('as another account'))
    expect(joinedItem).toBeTruthy()
    expect(joinedItem!.textContent).toContain(joined.said)
    expect(joinedItem!.querySelector('.m3-row__supporting')!.classList.contains('m3-wrap')).toBe(true)
    expect(joinedItem!.querySelector('.m3-tile--icon')).toBeTruthy()
    expect(within(joinedItem!).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/m/pi-5')

    const installItem = items.find((item) => item.textContent?.includes('needs your password'))
    expect(installItem).toBeTruthy()
    expect(installItem!.textContent).toContain('sudo apt-get install -y tmux')
    expect(within(installItem!).getByRole('button', { name: 'Copy the command' })).toBeTruthy()
    expect(within(installItem!).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/m/pi-5')
  })

  it('a plain join is done and never draws a letter avatar', async () => {
    const plain: Event = {
      ...joined,
      said: 'pi-5 joined, and Yantra logs in there as biswa',
      logs_in_as: 'biswa',
    }
    mount('desktop', '/', {
      overrides: { '/api/notifications': { body: { looked: 'ok', age_seconds: 0, data: [plain] } } },
    })
    const popover = await open()
    const items = await popover.findAllByRole('listitem')
    const item = items.find((one) => one.textContent?.includes('pi-5 joined'))
    expect(item).toBeTruthy()
    expect(item!.textContent).toContain('as biswa')
    // The machine tile is the icon glyph, not the workspace's letter avatar.
    const tile = item!.querySelector('.m3-tile')
    expect(tile?.classList.contains('m3-tile--icon')).toBe(true)
    expect(tile?.querySelector('svg')).toBeTruthy()
  })
})

describe('the footer reads the relay (Y-399)', () => {
  it('says on when about.relay is true', async () => {
    mount('desktop')
    const popover = await open()
    expect(await popover.findByText('Push to your phone is on')).toBeTruthy()
  })

  it('says off when about.relay is false', async () => {
    mount('desktop', '/', { overrides: { '/api/about': { body: { ...contract.about, relay: false } } } })
    const popover = await open()
    expect(await popover.findByText('Push to your phone is off')).toBeTruthy()
  })

  it('says unknown while about has not answered', async () => {
    mount('desktop', '/', { overrides: { '/api/about': { status: 503, body: 'not now' } } })
    const popover = await open()
    expect(await popover.findByText('Push to your phone is unknown')).toBeTruthy()
  })
})

describe('a notifications read that fails (Y-399)', () => {
  it('is a typed error, not an empty list', async () => {
    mount('desktop', '/', { overrides: { '/api/notifications': { status: 503, body: 'notifications are down' } } })
    const popover = await open()
    const alert = await popover.findByRole('alert')
    expect(alert.textContent).toContain('Notifications could not be read')
    expect(alert.textContent).toContain('notifications are down')
  })
})
