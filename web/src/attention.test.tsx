/**
 * The attention band: a block inside `Needs you` whose verbs open GitHub, on a
 * clock ten times slower than the fleet's, and which says why it is empty when
 * `gh` could not answer. D6 §2, §3.1–§3.5. Y-314, Y-315, Y-316.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type {
  AgentState,
  Attention,
  Item,
  Listed,
  Looked,
  Machine,
  Workspace,
} from './api'
import App from './App'
import { AttentionBand } from './components/Attention'

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

const item = (overrides: Partial<Item> = {}): Item => ({
  repo: '2002Bishwajeet/yantra',
  number: 123,
  title: 'Y-314: draw the attention band',
  url: 'https://github.com/2002Bishwajeet/yantra/pull/123',
  updated_at: '2026-09-03T09:00:00Z',
  ...overrides,
})

const queue = (overrides: Partial<Attention> = {}): Attention => ({
  reviews: [],
  issues: [],
  notifications: 0,
  ...overrides,
})

const ok = <T,>(data: T, age_seconds = 1) =>
  ({ looked: 'ok', age_seconds, data }) as const

const crashed: AgentState = { state: 'crashed', exit_status: 1 }
const quiet: AgentState = { state: 'finished' }

/** One workspace — crashed by default, so `Needs you` has a row of its own —
 *  plus whatever `/api/attention` is made to answer. */
function fleet(attention: Looked<Attention>, state: AgentState = crashed) {
  const answers: Record<string, Looked<unknown>> = {
    '/api/machines': ok([laptop]),
    '/api/workspaces': ok([{ loaded: 'yes', ...on('api') } satisfies Listed]),
    '/api/sessions': { looked: 'never' },
    '/api/attention': attention,
    '/api/workspaces/api/status': ok({
      workspace: 'api',
      machine: 'cachyos-g14',
      reached: 'yes',
      status: state,
      session: null,
    }),
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(answers[path]),
      }),
    ),
  )
}

/** The `Needs you` section, which is the `h2`'s own element. */
async function needs() {
  const heading = await screen.findByRole('heading', { name: /Needs you/ })
  return heading.parentElement!
}

describe('the attention band', () => {
  it('sits under its own h3, below the workspace rows', async () => {
    fleet(ok(queue({ reviews: [item()] })))
    render(<App />)

    const band = within(await needs()).getByRole('heading', { level: 3 })
    expect(band.textContent).toBe('GitHub')
    const row = within(await needs()).getByRole('link', { name: 'api' })
    expect(
      row.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('keeps reviews and issues as two subheadings', async () => {
    fleet(ok(queue({ reviews: [item()], issues: [item({ number: 7 })] })))
    render(<App />)

    const band = await needs()
    expect(
      within(band)
        .getAllByRole('heading', { level: 4 })
        .map((one) => one.textContent),
    ).toEqual(['review requested', 'assigned to you'])
  })

  it('draws a row as owner/name#123, its title and its own age, linking out', async () => {
    fleet(ok(queue({ issues: [item()] })))
    render(<App />)

    const row = within(await needs()).getByRole('link', {
      name: /2002Bishwajeet\/yantra#123/,
    })
    expect(row.getAttribute('href')).toBe(
      'https://github.com/2002Bishwajeet/yantra/pull/123',
    )
    expect(row.textContent).toContain('Y-314: draw the attention band')
    // GitHub's own `updated_at`, which is the pull request's age and not the
    // answer's — the stamp beside the heading is the other one.
    expect(
      within(row).getByTitle('2026-09-03T09:00:00Z').textContent,
    ).toBeTruthy()
  })

  /** D6 §3.3: a count rather than a list, because the titles are the part that
   *  would land in a journal. */
  it('counts notifications on one line and lists none of them', async () => {
    fleet(ok(queue({ notifications: 27 })))
    render(<App />)

    const line = within(await needs()).getByRole('link', {
      name: '27 unread notifications',
    })
    expect(line.getAttribute('href')).toBe('https://github.com/notifications')
  })

  it('leaves Needs you empty when the queue and the rows both are', async () => {
    fleet(ok(queue()), quiet)
    render(<App />)

    await screen.findByRole('heading', { name: /Idle/ })
    expect(screen.queryByRole('heading', { name: /Needs you/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'GitHub' })).toBeNull()
  })

  /** D3 §7.1: an unanswerable question is never drawn as nothing to do, so the
   *  band opens `Needs you` on its own. */
  it('draws a failed queue even with no workspace waiting on you', async () => {
    fleet(
      {
        looked: 'failed',
        age_seconds: 12,
        error: '`gh` is installed but not logged in — run `gh auth login`',
      },
      quiet,
    )
    render(<App />)

    const band = await needs()
    expect(
      within(band).getByText(
        '`gh` is installed but not logged in — run `gh auth login`',
      ),
    ).toBeTruthy()
  })
})

/** Y-315. The fleet reads on a 30 s sweep and this one on 300 s, so a stamp
 *  shared with the rows under it would be wrong about one of them. */
describe('the band stamps its own reading', () => {
  it('shows the queue age and names the clock it is on', () => {
    render(<AttentionBand reading={ok(queue({ notifications: 1 }), 240)} />)

    expect(screen.getByText('4m')).toBeTruthy()
    expect(screen.getByText(/read every 5 min/)).toBeTruthy()
  })

  /** `Age`'s thresholds are the 30 s sweep's, so borrowing it would call every
   *  ordinary reading here a stuck refresh. */
  it('does not call a five-minute-old answer a stuck refresh', () => {
    render(<AttentionBand reading={ok(queue({ notifications: 1 }), 290)} />)

    expect(screen.queryByText('refresh stuck')).toBeNull()
  })
})

/** Y-316. Each reason `attention.rs` tells apart is already written as an
 *  instruction, so the band carries the daemon's text rather than rewording it. */
describe('when gh cannot answer', () => {
  const sentences = [
    'could not spawn `gh` — is the GitHub CLI installed and on PATH?',
    '`gh` is installed but not logged in — run `gh auth login`',
    '`gh` could not reach GitHub',
    '`gh search prs --review-requested=@me` failed: HTTP 502',
  ]

  for (const error of sentences) {
    it(`says ${error}`, () => {
      render(<AttentionBand reading={{ looked: 'failed', age_seconds: 4, error }} />)

      expect(screen.getByText(error)).toBeTruthy()
      expect(screen.queryByText('Not looked at yet.')).toBeNull()
    })
  }

  it('draws a skeleton while the read is in flight', () => {
    const { container } = render(<AttentionBand reading={{ looked: 'pending' }} />)

    expect(container.querySelector('[data-slot="reading"]')).toBeTruthy()
    expect(screen.queryByText('Not looked at yet.')).toBeNull()
  })

  it('says nobody has looked rather than drawing an empty queue', () => {
    render(<AttentionBand reading={{ looked: 'never' }} />)

    expect(screen.getByText('Not looked at yet.')).toBeTruthy()
  })
})
