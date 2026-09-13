import { describe, expect, it } from 'vitest'
import { apart, notYours, runsSessions } from './platform'

const yours = 'yours' as const

describe('what a node is', () => {
  it('runs a session on Linux and macOS only', () => {
    expect(runsSessions({ os: 'linux', ownership: yours })).toBe(true)
    expect(runsSessions({ os: 'macOS', ownership: yours })).toBe(true)
    for (const os of ['iOS', 'android', 'windows', 'freebsd', '']) {
      expect(runsSessions({ os, ownership: yours })).toBe(false)
    }
  })

  /** Y-404, owner 2026-09-13: a node your account does not own never counts. */
  it('runs no session on a node another owner holds', () => {
    expect(runsSessions({ os: 'linux', ownership: 'shared' })).toBe(false)
    expect(runsSessions({ os: 'macOS', ownership: 'tagged' })).toBe(false)
  })

  /** Owner, 2026-09-12: phones and tablets open the dashboard, and Windows
   *  is coming. */
  it('says what each other node is, and never hides one', () => {
    expect(apart({ os: 'iOS', ownership: yours })).toBe('opens the dashboard · runs no session')
    expect(apart({ os: 'android', ownership: yours })).toBe('opens the dashboard · runs no session')
    expect(apart({ os: 'windows', ownership: yours })).toContain('coming soon')
    expect(apart({ os: 'freebsd', ownership: yours })).toBe('freebsd · runs no session')
    expect(apart({ os: '', ownership: yours })).toBe('an unnamed system · runs no session')
  })

  it('names why a node is not yours before what system it runs', () => {
    expect(notYours({ ownership: yours })).toBeNull()
    expect(apart({ os: 'linux', ownership: 'shared' })).toBe('shared from another account · not supported yet')
    expect(apart({ os: 'iOS', ownership: 'tagged' })).toBe(
      'tagged, so the tailnet owns it and not your account · not supported yet',
    )
  })
})
