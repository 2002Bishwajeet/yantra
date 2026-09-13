import { describe, expect, it } from 'vitest'
import type { Event } from '@/api'
import { asEvents, grouped, merge, unseen } from './notifications'

const trust: Event = { at: 100, kind: 'awaiting_trust', workspace: 'api', machine: 'pi', said: 'wants cargo test', commands: [] }
const relay: Event = { at: 50, kind: 'relay-test', workspace: null, machine: null, said: 'reached', commands: [] }
const gone: Event = { at: 75, kind: 'unreachable', workspace: null, machine: 'thinkpad', said: 'no route', commands: [] }

// `events.rs::joined`'s four sentences (§ notifications.ts, `NORMAL_JOIN`).
const joinedNormal: Event = {
  at: 200,
  kind: 'joined',
  workspace: null,
  machine: 'pi',
  said: 'pi joined, and Yantra logs in there as biswa',
  commands: [],
}
const joinedDiffers: Event = {
  at: 210,
  kind: 'joined',
  workspace: null,
  machine: 'pi',
  said:
    'pi joined as biswa, but the ssh config logs in there as someone-else, so Yantra cannot reach it until the owner edits that config',
  commands: [],
}
const joinedKept: Event = {
  at: 220,
  kind: 'joined',
  workspace: null,
  machine: 'pi',
  said: 'pi joined as biswa, and the ssh config already named it with that account, so it was kept',
  commands: [],
}
const installed: Event = {
  at: 230,
  kind: 'installed',
  workspace: null,
  machine: 'pi',
  said: 'pi: every basic was already there',
  commands: [],
}
const installStopped: Event = {
  at: 240,
  kind: 'install_stopped',
  workspace: null,
  machine: 'pi',
  said: 'pi: tmux left for you — run `sudo apt-get install -y tmux` on pi',
  commands: ['sudo apt-get install -y tmux'],
}
const installFailed: Event = {
  at: 250,
  kind: 'install_stopped',
  workspace: null,
  machine: 'pi',
  said: 'pi: the install did not finish: ssh closed unexpectedly',
  commands: [],
}

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

describe('join and install rows (Y-399)', () => {
  it('a plain join is done, with the account in the supporting line', () => {
    const [entry] = merge([joinedNormal], null)
    expect(entry).toMatchObject({
      headline: 'pi joined',
      supporting: 'as biswa',
      mark: 'done',
      open: 'pi',
    })
    expect(entry.wrap).toBeFalsy()
  })

  it('a join that logs in as another account carries the full warning, wrapped', () => {
    const [entry] = merge([joinedDiffers], null)
    expect(entry).toMatchObject({
      headline: 'pi joined, as another account',
      supporting: joinedDiffers.said,
      mark: 'needs',
      open: 'pi',
      wrap: true,
    })
  })

  it('a kept config is the same warning, not the happy path', () => {
    const [entry] = merge([joinedKept], null)
    expect(entry.mark).toBe('needs')
    expect(entry.supporting).toBe(joinedKept.said)
  })

  it('an install with nothing left for a person is done', () => {
    const [entry] = merge([installed], null)
    expect(entry).toMatchObject({ headline: 'pi is ready', mark: 'done', open: 'pi' })
    expect(entry.commands).toBeUndefined()
  })

  it('an install_stopped with a command carries it, and only it, to the row', () => {
    const [entry] = merge([installStopped], null)
    expect(entry).toMatchObject({
      headline: 'pi needs your password',
      supporting: 'One command is left for you to run',
      mark: 'needs',
      open: 'pi',
      commands: ['sudo apt-get install -y tmux'],
    })
  })

  it('more than one command left pluralises the count', () => {
    const two: Event = { ...installStopped, commands: ['a', 'b'] }
    expect(merge([two], null)[0]!.supporting).toBe('2 commands are left for you to run')
  })

  it('an install_stopped with no command left is a different sentence, wrapped', () => {
    const [entry] = merge([installFailed], null)
    expect(entry).toMatchObject({
      headline: "pi's install did not finish",
      supporting: installFailed.said,
      mark: 'needs',
      wrap: true,
    })
    expect(entry.commands).toBeUndefined()
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
