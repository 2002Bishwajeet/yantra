import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { ApiError } from '@/api/errors'
import { ATTEMPTS, attachTerminal, type Link as Wire, type Target, terminalAddress } from '@/api/socket'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Mark } from '@/m3/mark/Mark'
import { Mono, Text } from '@/m3/text/Text'
import { type Keys, KeysContext } from './keysContext'
import './Terminal.css'

type Ended =
  | { ended: 'no' }
  | { ended: 'yes'; refused: ApiError | null }
  // ADR-0030 §5: a one-off terminal's command ended it, and said how.
  | { ended: 'exited'; exit: number | null }

type Size = { cols: number; rows: number }

type Wired = Keys & { close: () => void }

/** How the socket ends: a session's reopens, a one-off's never does. */
type Ending = { attempts: number; exited?: (exit: number | null) => void }

const SIZE = 13
const FAMILY = '"IBM Plex Mono", ui-monospace, monospace'
/** `document.fonts.load` takes one face, not a fallback list, and the webfont is
 *  the only member of FAMILY that has to be fetched. */
const FACE = `${SIZE}px "IBM Plex Mono"`

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
  ending: Ending,
): Wired {
  // WCAG 1.4.3: xterm's ANSI blue is 3.5:1 on its black, and every shell prompt
  // paints a path in it. xterm lifts each colour that falls short of 4.5:1.
  const xterm = new Xterm({ cursorBlink: false, fontSize: SIZE, fontFamily: FAMILY, minimumContrastRatio: 4.5 })
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
    onExit: ending.exited,
    attempts: ending.attempts,
  })
  let arming: (() => void) | null = null
  const typed = xterm.onData((data) => {
    if (arming && data.length === 1) {
      const spent = arming
      arming = null
      link.send(new Uint8Array([data.toUpperCase().charCodeAt(0) & 0x1f]))
      spent()
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
    ctrl: (spent) => {
      arming = spent
    },
  }
}

export type TerminalProps = {
  target: Target
  height?: string
  /** The status line's subject: "tmux yantra-web on cachyos-g14". */
  label: string
  /** A one-off terminal's command ended, with this status (ADR-0030). */
  onExit?: (exit: number | null) => void
  /** A one-off terminal ended with no status: refused, or dropped mid-command. */
  onEnd?: () => void
  /** Where the status line goes when the page has a header to hold it. It then
   *  drops the label, because the page title already names the session. */
  statusIn?: HTMLElement | null
  /** Drawn under the pane, inside `KeysContext`: the phone's key row. */
  children?: ReactNode
}

/** The session, live (Y-129, Y-132). Nothing here keeps the stream: xterm.js
 *  holds the scrollback and it goes with the element (Q5). Key it on the
 *  target — a different target is a different socket and a different screen.
 *
 *  **A step target is a one-off terminal** (Y-394): it runs a command an
 *  install left, ends when the command does, and is never reopened, because
 *  reopening would run the command again. An owner target is one too (Y-701):
 *  it ends when its shell does. */
export function Terminal(props: TerminalProps) {
  const { target, height, label, onExit, onEnd, statusIn, children } = props
  const host = useRef<HTMLDivElement>(null)
  const wired = useRef<ReturnType<typeof attach> | null>(null)
  const told = useRef(onExit)
  const toldEnd = useRef(onEnd)
  const [end, setEnd] = useState<Ended>({ ended: 'no' })
  const [link, setLink] = useState<Wire>({ up: false, attempt: 0 })
  const [size, setSize] = useState<Size | null>(null)
  const [opened, reopen] = useState(0)
  const escape = useRef<HTMLParagraphElement>(null)
  const hint = useId()
  const url = terminalAddress(target)
  // An owner terminal ends with its shell, and a step with its command.
  const once = 'step' in target || 'owner' in target
  const refused = end.ended === 'yes' ? end.refused : null

  // The socket outlives any one render, so the newest callback is read at the
  // moment the command ends rather than captured when the pane opened.
  useEffect(() => {
    told.current = onExit
    toldEnd.current = onEnd
  })

  // The daemon's reason arrives before the close that follows it, so the first
  // answer is the one that says anything.
  //
  // **The face has to be there before the pane is measured.** A pty is opened
  // with a window, and a cell measured against a fallback font gives the wrong
  // column count — every line then wraps where the far side did not break it.
  useEffect(() => {
    let live: ReturnType<typeof attach> | null = null
    let closed = false
    // xterm measures the cell once, against whatever face is live at that
    // moment, and caches it — `fit()` afterwards only divides the container by
    // a stale cell, and reassigning the same `fontFamily` is a no-op, so a face
    // that lands late leaves the pane wrong for good. `fonts.ready` did not
    // hold it either: it settles on the loads already pending, and nothing on
    // this route asks for the face until the pane draws. So ask, then measure.
    const faces = document.fonts
    const there = faces ? faces.load(FACE).then(() => faces.ready) : Promise.resolve()
    void there.catch(() => undefined).then(() => {
      if (closed) return
      live = attach(
        url,
        host.current!,
        (refused) => {
          setEnd((before) => (before.ended === 'no' ? { ended: 'yes', refused } : before))
          if (once) toldEnd.current?.()
        },
        setLink,
        setSize,
        hint,
        () => escape.current?.focus(),
        once
          ? {
              attempts: 0,
              exited: (exit) => {
                setEnd({ ended: 'exited', exit })
                told.current?.(exit)
              },
            }
          : { attempts: ATTEMPTS },
      )
      wired.current = live
    })
    return () => {
      closed = true
      wired.current = null
      live?.close()
    }
  }, [url, opened, hint, once])

  const again = () => {
    setEnd({ ended: 'no' })
    setLink({ up: false, attempt: 0 })
    reopen((n) => n + 1)
  }

  // The end is the one thing this line has to carry, so it is mounted for the
  // whole life of the pane rather than replaced by what ended it.
  const short = statusIn != null
  const line = (
    <p className={short ? 'terminal__status terminal__status--short' : 'terminal__status'} role="status">
      <Mark
        size="small"
        state={
          end.ended === 'exited'
            ? end.exit === 0
              ? 'done'
              : 'failed'
            : end.ended === 'no'
              ? link.up
                ? 'running'
                : 'unknown'
              : refused
                ? 'failed'
                : 'idle'
        }
      />
      {short ? (
        <Text clip scale="body-small">
          {end.ended === 'exited'
            ? `Exited ${end.exit ?? 'with no status'}`
            : end.ended === 'yes'
              ? refused
                ? 'Refused'
                : 'Ended'
              : link.up
                ? `Attached${size ? ` · ${size.cols}×${size.rows}` : ''}`
                : link.attempt === 0
                  ? 'Connecting'
                  : `Reconnecting · ${link.attempt} of ${ATTEMPTS}`}
        </Text>
      ) : (
        <Mono clip>
          {end.ended === 'exited'
            ? `exited ${end.exit ?? 'with no status'} · ${label}`
            : end.ended === 'yes'
              ? `${refused ? 'refused' : 'ended'} · ${label}`
              : link.up
                ? `attached · ${label}${size ? ` · ${size.cols}×${size.rows}` : ''}`
                : link.attempt === 0
                  ? `connecting · ${label}`
                  : `reconnecting · attempt ${link.attempt} of ${ATTEMPTS} · ${label}`}
        </Mono>
      )}
    </p>
  )

  return (
    <div className="terminal">
      <div className="terminal__pane" ref={host} style={{ height: height ?? '60vh' }} />
      {statusIn ? createPortal(line, statusIn) : line}
      {/* Escape then Tab puts focus here: the first stop past the pane, whether
          or not the status line sits after it. */}
      <p className="terminal__escape" id={hint} ref={escape} tabIndex={-1}>
        Esc then Tab leaves the pane. Tab on its own goes to the shell in it.
      </p>
      {end.ended === 'no' || end.ended === 'exited' ? null : refused ? (
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
      ) : 'owner' in target ? (
        <p className="terminal__over">
          The owner terminal on{' '}
          <Link className="m3-hit" params={{ machine: target.machine }} to="/m/$machine">
            {target.machine}
          </Link>{' '}
          closed before its shell ended. Nothing reopens it on its own.
        </p>
      ) : once ? (
        <p className="terminal__over">
          The terminal on{' '}
          <Link className="m3-hit" params={{ machine: target.machine }} to="/m/$machine">
            {target.machine}
          </Link>{' '}
          closed before the command said how it went. Nothing reopens it, because that would run the command
          again.
        </p>
      ) : (
        <p className="terminal__over">
          The terminal on{' '}
          <Link className="m3-hit" params={{ machine: target.machine }} to="/m/$machine">
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
