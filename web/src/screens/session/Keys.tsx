import { use, useState } from 'react'
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
  const focus = () => wired.current?.focus()
  const ctrl = () => wired.current?.ctrl()
  const key = (bytes: number[]) => () => {
    wired.current?.send(bytes)
    focus()
  }
  return (
    <div className="terminal__keys" role="toolbar" aria-label="Keys">
      <button className="terminal__key m3-interactive" onClick={key(ESC)} type="button">
        Esc
      </button>
      <button className="terminal__key m3-interactive" onClick={key(TAB)} type="button">
        Tab
      </button>
      <button aria-label="Up" className="terminal__key m3-interactive" onClick={key(UP)} type="button">
        <ArrowUp aria-hidden="true" />
      </button>
      <button aria-label="Down" className="terminal__key m3-interactive" onClick={key(DOWN)} type="button">
        <ArrowDown aria-hidden="true" />
      </button>
      <button
        aria-pressed={armed}
        className="terminal__key m3-interactive"
        onClick={() => {
          ctrl()
          setArmed(true)
          focus()
        }}
        onBlur={() => setArmed(false)}
        type="button"
      >
        Ctrl
      </button>
      <button className="terminal__key m3-interactive" onClick={key(ENTER)} type="button">
        Enter
      </button>
      <button className="terminal__key terminal__key--keyboard m3-interactive" onClick={focus} type="button">
        <KeyboardIcon aria-hidden="true" />
        Keyboard
      </button>
    </div>
  )
}
