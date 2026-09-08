import { describe, expect, it } from 'vitest'
import { elapsed, isAge, oldest } from './clock'

describe('elapsed', () => {
  it('reads seconds, minutes, then hours with minutes, then a date', () => {
    expect(elapsed(4)).toBe('4s')
    expect(elapsed(11 * 60 + 30)).toBe('11m')
    expect(elapsed(3 * 3600 + 41 * 60)).toBe('3h 41m')
    expect(elapsed(2 * 3600)).toBe('2h')
    expect(elapsed(3 * 86400)).toMatch(/^\d{1,2} \w{3}$/)
    expect(elapsed(-5)).toBe('0s')
  })
})

describe('isAge', () => {
  it('stops where elapsed stops counting, so a date never takes an `ago`', () => {
    expect(isAge(23 * 3600)).toBe(true)
    expect(isAge(86400)).toBe(false)
    expect(isAge(4 * 86400)).toBe(false)
  })
})

describe('oldest', () => {
  it('is the oldest read, never an average, and null while one is pending', () => {
    expect(oldest([{ looked: 'ok', age_seconds: 4, data: 1 }, { looked: 'failed', age_seconds: 51, error: 'x' }])).toBe(51)
    expect(oldest([{ looked: 'ok', age_seconds: 4, data: 1 }, { looked: 'pending' }])).toBeNull()
    expect(oldest([{ looked: 'never' }])).toBeNull()
    expect(oldest([])).toBeNull()
  })
})
