import { useEffect, useId, useRef, useState } from 'react'
import { ArrowUp, ImagePlus, Square, X } from 'lucide-react'
import Markdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import type { Workspace } from '@/api'
import { AttachError, IMAGE_TYPES, type ChatError } from '@/api/chat'
import { LABEL, type Harness, type ItemType, type RequestOpened } from '@/api/thread'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Copyable } from '@/m3/copyable/Copyable'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { IconButton } from '@/m3/icon-button/IconButton'
import { State, type MarkState } from '@/m3/mark/Mark'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { useFormFactor } from '@/shell/formFactor'
import { HarnessPicker } from './HarnessPicker'
import type { Message, Timeline, Tool } from './timeline'
import { useChat, type Link } from './useChat'

// Module constants, so the renderer is not handed new plugin lists per delta.
const REMARK = [remarkGfm]
const REHYPE = [rehypeSanitize]

const KIND: Record<ItemType, string> = {
  command_execution: 'Command',
  file_change: 'File change',
  web_search: 'Web',
  dynamic_tool_call: 'Tool',
}

const ASKS: Record<RequestOpened['requestType'], string> = {
  exec_command_approval: 'asks to run',
  file_change_approval: 'asks to change',
  file_read_approval: 'asks to read',
  dynamic_tool_call: 'asks to use a tool',
}

function Said(props: { message: Message; agent: string }) {
  const { message, agent } = props
  if (message.who === 'thinking') {
    return (
      <details className="chat__thinking">
        <summary>Thinking</summary>
        <p>{message.text}</p>
      </details>
    )
  }
  return (
    <article className="turn" data-who={message.who}>
      <header className="turn__head">
        <Eyebrow>{message.who === 'agent' ? agent : message.who}</Eyebrow>
      </header>
      {message.who === 'you' ? (
        <p className="turn__text">{message.text}</p>
      ) : (
        // ADR-0026 decision 4: GFM, sanitised, and no raw HTML is parsed.
        <div className="turn__text chat__markdown">
          <Markdown rehypePlugins={REHYPE} remarkPlugins={REMARK}>
            {message.text}
          </Markdown>
        </div>
      )}
    </article>
  )
}

const STATUS: Record<Tool['status'], { state: MarkState; word: string }> = {
  inProgress: { state: 'running', word: 'running' },
  completed: { state: 'done', word: 'done' },
  failed: { state: 'failed', word: 'failed' },
}

function ToolCard(props: { tool: Tool }) {
  const { tool } = props
  const status = STATUS[tool.status]
  return (
    <Card className="chat__tool" render={<article />} surface="low">
      <div className="chat__tool-head">
        <Eyebrow>{KIND[tool.itemType]}</Eyebrow>
        <State size="small" state={status.state}>
          {status.word}
        </State>
      </div>
      {tool.title ? <Mono className="chat__tool-title">{tool.title}</Mono> : null}
      {tool.output ? (
        <details className="chat__tool-output">
          <summary>Output</summary>
          <pre>{tool.output}</pre>
        </details>
      ) : null}
    </Card>
  )
}

/** The agent's own question, with the three answers the chat offers. */
function Asking(props: {
  request: RequestOpened
  agent: string
  onAnswer: (decision: 'accept' | 'acceptAlways' | 'decline') => boolean
}) {
  const { request, agent, onAnswer } = props
  // The card stays until the daemon says `request.resolved`; a second answer
  // before then reaches no pending request.
  const [answered, setAnswered] = useState(false)
  const answer = (decision: 'accept' | 'acceptAlways' | 'decline') => {
    if (onAnswer(decision)) setAnswered(true)
  }
  return (
    <Card className="chat__asking" surface="primary">
      <div className="chat__asking-head">
        <Eyebrow>{`${agent} ${ASKS[request.requestType]}`}</Eyebrow>
        <Text render={<h3 />} scale="title-medium">
          {request.title ? <Mono>{request.title}</Mono> : (request.detail ?? 'a tool')}
        </Text>
        {request.title && request.detail ? (
          <Text render={<p />} scale="body-medium">
            {request.detail}
          </Text>
        ) : null}
      </div>
      <div className="chat__answers">
        <Button disabled={answered} onClick={() => answer('accept')}>
          Accept
        </Button>
        <Button disabled={answered} onClick={() => answer('acceptAlways')} variant="tonal">
          Accept always
        </Button>
        <Button disabled={answered} onClick={() => answer('decline')} variant="text">
          Decline
        </Button>
      </div>
    </Card>
  )
}

/** How full the context window is, from the last turn's usage. */
function Meter(props: { usage: NonNullable<Timeline['usage']> }) {
  const { used, max } = props.usage
  const share = Math.round((used / max) * 100)
  return (
    <div className="chat__meter">
      <meter aria-label="Context used" max={max} min={0} value={used} />
      <Mono>
        context {share}% · {Math.round(used / 1000)}k of {Math.round(max / 1000)}k
      </Mono>
    </div>
  )
}

/** What the polite region says, and the line under the composer shows. */
function status(timeline: Timeline, harness: Harness | null, machine: string, phone: boolean): string {
  const agent = harness ? LABEL[harness] : 'The agent'
  if (timeline.requests.length > 0) return `${agent} is waiting for your answer.`
  if (timeline.turn === 'stopping') return `Stopping ${agent}…`
  if (timeline.turn !== 'idle') return `${agent} is answering.`
  if (timeline.ended?.state === 'cancelled') return `${agent} stopped.`
  if (timeline.ended?.state === 'completed') return `${agent} finished.`
  return phone
    ? 'Each turn runs in this chat’s own worktree.'
    : `Each turn runs ${harness ?? 'the agent'} in this chat’s own worktree on ${machine}, apart from the terminal’s.`
}

/** A harness with no login: the command to run on its machine, and a Retry
 *  for once it has run (ADR-0033 decision 6). */
function LoggedOut(props: { error: ChatError; login: NonNullable<ChatError['login']>; retry: () => void }) {
  const { error, login, retry } = props
  return (
    <ErrorSurface.Inline
      action={
        <>
          <Copyable text={login.command} what={`how to log ${LABEL[login.harness]} in`} />
          <Button onClick={retry} variant="text">
            Retry
          </Button>
        </>
      }
      error={error}
      eyebrow={`on ${login.machine}`}
      title={`${LABEL[login.harness]} is not logged in on ${login.machine}`}
    />
  )
}

/** One image in the composer: a local preview, and how its upload went. */
type Picked = { id: number; url: string } & (
  | { state: 'uploading' }
  | { state: 'attached'; path: string }
  | { state: 'failed'; error: AttachError }
)

/** The composer's images (Y-424). Each uploads as it is added, and its
 *  preview URL is revoked when it goes or the chat does. */
function useImages(attach: (file: Blob) => Promise<string>, link: Link) {
  const [images, setImages] = useState<Picked[]>([])
  const next = useRef(1)
  const urls = useRef(new Map<number, string>())

  // The daemon removes a socket's images when the socket closes, and Retry
  // opens a socket with none, so a path from the old socket names nothing.
  const [was, setWas] = useState(link)
  if (link !== was) {
    setWas(link)
    if (link !== 'open') {
      setImages((now) =>
        now.map((one) =>
          one.state === 'attached' ? { id: one.id, url: one.url, state: 'failed', error: new AttachError('closed') } : one,
        ),
      )
    }
  }

  useEffect(() => {
    const held = urls.current
    return () => {
      for (const url of held.values()) URL.revokeObjectURL(url)
      held.clear()
    }
  }, [])

  const settle = (id: number, change: (one: Picked) => Picked) =>
    setImages((now) => now.map((one) => (one.id === id ? change(one) : one)))

  const forget = (ids: Iterable<number>) => {
    for (const id of ids) {
      const url = urls.current.get(id)
      if (url) URL.revokeObjectURL(url)
      urls.current.delete(id)
    }
  }

  return {
    images,
    add: (files: Iterable<File>) => {
      for (const file of files) {
        const id = next.current++
        const url = URL.createObjectURL(file)
        urls.current.set(id, url)
        setImages((now) => [...now, { id, url, state: 'uploading' }])
        attach(file).then(
          (path) => settle(id, ({ url }) => ({ id, url, state: 'attached', path })),
          (cause: unknown) =>
            settle(id, ({ url }) => ({
              id,
              url,
              state: 'failed',
              error: cause instanceof AttachError ? cause : new AttachError('unreachable', String(cause)),
            })),
        )
      }
    },
    remove: (id: number) => {
      forget([id])
      setImages((now) => now.filter((one) => one.id !== id))
    },
    clear: () => {
      forget([...urls.current.keys()])
      setImages([])
    },
  }
}

const UPLOAD: Record<Exclude<Picked['state'], 'failed'>, string> = {
  uploading: 'Uploading…',
  attached: 'Attached',
}

function Images(props: { images: Picked[]; onRemove: (id: number) => void }) {
  const { images, onRemove } = props
  return (
    <ul aria-label="Images" aria-live="polite" className="chat__images">
      {images.map((one, at) => (
        <li className="chat__image" data-state={one.state} key={one.id}>
          <img alt={`Image ${at + 1}`} src={one.url} />
          <span className="chat__image-state">{one.state === 'failed' ? one.error.describe() : UPLOAD[one.state]}</span>
          <IconButton label={`Remove image ${at + 1}`} onClick={() => onRemove(one.id)} type="button">
            <X />
          </IconButton>
        </li>
      ))}
    </ul>
  )
}

export type ChatProps = {
  workspace: Workspace
  /** `?thread=`: the chat to continue. Read when the socket opens. */
  thread?: string
  /** The daemon named a new thread; the URL keeps it. */
  onThread: (thread: string) => void
}

/** The streaming chat (ADR-0026, Y-356, ADR-0033). The first turn picks the
 *  harness, and every turn runs in the thread's own git worktree, so it never
 *  writes the tree the Terminal tab's agent is in. Every harness draws on the
 *  one timeline. */
export function Chat(props: ChatProps) {
  const { workspace, thread, onThread } = props
  const chat = useChat(workspace.name, thread, onThread)
  const { timeline, error, link } = chat
  const [draft, setDraft] = useState('')
  const [picked, setPicked] = useState<Harness>('claude')
  // An attach knows its thread before the daemon says whose it is, so until
  // then it names no harness rather than the picker's default.
  const locked = timeline.thread !== null
  const harness = timeline.harness ?? error?.login?.harness ?? (locked ? null : picked)
  const agent = harness ? LABEL[harness] : 'the agent'
  // A first turn refused for its login never reaches the timeline, so the
  // words it carried come back to the composer. Its images do not: the
  // daemon removes them when the client closes the socket.
  const lastSent = useRef('')
  useEffect(() => {
    if (error?.kind === 'notLoggedIn' && timeline.entries.length === 0) setDraft((now) => now || lastSent.current)
  }, [error, timeline.entries.length])
  const { images, add, remove, clear } = useImages(chat.attach, link)
  const [dropping, setDropping] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const why = useId()
  const phone = useFormFactor() === 'phone'
  const busy = timeline.turn !== 'idle'

  // The newest words are at the bottom, but a reader who scrolled up is not
  // dragged down by every delta: the foot leaving the viewport unpins it.
  useEffect(() => {
    const foot = end.current
    if (!foot || typeof IntersectionObserver === 'undefined') return
    const watching = new IntersectionObserver((seen) => {
      pinned.current = seen[seen.length - 1]?.isIntersecting ?? true
    })
    watching.observe(foot)
    return () => watching.disconnect()
  }, [])

  useEffect(() => {
    if (pinned.current) end.current?.scrollIntoView?.({ block: 'end' })
  }, [timeline.entries, timeline.requests])

  const uploading = images.some((one) => one.state === 'uploading')
  // The agent reads an image by its path, so each goes on a line of its own.
  const text = [draft.trim(), ...images.flatMap((one) => (one.state === 'attached' ? [one.path] : []))]
    .filter((line) => line !== '')
    .join('\n')

  const send = () => {
    if (text === '' || busy || uploading) return
    if (chat.send(text, locked ? undefined : picked)) {
      lastSent.current = draft.trim()
      setDraft('')
      clear()
    }
  }

  const cannotSend =
    link !== 'open'
      ? 'The chat is not connected, so nothing can be sent.'
      : busy
        ? `${agent} is answering. Stop it to send something else.`
        : uploading
          ? 'An image is still uploading. Send once it is attached.'
          : text === ''
            ? 'Type a message to send it.'
            : null

  return (
    <div className="chat">
      <section aria-label="Conversation" className="chat__turns">
        {timeline.entries.length === 0 && link !== 'connecting' ? (
          <Text className="chat__empty" render={<p />} scale="body-medium" tone="variant">
            Ask {agent} something about {workspace.name}. It works on a branch of its own, so the session in the
            terminal is untouched.
          </Text>
        ) : null}
        {timeline.entries.map((entry) =>
          entry.kind === 'message' ? <Said agent={agent} key={entry.id} message={entry} /> : <ToolCard key={entry.id} tool={entry} />,
        )}
        {timeline.requests.map((request) => (
          <Asking
            agent={agent}
            key={request.requestId}
            onAnswer={(decision) => chat.answer(request.requestId, decision)}
            request={request}
          />
        ))}
        <div ref={end} />
      </section>
      {error?.login ? (
        <LoggedOut error={error} login={error.login} retry={chat.retry} />
      ) : error ? (
        <ErrorSurface.Inline
          error={error}
          eyebrow={`on ${workspace.machine}`}
          reset={chat.retry}
          title={error.kind === 'turnFailed' ? 'The turn failed' : 'The chat could not go on'}
        />
      ) : null}
      <div
        className="chat__composer"
        data-dropping={dropping ? '' : undefined}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false)
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setDropping(true)
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length === 0) return
          event.preventDefault()
          setDropping(false)
          add(event.dataTransfer.files)
        }}
      >
        {dropping ? (
          <p aria-hidden="true" className="chat__drop">
            Drop an image to attach it.
          </p>
        ) : null}
        <div className="chat__controls">
          <IconButton
            disabled={link !== 'open'}
            label="Attach an image"
            onClick={() => picker.current?.click()}
            type="button"
          >
            <ImagePlus />
          </IconButton>
          <input
            accept={IMAGE_TYPES.join(',')}
            hidden
            multiple
            onChange={(event) => {
              if (event.target.files) add(event.target.files)
              // The same file picked twice is a second image.
              event.target.value = ''
            }}
            ref={picker}
            type="file"
          />
          {harness ? (
            <HarnessPicker
              disabled={busy || link !== 'open'}
              locked={locked}
              onChange={setPicked}
              value={harness}
            />
          ) : null}
          {timeline.usage ? <Meter usage={timeline.usage} /> : null}
        </div>
        {images.length > 0 ? <Images images={images} onRemove={remove} /> : null}
        <form
          className="chat__field"
          onSubmit={(event) => {
            event.preventDefault()
            send()
          }}
        >
          <TextField
            autoComplete="off"
            disabled={link === 'closed'}
            label={phone ? `Message ${agent}` : `Message ${agent} in ${workspace.name}`}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => {
              if (event.clipboardData.files.length === 0) return
              event.preventDefault()
              add(event.clipboardData.files)
            }}
            trailing={
              busy ? (
                <IconButton
                  disabled={timeline.turn === 'stopping'}
                  label={`Stop ${agent}`}
                  onClick={chat.stop}
                  type="button"
                >
                  <Square />
                </IconButton>
              ) : (
                <IconButton
                  aria-describedby={cannotSend ? why : undefined}
                  disabled={cannotSend !== null}
                  label="Send"
                  type="submit"
                  variant="filled"
                >
                  <ArrowUp />
                </IconButton>
              )
            }
            value={draft}
            variant="filled"
          />
          {cannotSend ? (
            <span className="m3-sr-only" id={why}>
              {cannotSend}
            </span>
          ) : null}
        </form>
        {/* 4.1.3: the turn's state, said politely and shown. */}
        <p className="chat__foot" role="status">
          {status(timeline, harness, workspace.machine, phone)}
        </p>
      </div>
    </div>
  )
}
