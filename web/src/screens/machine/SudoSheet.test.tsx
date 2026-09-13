import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import type { Check, Event, Looked, Machine, Readiness } from '@/api'
import type { Target } from '@/api/socket'
import { useMachineReadiness } from '@/api/hooks'
import { keys } from '@/api/keys'
import { answer } from '@/test/daemon'
import { renderInApp } from '@/test/inApp'
import { ReadinessCard } from './Readiness'
import { useVerdict } from './useVerdict'

/* Y-394. The sheet around the one-off terminal, through the card that opens
   it. The terminal itself is `Terminal.test.tsx`'s, against a real socket;
   here it is a stand-in that says which target it was handed and ends when
   told to, so the sheet's own behaviour is what is under test. */

const opened: Target[] = []

vi.mock('@/screens/session/Terminal', () => ({
  Terminal: (props: { target: Target; onExit?: (exit: number | null) => void }) => {
    opened.push(props.target)
    return (
      <div>
        <textarea aria-label="the pane" />
        <button onClick={() => props.onExit?.(0)} type="button">
          the command ends
        </button>
        <button onClick={() => props.onExit?.(1)} type="button">
          the command fails
        </button>
      </div>
    )
  },
}))

const IDS = ['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo', 'provider-cli', 'provider-auth', 'login-session', 'heartbeat']
const checks = (absent: string[]): Check[] =>
  IDS.map((id) => ({ check: id, state: absent.includes(id) ? 'absent' : 'present', detail: 'x' }))
const report = (list: Check[]): Looked<Readiness> => ({ looked: 'ok', age_seconds: 0, data: { machine: 'pi', checks: list } })
const ring = (events: Event[]): Looked<Event[]> => ({ looked: 'ok', age_seconds: 0, data: events })
const machine = { name: 'pi', dns_name: 'pi.ts.net.', os: 'linux', online: true, expired: false, last_seen: null, heartbeat: null } as unknown as Machine

const stopped = (commands: string[]): Event => ({
  at: 200,
  kind: 'install_stopped',
  workspace: null,
  machine: 'pi',
  said: 'pi: tmux left for you',
  commands,
})

let width = 1440

beforeEach(() => {
  opened.length = 0
  width = 1440
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function daemon() {
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? 'GET'} ${path}`)
      if (path.endsWith('/install')) return Promise.resolve(answer(202))
      if (path.endsWith('/readiness')) return Promise.resolve(answer(200, report(checks(['agent-cli']))))
      return Promise.resolve(answer(200, ring([])))
    }),
  )
  return asked
}

function Page() {
  const readiness = useMachineReadiness('pi')
  const state = useVerdict('pi', machine, readiness)
  return <ReadinessCard lastSeen={null} name="pi" readiness={readiness} state={state} />
}

/** The card on a result this page did not press for: the missing verdict,
 *  whose command still opens in a terminal. */
async function draw(events: Event[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(keys.notifications(), ring(events))
  client.setQueryData(keys.readiness('pi'), report(checks(['tmux', 'agent-cli'])))
  await renderInApp(<Page />, client)
}

const sheet = () => within(screen.getByRole('complementary', { name: 'Run it on pi' }))

describe('the one-off terminal for a sudo step', () => {
  it('sits beside a sudo command only, and opens that step by its place', async () => {
    daemon()
    await draw([stopped(['xcode-select --install', 'sudo apk add tmux'])])
    const open = screen.getAllByRole('button', { name: 'Open a terminal' })
    expect(open).toHaveLength(1)
    fireEvent.click(open[0]!)
    expect(sheet().getByText('sudo apk add tmux')).toBeTruthy()
    expect(sheet().getByText(/Your password goes to pi as keystrokes; Yantra does not keep it./)).toBeTruthy()
    await sheet().findByText('the command ends')
    expect(opened.at(-1)).toEqual({ machine: 'pi', step: 1 })
  })

  it('asks readiness again when the command ends, and says it finished', async () => {
    const asked = daemon()
    await draw([stopped(['sudo apk add tmux'])])
    fireEvent.click(screen.getByRole('button', { name: 'Open a terminal' }))
    fireEvent.click(await sheet().findByText('the command ends'))
    expect(sheet().getByText('It finished on pi. Readiness asks pi again now.')).toBeTruthy()
    await waitFor(() => expect(asked).toContain('POST /api/machines/pi/readiness'))
  })

  it('says a command that failed failed, and points at its output', async () => {
    daemon()
    await draw([stopped(['sudo apk add tmux'])])
    fireEvent.click(screen.getByRole('button', { name: 'Open a terminal' }))
    fireEvent.click(await sheet().findByText('the command fails'))
    expect(sheet().getByText(/It exited 1\. The output above says why/)).toBeTruthy()
  })

  it('keeps Escape for the terminal, and closes on its own button', async () => {
    daemon()
    await draw([stopped(['sudo apk add tmux'])])
    fireEvent.click(screen.getByRole('button', { name: 'Open a terminal' }))
    const pane = await sheet().findByLabelText('the pane')
    fireEvent.keyDown(pane, { key: 'Escape' })
    expect(screen.getByRole('complementary', { name: 'Run it on pi' }).hidden).toBe(false)
    fireEvent.click(sheet().getByRole('button', { name: 'Close Run it on pi' }))
    // Closed is hidden, so the sheet is no longer in the accessibility tree.
    expect(screen.queryByRole('complementary', { name: 'Run it on pi' })).toBeNull()
  })

  it('offers no terminal for a command meant for root', async () => {
    daemon()
    await draw([stopped(['apk add tmux'])])
    expect(screen.queryByRole('button', { name: 'Open a terminal' })).toBeNull()
  })
})
