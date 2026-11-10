import { describe, expect, it } from 'vitest'
import { at, seen } from './time'

describe('seen', () => {
  it('reads an age under a day as "ago"', () => {
    expect(seen('45s')).toBe('45s ago')
    expect(seen('3h')).toBe('3h ago')
  })

  it('reads a date as "on", never "8 Oct ago"', () => {
    expect(seen('8 Oct')).toBe('on 8 Oct')
  })

  it('agrees with `at` on both sides of the day boundary', () => {
    const now = Date.parse('2026-11-05T12:00:00Z')
    expect(seen(at('2026-11-05T01:00:00Z', now)!.text)).toBe('11h ago')
    expect(seen(at('2026-11-04T11:00:00Z', now)!.text)).toMatch(/^on \d{1,2} \p{L}+$/u)
  })
})
