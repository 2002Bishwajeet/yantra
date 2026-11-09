import { describe, expect, it } from 'vitest'
import type { Pull, PullCheck } from '@/api'
import { pulls } from '@/contract.gen'
import { canFix, checkStatus, fixBlock, summarizeChecks } from './checks.logic'

const watched = pulls.data[0]! as Pull
const run = (status: string, conclusion: string | null, name = 'test'): PullCheck => ({ name, status, conclusion, output: null })

describe('fixBlock', () => {
  it('names each failed check, then each review, then each line comment, in that order', () => {
    expect(fixBlock(watched)).toBe(
      [
        'Fix PR #21:',
        'Check test failed (failure).\n1 failed\n`watch::look` panicked',
        'Review by friend (changes requested):\nPlease add a test.',
        '> src/watch.rs:L12\nThis drops the etag.',
      ].join('\n\n'),
    )
  })

  it('leaves out the checks that passed, ran or are still running', () => {
    const pull: Pull = {
      ...watched,
      checks: [run('completed', 'success', 'lint'), run('in_progress', null, 'slow'), run('completed', 'timed_out', 'e2e')],
      reviews: [],
      comments: [],
    }
    expect(fixBlock(pull)).toBe('Fix PR #21:\n\nCheck e2e failed (timed_out).')
  })

  it('keeps the line comments in the order GitHub sent them, and names a line no longer in the diff by its path', () => {
    const pull: Pull = {
      ...watched,
      checks: [],
      reviews: [{ id: 1, author: '', state: 'APPROVED', body: '  ' }],
      comments: [
        { id: 2, author: 'a', path: 'b.rs', line: 4, body: 'second file first' },
        { id: 3, author: 'a', path: 'a.rs', line: null, body: 'outdated' },
      ],
    }
    expect(fixBlock(pull)).toBe('Fix PR #21:\n\n> b.rs:L4\nsecond file first\n\n> a.rs\noutdated')
  })

  it('is empty, and Fix is off, when nothing failed and nobody commented', () => {
    const pull: Pull = { ...watched, checks: [run('completed', 'success')], reviews: [], comments: [] }
    expect(fixBlock(pull)).toBe('')
    expect(canFix(pull)).toBe(false)
    expect(canFix(watched)).toBe(true)
  })
})

describe('the check marks', () => {
  it('reads a running check as pending and each conclusion as its own mark', () => {
    expect(checkStatus(run('queued', null))).toBe('pending')
    expect(checkStatus(run('completed', 'success'))).toBe('success')
    expect(checkStatus(run('completed', 'timed_out'))).toBe('failure')
    expect(checkStatus(run('completed', 'action_required'))).toBe('failure')
    expect(checkStatus(run('completed', 'cancelled'))).toBe('cancelled')
    expect(checkStatus(run('completed', 'stale'))).toBe('neutral')
  })

  it('summarises failed first, then running, then passed', () => {
    expect(summarizeChecks([])).toBe('GitHub reported no checks yet')
    expect(summarizeChecks(watched.checks)).toBe('1 of 2 failing')
    expect(summarizeChecks([run('completed', 'success'), run('queued', null)])).toBe('1 of 2 running')
    expect(summarizeChecks([run('completed', 'success'), run('completed', 'skipped')])).toBe('1 of 2 passing')
    expect(summarizeChecks([run('completed', 'success')])).toBe('All checks passed')
  })
})
