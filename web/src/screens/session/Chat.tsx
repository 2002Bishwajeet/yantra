import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Diff, ImagePlus, RefreshCw } from 'lucide-react'
import Markdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import type { Workspace } from '@/api'
import { IMAGE_TYPES, type ChatError } from '@/api/chat'
import { LABEL, type Harness, type ItemType, type PermissionMode, type RequestOpened } from '@/api/thread'
import { Attachments } from '@/composer/Attachments'
import * as Composer from '@/composer/Composer'
import { Icon as ControlIcon, Control, Separator } from '@/composer/Control'
import { ContextRing } from '@/composer/ContextRing'
import { draftId, useDraft } from '@/composer/draft'
import { useEnterSends } from '@/composer/enterSends'
import { buildPromptHistoryEntries, stepPromptHistory, type PromptHistoryPosition } from '@/composer/history'
import { placeholder } from '@/composer/placeholder'
import { PlanBadge } from '@/composer/PlanBadge'
import { PrimaryAction } from '@/composer/PrimaryAction'
import { useImages } from '@/composer/useImages'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Copyable } from '@/m3/copyable/Copyable'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State, type MarkState } from '@/m3/mark/Mark'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import { appendToDraft } from './diff/comment'
import { branchData, type DiffState } from './diff/data'
import { DiffSheet } from './diff/DiffSheet'
import { useEditors } from './diff/useEditors'
import { HarnessPicker } from './HarnessPicker'
import { keepMode, recallMode } from './mode'
import { ModePicker } from './ModePicker'
import type { Message, Timeline, Tool } from './timeline'
import { TurnDiff } from './TurnDiff'
import { useChat } from './useChat'

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

/** What the polite region says: only a change in the turn's state. */
function status(timeline: Timeline, harness: Harness | null): string {
  const agent = harness ? LABEL[harness] : 'The agent'
  if (timeline.requests.length > 0) return `${agent} is waiting for your answer.`
  if (timeline.turn === 'stopping') return `Stopping ${agent}…`
  if (timeline.turn !== 'idle') return `${agent} is answering.`
  if (timeline.ended?.state === 'cancelled') return `${agent} stopped.`
  if (timeline.ended?.state === 'completed') return `${agent} finished.`
  return ''
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

export type ChatProps = {
  workspace: Workspace
  /** `?thread=`: the chat to continue. Read when the socket opens. */
  thread?: string
  /** The daemon named a new thread; the URL keeps it. */
  onThread: (thread: string) => void
  /** Y-489: the issue's first text, from the picker that opened this thread. */
  initialDraft?: string
}

/** The streaming chat (ADR-0026, Y-356, ADR-0033). The first turn picks the
 *  harness, and every turn runs in the thread's own git worktree, so it never
 *  writes the tree the Terminal tab's agent is in. Every harness draws on the
 *  one timeline. */
export function Chat(props: ChatProps) {
  const { workspace, thread, onThread, initialDraft } = props
  const chat = useChat(workspace.name, thread, onThread)
  const { timeline, error, link } = chat
  const [draft, setDraft, recallInto] = useDraft(draftId(workspace.name, timeline.thread), initialDraft)
  const [showDiff, setShowDiff] = useState(false)
  const [added, setAdded] = useState(false)
  const diffButton = useRef<HTMLButtonElement>(null)
  const { branch } = chat
  // The viewer parses by identity, so a keystroke in the composer must not make a new one.
  const sheet = useMemo<DiffState>(
    () =>
      branch.state === 'ready'
        ? { state: 'ready', data: branchData(branch.diff) }
        : branch.state === 'failed'
          ? branch
          : { state: 'loading' },
    [branch],
  )
  const editors = useEditors(
    workspace.name,
    timeline.thread,
    showDiff || timeline.entries.some((entry) => entry.kind === 'diff'),
  )
  const [picked, setPicked] = useState<Harness>('claude')
  const [mode, setMode] = useState<PermissionMode>(() => recallMode(thread))
  // A new thread is named on its first turn, and keeps the mode it was sent with.
  useEffect(() => {
    if (timeline.thread) keepMode(timeline.thread, mode)
  }, [timeline.thread, mode])
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
  }, [error, timeline.entries.length, setDraft])
  const { images, add, remove, clear } = useImages(chat.attach, link)
  const [dropping, setDropping] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const busy = timeline.turn !== 'idle'
  const enterSends = useEnterSends()
  const box = useRef<HTMLTextAreaElement>(null)
  const recalled = useRef<PromptHistoryPosition | null>(null)
  const caretToEnd = useRef(false)
  const history = useMemo(
    () => buildPromptHistoryEntries(timeline.entries.filter((entry) => entry.kind === 'message')),
    [timeline.entries],
  )

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

  // The phone's dock is sticky, so a taller one (a plan, an error, a long draft) covers the newest words.
  // Session.css reads its height for scroll-padding, and a pinned reader is carried to the end again.
  useEffect(() => {
    const box = dock.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    const watching = new ResizeObserver(() => {
      root.style.setProperty('--chat-dock-height', `${box.offsetHeight}px`)
      // Only a sticky dock (the phone's) covers anything. It sits after the end, so its growth never moves
      // the end: where the end is now says if the reader is at the foot. The observer's own answer can be one scroll behind.
      const foot = end.current
      if (foot && getComputedStyle(box).position === 'sticky' && (pinned.current || foot.getBoundingClientRect().top <= window.innerHeight)) {
        foot.scrollIntoView?.({ block: 'end' })
      }
    })
    watching.observe(box)
    // The thread list above loads after the dock draws; the page grows and the dock would cover the intro or the last turn.
    const page = box.closest('.m3-page')
    if (page) watching.observe(page)
    return () => {
      watching.disconnect()
      root.style.removeProperty('--chat-dock-height')
    }
  }, [])

  const uploading = images.some((one) => one.state === 'uploading')
  // The agent reads an image by its path, so each goes on a line of its own.
  const text = [draft.trim(), ...images.flatMap((one) => (one.state === 'attached' ? [one.path] : []))]
    .filter((line) => line !== '')
    .join('\n')

  const send = () => {
    if (text === '' || busy || uploading) return
    if (chat.send(text, locked ? undefined : picked, mode)) {
      lastSent.current = draft.trim()
      recalled.current = null
      setDraft('')
      clear()
    }
  }

  // ArrowUp on the first line brings back the thread's earlier prompts, ArrowDown walks forward.
  const recall = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const up = event.key === 'ArrowUp'
    if (!up && event.key !== 'ArrowDown') return
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) return
    const field = event.currentTarget
    if (field.selectionStart !== field.selectionEnd) return
    const edge = up
      ? !field.value.slice(0, field.selectionStart).includes('\n')
      : !field.value.slice(field.selectionEnd).includes('\n')
    if (!edge) return
    const step = stepPromptHistory({
      direction: up ? 'backward' : 'forward',
      entries: history,
      position: recalled.current,
      currentPrompt: draft,
    })
    if (!step) return
    event.preventDefault()
    recalled.current = step.position
    caretToEnd.current = true
    recallInto(step.prompt)
  }

  useLayoutEffect(() => {
    if (!caretToEnd.current) return
    caretToEnd.current = false
    const field = box.current
    if (field) field.setSelectionRange(field.value.length, field.value.length)
  }, [draft])

  const answering = `${agent} is answering. Stop it to send something else.`
  const cannotSend =
    link !== 'open'
      ? 'The chat is not connected, so nothing can be sent.'
      : busy
        ? answering
        : uploading
          ? 'An image is still uploading. Send once it is attached.'
          : text === ''
            ? 'Type a message to send it.'
            : null

  const addComment = (block: string) => {
    setDraft((now) => appendToDraft(now, block))
    setAdded(true)
  }

  const asks = timeline.requests.map((request) => (
    <Asking
      agent={agent}
      key={request.requestId}
      onAnswer={(decision) => chat.answer(request.requestId, decision)}
      request={request}
    />
  ))

  const toggleDiff = () => {
    if (showDiff) {
      setShowDiff(false)
      setAdded(false)
      diffButton.current?.focus()
      return
    }
    setShowDiff(true)
    chat.requestDiff()
  }

  return (
    <div className="chat" data-branch={showDiff ? 'open' : undefined}>
      <div className="chat__bar">
        <Button
          aria-pressed={showDiff}
          icon={<Diff />}
          onClick={toggleDiff}
          ref={diffButton}
          variant={showDiff ? 'tonal' : 'text'}
        >
          Diff
        </Button>
        {showDiff ? (
          <Button
            aria-label="Refresh the diff"
            icon={<RefreshCw />}
            onClick={chat.requestDiff}
            variant="text"
          >
            Refresh
          </Button>
        ) : null}
        <span aria-live="polite" className="chat__added">
          {added ? 'Comment added to your message.' : ''}
        </span>
      </div>
      {showDiff ? (
        <section aria-label="Branch diff" className="chat__branch">
          <DiffSheet
            editors={editors}
            onComment={addComment}
            onRetry={chat.requestDiff}
            state={sheet}
            workspace={workspace}
          />
        </section>
      ) : null}
      {/* The diff hides the conversation, but the agent still waits on these. */}
      {showDiff && asks.length > 0 ? (
        <section aria-label="Waiting for your answer" className="chat__asks">
          {asks}
        </section>
      ) : null}
      <section aria-label="Conversation" className="chat__turns" hidden={showDiff}>
        {timeline.entries.length === 0 && link !== 'connecting' ? (
          <Text className="chat__empty" render={<p />} scale="body-medium" tone="variant">
            Ask {agent} something about {workspace.name}. It works on a branch of its own, so the session in the
            terminal is untouched.
          </Text>
        ) : null}
        {timeline.entries.map((entry) =>
          entry.kind === 'message' ? (
            <Said agent={agent} key={entry.id} message={entry} />
          ) : entry.kind === 'tool' ? (
            <ToolCard key={entry.id} tool={entry} />
          ) : (
            <TurnDiff
              disabled={busy || link !== 'open'}
              diff={entry}
              key={entry.id}
              editors={editors}
              onComment={addComment}
              onRevert={chat.revert}
              workspace={workspace}
            />
          ),
        )}
        {showDiff ? null : asks}
        <div ref={end} />
      </section>
      <div className="chat__dock" ref={dock}>
        {error?.login ? (
          <LoggedOut error={error} login={error.login} retry={chat.retry} />
        ) : error ? (
          <ErrorSurface.Inline
            error={error}
            eyebrow={`on ${workspace.machine}`}
            reset={chat.retry}
            title={
              error.kind === 'turnFailed'
                ? 'The turn failed'
                : error.kind === 'checkpoint'
                  ? 'The files could not be kept or put back'
                  : error.kind === 'diff'
                    ? "The branch's changes could not be read"
                    : 'The chat could not go on'
            }
          />
        ) : null}
        <Composer.Root
          above={<PlanBadge plan={timeline.plan} />}
          dropping={dropping}
          empty={draft === '' && images.length === 0}
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
          onSubmit={(event) => {
            event.preventDefault()
            send()
          }}
        >
          <Attachments images={images} onRemove={remove} />
          <Composer.Input
            aria-label={`Message ${agent} in ${workspace.name}`}
            disabled={link === 'closed'}
            enterSends={enterSends}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={recall}
            onPaste={(event) => {
              if (event.clipboardData.files.length === 0) return
              event.preventDefault()
              add(event.clipboardData.files)
            }}
            onSend={send}
            placeholder={placeholder({ link, waiting: timeline.requests.length > 0, agent, retryable: error?.retryable })}
            ref={box}
            value={draft}
          />
          <Composer.Footer
            actions={
              <>
                <ContextRing usage={timeline.usage} />
                <PrimaryAction
                  label="Send"
                  pending={uploading}
                  reason={cannotSend}
                  running={
                    busy
                      ? { agent, stopping: timeline.turn === 'stopping', onStop: chat.stop, reason: answering }
                      : null
                  }
                />
              </>
            }
            controls={
              <>
                <Control
                  aria-label="Attach an image"
                  disabled={link !== 'open'}
                  onClick={() => picker.current?.click()}
                >
                  <ControlIcon icon={ImagePlus} />
                </Control>
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
                <Separator />
                {harness ? (
                  <HarnessPicker
                    disabled={busy || link !== 'open'}
                    locked={locked}
                    onChange={setPicked}
                    value={harness}
                  />
                ) : null}
                <ModePicker disabled={link !== 'open'} onChange={setMode} value={mode} />
              </>
            }
          />
        </Composer.Root>
        {/* 4.1.3: the turn's state, said politely and shown, except while the empty field's placeholder says it. */}
        <Composer.Status quiet={timeline.requests.length > 0 && draft === '' && link === 'open'}>
          {status(timeline, harness)}
        </Composer.Status>
      </div>
    </div>
  )
}
