import { describe, expect, it } from 'vitest'
import { buildMenuItems, resolveQuickAction, type GitState } from './gitActions.logic'

const idle: GitState = { thread: true, busy: false, changed: false, committed: false, pushed: false, pr: null }
const quick = (over: Partial<GitState>) => resolveQuickAction({ ...idle, ...over })

describe('resolveQuickAction', () => {
  it.each([
    ['no thread', { thread: false }, /no thread yet/],
    ['a running turn', { busy: true, changed: true }, /turn is running/],
    ['nothing to do', {}, /Nothing to commit/],
  ] as const)('is a disabled hint for %s', (_, over, hint) => {
    const got = quick(over)
    expect(got.kind).toBe('hint')
    expect(got.disabled).toBe(true)
    expect(got.hint).toMatch(hint)
  })

  it.each([
    ['changes', { changed: true }, 'Commit', 'commit'],
    ['a commit not pushed', { committed: true }, 'Push', 'push'],
    ['a push with no PR', { pushed: true }, 'Open PR', 'pr'],
    ['an open PR', { pr: { number: 7, state: 'open' } }, 'PR #7', 'open_pr_link'],
    ['a merged PR', { pr: { number: 7, state: 'merged' } }, 'PR #7', 'open_pr_link'],
  ] as const)('offers the next step for %s', (_, over, label, kind) => {
    expect(quick(over)).toEqual({ label, kind, disabled: false, hint: null })
  })

  it('commits before it pushes, and pushes before it opens', () => {
    expect(quick({ changed: true, committed: true, pushed: true }).kind).toBe('commit')
    expect(quick({ committed: true, pushed: true }).kind).toBe('push')
  })

  it('shows the PR rather than opening a second one', () => {
    expect(quick({ pushed: true, pr: { number: 3, state: 'open' } }).kind).toBe('open_pr_link')
  })
})

describe('buildMenuItems', () => {
  it('lists the three verbs, on once the thread is idle', () => {
    const items = buildMenuItems(idle)
    expect(items.map((one) => [one.label, one.kind, one.disabled])).toEqual([
      ['Commit', 'commit', false],
      ['Push', 'push', false],
      ['Open PR', 'pr', false],
    ])
  })

  it.each([
    [{ thread: false }, /no thread yet/],
    [{ busy: true }, /turn is running/],
  ] as const)('turns each verb off with its reason for %j', (over, reason) => {
    const items = buildMenuItems({ ...idle, ...over })
    expect(items.every((one) => one.disabled)).toBe(true)
    expect(items.every((one) => reason.test(one.reason ?? ''))).toBe(true)
  })

  it('swaps Open PR for a link to the PR', () => {
    const link = buildMenuItems({ ...idle, pr: { number: 9, state: 'merged' } }).find((one) => one.id === 'pr')
    expect(link).toEqual({ id: 'pr', label: 'PR #9', kind: 'open_pr_link', disabled: false, reason: null })
  })

  it('offers Merge PR #n for an open PR, off while a turn runs', () => {
    const merge = (over: Partial<GitState>) =>
      buildMenuItems({ ...idle, pr: { number: 9, state: 'open' }, ...over }).find((one) => one.id === 'merge')
    expect(merge({})).toEqual({ id: 'merge', label: 'Merge PR #9', kind: 'merge', disabled: false, reason: null })
    expect(merge({ busy: true })).toMatchObject({ disabled: true, reason: expect.stringMatching(/turn is running/) })
  })

  it('offers Remove worktree for a merged PR, and neither without a PR', () => {
    const ids = (pr: GitState['pr']) => buildMenuItems({ ...idle, pr }).map((one) => one.id)
    expect(ids({ number: 9, state: 'merged' })).toEqual(['commit', 'push', 'pr', 'remove'])
    expect(buildMenuItems({ ...idle, pr: { number: 9, state: 'merged' } }).at(-1)).toEqual({
      id: 'remove',
      label: 'Remove worktree',
      kind: 'remove',
      disabled: false,
      reason: null,
    })
    expect(ids(null)).toEqual(['commit', 'push', 'pr'])
  })
})
