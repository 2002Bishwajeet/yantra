/** D7 §3.5: one name per check on every screen, and what fixes it. `doctor`
 *  keeps the ids; a person reads the names. */

import type { Check } from '@/api'

/** Apple's words for the one switch that lets an ssh login read the folders
 *  macOS guards (support.apple.com/guide/mac-help/mchlp1066, 2026-11-03), and its cost. */
export const fullDisk = (machine: string) =>
  `To allow it, open System Settings > General > Sharing > Remote Login, and turn on Allow full disk access for remote users. Every ssh login to ${machine}, agents included, then gets that access.`

/** Who fixes a check that is missing. */
export type Fix =
  | { by: 'join' }
  | { by: 'install' }
  | { by: 'command'; command: string; where: 'appliance' | 'machine' | 'terminal' }
  | { by: 'hand'; words: string }

/** `session`: a session cannot start on the machine without it, which is what
 *  `lib/ready` asks. GitHub and the usage reports are optional (Y-390 review). */
const CHECKS: Record<string, { name: string; fix: (machine: string) => Fix; session: boolean }> = {
  reachable: { name: 'ssh', fix: () => ({ by: 'join' }), session: true },
  sshd: { name: 'sshd', fix: () => ({ by: 'join' }), session: true },
  tmux: { name: 'tmux', fix: () => ({ by: 'install' }), session: true },
  git: { name: 'git', fix: () => ({ by: 'install' }), session: true },
  'agent-cli': { name: 'claude', fix: () => ({ by: 'install' }), session: true },
  terminfo: {
    name: 'terminfo',
    fix: (machine) => ({ by: 'command', command: `yantra fix-terminfo ${machine}`, where: 'appliance' }),
    session: true,
  },
  'provider-cli': {
    name: 'gh installed',
    fix: () => ({ by: 'hand', words: 'Install gh with that machine’s package manager.' }),
    session: false,
  },
  'provider-auth': {
    name: 'gh signed in',
    fix: () => ({ by: 'command', command: 'gh auth login', where: 'machine' }),
    session: false,
  },
  // doctor.rs `login_session`: whether claude finds a credential where the agent runs.
  'login-session': {
    name: 'claude signed in',
    fix: () => ({ by: 'hand', words: 'Run claude on that machine and log in.' }),
    session: true,
  },
  // ADR-0031 §9: optional, so a machine without it is still ready.
  mic: {
    name: 'microphone',
    fix: () => ({ by: 'hand', words: 'Run Install with Microphone ticked.' }),
    session: false,
  },
  // Y-591: only a warning, because a session outside those folders works.
  'folder-access': {
    name: 'folder access',
    fix: (machine) => ({ by: 'hand', words: fullDisk(machine) }),
    session: false,
  },
  // Y-640: a warning, because the agent starts and only its hooks fail.
  hooks: {
    name: 'agent hooks',
    fix: () => ({
      by: 'hand',
      words:
        'Install the command where the agent finds it, or put its directory on PATH in your login shell. Yantra reads that PATH when it next starts tmux.',
    }),
    session: false,
  },
  // Y-628: a warning, because sessions run; ADR-0046 says why agents must not hold sudo.
  'no-sudo': {
    name: 'account without sudo',
    fix: () => ({
      by: 'hand',
      words:
        'Agents run as the account that joined. Join a separate account without sudo, named karigar: Add a device shows how.',
    }),
    session: false,
  },
  // The agent's heartbeat, which carries the usage reports (Y-740).
  heartbeat: {
    name: 'yantra-agent',
    fix: () => ({ by: 'hand', words: 'The join command offers Yantra’s agent, which reports CPU, memory and disk.' }),
    session: false,
  },
}

/** `doctor`'s fourteen ids, in its order. */
export const CHECK_IDS: readonly string[] = Object.keys(CHECKS)

export const nameOf = (check: string): string => CHECKS[check]?.name ?? check

/** What a person types in Terminal on a Mac to start the login tmux server (I-44).
 *  Yantra asks only the server named `yantra` (Y-667). */
export const LOGIN_SERVER_COMMAND = 'tmux -L yantra new-session -d'

/** Every daemon sentence for this one refusal: doctor.rs `NO_LOGIN_SERVER` (said by
 *  `login-session` and `provider-auth`), up.rs, clone.rs and commit.rs. */
export const noLoginServer = (detail: string) => /no tmux server/.test(detail)

/** api.rs `behind` (Y-713): an agent older than the daemon. `agent` is null when it sends no version. */
const OLDER_AGENT = /^yantra-agent here (?:is v(\S+) and yantrad is|sends no version, so it predates yantrad) v(\S+?)\.(?:\s|$)/
const UPDATE = /`([^`]+)`/

export function olderAgent(check: Pick<Check, 'check'> & Partial<Pick<Check, 'detail'>>): { agent: string | null; daemon: string } | null {
  const said = check.check === 'heartbeat' ? OLDER_AGENT.exec(check.detail ?? '') : null
  return said ? { agent: said[1] ?? null, daemon: said[2]! } : null
}

/** doctor.rs `unrunnable` (Y-740): claude is there, but the account that runs agents cannot run it. */
export const unrunnable = (check: Pick<Check, 'check'> & Partial<Pick<Check, 'detail'>>): boolean =>
  check.check === 'agent-cli' && /this account cannot run it/.test(check.detail ?? '')

/** A check with no detail gets the fix its id names. */
export function fixOf(check: Pick<Check, 'check'> & Partial<Pick<Check, 'detail'>>, machine: string): Fix | null {
  if (noLoginServer(check.detail ?? '')) return { by: 'command', command: LOGIN_SERVER_COMMAND, where: 'terminal' }
  const update = olderAgent(check) ? UPDATE.exec(check.detail ?? '') : null
  if (update) return { by: 'command', command: update[1]!, where: 'machine' }
  return CHECKS[check.check]?.fix(machine) ?? null
}

/** A nightly's version carries `-nightly.`; a Mac has no build of it (ADR-0027). */
export const isNightly = (version: string | undefined): boolean => /-nightly\./.test(version ?? '')

const SHORT_REACH: Record<ReachableFailure, string> = {
  refused: 'key refused',
  unjoined: 'no account named',
  browser: 'waits for a browser sign-in',
  changed: 'host key changed',
  unreachable: 'ssh cannot reach it',
}

const SHORT_ABSENT: Record<string, string> = {
  sshd: 'not answering',
  tmux: 'not found',
  git: 'not found',
  'agent-cli': 'not found',
  mic: 'not found',
  terminfo: 'lacks xterm-256color',
  'provider-cli': 'gh not found',
  'provider-auth': 'gh not signed in',
  'login-session': 'claude not signed in',
  'folder-access': 'macOS blocks your folders',
  hooks: 'hook command not on PATH',
  'no-sudo': 'it can use sudo',
}

/** What is wrong, in at most eight words. The daemon's own detail waits behind the row's Fix. */
export function causeOf(check: Pick<Check, 'check' | 'state'> & Partial<Pick<Check, 'detail'>>): string {
  if (check.state === 'present') return ''
  const detail = check.detail ?? ''
  if (check.state !== 'absent') return 'could not be asked'
  if (noLoginServer(detail)) return 'no tmux server from a login'
  if (check.check === 'reachable') return SHORT_REACH[reachableFailure(detail)]
  if (unrunnable(check)) return 'installed, but this account cannot run it'
  if (check.check === 'heartbeat') {
    const older = olderAgent(check)
    if (!older) return 'no reports arrive'
    return older.agent ? `v${older.agent} installed, older than yantrad` : 'installed, older than yantrad'
  }
  return SHORT_ABSENT[check.check] ?? 'could not be asked'
}

/** An id this table does not know is not one a session needs. */
export const sessionNeeds = (check: string): boolean => CHECKS[check]?.session ?? false

/** ADR-0028 §1: what `yantra install` can put on a machine — narrower than
 *  every check a session needs (`lib/ready`'s `READY`). The one place this
 *  is derived; `lib/ready`'s `missingBasics` and the setup checklist both
 *  read it from here (Y-402 review). */
export const INSTALLABLE: readonly string[] = CHECK_IDS.filter((id) => fixOf({ check: id }, '')?.by === 'install')

/** `reachable`'s failure reads five ways: the appliance's key was refused,
 *  which the join command fixes by placing a fresh one, or ssh fails for
 *  another reason (a firewall, a machine that is off), which no command here
 *  can fix. The machine page and the machines list both classify it this
 *  same way, so they cannot disagree (Y-402 review). `unjoined` is a machine
 *  the appliance's ssh config names no account for (doctor.rs
 *  `name_the_account`, Y-412), which the join command also fixes. `browser`
 *  is a Tailscale SSH `check` rule (ssh.rs `BROWSER_CHECK`, Y-585): the join
 *  command offers normal ssh in its place. `changed` is a host key the
 *  appliance did not record (doctor.rs `diagnose`, Y-621): only a person can
 *  tell a reinstall from an attack, so `yantra forget-host-key` waits for one. */
export type ReachableFailure = 'refused' | 'unjoined' | 'browser' | 'changed' | 'unreachable'

/** The daemon's `known_hosts` belongs to the account yantrad runs as, so the
 *  verb runs as that account, as docs/appliance.md runs the others. */
export const forgetHostKey = (machine: string) => `sudo -u yantra -H yantra forget-host-key ${machine}`

export function reachableFailure(detail: string): ReachableFailure {
  if (/names no account/i.test(detail)) return 'unjoined'
  if (/requires an additional check/i.test(detail)) return 'browser'
  if (/host key verification failed|remote host identification has changed/i.test(detail)) return 'changed'
  return /permission denied/i.test(detail) ? 'refused' : 'unreachable'
}

/** Tailscale's sign-in link dies with the ssh that asked for it, and a daemon
 *  before v0.10.1 still sends it, so no page shows a line that holds one. */
export const withoutSignIn = (said: string): string =>
  said
    .split('\n')
    .filter((line) => !/https:\/\/login\.tailscale\.com\//i.test(line))
    .join('\n')

/** The daemon writes markdown; a row of the page shows plain words. */
export const withoutMarkdown = (said: string): string => said.replace(/`/g, '')

/** `ssh::Error::Transport` after yantrad's `because` (sessions.rs pins it). */
const TRANSPORT = /^ssh to \S+ failed before the command reported a status/

/** `sessions.rs` and `status.rs` send every error as `reached: 'no'`. Only a
 *  `Transport` one is ssh's; a tmux or local error is `listing` (Y-585). */
export type AnswerFailure = ReachableFailure | 'listing'

export const answerFailure = (error: string): AnswerFailure =>
  TRANSPORT.test(error) ? reachableFailure(error) : 'listing'

export const joinFixes = (kind: AnswerFailure) => kind !== 'unreachable' && kind !== 'changed' && kind !== 'listing'

/** The plain cause and the next step, which no title repeats. */
export function reachWords(kind: AnswerFailure, name: string): { cause: string; next: string } {
  switch (kind) {
    case 'refused':
      return {
        cause: `${name} did not take the appliance’s key.`,
        next: `Run the join command on ${name}; it places the key.`,
      }
    case 'unjoined':
      return {
        cause: `The appliance does not know which account to log in to ${name} as.`,
        next: `Run the join command on ${name}; it names the account and places the key.`,
      }
    case 'browser':
      return {
        cause: `Tailscale SSH on ${name} waits for a browser sign-in, and the appliance has no browser.`,
        next: `Run the join command on ${name}; it turns on normal ssh with the appliance’s key. Or change the tailnet’s SSH rule from check to accept.`,
      }
    case 'changed':
      return {
        cause: `${name} answered with a different host key than the one the appliance recorded. Turning Tailscale SSH off changes it, and so does a reinstall.`,
        next: `If you know why it changed, run ${forgetHostKey(name)} on the appliance, then Check again. If you do not, find out first.`,
      }
    case 'unreachable':
      return {
        cause: `Yantra can’t reach ${name} over ssh. A firewall or a machine that is off can do this.`,
        next: 'The join command does not fix this. What ssh said names the reason.',
      }
    case 'listing':
      return {
        cause: `Yantra could not list the sessions on ${name}.`,
        next: 'This is not an ssh failure, so the join command does not fix it. The full error names the reason.',
      }
  }
}

export const tookOf = (ms: number): string => (ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`)
