/*
 * The drawer's layout adapts T3 Code's `apps/web/src/components/ThreadTerminalDrawer.tsx`
 * at commit 1451e7c (MIT, Copyright (c) 2026 T3 Tools Inc.; THIRD_PARTY_NOTICES.md):
 * a docked aside, its actions at the top right, the terminal under them. Yantra keeps
 * its own xterm and socket, and tmux keeps the shell across a daemon restart (Y-498).
 */
import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { Workspace } from '@/api'
import type { ApiError } from '@/api/errors'
import { useThreadTerminal } from '@/api/mutations'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Text } from '@/m3/text/Text'
import { useFormFactor } from '@/shell/formFactor'
import { KeyRow } from './Keys'
import { Terminal } from './Terminal'
import './TerminalDrawer.css'

// The drawer sits in the composer's dock, so on a phone it shrinks with the screen the keyboard leaves.
const PHONE_HEIGHT = 'calc((100dvh - var(--m3-keyboard-inset, 0px)) * 0.3)'

function failure(error: ApiError, machine: string): string {
  if (error.kind === 'missing') return 'The thread has no worktree to open a terminal in'
  if (error.kind === 'network') return 'The daemon did not answer, so no terminal was opened'
  if (error.status === 409) return `${machine} has no tmux server to open the terminal in`
  return `The terminal could not be opened on ${machine}`
}

export type TerminalDrawerProps = {
  workspace: Workspace
  thread: string
  /** Who else writes the tree: "Claude", or "the agent" before a harness is named. */
  agent: string
  onClose: () => void
}

/** A shell in the thread's worktree (Y-498). Opening the drawer asks the daemon
 *  to open or attach the thread's tmux session, then attaches to it by name. */
export function TerminalDrawer(props: TerminalDrawerProps) {
  const { workspace, thread, agent, onClose } = props
  const factor = useFormFactor()
  const { mutate, data, error } = useThreadTerminal(workspace.name)
  const open = () => mutate(thread)
  useEffect(() => mutate(thread), [mutate, thread])

  return (
    <aside aria-label="Terminal in the thread's worktree" className="terminal-drawer">
      <div className="terminal-drawer__head">
        <Text render={<h2 />} scale="title-small">
          Terminal
        </Text>
        <Button icon={<X />} onClick={onClose} variant="text">
          Close
        </Button>
      </div>
      <Text className="terminal-drawer__note" render={<p />} scale="body-small" tone="variant">
        This shell and {agent} share the thread's worktree, so each sees what the other changes.
      </Text>
      {error ? (
        <ErrorSurface.Inline
          action={
            error.retryable ? undefined : (
              <Button onClick={open} variant="text">
                Retry
              </Button>
            )
          }
          error={error}
          eyebrow={`on ${workspace.machine}`}
          reset={open}
          title={failure(error, workspace.machine)}
        />
      ) : data ? (
        <Terminal
          height={factor === 'phone' ? PHONE_HEIGHT : 'min(40dvh, 320px)'}
          key={`${data.machine}/${data.session}`}
          label={`tmux ${data.session} on ${data.machine}`}
          target={{ machine: data.machine, session: data.session }}
        >
          {factor === 'phone' ? <KeyRow /> : null}
        </Terminal>
      ) : (
        <Text render={<p role="status" />} scale="body-small" tone="variant">
          Opening the terminal on {workspace.machine}…
        </Text>
      )}
    </aside>
  )
}
