import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Mic as MicIcon } from 'lucide-react'
import { type ApiError, micError } from '@/api/errors'
import { useMachineReadiness } from '@/api/hooks'
import { type Mic, type MicState, openMic } from '@/api/mic'
import { Button } from '@/m3/button/Button'
import { Mono } from '@/m3/text/Text'
import './Talk.css'

const HOLD_KEYS = new Set([' ', 'Enter'])

/** ADR-0031 §6's button, drawn only where `doctor` found `yantra-mic`: an
 *  optional item a machine does not have draws nothing. */
export function Talk({ machine }: { machine: string }) {
  const readiness = useMachineReadiness(machine)
  const present =
    readiness.looked === 'ok' && readiness.data.checks.some((one) => one.check === 'mic' && one.state === 'present')
  return present ? <Hold machine={machine} /> : null
}

function Hold({ machine }: { machine: string }) {
  const mic = useRef<Mic | null>(null)
  const [state, setState] = useState<MicState | 'idle'>('idle')
  const [error, setError] = useState<ApiError | null>(null)
  const id = useId()
  // §4: the page on :7717 is not a secure context, and the browser offers no microphone there.
  const insecure = window.isSecureContext ? null : micError('insecure', location.origin)

  const start = () => {
    if (mic.current || insecure) return
    setError(null)
    setState('opening')
    let ended = false
    const opened = openMic(machine, {
      onState: setState,
      onEnd: (error) => {
        ended = true
        mic.current = null
        setState('idle')
        setError(error)
      },
    })
    // A setup that threw has already ended, and must not hold the button.
    if (!ended) mic.current = opened
  }
  // The button is up at once; `onEnd` may come later, once a prompt is answered.
  const stop = () => {
    if (!mic.current) return
    mic.current.close()
    setState('idle')
  }

  // Leaving the page is a release.
  useEffect(() => () => mic.current?.close(), [])

  const down = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
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

  const pressed = state !== 'idle'
  const said = insecure ?? error
  return (
    <div className="talk">
      <Button
        aria-describedby={`${id}-status`}
        aria-pressed={pressed}
        className="talk__button"
        disabled={insecure !== null}
        icon={<MicIcon />}
        onBlur={stop}
        onKeyDown={keyDown}
        onKeyUp={keyUp}
        onLostPointerCapture={stop}
        onPointerCancel={stop}
        onPointerDown={down}
        onPointerUp={stop}
        variant={pressed ? 'filled' : 'tonal'}
      >
        Hold to talk
      </Button>
      <span aria-live="polite" className="talk__status" id={`${id}-status`} role="status">
        {said ? said.describe() : state === 'listening' ? 'Listening' : null}
        {said && said.kind !== 'insecure' && said.said ? <Mono className="talk__said">{said.said}</Mono> : null}
      </span>
    </div>
  )
}
