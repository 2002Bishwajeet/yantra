import type {
  Check,
  CheckState,
  Machine,
  MachineSessions,
  Readiness,
  Session,
  Workspace,
} from '@/api'
import { blocking } from '@/lib/ready'
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

/** D7 §3.3, for the grid card's chip. A closed lid is asleep, not failed —
 *  only a machine that answered and then failed gets the error tone. */
export type CardVerdict =
  | { kind: 'asleep' }
  | { kind: 'expired' }
  | { kind: 'unchecked' }
  | { kind: 'failed' }
  | { kind: 'needs'; missing: number }
  | { kind: 'ready' }

export function cardVerdict(machine: Machine, checks: Check[]): CardVerdict {
  if (machine.expired) return { kind: 'expired' }
  if (!machine.online) return { kind: 'asleep' }
  if (checks.length === 0) return { kind: 'unchecked' }
  if (checkNamed(checks, 'reachable')?.state === 'absent') return { kind: 'failed' }
  const missing = blocking({ machine: machine.name, checks })
  return missing.length > 0 ? { kind: 'needs', missing: missing.length } : { kind: 'ready' }
}

/** The chip's mark, word and tone. `seen` is the machine's last-seen text,
 *  already formatted by the caller's one clock (D3 §5.7). */
export function cardChip(verdict: CardVerdict, seen: string | null): { state: MarkState; word: string; error: boolean } {
  switch (verdict.kind) {
    case 'asleep':
      return { state: 'unknown', word: seen ? `asleep · ${seen}` : 'asleep', error: false }
    case 'expired':
      return { state: 'failed', word: 'key expired', error: true }
    case 'unchecked':
      return { state: 'idle', word: 'not checked', error: false }
    case 'failed':
      return { state: 'failed', word: 'key refused', error: true }
    case 'needs':
      return { state: 'needs', word: `${verdict.missing} missing`, error: false }
    case 'ready':
      return { state: 'done', word: 'ready', error: false }
  }
}

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
