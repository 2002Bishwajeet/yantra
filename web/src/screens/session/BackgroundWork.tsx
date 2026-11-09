/*
 * The shape is T3 Code's backgroundWorkNowItem and its title, at commit 67eebaca:
 * https://github.com/pingdotgg/t3code/blob/67eebaca/apps/web/src/components/chat/ThreadActivityBanners.tsx
 * https://github.com/pingdotgg/t3code/blob/67eebaca/packages/client-runtime/src/state/threadExecution.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useId } from 'react'
import { Terminal } from 'lucide-react'
import type { BackgroundTask } from '@/api/thread'
import { Button } from '@/m3/button/Button'

function waitingOn(count: number): string {
  return count === 1 ? 'Waiting on a background task' : `Waiting on ${count} background tasks`
}

/** What a task is called: its description, or the agent's word for its kind. */
const labelOf = (task: BackgroundTask) => task.description || task.kind

/** The tasks the agent runs past its turn, above the composer (ADR-0041 decision 2).
 *  Each has its own Stop; Stop all also lets the agent's process go. */
export function BackgroundWork(props: {
  tasks: BackgroundTask[]
  disabled: boolean
  onStop: (taskId: string) => void
  onStopAll: () => void
}) {
  const { tasks, disabled, onStop, onStopAll } = props
  const title = useId()
  if (tasks.length === 0) return null
  return (
    <section aria-labelledby={title} className="chat__background">
      <p className="chat__background-title" id={title}>
        <Terminal aria-hidden="true" size={16} />
        {waitingOn(tasks.length)}
      </p>
      <ul>
        {tasks.map((task) => (
          <li key={task.taskId}>
            <span className="chat__background-label">{labelOf(task)}</span>
            <Button
              aria-label={`Stop ${labelOf(task)}`}
              disabled={disabled}
              onClick={() => onStop(task.taskId)}
              variant="text"
            >
              Stop
            </Button>
          </li>
        ))}
      </ul>
      <Button className="chat__background-all" disabled={disabled} onClick={onStopAll} tone="error" variant="text">
        Stop all
      </Button>
    </section>
  )
}
