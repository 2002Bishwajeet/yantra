import { describe, expect, it } from 'vitest'
import { CHECK_IDS, fixOf, joinFixes, nameOf, reachableFailure, reachWords, sessionNeeds, tookOf } from './checks'

describe('the check name table', () => {
  it('names each of doctor’s eleven checks the way a person says it', () => {
    expect(
      [
        'reachable',
        'sshd',
        'tmux',
        'git',
        'agent-cli',
        'terminfo',
        'provider-cli',
        'provider-auth',
        'login-session',
        'mic',
        'heartbeat',
      ].map(nameOf),
    ).toEqual([
      'ssh',
      'sshd',
      'tmux',
      'git',
      'claude',
      'terminfo',
      'gh',
      'gh signed in',
      'claude signed in',
      'microphone',
      'heartbeat',
    ])
  })

  it('keeps an id it does not know, rather than hiding it', () => {
    expect(nameOf('docker')).toBe('docker')
    expect(fixOf('docker', 'pi')).toBeNull()
  })

  it('says who fixes each one', () => {
    expect(fixOf('reachable', 'pi')).toEqual({ by: 'join' })
    expect(fixOf('agent-cli', 'pi')).toEqual({ by: 'install' })
    expect(fixOf('terminfo', 'pi')).toEqual({ by: 'command', command: 'yantra fix-terminfo pi', where: 'appliance' })
    expect(fixOf('provider-auth', 'pi')).toEqual({ by: 'command', command: 'gh auth login', where: 'machine' })
    expect(fixOf('mic', 'pi')).toEqual({ by: 'hand', words: 'Run Install with Microphone ticked.' })
  })

  /** Y-390 review: GitHub and `yantra-agent` are optional for a session. */
  it('lists doctor’s ids in order, and says which of them a session needs', () => {
    expect(CHECK_IDS).toHaveLength(11)
    expect(CHECK_IDS.filter(sessionNeeds)).toEqual(['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo', 'login-session'])
    expect(sessionNeeds('docker')).toBe(false)
  })
})

describe('a failed reach', () => {
  const BROWSER = 'Tailscale SSH requires an additional check, which needs a browser sign-in'

  it('reads each failure by its words', () => {
    expect(reachableFailure('the ssh config here names no account for pi')).toBe('unjoined')
    expect(reachableFailure(BROWSER)).toBe('browser')
    expect(reachableFailure('yantra@pi: Permission denied (publickey).')).toBe('refused')
    expect(reachableFailure('No route to host')).toBe('unreachable')
  })

  /** `name_the_account` prefixes the detail, and a browser check ends before
   *  any key is tried, so these are the two orders that matter. */
  it('puts a missing account first, then the browser, then the key', () => {
    expect(reachableFailure(`the ssh config here names no account for pi · ${BROWSER}`)).toBe('unjoined')
    expect(reachableFailure(`${BROWSER} · Permission denied`)).toBe('browser')
  })

  it('gives every failure a cause and a next step that name the machine, and no raw ssh', () => {
    for (const kind of ['refused', 'unjoined', 'browser', 'unreachable'] as const) {
      const { cause, next } = reachWords(kind, 'pi')
      expect(cause).toContain('pi')
      expect(next.length).toBeGreaterThan(0)
      expect(`${cause} ${next}`).not.toMatch(/Permission denied|port 22|http/)
    }
  })

  it('offers normal ssh or the tailnet rule for a browser check', () => {
    const { cause, next } = reachWords('browser', 'pi')
    expect(cause).toBe('Yantra can’t reach pi because Tailscale asks for a browser sign-in on each connection.')
    expect(next).toContain('join command')
    expect(next).toContain('normal ssh')
    expect(next).toContain('from check to accept')
  })

  it('keeps the join command away from the one failure it cannot fix', () => {
    expect(joinFixes('refused')).toBe(true)
    expect(joinFixes('unjoined')).toBe(true)
    expect(joinFixes('browser')).toBe(true)
    expect(joinFixes('unreachable')).toBe(false)
  })
})

describe('how long a step took', () => {
  it('reads as milliseconds under a second, and seconds above', () => {
    expect(tookOf(0)).toBe('0 ms')
    expect(tookOf(84)).toBe('84 ms')
    expect(tookOf(1_240)).toBe('1.2 s')
  })
})
