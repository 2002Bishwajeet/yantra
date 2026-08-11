import type {
  Listed,
  MachineSessions,
  Session,
  Workspace,
  WorkspaceStatus,
} from '@/api'
import type { Reading } from '@/useLooked'
import type { AgentRow } from '@/columns'

/** D3 §4: who must act next — you, the agent, nobody. `unknown` is the fourth
 *  and D3 does not name it: a workspace the agent class answered 404 for (Y-084)
 *  has no state at all, and filing it under any of the three would be a guess
 *  painted as knowledge (R-23). It is almost always empty. */
export type Band = 'needs' | 'running' | 'idle' | 'unknown'

export const BANDS = [
  { band: 'needs', title: 'Needs you' },
  { band: 'running', title: 'Running' },
  { band: 'idle', title: 'Idle' },
  { band: 'unknown', title: 'Not read yet' },
] as const satisfies { band: Band; title: string }[]

export type WorkRow = { id: string; band: Band } & (
  | { kind: 'workspace'; workspace: Workspace; status: WorkspaceStatus | null }
  | { kind: 'machine'; machine: string; workspaces: number; error: string }
  | { kind: 'unusable'; name: string; error: string }
)

/** §4.1's table. A group heading is not a state: a `finished` row still says
 *  *finished* inside Idle, and `no_agent` sits in Running because its session is
 *  live rather than because an agent works in it. */
function bandOf(status: WorkspaceStatus | null): Band {
  if (!status) return 'unknown'
  // Rolled up into one machine row below, so no workspace row reaches this —
  // it is still the band the machine's own row lands in.
  if (status.reached === 'no') return 'needs'

  switch (status.status.state) {
    case 'awaiting_trust':
    case 'crashed':
    case 'killed':
    case 'unclear':
      return 'needs'
    case 'running':
    case 'no_agent':
      return 'running'
    case 'no_session':
    case 'finished':
    case 'stopped':
      return 'idle'
  }
}

/** §4.2: design for several agents, ship one. `startup === null` is what
 *  `chosen()` already reads as *claude*, so this borrows that reading rather
 *  than inventing a second one — and a live session with no agent in it is a
 *  shell whichever way the workspace was configured. */
export function agentOf(
  workspace: Workspace,
  status: WorkspaceStatus | null,
): string {
  if (status?.reached === 'yes' && status.status.state === 'no_agent') return '—'
  return workspace.startup === null ? 'claude' : '—'
}

/** **An unreachable machine is one row, and its workspaces are not listed.** A
 *  dead Pi holding four workspaces would otherwise push four rows into the group
 *  that means *act now*, all naming the same cause. The machine is the problem;
 *  the workspaces are downstream of it. */
export function work(
  entries: Listed[],
  agents: Reading<AgentRow[]>,
): WorkRow[] {
  const rows: WorkRow[] = entries.flatMap((one) =>
    one.loaded === 'no'
      ? [
          {
            id: `u:${one.name}`,
            band: 'needs' as const,
            kind: 'unusable' as const,
            name: one.name,
            error: one.error,
          },
        ]
      : [],
  )

  const reported =
    agents.looked === 'ok'
      ? agents.data
      : entries.flatMap((one) =>
          one.loaded === 'yes' ? [{ workspace: one, status: null }] : [],
        )

  const unreachable = new Map<string, { count: number; error: string }>()
  for (const row of reported) {
    if (row.status?.reached !== 'no') continue
    const seen = unreachable.get(row.status.machine)
    unreachable.set(row.status.machine, {
      count: (seen?.count ?? 0) + 1,
      error: seen?.error ?? row.status.error,
    })
  }

  for (const [machine, { count, error }] of unreachable) {
    rows.push({
      id: `m:${machine}`,
      band: 'needs',
      kind: 'machine',
      machine,
      workspaces: count,
      error,
    })
  }

  for (const row of reported) {
    if (row.status?.reached === 'no') continue
    rows.push({
      id: `w:${row.workspace.name}`,
      band: bandOf(row.status),
      kind: 'workspace',
      workspace: row.workspace,
      status: row.status,
    })
  }

  return rows
}

/** A session no workspace claims, which D3 §4.3 counts in the fleet footer and
 *  §3.1 lists on `/machines`. One definition, because a count that disagrees
 *  with the list under it is worse than neither. */
export function unclaimed(
  answers: MachineSessions[],
  workspaces: Reading<Workspace[]>,
): { machine: string; session: Session }[] {
  const claimed = new Set(
    workspaces.looked === 'ok'
      ? workspaces.data.map((one) => `${one.machine} ${one.name}`)
      : [],
  )
  return answers.flatMap((answer) =>
    answer.reached === 'yes'
      ? answer.sessions
          .map((session) => ({ machine: answer.machine, session }))
          .filter((row) => !claimed.has(`${row.machine} ${row.session.name}`))
      : [],
  )
}

/** D3 §7.2. Off the tailnet the service worker serves the shell and every fetch
 *  fails, and the page drew that as one failure per section — seven copies of
 *  one sentence. **When every read fails the same way, it is one fact about the
 *  connection to `yantrad` rather than N facts about the fleet.**
 *
 *  Identical text, not merely all-failed: the daemon's own envelopes differ per
 *  class, so two classes failing for two reasons is two problems and stays two. */
export function unreachable(reads: Reading<unknown>[]): string | null {
  const failures = reads.flatMap((read) =>
    read.looked === 'failed' ? [read.error] : [],
  )
  if (failures.length === 0 || failures.length !== reads.length) return null
  return failures.every((one) => one === failures[0]) ? failures[0]! : null
}
