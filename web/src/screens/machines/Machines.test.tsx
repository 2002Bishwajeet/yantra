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
  /** A changed host key reads as `unreachable`, never `refused` — the join
   *  command places a key and cannot fix that (`reachableFailure`, Y-402
   *  review). Only a refused key offers Copy join command. */
  it('reads ssh failing on a neutral-tone chip, and offers nothing to press', async () => {
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
    expect(failing.queryAllByRole('button')).toHaveLength(0)
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
    expect(screen.getByText('No machine can run a session yet.')).toBeTruthy()
    // The title row keeps its own Add a device too, so there are two.
    expect(screen.getAllByRole('link', { name: 'Add a device' }).length).toBeGreaterThan(0)
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
