import type {
  Looked,
  Machine,
  MachineSessions,
  Power,
  Session,
  Workspace,
  WorkspaceStatus,
} from '@/api'
import { Command } from '@/components/Command'
import type { Column } from '@/components/DataTable'
import { Status, type Tone } from '@/components/Status'

// What `workspace::validate_name` allows, restated rather than inherited: a
// command someone pastes into a shell must not depend on the daemon's promise.
const USABLE_NAME = /^[A-Za-z0-9_-]+$/

// I-39: an expired key is a third state, and it is the one a person can act
// on, so it must not read as a shade of offline.
function reachability(machine: Machine): { tone: Tone; label: string } {
  const reachable = machine.online ? 'online' : 'offline'
  if (machine.expired) {
    return { tone: 'warn', label: `${reachable}, key expired` }
  }
  return { tone: machine.online ? 'ok' : 'unknown', label: reachable }
}

// ADR-0013 §7: three of the agent's 10 s intervals, so a single lost POST never
// reads as a machine that stopped reporting.
const FRESH_SECONDS = 30

/** ADR-0013 §7's four states, and there are four rather than two because a page
 *  that says *asleep* when it means *we have not heard from it* is the confident
 *  lie M4 exists not to tell (R-23). `online` chooses between two explanations
 *  of a missing beat and never decides whether one arrived (R-8, I-10). */
export function reporting(machine: Machine): {
  tone: Tone
  label: string
  detail: string
} {
  const beat = machine.heartbeat
  if (!beat) {
    return {
      tone: 'unknown',
      label: 'never heard from',
      detail: `no heartbeat has ever arrived from ${machine.name}, which is not the same as one that stopped — yantra-agent is probably not installed there`,
    }
  }
  if (beat.age_seconds <= FRESH_SECONDS) {
    return {
      tone: 'ok',
      label: 'ready',
      detail: `${beat.free_ram_mb} MB free, ${beat.cpu_busy_pct}% busy, on ${power(beat.power)}`,
    }
  }
  return machine.online
    ? {
        tone: 'warn',
        label: 'up, but not reporting',
        detail: `Tailscale still sees ${machine.name}, so this is its agent rather than the machine — a different thing to go and fix`,
      }
    : {
        tone: 'unknown',
        label: 'asleep or off',
        detail: `nothing has arrived for ${beat.age_seconds}s and Tailscale has lost it too, which is the closest thing to a sleep signal that exists`,
      }
}

function power(state: Power): string {
  return state === 'ac' ? 'AC' : `battery, ${state.battery.percent}%`
}

export const machineColumns: Column<Machine>[] = [
  { header: 'MACHINE', cell: (machine) => machine.name },
  { header: 'OS', cell: (machine) => machine.os },
  { header: 'STATUS', cell: (machine) => <Status {...reachability(machine)} /> },
  {
    header: 'HEARTBEAT',
    cell: (machine) => (
      <span className="inline-flex items-center gap-2">
        <Status {...reporting(machine)} />
        {machine.heartbeat && (
          <time dateTime={`PT${machine.heartbeat.age_seconds}S`}>
            beat {machine.heartbeat.age_seconds}s ago
          </time>
        )}
      </span>
    ),
  },
  {
    header: 'LAST SEEN',
    // I-39: on an online peer this is noise, and the API does not blank it.
    cell: (machine) => (machine.online ? '' : (machine.last_seen ?? '')),
  },
]

/** Only a look that succeeded can say a session is there. Not knowing is not
 *  the same as knowing there is none, and `up` is right either way (§B4). */
export function workspaceCommand(
  workspace: Workspace,
  sessions: Looked<MachineSessions[]>,
): string | null {
  if (!USABLE_NAME.test(workspace.name)) return null

  const answer =
    sessions.looked === 'ok'
      ? sessions.data.find((one) => one.machine === workspace.machine)
      : undefined
  const running =
    answer?.reached === 'yes' &&
    answer.sessions.some((session) => session.name === workspace.name)

  return `yantra ${running ? 'attach' : 'up'} ${workspace.name}`
}

export function workspaceColumns(
  sessions: Looked<MachineSessions[]>,
): Column<Workspace>[] {
  return [
    { header: 'WORKSPACE', cell: (workspace) => workspace.name },
    { header: 'MACHINE', cell: (workspace) => workspace.machine },
    { header: 'REPO', cell: (workspace) => workspace.repo },
    { header: 'STARTUP', cell: (workspace) => workspace.startup ?? '' },
    {
      header: 'COMMAND',
      cell: (workspace) => {
        const command = workspaceCommand(workspace, sessions)
        return command && <Command command={command} />
      },
    },
  ]
}

export type SessionRow = { machine: string; session: Session }

/** Every verb takes a *workspace* name, so a session Yantra did not open has no
 *  command — and the name comes from the workspace, never from tmux's output. */
export function sessionCommand(
  row: SessionRow,
  workspaces: Looked<Workspace[]>,
): string | null {
  if (workspaces.looked !== 'ok') return null

  const workspace = workspaces.data.find(
    (one) => one.name === row.session.name && one.machine === row.machine,
  )
  if (!workspace || !USABLE_NAME.test(workspace.name)) return null

  return `yantra attach ${workspace.name}`
}

export function sessionColumns(
  workspaces: Looked<Workspace[]>,
): Column<SessionRow>[] {
  return [
    { header: 'MACHINE', cell: (row) => row.machine },
    { header: 'SESSION', cell: (row) => row.session.name },
    { header: 'WINDOWS', cell: (row) => row.session.windows },
    { header: 'ATTACHED', cell: (row) => row.session.attached },
    { header: 'CREATED', cell: (row) => row.session.created },
    {
      header: 'COMMAND',
      cell: (row) => {
        const command = sessionCommand(row, workspaces)
        return command && <Command command={command} />
      },
    },
  ]
}

/** A `null` status is Y-084's 404, or a workspace the last agent look predates
 *  — the two readings are taken on their own clocks and can disagree. */
export type AgentRow = { workspace: Workspace; status: WorkspaceStatus | null }

export function awaitingTrust(row: AgentRow): boolean {
  return (
    row.status?.reached === 'yes' &&
    row.status.status.state === 'awaiting_trust'
  )
}

/** Y-091 is what lets this section be honest: a shell session is `no_agent` and
 *  ordinary, so only `unclear`'s contradiction and a dead agent read as wrong. */
export function agentState(status: WorkspaceStatus | null): {
  tone: Tone
  label: string
} {
  if (!status) return { tone: 'unknown', label: 'no report yet' }
  if (status.reached === 'no') {
    return { tone: 'unknown', label: 'machine did not answer' }
  }

  const agent = status.status
  switch (agent.state) {
    case 'no_session':
      return { tone: 'ok', label: 'no session' }
    case 'running':
      return { tone: 'ok', label: 'running' }
    case 'finished':
      return { tone: 'ok', label: 'finished' }
    case 'stopped':
      return { tone: 'ok', label: 'stopped' }
    case 'no_agent':
      return { tone: 'ok', label: 'no agent — opened as a shell' }
    case 'awaiting_trust':
      return { tone: 'warn', label: "waiting for you at claude's trust prompt" }
    case 'crashed':
      return { tone: 'bad', label: `crashed — exit ${agent.exit_status}` }
    case 'killed':
      return { tone: 'bad', label: `killed — ${agent.signal}` }
    case 'unclear':
      return { tone: 'bad', label: 'unclear' }
  }
}

/** What told this state apart from the one next to it. */
function agentDetail(status: WorkspaceStatus | null): string {
  if (!status) {
    return 'the workspace list names it and the last agent look does not'
  }
  if (status.reached === 'no') return status.error
  if (status.status.state === 'unclear') return status.status.because
  return status.session ? `claude lists pid ${status.session.pid}` : ''
}

/** Y-097's third verb, derivable at last: `resume` respawns exactly the four
 *  endings, and refuses on sight a workspace whose `startup` is not an agent. */
export function agentCommand(row: AgentRow): string | null {
  const { name, startup } = row.workspace
  if (!USABLE_NAME.test(name)) return null
  if (!row.status || row.status.reached === 'no') return null

  switch (row.status.status.state) {
    case 'no_session':
      return `yantra up ${name}`
    case 'finished':
    case 'stopped':
    case 'crashed':
    case 'killed':
      return startup === null ? `yantra resume ${name}` : null
    // Attach is the whole answer to the trust prompt: ADR-0011 says the one who
    // answers that dialog is a person, never Yantra.
    case 'running':
    case 'awaiting_trust':
    case 'no_agent':
    case 'unclear':
      return `yantra attach ${name}`
  }
}

export const agentColumns: Column<AgentRow>[] = [
  { header: 'WORKSPACE', cell: (row) => row.workspace.name },
  { header: 'MACHINE', cell: (row) => row.workspace.machine },
  { header: 'AGENT', cell: (row) => <Status {...agentState(row.status)} /> },
  {
    header: 'DETAIL',
    cell: (row) => (
      <span className="font-mono text-xs whitespace-pre-wrap">
        {agentDetail(row.status)}
      </span>
    ),
  },
  {
    header: 'COMMAND',
    cell: (row) => {
      const command = agentCommand(row)
      return command && <Command command={command} />
    },
  },
]
