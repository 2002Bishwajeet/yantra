import { describe, expect, it } from 'vitest'
import type { Check, Event, Machine, Readiness } from '@/api'
import type { Reading } from '@/api/client'
import { CHANGED_KEY, CHECK_RULE } from '@/test/sshSaid'
import { chipOf, sessionsFailure, sorted, startable, titleOf, verdictOf } from './verdict'

const machine = (over: Partial<Machine> = {}) =>
  ({ name: 'pi', dns_name: 'pi.ts.net.', os: 'linux', online: true, expired: false, last_seen: null, heartbeat: null, ...over }) as Machine

const check = (name: string, state: Check['state'], detail = ''): Check => ({ check: name, state, detail })

const report = (checks: Check[]): Reading<Readiness> => ({ looked: 'ok', age_seconds: 0, data: { machine: 'pi', checks, age_seconds: 0 } })

const all = (over: Record<string, Check['state']> = {}, detail: Record<string, string> = {}) =>
  report(
    ['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo', 'provider-cli', 'provider-auth', 'login-session', 'folder-access', 'hooks', 'heartbeat'].map(
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

/** doctor.rs `no_login_server`, word for word. */
const NO_SERVER =
  'no tmux server from a login session is running on this Mac. Panes in a server started over ssh cannot read the login keychain, so Yantra starts one in the login session when a session starts. Start one in Terminal there: `tmux new-session -d`'

/** yantrad's words for `ssh::Error::Transport` and a tmux error (Y-585). */
const SSH = 'ssh to pi failed before the command reported a status:'
const TMUX = 'tmux `list-sessions` failed with status 1: error connecting to /tmp/tmux-1000/default (Permission denied)'

const verdict = (readiness: Reading<Readiness>, over: Partial<Parameters<typeof verdictOf>[0]> = {}) =>
  verdictOf({ name: 'pi', machine: machine(), readiness, events: [], watch: null, ...over })

describe('the machine page’s verdict', () => {
  it('reads an offline machine as asleep whatever its last checks said', () => {
    const v = verdict(all({ tmux: 'absent' }), { machine: machine({ online: false }) })
    expect(v).toEqual({ kind: 'asleep' })
    expect(titleOf(v, 'pi')).toBe('pi is asleep')
    expect(chipOf(v, '3h')).toEqual({ state: 'unknown', word: 'asleep · 3h', error: false })
  })

  it('reads a Tailscale browser check as its own failure', () => {
    const detail = 'Tailscale SSH requires an additional check, which needs a browser sign-in'
    const v = verdict(all({ reachable: 'absent' }, { reachable: detail }))
    expect(v).toEqual({ kind: 'browser', detail })
    expect(titleOf(v, 'pi')).toBe('pi needs a browser sign-in')
    expect(chipOf(v, null)).toEqual({ state: 'failed', word: 'browser sign-in', error: true })
    expect(startable(v)).toBe(false)
  })

  /** Y-621: the two lines a daemon before v0.10.1 sends, link and all. */
  it('reads Tailscale’s real check text as the browser failure', () => {
    const v = verdict(all({ reachable: 'absent' }, { reachable: CHECK_RULE }))
    expect(v).toEqual({ kind: 'browser', detail: CHECK_RULE })
    expect(titleOf(v, 'pi')).toBe('pi needs a browser sign-in')
  })

  it('reads a changed host key as its own failure', () => {
    const v = verdict(all({ reachable: 'absent' }, { reachable: CHANGED_KEY }))
    expect(v).toEqual({ kind: 'changed', detail: CHANGED_KEY })
    expect(titleOf(v, 'pi')).toBe('pi’s host key changed')
    expect(chipOf(v, null)).toEqual({ state: 'failed', word: 'host key changed', error: true })
    expect(startable(v)).toBe(false)
    expect(sessionsFailure(v, `${SSH} No route to host`)).toBe(v)
    expect(sessionsFailure({ kind: 'pending' }, `${SSH} Host key verification failed.`).kind).toBe('changed')
  })

  /** Y-585: tailnet machines reach Sessions and never the sweep, and the page
   *  must not say both *not checked* and *did not answer*. */
  it('takes a failure from the sessions where readiness holds nothing', () => {
    const sessionsError = `${SSH} Permission denied (publickey).`
    expect(verdict({ looked: 'never' }, { sessionsError })).toEqual({ kind: 'refused', detail: sessionsError })
    expect(verdict(report([]), { sessionsError })).toEqual({ kind: 'refused', detail: sessionsError })
    expect(verdict({ looked: 'never' }, { sessionsError: null })).toEqual({ kind: 'unasked' })
  })

  it('never takes an ssh failure from a tmux error', () => {
    expect(verdict({ looked: 'never' }, { sessionsError: TMUX })).toEqual({ kind: 'unasked' })
    expect(verdict(report([]), { sessionsError: TMUX })).toEqual({ kind: 'unasked' })
  })

  it('keeps a reachable check it holds over the sessions error', () => {
    const v = verdict(all(), { sessionsError: 'No route to host' })
    expect(v).toEqual({ kind: 'ready' })
  })

  it('never lets a sessions error outrank a machine the tailnet says is off', () => {
    const v = verdict({ looked: 'never' }, { machine: machine({ online: false }), sessionsError: 'No route to host' })
    expect(v).toEqual({ kind: 'asleep' })
  })

  it('gives Sessions the words Readiness has, or reads the error itself', () => {
    const refused = verdict(all({ reachable: 'absent' }, { reachable: 'Permission denied' }))
    const noRoute = `${SSH} No route to host`
    expect(sessionsFailure(refused, noRoute)).toBe(refused)
    expect(sessionsFailure(refused, TMUX)).toBe(refused)
    expect(sessionsFailure({ kind: 'asleep' }, noRoute)).toEqual({ kind: 'asleep' })
    expect(sessionsFailure({ kind: 'expired' }, noRoute)).toEqual({ kind: 'expired' })
    expect(sessionsFailure({ kind: 'ready' }, noRoute)).toEqual({ kind: 'unreachable', detail: noRoute })
    expect(sessionsFailure({ kind: 'pending' }, `${SSH} Tailscale SSH requires an additional check`).kind).toBe('browser')
  })

  it('reads a tmux error on a reached machine as a listing, not an ssh failure', () => {
    expect(sessionsFailure({ kind: 'ready' }, TMUX)).toEqual({ kind: 'listing', detail: TMUX })
    expect(sessionsFailure({ kind: 'unasked' }, TMUX)).toEqual({ kind: 'listing', detail: TMUX })
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

  /** Y-641: `ready` means what setup's `isReady` means, on the chip too. */
  it('says ready beside the optional fixes, and not while a session check is open', () => {
    const optional = verdict(all({ 'provider-auth': 'absent', hooks: 'absent' }))
    expect(optional).toMatchObject({ kind: 'manual', ready: true })
    expect(chipOf(optional, null)).toEqual({ state: 'done', word: 'ready · 2 to fix', error: false })

    const held = verdict(all({ 'login-session': 'absent', hooks: 'absent' }))
    expect(held).toMatchObject({ kind: 'manual', ready: false })
    expect(chipOf(held, null)).toEqual({ state: 'needs', word: '2 to fix', error: false })
  })

  it('does not say ready while a session check is unknown', () => {
    const v = verdict(all({ 'login-session': 'unknown' }))
    expect(v).toMatchObject({ kind: 'manual', ready: false })
    expect(chipOf(v, null).word).toBe('1 to fix')
  })

  /** Y-619: the account is signed in; the Mac has no login tmux server. */
  it('names the missing login tmux server, not a sign-out, for one check', () => {
    const v = verdict(all({ 'login-session': 'absent' }, { 'login-session': NO_SERVER }))
    expect(titleOf(v, 'mbp')).toBe('No tmux server from a login on mbp')
  })

  it('gives one title when both keychain checks miss the login tmux server', () => {
    const v = verdict(
      all({ 'login-session': 'absent', 'provider-auth': 'absent' }, { 'login-session': NO_SERVER, 'provider-auth': NO_SERVER }),
    )
    expect(titleOf(v, 'mbp')).toBe('No tmux server from a login on mbp')
  })

  it('still says claude is not signed in where claude finds no credential', () => {
    const v = verdict(all({ 'login-session': 'absent' }, { 'login-session': 'claude finds no credential where the agent will run (method: none)' }))
    expect(titleOf(v, 'pi')).toBe('claude is not signed in')
    const two = verdict(all({ 'login-session': 'absent', 'provider-auth': 'absent' }, { 'login-session': NO_SERVER }))
    expect(titleOf(two, 'pi')).toBe('2 checks need you')
  })

  /** Y-591: macOS guarding Desktop, Documents and Downloads is a warning. */
  it('lets a session start on a Mac that blocks the guarded folders', () => {
    const v = verdict(all({ 'folder-access': 'absent' }))
    expect(v.kind).toBe('manual')
    expect(titleOf(v, 'pi')).toBe('macOS blocks Desktop, Documents and Downloads')
    expect(startable(v)).toBe(true)
  })

  /** Y-640: the agent starts, and only the hook fails, so it is a warning. */
  it('lets a session start where a hook cannot run', () => {
    const v = verdict(all({ hooks: 'absent' }))
    expect(v.kind).toBe('manual')
    expect(titleOf(v, 'mbp')).toBe('a hook cannot run')
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

  /** A microphone install that stopped without a sudo step is not ready: it
   *  names the microphone and carries the answer that says why. */
  it.each([
    ['a command that needs no sudo', ['systemctl --user restart pipewire']],
    ['no command at all', []],
  ])('says the microphone is missing when the install stopped with %s', (_, commands) => {
    const watch = { since: 10, pressed: 0, mic: true }
    const answer = stopped(20, commands)
    const v = verdict(withMic('absent'), { watch, events: [answer] })
    expect(v).toEqual({ kind: 'missing', missing: ['microphone'], result: answer, fresh: true })
    expect(titleOf(v, 'pi')).toBe('microphone is missing')
    expect(startable(v)).toBe(false)
  })

  it('says the microphone is missing when an install that asked for it finished without it', () => {
    const watch = { since: 10, pressed: 0, mic: true }
    const done: Event = { ...stopped(20, []), kind: 'installed', said: 'pi: mic installed' }
    expect(verdict(withMic('absent'), { watch, events: [done] })).toMatchObject({ kind: 'missing', missing: ['microphone'] })
    expect(verdict(withMic('present'), { watch, events: [done] }).kind).toBe('ready')
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
