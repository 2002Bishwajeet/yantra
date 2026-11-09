import { describe, expect, it } from 'vitest'
import * as contract from '@/contract.gen'
import { elapsed, groupThreads, threadTitle } from './threads'

const one = contract.threads[0]!

describe('threadTitle', () => {
  it('reads the title, then the issue, then "Untitled thread", and never the id', () => {
    expect(threadTitle({ ...one, title: 'Fix it', issue: 'o/r#7' })).toBe('Fix it')
    expect(threadTitle({ ...one, title: null, issue: 'o/r#7' })).toBe('o/r#7')
    expect(threadTitle({ ...one, title: null, issue: null })).toBe('Untitled thread')
  })
})

describe('elapsed', () => {
  it('formats seconds, minutes and hours', () => {
    expect(elapsed(0, 8_000)).toBe('8s')
    expect(elapsed(0, 184_000)).toBe('3m 04s')
    expect(elapsed(0, 3_720_000)).toBe('1h 02m')
    expect(elapsed(10_000, 0)).toBe('0s')
  })
})

describe('groupThreads', () => {
  it('puts working threads first in Active', () => {
    const idle = { ...one, id: 'a', state: 'idle' as const }
    const busy = { ...one, id: 'b', state: 'working' as const }
    const merged = { ...one, id: 'c', state: 'idle' as const, pr: { state: 'merged' as const, number: 1, url: 'u' } }
    const groups = groupThreads([idle, merged, busy])
    expect(groups.map((group) => group.items.map((thread) => thread.id))).toEqual([['b', 'a'], ['c']])
  })
})
