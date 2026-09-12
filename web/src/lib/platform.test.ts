import { describe, expect, it } from 'vitest'
import { apart, runsSessions } from './platform'

describe('what a node is', () => {
  it('runs a session on Linux and macOS only', () => {
    expect(runsSessions({ os: 'linux' })).toBe(true)
    expect(runsSessions({ os: 'macOS' })).toBe(true)
    for (const os of ['iOS', 'android', 'windows', 'freebsd', '']) {
      expect(runsSessions({ os })).toBe(false)
    }
  })

  /** Owner, 2026-09-12: phones and tablets open the dashboard, and Windows
   *  is coming. */
  it('says what each other node is, and never hides one', () => {
    expect(apart({ os: 'iOS' })).toBe('opens the dashboard · runs no session')
    expect(apart({ os: 'android' })).toBe('opens the dashboard · runs no session')
    expect(apart({ os: 'windows' })).toContain('coming soon')
    expect(apart({ os: 'freebsd' })).toBe('freebsd · runs no session')
    expect(apart({ os: '' })).toBe('an unnamed system · runs no session')
  })
})
