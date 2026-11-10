import { describe, expect, it } from 'vitest'
import {
  answerFailure,
  CHECK_IDS,
  fixOf,
  joinFixes,
  LOGIN_SERVER_COMMAND,
  noLoginServer,
  nameOf,
  reachableFailure,
  reachWords,
  sessionNeeds,
  tookOf,
  withoutSignIn,
} from './checks'
import { CHANGED_KEY, CHECK_RULE } from '@/test/sshSaid'

/** doctor.rs `no_login_server`, word for word. */
const NO_SERVER =
  'no tmux server from a login session is running on this Mac. Panes in a server started over ssh cannot read the login keychain, so Yantra starts one in the login session when a session starts. Start one in Terminal there: `tmux -L yantra new-session -d`'

describe('the check name table', () => {
  it('names each of doctor’s thirteen checks the way a person says it', () => {
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
        'hooks',
        'no-sudo',
        'heartbeat',
      ].map(nameOf),
    ).toEqual([
      'ssh',
      'sshd',
      'tmux',
      'git',
      'claude',
      'terminfo',
      'gh installed',
      'gh signed in',
      'claude signed in',
      'microphone',
      'folder access',
      'agent hooks',
      'account without sudo',
      'usage reports',
    ])
  })

  it('keeps an id it does not know, rather than hiding it', () => {
    expect(nameOf('docker')).toBe('docker')
    expect(fixOf({ check: 'docker' }, 'pi')).toBeNull()
  })

  it('says who fixes each one', () => {
    expect(fixOf({ check: 'reachable' }, 'pi')).toEqual({ by: 'join' })
    expect(fixOf({ check: 'agent-cli' }, 'pi')).toEqual({ by: 'install' })
    expect(fixOf({ check: 'terminfo' }, 'pi')).toEqual({ by: 'command', command: 'yantra fix-terminfo pi', where: 'appliance' })
    expect(fixOf({ check: 'provider-auth' }, 'pi')).toEqual({ by: 'command', command: 'gh auth login', where: 'machine' })
    expect(fixOf({ check: 'mic' }, 'pi')).toEqual({ by: 'hand', words: 'Run Install with Microphone ticked.' })
    expect(fixOf({ check: 'folder-access' }, 'mbp')).toEqual({
      by: 'hand',
      words:
        'To allow it, open System Settings > General > Sharing > Remote Login, and turn on Allow full disk access for remote users. Every ssh login to mbp, agents included, then gets that access.',
    })
    expect(fixOf({ check: 'hooks' }, 'mbp')).toEqual({
      by: 'hand',
      words:
        'Install the command where the agent finds it, or put its directory on PATH in your login shell. Yantra reads that PATH when it next starts tmux.',
    })
    expect(sessionNeeds('hooks')).toBe(false)
    expect(fixOf({ check: 'no-sudo' }, 'mbp')).toEqual({
      by: 'hand',
      words: 'Agents run as the account that joined. Join a separate account without sudo, named karigar: Add a device shows how.',
    })
    expect(sessionNeeds('no-sudo')).toBe(false)
  })

  /** Y-619: on a Mac with no login tmux server, both keychain checks are
   *  fixed in Terminal there, and neither is a sign-in. */
  it('gives a Mac with no login tmux server the Terminal command, not a sign-in', () => {
    const terminal = { by: 'command', command: 'tmux -L yantra new-session -d', where: 'terminal' }
    expect(fixOf({ check: 'login-session', detail: NO_SERVER }, 'mbp')).toEqual(terminal)
    expect(fixOf({ check: 'provider-auth', detail: NO_SERVER }, 'mbp')).toEqual(terminal)
    expect(fixOf({ check: 'provider-auth', detail: 'gh found no credential there' }, 'mbp')).toEqual({
      by: 'command',
      command: 'gh auth login',
      where: 'machine',
    })
  })

  /** Y-631: the four Rust sentences for this one refusal, word for word. */
  it.each([
    [
      'up.rs',
      '`mbp` runs macOS and has no tmux server, and Yantra will not start one there: panes in a server started over ssh cannot read the login keychain, so the agent would come up unauthenticated. Start one from a login session on that machine — in Terminal: `tmux new-session -d`',
    ],
    [
      'clone.rs',
      '`mbp` runs macOS and has no tmux server, and Yantra will not start one there (ADR-0018 §1). Start one from a login session on that machine: `tmux new-session -d`',
    ],
    [
      'commit.rs',
      'the Mac has no tmux server from a login session, so git and claude there cannot read the login keychain (ADR-0018 §1). Start one there: `tmux new-session -d`',
    ],
    ['doctor.rs', NO_SERVER],
  ])('knows the %s sentence for a missing login tmux server', (_, said) => {
    expect(noLoginServer(said)).toBe(true)
  })

  /** Y-667: Yantra asks only the `yantra` server, so the copied command must start that one. */
  it('copies the command doctor.rs gives', () => {
    expect(NO_SERVER).toContain(`\`${LOGIN_SERVER_COMMAND}\``)
  })

  it('does not take another refusal for a missing login tmux server', () => {
    expect(noLoginServer('claude finds no credential where the agent will run (method: none)')).toBe(false)
    expect(noLoginServer('workspace `quiet-otter` already exists')).toBe(false)
  })

  /** Y-390 review: GitHub and `yantra-agent` are optional for a session. */
  it('lists doctor’s ids in order, and says which of them a session needs', () => {
    expect(CHECK_IDS).toHaveLength(14)
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

  /** Y-621: the two lines Tailscale really sends, and OpenSSH's changed key. */
  it('reads the real refusal texts', () => {
    expect(reachableFailure(CHECK_RULE)).toBe('browser')
    expect(reachableFailure(CHANGED_KEY)).toBe('changed')
    expect(reachableFailure('sshd refused this connection: Host key verification failed.')).toBe('changed')
  })

  it('puts the browser check before a changed key, and a changed key before the key', () => {
    expect(reachableFailure(`${BROWSER} · Host key verification failed.`)).toBe('browser')
    expect(reachableFailure(`${CHANGED_KEY} · Permission denied`)).toBe('changed')
  })

  it('drops the dead sign-in link and keeps the rest of what ssh said', () => {
    const shown = withoutSignIn(CHECK_RULE)
    expect(shown).not.toContain('login.tailscale.com')
    expect(shown).toContain('Tailscale SSH requires an additional check.')
    expect(withoutSignIn(CHANGED_KEY)).toBe(CHANGED_KEY)
  })

  it('gives every failure a cause and a next step that name the machine, and no raw ssh', () => {
    for (const kind of ['refused', 'unjoined', 'browser', 'changed', 'unreachable'] as const) {
      const { cause, next } = reachWords(kind, 'pi')
      expect(cause).toContain('pi')
      expect(next.length).toBeGreaterThan(0)
      expect(`${cause} ${next}`).not.toMatch(/Permission denied|port 22|http/)
    }
  })

  it('offers normal ssh or the tailnet rule for a browser check', () => {
    const { cause, next } = reachWords('browser', 'pi')
    expect(cause).toBe('Tailscale SSH on pi waits for a browser sign-in, and the appliance has no browser.')
    expect(next).toBe(
      'Run the join command on pi; it turns on normal ssh with the appliance’s key. Or change the tailnet’s SSH rule from check to accept.',
    )
  })

  it('names the forget command for a changed key, and only once a person knows why', () => {
    const { cause, next } = reachWords('changed', 'pi')
    expect(cause).toBe(
      'pi answered with a different host key than the one the appliance recorded. Turning Tailscale SSH off changes it, and so does a reinstall.',
    )
    expect(next).toBe(
      'If you know why it changed, run sudo -u yantra -H yantra forget-host-key pi on the appliance, then Check again. If you do not, find out first.',
    )
    expect(reachWords('unreachable', 'pi').cause).not.toContain('host key')
  })

  it('keeps the join command away from the failures it cannot fix', () => {
    expect(joinFixes('refused')).toBe(true)
    expect(joinFixes('unjoined')).toBe(true)
    expect(joinFixes('browser')).toBe(true)
    expect(joinFixes('changed')).toBe(false)
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
    expect(answerFailure(ssh(CHECK_RULE))).toBe('browser')
    expect(answerFailure(ssh('Host key verification failed.'))).toBe('changed')
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
