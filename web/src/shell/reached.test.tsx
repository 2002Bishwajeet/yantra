import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'
import { NOT_REACHED } from '@/api/client'
import { looked } from '@/api/fixtures'
import { mount, unmount } from './harness'
import { notReached } from './reached'

afterEach(() => {
  cleanup()
  unmount()
})

const dead = (why: string) => looked.failed<unknown>(`${NOT_REACHED}: ${why}`)

describe('what counts as the daemon not being reached', () => {
  it('collapses reads that all failed before the daemon answered', () => {
    expect(notReached([dead('HTTP 502'), dead('HTTP 502'), dead('HTTP 502')])).toBe(
      `${NOT_REACHED}: HTTP 502`,
    )
  })

  /** The sharp one: `tailscaled` is down on the daemon's own box, so the
   *  daemon answered and its look failed. That is fleet news, and the screen
   *  that owns the class keeps it. */
  it('is null when the daemon answered and said its own look failed', () => {
    const said = looked.failed<unknown>('`tailscale status --json` failed')
    expect(notReached([said, said, said])).toBeNull()
  })

  it('is null unless every read agrees', () => {
    expect(notReached([dead('HTTP 502'), dead('TypeError: Failed to fetch')])).toBeNull()
    expect(notReached([dead('HTTP 502'), { looked: 'pending' }])).toBeNull()
    expect(notReached([dead('HTTP 502'), looked.ok<unknown>([])])).toBeNull()
    expect(notReached([])).toBeNull()
  })
})

describe('the screen a dead daemon draws', () => {
  it('replaces the route with one board, and draws no fleet data', async () => {
    mount('desktop', '/', { down: true })
    const alert = await screen.findByRole('alert')
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    const board = within(alert)
    expect(board.getByText('Yantra')).toBeTruthy()
    expect(board.getByRole('heading', { name: 'Yantra cannot be reached' })).toBeTruthy()
    expect(board.getByText(`${NOT_REACHED}: HTTP 502`)).toBeTruthy()
    expect(board.getByText(/off the tailnet/)).toBeTruthy()
    expect(board.getByText(/yantrad down/)).toBeTruthy()
    expect(board.getByText(/retrying every 5 s/)).toBeTruthy()
    expect(board.getByRole('button', { name: 'Try again' })).toBeTruthy()
    // Finding 131: the board draws the way out beside the retry.
    expect(board.getByRole('link', { name: 'Open Tailscale' }).getAttribute('href')).toBe(
      'https://login.tailscale.com/admin/machines',
    )

    // Nothing of the fleet: no Dashboard, and no rail listing sessions.
    expect(screen.queryByRole('heading', { level: 1, name: 'Dashboard' })).toBeNull()
    expect(screen.queryByRole('complementary', { name: 'Sessions' })).toBeNull()
  })

  it('leaves the navigation in place so a person can still move', async () => {
    mount('desktop', '/', { down: true })
    await screen.findByRole('alert')
    const nav = within(screen.getByRole('navigation', { name: 'Main' }))
    for (const label of ['Dashboard', 'Fleet', 'Machines', 'Usage']) {
      expect(nav.getByRole('link', { name: label })).toBeTruthy()
    }
  })

  /** Settings reads nothing swept of its own, and the owner still asked for
   *  one screen: the daemon is down for Settings as much as for the fleet. */
  it('stands in front of a settings route too', async () => {
    mount('desktop', '/settings/providers', { down: true })
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: 'Yantra cannot be reached' })).toBeTruthy()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.queryByText(/Providers could not be drawn/)).toBeNull()
  })

  it('draws nothing of itself while the daemon answers', async () => {
    mount('desktop', '/')
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' })
    expect(screen.queryByText('Yantra cannot be reached')).toBeNull()
    expect(screen.getByRole('complementary', { name: 'Sessions' })).toBeTruthy()
  })
})
