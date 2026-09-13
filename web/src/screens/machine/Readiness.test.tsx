import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import type { Check, Event, Looked, Machine, Readiness } from '@/api'
import { useMachineReadiness } from '@/api/hooks'
import { keys } from '@/api/keys'
import { answer } from '@/test/daemon'
import { renderInApp } from '@/test/inApp'
import { ReadinessCard } from './Readiness'
import { useVerdict } from './useVerdict'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const IDS = ['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo', 'provider-cli', 'provider-auth', 'login-session', 'heartbeat']

const checks = (absent: string[] = [], detail: Record<string, string> = {}): Check[] =>
  IDS.map((id) => ({
    check: id,
    state: absent.includes(id) ? 'absent' : 'present',
    detail: detail[id] ?? (absent.includes(id) ? `no \`${id}\` there` : 'found'),
  }))

const report = (list: Check[]): Looked<Readiness> => ({ looked: 'ok', age_seconds: 0, data: { machine: 'pi', checks: list } })

const machine = (over: Partial<Machine> = {}) =>
  ({ name: 'pi', dns_name: 'pi.ts.net.', os: 'linux', online: true, expired: false, last_seen: null, heartbeat: null, ...over }) as Machine

const earlier: Event = { at: 100, kind: 'relay-test', workspace: null, machine: null, said: 'yantra can reach this topic', commands: [] }

const stopped: Event = {
  at: 200,
  kind: 'install_stopped',
  workspace: null,
  machine: 'pi',
  said: 'pi: claude installed; tmux left for you: sudo asks for a password — run `sudo apk add tmux` on pi',
  commands: ['sudo apk add tmux'],
}

const ring = (events: Event[]): Looked<Event[]> => ({ looked: 'ok', age_seconds: 0, data: events })

const ABOUT = {
  version: '0.2.0',
  target: 'x86_64-unknown-linux-gnu',
  built: '2026-09-13',
  uptime_seconds: 1,
  listening_on: ['100.64.0.1:7717'],
  tailnet: null,
  relay: false,
}

/** Every call answered by path, as `yantrad` would. `after` is what a
 *  re-check finds. */
function daemon(install: [number, string?] = [202], after: Check[] = checks()) {
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? 'GET'} ${path}`)
      if (path.endsWith('/install')) return Promise.resolve(answer(install[0], install[1]))
      if (path.endsWith('/readiness')) return Promise.resolve(answer(200, report(after)))
      if (path === '/api/about') return Promise.resolve(answer(200, ABOUT))
      return Promise.resolve(answer(200, ring([earlier])))
    }),
  )
  return asked
}

function Page(props: { machine: Machine; lastSeen?: string }) {
  const readiness = useMachineReadiness('pi')
  const state = useVerdict('pi', props.machine, readiness)
  return <ReadinessCard lastSeen={props.lastSeen ?? null} name="pi" readiness={readiness} state={state} />
}

async function draw(
  readiness: Looked<Readiness>,
  events: Event[] = [earlier],
  options: { machine?: Machine; lastSeen?: string } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(keys.notifications(), ring(events))
  client.setQueryData(keys.readiness('pi'), readiness)
  await renderInApp(<Page lastSeen={options.lastSeen} machine={options.machine ?? machine()} />, client)
  return client
}

const card = () => within(screen.getByRole('region', { name: 'Readiness' }))

describe('the Readiness card', () => {
  it('leads with Ready for sessions and New session when nothing is absent', async () => {
    daemon()
    await draw(report(checks()))
    expect(card().getByRole('heading', { name: 'Ready for sessions' })).toBeTruthy()
    expect(card().getByRole('link', { name: 'New session' })).toBeTruthy()
    expect(card().queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('names what is missing and offers Install, not a session', async () => {
    daemon()
    await draw(report(checks(['tmux', 'agent-cli'])))
    expect(card().getByRole('heading', { name: 'tmux and claude are missing' })).toBeTruthy()
    expect(card().getByRole('button', { name: 'Install' })).toBeTruthy()
    expect(card().queryByRole('link', { name: 'New session' })).toBeNull()
  })

  it('runs after the 202, then asks for the password step, with Copy, and asks readiness again', async () => {
    const asked = daemon([202], checks(['tmux']))
    const client = await draw(report(checks(['tmux'])))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))

    await card().findByRole('heading', { name: 'Installing tmux' })
    expect(asked).toContain('POST /api/machines/pi/install')
    expect(card().getByRole('progressbar', { name: 'Installing on pi' })).toBeTruthy()
    expect(card().getByRole('status').textContent).toContain('Running in the background')
    expect(card().queryByRole('button', { name: 'Install' })).toBeNull()

    act(() => client.setQueryData(keys.notifications(), ring([stopped, earlier])))

    await card().findByRole('heading', { name: 'tmux needs your password' })
    expect(card().getByText('sudo apk add tmux')).toBeTruthy()
    expect(card().getByRole('button', { name: 'Copy the command for pi' })).toBeTruthy()
    expect(card().getByRole('button', { name: 'Install again' })).toBeTruthy()
    await waitFor(() => expect(asked).toContain('POST /api/machines/pi/readiness'))
  })

  it('says the machine is ready once the install lands and the re-check agrees', async () => {
    daemon([202], checks())
    const client = await draw(report(checks(['git'])))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    await card().findByRole('heading', { name: 'Installing git' })
    const done: Event = { ...stopped, at: 300, kind: 'installed', said: 'pi: git installed', commands: [] }
    act(() => client.setQueryData(keys.notifications(), ring([done, earlier])))
    await card().findByRole('heading', { name: 'Ready for sessions' })
    expect(await screen.findByText('pi is ready for sessions')).toBeTruthy()
  })

  it('shows the last result, and its commands, before anything is pressed', async () => {
    daemon()
    await draw(report(checks(['tmux'])), [stopped, earlier])
    expect(card().getByRole('heading', { name: 'tmux is missing' })).toBeTruthy()
    expect(card().getByText(/The install stopped · the last install/)).toBeTruthy()
    expect(card().getByText('sudo apk add tmux')).toBeTruthy()
    expect(card().getByRole('button', { name: 'Install again' })).toBeTruthy()
  })

  it('reads a 409 as an install already running, and waits for it', async () => {
    daemon([409, 'an install is already running on pi'])
    await draw(report(checks(['tmux'])))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    await card().findByRole('heading', { name: 'Installing tmux' })
    expect(card().getByRole('status').textContent).toContain('An install was already running on pi.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    [403, 'node biswas-iphone is on this tailnet but is not yours', 'not on a node'],
    [400, '`pi x` is not a machine name Yantra passes to ssh', 'would not take'],
    [503, 'tailscale whois failed: no tailscaled', 'Nothing could be asked'],
  ])('draws a %i as a refusal with the daemon’s words', async (status, said, sentence) => {
    daemon([status, said])
    await draw(report(checks(['tmux'])))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Install did not start')
    expect(alert.textContent).toContain(sentence)
    expect(alert.textContent).toContain(said)
    expect(card().getByRole('button', { name: 'Install' })).toBeTruthy()
  })

  it('draws a daemon that did not answer, with Try again', async () => {
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) => {
        asked.push(`${init?.method ?? 'GET'} ${path}`)
        return Promise.reject(new TypeError('Failed to fetch'))
      }),
    )
    await draw(report(checks(['tmux'])))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The daemon did not answer.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(asked.filter((one) => one.endsWith('/install'))).toHaveLength(2))
  })

  it('says so when the result cannot be read while it waits', async () => {
    daemon()
    const client = await draw(report(checks(['tmux'])))
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    await card().findByRole('heading', { name: 'Installing tmux' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(answer(403, 'not yours'))))
    await act(() => client.refetchQueries({ queryKey: keys.notifications() }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The result could not be read')
  })

  it('says when no result arrives and lets the person stop waiting', async () => {
    daemon()
    await draw(report(checks(['tmux'])))
    const start = Date.now()
    fireEvent.click(card().getByRole('button', { name: 'Install' }))
    await card().findByRole('heading', { name: 'Installing tmux' })
    // The card's one-second clock is already running, so the next real tick
    // reads the moved instant.
    const later = vi.spyOn(Date, 'now').mockReturnValue(start + 17 * 60_000)
    try {
      await waitFor(() => expect(card().getByRole('status').textContent).toContain('No result arrived'), {
        timeout: 2_500,
      })
      fireEvent.click(card().getByRole('button', { name: 'Stop waiting' }))
      // Nothing answered, so there is no last result to install again after.
      expect(card().getByRole('button', { name: 'Install' })).toBeTruthy()
    } finally {
      later.mockRestore()
    }
  })

  it('is asleep for a machine the tailnet says is off, and offers nothing to press', async () => {
    daemon()
    await draw(report(checks(['tmux'])), [earlier], { machine: machine({ online: false }), lastSeen: '3h' })
    expect(card().getByRole('heading', { name: 'pi is asleep' })).toBeTruthy()
    expect(card().getByText('Last seen 3h ago · Yantra asks again when it comes back.')).toBeTruthy()
    expect(card().queryByRole('button')).toBeNull()
  })

  it('reads a machine nobody asked as Not checked yet, with Check again', async () => {
    const asked = daemon()
    await draw({ looked: 'never' })
    expect(card().getByRole('heading', { name: 'Not checked yet' })).toBeTruthy()
    fireEvent.click(card().getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(asked).toContain('POST /api/machines/pi/readiness'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('hands a refused key the join command', async () => {
    daemon()
    await draw(report(checks(['reachable'], { reachable: 'yantra@pi: Permission denied (publickey).' })))
    expect(card().getByRole('heading', { name: 'The key was refused' })).toBeTruthy()
    expect(await card().findByText('curl -fsSL http://100.64.0.1:7717/join | sh')).toBeTruthy()
  })

  it('puts a manual fix beside its check, and still offers a session', async () => {
    daemon()
    await draw(report(checks(['provider-auth'])))
    expect(card().getByRole('heading', { name: 'gh is not signed in' })).toBeTruthy()
    expect(card().getByText('gh auth login')).toBeTruthy()
    expect(card().getByRole('link', { name: 'New session' })).toBeTruthy()
  })
})
