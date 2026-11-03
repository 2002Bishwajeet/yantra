import { DEFAULT_MODE, MODES, type Interaction, type PermissionMode } from '@/api/thread'

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
