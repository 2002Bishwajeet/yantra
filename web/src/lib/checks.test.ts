import { describe, expect, it } from 'vitest'
import { CHECK_IDS, fixOf, nameOf, sessionNeeds } from './checks'

describe('the check name table', () => {
  it('names each of doctor’s ten checks the way a person says it', () => {
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
        'heartbeat',
      ].map(nameOf),
    ).toEqual(['ssh', 'sshd', 'tmux', 'git', 'claude', 'terminfo', 'gh', 'gh signed in', 'claude signed in', 'heartbeat'])
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
  })

  /** Y-390 review: GitHub and `yantra-agent` are optional for a session. */
  it('lists doctor’s ids in order, and says which of them a session needs', () => {
    expect(CHECK_IDS).toHaveLength(10)
    expect(CHECK_IDS.filter(sessionNeeds)).toEqual(['reachable', 'sshd', 'tmux', 'git', 'agent-cli', 'terminfo', 'login-session'])
    expect(sessionNeeds('docker')).toBe(false)
  })
})
