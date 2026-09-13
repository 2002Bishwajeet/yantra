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
  it('leads with a ready verdict, and draws About and only this machine’s workspaces', async () => {
    mount('desktop', '/m/cachyos-g14')
    await screen.findByRole('heading', { level: 1, name: 'cachyos-g14' }, { timeout: 2000 })
    await screen.findByText(/^looked /)

    const ready = card('Readiness')
    expect(ready.getByRole('heading', { level: 2, name: 'Ready for sessions' })).toBeTruthy()
    expect(ready.getByText(/^10 of 10 · asked/)).toBeTruthy()
    expect(ready.getByRole('link', { name: 'New session' })).toBeTruthy()
    expect(ready.getByRole('button', { name: 'Check again' })).toBeTruthy()
    expect(screen.getAllByText('ready').length).toBeGreaterThan(0)

    // The ten are folded to one line until asked for, by the names D7 §3.5 gives them.
    fireEvent.click(ready.getByRole('button', { name: /^Show/ }))
    expect(ready.getAllByText('ok')).toHaveLength(10)
    expect(ready.getByText('gh signed in')).toBeTruthy()
    expect(ready.getByText('claude signed in')).toBeTruthy()

    const about = card('About')
    expect(about.getByText('linux')).toBeTruthy()
    expect(about.getByText('online')).toBeTruthy()
    expect(about.getByText(/beat 4s ago/)).toBeTruthy()

    const here = card('Workspaces on this machine')
    expect(here.getByRole('link', { name: 'yantra-web' })).toBeTruthy()
    expect(here.getByRole('link', { name: 'agent-sdk' })).toBeTruthy()
    expect(here.getByText('waiting for trust')).toBeTruthy()
    // `landing` lives on macbook, so it is not drawn here.
    expect(here.queryByText('landing')).toBeNull()
  })

  it('puts Readiness first', async () => {
    mount('desktop', '/m/cachyos-g14')
    await screen.findByText(/^looked /)
    const titles = screen.getAllByRole('region').map((one) => one.getAttribute('aria-labelledby'))
    expect(screen.getAllByRole('region')[0]!.textContent).toContain('Readiness')
    expect(titles.length).toBeGreaterThanOrEqual(4)
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

  it('reads a report the daemon has not taken yet as Not checked yet, never as a failure', async () => {
    const busy = scenario('busy')
    const readiness = busy.readiness as { looked: string; data: { machine: string }[] }
    const state = {
      ...busy,
      readiness: { ...readiness, data: readiness.data.filter((one) => one.machine !== 'cachyos-g14') },
    }
    mount('desktop', '/m/cachyos-g14', state as unknown as typeof busy)
    const ready = within(await screen.findByRole('region', { name: 'Readiness' }))
    expect(await ready.findByRole('heading', { name: 'Not checked yet' })).toBeTruthy()
    expect(ready.getByRole('button', { name: 'Check again' })).toBeTruthy()
    expect(screen.queryByText(/yantrad was not reached/)).toBeNull()
  })
})

describe('/m/pi-5, which is missing git and claude', () => {
  /** pi-5's report has no `git` check at all: `missingBasics` (`lib/ready`)
   *  counts an unasked basic as missing too, the same as the machines-list
   *  card does (Y-402 review), so it joins `agent-cli`'s explicit absence. */
  it('offers Install and no New session, and the press starts it', async () => {
    const asked = mount('desktop', '/m/pi-5')
    const ready = within(await screen.findByRole('region', { name: 'Readiness' }))
    expect(await ready.findByRole('heading', { name: 'git and claude are missing' })).toBeTruthy()
    expect(ready.queryByRole('link', { name: 'New session' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'New session' })).toBeNull()
    fireEvent.click(ready.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(asked).toContain('POST /api/machines/pi-5/install'))
    expect(await ready.findByRole('heading', { name: 'Installing git and claude' })).toBeTruthy()
    expect(ready.getByRole('progressbar', { name: 'Installing on pi-5' })).toBeTruthy()
  })
})

describe('/m/thinkpad, which is off', () => {
  it('is asleep, not failed, and asks nothing', async () => {
    mount('desktop', '/m/thinkpad')
    await screen.findByRole('heading', { level: 1, name: 'thinkpad' }, { timeout: 2000 })
    const ready = card('Readiness')
    expect(await ready.findByRole('heading', { name: 'thinkpad is asleep' })).toBeTruthy()
    expect(ready.getByText(/Yantra asks again when it comes back/)).toBeTruthy()
    expect(ready.queryByRole('button', { name: 'Check again' })).toBeNull()
    expect(screen.getByText(/^asleep/)).toBeTruthy()
    const sessions = card('Sessions')
    expect(await sessions.findByText('the machine did not answer')).toBeTruthy()
    expect(sessions.getByText(/No route to host/)).toBeTruthy()
    // N2: no Kill here, so nothing says how Kill behaves.
    expect(sessions.queryByText(/Kill asks first/)).toBeNull()
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
  it('says so in place when the machines body is not the contract', async () => {
    const broken = { ...scenario('busy'), machines: { looked: 'ok', age_seconds: 0 } } as unknown as ReturnType<typeof scenario>
    mount('desktop', '/m/cachyos-g14', broken)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Machines could not be read')
    expect(screen.getByRole('heading', { level: 1, name: 'cachyos-g14' })).toBeTruthy()
  })

  it('is one page-sized error with Try again', async () => {
    mount('desktop', '/m/cachyos-g14', scenario('unreachable'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Nothing here can be reached')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})
