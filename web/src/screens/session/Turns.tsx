import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { ToolCall, Turn } from '@/api'
import { LINES, type Said } from '@/api/hooks'
import { at } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'

/** D5 §8's four verbs. A tool this list does not name reads as its own name,
 *  which is the honest fallback and what the far side sent. */
const VERBS: Record<string, string> = {
  Bash: 'ran',
  Edit: 'edited',
  Write: 'edited',
  Read: 'read',
  WebFetch: 'read',
  Grep: 'searched',
  Glob: 'searched',
  WebSearch: 'searched',
}

/** One line: the tool as a verb and the one string it acted on (D5 §4.2).
 *  Expanded, it is the target as the daemon sent it — up to the far side's
 *  120-character cap. The whole command is in the terminal and in the file. */
function Call(props: { call: ToolCall }) {
  const { call } = props
  const [open, setOpen] = useState(false)
  const verb = VERBS[call.name] ?? call.name
  if (call.target === null) return <span className="turn__verb">{verb}</span>
  return (
    <button aria-expanded={open} className="turn__call" onClick={() => setOpen(!open)} type="button">
      <span className="turn__verb">{verb}</span>
      <Mono className="turn__target" clip={!open}>
        {call.target}
      </Mono>
    </button>
  )
}

export function OneTurn(props: { turn: Turn; now: number }) {
  const { turn, now } = props
  const stamp = turn.at === null ? null : at(turn.at, now)
  return (
    <article className="turn" data-who={turn.who}>
      <header className="turn__head">
        <Eyebrow>{turn.who}</Eyebrow>
        {/* A few records carry no timestamp, and a turn with none prints none
            rather than *unknown* (D5 §4.1). */}
        {stamp ? (
          <Mono>
            <time dateTime={stamp.iso} title={stamp.title}>
              {stamp.text}
            </time>
          </Mono>
        ) : turn.at !== null ? (
          <Mono>{turn.at}</Mono>
        ) : null}
      </header>
      {/* Text, never Markdown: a parser inside a held budget, an XSS surface on
          text a machine wrote, and code fences that want a highlighter next
          (D5 §4.1). */}
      {turn.text !== '' ? <p className="turn__text">{turn.text}</p> : null}
      {turn.tools.length > 0 ? (
        <ul className="turn__calls">
          {turn.tools.map((call, index) => (
            <li key={index}>
              <Call call={call} />
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}

/** D5 §4.4. The windows are counted from the end, so a file that grew between
 *  two reads gives one that does not line up with what is above it. */
export function Moved(props: { onRefresh: () => void }) {
  return (
    <Card surface="high">
      <Text as="h3" scale="title-medium">
        The conversation moved on.
      </Text>
      <Text as="p" scale="body-medium" tone="variant">
        The agent has written more since this page read the transcript, so an older window no longer
        lines up with the turns below.
      </Text>
      <div>
        <Button onClick={props.onRefresh} variant="tonal">
          Refresh
        </Button>
      </div>
    </Card>
  )
}

/** The transcript in whichever state the read left it, oldest first. The
 *  `held` turns are the caller's to arrange — chat and transcript draw the
 *  same list two ways. */
export function Turns(props: { said: Said; machine: string; now: number; onRead: (lines: number, before: number) => void }) {
  const { said, machine, now, onRead } = props
  const refresh = () => onRead(LINES, 0)

  if (said.said === 'no' || said.said === 'reading') {
    return (
      <div aria-busy="true" className="turns__reading" data-slot="reading">
        <Skeleton shape="text" />
        <Skeleton shape="text" />
        <Text as="p" scale="body-small" tone="variant">
          reading the transcript on {machine} over ssh
        </Text>
      </div>
    )
  }

  if (said.said === 'nothing') {
    return (
      <Card surface="high">
        <Text as="h3" scale="title-medium">
          No agent has written a turn here.
        </Text>
        <Text as="p" scale="body-medium" tone="variant">
          A transcript appears on the agent's first message, not when it launches.
        </Text>
        <Mono className="turns__said">{said.because}</Mono>
      </Card>
    )
  }

  if (said.said === 'refused') {
    // D5 §7: this tab draws its own refusal and names the machine, so the
    // first one a reader opens already says where the fault is.
    return (
      <ErrorSurface.Inline
        action={
          <Button role="link" render={<Link params={{ machine }} to="/m/$machine" />} variant="text">
            {machine}
          </Button>
        }
        error={{
          kind: 'refused',
          said: said.because,
          retryable: true,
          describe: () => `The transcript on ${machine} could not be read.`,
        }}
        eyebrow={`on ${machine}`}
        reset={refresh}
        title="The transcript could not be read"
      />
    )
  }

  return (
    <>
      {said.moved ? <Moved onRefresh={refresh} /> : null}
      {said.turns.map((turn, index) => (
        <OneTurn key={index} now={now} turn={turn} />
      ))}
    </>
  )
}

/** The transcript's waiting card: the agent is at its trust prompt, and the
 *  answer is the pane itself on the Terminal tab — D5 §5.2 settles that the
 *  dialog is the agent's own and not a picture of one this tab redraws. */
export function Waiting(props: { name: string; subject: string | null }) {
  const { name, subject } = props
  return (
    <Card className="turns__waiting" surface="primary">
      <State state="needs">waiting for you</State>
      <Text as="p" scale="body-medium">
        {subject ? (
          <>
            Claude asked to run <Mono>{subject}</Mono>
          </>
        ) : (
          'Claude is asking for a decision'
        )}{' '}
        · answer on the{' '}
        <Link params={{ name }} replace search={{ view: 'terminal' }} to="/w/$name">
          Terminal tab
        </Link>
      </Text>
    </Card>
  )
}
