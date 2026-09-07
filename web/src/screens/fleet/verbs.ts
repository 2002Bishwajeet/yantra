import type { Workspace, WorkspaceStatus } from '@/api'
import type { MarkState } from '@/m3/mark/Mark'

export type Verb = 'up' | 'down' | 'resume'

/** D1 §2's one verb, computed rather than offered. The reading of each state
 *  is `columns.tsx`'s `chosen()` unchanged; this copy exists so the screens
 *  do not pull the old table and its primitives into their chunks. */
export type Chosen =
  | { does: 'wait' }
  | { does: 'fix' }
  | { does: 'answer' }
  | { does: 'open' }
  | { does: 'post'; verb: Verb; label: string }

export function chosen(workspace: Workspace, status: WorkspaceStatus | null): Chosen {
  // R-23: nothing has been read, so offering Start would be a guess.
  if (!status) return { does: 'wait' }
  if (status.reached === 'no') return { does: 'fix' }

  switch (status.status.state) {
    case 'no_session':
      return { does: 'post', verb: 'up', label: 'Start' }
    case 'awaiting_trust':
      return { does: 'answer' }
    case 'running':
    case 'no_agent':
    case 'unclear':
      return { does: 'open' }
    case 'finished':
    case 'stopped':
    case 'crashed':
    case 'killed':
      // ADR-0015 refuses resume where the workspace starts something of its
      // own, so what it left behind is a session to walk into, not a verb.
      return workspace.startup === null
        ? { does: 'post', verb: 'resume', label: 'Resume' }
        : { does: 'open' }
  }
}

/** D3 §4.7: only what cannot be undone asks first. */
export function confirms(verb: Verb | 'kill' | 'delete'): boolean {
  return verb === 'kill' || verb === 'delete'
}

/** Whether a running row also offers Stop: the boards draw it beside Open on
 *  an agent's session and not on a plain shell. */
export function stoppable(status: WorkspaceStatus | null): boolean {
  return status?.reached === 'yes' && status.status.state === 'running'
}

/** Mark plus word, never colour alone (D3 §6). A group heading is not a
 *  state: `finished` still says *finished* inside Idle. */
export function stateOf(status: WorkspaceStatus | null): { state: MarkState; word: string } {
  if (!status) return { state: 'unknown', word: 'not read yet' }
  if (status.reached === 'no') return { state: 'unknown', word: 'machine did not answer' }
  const agent = status.status
  switch (agent.state) {
    case 'awaiting_trust':
      return { state: 'needs', word: 'waiting for trust' }
    case 'running':
      return { state: 'running', word: 'running' }
    case 'no_agent':
      return { state: 'running', word: 'no agent, opened as a shell' }
    case 'no_session':
      return { state: 'idle', word: 'no session' }
    case 'finished':
      return { state: 'idle', word: 'finished' }
    case 'stopped':
      return { state: 'idle', word: 'stopped' }
    case 'crashed':
      return { state: 'failed', word: `crashed, exit ${agent.exit_status}` }
    case 'killed':
      return { state: 'failed', word: `killed, ${agent.signal}` }
    case 'unclear':
      return { state: 'unknown', word: 'unclear' }
  }
}

/** What told this state apart from the one beside it, for the row's detail. */
export function detailOf(status: WorkspaceStatus | null): string {
  if (!status) return 'the workspace list names it and the last agent look does not'
  if (status.reached === 'no') return status.error
  if (status.status.state === 'unclear') return status.status.because
  if (status.status.state === 'awaiting_trust') return 'Claude is asking before it runs a command'
  return ''
}
