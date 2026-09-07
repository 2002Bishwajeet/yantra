import { describe, expect, it } from 'vitest'
import type { Event } from '@/api'
import { asEvents, grouped, merge, unseen } from './notifications'

const trust: Event = { at: 100, kind: 'awaiting_trust', workspace: 'api', machine: 'pi', said: 'wants cargo test' }
const relay: Event = { at: 50, kind: 'relay-test', workspace: null, machine: null, said: 'reached' }
const gone: Event = { at: 75, kind: 'unreachable', workspace: null, machine: 'thinkpad', said: 'no route' }

const attention = {
  reviews: [{ repo: 'o/r', number: 1, title: 'a review', url: 'https://x/1', updated_at: '1970-01-01T00:01:30Z' }],
  issues: [{ repo: 'o/r', number: 2, title: 'an issue', url: 'https://x/2', updated_at: '1970-01-01T00:00:10Z' }],
  notifications: 0,
}

describe('merge', () => {
  it('sorts events and GitHub items together, newest first', () => {
    const entries = merge([relay, trust, gone], attention)
    expect(entries.map((one) => one.headline)).toEqual([
      'api is waiting for trust',
      'Review requested on r#1',
      'thinkpad became unreachable',
      'Test message arrived at the relay',
      'Issue assigned: r#2',
    ])
    expect(entries[0]!.answer).toBe('api')
    expect(entries[0]!.supporting).toBe('wants cargo test · pi')
    expect(entries[1]!.href).toBe('https://x/1')
    expect(entries[0]!.tile).toEqual({ kind: 'workspace', name: 'api' })
    expect(entries[3]!.tile).toEqual({ kind: 'relay' })
  })

  it('takes a bare list or the envelope', () => {
    expect(asEvents([trust])).toEqual([trust])
    expect(asEvents({ looked: 'ok', age_seconds: 0, data: [trust] })).toEqual([trust])
    expect(asEvents({ looked: 'never' })).toEqual([])
    expect(asEvents(undefined)).toEqual([])
  })
})

describe('unseen and grouped', () => {
  const entries = merge([relay, trust, gone], null)

  it('is everything before a mark, and only what is newer after one', () => {
    expect(unseen(entries, null)).toHaveLength(3)
    expect(unseen(entries, 75).map((one) => one.at)).toEqual([100])
  })

  it("splits on the reader's calendar day", () => {
    const now = Date.UTC(1970, 0, 1, 12)
    const { today, earlier } = grouped(entries, now)
    expect(today).toHaveLength(3)
    expect(earlier).toHaveLength(0)
    expect(grouped(entries, now + 2 * 86_400_000).today).toHaveLength(0)
  })
})
