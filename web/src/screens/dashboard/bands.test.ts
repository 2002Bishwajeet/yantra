import { describe, expect, it } from 'vitest'
import type { Event, Machine, MachineSessions, Workspace } from '@/api'
import type { Reading } from '@/api/hooks'
import { askedAt, online, recent, stamp, startedAt } from './bands'

const NOW = Date.parse('2026-09-06T12:00:00Z')

const machine = (name: string, up: boolean, seen: string | null = null): Machine => ({
  name,
  dns_name: `${name}.yantra.tail3a1b.ts.net.`,
  address: null,
  os: 'linux',
  online: up,
  expired: false,
  last_seen: seen,
  heartbeat: null,
})

const read = (name: string, age: number): { name: string; reading: Reading<unknown> } => ({
  name,
  reading: { looked: 'ok', age_seconds: age, data: null },
})

const event = (kind: Event['kind'], workspace: string | null, at: number): Event => ({
  at,
  kind,
  workspace,
  machine: workspace === null ? 'thinkpad' : 'cachyos-g14',
  said: 'said so',
})

describe('online', () => {
  it('counts what the tailnet sees and ages what it does not', () => {
    const { up, down } = online(
      [machine('cachyos-g14', true), machine('thinkpad', false, '2026-09-06T10:00:00Z')],
      NOW,
    )
    expect(up).toBe(1)
    expect(down).toEqual([{ name: 'thinkpad', since: '2h' }])
  })

  it('leaves the age null when the daemon never saw the machine', () => {
    expect(online([machine('nas', false)], NOW).down).toEqual([{ name: 'nas', since: null }])
  })
})

describe('stamp', () => {
  it('is the oldest read, not an average', () => {
    expect(stamp([read('machines', 4), read('workspaces', 12), read('sessions', 9)])?.age).toBe(12)
  })

  it('names a read more than one sweep behind the rest and drops it from the age', () => {
    const answer = stamp([read('machines', 4), read('sessions', 300)])
    expect(answer).toEqual({ age: 4, late: [{ name: 'sessions', age: 300 }] })
  })

  it('is null before any read has landed', () => {
    expect(stamp([{ name: 'machines', reading: { looked: 'pending' } }])).toBeNull()
  })

  it('counts a failed look, which ages its failure', () => {
    expect(
      stamp([{ name: 'machines', reading: { looked: 'failed', age_seconds: 30, error: 'no' } }])?.age,
    ).toBe(30)
  })
})

describe('startedAt', () => {
  const workspace = { name: 'landing', machine: 'macbook' } as Workspace
  const sessions = (reached: 'yes' | 'no'): Reading<MachineSessions[]> => ({
    looked: 'ok',
    age_seconds: 0,
    data: [
      reached === 'yes'
        ? {
            machine: 'macbook',
            reached: 'yes',
            sessions: [
              {
                name: 'landing',
                windows: 1,
                attached: 0,
                created: 'Sat Sep  5 12:00:00 2026',
                created_at: 1788600000,
              },
            ],
          }
        : { machine: 'macbook', reached: 'no', error: 'no route to host' },
    ],
  })

  it('finds the tmux session behind the workspace', () => {
    expect(startedAt(sessions('yes'), workspace)).toBe(1788600000)
  })

  it('is null when the machine did not answer', () => {
    expect(startedAt(sessions('no'), workspace)).toBeNull()
  })

  it('is null before the sessions read lands', () => {
    expect(startedAt({ looked: 'pending' }, workspace)).toBeNull()
  })
})

describe('askedAt', () => {
  const events = [event('awaiting_trust', 'yantra-web', 100), event('finished', 'landing', 90)]

  it('finds the trust prompt behind a waiting workspace', () => {
    expect(askedAt(events, 'yantra-web')?.at).toBe(100)
  })

  it('ignores an event of another kind for the same workspace', () => {
    expect(askedAt(events, 'landing')).toBeNull()
  })
})

describe('recent', () => {
  it('is the last five session events, newest first, in the board’s words', () => {
    const rows = recent([
      event('finished', 'landing', 10),
      event('awaiting_trust', 'yantra-web', 40),
      event('no_agent', 'appliance', 30),
      event('relay-test', null, 50),
      event('crashed', 'ntfy-relay', 20),
    ])
    expect(rows.map((one) => [one.workspace, one.words, one.mark])).toEqual([
      ['yantra-web', 'asked for trust', 'needs'],
      ['appliance', 'opened as a shell', 'running'],
      ['ntfy-relay', 'crashed', 'failed'],
      ['landing', 'finished', 'done'],
    ])
  })

  it('holds five at most', () => {
    const many = Array.from({ length: 9 }, (_, i) => event('running', `w${i}`, i))
    expect(recent(many)).toHaveLength(5)
  })
})
