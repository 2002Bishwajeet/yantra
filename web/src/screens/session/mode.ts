import { DEFAULT_MODE, EFFORTS, MODELS, MODES, type ClaudeModel, type Effort, type PermissionMode } from '@/api/thread'

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
