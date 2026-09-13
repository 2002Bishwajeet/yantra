import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import type { Event, Readiness } from '@/api'
import { aMachine, looked } from '@/api/fixtures'
import { mountSettings, unmountSettings } from '@/screens/settings/harness'

/* What the flow sees arrive: the poll is the only thing that moves it, so it
   runs fast here rather than every 5 s. */
vi.mock('@/api/client', async (actual) => ({ ...(await actual<typeof import('@/api/client')>()), POLL_MS: 100 }))

const laptop = aMachine({ name: 'laptop', os: 'linux', online: true })
const whole: Readiness = {
  machine: 'laptop',
  checks: ['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo', 'login-session'].map((check) => ({
    check,
    state: 'present',
    detail: '',
  })),
}
const joined: Event = {
  at: 5,
  kind: 'joined',
  workspace: null,
  machine: 'laptop',
  said: 'laptop joined, and Yantra logs in there as biswa',
  commands: [],
  user: 'biswa',
  kept: false,
  logs_in_as: 'biswa',
}

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  unmountSettings()
})

describe('what the flow sees arrive', () => {
  it('follows the first new node of the platform, and keeps it in the address', async () => {
    let looks = 0
    mountSettings('desktop', '/machines/add?platform=linux', {
      'GET /api/machines': () => [200, looked.ok(++looks > 2 ? [laptop] : [])],
      'GET /api/notifications': [200, looked.ok([])],
      'GET /api/readiness': [200, looked.ok([])],
    })
    expect(await screen.findByText(/watching the tailnet for a new Linux machine/)).toBeTruthy()
    expect(await screen.findByText(/done · laptop is on the tailnet/)).toBeTruthy()
    await waitFor(() => expect(location.search).toBe('?platform=linux&machine=laptop'))
  })

  /** D7 §4.2: each beat's three minutes start when it becomes current. Beat 1
   *  waited four, so a flow timer would have beat 2 stuck at birth. */
  it("starts beat 2's three minutes when beat 1 is done, not when the flow opened", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.parse('2026-09-13T12:00:00Z')
    vi.setSystemTime(start)
    let arrived = false
    mountSettings('desktop', '/machines/add?platform=linux', {
      'GET /api/machines': () => [200, looked.ok(arrived ? [laptop] : [])],
      'GET /api/notifications': [200, looked.ok([])],
      'GET /api/readiness': [200, looked.ok([])],
    })
    expect(await screen.findByText(/watching the tailnet for a new Linux machine/)).toBeTruthy()
    vi.setSystemTime(start + 4 * 60_000)
    expect(await screen.findByText(/stuck · Not seen yet/)).toBeTruthy()
    arrived = true
    expect(await screen.findByText(/done · laptop is on the tailnet/)).toBeTruthy()
    expect(await screen.findByText(/waiting · run this in a terminal on laptop/)).toBeTruthy()
    expect(screen.queryByText(/No join yet/)).toBeNull()
    vi.setSystemTime(start + 8 * 60_000)
    expect(await screen.findByText(/stuck · No join yet/)).toBeTruthy()
  })

  /** ADR-0019: one ask per join seen arriving, and none on a timer. */
  it('asks the machine once when its join arrives', async () => {
    let looks = 0
    const asked = mountSettings('desktop', '/machines/add?platform=linux&machine=laptop', {
      'GET /api/machines': [200, looked.ok([laptop])],
      'GET /api/notifications': () => [200, looked.ok(++looks > 2 ? [joined] : [])],
      'GET /api/readiness': [200, looked.ok([])],
      'POST /api/machines/laptop/readiness': [200, looked.ok(whole)],
    })
    expect(await screen.findByText(/done · ready · open a session on laptop/)).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(asked.filter((one) => one === 'POST /api/machines/laptop/readiness')).toHaveLength(1)
  })

  it('does not ask for a join that was there when the page opened', async () => {
    const asked = mountSettings('desktop', '/machines/add?platform=linux&machine=laptop', {
      'GET /api/machines': [200, looked.ok([laptop])],
      'GET /api/notifications': [200, looked.ok([joined])],
      'GET /api/readiness': [200, looked.ok([])],
    })
    expect(await screen.findByText(/Check asks now/)).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(asked).not.toContain('POST /api/machines/laptop/readiness')
  })
})
