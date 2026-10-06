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

const withMic = (state: Check['state']) => {
  const ok = all()
  return report([...(ok.looked === 'ok' ? ok.data.checks : []), check('mic', state)])
}

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

  /** Y-412: doctor names a machine no ssh config block names, and that wins
   *  over the refusal it caused — the join command is the fix either way. */
  it('tells a machine that never joined from a refused key', () => {
    const unjoined = verdict(all({ reachable: 'absent' }, { reachable: 'the ssh config here names no account for cachyos-g14, so ssh tried `yantra` — run the join command on cachyos-g14 (Add a device, or `yantra join-script`) · Permission denied (publickey).' }))
    expect(unjoined).toEqual({ kind: 'unjoined', detail: 'the ssh config here names no account for cachyos-g14, so ssh tried `yantra` — run the join command on cachyos-g14 (Add a device, or `yantra join-script`) · Permission denied (publickey).' })
    expect(titleOf(unjoined, 'cachyos-g14')).toBe('cachyos-g14 has not joined')
    expect(chipOf(unjoined, null)).toEqual({ state: 'failed', word: 'not joined', error: true })
  })

  it('names the missing basics and offers no session', () => {
    const v = verdict(all({ tmux: 'absent', 'agent-cli': 'absent', 'provider-cli': 'absent' }))
    expect(v).toEqual({ kind: 'missing', missing: ['tmux', 'claude'], result: null, fresh: false })
    expect(titleOf(v, 'pi')).toBe('tmux and claude are missing')
    expect(startable(v)).toBe(false)
  })

  /** Y-402 review: the machines-list card reads `lib/ready`'s
   *  `missingBasics` too, and the two must not disagree about a basic the
   *  report never asked about — `git` is left out of this report entirely. */
  it('counts a basic the report never asked about, same as the card does', () => {
    const noGit = report(
      ['reachable', 'sshd', 'tmux', 'agent-cli', 'terminfo', 'provider-cli', 'provider-auth', 'login-session', 'heartbeat'].map(
        (id) => check(id, id === 'agent-cli' ? 'absent' : 'present'),
      ),
    )
    const v = verdict(noGit)
    expect(v).toEqual({ kind: 'missing', missing: ['git', 'claude'], result: null, fresh: false })
  })

  it('runs from the press until an answer newer than it lands', () => {
    const watch = { since: 10, pressed: 0, mic: false }
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
    const watch = { since: 0, pressed: 0, mic: false }
    const v = verdict(all({ tmux: 'absent' }), { watch, events: [stopped(20, ['apk add tmux'])] })
    expect(v).toMatchObject({ kind: 'missing', fresh: true })
  })

  it('lets a session start with only gh left to fix', () => {
    const v = verdict(all({ 'provider-auth': 'absent' }))
    expect(v.kind).toBe('manual')
    expect(titleOf(v, 'pi')).toBe('gh is not signed in')
    expect(startable(v)).toBe(true)
  })

  /** ADR-0031 §9: a microphone never installed is no fault. */
  it('is ready with a microphone never installed', () => {
    const ok = all()
    const checks = ok.looked === 'ok' ? ok.data.checks : []
    const v = verdict(report([...checks, check('mic', 'absent', 'not installed — the microphone is optional')]))
    expect(v.kind).toBe('ready')
    expect(chipOf(v, null).word).toBe('ready')
  })

  /** ADR-0031 §2: with every basic there, the step sudo stopped is linger. */
  it('asks for a password for the microphone after this page’s press', () => {
    const watch = { since: 10, pressed: 0, mic: true }
    const v = verdict(all(), { watch, events: [stopped(20, ['sudo loginctl enable-linger biswa'])] })
    expect(v).toMatchObject({ kind: 'sudo', missing: ['microphone'] })
    expect(titleOf(v, 'pi')).toBe('microphone needs your password')
  })

  /** ADR-0031 §1: a ready machine whose sudo asks still needs the microphone's packages. */
  it('asks for a password for the microphone’s package step', () => {
    const watch = { since: 10, pressed: 0, mic: true }
    const command = 'sudo apt-get install -y pipewire pipewire-pulse wireplumber'
    const v = verdict(withMic('absent'), { watch, events: [stopped(20, [command])] })
    expect(v).toMatchObject({ kind: 'sudo', missing: ['microphone'] })
    expect(titleOf(v, 'pi')).toBe('microphone needs your password')
  })

  it('is ready once the microphone a package step stopped is present', () => {
    const watch = { since: 10, pressed: 0, mic: true }
    const command = 'sudo apt-get install -y pipewire pipewire-pulse wireplumber'
    const v = verdict(withMic('present'), { watch, events: [stopped(20, [command])] })
    expect(v.kind).toBe('ready')
  })

  /** A package command someone ran by hand is no longer the microphone's. */
  it('is ready once a package sudo stopped is installed by hand', () => {
    const watch = { since: 10, pressed: 0, mic: false }
    const v = verdict(all(), { watch, events: [stopped(20, ['sudo apk add tmux'])] })
    expect(v.kind).toBe('ready')
    expect(titleOf(v, 'pi')).toBe('Ready for sessions')
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
