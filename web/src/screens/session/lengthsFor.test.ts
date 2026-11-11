import { describe, expect, it } from 'vitest'
import { lengthsFor } from '@/api/thread'

describe('lengthsFor', () => {
  const labels = (lengths: readonly { label: string }[]) => lengths.map((one) => one.label)

  it("offers Claude's larger models every length, and Haiku only the default", () => {
    for (const model of [null, 'fable', 'opus', 'sonnet'] as const) {
      expect(labels(lengthsFor('claude', model))).toEqual(['Default', '256K', '400K', '512K', '1M'])
    }
    expect(labels(lengthsFor('claude', 'haiku'))).toEqual(['Default'])
  })

  it('offers Codex no more than the window it last reported', () => {
    expect(labels(lengthsFor('codex', null))).toEqual(['Default', '256K', '400K', '512K', '1M'])
    expect(labels(lengthsFor('codex', null, 400_000))).toEqual(['Default', '256K', '400K'])
  })

  it('offers the harnesses that take no length nothing', () => {
    for (const harness of ['gemini', 'grok', 'opencode', null] as const) expect(lengthsFor(harness, null)).toEqual([])
  })
})
