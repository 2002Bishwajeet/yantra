import type {
  Check,
  CheckState,
  Machine,
  MachineSessions,
  Readiness,
  Session,
  Workspace,
} from '@/api'
import type { MarkState } from '@/m3/mark/Mark'

/** The four a machine card draws; the machine page draws all nine. */
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

export type Tally = { present: number; absent: number; unknown: number; total: number }

export function tally(checks: Check[]): Tally {
  const count = (state: CheckState) => checks.filter((one) => one.state === state).length
  return {
    present: count('present'),
    absent: count('absent'),
    unknown: count('unknown'),
    total: checks.length,
  }
}

/** The card's summary line, which is the phone board's condensed check block. */
export function summary(one: Tally): string {
  if (one.total === 0) return 'not asked yet'
  if (one.absent === 0 && one.unknown === 0) return `${one.present} of ${one.total} checks`
  const said = []
  if (one.absent > 0) said.push(`${one.absent} failing`)
  if (one.unknown > 0) said.push(`${one.unknown} unknown`)
  return said.join(' · ')
}

/** Mark plus word for the machine itself. `expired` is Tailscale's key, which
 *  is a reason it cannot be reached rather than a fourth state. */
export function machineState(machine: Machine): { state: MarkState; word: string } {
  if (machine.expired) return { state: 'failed', word: 'key expired' }
  return machine.online
    ? { state: 'running', word: 'online' }
    : { state: 'failed', word: 'unreachable' }
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
