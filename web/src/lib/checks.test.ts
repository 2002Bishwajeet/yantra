import { describe, expect, it } from 'vitest'
import {
  answerFailure,
  CHECK_IDS,
  fixOf,
  joinFixes,
  nameOf,
  reachableFailure,
  reachWords,
  sessionNeeds,
  tookOf,
} from './checks'

describe('the check name table', () => {
  it('names each of doctor’s twelve checks the way a person says it', () => {
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
        'folder-access',
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
      'folder access',
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
    expect(fixOf('folder-access', 'mbp')).toEqual({
      by: 'hand',
      words:
        'To allow it, open System Settings > General > Sharing > Remote Login, and turn on Allow full disk access for remote users. Every ssh login to mbp, agents included, then gets that access.',
    })
  })

  /** Y-390 review: GitHub and `yantra-agent` are optional for a session. */
  it('lists doctor’s ids in order, and says which of them a session needs', () => {
    expect(CHECK_IDS).toHaveLength(12)
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
    expect(joinFixes('listing')).toBe(false)
  })
})

/** Y-585: what `sessions.rs` and `status.rs` send as `reached: 'no'`, after
 *  yantrad's `because`. Only ssh's `Transport` starts with the prefix. */
describe('a failed sessions or status answer', () => {
  const ssh = (diagnosis: string) => `ssh to pi failed before the command reported a status: ${diagnosis}`

  it('reads an ssh failure as reachableFailure does', () => {
    expect(answerFailure(ssh('yantra@pi: Permission denied (publickey).'))).toBe('refused')
    expect(answerFailure(ssh('the ssh config here names no account for pi'))).toBe('unjoined')
    expect(answerFailure(ssh('# Tailscale SSH requires an additional check.'))).toBe('browser')
    expect(answerFailure(ssh('connect to host pi port 22: No route to host'))).toBe('unreachable')
  })

  it('never calls a tmux or local failure an ssh one', () => {
    expect(answerFailure('tmux `list-sessions` failed with status 1: protocol version mismatch (client 8, server 7)')).toBe(
      'listing',
    )
    expect(
      answerFailure('tmux `list-sessions` failed with status 1: error connecting to /tmp/tmux-1000/default (Permission denied)'),
    ).toBe('listing')
    expect(answerFailure('could not spawn `ssh` — is OpenSSH installed and on PATH?: No such file or directory')).toBe('listing')
    expect(answerFailure('Permission denied (publickey).')).toBe('listing')
  })

  it('gives a listing failure its own words, which send no one to the join command', () => {
    const { cause, next } = reachWords('listing', 'pi')
    expect(cause).toBe('Yantra could not list the sessions on pi.')
    expect(next).toContain('not an ssh failure')
    expect(`${cause} ${next}`).not.toMatch(/key|refused|ssh to/i)
  })
})

describe('how long a step took', () => {
  it('reads as milliseconds under a second, and seconds above', () => {
    expect(tookOf(0)).toBe('0 ms')
    expect(tookOf(84)).toBe('84 ms')
    expect(tookOf(1_240)).toBe('1.2 s')
  })
})
