import {
  HARNESSES,
  type ChatAttached,
  type ChatBranchDiff,
  type ClaudeModel,
  type ChatQueue,
  type ChatFailure,
  type ChatFrame,
  type ChatNotAttached,
  type ChatPong,
  type Decision,
  type Effort,
  type Harness,
  type Interaction,
  type PermissionMode,
  type ThreadEvent,
} from '@/api/thread'

/** Every way the chat can fail, each from a different place (ADR-0026, Y-356). */
export type ChatErrorKind =
  // The socket never opened: the authoriser's 403 or 503, which a browser hides.
  | 'refused'
  // The workspace, its machine or its harness could not be reached.
  | 'unreachable'
  // The harness has no login on the machine; a person runs `command` there.
  | 'notLoggedIn'
  // `?thread=` names no thread of this workspace.
  | 'unknownThread'
  // A turn is running, and one runs at a time.
  | 'busy'
  // A frame one side could not read.
  | 'badFrame'
  // git could not keep, diff or restore a checkpoint (Y-448).
  | 'checkpoint'
  // git could not diff the thread's branch (Y-490).
  | 'diff'
  // The agent could not stop a background task, or it no longer runs (ADR-0041).
  | 'stopTask'
  // The agent's turn ended failed: ssh refused, the harness not found.
  | 'turnFailed'

const sentences: Record<ChatErrorKind, string> = {
  refused: "The daemon refused the chat. This browser may not be on a node this tailnet's owner holds.",
  unreachable: "The workspace's machine or its agent could not be reached, so the turn did not run.",
  notLoggedIn: 'The agent has no login on this machine. Log it in there, then retry.',
  unknownThread: 'This workspace has no chat with that id. Its worktree may have been removed.',
  busy: 'The agent is still answering. Stop it, or wait for it to end.',
  badFrame: 'The daemon could not read what the dashboard sent.',
  checkpoint: "git on the workspace's machine could not keep or restore this chat's files.",
  diff: "git on the workspace's machine could not diff this chat's branch.",
  stopTask: 'The agent could not stop that background task. It may have ended already.',
  turnFailed: 'The agent could not finish the turn.',
}

/** Whose login is missing, where, and what to run there. */
export type Login = { harness: Harness; machine: string; command: string }

/** The one error the chat client reports. `said` is the daemon's or the
 *  agent's own words, verbatim. */
export class ChatError extends Error {
  readonly kind: ChatErrorKind
  readonly said: string
  /** Set on `notLoggedIn` only. */
  readonly login?: Login
  /** A machine that did not answer may answer the next time. The other kinds
   *  would say the same thing again. */
  readonly retryable: boolean
  private readonly sentence?: string

  constructor(kind: ChatErrorKind, said: string, sentence?: string, login?: Login) {
    super(said)
    this.name = 'ChatError'
    this.kind = kind
    this.said = said
    // `notLoggedIn` is not: it fails again until a person logs in, so the
    // chat offers its own Retry beside the command.
    this.retryable = kind === 'unreachable'
    this.sentence = sentence
    this.login = login
  }

  describe(): string {
    return this.sentence ?? sentences[this.kind]
  }
}

/** The largest image a frame carries: `chat.rs`'s `IMAGE_LIMIT`. */
export const IMAGE_LIMIT = 16 * 1024 * 1024

/** The formats Claude's Read takes. The daemon checks the bytes again. */
export const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** Every way one image can fail to attach (Y-424). */
export type AttachErrorKind =
  // Over IMAGE_LIMIT, so it was not sent.
  | 'tooLarge'
  // Not PNG, JPEG, GIF or WebP, by its type here or its bytes on the daemon.
  | 'notAnImage'
  // The machine could not be reached, or did not write it.
  | 'unreachable'
  // The socket was not open, closed before the daemon replied, or closed
  // after, which removed the image from the machine.
  | 'closed'

const attachSentences: Record<AttachErrorKind, string> = {
  tooLarge: 'The image is larger than 16 MiB, the most the chat takes.',
  notAnImage: 'The chat takes PNG, JPEG, GIF and WebP images only.',
  unreachable: "The workspace's machine did not take the image.",
  closed: 'The chat socket closed, so the image is not attached. Add it again.',
}

/** Why one image did not attach. `said` is the daemon's words, when it spoke. */
export class AttachError extends Error {
  readonly kind: AttachErrorKind
  readonly said: string
  /** Adding the image again may work after a machine or a socket failure, and never after a bad file. */
  readonly retryable: boolean

  constructor(kind: AttachErrorKind, said = '') {
    super(said || attachSentences[kind])
    this.name = 'AttachError'
    this.kind = kind
    this.said = said
    this.retryable = kind === 'unreachable' || kind === 'closed'
  }

  describe(): string {
    return attachSentences[this.kind]
  }
}

/** `after` is the last cursor drawn, so the daemon sends only what follows
 *  it (ADR-0035 decision 8). It is read only with a thread. */
export function chatAddress(workspace: string, thread?: string, after?: string): string {
  const daemon = location.origin.replace(/^http/, 'ws')
  const base = `${daemon}/api/workspaces/${encodeURIComponent(workspace)}/chat`
  if (!thread) return base
  const query = `${base}?thread=${encodeURIComponent(thread)}`
  return after ? `${query}&after=${encodeURIComponent(after)}` : query
}

/** How long apart a socket that dropped is reopened, one pause per attempt:
 *  the daemon's own reader backs off the same way. The last pause repeats for
 *  as long as the page is visible, because a phone asleep for a minute is not
 *  a chat that ended. A message restarts the list. Exported so the tests
 *  assert it. */
export const PAUSES: readonly number[] = [1_000, 2_000, 4_000, 8_000]

/** How often an open, visible socket sends a ping. */
export const PING_EVERY = 20_000

/** How long a ping waits for any frame before the socket counts as dead. */
export const PONG_WITHIN = 5_000

export type ChatSocket = {
  /** `false` when the socket is not open, so nothing was sent. */
  /** `harness` opens a thread; the daemon ignores it on a later turn. */
  /** `model` and `effort` are Claude's; `null` or absent sends none. */
  send: (
    text: string,
    harness?: Harness,
    mode?: PermissionMode,
    interaction?: Interaction,
    model?: ClaudeModel | null,
    effort?: Effort | null,
  ) => boolean
  answer: (requestId: string, decision: Decision, answers?: Record<string, string[]>) => boolean
  stop: () => boolean
  /** Stops one background task (ADR-0041); a failure is `stopTask`. */
  stopTask: (taskId: string) => boolean
  /** Stops every background task and the turn, and lets the agent go. */
  stopAll: () => boolean
  /** Puts the files back as checkpoint `turn` kept them. */
  revert: (turn: number) => boolean
  /** Asks for the thread's whole-branch diff, which `onBranchDiff` receives. */
  diff: () => boolean
  /** Sends an image and resolves to its path on the machine, or rejects with
   *  an `AttachError`. The daemon replies to images in the order they went. */
  attach: (file: Blob) => Promise<string>
  /** The one end that means it: nothing more is reported. */
  close: () => void
}

const KINDS: ReadonlySet<string> = new Set([
  'unknownThread',
  'busy',
  'badFrame',
  'unreachable',
  'notLoggedIn',
  'checkpoint',
  'diff',
  'stopTask',
])
const NAMES: ReadonlySet<string> = new Set(HARNESSES)

function loginOf(failure: Partial<Record<keyof Login, unknown>>): Login | null {
  const { harness, machine, command } = failure
  return typeof harness === 'string' &&
    NAMES.has(harness) &&
    typeof machine === 'string' &&
    typeof command === 'string' &&
    command !== ''
    ? { harness: harness as Harness, machine, command }
    : null
}

const isCount = (n: unknown) => n === undefined || (typeof n === 'number' && Number.isInteger(n) && n >= 0)

/** A reply whose files the tree cannot read is a badFrame, not a crash in the panel. */
function branchDiffOf(said: object): ChatBranchDiff | null {
  const d = said as Partial<Record<keyof ChatBranchDiff, unknown>>
  if (
    typeof d.threadId !== 'string' ||
    typeof d.base !== 'string' ||
    typeof d.unifiedDiff !== 'string' ||
    typeof d.filesTruncated !== 'boolean' ||
    typeof d.truncated !== 'boolean' ||
    !Array.isArray(d.files)
  ) {
    return null
  }
  for (const file of d.files as Record<string, unknown>[]) {
    if (typeof file !== 'object' || file === null) return null
    if (typeof file.path !== 'string' || file.path === '') return null
    if (file.from !== undefined && typeof file.from !== 'string') return null
    if (!isCount(file.added) || !isCount(file.deleted)) return null
  }
  return said as ChatBranchDiff
}

function queueOf(said: object): ChatQueue | null {
  const q = said as Partial<Record<keyof ChatQueue, unknown>>
  return typeof q.threadId === 'string' &&
    Array.isArray(q.texts) &&
    q.texts.every((text) => typeof text === 'string')
    ? (said as ChatQueue)
    : null
}

/** A daemon frame, or `null` for one this dashboard cannot read. */
export function frameOf(
  text: string,
):
  | ThreadEvent
  | ChatFailure
  | ChatAttached
  | ChatNotAttached
  | ChatBranchDiff
  | ChatQueue
  | ChatPong
  | null {
  let said: unknown
  try {
    said = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof said !== 'object' || said === null || !('type' in said)) return null
  if (said.type === 'pong') return { type: 'pong' }
  if (said.type === 'attached') {
    return 'path' in said && typeof said.path === 'string' && said.path !== '' ? (said as ChatAttached) : null
  }
  if (said.type === 'notAttached') {
    const refused = said as Partial<ChatNotAttached>
    return (refused.kind === 'notAnImage' || refused.kind === 'unreachable') && typeof refused.said === 'string'
      ? (said as ChatNotAttached)
      : null
  }
  if (said.type === 'branchDiff') return branchDiffOf(said)
  if (said.type === 'queue') return queueOf(said)
  if (said.type === 'error') {
    const failure = said as Partial<ChatFailure> & Partial<Record<keyof Login, unknown>>
    if (typeof failure.kind !== 'string' || !KINDS.has(failure.kind) || typeof failure.said !== 'string') return null
    if (failure.kind === 'notLoggedIn' && loginOf(failure) === null) return null
    return failure as ChatFailure
  }
  return typeof said.type === 'string' && 'threadId' in said ? (said as ThreadEvent) : null
}

/** The browser's half of the chat socket, and nothing that renders.
 *
 *  A turn outlives its socket (ADR-0035), so a socket that drops is reopened
 *  with the last cursor drawn, and the daemon sends only what followed it.
 *  `address` builds each URL from that cursor. `onRestart` says the daemon
 *  could not continue from it and replays the thread from the start, so the
 *  caller draws it again. A socket that drops is reopened for as long as the
 *  page is visible; a hidden page waits until it is shown, and a socket that
 *  stops answering pings is dropped and reopened (a phone's OS can kill one
 *  without a close event). */
export function openChat(
  address: (after?: string) => string,
  {
    onEvent,
    onError,
    onOpen,
    onDropped,
    onRestart,
    onBranchDiff,
    onQueue,
    pauses = PAUSES,
  }: {
    onEvent: (event: ThreadEvent) => void
    /** The reply to `diff`, which is no event of the timeline. */
    onBranchDiff?: (diff: ChatBranchDiff) => void
    /** The turns waiting for the running one, which is no event of the timeline either. */
    onQueue?: (queue: ChatQueue) => void
    onError: (error: ChatError) => void
    onOpen?: () => void
    /** The socket dropped and a reopen is waiting. */
    onDropped?: () => void
    onRestart?: () => void
    pauses?: readonly number[]
  },
): ChatSocket {
  let socket: WebSocket | undefined
  let finished = false
  let wasOpen = false
  let waiting: ReturnType<typeof setTimeout> | undefined
  // A reopen that is scheduled and has not run.
  let reopening = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  // The last cursor drawn, and the one the open socket was opened after.
  let cursor: string | undefined
  let asked: string | undefined
  // Whether an earlier socket drew anything, and so whether a replay from the
  // start would draw it again.
  let drawn = false
  // An unknown thread or a missing login is said, and then the daemon closes;
  // that close is not a second failure. A retryable error may answer next time.
  let said = false
  // A reopen sends a failed turn's end again, so a failure is reported once
  // for each turn: one a `turn.started` cursor names, or one this tab sent.
  let turn: string | number = 0
  let failed: string | number | undefined
  let sends = 0
  // One per image sent and not yet answered, oldest first.
  const pending: { resolve: (path: string) => void; reject: (error: AttachError) => void }[] = []

  const abandon = () => {
    for (const waiting of pending.splice(0)) waiting.reject(new AttachError('closed'))
  }

  const send = (frame: ChatFrame) => {
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  const stopWatching = () => {
    clearInterval(heartbeat)
    clearTimeout(deadline)
  }

  const detach = (old: WebSocket) => {
    old.onopen = old.onmessage = old.onclose = old.onerror = null
  }

  const visible = () => document.visibilityState !== 'hidden'

  // A hidden page schedules nothing: the phone may be asleep, and `wake` reopens.
  const reopenLater = () => {
    onDropped?.()
    if (!visible()) return
    const pause = pauses[Math.min(attempts, pauses.length - 1)] ?? PAUSES[PAUSES.length - 1]!
    attempts += 1
    reopening = true
    waiting = setTimeout(open, pause)
  }

  // No frame came back: a dead link may never fire `onclose`, so this does not wait for it.
  const dead = () => {
    stopWatching()
    if (!socket || finished) return
    const old = socket
    detach(old)
    old.close()
    abandon()
    onDropped?.()
    // The link was silent, not refused: the first try is at once.
    if (visible()) open()
  }

  const probe = () => {
    if (socket?.readyState !== WebSocket.OPEN || !visible()) return
    clearTimeout(deadline)
    deadline = setTimeout(dead, PONG_WITHIN)
    send({ type: 'ping' })
  }

  // The page came back or the network did: a reopen waiting out its pause is
  // not needed, and an open socket may be one the OS killed.
  const wake = () => {
    if (finished || !visible()) return
    clearTimeout(waiting)
    reopening = false
    attempts = 0
    if (socket?.readyState === WebSocket.OPEN) {
      probe()
      return
    }
    // A second wake must not replace a socket that is still connecting.
    if (socket?.readyState === WebSocket.CONNECTING) return
    open()
  }

  const onVisibility = () => {
    if (visible()) wake()
    else if (reopening) {
      clearTimeout(waiting)
      reopening = false
    }
  }
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) wake()
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', wake)
  window.addEventListener('pageshow', onPageShow)

  function open() {
    reopening = false
    if (socket) {
      detach(socket)
      socket.close()
    }
    stopWatching()
    let live: WebSocket
    asked = wasOpen ? cursor : undefined
    const redraws = drawn
    const tries = attempts
    try {
      live = new WebSocket(address(asked))
    } catch (cause) {
      finished = true
      onError(new ChatError('refused', String(cause)))
      return
    }
    socket = live
    live.onerror = () => {}
    live.onopen = () => {
      wasOpen = true
      heartbeat = setInterval(probe, PING_EVERY)
      onOpen?.()
    }
    live.onmessage = (message: MessageEvent<unknown>) => {
      // Any frame proves the socket is alive.
      clearTimeout(deadline)
      const frame = typeof message.data === 'string' ? frameOf(message.data) : null
      if (frame === null) {
        onError(
          new ChatError(
            'badFrame',
            typeof message.data === 'string' ? message.data : 'a binary frame',
            'The daemon sent a frame this dashboard cannot read.',
          ),
        )
        return
      }
      // An error frame is no sign the daemon can answer, so it does not refill
      // the reopen budget.
      if (frame.type !== 'error') attempts = 0
      if (frame.type === 'pong') return
      if (frame.type === 'attached' || frame.type === 'notAttached') {
        const waiting = pending.shift()
        if (!waiting) {
          onError(new ChatError('badFrame', message.data as string, 'The daemon answered an image this dashboard did not send.'))
        } else if (frame.type === 'attached') {
          waiting.resolve(frame.path)
        } else {
          waiting.reject(new AttachError(frame.kind, frame.said))
        }
        return
      }
      if (frame.type === 'branchDiff') {
        onBranchDiff?.(frame)
        return
      }
      if (frame.type === 'queue') {
        onQueue?.(frame)
        return
      }
      if (frame.type === 'error') {
        said = frame.kind === 'unknownThread' || frame.kind === 'notLoggedIn'
        // The `thread.started` before it refilled the budget, which this takes back.
        if (frame.kind === 'unreachable') attempts = tries
        onError(
          frame.kind === 'notLoggedIn'
            ? new ChatError(frame.kind, frame.said, `Run this on ${frame.machine}, then retry.`, {
                harness: frame.harness,
                machine: frame.machine,
                command: frame.command,
              })
            : new ChatError(frame.kind, frame.said),
        )
        return
      }
      said = false
      // A reopen the daemon cannot continue says so by a `thread.started`
      // that does not carry the cursor it was asked to continue from. Without
      // a cursor to ask after, the daemon always replays from the start.
      if (frame.type === 'thread.started' && redraws && (asked === undefined || frame.cursor !== asked)) onRestart?.()
      if (frame.cursor) cursor = frame.cursor
      drawn = true
      onEvent(frame)
      if (frame.type === 'turn.started' && frame.cursor) turn = frame.cursor
      if (frame.type === 'turn.completed' && frame.payload.state === 'failed' && failed !== turn) {
        failed = turn
        onError(new ChatError('turnFailed', frame.payload.message ?? ''))
      }
    }
    live.onclose = (closed: CloseEvent) => {
      stopWatching()
      abandon()
      if (finished) return
      if (!wasOpen) {
        finished = true
        onError(new ChatError('refused', 'the daemon refused the chat'))
        return
      }
      // The daemon said why it ended the socket, and a reopen would say it again.
      // It ends a socket with a close frame; a network that drops sends none.
      if (said && closed.wasClean) {
        finished = true
        return
      }
      reopenLater()
    }
  }

  // StrictMode runs an effect twice in dev; a close before this tick opens no
  // socket rather than closing a CONNECTING one.
  waiting = setTimeout(open, 0)

  return {
    send: (text, harness, mode, interaction, model, effort) => {
      const sent = send({
        type: 'turn',
        text,
        ...(harness ? { harness } : {}),
        ...(mode ? { mode } : {}),
        ...(interaction === 'plan' ? { interaction } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      })
      // A turn that fails before it starts still gets its own error.
      if (sent) turn = ++sends
      return sent
    },
    answer: (requestId, decision, answers) =>
      send({ type: 'answer', requestId, decision, ...(answers ? { answers } : {}) }),
    stop: () => send({ type: 'cancel' }),
    stopTask: (taskId) => send({ type: 'stopTask', taskId }),
    stopAll: () => send({ type: 'stopAll' }),
    revert: (turn) => send({ type: 'revert', turn }),
    diff: () => send({ type: 'diff' }),
    attach: (file) => {
      if (file.size > IMAGE_LIMIT) return Promise.reject(new AttachError('tooLarge'))
      if (!IMAGE_TYPES.includes(file.type)) return Promise.reject(new AttachError('notAnImage'))
      if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new AttachError('closed'))
      const live = socket
      return new Promise<string>((resolve, reject) => {
        pending.push({ resolve, reject })
        live.send(file)
      })
    },
    close: () => {
      abandon()
      finished = true
      clearTimeout(waiting)
      stopWatching()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', wake)
      window.removeEventListener('pageshow', onPageShow)
      socket?.close()
    },
  }
}
