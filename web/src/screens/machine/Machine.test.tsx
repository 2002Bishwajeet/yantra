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

const openEverything = () =>
  document.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]').forEach((one) => fireEvent.click(one))

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

    // Y-714: ten checks passed, so the card lists none and has no probe text to show.
    expect(ready.queryByText('ok')).toBeNull()
    expect(ready.queryByText('gh signed in')).toBeNull()
    expect(ready.queryByRole('button', { name: /What ssh said/ })).toBeNull()

    const about = card('About')
    expect(about.getByText('linux')).toBeTruthy()
    expect(about.getByText('online')).toBeTruthy()
    expect(about.getByText('CPU')).toBeTruthy()
    expect(about.getByText(/% busy$/)).toBeTruthy()
    expect(about.queryByText(/beat/)).toBeNull()

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
    expect(ready.getByRole('button', { name: 'Check' })).toBeTruthy()
    expect(screen.queryByText(/yantrad was not reached/)).toBeNull()
  })

  /** Y-585: the sweep skips a machine no workspace names, and Sessions asks it
   *  anyway. Both cards then say the one thing that is known. */
  it('gives one title in both cards when only the sessions failed', async () => {
    const busy = scenario('busy')
    const error = 'ssh to cachyos-g14 failed before the command reported a status: No route to host'
    const state = {
      ...busy,
      readiness: { looked: 'never' },
      sessions: { looked: 'ok', age_seconds: 0, data: [{ machine: 'cachyos-g14', reached: 'no', error }] },
    }
    mount('desktop', '/m/cachyos-g14', state as unknown as typeof busy)
    const ready = within(await screen.findByRole('region', { name: 'Readiness' }))
    const title = 'ssh to cachyos-g14 fails'
    expect(await ready.findByRole('heading', { name: title })).toBeTruthy()
    expect(ready.queryByText('Not checked yet')).toBeNull()

    const sessions = card('Sessions')
    expect(await sessions.findByText(title)).toBeTruthy()
    expect(sessions.queryByText(/No route to host/)).toBeNull()
    fireEvent.click(sessions.getByRole('button', { name: /What ssh said/ }))
    expect(sessions.getByText(error)).toBeTruthy()
  })

  it('classifies the sessions error itself when Readiness has not failed', async () => {
    const busy = scenario('busy')
    const error = 'ssh to cachyos-g14 failed before the command reported a status: Tailscale SSH requires an additional check'
    const state = {
      ...busy,
      sessions: { looked: 'ok', age_seconds: 0, data: [{ machine: 'cachyos-g14', reached: 'no', error }] },
    }
    mount('desktop', '/m/cachyos-g14', state as unknown as typeof busy)
    const ready = within(await screen.findByRole('region', { name: 'Readiness' }))
    expect(await ready.findByRole('heading', { name: 'Ready for sessions' })).toBeTruthy()
    expect(await card('Sessions').findByText('cachyos-g14 needs a browser sign-in')).toBeTruthy()
  })

  /** Y-585 review: tmux's own `Permission denied` is not the appliance's key. */
  it('never calls a tmux error an ssh failure, and keeps its text behind a disclosure', async () => {
    const busy = scenario('busy')
    const error = 'tmux `list-sessions` failed with status 1: error connecting to /tmp/tmux-1000/default (Permission denied)'
    const state = {
      ...busy,
      readiness: { looked: 'never' },
      sessions: { looked: 'ok', age_seconds: 0, data: [{ machine: 'cachyos-g14', reached: 'no', error }] },
    }
    mount('desktop', '/m/cachyos-g14', state as unknown as typeof busy)
    const ready = within(await screen.findByRole('region', { name: 'Readiness' }))
    expect(await ready.findByRole('heading', { name: 'Not checked yet' })).toBeTruthy()

    const sessions = card('Sessions')
    expect(await sessions.findByText('The sessions could not be listed')).toBeTruthy()
    expect(sessions.getByText(/not an ssh failure/)).toBeTruthy()
    for (const words of [/ssh to/, /key was refused/, /What ssh said/, /Permission denied/]) {
      expect(screen.queryByText(words)).toBeNull()
    }
    fireEvent.click(sessions.getByRole('button', { name: /The full error/ }))
    expect(sessions.getByText(error)).toBeTruthy()
  })
})

describe('About on the machine page', () => {
  it('draws the numbers as tiles and the two long names as list items, with no Heartbeat row and no trailing dot', async () => {
    mount('desktop', '/m/cachyos-g14')
    await screen.findByText(/^looked /)
    const region = screen.getByRole('region', { name: 'About' })
    const about = region.querySelector('dl')!
    const labels = [...about.querySelectorAll('dt')].map((one) => one.textContent)
    expect(labels).toEqual(expect.arrayContaining(['OS', 'Architecture', 'Status', 'CPU', 'Memory', 'Disk', 'Power']))
    expect(labels).not.toContain('Heartbeat')
    // Each tile holds one dt, one dd and an icon.
    const tiles = [...about.querySelectorAll('.machine__fact')]
    expect(tiles).toHaveLength(labels.length)
    for (const tile of tiles) {
      expect(tile.querySelectorAll('dt')).toHaveLength(1)
      expect(tile.querySelectorAll('dd')).toHaveLength(1)
      expect(tile.querySelector('dt svg')).not.toBeNull()
    }

    const items = [...region.querySelectorAll('.m3-list-item')]
    const named = (word: string) => items.find((one) => one.querySelector('.m3-list-item__headline')?.textContent === word)!
    expect(named('Address').querySelector('.machine__num')).not.toBeNull()
    const name = named('Tailnet name').querySelector('.m3-list-item__supporting') as HTMLElement
    expect(name.textContent).not.toMatch(/\.$/)
    expect(name.querySelectorAll('wbr').length).toBeGreaterThan(0)
    expect(name.textContent).toMatch(/^cachyos-g14\..+\.ts\.net$/)
  })

  it('draws no usage rows and no zeros for a machine that never reported (I-47)', async () => {
    const state = scenario('busy')
    ;(state.machines!.data as { name: string; heartbeat: unknown }[]).find((one) => one.name === 'cachyos-g14')!.heartbeat = null
    mount('desktop', '/m/cachyos-g14', state)
    await screen.findByText(/^looked /)
    const about = within(screen.getByRole('region', { name: 'About' }))
    expect(about.queryByText('CPU')).toBeNull()
    expect(about.queryByText('Memory')).toBeNull()
    expect(about.queryByText(/never|beat/)).toBeNull()
  })
})

describe('the machine page keeps monospace for commands (Y-714)', () => {
  it('has a .m3-mono only inside a .m3-copyable, with every disclosure open', async () => {
    mount('desktop', '/m/cachyos-g14')
    await screen.findByText(/^looked /)
    openEverything()
    const stray = [...document.querySelectorAll('.machine__card .m3-mono')].filter((one) => !one.closest('.m3-copyable'))
    expect(stray.map((one) => one.textContent)).toEqual([])
  })
})

describe('the machine page in plain words', () => {
  it('names no ADR, invariant, beat or yantra-agent anywhere, with every check open', async () => {
    mount('desktop', '/m/cachyos-g14')
    await screen.findByText(/^looked /)
    openEverything()
    expect((document.body.textContent ?? '').match(/.{30}(ADR-\d|I-\d\d|beat|yantra-agent).{20}/)?.[0]).toBeUndefined()
  })
})

describe('the cards with nothing to say', () => {
  const none = (extra: Record<string, unknown>) => {
    const busy = scenario('busy')
    return { ...busy, ...extra } as unknown as typeof busy
  }
  const empty = (machine: string) => ({
    looked: 'ok',
    age_seconds: 0,
    data: [{ machine, reached: 'yes', sessions: [] }],
  })

  /** Y-580: no tmux listed and nothing failed, so no Sessions card. */
  it('leaves out Sessions when it is empty with no failure', async () => {
    mount('desktop', '/m/pi-5', none({ sessions: empty('pi-5') }))
    await screen.findByRole('heading', { level: 1, name: 'pi-5' })
    await screen.findByText(/^looked /)
    expect(screen.queryByRole('region', { name: 'Sessions' })).toBeNull()
    expect(screen.queryByText(/tmux lists nothing/)).toBeNull()
  })

  it('keeps Sessions when the machine did not answer', async () => {
    const error = 'ssh to pi-5 failed before the command reported a status: No route to host'
    mount('desktop', '/m/pi-5', none({ sessions: { looked: 'ok', age_seconds: 0, data: [{ machine: 'pi-5', reached: 'no', error }] } }))
    await screen.findByRole('region', { name: 'Sessions' })
    expect(await card('Sessions').findByText(/ssh to pi-5 fails/)).toBeTruthy()
  })

  it('keeps Sessions while it is pending', async () => {
    mount('desktop', '/m/cachyos-g14', none({ sessions: { looked: 'pending' } }))
    expect(await screen.findByRole('region', { name: 'Sessions' })).toBeTruthy()
  })

  /** Y-580: no workspace and no way to start one, so no Workspaces card. */
  it('leaves out Workspaces when it is empty and no session can start', async () => {
    mount('desktop', '/m/nas')
    const ready = within(await screen.findByRole('region', { name: 'Readiness' }))
    expect(await ready.findByRole('heading', { name: /tmux.* missing/ })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Workspaces on this machine' })).toBeNull()
  })

  it('keeps Workspaces, with New session, when it is empty and a session can start', async () => {
    const state = scenario('busy')
    state.workspaces!.data = []
    mount('desktop', '/m/cachyos-g14', state)
    await screen.findByRole('region', { name: 'Workspaces on this machine' })
    const here = card('Workspaces on this machine')
    expect(await here.findByRole('link', { name: 'New session' })).toBeTruthy()
    expect(here.getByText('No workspace lives here')).toBeTruthy()
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
    expect(await sessions.findByText('thinkpad is asleep')).toBeTruthy()
    expect(sessions.queryByText(/No route to host/)).toBeNull()
    fireEvent.click(sessions.getByRole('button', { name: /What ssh said/ }))
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
    expect(alert.textContent).toContain('The daemon could not read the fleet')
    expect(alert.textContent).toContain('The daemon answered, but every read of the fleet failed the same way.')
    expect(alert.textContent).not.toContain('Nothing here can be reached')
    expect(alert.textContent).not.toContain('off the tailnet')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})
