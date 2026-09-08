import type { AgentState, MachineSessions, Workspace, WorkspaceStatus } from '@/api'
import type { Reading } from '@/api/hooks'
import { phrase } from '@/shell/phrase'

/** The tmux session behind a workspace, for its age. */
export function startedAt(sessions: Reading<MachineSessions[]>, workspace: Workspace): number | null {
  if (sessions.looked !== 'ok') return null
  const machine = sessions.data.find((one) => one.machine === workspace.machine)
  if (!machine || machine.reached !== 'yes') return null
  return machine.sessions.find((one) => one.name === workspace.name)?.created_at ?? null
}

/** Whether the one verb is live: Stop for an agent that is going, Resume for
 *  one that ended and started nothing of its own (ADR-0015, `columns.tsx`). */
export function verbs(workspace: Workspace, status: WorkspaceStatus | null): { stop: boolean; resume: boolean } {
  if (status === null || status.reached === 'no') return { stop: false, resume: false }
  switch (status.status.state) {
    case 'running':
    case 'awaiting_trust':
    case 'no_agent':
    case 'unclear':
      return { stop: true, resume: false }
    case 'finished':
    case 'stopped':
    case 'crashed':
    case 'killed':
      return { stop: false, resume: workspace.startup === null }
    case 'no_session':
      return { stop: false, resume: false }
  }
}

/** Why a verb `verbs` withholds is not offered. A disabled button carries this
 *  as its description, so a reader who cannot see the state still gets it. */
export function whyNot(workspace: Workspace, status: WorkspaceStatus | null): { stop: string; resume: string } {
  const both = (said: string) => ({ stop: said, resume: said })
  if (status === null) return both(`The daemon has not read ${workspace.name} yet.`)
  if (status.reached === 'no') return both(`${workspace.machine} did not answer, so neither verb can be sent.`)
  const { words } = phrase(status)
  return {
    stop: `Stop needs a running agent, and ${workspace.name} is ${words}.`,
    resume:
      workspace.startup === null
        ? `Resume needs an agent that has ended, and ${workspace.name} is ${words}.`
        : `${workspace.name} starts a command of its own, so claude has no conversation to resume.`,
  }
}

/** The end of an agent, in the daemon's words (§2e: `finished` carries no
 *  code, `crashed` its status, `killed` its signal). */
export function ending(state: AgentState): string | null {
  switch (state.state) {
    case 'finished':
      return 'claude exited 0'
    case 'crashed':
      return `claude exited ${state.exit_status}`
    case 'killed':
      return `claude was killed by ${state.signal}`
    case 'stopped':
      return 'claude was stopped'
    default:
      return null
  }
}
