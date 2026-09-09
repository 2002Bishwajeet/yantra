import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { mount, scenario, unmount } from '@/screens/fleet/harness'

// The route is lazy, so the first mount pays for its chunk; warming it here
// keeps that cost out of the first test's own timeout.
beforeAll(async () => {
  await import('./Machines')
}, 60_000)

afterEach(() => {
  cleanup()
  unmount()
})

const card = (name: string) => within(screen.getByRole('region', { name }))

describe('/machines on the busy fleet', () => {
  it('draws one card a machine, with the four checks as a mark and a word', async () => {
    mount('desktop', '/machines')
    await screen.findByRole('heading', { level: 1, name: 'Machines' }, { timeout: 2000 })
    await screen.findByText(/^looked /)

    expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(6)

    const good = card('cachyos-g14')
    expect(good.getByText('online')).toBeTruthy()
    for (const check of ['reachable', 'tmux', 'agent-cli', 'terminfo']) {
      expect(good.getByText(check)).toBeTruthy()
    }
    expect(good.getAllByText('ok')).toHaveLength(4)
    expect(good.getByText('4 of 4 checks')).toBeTruthy()
    // Everything passes, so nothing asks the machine again.
    expect(good.queryByRole('button', { name: 'Doctor' })).toBeNull()

    const short = card('pi-5')
    expect(short.getByText('missing')).toBeTruthy()
    expect(short.getByText('no `claude` on PATH there')).toBeTruthy()
    expect(short.getByText('1 failing')).toBeTruthy()
    expect(short.getByRole('button', { name: 'Doctor' })).toBeTruthy()

    const gone = card('thinkpad')
    expect(gone.getByText('unreachable')).toBeTruthy()
    expect(gone.getAllByText('unknown').length).toBeGreaterThan(0)
    expect(gone.getByText('1 failing · 3 unknown')).toBeTruthy()
  })

  it('asks the machine again when Doctor is pressed', async () => {
    const asked = mount('desktop', '/machines')
    await screen.findByText(/^looked /)
    fireEvent.click(card('pi-5').getByRole('button', { name: 'Doctor' }))
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
    expect(card('pi-5').getByText('agent-cli')).toBeTruthy()
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

describe('/machines when nothing can be reached', () => {
  it('is one page-sized error rather than one per card', async () => {
    mount('desktop', '/machines', scenario('unreachable'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Nothing here can be reached')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})
