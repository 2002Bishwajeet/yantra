import { HARNESSES, type ChatFailure, type ChatFrame, type Decision, type Harness, type ThreadEvent } from '@/api/thread'

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
  // The agent's turn ended failed: ssh refused, the harness not found.
  | 'turnFailed'
  // The socket closed after it opened.
  | 'closed'

const sentences: Record<ChatErrorKind, string> = {
  refused: "The daemon refused the chat. This browser may not be on a node this tailnet's owner holds.",
  unreachable: "The workspace's machine or its agent could not be reached, so the turn did not run.",
  notLoggedIn: 'The agent has no login on this machine. Log it in there, then retry.',
  unknownThread: 'This workspace has no chat with that id. Its worktree may have been removed.',
  busy: 'The agent is still answering. Stop it, or wait for it to end.',
  badFrame: 'The daemon could not read what the dashboard sent.',
  turnFailed: 'The agent could not finish the turn.',
  closed: 'The chat socket closed. A turn that was running was stopped.',
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
  /** A machine that did not answer, and a socket that closed, may answer the
   *  next time. The other kinds would say the same thing again. */
  readonly retryable: boolean
  private readonly sentence?: string

  constructor(kind: ChatErrorKind, said: string, sentence?: string, login?: Login) {
    super(said)
    this.name = 'ChatError'
    this.kind = kind
    this.said = said
    // `notLoggedIn` is not: it fails again until a person logs in, so the
    // chat offers its own Retry beside the command.
    this.retryable = kind === 'unreachable' || kind === 'closed'
    this.sentence = sentence
    this.login = login
  }

  describe(): string {
    return this.sentence ?? sentences[this.kind]
  }
}

export function chatAddress(workspace: string, thread?: string): string {
  const daemon = location.origin.replace(/^http/, 'ws')
  const base = `${daemon}/api/workspaces/${encodeURIComponent(workspace)}/chat`
  return thread ? `${base}?thread=${encodeURIComponent(thread)}` : base
}

export type ChatSocket = {
  /** `false` when the socket is not open, so nothing was sent. */
  /** `harness` opens a thread; the daemon ignores it on a later turn. */
  send: (text: string, harness?: Harness) => boolean
  answer: (requestId: string, decision: Decision) => boolean
  stop: () => boolean
  /** The one end that means it: nothing more is reported. */
  close: () => void
}

const KINDS: ReadonlySet<string> = new Set(['unknownThread', 'busy', 'badFrame', 'unreachable', 'notLoggedIn'])
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

/** A daemon frame, or `null` for one this dashboard cannot read. */
export function frameOf(text: string): ThreadEvent | ChatFailure | null {
  let said: unknown
  try {
    said = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof said !== 'object' || said === null || !('type' in said)) return null
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
 *  It does not reopen a socket that closed: the daemon cancels a turn whose
 *  socket closed, so a silent reconnect would hide a stopped turn. `closed` is
 *  retryable instead, and the person reopens it. */
export function openChat(
  url: string,
  {
    onEvent,
    onError,
    onOpen,
  }: {
    onEvent: (event: ThreadEvent) => void
    onError: (error: ChatError) => void
    onOpen?: () => void
  },
): ChatSocket {
  let socket: WebSocket | undefined
  let finished = false
  let wasOpen = false
  // An unknown thread is said, and then the daemon closes; that close is not
  // a second failure.
  let said = false

  const send = (frame: ChatFrame) => {
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  const open = () => {
    let live: WebSocket
    try {
      live = new WebSocket(url)
    } catch (cause) {
      finished = true
      onError(new ChatError('refused', String(cause)))
      return
    }
    socket = live
    live.onerror = () => {}
    live.onopen = () => {
      wasOpen = true
      onOpen?.()
    }
    live.onmessage = (message: MessageEvent<unknown>) => {
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
      if (frame.type === 'error') {
        said = frame.kind === 'unknownThread' || frame.kind === 'unreachable' || frame.kind === 'notLoggedIn'
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
      onEvent(frame)
      if (frame.type === 'turn.completed' && frame.payload.state === 'failed') {
        onError(new ChatError('turnFailed', frame.payload.message ?? ''))
      }
    }
    live.onclose = () => {
      if (finished) return
      finished = true
      if (!wasOpen) onError(new ChatError('refused', 'the daemon refused the chat'))
      else if (!said) onError(new ChatError('closed', ''))
    }
  }

  // StrictMode runs an effect twice in dev; a close before this tick opens no
  // socket rather than closing a CONNECTING one.
  const waiting = setTimeout(open, 0)

  return {
    send: (text, harness) => send(harness ? { type: 'turn', text, harness } : { type: 'turn', text }),
    answer: (requestId, decision) => send({ type: 'answer', requestId, decision }),
    stop: () => send({ type: 'cancel' }),
    close: () => {
      finished = true
      clearTimeout(waiting)
      socket?.close()
    },
  }
}
