import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/errors'
import { gitFailure, whyOff, type GitAction, type GitFailureKind } from './git'

const refused = (status: number, said = 'the daemon said') => new ApiError('refused', said, { status })

describe('gitFailure', () => {
  it.each<[GitAction, number, GitFailureKind]>([
    ['draft', 409, 'draftRunning'],
    ['draft', 502, 'draftClaude'],
    ['draft', 504, 'draftTimeout'],
    ['commit', 400, 'commitEmpty'],
    ['commit', 409, 'commitRefused'],
    ['push', 409, 'pushRefused'],
    ['pr', 409, 'prRefused'],
    ['pr', 502, 'prGithub'],
  ])('%s with %s is %s', (action, status, kind) => {
    const failure = gitFailure(action, refused(status, 'daemon words'))
    expect(failure.kind).toBe(kind)
    expect(failure.said).toBe('daemon words')
    expect(failure.title).not.toBe('')
    expect(failure.describe()).not.toBe('')
  })

  it.each<GitAction>(['draft', 'commit', 'push', 'pr'])('%s with 404 is no thread, and asking again cannot help', (action) => {
    const failure = gitFailure(action, new ApiError('missing', 'no such thread', { status: 404 }))
    expect(failure).toMatchObject({ kind: 'noThread', retryable: false, said: 'no such thread' })
  })

  it.each<GitAction>(['draft', 'commit', 'push', 'pr'])('%s with 503 is the machine unreachable', (action) => {
    expect(gitFailure(action, refused(503, 'ssh: no route'))).toMatchObject({ kind: 'unreachable', retryable: true })
  })

  it.each<GitAction>(['draft', 'commit', 'push', 'pr'])('%s with nothing answering is network', (action) => {
    expect(gitFailure(action, new ApiError('network', 'Failed to fetch'))).toMatchObject({
      kind: 'network',
      retryable: true,
    })
  })

  it.each<[GitAction, number]>([
    ['push', 502],
    ['commit', 500],
    ['draft', 403],
    ['pr', 400],
  ])('%s with a status the daemon does not send for it (%s) is other', (action, status) => {
    expect(gitFailure(action, refused(status)).kind).toBe('other')
  })

  it('names a bare error as other, not as the daemon', () => {
    expect(gitFailure('push', new Error('boom')).kind).toBe('other')
  })

  it('lets a person retry everything but an empty message and a missing thread', () => {
    expect(gitFailure('commit', refused(400)).retryable).toBe(false)
    expect(gitFailure('commit', refused(409)).retryable).toBe(true)
  })

  it('has a distinct title for every kind', () => {
    const kinds = new Set<GitFailureKind>()
    const seen = new Set<string>()
    const probes: [GitAction, ApiError][] = [
      ['draft', refused(409)],
      ['draft', refused(502)],
      ['draft', refused(504)],
      ['commit', refused(400)],
      ['commit', refused(409)],
      ['push', refused(409)],
      ['pr', refused(409)],
      ['pr', refused(502)],
      ['pr', new ApiError('missing', '', { status: 404 })],
      ['pr', refused(503)],
      ['pr', new ApiError('network', '')],
      ['pr', refused(500)],
    ]
    for (const [action, error] of probes) {
      const failure = gitFailure(action, error)
      kinds.add(failure.kind)
      seen.add(failure.title)
    }
    expect(kinds.size).toBe(12)
    expect(seen.size).toBe(12)
  })
})

describe('whyOff', () => {
  it('names a missing thread before a running turn', () => {
    expect(whyOff(null, true)).toMatch(/no thread/)
  })
  it('names a running turn', () => {
    expect(whyOff('0a1b', true)).toMatch(/turn is running/)
  })
  it('is null when the control is on', () => {
    expect(whyOff('0a1b', false)).toBeNull()
  })
})
