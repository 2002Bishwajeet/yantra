import type {
  ChatItem,
  Harness,
  ItemStatus,
  ItemType,
  RequestOpened,
  ThreadEvent,
  TurnCompleted,
} from '@/api/thread'

export type Message = {
  kind: 'message'
  id: string
  /** `agent` is whichever harness the thread speaks to. */
  who: 'you' | 'agent' | 'thinking'
  text: string
}

export type Tool = {
  kind: 'tool'
  id: string
  itemType: ItemType
  status: ItemStatus
  title: string | null
  output: string | null
}

export type Entry = Message | Tool

/** What the chat draws, folded from the socket's events. */
export type Timeline = {
  /** The id `?thread=` keeps, once the daemon has named one. */
  thread: string | null
  /** Who speaks, once the daemon has said; the picker is locked from then on. */
  harness: Harness | null
  entries: Entry[]
  /** Requests the agent is waiting on, oldest first. */
  requests: RequestOpened[]
  usage: { used: number; max: number } | null
  /** `sent` is the frame on its way, before the agent says it started. */
  turn: 'idle' | 'sent' | 'running' | 'stopping'
  /** How the last turn ended, until the next one starts. */
  ended: TurnCompleted | null
}

export const empty: Timeline = {
  thread: null,
  harness: null,
  entries: [],
  requests: [],
  usage: null,
  turn: 'idle',
  ended: null,
}

export type Action =
  | { type: 'event'; event: ThreadEvent }
  | { type: 'sent' }
  | { type: 'stopping' }
  /** The daemon refused the turn, so none is running. */
  | { type: 'refused' }
  /** A reopened socket replays the thread from the start. */
  | { type: 'reset' }

const WHO = { user_text: 'you', assistant_text: 'agent', reasoning_text: 'thinking' } as const

export function reduce(timeline: Timeline, action: Action): Timeline {
  switch (action.type) {
    case 'sent':
      return { ...timeline, turn: 'sent', ended: null }
    case 'stopping':
      return timeline.turn === 'idle' ? timeline : { ...timeline, turn: 'stopping' }
    case 'refused':
      return { ...timeline, turn: 'idle' }
    case 'reset':
      return { ...empty, thread: timeline.thread, harness: timeline.harness }
    case 'event':
      return fold(timeline, action.event)
  }
}

function fold(timeline: Timeline, event: ThreadEvent): Timeline {
  switch (event.type) {
    case 'thread.started':
      return { ...timeline, thread: event.payload.thread, harness: event.payload.harness }
    case 'turn.started':
      return { ...timeline, turn: timeline.turn === 'stopping' ? 'stopping' : 'running', ended: null }
    case 'turn.completed':
      return { ...timeline, turn: 'idle', requests: [], ended: event.payload }
    case 'thread.token-usage.updated':
      return { ...timeline, usage: { used: event.payload.usedTokens, max: event.payload.maxTokens } }
    case 'content.delta': {
      const { streamKind, delta, itemId } = event.payload
      return { ...timeline, entries: said(timeline.entries, WHO[streamKind], delta, itemId) }
    }
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return { ...timeline, entries: tool(timeline.entries, event.payload) }
    case 'request.opened':
      return { ...timeline, requests: [...timeline.requests, event.payload] }
    case 'request.resolved':
      return {
        ...timeline,
        requests: timeline.requests.filter((one) => one.requestId !== event.payload.requestId),
      }
    case 'thread.metadata.updated':
    case 'turn.plan.updated':
      return timeline
  }
}

/** A delta joins the message it names, or the last message when it names
 *  none and the same voice is still speaking. */
function said(entries: Entry[], who: Message['who'], delta: string, itemId?: string): Entry[] {
  const last = entries[entries.length - 1]
  const at =
    itemId === undefined
      ? last?.kind === 'message' && last.who === who
        ? entries.length - 1
        : -1
      : entries.findIndex((one) => one.kind === 'message' && one.id === itemId)
  if (at === -1) {
    return [...entries, { kind: 'message', id: itemId ?? `said:${entries.length}`, who, text: delta }]
  }
  const found = entries[at] as Message
  return entries.with(at, { ...found, text: found.text + delta })
}

function tool(entries: Entry[], item: ChatItem): Entry[] {
  const at = entries.findIndex((one) => one.kind === 'tool' && one.id === item.itemId)
  if (at === -1) {
    return [
      ...entries,
      {
        kind: 'tool',
        id: item.itemId,
        itemType: item.itemType ?? 'dynamic_tool_call',
        status: item.status ?? 'inProgress',
        title: item.title ?? null,
        output: item.output ?? null,
      },
    ]
  }
  const found = entries[at] as Tool
  return entries.with(at, {
    ...found,
    itemType: item.itemType ?? found.itemType,
    status: item.status ?? found.status,
    title: item.title ?? found.title,
    output: item.output ?? found.output,
  })
}
