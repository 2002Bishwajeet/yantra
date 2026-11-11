import type { KeyboardEvent, PointerEvent } from 'react'
import { Mic as MicIcon } from 'lucide-react'
import { Control, Icon } from './Control'
import type { Dictation } from './useDictation'

const HOLD_KEYS = new Set([' ', 'Enter'])

/** A footer control held like a walkie-talkie, by pointer, touch or Space. */
export function DictateButton(props: { dictation: Dictation; disabled?: boolean; describedBy?: string }) {
  const { dictation, disabled, describedBy } = props
  if (!dictation.shown) return null
  const { state, start, stop, askAgain, checking } = dictation

  const down = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    // The field keeps the focus, so the caret stays where the words go and a phone keeps its keyboard.
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    start()
  }
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!HOLD_KEYS.has(event.key)) return
    event.preventDefault()
    if (!event.repeat) start()
  }
  const keyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (HOLD_KEYS.has(event.key)) stop()
  }

  return (
    <Control
      aria-busy={state === 'transcribing' || checking}
      aria-describedby={describedBy}
      // §6 says disabled; a press still asks the box again, so it stays focusable and pressable.
      aria-disabled={askAgain || undefined}
      aria-label="Hold to dictate"
      aria-pressed={state === 'opening' || state === 'listening'}
      className="composer-dictate"
      data-state={state}
      disabled={disabled || (dictation.blocked !== null && !askAgain) || state === 'transcribing'}
      onBlur={stop}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={keyDown}
      onKeyUp={keyUp}
      onLostPointerCapture={stop}
      onPointerCancel={stop}
      onPointerDown={down}
      onPointerUp={stop}
    >
      <Icon icon={MicIcon} />
    </Control>
  )
}
