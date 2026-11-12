import type { Check, CheckState, Event, Machine, Readiness } from '@/api'
import type { Reading } from '@/api/client'
import { answerFailure, INSTALLABLE, nameOf, noLoginServer, olderAgent, reachableFailure, unrunnable } from '@/lib/checks'
import { blocking, isReady, missingBasics } from '@/lib/ready'
import type { MarkState } from '@/m3/mark/Mark'
import { answer, listed, needsSudo, newestInstall, type Watch } from './install'

/** D7 §4.3: what the Readiness card says, which decides its one action. */
export type Verdict =
  | { kind: 'pending' }
  | { kind: 'asleep' }
  | { kind: 'expired' }
  | { kind: 'unasked' }
  | { kind: 'unread'; error: string }
  | { kind: 'installing'; missing: string[] }
  | { kind: 'refused'; detail: string }
  | { kind: 'unjoined'; detail: string }
  | { kind: 'browser'; detail: string }
  | { kind: 'changed'; detail: string }
  | { kind: 'unreachable'; detail: string }
  /** `unrunnable`: those of `missing` that are there, but this account cannot run them (Y-740). */
  | { kind: 'sudo'; missing: string[]; result: Event; unrunnable?: string[] }
  | { kind: 'missing'; missing: string[]; result: Event | null; fresh: boolean; unrunnable?: string[] }
  | { kind: 'manual'; absent: Check[]; ready: boolean }
  | { kind: 'ready' }

const BASIC = new Set(INSTALLABLE)

export function verdictOf(input: {
  name: string
  machine: Machine | undefined
  readiness: Reading<Readiness>
  events: Event[]
  watch: Watch | null
  /** This machine's answer in the sessions reading, if it did not answer. */
  sessionsError?: string | null
}): Verdict {
  const { name, machine, readiness, events, watch, sessionsError } = input
  // D7 §3.3: the tailnet says it is off, so nothing behind ssh can be asked.
  if (machine?.expired) return { kind: 'expired' }
  if (machine && !machine.online) return { kind: 'asleep' }
  if (readiness.looked === 'pending') return { kind: 'pending' }
  if (readiness.looked === 'failed') return { kind: 'unread', error: readiness.error }
  if (readiness.looked === 'never' || readiness.data.checks.length === 0) {
    // The sweep skips a machine no workspace names, and Sessions asks it anyway.
    // A tmux error says nothing about ssh, so it leaves the machine unasked.
    if (!sessionsError) return { kind: 'unasked' }
    const kind = answerFailure(sessionsError)
    return kind === 'listing' ? { kind: 'unasked' } : { kind, detail: sessionsError }
  }

  const { checks } = readiness.data
  const basics = missingBasics(readiness.data)
  const missing = basics.map((one) => nameOf(one.check))
  const fresh = watch ? answer(events, name, watch) : null
  if (watch && !fresh) return { kind: 'installing', missing }

  const reachable = checks.find((one) => one.check === 'reachable')
  if (reachable?.state === 'absent') {
    return { kind: reachableFailure(reachable.detail), detail: reachable.detail }
  }

  // Only an answer to this page's press: an older one may name a step a
  // person has since run by hand.
  const stopped = fresh?.kind === 'install_stopped' ? fresh : null
  if (missing.length > 0) {
    const closed = basics.filter(unrunnable).map((one) => nameOf(one.check))
    const installed = closed.length > 0 ? { unrunnable: closed } : {}
    if (stopped?.commands.some(needsSudo)) return { kind: 'sudo', missing, result: stopped, ...installed }
    return { kind: 'missing', missing, result: fresh ?? newestInstall(events, name) ?? null, fresh: fresh !== null, ...installed }
  }

  // ADR-0031 §1–2: with every basic there, a sudo step this press stopped is the
  // microphone's, until doctor finds the microphone.
  const mic = checks.find((one) => one.check === 'mic')
  if (watch?.mic && stopped?.commands.some(needsSudo) && mic?.state !== 'present') {
    return { kind: 'sudo', missing: [nameOf('mic')], result: stopped }
  }
  // A press that asked for the microphone and answered without it says so.
  if (watch?.mic && fresh && mic?.state !== 'present') {
    return { kind: 'missing', missing: [nameOf('mic')], result: fresh, fresh: true }
  }

  // ADR-0031 §9: the microphone is optional, so its absence never titles the card.
  const absent = checks.filter((one) => one.state === 'absent' && !BASIC.has(one.check) && one.check !== 'mic')
  // `ready` means `isReady` on every screen, so a session check that is
  // absent or unknown holds it back, and an optional one (gh, hooks) does not.
  const ready = isReady(readiness.data)
  if (ready && absent.length === 0) return { kind: 'ready' }
  const held = blocking(readiness.data).filter((one) => !absent.some((other) => other.check === one.check))
  return { kind: 'manual', absent: [...absent, ...held], ready }
}

const NOT_REACHED: ReadonlySet<Verdict['kind']> = new Set([
  'asleep',
  'expired',
  'refused',
  'unjoined',
  'browser',
  'changed',
  'unreachable',
])

/** Sessions' answer when ssh got in and the listing failed (Y-585). */
export type SessionsFailure = Verdict | { kind: 'listing'; detail: string }

/** What Sessions says for a machine that did not answer: Readiness's verdict
 *  where that failed too, so the two cards agree, or else its own error. */
export const sessionsFailure = (verdict: Verdict, error: string): SessionsFailure =>
  NOT_REACHED.has(verdict.kind) ? verdict : { kind: answerFailure(error), detail: error }

/** A session can start: tmux and claude are there and ssh gets in. A missing
 *  `gh` does not stop one, so `manual` counts (B3 names only the basics and the
 *  key). */
export const startable = (verdict: Verdict) => verdict.kind === 'ready' || verdict.kind === 'manual'

function missingTitle(check: Check, name: string): string {
  if (noLoginServer(check.detail)) return `No tmux server from a login on ${name}`
  if (check.check === 'provider-auth') return 'gh is not signed in'
  if (check.check === 'login-session') return 'claude is not signed in'
  if (check.check === 'folder-access') return 'macOS blocks Desktop, Documents and Downloads'
  if (check.check === 'hooks') return 'a hook cannot run'
  if (check.check === 'no-sudo') return 'The joined account can use sudo'
  const older = olderAgent(check)
  if (older) {
    return older.agent
      ? `yantra-agent on ${name} is v${older.agent}; yantrad is v${older.daemon}`
      : `yantra-agent on ${name} is older than yantrad v${older.daemon}`
  }
  return `${nameOf(check.check)} is missing`
}

const be = (names: string[], one: string, many: string) => (names.length === 1 ? one : many)

export function titleOf(verdict: Verdict, name: string): string {
  switch (verdict.kind) {
    case 'pending':
      return 'Reading the checks…'
    case 'asleep':
      return `${name} is asleep`
    case 'expired':
      return `${name}’s Tailscale key expired`
    case 'unasked':
      return 'Not checked yet'
    case 'unread':
      return 'The checks could not be read'
    case 'installing':
      return verdict.missing.length ? `Installing ${listed(verdict.missing)}` : `Installing on ${name}`
    case 'refused':
      return 'The key was refused'
    case 'unjoined':
      return `${name} has not joined`
    case 'browser':
      return `${name} needs a browser sign-in`
    case 'changed':
      return `${name}’s host key changed`
    case 'unreachable':
      return `ssh to ${name} fails`
    case 'sudo':
      return `${listed(verdict.missing)} ${be(verdict.missing, 'needs', 'need')} your password`
    case 'missing': {
      const closed = verdict.unrunnable ?? []
      const absent = verdict.missing.filter((one) => !closed.includes(one))
      if (closed.length === 0) return `${listed(absent)} ${be(absent, 'is', 'are')} missing`
      if (absent.length === 0) return `${listed(closed)} is installed, but this account cannot run it`
      return `${listed(absent)} ${be(absent, 'is', 'are')} missing, and this account cannot run ${listed(closed)}`
    }
    case 'manual':
      // Both keychain checks miss one server on a Mac, and one command fixes both.
      return verdict.absent.length === 1 || verdict.absent.every((one) => noLoginServer(one.detail))
        ? missingTitle(verdict.absent[0]!, name)
        : `${verdict.absent.length} checks need you`
    case 'ready':
      return 'Ready for sessions'
  }
}

/** D7 §3.3's chip. Error tone is for a machine that is on and failing. */
export function chipOf(verdict: Verdict, lastSeen: string | null): { state: MarkState; word: string; error: boolean } {
  switch (verdict.kind) {
    case 'asleep':
      return { state: 'unknown', word: lastSeen ? `asleep · ${lastSeen}` : 'asleep', error: false }
    case 'expired':
      return { state: 'failed', word: 'key expired', error: true }
    case 'refused':
      return { state: 'failed', word: 'key refused', error: true }
    case 'unjoined':
      return { state: 'failed', word: 'not joined', error: true }
    case 'browser':
      return { state: 'failed', word: 'browser sign-in', error: true }
    case 'changed':
      return { state: 'failed', word: 'host key changed', error: true }
    case 'unreachable':
      return { state: 'failed', word: 'ssh failing', error: true }
    case 'installing':
      return { state: 'running', word: 'installing', error: false }
    case 'sudo':
    case 'missing':
      // Y-740: a tool that is there is not missing, and Install is still what fixes it.
      return { state: 'needs', word: `${verdict.missing.length} ${verdict.unrunnable ? 'to install' : 'missing'}`, error: false }
    case 'manual':
      return verdict.ready
        ? { state: 'done', word: `ready · ${verdict.absent.length} to fix`, error: false }
        : { state: 'needs', word: `${verdict.absent.length} to fix`, error: false }
    case 'ready':
      return { state: 'done', word: 'ready', error: false }
    default:
      return { state: 'idle', word: 'not checked', error: false }
  }
}

/** The hero's tint: the verdict's tone, so the state reads before the title does. Amber, never green, for what needs the owner. */
export function surfaceOf(verdict: Verdict): 'primary' | 'secondary' | 'error' | 'high' {
  const { state, error } = chipOf(verdict, null)
  if (error) return 'error'
  if (state === 'done') return 'primary'
  return state === 'needs' ? 'secondary' : 'high'
}

const order: Record<CheckState, number> = { absent: 0, unknown: 1, present: 2 }

/** Missing first, so the line that says what to do is the first one read. */
export const sorted = (checks: Check[]) => checks.toSorted((a, b) => order[a.state] - order[b.state])
