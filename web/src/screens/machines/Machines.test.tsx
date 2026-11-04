import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { mount, scenario, unmount } from '@/screens/fleet/harness'

// The route is lazy, so the first mount pays for its chunk; warming it here
// keeps that cost out of the first test's own timeout.
beforeAll(async () => {
  await import('./Machines')
}, 60_000)

const clipboard = (writeText: ((text: string) => Promise<void>) | undefined) =>
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  })

afterEach(() => {
  cleanup()
  unmount()
  clipboard(undefined)
})

const card = (name: string) => within(screen.getByRole('region', { name }))

describe('/machines on the busy fleet', () => {
  it('draws one card a machine, with the four checks as a mark and a word', async () => {
    mount('desktop', '/machines')
    await screen.findByRole('heading', { level: 1, name: 'Machines' }, { timeout: 2000 })
    await screen.findByText(/^looked /)

    expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(6)

    const good = card('cachyos-g14')
    // Every basic is present, so the chip reads the verdict, not `online` (D7 §3.3).
    expect(good.getByText('ready')).toBeTruthy()
    // The check name table (`lib/checks.ts`), never a raw id (D7 §3.5).
    for (const check of ['ssh', 'tmux', 'claude', 'terminfo']) {
      expect(good.getByText(check)).toBeTruthy()
    }
    expect(good.getAllByText('ok')).toHaveLength(4)
    expect(good.getByText('4 of 4 checks')).toBeTruthy()
    // Everything passes, so nothing asks the machine again.
    expect(good.queryByRole('button')).toBeNull()

    const short = card('pi-5')
    expect(short.getByText('missing')).toBeTruthy()
    expect(short.getByText('no `claude` on PATH there')).toBeTruthy()
    expect(short.getByText('1 failing')).toBeTruthy()
    // `git` is not in pi-5's report at all, so it counts as missing too (D7 §3.3).
    expect(short.getByText('2 missing')).toBeTruthy()
    expect(short.getByRole('button', { name: 'Install' })).toBeTruthy()

    const gone = card('thinkpad')
    // The tailnet says thinkpad is off: asleep, not failed (D7 §3.3).
    expect(gone.getByText('asleep · 7 Jul')).toBeTruthy()
    expect(gone.getAllByText('unknown').length).toBeGreaterThan(0)
    expect(gone.getByText('1 failing · 3 unknown')).toBeTruthy()
    // Asleep offers nothing to press: ssh cannot answer either way.
    expect(gone.queryAllByRole('button')).toHaveLength(0)
  })

  /** Y-404, owner 2026-09-13: listed with the reason, never a card or a count. */
  it('lists a node your account does not own apart, with the reason, and draws it no card', async () => {
    const state = scenario('busy')
    const first = (state.machines!.data as Record<string, unknown>[])[0]!
    ;(state.machines!.data as Record<string, unknown>[]).push(
      { ...first, name: 'friends-box', ownership: 'shared' },
      { ...first, name: 'ci-runner', ownership: 'tagged' },
    )
    mount('desktop', '/machines', state)
    await screen.findByText(/^looked /)

    expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(6)
    expect(screen.queryByRole('region', { name: 'friends-box' })).toBeNull()
    const foreign = within(screen.getByRole('region', { name: 'Devices your account does not own' }))
    expect(foreign.getByText('friends-box')).toBeTruthy()
    expect(foreign.getByText('shared from another account · not supported yet')).toBeTruthy()
    expect(foreign.getByText('shared')).toBeTruthy()
    expect(foreign.getByText('ci-runner')).toBeTruthy()
    expect(foreign.getByText(/tagged, so the tailnet owns it/)).toBeTruthy()
  })

  it('starts an install when Install is pressed', async () => {
    const asked = mount('desktop', '/machines')
    await screen.findByText(/^looked /)
    fireEvent.click(card('pi-5').getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(asked).toContain('POST /api/machines/pi-5/install'))
  })

  it('shows the daemon’s words when Install is refused', async () => {
    mount('desktop', '/machines', scenario('refused'))
    await screen.findByText(/^looked /)
    fireEvent.click(card('pi-5').getByRole('button', { name: 'Install' }))
    const alert = await card('pi-5').findByRole('alert')
    expect(alert.textContent).toContain('Install did not start')
    expect(alert.textContent).toContain('node biswas-iphone is on this tailnet but is not yours')
  })

  it('asks the machine again when Check again is pressed, for a machine never checked', async () => {
    const state = scenario('busy')
    state.readiness!.data = (state.readiness!.data as { machine: string }[]).filter(
      (one) => one.machine !== 'pi-5',
    )
    const asked = mount('desktop', '/machines', state)
    await screen.findByText(/^looked /)
    expect(card('pi-5').getByText('not checked')).toBeTruthy()
    fireEvent.click(card('pi-5').getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(asked).toContain('POST /api/machines/pi-5/readiness'))
  })

  /** Y-579: no workspace names the machine, and the daemon now keeps the
   *  check. The card moves at once and a later list poll holds it there. */
  it('moves the card off not checked, and a poll does not move it back', async () => {
    const state = scenario('busy')
    state.workspaces!.data = []
    const list = state.readiness!.data as { machine: string; checks: unknown[]; age_seconds: number }[]
    const [held] = list.filter((one) => one.machine === 'cachyos-g14')
    state.readiness!.data = list.filter((one) => one.machine !== 'pi-5')
    const report = { ...held!, machine: 'pi-5', age_seconds: 0 }
    state.asked = { 'pi-5': report }
    const asked = mount('desktop', '/machines', state)
    await screen.findByText(/^looked /)
    expect(card('pi-5').getByText('not checked')).toBeTruthy()

    fireEvent.click(card('pi-5').getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(card('pi-5').queryByText('not checked')).toBeNull())

    const polls = () => asked.filter((one) => one === 'GET /api/readiness').length
    const before = polls()
    await waitFor(() => expect(polls()).toBeGreaterThan(before), { timeout: 7_000 })
    expect(card('pi-5').queryByText('not checked')).toBeNull()
  }, 15_000)

  it('offers an unclaimed session Attach and Kill, and never Adopt', async () => {
    mount('desktop', '/machines')
    await screen.findByText('scratch')
    const worth = within(screen.getByRole('region', { name: 'Worth a look' }))
    expect(worth.getByText('mux')).toBeTruthy()
    expect(worth.queryByRole('button', { name: 'Adopt' })).toBeNull()
    expect(
      worth.getAllByRole('link', { name: 'Attach' })[0]!.getAttribute('href'),
    ).toBe('/m/cachyos-g14/s/scratch')
    // A workspace's own session is not in here.
    expect(worth.queryByText('yantra-web')).toBeNull()
  })

  /** Ledger row 142: a machine dark for a week read `beat 4 Sep ago`, because
   *  the card wrote the word behind a helper that names the day past 24 h. */
  it('drops `ago` from a beat that has become a date', async () => {
    const state = scenario('busy')
    const machines = state.machines!.data as { name: string; heartbeat: { age_seconds: number } }[]
    machines.find((one) => one.name === 'thinkpad')!.heartbeat = { age_seconds: 7 * 86_400 }
    mount('desktop', '/machines', state)
    await screen.findByText(/^looked /)

    const about = (name: string) =>
      screen.getByRole('region', { name }).querySelector('.machines__about')?.textContent ?? ''
    expect(about('thinkpad')).toMatch(/· beat \d{1,2} \w{3}$/)
    // The band under a day is unchanged, and it keeps the word.
    expect(about('cachyos-g14')).toMatch(/· beat 4s ago$/)
  })

  it('Kill asks first, and the daemon is only told after the answer', async () => {
    const asked = mount('desktop', '/machines')
    await screen.findByText('scratch')
    const worth = within(screen.getByRole('region', { name: 'Worth a look' }))
    fireEvent.click(worth.getAllByRole('button', { name: 'Kill' })[0]!)
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('Kill scratch?')).toBeTruthy()
    expect(asked.some((one) => one.startsWith('DELETE'))).toBe(false)
    fireEvent.click(dialog.getByRole('button', { name: 'Kill' }))
    await waitFor(() =>
      expect(asked).toContain('DELETE /api/machines/cachyos-g14/sessions/scratch'),
    )
  })
})

describe('/machines on the phone', () => {
  it('condenses a card that passes and still names what fails', async () => {
    mount('phone', '/machines')
    await screen.findByText(/^looked /)
    const good = card('cachyos-g14')
    expect(good.getByText('4 of 4 checks')).toBeTruthy()
    expect(good.queryByText('tmux')).toBeNull()
    expect(card('pi-5').getByText('claude')).toBeTruthy()
  })
})

describe('/machines on an empty fleet', () => {
  it("says every session belongs to a workspace", async () => {
    mount('desktop', '/machines', scenario('empty'))
    expect(
      await screen.findByText(
        'every tmux session on the machines that answered belongs to a workspace',
      ),
    ).toBeTruthy()
  })
})

describe('/machines with devices that open the dashboard', () => {
  it('keeps a phone, a tablet and Windows apart, uncounted and without a Fix', async () => {
    mount('desktop', '/machines', scenario('setup'))
    await screen.findByText(/^looked /)

    // Four machines run sessions; the phone and the Windows PC do not (D7 §3.4).
    expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(4)
    expect(screen.queryByRole('region', { name: 'iphone' })).toBeNull()

    const devices = within(
      screen.getByRole('region', { name: 'Devices that open the dashboard' }),
    )
    expect(devices.getByText('iphone')).toBeTruthy()
    expect(devices.getByText('gaming-pc')).toBeTruthy()
    expect(devices.getByText('coming soon')).toBeTruthy()
  })

  it('reads a missing basic as Install, and a refused key as Copy join command', async () => {
    mount('desktop', '/machines', scenario('setup'))
    await screen.findByText(/^looked /)

    const missing = card('missing-mac')
    expect(missing.getByText('2 missing')).toBeTruthy()
    expect(missing.getByRole('button', { name: 'Install' })).toBeTruthy()

    const refused = card('refused-box')
    expect(refused.getByText('key refused')).toBeTruthy()
    expect(refused.getByRole('button', { name: 'Copy join command' })).toBeTruthy()
    expect(refused.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('is asleep, not failed, for a machine the tailnet says is off — and offers nothing to press', async () => {
    mount('desktop', '/machines', scenario('setup'))
    await screen.findByText(/^looked /)

    const asleep = card('asleep-laptop')
    expect(asleep.getByText(/^asleep · /)).toBeTruthy()
    expect(asleep.queryAllByRole('button')).toHaveLength(0)
  })

  it('copies the join command where a clipboard exists', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    clipboard(writeText)
    mount('desktop', '/machines', scenario('setup'))
    await screen.findByText(/^looked /)
    // The join URL comes from `GET /api/about`, a second read the button
    // waits on before it can be pressed.
    const button = await card('refused-box').findByRole('button', { name: 'Copy join command' })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
    expect(await card('refused-box').findByRole('button', { name: 'Copied' })).toBeTruthy()
    expect(writeText).toHaveBeenCalled()
  })

  it('says the page has no clipboard, rather than silently doing nothing', async () => {
    clipboard(undefined)
    mount('desktop', '/machines', scenario('setup'))
    await screen.findByText(/^looked /)
    const button = await card('refused-box').findByRole('button', { name: 'Copy join command' })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
    expect(await card('refused-box').findByText(/This page has no clipboard/)).toBeTruthy()
    expect(card('refused-box').getByRole('button', { name: 'Copy join command' })).toBeTruthy()
  })
})

describe('/machines when ssh fails for a reason the join command cannot fix', () => {
  /** Y-585: the card says why in plain words, offers the join command, and
   *  keeps ssh's own words behind a press. */
  it('reads a browser check as Copy join command, with the raw text closed', async () => {
    const state = scenario('busy')
    const said = 'Tailscale SSH requires an additional check, which needs a browser sign-in'
    const data = state.readiness!.data as { machine: string; checks: { check: string; state: string; detail: string }[] }[]
    const one = data.find((report) => report.machine === 'cachyos-g14')!
    one.checks = one.checks.map((check) => (check.check === 'reachable' ? { ...check, state: 'absent', detail: said } : check))
    mount('desktop', '/machines', state)
    const box = within(await screen.findByRole('region', { name: 'cachyos-g14' }))
    expect(await box.findByText('browser sign-in')).toBeTruthy()
    expect(box.getByRole('button', { name: 'Copy join command' })).toBeTruthy()
    expect(box.getByText(/Tailscale asks for a browser sign-in on each connection/)).toBeTruthy()
    expect(box.queryByText(said)).toBeNull()
    fireEvent.click(box.getByRole('button', { name: /What ssh said/ }))
    expect(box.getByText(said)).toBeTruthy()
  })

  /** A changed host key reads as `unreachable`, never `refused` — the join
   *  command places a key and cannot fix that (`reachableFailure`, Y-402
   *  review). Only a refused key offers Copy join command. */
  it('reads ssh failing on a neutral-tone chip, and offers only the raw text', async () => {
    const state = scenario('busy')
    const data = state.readiness!.data as { machine: string; checks: { check: string; state: string; detail: string }[] }[]
    const cachy = data.find((one) => one.machine === 'cachyos-g14')!
    cachy.checks = cachy.checks.map((one) =>
      one.check === 'reachable' ? { ...one, state: 'absent', detail: 'No route to host' } : one,
    )
    mount('desktop', '/machines', state)
    await screen.findByText(/^looked /)

    const failing = card('cachyos-g14')
    expect(failing.getByText('ssh failing')).toBeTruthy()
    expect(failing.queryByRole('button', { name: 'Copy join command' })).toBeNull()
    expect(failing.getAllByRole('button').map((one) => one.textContent)).toEqual(['Show'])
  })
})

describe('/machines when no machine can run a session', () => {
  it('offers Add a device instead of an empty grid', async () => {
    const state = scenario('busy')
    state.machines!.data = (state.machines!.data as { os: string }[]).filter(
      (one) => one.os !== 'linux' && one.os !== 'macOS',
    )
    mount('desktop', '/machines', state)
    await screen.findByText(/^looked /)
    expect(screen.getByText('No machine can run a session yet')).toBeTruthy()
    // The title row keeps its own Add a device too, so there are two.
    expect(screen.getAllByRole('link', { name: 'Add a device' }).length).toBeGreaterThan(0)
  })
})

/** Y-582: the hub is the node yantrad runs on. It is drawn first, in its own
 *  section, and never in the grid. The busy fleet's hub is cachyos-g14. */
describe('/machines with a hub', () => {
  type Row = Record<string, unknown>
  it('draws the hub first and apart, with the note that its agents share it', async () => {
    mount('desktop', '/machines')
    await screen.findByText(/^looked /)
    const hub = screen.getByRole('region', { name: 'Hub' })
    expect(within(hub).getByRole('region', { name: 'cachyos-g14' })).toBeTruthy()
    expect(within(hub).getByText('Agents on the hub share its CPU and memory with yantrad.')).toBeTruthy()
    const grid = document.querySelector('.machines__grid')!
    expect(within(grid as HTMLElement).queryByRole('region', { name: 'cachyos-g14' })).toBeNull()
    expect(within(grid as HTMLElement).getByRole('region', { name: 'pi-5' })).toBeTruthy()
    expect(hub.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(6)
  })

  it('draws the page as before when no node is the hub', async () => {
    const state = scenario('busy')
    state.machines!.data = (state.machines!.data as Row[]).map((one) => ({ ...one, hub: false }))
    mount('desktop', '/machines', state)
    await screen.findByText(/^looked /)
    expect(screen.queryByRole('region', { name: 'Hub' })).toBeNull()
    const grid = document.querySelector('.machines__grid') as HTMLElement
    expect(within(grid).getByRole('region', { name: 'cachyos-g14' })).toBeTruthy()
  })

  it('offers Add a device under a hub that is the only machine', async () => {
    const state = scenario('busy')
    state.machines!.data = (state.machines!.data as Row[]).filter((one) => one.hub === true)
    mount('desktop', '/machines', state)
    await screen.findByText(/^looked /)
    expect(within(screen.getByRole('region', { name: 'Hub' })).getByRole('region', { name: 'cachyos-g14' })).toBeTruthy()
    expect(screen.getByText('No other machine yet')).toBeTruthy()
    expect(screen.queryByText('No machine can run a session yet')).toBeNull()
  })

  it('draws no hub and keeps the failure card when the machines could not be read', async () => {
    const state = scenario('busy')
    state.machines = { looked: 'failed', age_seconds: 0, error: 'tailscaled is down' } as typeof state.machines
    mount('desktop', '/machines', state)
    expect(await screen.findByText('The machines could not be read')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Hub' })).toBeNull()
  })
})

describe('/machines when nothing can be reached', () => {
  it('is one page-sized error rather than one per card', async () => {
    mount('desktop', '/machines', scenario('unreachable'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Nothing here can be reached')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})
