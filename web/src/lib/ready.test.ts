import { describe, expect, it } from 'vitest'
import type { Readiness } from '@/api'
import { blocking, isReady, READY } from './ready'

const report = (states: Record<string, string>): Readiness => ({
  machine: 'pi-5',
  checks: Object.entries(states).map(([check, state]) => ({ check, state, detail: '' })) as Readiness['checks'],
})
const seven = (): Record<string, string> => Object.fromEntries(READY.map((one) => [one, 'present']))

describe('ready', () => {
  it('is the seven checks a session needs, all present', () => {
    expect(READY).toEqual(['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo', 'login-session'])
    expect(isReady(report(seven()))).toBe(true)
  })

  /** Coordinator's ruling by the owner's delegation, 2026-09-13: GitHub and
   *  `yantra-agent` are optional. */
  it('is not held back by gh, its sign-in or a heartbeat', () => {
    const optional = report({ ...seven(), 'provider-cli': 'absent', 'provider-auth': 'unknown', heartbeat: 'absent' })
    expect(isReady(optional)).toBe(true)
    expect(blocking(optional)).toEqual([])
  })

  it('is held back by any one of the seven', () => {
    for (const one of READY) {
      expect(isReady(report({ ...seven(), [one]: 'absent' }))).toBe(false)
      expect(isReady(report({ ...seven(), [one]: 'unknown' }))).toBe(false)
    }
  })

  it('counts a check the report does not carry as not asked, and no report as not ready', () => {
    const six = Object.fromEntries(READY.filter((one) => one !== 'terminfo').map((one) => [one, 'present']))
    expect(blocking(report(six))).toEqual([{ check: 'terminfo', state: 'unknown', detail: '' }])
    expect(isReady(report(six))).toBe(false)
    expect(isReady(null)).toBe(false)
  })
})
