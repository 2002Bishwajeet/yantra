import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { mount, unmount } from './harness'

afterEach(() => {
  cleanup()
  unmount()
})

const failed = { body: { looked: 'failed', age_seconds: 0, error: 'tailscale did not answer' } }

describe('the sessions rail when its read fails', () => {
  it('says so in an inline error surface, with Try again, and not in a bare line', async () => {
    const asked = mount('desktop', '/', { overrides: { '/api/workspaces': failed } })
    const rail = await screen.findByRole('complementary', { name: 'Sessions' })
    const alert = await within(rail).findByRole('alert')
    expect(alert.getAttribute('data-layout')).toBe('inline')
    expect(within(alert).getByText('Sessions could not be read')).toBeTruthy()
    expect(within(alert).getByText('tailscale did not answer')).toBeTruthy()
    expect(rail.querySelector('.rail__note')).toBeNull()

    const before = asked.filter((one) => one === 'GET /api/workspaces').length
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(asked.filter((one) => one === 'GET /api/workspaces').length).toBeGreaterThan(before))
  })

  it('keeps the plain note for a read nobody has made yet', async () => {
    mount('desktop', '/', { overrides: { '/api/workspaces': { body: { looked: 'never' } } } })
    const rail = await screen.findByRole('complementary', { name: 'Sessions' })
    expect(await within(rail).findByText('Sessions have not been read yet.')).toBeTruthy()
    expect(within(rail).queryByRole('alert')).toBeNull()
  })
})

/** Y-639: `unclear` has one real cause, a live pane, and every Stop ends in
 *  `no_session`, which the rail calls stopped. */
describe('the sessions rail groups each state', () => {
  it('files running and unclear under Live, and stopped and no_session under History', async () => {
    const workspace = (name: string) => ({ loaded: 'yes', machine: 'cachyos-g14', name, repo: '/srv/repo', startup: null })
    mount('desktop', '/', {
      overrides: {
        '/api/workspaces': {
          body: { looked: 'ok', age_seconds: 0, data: ['api', 'ghost', 'halted', 'gone'].map(workspace) },
        },
      },
    })
    const rail = await screen.findByRole('complementary', { name: 'Sessions' })
    const live = await within(rail).findByRole('region', { name: 'Live' })
    const history = within(rail).getByRole('region', { name: 'History' })

    await waitFor(() => expect(within(live).getAllByRole('link').map((one) => one.textContent)).toHaveLength(2))
    expect(within(live).getByRole('link', { name: /^api/ })).toBeTruthy()
    expect(within(live).getByRole('link', { name: /^ghost.*unclear/ })).toBeTruthy()
    expect(within(history).getByRole('link', { name: /^halted.*stopped/ })).toBeTruthy()
    expect(within(history).getByRole('link', { name: /^gone.*stopped/ })).toBeTruthy()
    expect(within(rail).queryByText(/no session/)).toBeNull()
  })
})
