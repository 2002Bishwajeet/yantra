import { describe, expect, it } from 'vitest'
import type { AgentState, Workspace, WorkspaceStatus } from '@/api'
import { chosen, confirms, detailOf, stateOf, stoppable } from './verbs'

const shell: Workspace = { name: 'api', machine: 'cachyos-g14', repo: '/r', startup: null }
const own: Workspace = { ...shell, startup: 'npm run dev' }

const reached = (status: AgentState): WorkspaceStatus => ({
  workspace: 'api',
  machine: 'cachyos-g14',
  reached: 'yes',
  status,
  session: null,
})

const gone: WorkspaceStatus = { workspace: 'api', machine: 'pi', reached: 'no', error: 'No route to host' }

describe('chosen', () => {
  it('waits on a row nobody has read, and sends an unreachable machine to Fix', () => {
    expect(chosen(shell, null)).toEqual({ does: 'wait' })
    expect(chosen(shell, gone)).toEqual({ does: 'fix' })
  })

  it('Start for no session, Answer for the trust prompt, Open for a live one', () => {
    expect(chosen(shell, reached({ state: 'no_session' }))).toEqual({ does: 'post', verb: 'up', label: 'Start' })
    expect(chosen(shell, reached({ state: 'awaiting_trust' }))).toEqual({ does: 'answer' })
    expect(chosen(shell, reached({ state: 'running' }))).toEqual({ does: 'open' })
    expect(chosen(shell, reached({ state: 'no_agent' }))).toEqual({ does: 'open' })
  })

  it('Resume for an ended agent, unless the workspace starts something of its own (ADR-0015)', () => {
    for (const state of ['finished', 'stopped', 'crashed', 'killed'] as const) {
      const status = state === 'crashed' ? { state, exit_status: 1 } : state === 'killed' ? { state, signal: 'SIGKILL' } : { state }
      expect(chosen(shell, reached(status as AgentState))).toEqual({ does: 'post', verb: 'resume', label: 'Resume' })
      expect(chosen(own, reached(status as AgentState))).toEqual({ does: 'open' })
    }
  })
})

describe('confirming', () => {
  it('asks first only for Kill and Delete (D3 §4.7)', () => {
    expect(confirms('up')).toBe(false)
    expect(confirms('down')).toBe(false)
    expect(confirms('resume')).toBe(false)
    expect(confirms('kill')).toBe(true)
    expect(confirms('delete')).toBe(true)
  })

  it('offers Stop beside Open on an agent, and not on a plain shell', () => {
    expect(stoppable(reached({ state: 'running' }))).toBe(true)
    expect(stoppable(reached({ state: 'no_agent' }))).toBe(false)
    expect(stoppable(null)).toBe(false)
  })
})

describe('the words', () => {
  it('are a mark and a word for every state, and never colour alone', () => {
    expect(stateOf(reached({ state: 'awaiting_trust' }))).toEqual({ state: 'needs', word: 'waiting for trust' })
    expect(stateOf(reached({ state: 'no_agent' }))).toEqual({ state: 'running', word: 'no agent, opened as a shell' })
    expect(stateOf(reached({ state: 'crashed', exit_status: 137 }))).toEqual({ state: 'failed', word: 'crashed, exit 137' })
    expect(stateOf(reached({ state: 'unclear', because: 'two verdicts' }))).toEqual({ state: 'unknown', word: 'unclear' })
    expect(stateOf(null)).toEqual({ state: 'unknown', word: 'not read yet' })
    expect(stateOf(gone).word).toBe('machine did not answer')
  })

  it('carries the reason where there is one', () => {
    expect(detailOf(gone)).toBe('No route to host')
    expect(detailOf(reached({ state: 'unclear', because: 'two verdicts' }))).toBe('two verdicts')
    expect(detailOf(reached({ state: 'running' }))).toBe('')
  })
})
