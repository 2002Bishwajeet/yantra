import {
  CONTEXT_LENGTHS,
  DEFAULT_MODE,
  EFFORTS,
  MODELS,
  MODES,
  type ClaudeModel,
  type ContextLength,
  type Effort,
  type Interaction,
  type PermissionMode,
} from '@/api/thread'

const KEY = 'yantra.chat.mode.'

/** The mode this browser kept for `thread`, or the default. The daemon keeps
 *  none, so a mode is the browser's (Y-453). */
export function recallMode(thread: string | null | undefined): PermissionMode {
  if (!thread) return DEFAULT_MODE
  try {
    const kept = localStorage.getItem(KEY + thread)
    return MODES.find((one) => one.mode === kept)?.mode ?? DEFAULT_MODE
  } catch {
    // A private window, or a browser that refuses site data.
    return DEFAULT_MODE
  }
}

export function keepMode(thread: string, mode: PermissionMode) {
  try {
    localStorage.setItem(KEY + thread, mode)
  } catch {
    // Held for this page only, which is the most that can be done.
  }
}

const INTERACTION = 'yantra.chat.interaction.'

/** Whether this browser kept `thread` in plan mode (Y-565), as `recallMode` keeps the mode. */
export function recallInteraction(thread: string | null | undefined): Interaction {
  if (!thread) return 'build'
  try {
    return localStorage.getItem(INTERACTION + thread) === 'plan' ? 'plan' : 'build'
  } catch {
    return 'build'
  }
}

export function keepInteraction(thread: string, interaction: Interaction) {
  try {
    localStorage.setItem(INTERACTION + thread, interaction)
  } catch {
    // As in keepMode.
  }
}

/** A value this browser kept for `thread` under `key`, if `known` holds it (Y-564). */
function recall<T extends string>(key: string, thread: string | null | undefined, known: readonly (T | null)[]) {
  if (!thread) return null
  try {
    const kept = localStorage.getItem(key + thread)
    return known.find((one) => one === kept) ?? null
  } catch {
    return null
  }
}

function keep(key: string, thread: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key + thread)
    else localStorage.setItem(key + thread, value)
  } catch {
    // Held for this page only, as with the mode.
  }
}

const MODEL_KEY = 'yantra.chat.model.'
const EFFORT_KEY = 'yantra.chat.effort.'

/** Claude's model this browser kept for `thread`, or `null` for Claude's default. */
export const recallModel = (thread: string | null | undefined): ClaudeModel | null =>
  recall(MODEL_KEY, thread, MODELS.map((one) => one.model))

export const keepModel = (thread: string, model: ClaudeModel | null) => keep(MODEL_KEY, thread, model)

export const recallEffort = (thread: string | null | undefined): Effort | null =>
  recall(EFFORT_KEY, thread, EFFORTS.map((one) => one.effort))

export const keepEffort = (thread: string, effort: Effort | null) => keep(EFFORT_KEY, thread, effort)

const CONTEXT_KEY = 'yantra.chat.context.'

/** The context length this browser kept for `thread` (Y-663), or `null` for the agent's default. */
export function recallContext(thread: string | null | undefined): ContextLength | null {
  const kept = recall(
    CONTEXT_KEY,
    thread,
    CONTEXT_LENGTHS.map((one) => (one.length === null ? null : String(one.length))),
  )
  return kept === null ? null : (Number(kept) as ContextLength)
}

export const keepContext = (thread: string, length: ContextLength | null) =>
  keep(CONTEXT_KEY, thread, length === null ? null : String(length))
