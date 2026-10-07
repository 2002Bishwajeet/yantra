import { DEFAULT_MODE, MODES, type PermissionMode } from '@/api/thread'

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
