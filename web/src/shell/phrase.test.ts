import { describe, expect, it } from 'vitest'
import type { AgentState, WorkspaceStatus } from '@/api'
import { phrase } from './phrase'

const reached = (status: AgentState): WorkspaceStatus => ({
  workspace: 'landing',
  machine: 'macbook',
  reached: 'yes',
  session: null,
  status,
})

describe('the words a status carries in a row', () => {
  /** Y-639: every Stop ends in `no_session`, so the two read the same. */
  it('calls a session that is gone stopped, as it calls a stopped agent', () => {
    expect(phrase(reached({ state: 'no_session' }))).toEqual({ mark: 'idle', words: 'stopped', live: false })
    expect(phrase(reached({ state: 'stopped' }))).toEqual({ mark: 'idle', words: 'stopped', live: false })
  })

  /** Y-639: the only real cause of `unclear` is a live pane. */
  it('files an unclear agent as live', () => {
    expect(phrase(reached({ state: 'unclear', because: 'claude knows of no agent in that directory' }))).toEqual({
      mark: 'unknown',
      words: 'unclear',
      live: true,
    })
  })

  it('files nothing it could not read as live', () => {
    expect(phrase(null).live).toBe(false)
    expect(phrase({ workspace: 'landing', machine: 'macbook', reached: 'no', error: 'no route to host' }).live).toBe(false)
  })
})
