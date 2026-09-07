import { afterEach, describe, expect, it } from 'vitest'
import { PREFS_KEY, readPrefs, writePrefs } from './prefs'

afterEach(() => {
  writePrefs({ seenAt: null, theme: 'system', density: 'clean', seed: null, general: {} })
  localStorage.clear()
})

describe('prefs', () => {
  it('round-trips a patch under one versioned key', () => {
    writePrefs({ theme: 'dark', density: 'compact' })
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({
      v: 1,
      seenAt: null,
      theme: 'dark',
      density: 'compact',
      seed: null,
      general: {},
    })
    expect(readPrefs().theme).toBe('dark')
  })

  it('keeps what a later version would drop, and fills what is missing', () => {
    writePrefs({ seenAt: 5 })
    expect(readPrefs()).toMatchObject({ v: 1, seenAt: 5, theme: 'system' })
  })
})
