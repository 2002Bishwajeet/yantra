import type { ReactNode } from 'react'
import { State, type MarkState } from '@/m3/mark/Mark'
import { Text } from '@/m3/text/Text'
import './EmptyState.css'

/** One block of the EmptyStates board, drawn in place of a card's rows: a
 *  mark and a word for the answer, one line for why it is an answer, and the
 *  way out when there is one. Titles are sentence case and end with no full
 *  stop. `compact` is the banner: a left-aligned row with the action at the far
 *  end, for a state that is not empty (a paused room) or a line (Idle). */
export function EmptyState(props: {
  state?: MarkState
  title: string
  children?: ReactNode
  action?: ReactNode
  compact?: boolean
}) {
  const { state, title, children, action, compact } = props
  return (
    <div className="m3-empty" data-compact={compact ? '' : undefined} data-slot="empty">
      <State className="m3-empty__title" state={state ?? 'idle'}>
        {title}
      </State>
      {children ? (
        <Text render={<p />} className="m3-empty__why" scale="body-small" tone="variant">
          {children}
        </Text>
      ) : null}
      {action ? <div className="m3-empty__action">{action}</div> : null}
    </div>
  )
}
