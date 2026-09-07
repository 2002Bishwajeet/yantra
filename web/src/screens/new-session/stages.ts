import type { ApiError } from '@/api/errors'

/** The four things the starting screen does, in order (NewSessionCloning). */
export type StageId = 'clone' | 'create' | 'start' | 'open'

export type Stage = {
  id: StageId
  state: 'waiting' | 'running' | 'done' | 'skipped' | 'refused'
  /** The last line of clone output, or what a stage found. */
  detail: string | null
  error: ApiError | null
}

export type Stages = Stage[]

export const ORDER: readonly StageId[] = ['clone', 'create', 'start', 'open']

/** The first stage still to do, or null when every stage is done. */
export const next = (stages: Stages): StageId | null =>
  stages.find((one) => one.state !== 'done' && one.state !== 'skipped')?.id ?? null

export function begin(clone: boolean, already: string | null): Stages {
  return ORDER.map((id) => ({
    id,
    state: id === 'clone' && !clone ? 'skipped' : 'waiting',
    detail: id === 'clone' && !clone ? already : null,
    error: null,
  }))
}

export type Event =
  | { type: 'running'; stage: StageId; detail?: string }
  | { type: 'progress'; stage: StageId; detail: string }
  | { type: 'done'; stage: StageId; detail?: string }
  | { type: 'refused'; stage: StageId; error: ApiError }
  /** Try again: the refused stage goes back to waiting; the done ones stay done. */
  | { type: 'retry' }

export function advance(stages: Stages, event: Event): Stages {
  return stages.map((one) => {
    if (event.type === 'retry') {
      return one.state === 'refused' ? { ...one, state: 'waiting', error: null } : one
    }
    if (one.id !== event.stage) return one
    switch (event.type) {
      case 'running':
        return { ...one, state: 'running', detail: event.detail ?? one.detail, error: null }
      case 'progress':
        return { ...one, detail: event.detail }
      case 'done':
        return { ...one, state: 'done', detail: event.detail ?? one.detail }
      case 'refused':
        return { ...one, state: 'refused', error: event.error }
    }
  })
}
