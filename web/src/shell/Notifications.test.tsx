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
    // One filled button at most: Answer is tonal and Mark all read is text.
    expect(popover.getAllByRole('button').filter((b) => b.dataset.variant === 'filled').length).toBeLessThanOrEqual(1)
    expect(answer.dataset.variant).toBe('tonal')
    expect(popover.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings/notifications')
  })

  it('Mark all read moves the seen mark and empties Unread', async () => {
    mount('desktop')
    const popover = await open()
    await popover.findAllByRole('listitem')
    fireEvent.click(popover.getByRole('button', { name: 'Mark all read' }))
    expect(readPrefs().seenAt).toBe(1786471773)
    expect(JSON.parse(localStorage.getItem('yantra.prefs')!).seenAt).toBe(1786471773)
    expect(await popover.findByText('Nothing unread')).toBeTruthy()
    // Nothing unread: the action cannot apply, so it is not drawn.
    expect(popover.queryByRole('button', { name: 'Mark all read' })).toBeNull()
    // The badge is the Unread tab's count, so it clears with it.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy())
    fireEvent.click(popover.getByRole('radio', { name: 'All' }))
    // Nine fixture events (contract.gen.ts) and the two GitHub items.
    expect((await popover.findAllByRole('listitem')).length).toBe(11)
  })
})

describe('install and join rows (Y-399)', () => {
  it('shows the full warning, the commands via Copyable, a machine tile and a row that links to the machine', async () => {
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
    expect(within(joinedItem!).queryByRole('button', { name: 'Open' })).toBeNull()
    expect(joinedItem!.querySelector('a.m3-row')!.getAttribute('href')).toBe('/m/pi-5')

    const installItem = items.find((item) => item.textContent?.includes('needs your password'))
    expect(installItem).toBeTruthy()
    expect(installItem!.textContent).toContain('sudo apt-get install -y tmux')
    expect(within(installItem!).getByRole('button', { name: 'Copy the command' })).toBeTruthy()
    expect(within(installItem!).queryByText('Open')).toBeNull()
    expect(installItem!.querySelector('a.m3-row')!.getAttribute('href')).toBe('/m/pi-5')
    // The commands stay outside the link: a link cannot hold a button.
    expect(installItem!.querySelector('a.m3-row button')).toBeNull()
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

describe('row taps (Y-722)', () => {
  const at = (n: number, kind: Event['kind'], workspace: string | null, machine: string | null): Event =>
    ({ at: 1785522000 + n, kind, workspace, machine, said: `${kind} said`, commands: [] }) as Event

  it.each(['finished', 'crashed', 'killed', 'check_failed', 'checks_passed', 'reviewed'] as const)(
    'a %s row is a link to the workspace',
    async (kind) => {
      mount('desktop', '/', {
        overrides: {
          '/api/notifications': { body: { looked: 'ok', age_seconds: 0, data: [at(1, kind, 'api', 'pi-5')] } },
        },
      })
      const popover = await open()
      const item = (await popover.findAllByRole('listitem')).find((one) => one.textContent?.includes('said'))!
      expect(item.querySelector('a.m3-row')!.getAttribute('href')).toBe('/w/api')
    },
  )

  it('an unreachable row is a link to the machine', async () => {
    mount('desktop', '/', {
      overrides: {
        '/api/notifications': { body: { looked: 'ok', age_seconds: 0, data: [at(1, 'unreachable', null, 'pi-5')] } },
      },
    })
    const popover = await open()
    const item = (await popover.findAllByRole('listitem')).find((one) => one.textContent?.includes('said'))!
    expect(item.querySelector('a.m3-row')!.getAttribute('href')).toBe('/m/pi-5')
  })

  it('a trust row links to the workspace and keeps Answer outside the link', async () => {
    mount('desktop', '/', {
      overrides: {
        '/api/notifications': { body: { looked: 'ok', age_seconds: 0, data: [at(1, 'awaiting_trust', 'api', null)] } },
      },
    })
    const popover = await open()
    const item = (await popover.findAllByRole('listitem')).find((one) => one.textContent?.includes('said'))!
    expect(item.querySelector('a.m3-row')!.getAttribute('href')).toBe('/w/api')
    expect(item.querySelector('a.m3-row a, a.m3-row button')).toBeNull()
    const answer = within(item).getByRole('link', { name: 'Answer' })
    expect(answer.getAttribute('href')).toBe('/w/api?view=chat')
    // A trailing sibling of the row link, not a block under it.
    expect(answer.closest('.notifications__item')).not.toBeNull()
    expect(item.querySelector('a.m3-row')!.contains(answer)).toBe(false)
    expect(item.querySelector('a.m3-row')).not.toBeNull()
  })
})

describe('repeated unreachable rows (Y-669)', () => {
  it('fold into one row whose supporting line carries the count', async () => {
    const gone = (at: number): Event => ({
      at,
      kind: 'unreachable',
      workspace: null,
      machine: 'pi-5',
      said: 'pi-5 is no longer online',
      commands: [],
    })
    mount('desktop', '/', {
      overrides: {
        '/api/notifications': { body: { looked: 'ok', age_seconds: 0, data: [gone(1785522900), gone(1785522800), gone(1785522700)] } },
      },
    })
    const popover = await open()
    const items = await popover.findAllByRole('listitem')
    const rows = items.filter((item) => item.textContent?.includes('pi-5 became unreachable'))
    expect(rows).toHaveLength(1)
    const supporting = rows[0]!.querySelector('.m3-row__supporting')!
    expect(supporting.textContent).toMatch(/^3 times since .+ · pi-5 is no longer online$/)
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
