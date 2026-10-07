/*
 * The event names and payload vocabulary below are T3 Code's, as
 * crates/yantra-core/src/chat.rs re-expresses them:
 * https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/providerRuntime.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */

/** The chat socket's wire (ADR-0026, Y-356): what `GET /api/workspaces/{name}/chat`
 *  sends and takes. `contract.gen.ts` checks every shape here against what
 *  `yantrad` serialises. */

/** Who speaks in a thread: Claude over the stream-json bridge, or an ACP
 *  harness (ADR-0033). A thread keeps the one its first turn picked. */
export type Harness = 'claude' | 'codex' | 'gemini' | 'grok' | 'opencode'

export const HARNESSES: readonly Harness[] = ['claude', 'codex', 'gemini', 'grok', 'opencode']

/** How the chat names each harness: opencode writes its own name in lower case. */
export const LABEL: Record<Harness, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  grok: 'Grok',
  opencode: 'opencode',
}

export type StreamKind = 'assistant_text' | 'reasoning_text' | 'user_text'

export type ItemType = 'command_execution' | 'file_change' | 'web_search' | 'dynamic_tool_call'

export type ItemStatus = 'inProgress' | 'completed' | 'failed'

export type Decision = 'accept' | 'acceptAlways' | 'decline' | 'cancel'

export type RequestType =
  | 'exec_command_approval'
  | 'file_read_approval'
  | 'file_change_approval'
  | 'dynamic_tool_call'

export type TurnState = 'completed' | 'cancelled' | 'failed'

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

export type FileChange = { path: string; oldText: string | null; newText: string }

/** A tool call. On `item.updated` and `item.completed` an absent field is
 *  unchanged. */
export type ChatItem = {
  itemId: string
  itemType?: ItemType
  status?: ItemStatus
  /** What the tool acts on: the command, the path. */
  title?: string
  output?: string
  changes?: FileChange[]
}

export type RequestOption = { optionId: string; label: string; decision: Decision }

export type RequestOpened = {
  requestId: string
  requestType: RequestType
  itemId?: string
  title?: string
  detail?: string
  options: RequestOption[]
}

export type TurnCompleted = {
  state: TurnState
  stopReason?: StopReason
  /** Why a failed turn failed, in the agent's or ssh's own words. */
  message?: string
}

export type ThreadEvent = { threadId: string } & (
  | { type: 'thread.started'; payload: { thread: string; harness: Harness } }
  | { type: 'thread.metadata.updated'; payload: { name: string } }
  | { type: 'thread.token-usage.updated'; payload: { usedTokens: number; maxTokens: number } }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; payload: TurnCompleted }
  | {
      type: 'turn.plan.updated'
      payload: { plan: { step: string; status: 'pending' | 'inProgress' | 'completed' }[] }
    }
  | { type: 'content.delta'; payload: { streamKind: StreamKind; delta: string; itemId?: string } }
  | { type: 'item.started' | 'item.updated' | 'item.completed'; payload: ChatItem }
  | { type: 'request.opened'; payload: RequestOpened }
  | {
      type: 'request.resolved'
      payload: { requestId: string; requestType: RequestType; decision: Decision }
    }
)

/** What the browser sends. One turn runs at a time. */
export type ChatFrame =
  /** `harness` is read only on the turn that opens a thread. */
  | { type: 'turn'; text: string; harness?: Harness }
  | { type: 'answer'; requestId: string; decision: Decision }
  | { type: 'cancel' }

/** The one daemon frame that is not an event. `notLoggedIn` names the
 *  command to run on the machine, because the login stays there (ADR-0033 §6). */
export type ChatFailure =
  | { type: 'error'; kind: 'unknownThread' | 'busy' | 'badFrame' | 'unreachable'; said: string }
  | { type: 'error'; kind: 'notLoggedIn'; said: string; harness: Harness; machine: string; command: string }
