/**
 * The work page's subject: three groups ordered by who must act next, an
 * unreachable machine counted once, an order that holds until it is asked to
 * move, and an Idle group that stops being the longest thing on the page.
 * D3 §4.1, §4.4, §4.6. Y-188.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type {
  AgentState,
  Listed,
  Workspace,
  WorkspaceStatus,
} from './api'
import { Footer } from './components/Footer'
import { Unreachable } from './components/Unreachable'
import { unreachable, work } from './work'

afterEach(cleanup)

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

/** D3 §4.3: one line at the foot of the page, where §2 finding 4 counted seven
 *  freshness stamps and D1 §2 had asked for one. */
describe('the footer', () => {
  const read = (name: string, age: number) => ({
    name,
    reading: { looked: 'ok', age_seconds: age, data: null } as const,
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

/** D3 §7.2: off the tailnet the service worker serves the shell and every fetch
 *  fails, and the page drew that as one failure per section. */
describe('when nothing can be reached', () => {
  const dead = (error: string) =>
    ({ looked: 'failed', age_seconds: 0, error }) as const

  it('says it once, and says what it cannot tell apart', () => {
    const off = 'TypeError: fetch failed'
    expect(unreachable([dead(off), dead(off), dead(off)])).toBe(off)

    render(<Unreachable error={off} />)
    expect(screen.getByText('Nothing here can be reached.')).toBeTruthy()
    expect(
      screen.getByText(/not something this page can tell/),
    ).toBeTruthy()
  })

  /** Identical text, not merely all-failed: the daemon's own envelopes differ
   *  per class, so two classes failing for two reasons stays two problems. */
  it('keeps two different failures as two', () => {
    expect(
      unreachable([dead('tailscaled is down'), dead('TypeError: fetch failed')]),
    ).toBeNull()
  })

  it('says nothing while one read is still answering', () => {
    expect(unreachable([dead('gone'), { looked: 'pending' }])).toBeNull()
    expect(
      unreachable([dead('gone'), { looked: 'ok', age_seconds: 1, data: null }]),
    ).toBeNull()
  })
})
