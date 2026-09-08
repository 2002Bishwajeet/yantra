/**
 * `/w/{name}` before any socket is opened: which of the four views the URL
 * picks, and the three answers that are not a session at all — a name no
 * workspace carries, a file that will not load, and a list that could not be
 * read. Chat's own socket has its own suite (`Chat.test.tsx`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { cleanup, screen, waitFor } from '@testing-library/react'
import * as contract from '@/contract.gen'
import { renderInApp } from '@/test/inApp'
import { answer } from '@/test/daemon'
import type { View } from '@/views'
import { Workspace } from './Session'

const workspaces = [
  { loaded: 'yes', name: 'landing', machine: 'macbook', repo: '/Users/biswa/Github/yantra-landing', startup: null },
  {
    loaded: 'no',
    name: 'price-table',
    error: "workspace `price-table` will not load: missing field 'machine' at line 7",
  },
]

const looked = (data: unknown) => ({ looked: 'ok', age_seconds: 0, data })

const status = looked({
  workspace: 'landing',
  machine: 'macbook',
  reached: 'yes',
  status: { state: 'running' },
  session: { id: 'c3d4e5f6', pid: 9107 },
})

const sessions = looked([
  {
    machine: 'macbook',
    reached: 'yes',
    sessions: [
      { name: 'landing', windows: 1, attached: 0, created: 'Sun Sep  6 08:19:00 2026', created_at: 1_788_683_940 },
    ],
  },
])

/** Answers the reads this screen makes, and `tokens` — the one write the Spend
 *  view sends, since reading spend costs an ssh and only happens on request
 *  (ADR-0019). */
function daemon(list: unknown = looked(workspaces)) {
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? 'GET'} ${path.split('?')[0]}`)
      if (path.endsWith('/tokens')) return Promise.resolve(answer(200, contract.spend))
      if (path.includes('/status')) return Promise.resolve(answer(200, status))
      if (path.endsWith('/api/sessions')) return Promise.resolve(answer(200, sessions))
      if (path.endsWith('/api/workspaces')) return Promise.resolve(answer(200, list))
      return Promise.resolve(answer(404, 'no'))
    }),
  )
  return asked
}

const open = (name: string, view: View = 'spend') =>
  renderInApp(
    <Workspace name={name} view={view} />,
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  )

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: /min-width: (600|1240)px/.test(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    // xterm.js still asks for the legacy pair on the device-pixel-ratio query.
    addListener: () => {},
    removeListener: () => {},
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('one workspace, four views the URL carries', () => {
  it('names the session once, with where it lives and the verbs that are live', async () => {
    daemon()
    await open('landing')

    // The list is read before anything is drawn, so the header waits on a verb.
    await screen.findByRole('button', { name: 'Stop' })
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.textContent).toBe('landing')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    // `~` for the home directory, as a shell and the boards print a path.
    expect(heading.closest('.session__name')?.textContent).toContain(
      'macbook · ~/Github/yantra-landing',
    )
    // A running agent can be stopped and has nothing to resume (ADR-0015).
    expect(screen.getByRole('button', { name: 'Stop' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: 'Resume' }).hasAttribute('disabled')).toBe(true)
  })

  /** **Finding 120.** A verb that is off reads as broken unless it says why,
   *  and the boards draw no line for the reason, so it is the description. */
  it('gives the verb that is off a reason, and the live one none', async () => {
    daemon()
    await open('landing')

    const resume = await screen.findByRole('button', { name: 'Resume' })
    const said = document.getElementById(resume.getAttribute('aria-describedby') ?? '')
    expect(said?.textContent).toBe('Resume needs an agent that has ended, and landing is running.')
    expect(screen.getByRole('button', { name: 'Stop' }).getAttribute('aria-describedby')).toBeNull()
  })

  /** D5 §3.2: a view is navigation, so each pill is a link the browser can
   *  copy and open in a tab. Chat is first (M14 board 13). */
  it('draws the four views as links, chat first, with the open one marked', async () => {
    daemon()
    await open('landing')

    const views = await screen.findByRole('navigation', { name: 'Views' })
    const links = [...views.querySelectorAll('a')]
    expect(links.map((one) => one.textContent)).toEqual(['Chat', 'Terminal', 'Transcript', 'Spend'])
    expect(links[0]?.getAttribute('href')).toBe('/w/landing?view=chat')
    expect(links[3]?.getAttribute('aria-current')).toBe('page')
  })

  /** ADR-0019: spend is an ssh transcript read, so it is asked for once when
   *  the view is opened and never on a timer. */
  it('asks the daemon for spend when the view opens, and only then', async () => {
    const asked = daemon()
    await open('landing')

    // One model in the answer is unpriced, so the hero counts tokens and
    // gives no dollar figure (D5 §6.2).
    await waitFor(() => expect(screen.getByText('tokens, unpriced')).toBeTruthy())
    expect(asked.filter((one) => one.endsWith('/tokens'))).toEqual([
      'POST /api/workspaces/landing/tokens',
    ])
  })
})

describe('what `/w/{name}` draws when there is no session behind it', () => {
  it('says no workspace carries the name, and points at the fleet', async () => {
    daemon()
    await open('nowhere')

    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe(
      'No workspace is called nowhere.',
    )
    expect(screen.getByRole('link', { name: 'Fleet' }).getAttribute('href')).toBe('/fleet')
  })

  /** ADR-0020: only the bytes fix a file that will not load, so the one way
   *  out is the editor rather than a form over fields that were not read. */
  it('draws a file that will not load with the daemon words and a way to repair it', async () => {
    daemon()
    await open('price-table')

    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe(
      'price-table is not usable.',
    )
    expect(screen.getByText(/missing field 'machine' at line 7/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Repair the file' }).getAttribute('href')).toBe(
      '/w/price-table/repair',
    )
  })

  it('draws a workspace list that could not be read as its own failure', async () => {
    daemon({ looked: 'failed', age_seconds: 0, error: 'connection refused' })
    await open('landing')

    const said = await screen.findByRole('alert')
    expect(said.textContent).toContain('The workspaces could not be read')
    expect(said.textContent).toContain('connection refused')
  })
})
