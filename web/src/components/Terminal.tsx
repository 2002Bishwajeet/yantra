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

type Ended = { ended: 'no' } | { ended: 'yes'; said: string | null }

/** The socket and xterm.js, wired to each other and to nothing that renders.
 *  Returns the teardown, which is the whole of what closing a terminal is. */
function attach(
  name: string,
  host: HTMLElement,
  over: (said: string | null) => void,
): () => void {
  const xterm = new Xterm({ cursorBlink: true, fontSize: 13 })
  const fit = new FitAddon()
  xterm.loadAddon(fit)
  xterm.open(host)
  fit.fit()
  xterm.focus()

  const socket = new WebSocket(
    `${location.origin.replace(/^http/, 'ws')}/api/workspaces/${encodeURIComponent(name)}/terminal`,
  )
  socket.binaryType = 'arraybuffer'
  const send = (frame: string | Uint8Array<ArrayBuffer>) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(frame)
  }

  // A pty is opened with a window, so this is what *starts* the terminal; every
  // later one resizes it.
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

  const bytes = new TextEncoder()
  const typed = xterm.onData((data) => send(bytes.encode(data)))

  socket.onopen = measure
  socket.onmessage = (frame: MessageEvent<string | ArrayBuffer>) => {
    // Text from the daemon is why a terminal could not be opened. Written to
    // the screen it would be indistinguishable from something the session said.
    if (typeof frame.data === 'string') over(frame.data)
    else xterm.write(new Uint8Array(frame.data))
  }
  socket.onclose = () => over(null)
  window.addEventListener('resize', measure)

  return () => {
    window.removeEventListener('resize', measure)
    typed.dispose()
    socket.close()
    xterm.dispose()
  }
}

/** The session, live, in the page that started it — what M5's `yantra attach`
 *  paste was standing in for. Nothing here keeps the stream: xterm.js holds the
 *  scrollback and it goes with the element (Q5).
 *
 *  **Key it on `name`.** A different workspace is a different socket and a
 *  different screen, and the React Compiler refuses the reset that would
 *  otherwise do it in the effect. */
export function Terminal({
  name,
  onClose,
}: {
  name: string
  onClose: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const [end, setEnd] = useState<Ended>({ ended: 'no' })

  // The daemon's reason arrives before the close that follows it, so the first
  // answer is the one that says anything.
  useEffect(
    () =>
      attach(name, host.current!, (said) =>
        setEnd((before) =>
          before.ended === 'yes' ? before : { ended: 'yes', said },
        ),
      ),
    [name],
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
        <div ref={host} className="h-[60vh] w-full" />
        {end.ended === 'yes' &&
          (end.said === null ? (
            <p className="text-muted-foreground text-sm">
              The terminal ended. Detaching never stops a session, and whether
              this one is still running is what the Workspaces row says.
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
