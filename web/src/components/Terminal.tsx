import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  ATTEMPTS,
  attachTerminal,
  type Link,
  type Target,
  terminalAddress,
} from '@/api/socket'
import { button } from '@/components/Act'
import { Machine } from '@/components/Machine'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

type Ended = { ended: 'no' } | { ended: 'yes'; said: string | null }

/** What a refusal names, which is the daemon's `Display` for the same two
 *  addresses — a session that went away is named, never a workspace (§4.3). */
function names(target: Target): string {
  return 'workspace' in target
    ? target.workspace
    : `${target.session} on ${target.machine}`
}

/** xterm.js and the socket, wired to each other and to nothing that renders.
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

  const link = attachTerminal(url, {
    size: () => {
      fit.fit()
      return { rows: xterm.rows, cols: xterm.cols }
    },
    onBytes: (bytes) => xterm.write(bytes),
    onEnd: (refused) => over(refused ? refused.said : null),
    onLink: linked,
  })
  const typed = xterm.onData(link.type)
  window.addEventListener('resize', link.resize)

  return () => {
    window.removeEventListener('resize', link.resize)
    typed.dispose()
    link.close()
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
  const url = terminalAddress(target)
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
            // D5 §7: this tab's own refusal names the machine, and the name
            // stays the link to where its heartbeat is.
            <p className="text-muted-foreground text-sm">
              The terminal on <Machine name={target.machine} /> ended, and{' '}
              {ATTEMPTS} attempts to reopen it all failed. Whether you are off
              the tailnet or the daemon is down is not something this page can
              tell. Detaching never stops a session, and whether this one is
              still running is what {listed} says. Open the terminal again once
              the connection is back.
            </p>
          ) : (
            <Alert variant="destructive">
              <AlertTitle className="text-xs">
                {name} has no terminal to attach to.
              </AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                {/* D5 §7: the refusal names the machine, and the name stays the
                    link to where its heartbeat is. */}
                <span>
                  on <Machine name={target.machine} />
                </span>
                {/* The daemon's whole source() chain: it names the machine, the
                    command and what ssh said, which is the actionable half. */}
                <span className="font-mono text-xs whitespace-pre-wrap">
                  {end.said}
                </span>
              </AlertDescription>
            </Alert>
          ))}
      </CardContent>
    </Card>
  )
}
