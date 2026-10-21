/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/components/chat/ComposerPrimaryActions.tsx
 * (the send and stop buttons only; the daemon has no steer, queue, resume or implement):
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/components/chat/ComposerPrimaryActions.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useId } from 'react'
import { Tooltip } from '@base-ui/react/tooltip'
import { ArrowUp } from 'lucide-react'

export type PrimaryActionProps = {
  /** The name of the send button: Send in the chat, Post in a room. */
  label: string
  /** Why the button is off, or null when it acts. It is the tooltip and the description. */
  reason: string | null
  /** A request is in flight, and the button shows a spinner. */
  pending?: boolean
  /** A turn is running: the button is a Stop. */
  running?: { agent: string; stopping: boolean; onStop: () => void; reason: string } | null
}

function Spinner() {
  return <span aria-hidden="true" className="composer-spinner" />
}

/** The one round button: arrow-up to send, a rounded square to stop. */
export function PrimaryAction(props: PrimaryActionProps) {
  const { label, reason, pending, running } = props
  const why = useId()
  if (running) {
    return (
      <>
        <span className="m3-sr-only" id={why}>
          {running.reason}
        </span>
        <button
          aria-busy={running.stopping || undefined}
          aria-describedby={why}
          aria-label={`Stop ${running.agent}`}
          className="composer-action"
          data-kind="stop"
          disabled={running.stopping}
          onClick={running.onStop}
          type="button"
        >
          <span className="composer-action__disc">
            {running.stopping ? (
              <Spinner />
            ) : (
              <svg aria-hidden="true" fill="currentColor" height="12" viewBox="0 0 12 12" width="12">
                <rect height="8" rx="1.5" width="8" x="2" y="2" />
              </svg>
            )}
          </span>
        </button>
      </>
    )
  }
  const button = (
    <button
      aria-busy={pending || undefined}
      aria-describedby={reason ? why : undefined}
      aria-label={label}
      className="composer-action"
      data-kind="send"
      disabled={reason !== null}
      type="submit"
    >
      <span className="composer-action__disc">{pending ? <Spinner /> : <ArrowUp aria-hidden="true" />}</span>
    </button>
  )
  // One tree whether or not there is a reason, so the button keeps its identity as the reason comes and goes.
  return (
    <>
      {reason ? (
        <span className="m3-sr-only" id={why}>
          {reason}
        </span>
      ) : null}
      <Tooltip.Provider delay={300}>
        <Tooltip.Root disabled={!reason}>
          <Tooltip.Trigger render={<span style={{ display: 'inline-flex' }} />}>{button}</Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Positioner className="composer-tip__positioner" side="top" sideOffset={6}>
              <Tooltip.Popup className="composer-tip">{reason}</Tooltip.Popup>
            </Tooltip.Positioner>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    </>
  )
}
