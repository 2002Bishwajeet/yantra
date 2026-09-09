import type { ReactNode } from 'react'
import { State, type MarkState } from '@/m3/mark/Mark'
import { Text } from '@/m3/text/Text'
import './Empty.css'

/** One block of the EmptyStates board, drawn in place of a card's rows: a
 *  mark and a word for the answer, and one line for why it is an answer. */
export function Empty(props: { state?: MarkState; title: string; children?: ReactNode }) {
  const { state, title, children } = props
  return (
    <div className="empty">
      <State className="empty__title" state={state ?? 'idle'}>
        {title}
      </State>
      {children ? (
        <Text render={<p />} className="empty__why" scale="body-small" tone="variant">
          {children}
        </Text>
      ) : null}
    </div>
  )
}
