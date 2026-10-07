import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react'
import { AttachError, ChatError, chatAddress, openChat, type ChatSocket } from '@/api/chat'
import type { Decision, Harness } from '@/api/thread'
import { empty, reduce, type Timeline } from './timeline'

export type Link = 'connecting' | 'open' | 'closed'

/** One chat socket for the workspace, and the timeline it folds into.
 *
 *  `thread` is read when the socket opens. The daemon names a new thread on the
 *  first turn, `onThread` puts it in the URL, and a reopened socket attaches to
 *  it — so the URL changing under a live socket never opens a second one. */
export function useChat(workspace: string, thread: string | undefined, onThread: (id: string) => void) {
  const [timeline, dispatch] = useReducer(reduce, thread, (id): Timeline => ({ ...empty, thread: id ?? null }))
  const [error, setError] = useState<ChatError | null>(null)
  const [link, setLink] = useState<Link>('connecting')
  const [opened, reopen] = useState(0)
  const socket = useRef<ChatSocket | null>(null)
  const attach = useRef(thread)
  const named = useEffectEvent((id: string) => onThread(id))

  useEffect(() => {
    const live = openChat(chatAddress(workspace, attach.current), {
      onOpen: () => setLink('open'),
      onEvent: (event) => {
        if (event.type === 'thread.started') {
          attach.current = event.payload.thread
          named(event.payload.thread)
        }
        dispatch({ type: 'event', event })
      },
      onError: (failure) => {
        setError(failure)
        // Busy and badFrame never end or prevent a turn: a second tap on an
        // answer the daemon already took is a badFrame while the agent still runs.
        if (failure.kind === 'unreachable') dispatch({ type: 'refused' })
        // A missing login fails every turn the same way until a person logs
        // in, so the composer waits for Retry.
        if (
          failure.kind === 'closed' ||
          failure.kind === 'refused' ||
          failure.kind === 'unknownThread' ||
          failure.kind === 'notLoggedIn'
        ) {
          dispatch({ type: 'refused' })
          setLink('closed')
          // The daemon still holds the agent's ssh for a refused prompt; Retry opens a new socket.
          if (failure.kind === 'notLoggedIn') socket.current?.close()
        }
      },
    })
    socket.current = live
    return () => {
      live.close()
      socket.current = null
    }
  }, [workspace, opened])

  return {
    timeline,
    error,
    link,
    send: (text: string, harness?: Harness) => {
      if (!socket.current?.send(text, harness)) return false
      setError(null)
      dispatch({ type: 'sent' })
      return true
    },
    answer: (requestId: string, decision: Decision) => socket.current?.answer(requestId, decision) ?? false,
    /** Sends an image; it resolves to the path on the machine. */
    attach: (file: Blob) => socket.current?.attach(file) ?? Promise.reject(new AttachError('closed')),
    stop: () => {
      if (socket.current?.stop()) dispatch({ type: 'stopping' })
    },
    /** Opens the socket again; an attach replays the transcript, so the
     *  timeline starts over. */
    retry: () => {
      setError(null)
      setLink('connecting')
      dispatch({ type: 'reset' })
      reopen((n) => n + 1)
    },
  }
}
