import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/errors'
import { gitFailure, whyOff, type GitAction, type GitFailureKind } from './git'

const refused = (status: number, said = 'the daemon said') => new ApiError('refused', said, { status })

describe('gitFailure', () => {
  it.each<[GitAction, number, GitFailureKind]>([
    ['draft', 502, 'draftClaude'],
    ['draft', 504, 'draftTimeout'],
    ['commit', 400, 'commitEmpty'],
    ['commit', 409, 'commitRefused'],
    ['push', 409, 'pushRefused'],
    ['pr', 409, 'prRefused'],
    ['pr', 502, 'prGithub'],
    ['pending', 409, 'pendingRefused'],
    ['pending', 502, 'pendingGithub'],
    ['merge', 409, 'mergeRefused'],
    ['merge', 502, 'mergeGithub'],
    ['remove', 409, 'removeRefused'],
  ])('%s with %s is %s', (action, status, kind) => {
    const failure = gitFailure(action, refused(status, 'daemon words'))
    expect(failure.kind).toBe(kind)
    expect(failure.said).toBe('daemon words')
    expect(failure.title).not.toBe('')
    expect(failure.describe()).not.toBe('')
  })

  it.each<[string, GitFailureKind]>([
    ['a turn or a revert is running in this thread; wait for it to end', 'turnRunning'],
    ['the thread has nothing to commit', 'draftNothing'],
    ['the Mac has no tmux server from a login session, so git', 'noLogin'],
    ['something else', 'other'],
  ])('a draft 409 saying "%s" is %s', (said, kind) => {
    expect(gitFailure('draft', refused(409, said)).kind).toBe(kind)
  })

  it.each<[GitAction, string, GitFailureKind]>([
    ['merge', "the pull request's head moved after it was read; read it again and confirm the merge", 'mergeHeadMoved'],
    ['merge', 'no GitHub grant — run `yantra github login`', 'noGrant'],
    ['merge', 'GitHub will not merge the pull request: Pull Request is not mergeable', 'mergeRefused'],
    ['merge', 'the merge names no head; reload the dashboard, read the pull request again and confirm', 'mergeRefused'],
    ['pending', 'no GitHub grant — run `yantra github login`', 'noGrant'],
    ['pending', "the thread's branch has no open PR; open one first with `yantra pr open`", 'pendingRefused'],
    ['remove', 'a turn or a revert is running in this thread; wait for it to end', 'turnRunning'],
  ])('a %s 409 saying "%s" is %s', (action, said, kind) => {
    expect(gitFailure(action, refused(409, said)).kind).toBe(kind)
  })

  it.each<GitAction>(['draft', 'commit', 'push', 'pr', 'merge', 'remove'])(
    'a %s refusal that names the missing grant is noGrant, with no CLI in its words',
    (action) => {
      const failure = gitFailure(action, refused(409, 'no GitHub grant — run `yantra github login`'))
      expect(failure.kind).toBe('noGrant')
      expect(failure.title).toBe('GitHub is not connected')
      expect(failure.describe()).toBe('Connect GitHub, then try again.')
    },
  )

  it.each<[GitAction, number]>([
    ['pending', 401],
    ['pending', 403],
    ['merge', 401],
    ['merge', 403],
  ])('a %s %s is the caller gate, not the grant, so it keeps the daemon words', (action, status) => {
    const failure = gitFailure(action, refused(status, 'this node is not the owner'))
    expect(failure.kind).toBe('other')
    expect(failure.said).toBe('this node is not the owner')
  })

  it.each<GitAction>(['draft', 'commit', 'push'])('a %s 409 saying a turn or a revert is running is turnRunning', (action) => {
    expect(gitFailure(action, refused(409, 'a turn or a revert is running')).kind).toBe('turnRunning')
  })

  it.each<GitAction>(['draft', 'commit', 'push'])('a %s 409 saying the Mac has no tmux server is noLogin', (action) => {
    expect(gitFailure(action, refused(409, 'the Mac has no tmux server from a login session')).kind).toBe('noLogin')
  })

  it.each<GitAction>(['draft', 'commit', 'push', 'pr'])('%s with 404 is no thread, and asking again cannot help', (action) => {
    const failure = gitFailure(action, new ApiError('missing', 'no such thread', { status: 404 }))
    expect(failure).toMatchObject({ kind: 'noThread', retryable: false, said: 'no such thread' })
  })

  it.each<GitAction>(['draft', 'commit', 'push', 'pr', 'pending', 'merge', 'remove'])('%s with 503 is the machine unreachable', (action) => {
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
    expect(gitFailure('draft', refused(409, 'the thread has nothing to commit')).retryable).toBe(false)
  })

  it('has a distinct title for every kind', () => {
    const kinds = new Set<GitFailureKind>()
    const seen = new Set<string>()
    const probes: [GitAction, ApiError][] = [
      ['draft', refused(409, 'a turn is running')],
      ['draft', refused(409, 'nothing to commit')],
      ['draft', refused(409, 'no tmux server')],
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
      ['pending', refused(409)],
      ['pending', refused(502)],
      ['merge', refused(409)],
      ['merge', refused(409, 'head moved')],
      ['merge', refused(502)],
      ['merge', refused(409, 'no GitHub grant — run `yantra github login`')],
      ['remove', refused(409)],
    ]
    for (const [action, error] of probes) {
      const failure = gitFailure(action, error)
      kinds.add(failure.kind)
      seen.add(failure.title)
    }
    expect(kinds.size).toBe(21)
    expect(seen.size).toBe(21)
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
