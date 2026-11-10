import { useState } from 'react'
import { ChatError } from '@/api/chat'
import type { Decision } from '@/api/thread'

const NOT_SENT = new ChatError(
  'badFrame',
  'the socket is not open',
  'The chat is not connected, so the answer was not sent. Answer again once it reconnects.',
)

/** One answer per request. The controls stay off until the daemon refuses it (a new chat error) or
 *  the socket was shut, so a double tap sends one frame and a refusal can be tried again. */
export function useAnswer<Args extends unknown[]>(
  error: ChatError | null,
  send: (decision: Decision, ...rest: Args) => boolean,
) {
  const [sent, setSent] = useState<{ error: ChatError | null } | null>(null)
  const [shut, setShut] = useState(false)
  const waiting = sent !== null && sent.error === error
  return {
    disabled: waiting,
    // A refusal from the daemon is the chat's own error, drawn in the dock; only a shut socket is said here.
    refused: shut ? NOT_SENT : null,
    answer: (decision: Decision, ...rest: Args) => {
      if (waiting) return
      const ok = send(decision, ...rest)
      setShut(!ok)
      setSent(ok ? { error } : null)
    },
  }
}
