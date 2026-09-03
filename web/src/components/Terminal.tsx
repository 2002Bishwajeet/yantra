import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalSize } from '@/api'
import { button } from '@/components/Act'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

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

type Ended = { ended: 'no' } | { ended: 'yes'; said: string | null }

/** Whether the socket is up, and which attempt is in flight while it is not —
 *  attempt 0 being the first connection, which nobody chose to retry. */
type Link = { up: boolean; attempt: number }

/** What a socket attaches to: a workspace the daemon looks up, or a machine and
 *  a session it is handed
 *  ([ADR-0022](../../../docs/adr/0022-a-socket-may-address-a-session-rather-than-a-workspace.md)).
 *  It mirrors the daemon's own `Target`, addresses and all. */
export type Target = { workspace: string } | { machine: string; session: string }

function address(target: Target): string {
  const daemon = location.origin.replace(/^http/, 'ws')
  return 'workspace' in target
    ? `${daemon}/api/workspaces/${encodeURIComponent(target.workspace)}/terminal`
    : `${daemon}/api/machines/${encodeURIComponent(target.machine)}/sessions/${encodeURIComponent(target.session)}/terminal`
}

/** What a refusal names, which is the daemon's `Display` for the same two
 *  addresses — a session that went away is named, never a workspace (§4.3). */
function names(target: Target): string {
  return 'workspace' in target
    ? target.workspace
    : `${target.session} on ${target.machine}`
}

/** The socket and xterm.js, wired to each other and to nothing that renders.
 *  Returns the teardown, which is the whole of what closing a terminal is. */
function attach(
  url: string,
  host: HTMLElement,
  over: (said: string | null) => void,
  linked: (link: Link) => void,
): () => void {
  const xterm = new Xterm({ cursorBlink: true, fontSize: 13 })
  const fit = new FitAddon()
  xterm.loadAddon(fit)
  xterm.open(host)
  fit.fit()
  xterm.focus()

  let socket: WebSocket | undefined
  let waiting: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  let finished = false

  const send = (frame: string | Uint8Array<ArrayBuffer>) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(frame)
  }

  // A pty is opened with a window, so this is what *starts* the terminal and
  // every later one resizes it — and a reopened socket needs the first sense
  // again, its pty being as new as it is.
  const measure = () => {
    fit.fit()
    send(
      JSON.stringify({
        rows: xterm.rows,
        cols: xterm.cols,
        term: TERM,
      } satisfies TerminalSize),
    )
  }

  const open = () => {
    const live = new WebSocket(url)
    socket = live
    live.binaryType = 'arraybuffer'
    live.onopen = () => {
      linked({ up: true, attempt: attempts })
      measure()
    }
    live.onmessage = (frame: MessageEvent<string | ArrayBuffer>) => {
      attempts = 0
      // Text from the daemon is why a terminal could not be opened. Written to
      // the screen it would be indistinguishable from something the session
      // said — and reopening a socket that was refused only refuses again.
      if (typeof frame.data === 'string') {
        finished = true
        over(frame.data)
      } else xterm.write(new Uint8Array(frame.data))
    }
    // **The screen is not lost with the socket.** tmux draws the pane's
    // contents for whichever client attaches next, so reopening is the whole of
    // replay and nothing on this side keeps the stream (Q5).
    live.onclose = () => {
      if (finished) return
      if (attempts >= ATTEMPTS) {
        over(null)
        return
      }
      attempts += 1
      linked({ up: false, attempt: attempts })
      waiting = setTimeout(open, PAUSE)
    }
  }

  const bytes = new TextEncoder()
  const typed = xterm.onData((data) => send(bytes.encode(data)))

  open()
  window.addEventListener('resize', measure)

  return () => {
    finished = true
    clearTimeout(waiting)
    window.removeEventListener('resize', measure)
    typed.dispose()
    socket?.close()
    xterm.dispose()
  }
}

/** The session, live, in the page that started it — what M5's `yantra attach`
 *  paste was standing in for. Nothing here keeps the stream: xterm.js holds the
 *  scrollback and it goes with the element (Q5).
 *
 *  **Key it on the URL.** A different target is a different socket and a
 *  different screen, and the React Compiler refuses the reset that would
 *  otherwise do it in the effect.
 *
 *  `height` is a prop, defaulting to `60vh`, because a trust prompt on a fleet
 *  row wants twelve rows of this same pane where `/w/{name}` wants the page
 *  (D5 §5.1). */
export function Terminal({
  target,
  onClose,
  height,
}: {
  target: Target
  onClose: () => void
  height?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const [end, setEnd] = useState<Ended>({ ended: 'no' })
  const [link, setLink] = useState<Link>({ up: false, attempt: 0 })
  const url = address(target)
  const name = names(target)
  const listed =
    'workspace' in target ? 'the Workspaces row' : "the machine's Sessions table"

  // The daemon's reason arrives before the close that follows it, so the first
  // answer is the one that says anything.
  useEffect(
    () =>
      attach(
        url,
        host.current!,
        (said) =>
          setEnd((before) =>
            before.ended === 'yes' ? before : { ended: 'yes', said },
          ),
        setLink,
      ),
    [url],
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Terminal — {name}</CardTitle>
        <CardAction>
          <button type="button" className={button} onClick={onClose}>
            Close
          </button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {/* An empty black box says nothing about itself, so the state that
            produced it is said above it rather than left to be inferred. */}
        {end.ended === 'no' && !link.up && (
          <p role="status" className="text-muted-foreground text-sm">
            {link.attempt === 0
              ? 'Connecting…'
              : `Reconnecting, attempt ${link.attempt} of ${ATTEMPTS}.`}
          </p>
        )}
        {/* Inline rather than a class: Tailwind cannot generate `h-[…]` for a
            value it does not see at build time. The default is here rather than
            in the signature because the React Compiler declines a whole
            component over a default in a destructured parameter. */}
        <div
          ref={host}
          className="w-full"
          style={{ height: height ?? '60vh' }}
        />
        {end.ended === 'yes' &&
          (end.said === null ? (
            <p className="text-muted-foreground text-sm">
              The terminal ended, and {ATTEMPTS} attempts to reopen it all
              failed. Whether you are off the tailnet or the daemon is down is
              not something this page can tell. Detaching never stops a session,
              and whether this one is still running is what {listed} says. Open
              the terminal again once the connection is back.
            </p>
          ) : (
            <Alert variant="destructive">
              <AlertTitle className="text-xs">
                {name} has no terminal to attach to.
              </AlertTitle>
              {/* The daemon's whole source() chain: it names the machine, the
                  command and what ssh said, which is the actionable half. */}
              <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
                {end.said}
              </AlertDescription>
            </Alert>
          ))}
      </CardContent>
    </Card>
  )
}
