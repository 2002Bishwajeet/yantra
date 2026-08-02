import type { Looked, Machine, MachineSessions, Session, Workspace } from '@/api'
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

export const machineColumns: Column<Machine>[] = [
  { header: 'MACHINE', cell: (machine) => machine.name },
  { header: 'OS', cell: (machine) => machine.os },
  { header: 'STATUS', cell: (machine) => <Status {...reachability(machine)} /> },
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
