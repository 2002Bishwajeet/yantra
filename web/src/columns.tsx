import { Link } from '@tanstack/react-router'
import type {
  Looked,
  Machine,
  MachineSessions,
  Power,
  Session,
  Workspace,
  WorkspaceStatus,
} from '@/api'
import { Act, Actions, type Verb } from '@/components/Act'
import { Ago, Stamp } from '@/components/Age'
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
  {
    header: 'MACHINE',
    cell: (machine) => (
      <Link to="/m/$machine" params={{ machine: machine.name }}>
        {machine.name}
      </Link>
    ),
  },
  { header: 'OS', cell: (machine) => machine.os },
  { header: 'STATUS', cell: (machine) => <Status {...reachability(machine)} /> },
  {
    header: 'HEARTBEAT',
    cell: (machine) => (
      <span className="inline-flex items-center gap-2">
        <Status {...reporting(machine)} />
        {machine.heartbeat && (
          <span>
            beat <Ago seconds={machine.heartbeat.age_seconds} />
          </span>
        )}
      </span>
    ),
  },
  {
    header: 'LAST SEEN',
    // I-39: on an online peer this is noise, and the API does not blank it.
    cell: (machine) =>
      machine.online || !machine.last_seen ? (
        ''
      ) : (
        <Stamp stamp={machine.last_seen} />
      ),
  },
]

/** Y-113 left `attach` as a paste because ADR-0011's TUI wants a terminal this
 *  page had none of; Y-130 gives it one, so the paste is a button. Only a look
 *  that succeeded can say there is a session to attach to — and the name goes
 *  into a URL the browser encodes rather than a shell someone pastes, so
 *  `USABLE_NAME` guards the two commands below and not this. */
export function attachable(
  workspace: Workspace,
  sessions: Looked<MachineSessions[]>,
): boolean {
  const answer =
    sessions.looked === 'ok'
      ? sessions.data.find((one) => one.machine === workspace.machine)
      : undefined

  return (
    answer?.reached === 'yes' &&
    answer.sessions.some((session) => session.name === workspace.name)
  )
}

/** What the button is about to touch, said before it is tapped: the machine the
 *  workspace names, and Y-109's reading of it where the fleet holds one. A
 *  machine the tailnet does not list gets no state, because none was looked up. */
function target(
  workspace: Workspace,
  machines: Looked<Machine[]>,
): Machine | undefined {
  return machines.looked === 'ok'
    ? machines.data.find((one) => one.name === workspace.machine)
    : undefined
}

/** D1 §2's one verb, computed rather than offered. *Resume* stays the name of
 *  the route that respawns an ended agent and is never borrowed for a live one:
 *  a session you can walk back into is `open`, which is a URL rather than
 *  anything the daemon runs. */
export type Chosen =
  | { does: 'wait'; label: string }
  | { does: 'fix'; label: string }
  | { does: 'open'; label: string }
  | { does: 'post'; verb: Verb; label: string }

export function chosen(
  workspace: Workspace,
  status: WorkspaceStatus | null,
): Chosen {
  // R-23: nothing has been read, so offering Start would be a guess painted as
  // knowledge — and this is the state a row spends its first seconds in.
  if (!status) return { does: 'wait', label: 'reading…' }
  if (status.reached === 'no') return { does: 'fix', label: 'Fix' }

  switch (status.status.state) {
    case 'no_session':
      return {
        does: 'post',
        verb: 'up',
        label: workspace.startup === null ? 'Start claude' : 'Start',
      }
    // I-49 waits on a person and on nothing else, so it is worth its own word
    // rather than reading as a session that is getting on with something.
    case 'awaiting_trust':
      return { does: 'open', label: 'Answer' }
    case 'running':
    case 'no_agent':
    case 'unclear':
      return { does: 'open', label: 'Open' }
    case 'finished':
    case 'stopped':
    case 'crashed':
    case 'killed':
      // ADR-0015 refuses resume where the workspace starts something of its
      // own, so what it left behind is a session to walk into, not a verb.
      return workspace.startup === null
        ? { does: 'post', verb: 'resume', label: 'Resume' }
        : { does: 'open', label: 'Open' }
  }
}

/** The agent class answers per workspace and collapses back into one reading, so
 *  a class that is not `ok` gives every row the same `null` — which `chosen`
 *  reads as *nothing has been looked at yet* rather than as a state. */
function reportOn(
  workspace: Workspace,
  agents: Looked<AgentRow[]>,
): WorkspaceStatus | null {
  if (agents.looked !== 'ok') return null
  return (
    agents.data.find((row) => row.workspace.name === workspace.name)?.status ??
    null
  )
}

export function workspaceColumns(
  sessions: Looked<MachineSessions[]>,
  machines: Looked<Machine[]>,
  agents: Looked<AgentRow[]>,
  // Null on a machine's own page: a workspace is edited where it is listed.
  edit: ((name: string) => void) | null,
): Column<Workspace>[] {
  return [
    { header: 'WORKSPACE', cell: (workspace) => workspace.name },
    {
      header: 'MACHINE',
      cell: (workspace) => {
        const machine = target(workspace, machines)
        // Stacked, not inline: the cells do not wrap, and a badge beside a
        // MagicDNS name costs 120 px of the 295 a phone has.
        return (
          <span className="inline-flex flex-col items-start gap-1">
            <Link to="/m/$machine" params={{ machine: workspace.machine }}>
              {workspace.machine}
            </Link>
            {machine && <Status {...reporting(machine)} />}
          </span>
        )
      },
    },
    // Third, not last: the buttons are the whole point of this page, so they
    // come before the fields you only read — in a row and in a block alike.
    // Y-167 folded the TERMINAL and EDIT columns into the overflow behind it.
    {
      header: 'ACT',
      cell: (workspace) => (
        <Actions
          chosen={chosen(workspace, reportOn(workspace, agents))}
          edit={edit}
          terminal={attachable(workspace, sessions)}
          workspace={workspace}
        />
      ),
    },
    { header: 'REPO', cell: (workspace) => workspace.repo },
    { header: 'STARTUP', cell: (workspace) => workspace.startup ?? '' },
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
    {
      header: 'WINDOWS',
      cell: (row) => <span className="font-mono">{row.session.windows}</span>,
    },
    {
      header: 'ATTACHED',
      cell: (row) => <span className="font-mono">{row.session.attached}</span>,
    },
    { header: 'CREATED', cell: (row) => <Stamp stamp={row.session.created} /> },
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
    // D3 §6.1 splits what `ok` held: a live session gets the running mark, and
    // the three endings get the hollow one, because they wait on nobody.
    case 'no_session':
      return { tone: 'idle', label: 'no session' }
    case 'running':
      return { tone: 'ok', label: 'running' }
    case 'finished':
      return { tone: 'idle', label: 'finished' }
    case 'stopped':
      return { tone: 'idle', label: 'stopped' }
    case 'no_agent':
      return { tone: 'ok', label: 'no agent — opened as a shell' }
    case 'awaiting_trust':
      return { tone: 'warn', label: "waiting for you at claude's trust prompt" }
    case 'crashed':
      return { tone: 'bad', label: `crashed — exit ${agent.exit_status}` }
    case 'killed':
      return { tone: 'bad', label: `killed — ${agent.signal}` }
    // D3 §6.2: colouring uncertainty makes it look like a decision, so the
    // dashed hollow mark is the whole treatment.
    case 'unclear':
      return { tone: 'unknown', label: 'unclear' }
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
 *  endings, and refuses on sight a workspace whose `startup` is not an agent.
 *  Two of the three have a route behind them and are buttons (Y-136); `attach`
 *  execs `ssh -t` and hands this terminal over (ADR-0011), so it has none. */
export function agentAct(row: AgentRow): Verb | 'attach' | null {
  if (!row.status || row.status.reached === 'no') return null

  switch (row.status.status.state) {
    case 'no_session':
      return 'up'
    case 'finished':
    case 'stopped':
    case 'crashed':
    case 'killed':
      return row.workspace.startup === null ? 'resume' : null
    // Attach is the whole answer to the trust prompt: ADR-0011 says the one who
    // answers that dialog is a person, never Yantra.
    case 'running':
    case 'awaiting_trust':
    case 'no_agent':
    case 'unclear':
      return 'attach'
  }
}

/** The one command left, and the name is checked because this one really is
 *  pasted into a shell — what goes into a button's URL is not (Y-130). */
export function agentCommand(row: AgentRow): string | null {
  const { name } = row.workspace
  if (agentAct(row) !== 'attach' || !USABLE_NAME.test(name)) return null
  return `yantra attach ${name}`
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
  // `ACT` rather than `COMMAND`, which is what the cell held before the two
  // verbs with a route became buttons — and what the workspaces table calls
  // the same thing. Only one verb is offered, because this section read the
  // state: a Stop beside an agent that has already stopped is answerable and
  // still says the page does not know what it is looking at.
  {
    header: 'ACT',
    cell: (row) => {
      const act = agentAct(row)
      if (act === 'up' || act === 'resume') {
        return <Act workspace={row.workspace} verb={act} />
      }
      const command = agentCommand(row)
      return command && <Command command={command} />
    },
  },
]
