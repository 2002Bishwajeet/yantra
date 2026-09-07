import type { About, Check, Machine, Readiness, SshIdentity } from '@/api'
import { asApiError } from '@/api/errors'
import type { MarkState } from '@/m3/mark/Mark'

/** Query's three states, as this screen reads them: nothing more of the
 *  result than a step needs. */
export type Asked<T> = { data: T | undefined; error: Error | null; isPending: boolean }

export type Status = 'done' | 'progress' | 'todo' | 'failed'

export type Step = { status: Status; words: string }

export const marks: Record<Status, MarkState> = {
  done: 'done',
  progress: 'running',
  todo: 'idle',
  failed: 'failed',
}

export const statusWord: Record<Status, string> = {
  done: 'done',
  progress: 'in progress',
  todo: 'not yet',
  failed: 'could not be read',
}

const reading = (): Step => ({ status: 'todo', words: 'reading…' })
const failed = (error: Error): Step => {
  const said = asApiError(error)
  return { status: 'failed', words: `${said.describe()} · ${said.said}` }
}

export function tailnet(about: Asked<About>, protocol: string): Step {
  if (about.error) return failed(about.error)
  if (about.isPending || !about.data) return reading()
  if (about.data.tailnet === null) {
    return { status: 'todo', words: 'the daemon has not read the tailnet yet' }
  }
  return {
    status: 'done',
    words: `${about.data.tailnet}, reached over ${protocol === 'https:' ? 'HTTPS' : 'HTTP'}`,
  }
}

/** A 404 is a key not made, which is the daemon's own reading (api.ts). */
export function sshKey(identity: Asked<SshIdentity>): Step {
  if (identity.error && asApiError(identity.error).kind === 'missing') {
    return { status: 'todo', words: 'not created yet · run `yantra ssh-identity` on the appliance' }
  }
  if (identity.error) return failed(identity.error)
  if (identity.isPending || !identity.data) return reading()
  return { status: 'done', words: `created on the appliance · ${identity.data.fingerprint}` }
}

/** The grant, read as narrowly as this step needs it: the api layer still
 *  types `/api/github` without `pending`, and the daemon sends it. */
type Grant = { connected: boolean; login: string | null; pending?: boolean }

export function github(connection: Asked<Grant>): Step {
  if (connection.error) return failed(connection.error)
  if (connection.isPending || !connection.data) return reading()
  if (connection.data.connected) {
    return { status: 'done', words: `signed in as ${connection.data.login ?? 'an account not yet read'} on the appliance` }
  }
  if (connection.data.pending) return { status: 'progress', words: 'a sign-in is waiting at github.com' }
  return { status: 'todo', words: 'not connected · reviews, issues and repositories come through it' }
}

/** What a machine's checks say, in the board's words. */
export type Line =
  | { kind: 'unreachable'; words: string }
  | { kind: 'unchecked' }
  | { kind: 'refused' }
  | { kind: 'ready'; present: number; total: number; words: string }
  | { kind: 'missing'; present: number; total: number; words: string }

const named: Record<string, string> = {
  sshd: 'sshd',
  tmux: 'tmux',
  'agent-cli': 'claude',
  terminfo: 'terminfo',
  'provider-cli': 'gh',
  'provider-auth': 'gh signed in',
  'login-session': 'login session held',
  heartbeat: 'a heartbeat',
  reachable: 'ssh',
}

const word = (check: Check) => named[check.check] ?? check.check

export function line(machine: Machine, report: Readiness | null, since: string | null): Line {
  if (!machine.online) {
    return {
      kind: 'unreachable',
      words: `unreachable${since ? ` · last seen ${since} ago` : ''} · nothing behind ssh could be asked`,
    }
  }
  if (!report) return { kind: 'unchecked' }
  const reachable = report.checks.find((one) => one.check === 'reachable')
  if (reachable && reachable.state !== 'present') {
    if (/permission denied/i.test(reachable.detail)) return { kind: 'refused' }
    return { kind: 'unreachable', words: `unreachable · ${reachable.detail}` }
  }
  const present = report.checks.filter((one) => one.state === 'present')
  const total = report.checks.length
  if (present.length === total) {
    const listed = present.filter((one) => ['sshd', 'tmux', 'agent-cli', 'terminfo', 'provider-auth'].includes(one.check))
    return { kind: 'ready', present: present.length, total, words: listed.map(word).join(', ') }
  }
  const absent = report.checks.filter((one) => one.state === 'absent').map(word)
  const unknown = report.checks.filter((one) => one.state === 'unknown').map(word)
  const words = [
    absent.length ? `missing ${absent.join(', ')}` : '',
    unknown.length ? `could not ask about ${unknown.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return { kind: 'missing', present: present.length, total, words }
}

export const ready = (one: Line) => one.kind === 'ready'

export function machines(lines: { machine: string; line: Line }[]): Step {
  if (lines.length === 0) return { status: 'todo', words: 'this tailnet lists no machine, so there is nothing to check' }
  const checked = lines.filter((one) => one.line.kind !== 'unchecked')
  if (checked.length === 0) return { status: 'todo', words: 'not checked yet · Check asks a machine over ssh' }
  const done = lines.filter((one) => ready(one.line))
  const not = lines.filter((one) => !ready(one.line)).map((one) => one.machine)
  if (done.length === lines.length) return { status: 'done', words: `${done.length} of ${lines.length} machines ready` }
  return {
    status: 'progress',
    words: `${done.length} of ${lines.length} machines ready · ${not.join(', ')} ${not.length === 1 ? 'does' : 'do'} not yet`,
  }
}

/** The remedy for a refused key: the board's line, with the real key in it. */
export const remedy = (publicKey: string) => `echo '${publicKey}' >> ~/.ssh/authorized_keys`
