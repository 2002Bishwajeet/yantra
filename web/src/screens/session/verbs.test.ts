import { describe, expect, it } from 'vitest'
import type { AgentState, MachineSessions, Workspace, WorkspaceStatus } from '@/api'
import type { Reading } from '@/api/hooks'
import { ending, startedAt, verbs } from './verbs'

const landing: Workspace = {
  name: 'landing',
  machine: 'macbook',
  repo: '/Users/biswa/Github/yantra-landing',
  startup: null,
}

const reached = (status: AgentState): WorkspaceStatus => ({
  workspace: 'landing',
  machine: 'macbook',
  reached: 'yes',
  session: null,
  status,
})

describe('the verbs a session offers', () => {
  it('offers Stop while an agent is going, and Resume once it has ended', () => {
    expect(verbs(landing, reached({ state: 'running' }))).toEqual({ stop: true, resume: false })
    expect(verbs(landing, reached({ state: 'awaiting_trust' }))).toEqual({ stop: true, resume: false })
    expect(verbs(landing, reached({ state: 'finished' }))).toEqual({ stop: false, resume: true })
    expect(verbs(landing, reached({ state: 'killed', signal: 'SIGTERM' }))).toEqual({
      stop: false,
      resume: true,
    })
  })

  /** ADR-0015: `resume` forks claude's own conversation, and a workspace that
   *  starts a command of its own has no conversation to fork. */
  it('offers no Resume to a workspace that starts a command of its own', () => {
    const relay: Workspace = { ...landing, startup: 'npm run dev' }

    expect(verbs(relay, reached({ state: 'finished' }))).toEqual({ stop: false, resume: false })
  })

  it('offers neither before the status is read, nor when the machine did not answer', () => {
    expect(verbs(landing, null)).toEqual({ stop: false, resume: false })
    expect(
      verbs(landing, {
        workspace: 'landing',
        machine: 'macbook',
        reached: 'no',
        error: 'no route to host',
      }),
    ).toEqual({
      stop: false,
      resume: false,
    })
    expect(verbs(landing, reached({ state: 'no_session' }))).toEqual({ stop: false, resume: false })
  })
})

describe('how an ended agent is named', () => {
  it("uses the daemon's own word for each end, and none for a live one", () => {
    expect(ending({ state: 'finished' })).toBe('claude exited 0')
    expect(ending({ state: 'crashed', exit_status: 101 })).toBe('claude exited 101')
    expect(ending({ state: 'killed', signal: 'SIGKILL' })).toBe('claude was killed by SIGKILL')
    expect(ending({ state: 'running' })).toBeNull()
    expect(ending({ state: 'awaiting_trust' })).toBeNull()
  })
})

describe('the age of the tmux session behind a workspace', () => {
  const read = (data: MachineSessions[]): Reading<MachineSessions[]> => ({
    looked: 'ok',
    age_seconds: 0,
    data,
  })

  it('is the created_at of the session that carries its name', () => {
    const sessions = read([
      {
        machine: 'macbook',
        reached: 'yes',
        sessions: [
          {
            name: 'landing',
            windows: 1,
            attached: 0,
            created: 'Sun Sep  6 12:00:00 2026',
            created_at: 1_757_000_000,
          },
        ],
      },
    ])

    expect(startedAt(sessions, landing)).toBe(1_757_000_000)
  })

  it('is nothing when nothing was read, the machine refused, or no session carries the name', () => {
    expect(startedAt({ looked: 'pending' }, landing)).toBeNull()
    expect(startedAt(read([{ machine: 'macbook', reached: 'no', error: 'asleep' }]), landing)).toBeNull()
    expect(startedAt(read([{ machine: 'macbook', reached: 'yes', sessions: [] }]), landing)).toBeNull()
  })
})
