import type { Machine, Session, Workspace } from '@/api'
import type { Column } from '@/components/DataTable'
import { Status, type Tone } from '@/components/Status'

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

export const workspaceColumns: Column<Workspace>[] = [
  { header: 'WORKSPACE', cell: (workspace) => workspace.name },
  { header: 'MACHINE', cell: (workspace) => workspace.machine },
  { header: 'REPO', cell: (workspace) => workspace.repo },
  { header: 'STARTUP', cell: (workspace) => workspace.startup ?? '' },
]

export type SessionRow = { machine: string; session: Session }

export const sessionColumns: Column<SessionRow>[] = [
  { header: 'MACHINE', cell: (row) => row.machine },
  { header: 'SESSION', cell: (row) => row.session.name },
  { header: 'WINDOWS', cell: (row) => row.session.windows },
  { header: 'ATTACHED', cell: (row) => row.session.attached },
  { header: 'CREATED', cell: (row) => row.session.created },
]
