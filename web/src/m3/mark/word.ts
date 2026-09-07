import type { MarkState } from './Mark'

/** The word a state carries when the caller gives none. */
export const word: Record<MarkState, string> = {
  needs: 'needs you',
  running: 'running',
  idle: 'idle',
  unknown: 'unknown',
  done: 'done',
  failed: 'failed',
}
