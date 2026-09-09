import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import { mount, scenario, unmount } from '@/screens/fleet/harness'

/* Ledger row 142 on `/m/:machine/s/:session`: the line wrote `ago` behind a
   helper that names the day past 24 h, so an old session read
   `started 4 Sep ago`. The terminal itself is Y-346's; this asks only for the
   sentence above it. */

// The e2e fixture's own instant, so an age here reads as it does in a shot.
const NOW = Date.parse('2026-09-06T12:00:00Z')

beforeAll(async () => {
  await import('./SessionTerminal')
}, 60_000)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  unmount()
})

const age = () => document.querySelector('.session-terminal__age')?.textContent ?? ''

const state = (created: number) => {
  const one = scenario('busy')
  const hosts = one.sessions!.data as { machine: string; sessions: { name: string; created_at: number }[] }[]
  const host = hosts.find((each) => each.machine === 'cachyos-g14')!
  host.sessions.find((each) => each.name === 'scratch')!.created_at = created
  return one
}

describe('an unclaimed session', () => {
  it('counts with an `ago` behind it', async () => {
    mount('desktop', '/m/cachyos-g14/s/scratch', state(NOW / 1000 - 3 * 3600))
    await screen.findByText(/^started /)
    expect(age()).toBe('started 3h ago · 3 windows')
  })

  it('names the day with nothing behind it', async () => {
    mount('desktop', '/m/cachyos-g14/s/scratch', state(NOW / 1000 - 7 * 86_400))
    await screen.findByText(/^started /)
    expect(age()).toMatch(/^started \d{1,2} \w{3} · 3 windows$/)
  })
})
