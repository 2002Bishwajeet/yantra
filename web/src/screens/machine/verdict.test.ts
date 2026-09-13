import { describe, expect, it } from 'vitest'
import type { Check, Event, Machine, Readiness } from '@/api'
import type { Reading } from '@/api/client'
import { chipOf, sorted, startable, titleOf, verdictOf } from './verdict'

const machine = (over: Partial<Machine> = {}) =>
  ({ name: 'pi', dns_name: 'pi.ts.net.', os: 'linux', online: true, expired: false, last_seen: null, heartbeat: null, ...over }) as Machine

const check = (name: string, state: Check['state'], detail = ''): Check => ({ check: name, state, detail })

const report = (checks: Check[]): Reading<Readiness> => ({ looked: 'ok', age_seconds: 0, data: { machine: 'pi', checks } })

const all = (over: Record<string, Check['state']> = {}, detail: Record<string, string> = {}) =>
  report(
    ['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo', 'provider-cli', 'provider-auth', 'login-session', 'heartbeat'].map(
      (id) => check(id, over[id] ?? 'present', detail[id] ?? ''),
    ),
  )

const stopped = (at: number, commands: string[]): Event => ({
  at,
  kind: 'install_stopped',
  workspace: null,
  machine: 'pi',
  said: 'pi: tmux left for you',
  commands,
})

const verdict = (readiness: Reading<Readiness>, over: Partial<Parameters<typeof verdictOf>[0]> = {}) =>
  verdictOf({ name: 'pi', machine: machine(), readiness, events: [], watch: null, ...over })

describe('the machine page’s verdict', () => {
  it('reads an offline machine as asleep whatever its last checks said', () => {
    const v = verdict(all({ tmux: 'absent' }), { machine: machine({ online: false }) })
    expect(v).toEqual({ kind: 'asleep' })
    expect(titleOf(v, 'pi')).toBe('pi is asleep')
    expect(chipOf(v, '3h')).toEqual({ state: 'unknown', word: 'asleep · 3h', error: false })
  })

  it('reads a machine nobody asked as not checked, never as a failure', () => {
    expect(verdict({ looked: 'never' })).toEqual({ kind: 'unasked' })
    expect(verdict(report([]))).toEqual({ kind: 'unasked' })
    expect(chipOf({ kind: 'unasked' }, null).error).toBe(false)
  })

  it('tells a refused key from ssh that fails for another reason', () => {
    const refused = verdict(all({ reachable: 'absent' }, { reachable: 'Permission denied (publickey).' }))
    expect(refused.kind).toBe('refused')
    expect(chipOf(refused, null)).toEqual({ state: 'failed', word: 'key refused', error: true })
    expect(verdict(all({ reachable: 'absent' }, { reachable: 'No route to host' })).kind).toBe('unreachable')
  })

  it('names the missing basics and offers no session', () => {
    const v = verdict(all({ tmux: 'absent', 'agent-cli': 'absent', 'provider-cli': 'absent' }))
    expect(v).toEqual({ kind: 'missing', missing: ['tmux', 'claude'], result: null, fresh: false })
    expect(titleOf(v, 'pi')).toBe('tmux and claude are missing')
    expect(startable(v)).toBe(false)
  })

  it('runs from the press until an answer newer than it lands', () => {
    const watch = { since: 10, pressed: 0 }
    const events = [stopped(10, ['sudo apk add tmux'])]
    expect(verdict(all({ tmux: 'absent' }), { watch, events })).toEqual({ kind: 'installing', missing: ['tmux'] })
    const answered = [stopped(20, ['sudo apk add tmux']), ...events]
    const v = verdict(all({ tmux: 'absent' }), { watch, events: answered })
    expect(v.kind).toBe('sudo')
    expect(titleOf(v, 'pi')).toBe('tmux needs your password')
  })

  it('asks for a password only after this page’s own press', () => {
    const v = verdict(all({ tmux: 'absent' }), { events: [stopped(20, ['sudo apk add tmux'])] })
    expect(v).toMatchObject({ kind: 'missing', fresh: false })
  })

  it('keeps a stop that needs no password as missing, with its result', () => {
    const watch = { since: 0, pressed: 0 }
    const v = verdict(all({ tmux: 'absent' }), { watch, events: [stopped(20, ['apk add tmux'])] })
    expect(v).toMatchObject({ kind: 'missing', fresh: true })
  })

  it('lets a session start with only gh left to fix', () => {
    const v = verdict(all({ 'provider-auth': 'absent' }))
    expect(v.kind).toBe('manual')
    expect(titleOf(v, 'pi')).toBe('gh is not signed in')
    expect(startable(v)).toBe(true)
  })

  it('is ready when nothing is absent', () => {
    const v = verdict(all())
    expect(titleOf(v, 'pi')).toBe('Ready for sessions')
    expect(chipOf(v, null)).toEqual({ state: 'done', word: 'ready', error: false })
  })

  it('sorts missing lines first', () => {
    const lines = sorted([check('a', 'present'), check('b', 'unknown'), check('c', 'absent')])
    expect(lines.map((one) => one.check)).toEqual(['c', 'b', 'a'])
  })
})
