import { describe, expect, it } from 'vitest'
import { noAccess } from './dirs'

describe('a folder the machine refuses', () => {
  /** Y-591: on a Mac the reason, the fix in Apple's words, and what it costs. */
  it('on macOS gives the reason, the fix and the cost', () => {
    const said = noAccess('mbp', 'macOS')
    expect(said).toMatch(/^macOS blocks remote access to this folder\./)
    expect(said).toContain('System Settings > General > Sharing > Remote Login')
    expect(said).toContain('Allow full disk access for remote users')
    expect(said).toContain('Every ssh login to mbp, agents included, then gets that access.')
  })

  it('elsewhere, or with the machine unread, says only that the account cannot read it', () => {
    for (const os of ['linux', undefined]) {
      expect(noAccess('pi', os)).toBe('pi does not let this account read this folder.')
    }
  })
})
