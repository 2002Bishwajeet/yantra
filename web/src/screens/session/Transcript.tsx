import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import type { AgentState, Workspace } from '@/api'
import { LINES, type Said } from '@/api/hooks'
import { at } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Mono, Text } from '@/m3/text/Text'
import { count } from './format'
import { Turns, Waiting } from './Turns'

export type TranscriptProps = {
  workspace: Workspace
  state: AgentState | null
  said: Said
  now: number
  onRead: (lines: number, before: number) => void
}

/** What the agent in this workspace has been saying (D5 §4), read on request:
 *  mounting the tab is the request, `Refresh` re-reads, `Older` pages back. */
export function Transcript(props: TranscriptProps) {
  const { workspace, state, said, now, onRead } = props

  useEffect(() => {
    if (said.said === 'no') onRead(LINES, 0)
  }, [said.said, onRead])

  const refresh = () => onRead(LINES, 0)
  const read = said.said === 'held' ? at(said.at, now) : null

  return (
    <div className="transcript">
      <div className="transcript__turns">
        <Turns machine={workspace.machine} now={now} onRead={onRead} said={said} />
        {state?.state === 'awaiting_trust' ? <Waiting name={workspace.name} subject={null} /> : null}
      </div>
      <footer className="transcript__foot">
        <Text as="p" scale="body-small" tone="variant">
          read from the transcript on{' '}
          <Link params={{ machine: workspace.machine }} to="/m/$machine">
            {workspace.machine}
          </Link>{' '}
          over ssh
          {said.said === 'held' ? (
            <>
              {' '}
              · the last {count(said.asked)} of {count(said.total)} records · read{' '}
              <Mono>
                {read ? (
                  <time dateTime={read.iso} title={read.title}>
                    {read.text}
                  </time>
                ) : (
                  said.at
                )}
              </Mono>{' '}
              ago
            </>
          ) : null}
        </Text>
        <div className="transcript__actions">
          {/* D5 §4.6: on a narrow screen this is the only thing that reaches
              the pane without going through the tab bar. */}
          <Button
            role="link"
            render={<Link params={{ name: workspace.name }} replace search={{ view: 'terminal' }} to="/w/$name" />}
            variant="text"
          >
            Take control
          </Button>
          {said.said === 'held' && !said.moved ? (
            <Button
              disabled={said.paging || said.asked >= said.total}
              onClick={() => onRead(Math.min(LINES, said.total - said.asked), said.asked)}
              variant="tonal"
            >
              Older
            </Button>
          ) : null}
          {said.said === 'held' && !said.moved ? (
            <Button onClick={refresh} variant="tonal">
              Refresh
            </Button>
          ) : null}
        </div>
      </footer>
    </div>
  )
}
