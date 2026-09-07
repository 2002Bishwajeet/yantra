import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowUp } from 'lucide-react'
import type { AgentState, Workspace } from '@/api'
import { LINES, type Said } from '@/api/hooks'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { IconButton } from '@/m3/icon-button/IconButton'
import { State } from '@/m3/mark/Mark'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { type Prompt, usePane } from './pane'
import { home } from './format'
import { ending } from './verbs'
import { Turns } from './Turns'

/** "Claude is asking": the agent's own dialog as rows. Each row types its
 *  number and Enter into the pane; the answer is Claude's, not Yantra's. */
function Asking(props: { prompt: Prompt; repo: string; onAnswer: (number: string) => void }) {
  const { prompt, repo, onAnswer } = props
  return (
    <Card className="chat__asking" surface="primary">
      <div className="chat__asking-head">
        <Eyebrow>Claude is asking</Eyebrow>
        <Text as="h3" scale="title-large">
          {prompt.kind === 'Bash command' && prompt.subject ? (
            <>
              Run <Mono>{prompt.subject}</Mono> in <Mono>{home(repo)}</Mono>?
            </>
          ) : prompt.subject ? (
            <>
              {prompt.kind ?? prompt.question} <Mono>{prompt.subject}</Mono>
            </>
          ) : (
            prompt.question
          )}
        </Text>
      </div>
      <ol className="chat__options">
        {prompt.options.map((option, index) => (
          <li key={option.number}>
            <button className="chat__option m3-interactive" onClick={() => onAnswer(option.number)} type="button">
              <Mono className="chat__option-number">{option.number}</Mono>
              <span className="chat__option-label">{option.label}</span>
              {index === 0 ? <Mono className="chat__option-hint">then Enter</Mono> : null}
            </button>
          </li>
        ))}
      </ol>
      <Text as="p" scale="body-small">
        each option types its number into the pane; the answer is Claude's, not Yantra's
      </Text>
    </Card>
  )
}

function Ended(props: { workspace: Workspace; state: AgentState; paneOpen: boolean; actions: ReactNode }) {
  const { workspace, state, paneOpen, actions } = props
  return (
    <div className="chat__ended">
      <Card className="chat__end" surface="high">
        <div className="chat__end-text">
          <State state={state.state === 'finished' || state.state === 'stopped' ? 'idle' : 'failed'}>
            <Text scale="title-medium">{state.state}</Text>
          </State>
          <Text as="p" scale="body-small" tone="variant">
            {ending(state)} in tmux {workspace.name} on {workspace.machine}. The transcript above is frozen;{' '}
            {paneOpen ? 'the pane is still open on the Terminal tab.' : 'the tmux session is gone.'}
          </Text>
        </div>
        {actions}
      </Card>
      <Text as="p" scale="body-small" tone="variant">
        Resume starts claude again in the same pane and does not ask. Delete removes the workspace and
        asks first.
      </Text>
    </div>
  )
}

export type ChatProps = {
  workspace: Workspace
  state: AgentState | null
  said: Said
  now: number
  onRead: (lines: number, before: number) => void
  paneOpen: boolean
  /** Resume and Delete, for the end card. */
  endActions: ReactNode
}

/** The transcript made writable (the `y332-chat` note): turns from the JSONL
 *  read over ssh, a composer that types into the tmux pane, and the trust
 *  prompt's options sending the number the agent's own dialog expects.
 *  Nothing polls: the transcript is re-read after a send and on Refresh
 *  (ADR-0019). Live chat is Y-356. */
export function Chat(props: ChatProps) {
  const { workspace, state, said, now, onRead, paneOpen, endActions } = props

  // Mounting the view is the request (ADR-0019), and an ended session is read
  // here too: its turns are frozen, not absent.
  useEffect(() => {
    if (said.said === 'no') onRead(LINES, 0)
  }, [said.said, onRead])

  const over = state !== null && ending(state) !== null
  return over && state ? (
    <div className="chat">
      <div className="chat__turns">
        <Turns machine={workspace.machine} now={now} onRead={onRead} said={said} />
      </div>
      <Ended actions={endActions} paneOpen={paneOpen} state={state} workspace={workspace} />
    </div>
  ) : (
    <LiveChat {...props} />
  )
}

function LiveChat(props: ChatProps) {
  const { workspace, said, now, onRead } = props
  const [opened, reopen] = useState(0)
  const pane = usePane({ workspace: workspace.name, machine: workspace.machine }, opened)
  const [draft, setDraft] = useState('')
  const [typed, setTyped] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)

  // The newest turn is at the bottom, as a chat is read.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [said])

  const refresh = () => onRead(LINES, 0)
  const refused = pane.refused

  const answer = (number: string) => {
    pane.type(`${number}\r`)
    setTyped(`Typed ${number} and Enter into the pane.`)
    refresh()
  }

  const send = () => {
    const text = draft.trim()
    if (text === '') return
    pane.type(`${text}\r`)
    setDraft('')
    setTyped('Typed your message into the pane.')
    refresh()
  }

  const machine = (
    <Link params={{ machine: workspace.machine }} to="/m/$machine">
      {workspace.machine}
    </Link>
  )

  return (
    <div className="chat">
      <div className="chat__turns">
        <Turns machine={workspace.machine} now={now} onRead={onRead} said={said} />
        {pane.prompt ? <Asking onAnswer={answer} prompt={pane.prompt} repo={workspace.repo} /> : null}
        <div ref={end} />
      </div>
      {refused ? (
        <ErrorSurface.Inline
          error={{ kind: refused.kind, said: refused.said, retryable: true, describe: () => refused.describe() }}
          eyebrow={`on ${workspace.machine}`}
          reset={() => reopen((n) => n + 1)}
          title="The pane could not be reached, so nothing can be typed"
          action={
            <Button
              role="link"
              render={<Link params={{ name: workspace.name }} replace search={{ view: 'terminal' }} to="/w/$name" />}
              variant="text"
            >
              Terminal
            </Button>
          }
        />
      ) : null}
      <div className="chat__composer">
        <form
          className="chat__field"
          onSubmit={(event) => {
            event.preventDefault()
            send()
          }}
        >
          <TextField
            autoComplete="off"
            disabled={pane.refused !== null || pane.over}
            label={`Message Claude in ${workspace.name}`}
            onChange={(event) => setDraft(event.target.value)}
            trailing={
              <IconButton disabled={draft.trim() === '' || !pane.link.up} label="Send" type="submit" variant="filled">
                <ArrowUp />
              </IconButton>
            }
            value={draft}
            variant="filled"
          />
        </form>
        <p className="chat__foot" role="status">
          {typed ?? (
            <>
              typed into the tmux pane on {machine} · turns appear when the transcript is read again,
              after every send or on Refresh — about 5 s behind the pane
            </>
          )}
        </p>
      </div>
    </div>
  )
}
