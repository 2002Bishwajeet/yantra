import type { MarkState } from './Mark'

/** The word a state carries when the caller gives none. */
export const word: Record<MarkState, string> = {
  needs: 'Needs you',
  running: 'Running',
  idle: 'Idle',
  unknown: 'Unknown',
  done: 'Done',
  failed: 'Failed',
}
