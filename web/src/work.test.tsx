/**
 * The work page's subject: three groups ordered by who must act next, an
 * unreachable machine counted once, an order that holds until it is asked to
 * move, and an Idle group that stops being the longest thing on the page.
 * D3 §4.1, §4.4, §4.6. Y-188.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type {
  AgentState,
  Listed,
  Looked,
  Machine,
  Workspace,
  WorkspaceStatus,
} from './api'
import App from './App'
import { Footer } from './components/Footer'
import { BANDS, work } from './work'

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

const on = (name: string, machine = 'cachyos-g14'): Workspace => ({
  name,
  machine,
  repo: `/home/<user>/${name}`,
  startup: null,
})

const reached = (name: string, status: AgentState): WorkspaceStatus => ({
  workspace: name,
  machine: 'cachyos-g14',
  reached: 'yes',
  status,
  session: null,
})

const missed = (name: string, machine: string): WorkspaceStatus => ({
  workspace: name,
  machine,
  reached: 'no',
  error: `connect to host ${machine} port 22: Connection refused`,
})

const agents = (rows: { workspace: Workspace; status: WorkspaceStatus | null }[]) =>
  ({ looked: 'ok', age_seconds: 1, data: rows }) as const

describe('which group a state lands in', () => {
  const bandFor = (state: AgentState) => {
    const rows = work(
      [{ loaded: 'yes', ...on('one') } satisfies Listed],
      agents([{ workspace: on('one'), status: reached('one', state) }]),
    )
    return rows[0]!.band
  }

  it('puts what waits on a person, and what died, in front of you', () => {
    expect(bandFor({ state: 'awaiting_trust' })).toBe('needs')
    expect(bandFor({ state: 'crashed', exit_status: 1 })).toBe('needs')
    expect(bandFor({ state: 'killed', signal: 'SIGKILL' })).toBe('needs')
    expect(bandFor({ state: 'unclear', because: 'two answers' })).toBe('needs')
  })

  /** A group heading is not a state: `no_agent` sits in Running because its
   *  session is live, not because an agent works in it. */
  it('puts a live session under Running, agent or no agent', () => {
    expect(bandFor({ state: 'running' })).toBe('running')
    expect(bandFor({ state: 'no_agent' })).toBe('running')
  })

  it('puts what nobody has to touch under Idle', () => {
    expect(bandFor({ state: 'no_session' })).toBe('idle')
    expect(bandFor({ state: 'finished' })).toBe('idle')
    expect(bandFor({ state: 'stopped' })).toBe('idle')
  })

  /** R-23 inside the page: Y-084's 404 leaves a workspace with no state at all,
   *  and filing it under any of the three would be a guess painted as fact. */
  it('refuses to place a workspace nothing has read', () => {
    const rows = work(
      [{ loaded: 'yes', ...on('one') } satisfies Listed],
      agents([{ workspace: on('one'), status: null }]),
    )
    expect(rows[0]!.band).toBe('unknown')
  })

  it('names a file that will not parse, and gives it to you', () => {
    const rows = work(
      [{ loaded: 'no', name: 'broken', error: 'expected `=`' } satisfies Listed],
      { looked: 'never' },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ band: 'needs', kind: 'unusable' })
  })
})

/** **An unreachable machine is one row, and its workspaces are not listed.** A
 *  dead Pi holding four workspaces would otherwise push four rows into the group
 *  that means *act now*, and every one of them would name the same cause. */
describe('a machine that did not answer', () => {
  const four = ['a', 'b', 'c', 'd'].map((name) => on(name, 'pi'))
  const rows = work(
    four.map((one) => ({ loaded: 'yes', ...one }) satisfies Listed),
    agents(four.map((one) => ({ workspace: one, status: missed(one.name, 'pi') }))),
  )

  it('is one row, counting the workspaces behind it', () => {
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      band: 'needs',
      kind: 'machine',
      machine: 'pi',
      workspaces: 4,
    })
  })

  it('lists none of them separately', () => {
    expect(rows.filter((row) => row.kind === 'workspace')).toHaveLength(0)
  })
})

function fleet(
  workspaces: Workspace[],
  states: Record<string, AgentState>,
  overrides: Record<string, Looked<unknown> | number> = {},
) {
  const answers: Record<string, Looked<unknown> | number> = {
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
          data: reached(one.name, states[one.name]!),
        },
      ]),
    ),
    ...overrides,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      const answer = answers[path]
      return typeof answer === 'number'
        ? Promise.resolve({ ok: false, status: answer })
        : Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(answer),
          })
    }),
  )
  return answers
}

const heading = (name: RegExp) => screen.getByRole('heading', { name })

describe('the work page', () => {
  it('opens on the three groups, each carrying its count', async () => {
    fleet([on('api'), on('web'), on('old')], {
      api: { state: 'awaiting_trust' },
      web: { state: 'running' },
      old: { state: 'finished' },
    })
    render(<App />)

    await screen.findByRole('heading', { name: /Needs you/ })
    for (const [title, count] of [
      ['Needs you', '1'],
      ['Running', '1'],
      ['Idle', '1'],
    ]) {
      expect(heading(new RegExp(title)).textContent).toContain(count)
    }
    // Every band has a title, and none of them is a state's own word.
    expect(BANDS.map((one) => one.title)).not.toContain('finished')
  })

  /** §4.1: a `finished` row still says *finished* inside Idle. Collapsing nine
   *  verdicts into three words would throw away the vocabulary R-23 protects. */
  it('keeps every row its own word inside the group', async () => {
    fleet([on('old')], { old: { state: 'finished' } })
    render(<App />)

    const idle = (await screen.findByRole('heading', { name: /Idle/ }))
      .parentElement!
    expect(within(idle).getByText('finished')).toBeTruthy()
  })

  /** §4.6: thirty idle workspaces would be the longest thing on the page and
   *  the least urgent. */
  it('collapses Idle past a threshold', async () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => on(name))
    fleet(
      many,
      Object.fromEntries(many.map((one) => [one.name, { state: 'stopped' }])),
    )
    render(<App />)

    await screen.findByRole('heading', { name: /Idle/ })
    expect(screen.queryByText('g')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '2 more' }))
    expect(await screen.findByText('g')).toBeTruthy()
  })
})

/** §4.4: nothing moves under a thumb. A row shows its true state inside the
 *  group it had when the order was last computed, and the pill is what stops
 *  that being a lie. */
describe('the order is held; the rows are not', () => {
  it('leaves a changed row where it was, and offers the move', { timeout: 15_000 }, async () => {
    const answers = fleet([on('api')], { api: { state: 'running' } })
    render(<App />)

    const running = await screen.findByRole('heading', { name: /Running/ })
    expect(within(running.parentElement!).getByText('running')).toBeTruthy()

    answers['/api/workspaces/api/status'] = {
      looked: 'ok',
      age_seconds: 1,
      data: reached('api', { state: 'crashed', exit_status: 1 }),
    }

    // The row's word changes where it stands; the group does not. `useLooked`
    // polls every 5 s, which is longer than a matcher waits by default.
    expect(
      await screen.findByText('crashed — exit 1', undefined, { timeout: 8_000 }),
    ).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /Needs you/ })).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: /reorder/ }))

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Needs you/ })).toBeTruthy(),
    )
    expect(screen.queryByRole('heading', { name: /Running/ })).toBeNull()
  })
})

/** D3 §4.3: one line at the foot of the page, where §2 finding 4 counted seven
 *  freshness stamps and D1 §2 had asked for one. */
describe('the footer', () => {
  const read = (name: string, age: number) => ({
    name,
    reading: { looked: 'ok', age_seconds: age, data: null } as const,
  })

  it('counts machines, unreachable machines and unclaimed sessions', async () => {
    fleet([on('api'), on('gone', 'pi')], { api: { state: 'running' } }, {
      '/api/workspaces/gone/status': {
        looked: 'ok',
        age_seconds: 1,
        data: missed('gone', 'pi'),
      },
      '/api/sessions': {
        looked: 'ok',
        age_seconds: 1,
        data: [
          {
            machine: 'cachyos-g14',
            reached: 'yes',
            sessions: [
              { name: 'stray', windows: 1, attached: 0, created: 'today' },
            ],
          },
        ],
      },
    })
    render(<App />)

    // Scoped to the line, not to the word: `machines` is also a nav item.
    const foot = (await screen.findByText(/session unclaimed/)).closest('p')!
    expect(foot.textContent).toContain('1 machine')
    expect(foot.textContent).toContain('1 unreachable')
    expect(foot.textContent).toContain('1 session unclaimed')
  })

  /** The age is the **oldest** read and never an average, because an average
   *  hides the one stale answer — and a read a whole refresh period behind the
   *  rest is named beside the figure rather than folded into it. */
  it('takes the oldest age, and names a read that is further behind than that', () => {
    const { container } = render(
      <Footer
        machines={3}
        reads={[read('machines', 4), read('workspaces', 9), read('readiness', 51)]}
        unclaimed={0}
        unreachable={0}
      />,
    )

    expect(container.textContent).toContain('as of 9s')
    expect(container.textContent).toContain('readiness 51s')
    expect(container.textContent).not.toContain('as of 51s')
  })

  it('says nothing at all while every read is still in flight', () => {
    const { container } = render(
      <Footer
        machines={null}
        reads={[{ name: 'machines', reading: { looked: 'pending' } }]}
        unclaimed={null}
        unreachable={0}
      />,
    )
    expect(container.textContent).toBe('')
  })
})
