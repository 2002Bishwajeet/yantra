import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { mount, scenario, unmount } from '@/screens/fleet/harness'

// The route is lazy, so the first mount pays for its chunk; warming it here
// keeps that cost out of the first test's own timeout.
beforeAll(async () => {
  await import('./Machine')
}, 60_000)

afterEach(() => {
  cleanup()
  unmount()
})

const card = (name: string) => within(screen.getByRole('region', { name }))

describe('/m/cachyos-g14 on the busy fleet', () => {
  it('draws About, the nine checks, and only this machine’s workspaces', async () => {
    mount('desktop', '/m/cachyos-g14')
    await screen.findByRole('heading', { level: 1, name: 'cachyos-g14' }, { timeout: 2000 })
    await screen.findByText(/^looked /)

    const about = card('About')
    expect(about.getByText('linux')).toBeTruthy()
    expect(about.getByText('online')).toBeTruthy()
    expect(about.getByText(/beat 4s ago/)).toBeTruthy()

    const ready = card('Readiness')
    expect(ready.getByText(/^9 of 9 · asked/)).toBeTruthy()
    expect(ready.getAllByText('ok')).toHaveLength(9)
    expect(ready.getByText('provider-auth')).toBeTruthy()

    const here = card('Workspaces on this machine')
    expect(here.getByRole('link', { name: 'yantra-web' })).toBeTruthy()
    expect(here.getByRole('link', { name: 'agent-sdk' })).toBeTruthy()
    expect(here.getByText('waiting for trust')).toBeTruthy()
    // `landing` lives on macbook, so it is not drawn here.
    expect(here.queryByText('landing')).toBeNull()
  })

  it('gives one verb a row, and Resume never asks first', async () => {
    const asked = mount('desktop', '/m/cachyos-g14')
    await screen.findByText(/^looked /)
    const here = card('Workspaces on this machine')
    expect((await here.findByRole('link', { name: 'Answer' })).getAttribute('href')).toBe(
      '/w/yantra-web?view=chat',
    )
    fireEvent.click(here.getByRole('button', { name: 'Resume' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(asked).toContain('POST /api/workspaces/price-table/resume'))
  })

  it('lists every tmux session, claimed or not, and never adopts one', async () => {
    mount('desktop', '/m/cachyos-g14')
    await screen.findByText(/^looked /)
    const sessions = card('Sessions')
    expect(sessions.getByText(/4 tmux sessions · 1 no workspace claims/)).toBeTruthy()
    expect(sessions.getAllByRole('link', { name: 'Terminal' })).toHaveLength(3)
    expect(sessions.getByRole('link', { name: 'Attach' }).getAttribute('href')).toBe(
      '/m/cachyos-g14/s/scratch',
    )
    expect(sessions.getByText(/no workspace claims it/)).toBeTruthy()
    expect(sessions.queryByRole('button', { name: 'Adopt' })).toBeNull()
  })

  it('Kill asks first and names the session', async () => {
    const asked = mount('desktop', '/m/cachyos-g14')
    await screen.findByText(/^looked /)
    const sessions = card('Sessions')
    fireEvent.click(sessions.getAllByRole('button', { name: 'Kill' })[0]!)
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('Kill yantra-web?')).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Kill' }))
    await waitFor(() =>
      expect(asked).toContain('DELETE /api/machines/cachyos-g14/sessions/yantra-web'),
    )
  })
})

describe('/m/thinkpad, which did not answer', () => {
  it('draws the machine’s own words in place of its sessions', async () => {
    mount('desktop', '/m/thinkpad')
    await screen.findByRole('heading', { level: 1, name: 'thinkpad' }, { timeout: 2000 })
    const sessions = card('Sessions')
    expect(await sessions.findByText('the machine did not answer')).toBeTruthy()
    expect(sessions.getByText(/No route to host/)).toBeTruthy()
    expect(card('Readiness').getAllByText('unknown').length).toBeGreaterThan(0)
  })
})

describe('/m/nowhere', () => {
  it('says no machine has that name and offers the list', async () => {
    mount('desktop', '/m/nowhere')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('No machine is called nowhere.')
    expect(within(alert).getByRole('link', { name: 'Machines' })).toBeTruthy()
  })
})

describe('/m/cachyos-g14 when nothing can be reached', () => {
  it('is one page-sized error with Try again', async () => {
    mount('desktop', '/m/cachyos-g14', scenario('unreachable'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Nothing here can be reached')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})
