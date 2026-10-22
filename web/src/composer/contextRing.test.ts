import { describe, expect, it } from 'vitest'
import { formatPercentage, formatTokens, isOverloaded, usedShare } from './contextRing'

describe('the context ring', () => {
  it('reads the share of the window used', () => {
    expect(usedShare({ used: 29149, max: 200000 })).toBeCloseTo(14.57, 1)
    expect(formatPercentage(usedShare({ used: 29149, max: 200000 }))).toBe('15%')
    expect(formatPercentage(4.25)).toBe('4.3%')
    expect(formatPercentage(0)).toBe('0%')
  })

  it('stays between 0 and 100 when the numbers are odd', () => {
    expect(usedShare({ used: 300, max: 200 })).toBe(100)
    expect(usedShare({ used: -5, max: 200 })).toBe(0)
    expect(usedShare({ used: 5, max: 0 })).toBe(0)
  })

  it('turns to the error colour above 90 percent and not at it', () => {
    expect(isOverloaded({ used: 182000, max: 200000 })).toBe(true)
    expect(isOverloaded({ used: 180000, max: 200000 })).toBe(false)
    expect(isOverloaded({ used: 29149, max: 200000 })).toBe(false)
  })

  it('writes tokens short', () => {
    expect([512, 1200, 29149, 200000, 1_000_000].map(formatTokens)).toEqual(['512', '1.2k', '29k', '200k', '1m'])
  })
})
