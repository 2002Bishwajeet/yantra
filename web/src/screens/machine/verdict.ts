import type { Check, CheckState, Event, Machine, Readiness } from '@/api'
import type { Reading } from '@/api/client'
import { nameOf } from '@/lib/checks'
import type { MarkState } from '@/m3/mark/Mark'
import { answer, listed, missingBasics, needsSudo, newestInstall, type Watch } from './install'

/** D7 §4.3: what the Readiness card says, which decides its one action. */
export type Verdict =
  | { kind: 'pending' }
  | { kind: 'asleep' }
  | { kind: 'expired' }
  | { kind: 'unasked' }
  | { kind: 'unread'; error: string }
  | { kind: 'installing'; missing: string[] }
  | { kind: 'refused'; detail: string }
  | { kind: 'unreachable'; detail: string }
  | { kind: 'sudo'; missing: string[]; result: Event }
  | { kind: 'missing'; missing: string[]; result: Event | null; fresh: boolean }
  | { kind: 'manual'; absent: Check[] }
  | { kind: 'ready' }

const BASIC = new Set(['tmux', 'git', 'agent-cli'])

export function verdictOf(input: {
  name: string
  machine: Machine | undefined
  readiness: Reading<Readiness>
  events: Event[]
  watch: Watch | null
}): Verdict {
  const { name, machine, readiness, events, watch } = input
  // D7 §3.3: the tailnet says it is off, so nothing behind ssh can be asked.
  if (machine?.expired) return { kind: 'expired' }
  if (machine && !machine.online) return { kind: 'asleep' }
  if (readiness.looked === 'pending') return { kind: 'pending' }
  if (readiness.looked === 'failed') return { kind: 'unread', error: readiness.error }
  if (readiness.looked === 'never' || readiness.data.checks.length === 0) return { kind: 'unasked' }

  const { checks } = readiness.data
  const missing = missingBasics(checks)
  const fresh = watch ? answer(events, name, watch) : null
  if (watch && !fresh) return { kind: 'installing', missing }

  const reachable = checks.find((one) => one.check === 'reachable')
  if (reachable?.state === 'absent') {
    return /permission denied/i.test(reachable.detail)
      ? { kind: 'refused', detail: reachable.detail }
      : { kind: 'unreachable', detail: reachable.detail }
  }

  if (missing.length > 0) {
    // Only an answer to this page's press: an older one may name a step a
    // person has since run by hand.
    if (fresh?.kind === 'install_stopped' && fresh.commands.some(needsSudo)) {
      return { kind: 'sudo', missing, result: fresh }
    }
    return { kind: 'missing', missing, result: fresh ?? newestInstall(events, name) ?? null, fresh: fresh !== null }
  }

  const absent = checks.filter((one) => one.state === 'absent' && !BASIC.has(one.check))
  return absent.length > 0 ? { kind: 'manual', absent } : { kind: 'ready' }
}

/** A session can start: tmux and claude are there and ssh gets in. A missing
 *  `gh` does not stop one, so `manual` counts (B3 names only the basics and the
 *  key). */
export const startable = (verdict: Verdict) => verdict.kind === 'ready' || verdict.kind === 'manual'

function missingTitle(check: Check): string {
  if (check.check === 'provider-auth') return 'gh is not signed in'
  if (check.check === 'login-session') return 'claude is not signed in'
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
    case 'unreachable':
      return `ssh to ${name} fails`
    case 'sudo':
      return `${listed(verdict.missing)} ${be(verdict.missing, 'needs', 'need')} your password`
    case 'missing':
      return `${listed(verdict.missing)} ${be(verdict.missing, 'is', 'are')} missing`
    case 'manual':
      return verdict.absent.length === 1 ? missingTitle(verdict.absent[0]!) : `${verdict.absent.length} checks need you`
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
    case 'unreachable':
      return { state: 'failed', word: 'ssh failing', error: true }
    case 'installing':
      return { state: 'running', word: 'installing', error: false }
    case 'sudo':
    case 'missing':
      return { state: 'needs', word: `${verdict.missing.length} missing`, error: false }
    case 'manual':
      return { state: 'needs', word: `${verdict.absent.length} to fix`, error: false }
    case 'ready':
      return { state: 'done', word: 'ready', error: false }
    default:
      return { state: 'idle', word: 'not checked', error: false }
  }
}

const order: Record<CheckState, number> = { absent: 0, unknown: 1, present: 2 }

/** Missing first, so the line that says what to do is the first one read. */
export const sorted = (checks: Check[]) => checks.toSorted((a, b) => order[a.state] - order[b.state])
