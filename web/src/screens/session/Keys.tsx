import { use, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowDown, ArrowUp, Keyboard as KeyboardIcon } from 'lucide-react'
import { KeysContext } from './keysContext'

const ESC = [0x1b]
const TAB = [0x09]
const UP = [0x1b, 0x5b, 0x41]
const DOWN = [0x1b, 0x5b, 0x42]
const ENTER = [0x0d]

/** The phone's key row (PhoneSessionTerminal): the keys a soft keyboard has
 *  no row for, and a button that raises the keyboard by focusing the pane. */
export function KeyRow() {
  const wired = use(KeysContext)
  const [armed, setArmed] = useState(false)
  const [at, setAt] = useState(0)
  const row = useRef<HTMLDivElement>(null)
  const focus = () => wired.current?.focus()
  const key = (bytes: number[]) => () => {
    wired.current?.send(bytes)
    focus()
  }
  // The pane clears the mark when it spends the Ctrl. Blur cannot: focusing the
  // pane is what pressing a key here does, and the pane stays armed.
  const ctrl = () => {
    if (!wired.current) return
    wired.current.ctrl(() => setArmed(false))
    setArmed(true)
    focus()
  }
  // 4.1.2: a toolbar is one tab stop, and the arrow keys move inside it.
  const roving = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const keys = row.current?.querySelectorAll('button') ?? []
    const next = (at + step + keys.length) % keys.length
    setAt(next)
    keys[next]?.focus()
  }
  const stop = (index: number) => (index === at ? 0 : -1)
  return (
    <div className="terminal__keys" role="toolbar" aria-label="Keys" onKeyDown={roving} ref={row}>
      <button className="terminal__key m3-interactive" onClick={key(ESC)} tabIndex={stop(0)} type="button">
        Esc
      </button>
      <button className="terminal__key m3-interactive" onClick={key(TAB)} tabIndex={stop(1)} type="button">
        Tab
      </button>
      <button
        aria-label="Up"
        className="terminal__key m3-interactive"
        onClick={key(UP)}
        tabIndex={stop(2)}
        type="button"
      >
        <ArrowUp aria-hidden="true" />
      </button>
      <button
        aria-label="Down"
        className="terminal__key m3-interactive"
        onClick={key(DOWN)}
        tabIndex={stop(3)}
        type="button"
      >
        <ArrowDown aria-hidden="true" />
      </button>
      <button
        aria-pressed={armed}
        className="terminal__key m3-interactive"
        onClick={ctrl}
        tabIndex={stop(4)}
        type="button"
      >
        Ctrl
      </button>
      <button className="terminal__key m3-interactive" onClick={key(ENTER)} tabIndex={stop(5)} type="button">
        Enter
      </button>
      <button
        className="terminal__key terminal__key--keyboard m3-interactive"
        onClick={focus}
        tabIndex={stop(6)}
        type="button"
      >
        <KeyboardIcon aria-hidden="true" />
        Keyboard
      </button>
    </div>
  )
}
