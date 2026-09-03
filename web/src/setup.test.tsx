/**
 * The first run: a fresh install has no workspace, so `/` is D2 §3.1's checks
 * rather than a form whose `up` would fail. The sweep cannot supply this page —
 * it asks only the machines a workspace names — so the list is the tailnet's and
 * every report comes from a POST somebody asked for. D3 §4.8. Y-197.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Check, Listed, Looked, Machine, Workspace } from './api'
import App from './App'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: 1280 < Number(/([\d.]+)rem/.exec(query)?.[1]) * 16,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
})

const laptop: Machine = {
  name: 'cachyos-g14',
  dns_name: 'cachyos-g14.<tailnet>.ts.net.',
  os: 'linux',
  online: true,
  expired: false,
  last_seen: null,
  heartbeat: null,
}

const on = (name: string): Workspace => ({
  name,
  machine: 'cachyos-g14',
  repo: `/home/<user>/${name}`,
  startup: null,
})

const RECHECK = '/api/machines/cachyos-g14/readiness'

const report = (checks: Check[]): Looked<unknown> => ({
  looked: 'ok',
  age_seconds: 0,
  data: { machine: 'cachyos-g14', checks },
})

/** The GET class, and the one POST beside it. `recheck` is a function so a test
 *  can hold the answer back and look at the page while it waits. */
function fleet(
  workspaces: Workspace[],
  recheck: () => Promise<Looked<unknown>> = () =>
    Promise.resolve(report([])),
) {
  const answers: Record<string, Looked<unknown>> = {
    '/api/machines': { looked: 'ok', age_seconds: 1, data: [laptop] },
    '/api/workspaces': {
      looked: 'ok',
      age_seconds: 1,
      data: workspaces.map((one) => ({ loaded: 'yes', ...one }) satisfies Listed),
    },
    '/api/sessions': { looked: 'never' },
    ...Object.fromEntries(
      workspaces.map((one) => [
        `/api/workspaces/${one.name}/status`,
        {
          looked: 'ok',
          age_seconds: 1,
          data: {
            workspace: one.name,
            machine: one.machine,
            reached: 'yes',
            status: { state: 'running' },
            session: null,
          },
        },
      ]),
    ),
  }

  const fetching = vi.fn((path: string, init?: { method?: string }) => {
    const answer =
      init?.method === 'POST' ? recheck() : Promise.resolve(answers[path])
    return answer.then((body) => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    }))
  })
  vi.stubGlobal('fetch', fetching)
  return fetching
}

const check = (one: Partial<Check>): Check => ({
  check: 'reachable',
  state: 'present',
  detail: 'a command ran there and reported its own status',
  ...one,
})

describe('the page a fresh install opens on', () => {
  it('draws the checks rather than the bands when no workspace exists', async () => {
    fleet([])
    render(<App />)

    expect(await screen.findByText('No workspace exists yet.')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'cachyos-g14' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy()
    for (const band of ['Needs you', 'Running', 'Idle', 'Not read yet']) {
      expect(screen.queryByRole('heading', { name: new RegExp(band) })).toBeNull()
    }
  })

  it('is the work page again the moment one workspace exists', async () => {
    fleet([on('api')])
    render(<App />)

    expect(await screen.findByRole('heading', { name: /Running/ })).toBeTruthy()
    expect(screen.queryByText('No workspace exists yet.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check' })).toBeNull()
  })
})

describe('the re-check', () => {
  it('asks the machine over a POST, and draws what it answered', async () => {
    const fetching = fleet([], () =>
      Promise.resolve(
        report([check({ check: 'tmux', detail: 'tmux 3.5a at /usr/bin/tmux' })]),
      ),
    )
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Check' }))

    expect(await screen.findByText('tmux 3.5a at /usr/bin/tmux')).toBeTruthy()
    expect(fetching).toHaveBeenCalledWith(RECHECK, { method: 'POST' })
  })

  /** R-23, and the reason this route answers 200 with unknowns rather than an
   *  error: painting a question that could not be asked as a thing that is
   *  missing sends someone to install what is already there. */
  it('never draws a check it could not ask as a check that failed', async () => {
    fleet([], () =>
      Promise.resolve(
        report([
          check({ check: 'tmux', state: 'absent', detail: 'no tmux there' }),
          check({
            check: 'provider-auth',
            state: 'unknown',
            detail: 'could not be asked: ssh said nothing',
          }),
        ]),
      ),
    )
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Check' }))

    const absent = (await screen.findByText('tmux')).closest(
      '[data-slot="badge"]',
    )
    const unknown = screen
      .getByText('provider-auth')
      .closest('[data-slot="badge"]')
    expect(absent?.className).not.toBe(unknown?.className)
    expect(screen.getByText(/could not be asked/)).toBeTruthy()
  })

  /** D3 §7: a round trip that takes ten seconds may not look like a page that
   *  has finished. */
  it('says it is waiting while the machine is being asked', async () => {
    let answer: (report: Looked<unknown>) => void = () => {}
    fleet([], () => new Promise((resolve) => (answer = resolve)))
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Check' }))

    expect(await screen.findByText(/ssh gives it ten seconds/)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'asking…' }).hasAttribute('disabled'),
    ).toBe(true)

    answer(report([check({ detail: 'ssh answered' })]))
    expect(await screen.findByText('ssh answered')).toBeTruthy()
  })
})
