import type {
  Check,
  CheckState,
  Machine,
  MachineSessions,
  Readiness,
  Session,
  Workspace,
} from '@/api'
import { olderAgent, sessionNeeds, unrunnable } from '@/lib/checks'
import type { MarkState } from '@/m3/mark/Mark'

/** The four a machine card draws; the machine page draws all ten. */
export const CARD_CHECKS = ['reachable', 'tmux', 'agent-cli', 'terminfo']

const marks: Record<CheckState, MarkState> = {
  present: 'done',
  absent: 'failed',
  unknown: 'unknown',
}

// `unknown` is a question that could not be asked, never a shade of `absent`
// (api.ts) — the two send a reader to different places.
const words: Record<CheckState, string> = {
  present: 'ok',
  absent: 'missing',
  unknown: 'unknown',
}

export const markOf = (state: CheckState): MarkState => marks[state]
export const wordOf = (state: CheckState): string => words[state]

/** ADR-0031 §9: a microphone that is not installed is no fault. */
export const optionalAbsent = (check: Check) => check.check === 'mic' && check.state === 'absent'

export type Tally = { present: number; absent: number; unknown: number; total: number }

/** The count covers the checks drawn, so its total is the row count. An absent
 *  microphone is a row but not a failure, so the summary never calls it one. */
export function tally(checks: Check[]): Tally {
  const count = (state: CheckState) => checks.filter((one) => one.state === state).length
  return {
    present: count('present'),
    absent: checks.filter((one) => one.state === 'absent' && !optionalAbsent(one)).length,
    unknown: count('unknown'),
    total: checks.length,
  }
}

/** A check the chip counts under "to fix" and the title counts as needing you:
 *  an absent one, or a session check that could not be asked. */
export const toFix = (check: Check): boolean =>
  check.state === 'absent' ? !optionalAbsent(check) : check.state === 'unknown' && sessionNeeds(check.check)

/** The mark of a row on the machine page: `needs` exactly when `toFix` counts it. */
export const rowMark = (check: Check): MarkState =>
  optionalAbsent(check) ? 'idle' : toFix(check) ? 'needs' : check.state === 'present' ? 'done' : 'unknown'

/** A binary or a terminfo entry: the only checks whose absence means nothing is there. */
const CAN_BE_MISSING = ['tmux', 'git', 'agent-cli', 'provider-cli', 'terminfo']

export function rowWord(check: Check): string {
  if (check.state !== 'absent') return wordOf(check.state)
  if (optionalAbsent(check)) return 'optional'
  // Y-713, Y-740: each of these is installed, so *missing* would be false.
  if (olderAgent(check)) return 'behind'
  // No beat says only that nothing arrived, not that the agent is absent.
  if (check.check === 'heartbeat') return 'silent'
  if (unrunnable(check)) return 'closed'
  if (check.check === 'folder-access') return 'blocked'
  // A sign-in, the hooks or sudo is a fault in something installed, so it takes the chip's word.
  return CAN_BE_MISSING.includes(check.check) ? wordOf('absent') : 'to fix'
}

/** The count the card and the Readiness card both print. */
export const counted = (one: Tally) => `${one.present} of ${one.total}`

/** The card's summary line, which is the phone board's condensed check block. */
export function summary(one: Tally): string {
  if (one.total === 0) return 'not checked'
  const said = [counted(one)]
  if (one.absent > 0) said.push(`${one.absent} failing`)
  if (one.unknown > 0) said.push(`${one.unknown} unknown`)
  return said.join(' · ')
}

/** Mark plus word for the machine itself. `expired` is Tailscale's key, which
 *  is a reason it cannot be reached rather than a fourth state. */
export function machineState(machine: Machine): { state: MarkState; word: string } {
  if (machine.expired) return { state: 'failed', word: 'key expired' }
  if (machine.control_lost) return { state: 'running', word: 'online · control link lost' }
  return machine.online
    ? { state: 'running', word: 'online' }
    : { state: 'failed', word: 'unreachable' }
}

/** Megabytes as gigabytes, to one decimal below ten. */
export const gb = (mb: number) => {
  const size = mb / 1024
  return size >= 10 ? Math.round(size).toString() : size.toFixed(1)
}

/** The facts line of a card. A machine with no heartbeat says its OS and
 *  nothing else: no zeros for numbers nobody sent (I-47). `sessions` is null
 *  when the machine did not answer. */
export function factsOf(machine: Machine, sessions: number | null): string {
  const beat = machine.heartbeat
  const parts: string[] = [machine.os]
  if (beat) {
    parts.push(
      beat.arch,
      `CPU ${beat.cpu_busy_pct}% busy`,
      `${gb(beat.free_ram_mb)} GB memory free`,
      `${gb(beat.free_disk_mb)} GB disk free`,
    )
  }
  if (sessions !== null) parts.push(sessions === 0 ? 'no sessions' : `${sessions} session${sessions === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

export const checksOf = (readiness: Readiness[], machine: string): Check[] =>
  readiness.find((one) => one.machine === machine)?.checks ?? []

export const checkNamed = (checks: Check[], name: string): Check | undefined =>
  checks.find((one) => one.check === name)

export type Held = { machine: string; session: Session }

/** A tmux session no workspace on that machine claims (ADR-0022). D6 §4.3
 *  gives it Attach and Kill and never Adopt: its repo is not on the wire, so
 *  a workspace for it starts at New session. */
export function unclaimed(
  sessions: MachineSessions[],
  workspaces: Workspace[],
): Held[] {
  const claimed = new Set(workspaces.map((one) => `${one.machine} ${one.name}`))
  return sessions.flatMap((answer) =>
    answer.reached === 'yes'
      ? answer.sessions
          .filter((session) => !claimed.has(`${answer.machine} ${session.name}`))
          .map((session) => ({ machine: answer.machine, session }))
      : [],
  )
}
