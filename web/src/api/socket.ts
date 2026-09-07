import type { TerminalSize } from '@/api'
import { ApiError } from '@/api/errors'

/** What xterm.js is in terminfo's vocabulary, and the one thing this page tells
 *  the far side about itself. Every consumer of xterm.js measured says the same
 *  (VS Code, ttyd, wetty, terminado), and it is the entry `ncurses-base` and
 *  Apple's 2015 ncurses both carry, where `xterm-direct` and ncurses' own
 *  `xterm.js` alias are in neither — an entry tmux cannot find is an attach that
 *  aborts (I-36). */
const TERM = 'xterm-256color'

/** How many times a socket that went away with nothing to say is reopened, and
 *  how long apart. A phone waking or a network changing hands is one attempt
 *  and half a second, and nobody sees it; a daemon that is down is given up on
 *  rather than hammered, because every attempt is an `ssh` connection and a
 *  tmux client on a machine that may be asleep. The budget is per outage — a
 *  socket that printed anything worked, and refills it.
 *
 *  Exported so the tests assert the budget this file declares rather than a
 *  number copied out of it. */
export const ATTEMPTS = 5
export const PAUSE = 500

/** What a socket attaches to: a workspace the daemon looks up, or a machine and
 *  a session it is handed
 *  ([ADR-0022](../../../docs/adr/0022-a-socket-may-address-a-session-rather-than-a-workspace.md)).
 *  It mirrors the daemon's own `Target`, addresses and all.
 *
 *  **Both variants carry the machine**, which the daemon's does not need and a
 *  refusal does: D5 §7 has every tab name the machine it could not reach, and a
 *  workspace's is not in its address. */
export type Target =
  | { workspace: string; machine: string }
  | { machine: string; session: string }

export function terminalAddress(target: Target): string {
  const daemon = location.origin.replace(/^http/, 'ws')
  return 'workspace' in target
    ? `${daemon}/api/workspaces/${encodeURIComponent(target.workspace)}/terminal`
    : `${daemon}/api/machines/${encodeURIComponent(target.machine)}/sessions/${encodeURIComponent(target.session)}/terminal`
}

/** Whether the socket is up, and which attempt is in flight while it is not —
 *  attempt 0 being the first connection, which nobody chose to retry. */
export type Link = { up: boolean; attempt: number }

export type Attached = {
  /** Terminal bytes, as a binary frame. */
  send: (bytes: Uint8Array<ArrayBuffer>) => void
  /** Text a person typed, encoded — what a chat composer sends. */
  type: (text: string) => void
  /** Tells the pty its window again. */
  resize: () => void
  /** The one end that means it: nothing is reopened. */
  close: () => void
}

/** The browser's half of either terminal socket, and nothing that renders.
 *
 *  A pty is opened with a window, so the size frame is what *starts* the
 *  terminal and every later one resizes it — a reopened socket needs it again,
 *  its pty being as new as it is. Binary frames are terminal bytes both ways.
 *  A text frame from the daemon is why the terminal could not be opened, and
 *  it ends the link: `onEnd` gets it as a `socket` error, and reopening a
 *  socket that was refused only refuses again. `onEnd(null)` is the budget
 *  spent. A socket that never opened is a refused upgrade (the authoriser's
 *  403 or 503, which a browser hides), and it ends as `refused` at once:
 *  reopening it is five more round trips to the same answer.
 *
 *  **The screen is not lost with the socket.** tmux draws the pane's contents
 *  for whichever client attaches next, so reopening is the whole of replay and
 *  nothing on this side keeps the stream (Q5). */
export function attachTerminal(
  url: string,
  {
    size,
    onBytes,
    onEnd,
    onLink,
  }: {
    size: () => { rows: number; cols: number }
    onBytes: (bytes: Uint8Array<ArrayBuffer>) => void
    onEnd: (refused: ApiError | null) => void
    onLink: (link: Link) => void
  },
): Attached {
  let socket: WebSocket | undefined
  let waiting: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  let finished = false
  let wasOpen = false

  const send = (frame: string | Uint8Array<ArrayBuffer>) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(frame)
  }

  const resize = () =>
    send(JSON.stringify({ ...size(), term: TERM } satisfies TerminalSize))

  const open = () => {
    let live: WebSocket
    try {
      live = new WebSocket(url)
    } catch (cause) {
      finished = true
      onEnd(new ApiError('socket', String(cause)))
      return
    }
    socket = live
    live.binaryType = 'arraybuffer'
    // A refused upgrade is an error event and then the close that ends it.
    live.onerror = () => {}
    live.onopen = () => {
      wasOpen = true
      onLink({ up: true, attempt: attempts })
      resize()
    }
    live.onmessage = (frame: MessageEvent<string | ArrayBuffer>) => {
      attempts = 0
      if (typeof frame.data === 'string') {
        finished = true
        onEnd(new ApiError('socket', frame.data))
      } else onBytes(new Uint8Array(frame.data))
    }
    live.onclose = () => {
      if (finished) return
      if (!wasOpen) {
        finished = true
        onEnd(new ApiError('refused', 'the daemon refused the terminal'))
        return
      }
      if (attempts >= ATTEMPTS) {
        onEnd(null)
        return
      }
      attempts += 1
      onLink({ up: false, attempt: attempts })
      waiting = setTimeout(open, PAUSE)
    }
  }

  const bytes = new TextEncoder()
  // StrictMode runs an effect twice in dev, so the first attach closes at once.
  // A close before this tick opens no socket, rather than closing a CONNECTING one.
  waiting = setTimeout(open, 0)

  return {
    send,
    type: (text) => send(bytes.encode(text)),
    resize,
    close: () => {
      finished = true
      clearTimeout(waiting)
      socket?.close()
    },
  }
}
