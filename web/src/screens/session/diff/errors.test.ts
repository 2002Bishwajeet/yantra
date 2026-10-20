import { describe, expect, it } from 'vitest'
import { DiffError, type DiffErrorKind } from './errors'

const KINDS: DiffErrorKind[] = ['notOpen', 'noThread', 'failed', 'threadsFailed', 'loadFailed']

describe('a diff error', () => {
  it('has a sentence of its own for every kind', () => {
    const sentences = KINDS.map((kind) => new DiffError(kind).describe())
    expect(new Set(sentences).size).toBe(KINDS.length)
    for (const sentence of sentences) expect(sentence).toMatch(/\.$/)
  })

  it('keeps the daemon’s words verbatim, and falls back to its sentence', () => {
    const said = new DiffError('failed', 'fatal: bad object')
    expect(said.said).toBe('fatal: bad object')
    expect(said.message).toBe('fatal: bad object')
    expect(new DiffError('notOpen').said).toBe('')
  })

  it('offers a retry for all but noThread, which only a first message changes', () => {
    expect(KINDS.filter((kind) => new DiffError(kind).retryable)).toEqual(['notOpen', 'failed', 'threadsFailed', 'loadFailed'])
  })
})
