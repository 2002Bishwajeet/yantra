import type { WorkspaceStatus } from '@/api'
import type { MarkState } from '@/m3/mark/Mark'

/** The mark and the words a workspace's status carries in a row — the sessions
 *  rail's and the palette's supporting line. Null is a status not yet read. */
export function phrase(status: WorkspaceStatus | null): { mark: MarkState; words: string; live: boolean } {
  if (status === null) return { mark: 'unknown', words: 'not read yet', live: false }
  if (status.reached === 'no') return { mark: 'unknown', words: 'unreachable', live: false }
  const state = status.status
  switch (state.state) {
    case 'awaiting_trust':
      return { mark: 'needs', words: 'waiting for trust', live: true }
    case 'running':
      return { mark: 'running', words: 'running', live: true }
    case 'no_agent':
      return { mark: 'running', words: 'no agent, a shell', live: true }
    case 'crashed':
      return { mark: 'failed', words: `crashed, exit ${state.exit_status}`, live: false }
    case 'killed':
      return { mark: 'failed', words: `killed, ${state.signal}`, live: false }
    case 'finished':
      return { mark: 'done', words: 'finished', live: false }
    case 'stopped':
      return { mark: 'idle', words: 'stopped', live: false }
    case 'no_session':
      return { mark: 'idle', words: 'no session', live: false }
    case 'unclear':
      return { mark: 'unknown', words: 'unclear', live: false }
  }
}
