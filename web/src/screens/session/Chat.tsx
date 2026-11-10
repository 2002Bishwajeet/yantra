import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ImagePlus } from 'lucide-react'
import type { Mentions, SlashCommand, Workspace } from '@/api'
import { IMAGE_TYPES, type ChatError } from '@/api/chat'
import { asApiError } from '@/api/errors'
import { useCommands, useMentions } from '@/api/queries'
import {
  LABEL,
  lengthsFor,
  type ClaudeModel,
  type ContextLength,
  type Effort,
  type Decision,
  type Harness,
  type Interaction,
  type PermissionMode,
  type RequestOpened,
} from '@/api/thread'
import { Attachments } from '@/composer/Attachments'
import * as Composer from '@/composer/Composer'
import { Icon as ControlIcon, Control, Separator } from '@/composer/Control'
import { ContextRing } from '@/composer/ContextRing'
import { draftId, useDraft } from '@/composer/draft'
import { useEnterSends } from '@/composer/enterSends'
import { buildPromptHistoryEntries, stepPromptHistory, type PromptHistoryPosition } from '@/composer/history'
import { MentionMenu, optionId, type MentionItem } from '@/composer/MentionMenu'
import { placeholder } from '@/composer/placeholder'
import { PlanBadge } from '@/composer/PlanBadge'
import { PrimaryAction } from '@/composer/PrimaryAction'
import { searchCommands } from '@/composer/searchCommands'
import { searchMentions } from '@/composer/searchMentions'
import { detectTrigger, insertMention, type Trigger } from '@/composer/trigger'
import { useDockHeight } from '@/composer/useDockHeight'
import { useImages } from '@/composer/useImages'
import { Button } from '@/m3/button/Button'
import { Copyable } from '@/m3/copyable/Copyable'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { EmptyState } from '@/m3/empty-state/EmptyState'
import { Eyebrow } from '@/m3/text/Text'
import { BackgroundWork } from './BackgroundWork'
import { appendToDraft } from './diff/comment'
import { branchData, type DiffState } from './diff/data'
import { DiffSheet } from './diff/DiffSheet'
import { useEditors } from './diff/useEditors'
import { ChatMarkdown } from './markdown/ChatMarkdown'
import { ChatHeader } from './ChatHeader'
import { HarnessPicker } from './HarnessPicker'
import { ContextPicker } from './ContextPicker'
import { EffortPicker } from './EffortPicker'
import {
  keepContext,
  keepEffort,
  keepInteraction,
  keepMode,
  keepModel,
  recallContext,
  recallEffort,
  recallInteraction,
  recallMode,
  recallModel,
} from './mode'
import { ModePicker } from './ModePicker'
import { ModelPicker } from './ModelPicker'
import { PendingApproval } from './PendingApproval'
import { PendingQuestion } from './PendingQuestion'
import { PlanToggle } from './PlanToggle'
import { TerminalDrawer } from './TerminalDrawer'
import type { Message, Timeline } from './timeline'
import { TurnDiff } from './TurnDiff'
import { useChat } from './useChat'
import { WorkLog } from './WorkLog'
import { workRows } from './workLog.logic'

function Said(props: { message: Message; agent: string; machine: string; worktree: string | null }) {
  const { message, agent, machine, worktree } = props
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
          <ChatMarkdown machine={machine} text={message.text} worktree={worktree} />
        </div>
      )}
    </article>
  )
}

/** What the polite region says: only a change in the turn's state. */
function status(timeline: Timeline, harness: Harness | null): string {
  const agent = harness ? LABEL[harness] : 'The agent'
  if (timeline.requests.length > 0) return `${agent} is waiting for your answer.`
  if (timeline.turn === 'stopping') return `Stopping ${agent}…`
  if (timeline.turn !== 'idle' && timeline.queued.length > 0) {
    const n = timeline.queued.length
    return `${agent} is answering. ${n} ${n === 1 ? 'message is' : 'messages are'} queued.`
  }
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

/** What the menu lists for an open trigger; each id is the token a pick inserts. */
function mentionItems(
  kind: Trigger['kind'],
  query: string,
  found: Mentions | undefined,
  commands: readonly SlashCommand[] | undefined,
): MentionItem[] {
  if (kind === 'command') {
    return searchCommands(commands ?? [], query).map((command) => ({
      id: `/${command.name}`,
      label: `/${command.name}`,
      description: command.description,
      hint: command.hint,
    }))
  }
  if (!found) return []
  if (kind === 'path') {
    return searchMentions(found.files, query, (file) => file).map((file) => ({ id: `@${file}`, label: file, description: '' }))
  }
  return searchMentions(found.skills, query, (skill) => skill.name).map((skill) => ({
    id: skill.mention,
    label: skill.mention,
    description: skill.description,
    badge: skill.scope === 'user' ? 'Personal' : 'Project',
  }))
}

/** An ACP agent sends its commands once its session opens, which is on the first turn. */
const NO_COMMANDS_YET = 'The commands appear after the agent’s first reply.'

export type ChatProps = {
  workspace: Workspace
  /** `?thread=`: the chat to continue. Read when the socket opens. */
  thread?: string
  /** The daemon named a new thread; the URL keeps it. */
  onThread: (thread: string) => void
  /** Y-489: the issue's first text, from the picker that opened this thread. */
  initialDraft?: string
  /** Y-633: where the header draws, in the page's one bar. */
  slot?: HTMLElement | null
}

/** The streaming chat (ADR-0026, Y-356, ADR-0033). The first turn picks the
 *  harness, and every turn runs in the thread's own git worktree, so it never
 *  writes the tree the Terminal tab's agent is in. Every harness draws on the
 *  one timeline. */
export function Chat(props: ChatProps) {
  const { workspace, thread, onThread, initialDraft, slot } = props
  const chat = useChat(workspace.name, thread, onThread)
  const { timeline, error, link } = chat
  const [draft, setDraft, recallInto] = useDraft(draftId(workspace.name, timeline.thread), initialDraft)
  const [showDiff, setShowDiff] = useState(false)
  const [showTerminal, setShowTerminal] = useState(false)
  const terminalButton = useRef<HTMLButtonElement>(null)
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
    showDiff || timeline.entries.some((entry) => entry.kind === 'diff' || (entry.kind === 'message' && entry.who === 'agent')),
  )
  const [picked, setPicked] = useState<Harness>('claude')
  const [mode, setMode] = useState<PermissionMode>(() => recallMode(thread))
  const [model, setModel] = useState<ClaudeModel | null>(() => recallModel(thread))
  const [effort, setEffort] = useState<Effort | null>(() => recallEffort(thread))
  const [context, setContext] = useState<ContextLength | null>(() => recallContext(thread))
  // A new thread is named on its first turn, and keeps the mode, model, effort and context length it was sent with.
  useEffect(() => {
    if (!timeline.thread) return
    keepMode(timeline.thread, mode)
    keepModel(timeline.thread, model)
    keepEffort(timeline.thread, effort)
    keepContext(timeline.thread, context)
  }, [timeline.thread, mode, model, effort, context])
  const [interaction, setInteraction] = useState<Interaction>(() => recallInteraction(thread))
  useEffect(() => {
    if (timeline.thread) keepInteraction(timeline.thread, interaction)
  }, [timeline.thread, interaction])
  // An attach knows its thread before the daemon says whose it is, so until
  // then it names no harness rather than the picker's default.
  const locked = timeline.thread !== null
  const harness = timeline.harness ?? error?.login?.harness ?? (locked ? null : picked)
  const agent = harness ? LABEL[harness] : 'the agent'
  // Only Claude has a plan mode, so another harness's turn is a build turn whatever was kept.
  const planning = harness === 'claude' ? interaction : 'build'
  const lengths = lengthsFor(harness, model, timeline.usage?.max)
  const pickModel = (next: ClaudeModel | null) => {
    setModel(next)
    // A length the new model does not allow goes back to the default.
    if (!lengthsFor(harness, next).some((one) => one.length === context)) setContext(null)
  }
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
  const rows = useMemo(() => workRows(timeline), [timeline])
  const diffs = timeline.entries.filter((entry) => entry.kind === 'diff').length
  const enterSends = useEnterSends()
  const box = useRef<HTMLTextAreaElement>(null)
  const recalled = useRef<PromptHistoryPosition | null>(null)
  const caretTo = useRef<number | null>(null)
  // Y-562: `@` and `$` open a menu of the worktree's files and the harness's skills.
  const [caret, setCaret] = useState(0)
  // Escape shuts the trigger that starts here until the text changes.
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const found = detectTrigger(draft, caret)
  const trigger = found && found.start !== dismissed ? found : null
  const menu = useId()
  const kind = trigger?.kind
  const mentions = useMentions(workspace.name, timeline.thread, harness ?? 'claude', kind === 'path' || kind === 'skill')
  // Y-563: Claude is asked for its commands; an ACP agent sent its own on the socket.
  const asksClaude = (harness ?? 'claude') === 'claude'
  const claudeCommands = useCommands(workspace.name, timeline.thread, 'claude', kind === 'command' && asksClaude)
  const commands = asksClaude ? claudeCommands.data?.commands : timeline.commands
  const asked = kind === 'command' ? (asksClaude ? claudeCommands : null) : mentions
  const query = trigger?.query ?? ''
  const items = useMemo(
    () => (kind ? mentionItems(kind, query, mentions.data, commands) : []),
    [kind, query, mentions.data, commands],
  )
  const at = Math.min(active, items.length - 1)
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

  // A pinned reader is carried to the end again when the dock grows, since it sits after the end and never moves it.
  // Where the end is now says if the reader is at the foot; the observer's own answer can be one scroll behind.
  useDockHeight(dock, () => {
    const foot = end.current
    if (foot && (pinned.current || foot.getBoundingClientRect().top <= window.innerHeight)) {
      foot.scrollIntoView?.({ block: 'end' })
    }
  })

  const uploading = images.some((one) => one.state === 'uploading')
  // The agent reads an image by its path, so each goes on a line of its own.
  const compose = (words: string) =>
    [words.trim(), ...images.flatMap((one) => (one.state === 'attached' ? [one.path] : []))]
      .filter((line) => line !== '')
      .join('\n')
  const text = compose(draft)

  const sendWords = (words: string) => {
    const out = compose(words)
    if (out === '' || uploading) return
    const claude = harness === 'claude'
    const length = lengths.some((one) => one.length === context) ? context : null
    if (chat.send(out, locked ? undefined : picked, mode, planning, claude ? model : null, claude ? effort : null, length)) {
      lastSent.current = words.trim()
      recalled.current = null
      setDraft('')
      clear()
    }
  }
  const send = () => sendWords(draft)

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
    caretTo.current = step.prompt.length
    recallInto(step.prompt)
  }

  const pick = (item: MentionItem) => {
    if (!trigger) return
    // A command with no argument is sent as it is picked; one with an argument waits for it.
    if (trigger.kind === 'command' && !item.hint) {
      sendWords(`${item.id}${draft.slice(trigger.end)}`)
      return
    }
    const next = insertMention(draft, trigger, item.id)
    caretTo.current = next.caret
    setDraft(next.text)
  }

  // While the menu is open it has the arrows, Escape, and Enter and Tab when there is a row to pick.
  const keydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (trigger && !event.nativeEvent.isComposing) {
      const { key } = event
      if (key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setDismissed(trigger.start)
        return
      }
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault()
        if (items.length > 0) setActive((at + (key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
        return
      }
      const item = items[at]
      if ((key === 'Enter' || key === 'Tab') && item && !event.shiftKey) {
        event.preventDefault()
        pick(item)
        return
      }
    }
    recall(event)
  }

  useLayoutEffect(() => {
    const to = caretTo.current
    if (to === null) return
    caretTo.current = null
    box.current?.setSelectionRange(to, to)
    setCaret(to)
  }, [draft])

  const answering = `${agent} is answering. A message you queue is sent when it ends.`
  const cannotSend =
    link !== 'open'
      ? 'The chat is not connected, so nothing can be sent.'
      : uploading
        ? 'An image is still uploading. Send once it is attached.'
        : text === ''
          ? 'Type a message to send it.'
          : null

  // Stop drops the queue too, so its text comes back to an empty field.
  const stop = () => {
    if (timeline.queued.length > 0) setDraft((now) => now || timeline.queued.join('\n\n'))
    chat.stop()
  }

  const addComment = (block: string) => {
    setDraft((now) => appendToDraft(now, block))
    setAdded(true)
  }
  // Y-495: Fix with agent fills the composer and hands it the caret. The owner sends.
  const fixWithAgent = (block: string) => {
    addComment(block)
    box.current?.focus()
  }

  const [asked1, ...others] = timeline.requests
  const answerOf = (request: RequestOpened) => (decision: Decision, answers?: Record<string, string[]>) =>
    chat.answer(request.requestId, decision, answers)

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

  const closeTerminal = () => {
    setShowTerminal(false)
    terminalButton.current?.focus()
  }

  return (
    <div className="chat" data-branch={showDiff ? 'open' : undefined}>
      <ChatHeader
        added={added}
        busy={busy}
        diff={{ open: showDiff, onToggle: toggleDiff, onRefresh: chat.requestDiff }}
        diffRef={diffButton}
        diffs={diffs}
        into={slot}
        onFix={fixWithAgent}
        terminal={{ open: showTerminal, onToggle: () => (showTerminal ? closeTerminal() : setShowTerminal(true)) }}
        terminalRef={terminalButton}
        thread={timeline.thread}
        urlThread={thread}
        workspace={workspace.name}
      />
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
      <section aria-label="Conversation" className="chat__turns" hidden={showDiff}>
        {timeline.entries.length === 0 && link !== 'connecting' ? (
          <EmptyState title="Nothing asked yet">
            Ask {agent} something about {workspace.name}. It works on a branch of its own, so the session in the
            terminal is untouched.
          </EmptyState>
        ) : null}
        {rows.map((row) =>
          row.kind === 'work' ? (
            <WorkLog
              key={row.id}
              said={(message) => (
                <Said agent={agent} machine={workspace.machine} message={message} worktree={editors.worktree} />
              )}
              work={row}
            />
          ) : row.entry.kind === 'message' ? (
            <Said
              agent={agent}
              key={row.entry.id}
              machine={workspace.machine}
              message={row.entry}
              worktree={editors.worktree}
            />
          ) : row.entry.kind === 'diff' ? (
            <TurnDiff
              disabled={busy || link !== 'open'}
              diff={row.entry}
              key={row.entry.id}
              editors={editors}
              onComment={addComment}
              onRevert={chat.revert}
              workspace={workspace}
            />
          ) : null,
        )}
        <div ref={end} />
      </section>
      <div className="composer-dock" ref={dock}>
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
                    : error.kind === 'stopTask'
                      ? 'The background task could not be stopped'
                      : 'The chat could not go on'
            }
          />
        ) : null}
        <BackgroundWork
          disabled={link !== 'open'}
          onStop={chat.stopTask}
          onStopAll={chat.stopAll}
          tasks={timeline.background}
        />
        {timeline.queued.length > 0 ? (
          <section aria-label="Queued messages" className="chat__queued">
            <p className="chat__queued-title">Queued, sends when {agent} ends</p>
            <ul>
              {timeline.queued.map((queued, n) => (
                <li key={`${n}:${queued}`}>{queued}</li>
              ))}
            </ul>
          </section>
        ) : null}
        {trigger ? (
          <MentionMenu
            active={at}
            empty={kind === 'command' && !asksClaude && timeline.commands.length === 0 ? NO_COMMANDS_YET : undefined}
            error={asked?.isError ? asApiError(asked.error) : null}
            id={menu}
            items={items}
            kind={trigger.kind}
            onHover={setActive}
            onPick={pick}
            loading={asked?.isPending ?? false}
            onRetry={() => void asked?.refetch()}
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
          {asked1 ? (
            asked1.questions?.length ? (
              <PendingQuestion
                agent={agent}
                error={error}
                key={asked1.requestId}
                more={others.length}
                onAnswer={answerOf(asked1)}
                request={asked1}
              />
            ) : (
              <PendingApproval
                agent={agent}
                error={error}
                key={asked1.requestId}
                more={others.length}
                onAnswer={answerOf(asked1)}
                request={asked1}
              />
            )
          ) : null}
          <Attachments images={images} onRemove={remove} />
          <Composer.Input
            aria-activedescendant={trigger && at >= 0 ? optionId(menu, at) : undefined}
            aria-autocomplete="list"
            aria-controls={trigger ? menu : undefined}
            aria-expanded={trigger !== null}
            aria-label={`Message ${agent} in ${workspace.name}`}
            disabled={link === 'closed'}
            enterSends={enterSends}
            onChange={(event) => {
              setDraft(event.target.value)
              setCaret(event.target.selectionStart)
              setDismissed(null)
              setActive(0)
            }}
            onKeyDown={keydown}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onPaste={(event) => {
              if (event.clipboardData.files.length === 0) return
              event.preventDefault()
              add(event.clipboardData.files)
            }}
            onSend={send}
            placeholder={placeholder({ link, waiting: timeline.requests.length > 0, agent, retryable: error?.retryable })}
            ref={box}
            role="combobox"
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
                      ? { agent, stopping: timeline.turn === 'stopping', onStop: stop, reason: answering, queues: true }
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
                <PlanToggle
                  disabled={
                    link !== 'open' ? 'The chat is not connected' : harness !== 'claude' ? 'Plan mode needs Claude' : undefined
                  }
                  onChange={setInteraction}
                  value={planning}
                />
                {harness === 'claude' ? (
                  <>
                    <ModelPicker disabled={link !== 'open'} onChange={pickModel} value={model} />
                    <EffortPicker disabled={link !== 'open'} onChange={setEffort} value={effort} />
                  </>
                ) : null}
                {lengths.length > 0 ? (
                  <ContextPicker
                    // Codex reads its length only when its keeper starts, on the thread's first turn.
                    disabled={link !== 'open' || (harness === 'codex' && locked)}
                    lengths={lengths}
                    onChange={setContext}
                    value={context}
                  />
                ) : null}
              </>
            }
          />
        </Composer.Root>
        {/* 4.1.3: the turn's state, said politely and shown, except while the empty field's placeholder says it. */}
        <Composer.Status quiet={timeline.requests.length > 0 && draft === '' && link === 'open'}>
          {status(timeline, harness)}
        </Composer.Status>
        {showTerminal && timeline.thread ? (
          <TerminalDrawer
            agent={agent}
            key={timeline.thread}
            onClose={closeTerminal}
            thread={timeline.thread}
            workspace={workspace}
          />
        ) : null}
      </div>
    </div>
  )
}
