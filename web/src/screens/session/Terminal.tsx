import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { ApiError } from '@/api/errors'
import { ATTEMPTS, attachTerminal, type Link as Wire, type Target, terminalAddress } from '@/api/socket'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Mark } from '@/m3/mark/Mark'
import { Mono } from '@/m3/text/Text'
import { type Keys, KeysContext } from './keysContext'
import './Terminal.css'

type Ended = { ended: 'no' } | { ended: 'yes'; refused: ApiError | null }

type Size = { cols: number; rows: number }

type Wired = Keys & { close: () => void }

/** xterm.js and the socket, wired to each other. Returns the teardown, which
 *  is the whole of what closing a terminal is. */
function attach(
  url: string,
  host: HTMLElement,
  over: (refused: ApiError | null) => void,
  linked: (link: Wire) => void,
  sized: (size: Size) => void,
  hint: string,
  leave: () => void,
): Wired {
  const xterm = new Xterm({ cursorBlink: false, fontSize: 13, fontFamily: '"IBM Plex Mono", ui-monospace, monospace' })
  const fit = new FitAddon()
  xterm.loadAddon(fit)
  xterm.open(host)
  fit.fit()

  // WCAG 2.1.2: xterm hands Tab to the shell, so the pane needs an exit of its
  // own. Escape then Tab is CodeMirror's: both keys keep reaching the shell,
  // and only the pair leaves. `hint` is the line under the pane that says so.
  let armed = false
  xterm.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    if (armed && event.key === 'Tab') {
      armed = false
      event.preventDefault()
      leave()
      return false
    }
    armed = event.key === 'Escape'
    return true
  })
  xterm.textarea?.setAttribute('aria-describedby', hint)

  const link = attachTerminal(url, {
    size: () => {
      fit.fit()
      sized({ rows: xterm.rows, cols: xterm.cols })
      return { rows: xterm.rows, cols: xterm.cols }
    },
    onBytes: (bytes) => xterm.write(bytes),
    onEnd: over,
    onLink: linked,
  })
  let ctrl = false
  const typed = xterm.onData((data) => {
    if (ctrl && data.length === 1) {
      ctrl = false
      link.send(new Uint8Array([data.toUpperCase().charCodeAt(0) & 0x1f]))
    } else link.type(data)
  })
  window.addEventListener('resize', link.resize)
  // The window is not the only thing that moves the pane: a sheet that opens
  // takes the page's scrollbar with it, and a pane measured either side of
  // that is two different terminals. Guarded because jsdom has no observer,
  // and the unit tests run there.
  const watching = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => link.resize())
  watching?.observe(host)

  return {
    close: () => {
      watching?.disconnect()
      window.removeEventListener('resize', link.resize)
      typed.dispose()
      link.close()
      xterm.dispose()
    },
    send: (bytes) => link.send(new Uint8Array(bytes)),
    focus: () => xterm.focus(),
    ctrl: () => {
      ctrl = true
    },
  }
}

export type TerminalProps = {
  target: Target
  height?: string
  /** The status line's subject: "tmux yantra-web on cachyos-g14". */
  label: string
  /** Drawn under the pane, inside `KeysContext`: the phone's key row. */
  children?: ReactNode
}

/** The session, live (Y-129, Y-132). Nothing here keeps the stream: xterm.js
 *  holds the scrollback and it goes with the element (Q5). Key it on the
 *  target — a different target is a different socket and a different screen. */
export function Terminal(props: TerminalProps) {
  const { target, height, label, children } = props
  const host = useRef<HTMLDivElement>(null)
  const wired = useRef<ReturnType<typeof attach> | null>(null)
  const [end, setEnd] = useState<Ended>({ ended: 'no' })
  const [link, setLink] = useState<Wire>({ up: false, attempt: 0 })
  const [size, setSize] = useState<Size | null>(null)
  const [opened, reopen] = useState(0)
  const status = useRef<HTMLParagraphElement>(null)
  const hint = useId()
  const url = terminalAddress(target)
  const refused = end.ended === 'yes' ? end.refused : null

  // The daemon's reason arrives before the close that follows it, so the first
  // answer is the one that says anything.
  //
  // **The face has to be there before the pane is measured.** A pty is opened
  // with a window, and a cell measured against a fallback font gives the wrong
  // column count — every line then wraps where the far side did not break it.
  useEffect(() => {
    let live: ReturnType<typeof attach> | null = null
    let closed = false
    void (document.fonts?.ready ?? Promise.resolve()).then(() => {
      if (closed) return
      live = attach(
        url,
        host.current!,
        (refused) => setEnd((before) => (before.ended === 'yes' ? before : { ended: 'yes', refused })),
        setLink,
        setSize,
        hint,
        () => status.current?.focus(),
      )
      wired.current = live
    })
    return () => {
      closed = true
      wired.current = null
      live?.close()
    }
  }, [url, opened, hint])

  const again = () => {
    setEnd({ ended: 'no' })
    setLink({ up: false, attempt: 0 })
    reopen((n) => n + 1)
  }

  return (
    <div className="terminal">
      <div className="terminal__pane" ref={host} style={{ height: height ?? '60vh' }} />
      {/* The end is the one thing this line has to carry, so it is mounted for
          the whole life of the pane rather than replaced by what ended it. It
          is also where Escape-then-Tab puts focus: the first stop past it. */}
      <p className="terminal__status" ref={status} role="status" tabIndex={-1}>
        <Mark size="small" state={end.ended === 'no' ? (link.up ? 'running' : 'unknown') : refused ? 'failed' : 'idle'} />
        <Mono clip>
          {end.ended === 'yes'
            ? `${refused ? 'refused' : 'ended'} · ${label}`
            : link.up
              ? `attached · ${label}${size ? ` · ${size.cols}×${size.rows}` : ''}`
              : link.attempt === 0
                ? `connecting · ${label}`
                : `reconnecting · attempt ${link.attempt} of ${ATTEMPTS} · ${label}`}
        </Mono>
      </p>
      <p className="terminal__escape" id={hint}>
        Esc then Tab leaves the pane. Tab on its own goes to the shell in it.
      </p>
      {end.ended === 'no' ? null : refused ? (
        // D5 §7: this tab's own refusal names the machine, and the name stays
        // the link to where its heartbeat is.
        <ErrorSurface.Inline
          action={
            <Button role="link" render={<Link params={{ machine: target.machine }} to="/m/$machine" />} variant="text">
              {target.machine}
            </Button>
          }
          error={{ kind: refused.kind, said: refused.said, retryable: true, describe: () => refused.describe() }}
          eyebrow={`on ${target.machine}`}
          reset={again}
          title={`${label} has no terminal to attach to`}
        />
      ) : (
        <p className="terminal__over">
          The terminal on{' '}
          <Link params={{ machine: target.machine }} to="/m/$machine">
            {target.machine}
          </Link>{' '}
          ended, and {ATTEMPTS} attempts to reopen it all failed. Whether you are off the tailnet or the
          daemon is down is not something this page can tell. Detaching never stops a session.{' '}
          <Button onClick={again} variant="text">
            Open it again
          </Button>
        </p>
      )}
      <KeysContext value={wired}>{children}</KeysContext>
    </div>
  )
}
