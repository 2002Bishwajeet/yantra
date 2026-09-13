import type { About, Check, Machine, Readiness } from '@/api'
import { asApiError } from '@/api/errors'
import { blocking } from '@/lib/ready'
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
export const failed = (error: Error): Step => {
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

/** D7 §4.1 step 2: a machine has joined. The key is a line under it, since
 *  the first join makes it (ADR-0029). `unkeyed` is a machine ssh reaches
 *  with no key made, so through the account's own keys and not Yantra's. */
export function added(joined: string[], unkeyed: string[] = []): Step {
  if (joined.length > 0) return { status: 'done', words: `${joined.join(', ')} joined` }
  if (unkeyed.length > 0) {
    return {
      status: 'todo',
      words: `${unkeyed.join(', ')} reached without Yantra's key · run the join command on ${unkeyed.length === 1 ? 'it' : 'each'} once`,
    }
  }
  return { status: 'todo', words: 'no machine has joined yet · Add a device shows the steps' }
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

/** ADR-0021: a relay saved in Settings reaches the daemon at its next start,
 *  so `relay` is what a push uses now and not what was last saved. */
export function push(about: Asked<About>): Step {
  if (about.error) return failed(about.error)
  if (about.isPending || !about.data) return reading()
  if (about.data.relay) return { status: 'done', words: 'the daemon holds a relay and pushes to it' }
  return { status: 'todo', words: 'no relay yet · one saved in Settings is used after yantrad restarts' }
}

/** What a machine's checks say, in the board's words. Off is `asleep`, which
 *  is normal and never an error (D7 §3.3). */
export type Line =
  | { kind: 'asleep'; since: string | null }
  | { kind: 'unreachable'; words: string }
  | { kind: 'unchecked' }
  | { kind: 'refused' }
  | { kind: 'ready'; present: number; total: number }
  | { kind: 'missing'; present: number; total: number; words: string; installable: boolean }

const named: Record<string, string> = {
  sshd: 'sshd',
  tmux: 'tmux',
  git: 'git',
  'agent-cli': 'claude',
  terminfo: 'terminfo',
  'provider-cli': 'gh',
  'provider-auth': 'gh signed in',
  'login-session': 'login session held',
  heartbeat: 'a heartbeat',
  reachable: 'ssh',
}

export const word = (check: string) => named[check] ?? check

/** What Install puts there (ADR-0028 §1). A person fixes the rest on the
 *  machine itself (D7 §3.5). */
export const INSTALLED: readonly string[] = ['tmux', 'git', 'agent-cli']

/** The checks that hold ready back, in the board's words. */
export function lacking(needs: Check[]): string {
  const absent = needs.filter((one) => one.state === 'absent').map((one) => word(one.check))
  const unknown = needs.filter((one) => one.state !== 'absent').map((one) => word(one.check))
  return [absent.length ? `missing ${absent.join(', ')}` : '', unknown.length ? `could not ask about ${unknown.join(', ')}` : '']
    .filter(Boolean)
    .join(' · ')
}

export function line(machine: Machine, report: Readiness | null, since: string | null): Line {
  if (!machine.online) return { kind: 'asleep', since }
  if (!report) return { kind: 'unchecked' }
  const reachable = report.checks.find((one) => one.check === 'reachable')
  if (reachable && reachable.state !== 'present') {
    if (/permission denied/i.test(reachable.detail)) return { kind: 'refused' }
    return { kind: 'unreachable', words: `ssh did not answer · ${reachable.detail}` }
  }
  const present = report.checks.filter((one) => one.state === 'present').length
  const total = report.checks.length
  const needs = blocking(report)
  if (needs.length === 0) return { kind: 'ready', present, total }
  const installable = needs.some((one) => INSTALLED.includes(one.check) && one.state === 'absent')
  return { kind: 'missing', present, total, words: lacking(needs), installable }
}

export const ready = (one: Line) => one.kind === 'ready'

/** D7 §4.1 step 3: done at one ready machine, since an asleep laptop does not
 *  hold back a first session (walk-through Q2.3). */
export function machines(lines: { machine: string; line: Line }[]): Step {
  if (lines.length === 0) return { status: 'todo', words: 'this tailnet lists no machine that runs Linux or macOS' }
  const checked = lines.filter((one) => one.line.kind !== 'unchecked')
  if (checked.length === 0) return { status: 'todo', words: 'not checked yet · Check asks a machine over ssh' }
  const done = lines.filter((one) => ready(one.line)).length
  if (done === 0) {
    return { status: 'progress', words: `0 of ${lines.length} machines ready · one ready machine finishes this step` }
  }
  return {
    status: 'done',
    words: `${done} of ${lines.length} machines ready${done < lines.length ? ' · one is enough to start' : ''}`,
  }
}

/** Done once a workspace exists, which is what a first session starts from. */
export function firstSession(workspaces: number | null, ready: number): Step {
  if (workspaces) return { status: 'done', words: `${workspaces} workspace${workspaces === 1 ? '' : 's'} made` }
  return { status: 'todo', words: `needs one ready machine, you have ${ready === 0 ? 'none yet' : ready}` }
}
