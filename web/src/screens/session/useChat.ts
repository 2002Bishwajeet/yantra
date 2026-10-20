import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react'
import { AttachError, ChatError, chatAddress, openChat, type ChatSocket } from '@/api/chat'
import type { ChatBranchDiff, Decision, Harness, PermissionMode } from '@/api/thread'
import { DiffError } from './diff/errors'
import { empty, reduce, type Timeline } from './timeline'

export type Link = 'connecting' | 'open' | 'closed'

/** The branch diff (Y-491): asked for on request, answered by one frame. */
export type Branch =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; diff: ChatBranchDiff }
  | { state: 'failed'; error: DiffError }

/** One chat socket for the workspace, and the timeline it folds into.
 *
 *  `thread` is read when the socket opens. The daemon names a new thread on the
 *  first turn, `onThread` puts it in the URL, and a reopened socket attaches to
 *  it — so the URL changing under a live socket never opens a second one. A
 *  socket that drops reopens by itself after the last cursor drawn, and the
 *  turn runs on meanwhile (ADR-0035). */
export function useChat(workspace: string, thread: string | undefined, onThread: (id: string) => void) {
  const [timeline, dispatch] = useReducer(reduce, thread, (id): Timeline => ({ ...empty, thread: id ?? null }))
  const [error, setError] = useState<ChatError | null>(null)
  const [link, setLink] = useState<Link>('connecting')
  const [opened, reopen] = useState(0)
  const [branch, setBranch] = useState<Branch>({ state: 'idle' })
  const asking = useRef(false)
  const socket = useRef<ChatSocket | null>(null)
  const attach = useRef(thread)
  const named = useEffectEvent((id: string) => onThread(id))
  const settle = useEffectEvent((error: DiffError) => {
    asking.current = false
    setBranch({ state: 'failed', error })
  })

  useEffect(() => {
    const live = openChat((after) => chatAddress(workspace, attach.current, after), {
      onOpen: () => {
        setLink('open')
        // A diff asked on a dropped socket got no reply (ADR-0035), so it is asked again.
        if (asking.current && !live.diff()) settle(new DiffError('notOpen'))
      },
      onDropped: () => setLink('connecting'),
      // The daemon replays the whole thread, so it is drawn again.
      onRestart: () => dispatch({ type: 'reset' }),
      onEvent: (event) => {
        if (event.type === 'thread.started') {
          attach.current = event.payload.thread
          named(event.payload.thread)
        }
        dispatch({ type: 'event', event })
      },
      onBranchDiff: (diff) => {
        asking.current = false
        setBranch({ state: 'ready', diff })
      },
      onError: (failure) => {
        // Error frames carry no request id: only `diff`, and `busy` during a revert, are the diff's.
        if (asking.current && (failure.kind === 'diff' || failure.kind === 'busy')) {
          settle(new DiffError(failure.kind === 'busy' ? 'busy' : 'failed', failure.kind === 'busy' ? '' : failure.said))
          return
        }
        if (
          asking.current &&
          (failure.kind === 'closed' ||
            failure.kind === 'refused' ||
            failure.kind === 'unknownThread' ||
            failure.kind === 'notLoggedIn')
        ) {
          settle(new DiffError('notOpen'))
        }
        setError(failure)
        // Busy and badFrame never end or prevent a turn: a second tap on an
        // answer the daemon already took is a badFrame while the agent still runs.
        // A turn whose first checkpoint failed never starts.
        if (failure.kind === 'unreachable' || failure.kind === 'checkpoint') dispatch({ type: 'refused' })
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
    send: (text: string, harness?: Harness, mode?: PermissionMode) => {
      if (!socket.current?.send(text, harness, mode)) return false
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
    /** Puts the files back as checkpoint `turn` kept them (Y-448). */
    revert: (turn: number) => {
      if (!socket.current?.revert(turn)) return false
      setError(null)
      return true
    },
    branch,
    /** Asks for the thread's whole-branch diff; the answer lands in `branch`. */
    requestDiff: () => {
      if (timeline.thread === null) {
        setBranch({ state: 'failed', error: new DiffError('noThread') })
        return
      }
      if (!socket.current?.diff()) {
        setBranch({ state: 'failed', error: new DiffError('notOpen') })
        return
      }
      asking.current = true
      setBranch({ state: 'loading' })
    },
    /** Opens the socket again; an attach replays the transcript, so the
     *  timeline starts over. */
    retry: () => {
      setError(null)
      setLink('connecting')
      // A diff panel left open shows this and waits for Refresh, not a skeleton nobody fills.
      asking.current = false
      setBranch({ state: 'failed', error: new DiffError('notOpen') })
      dispatch({ type: 'reset' })
      reopen((n) => n + 1)
    },
  }
}
