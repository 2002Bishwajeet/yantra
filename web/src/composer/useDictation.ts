import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { type ApiError, dictateError, micError } from '@/api/errors'
import { dictateAddress, type Mic, type MicState, openMic } from '@/api/mic'
import { dictationQuery } from '@/api/queries'

/** §6: a service that failed may have gone away, so the button asks again. */
const ASK_AGAIN = new Set(['stt-unreachable', 'stt-failed'])

export type Dictation = {
  /** Whether a button is drawn: not while dictation is off or not yet known. */
  shown: boolean
  /** Why the button cannot be held, when it cannot. */
  blocked: ApiError | null
  /** The box did not answer: the button looks disabled, and a press asks it again. */
  askAgain: boolean
  /** The health read a press asked for is on its way. */
  checking: boolean
  state: MicState | 'idle'
  /** How the last utterance ended, when it gave no text. */
  error: ApiError | null
  start: () => void
  stop: () => void
}

/** ADR-0043 §4: hold to talk, let go, and the words go to `onText`. Nothing is sent to the agent. */
export function useDictation({
  workspace,
  thread,
  onText,
}: {
  workspace?: string
  thread: string | null
  onText: (text: string) => void
}): Dictation {
  const health = useQuery(dictationQuery())
  const mic = useRef<Mic | null>(null)
  const [state, setState] = useState<MicState | 'idle'>('idle')
  const [error, setError] = useState<ApiError | null>(null)
  const latest = useRef(onText)
  useEffect(() => {
    latest.current = onText
  }, [onText])

  const service = health.data?.state
  const blocked =
    service === 'unreachable'
      ? dictateError('unreachable', '')
      : window.isSecureContext
        ? null
        : micError('insecure', location.origin)
  const askAgain = service === 'unreachable'
  const checking = askAgain && health.isFetching
  const { refetch } = health

  const start = () => {
    if (askAgain) {
      if (!checking) void refetch()
      return
    }
    if (mic.current || blocked || state === 'transcribing') return
    setError(null)
    let ended = false
    const opened = openMic(dictateAddress(workspace, thread), {
      onState: setState,
      onText: (text) => latest.current(text),
      onEnd: (failed) => {
        ended = true
        mic.current = null
        setState('idle')
        setError(failed)
        if (failed && ASK_AGAIN.has(failed.kind)) void refetch()
      },
    })
    if (!ended) mic.current = opened
  }
  const stop = () => mic.current?.close()

  // Leaving the page is a release.
  useEffect(() => () => mic.current?.close(), [])

  return { shown: service === 'ready' || askAgain, blocked, askAgain, checking, state, error, start, stop }
}

/** The status line's words: the reason first, then what the press is doing. */
export function dictationStatus(dictation: Dictation): string {
  if (dictation.checking) return 'Asking yantra-box again…'
  const said = dictation.error ?? dictation.blocked
  if (said) return dictation.askAgain ? `${said.describe()} Press to ask again.` : said.describe()
  if (dictation.state === 'listening') return 'Listening. Let go to write it in.'
  if (dictation.state === 'transcribing') return 'Writing down what you said…'
  return ''
}
