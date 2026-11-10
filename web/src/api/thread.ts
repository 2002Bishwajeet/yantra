/*
 * The event names and payload vocabulary below are T3 Code's, as
 * crates/yantra-core/src/chat.rs re-expresses them:
 * https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/providerRuntime.ts
 * The permission modes' names and descriptions are T3 Code's at 72d5c32:
 * https://github.com/pingdotgg/t3code/blob/72d5c32ba67953805feb6fe9ad3b70b632a64c47/docs/user/permission-modes.md
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

/** When the agent asks a person first (Y-453). The daemon answers what the
 *  mode allows; on Claude, `auto` and `auto-accept-edits` are Claude's own. */
export type PermissionMode = 'supervised' | 'auto-accept-edits' | 'auto' | 'full-access'

/** Unlike T3 Code, a new thread starts supervised. */
export const DEFAULT_MODE: PermissionMode = 'supervised'

/** Whether a turn may change anything (Y-565): `plan` only reads and proposes
 *  a plan. Claude alone has it; T3 Code names `build` `default`. */
export type Interaction = 'build' | 'plan'

/** T3 Code's names and words for each mode, in its order. */
export const MODES: readonly { mode: PermissionMode; label: string; description: string }[] = [
  { mode: 'supervised', label: 'Supervised', description: 'Requests approval for commands and file changes.' },
  {
    mode: 'auto-accept-edits',
    label: 'Auto-accept edits',
    description: 'Approves file edits automatically; other actions can still require approval.',
  },
  {
    mode: 'auto',
    label: 'Auto',
    description: "Uses the provider's automatic review to approve routine actions and ask about others.",
  },
  { mode: 'full-access', label: 'Full access', description: 'Allows commands and edits without approval prompts.' },
]

/** Claude's `--model` aliases (Y-564). `null` sends no flag, so Claude picks. */
export type ClaudeModel = 'fable' | 'opus' | 'sonnet' | 'haiku'

export const MODELS: readonly { model: ClaudeModel | null; label: string }[] = [
  { model: null, label: 'Default' },
  { model: 'fable', label: 'Fable' },
  { model: 'opus', label: 'Opus' },
  { model: 'sonnet', label: 'Sonnet' },
  { model: 'haiku', label: 'Haiku' },
]

/** Claude's `--effort`; `null` sends no flag. The labels are T3 Code's. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORTS: readonly { effort: Effort | null; label: string }[] = [
  { effort: null, label: 'Default' },
  { effort: 'low', label: 'Low' },
  { effort: 'medium', label: 'Medium' },
  { effort: 'high', label: 'High' },
  { effort: 'xhigh', label: 'Extra High' },
  { effort: 'max', label: 'Max' },
]

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
  /** Not T3 Code's: how long the turn ran, as the agent measured it. */
  durationMs?: number
}

/** What turn `turn` changed in the thread's worktree (Y-448). `truncated` is a
 *  diff cut at 256 KiB. */
export type TurnDiff = { turn: number; unifiedDiff: string; truncated: boolean }

/** A slash command the agent expands when `/<name>` opens a prompt (Y-563).
 *  `hint` says what the argument is for; with none, the command takes no argument. */
export type SlashCommand = { name: string; description: string; hint?: string }

/** A task the agent runs past its turn (ADR-0041). `kind` is the agent's own
 *  word for it, such as `local_bash`. */
export type BackgroundTask = { taskId: string; kind: string; description: string }

/** `cursor` is `<run>:<line end>:<part>` on an event read from the agent's
 *  keeper, and absent on one the daemon made (ADR-0035). A reconnect sends the
 *  last one back as `after`. On `thread.started` it is the cursor the replay
 *  continues from; without one, the thread replays from the start. */
export type ThreadEvent = { threadId: string; cursor?: string } & (
  | { type: 'thread.started'; payload: { thread: string; harness: Harness } }
  | { type: 'thread.metadata.updated'; payload: { name: string } }
  | { type: 'thread.token-usage.updated'; payload: { usedTokens: number; maxTokens: number } }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; payload: TurnCompleted }
  | { type: 'turn.diff.updated'; payload: TurnDiff }
  /** Not T3 Code's: the files are back as checkpoint `turn` kept them. */
  | { type: 'thread.reverted'; payload: { turn: number } }
  /** Not T3 Code's: an ACP agent's slash commands, sent when its session opens. */
  | { type: 'thread.commands.updated'; payload: { commands: SlashCommand[] } }
  /** Not T3 Code's: the whole list of background tasks that still run, empty when none do. */
  | { type: 'thread.background.updated'; payload: { tasks: BackgroundTask[] } }
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

/** The chat route's query: the thread to attach to, and the last cursor drawn. */
export type ChatQuery = { thread?: string; after?: string }

/** What the browser sends. One turn runs at a time. */
export type ChatFrame =
  /** `harness` is read only on the turn that opens a thread. `mode` and
   *  `interaction` hold for this turn; absent, they are supervised and build.
   *  A Claude turn reads `model` and `effort`; an ACP one ignores them. */
  | {
      type: 'turn'
      text: string
      harness?: Harness
      mode?: PermissionMode
      interaction?: Interaction
      model?: string
      effort?: Effort
    }
  | { type: 'answer'; requestId: string; decision: Decision }
  /** Stops the turn; background tasks run on. */
  | { type: 'cancel' }
  /** Stops one background task; a failure is `stopTask`. */
  | { type: 'stopTask'; taskId: string }
  /** Stops every background task and the turn, and lets the keeper go. */
  | { type: 'stopAll' }
  /** Puts the files back as checkpoint `turn` kept them; the conversation stays. */
  | { type: 'revert'; turn: number }
  /** Asks for the thread's whole-branch diff; answered while a turn runs. */
  | { type: 'diff' }
  /** A browser cannot send a protocol ping, so it sends this; the daemon answers `pong`. */
  | { type: 'ping' }

/** The answer to `ping`. It proves the socket is alive and is no event. */
export type ChatPong = { type: 'pong' }

/** The one daemon frame that is not an event. `notLoggedIn` names the
 *  command to run on the machine, because the login stays there (ADR-0033 §6). */
export type ChatFailure =
  | {
      type: 'error'
      kind: 'unknownThread' | 'busy' | 'badFrame' | 'unreachable' | 'checkpoint' | 'diff' | 'stopTask'
      said: string
    }
  | { type: 'error'; kind: 'notLoggedIn'; said: string; harness: Harness; machine: string; command: string }

/** The one reply to each image the browser sends as a binary frame (Y-424),
 *  in the order they were sent. `path` is where the agent reads it. */
export type ChatAttached = { type: 'attached'; path: string }

export type ChatNotAttached = { type: 'notAttached'; kind: 'notAnImage' | 'unreachable'; said: string }

/** The turns a person sent while one runs (Y-561), as they are now. The daemon
 *  sends them as one prompt when the turn ends, and `cancel` empties the list. */
export type ChatQueue = { type: 'queue'; threadId: string; texts: string[] }

/** One file of a branch diff. No counts is a binary file; `from` is a rename's
 *  old path. */
export type ChangedFile = { path: string; from?: string; added?: number; deleted?: number }

/** The reply to a `diff` frame (Y-490): the thread's committed and uncommitted
 *  work since `base`. Each flag says a list or a diff was cut at 256 KiB. A failure is `diff`. */
export type ChatBranchDiff = {
  type: 'branchDiff'
  threadId: string
  base: string
  files: ChangedFile[]
  filesTruncated: boolean
  unifiedDiff: string
  truncated: boolean
}
