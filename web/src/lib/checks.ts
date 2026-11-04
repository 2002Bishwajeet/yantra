/** D7 §3.5: one name per check on every screen, and what fixes it. `doctor`
 *  keeps the ids; a person reads the names. */

/** Apple's words for the one switch that lets an ssh login read the folders
 *  macOS guards (support.apple.com/guide/mac-help/mchlp1066, 2026-11-03), and its cost. */
export const fullDisk = (machine: string) =>
  `To allow it, open System Settings > General > Sharing > Remote Login, and turn on Allow full disk access for remote users. Every ssh login to ${machine}, agents included, then gets that access.`

/** Who fixes a check that is missing. */
export type Fix =
  | { by: 'join' }
  | { by: 'install' }
  | { by: 'command'; command: string; where: 'appliance' | 'machine' }
  | { by: 'hand'; words: string }

/** `session`: a session cannot start on the machine without it, which is what
 *  `lib/ready` asks. GitHub and `yantra-agent` are optional (Y-390 review). */
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
    name: 'gh',
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
  heartbeat: {
    name: 'heartbeat',
    fix: () => ({ by: 'hand', words: 'The join command offers yantra-agent, which sends it.' }),
    session: false,
  },
}

/** `doctor`'s twelve ids, in its order. */
export const CHECK_IDS: readonly string[] = Object.keys(CHECKS)

export const nameOf = (check: string): string => CHECKS[check]?.name ?? check

export const fixOf = (check: string, machine: string): Fix | null => CHECKS[check]?.fix(machine) ?? null

/** An id this table does not know is not one a session needs. */
export const sessionNeeds = (check: string): boolean => CHECKS[check]?.session ?? false

/** ADR-0028 §1: what `yantra install` can put on a machine — narrower than
 *  every check a session needs (`lib/ready`'s `READY`). The one place this
 *  is derived; `lib/ready`'s `missingBasics` and the setup checklist both
 *  read it from here (Y-402 review). */
export const INSTALLABLE: readonly string[] = CHECK_IDS.filter((id) => fixOf(id, '')?.by === 'install')

/** `reachable`'s failure reads four ways: the appliance's key was refused,
 *  which the join command fixes by placing a fresh one, or ssh fails for
 *  another reason (a changed host key, a firewall), which no command here
 *  can fix. The machine page and the machines list both classify it this
 *  same way, so they cannot disagree (Y-402 review). `unjoined` is a machine
 *  the appliance's ssh config names no account for (doctor.rs
 *  `name_the_account`, Y-412), which the join command also fixes. `browser`
 *  is a Tailscale SSH `check` rule (ssh.rs `BROWSER_CHECK`, Y-585): the join
 *  command offers normal ssh in its place. */
export type ReachableFailure = 'refused' | 'unjoined' | 'browser' | 'unreachable'

export function reachableFailure(detail: string): ReachableFailure {
  if (/names no account/i.test(detail)) return 'unjoined'
  if (/requires an additional check/i.test(detail)) return 'browser'
  return /permission denied/i.test(detail) ? 'refused' : 'unreachable'
}

/** `ssh::Error::Transport` after yantrad's `because` (sessions.rs pins it). */
const TRANSPORT = /^ssh to \S+ failed before the command reported a status/

/** `sessions.rs` and `status.rs` send every error as `reached: 'no'`. Only a
 *  `Transport` one is ssh's; a tmux or local error is `listing` (Y-585). */
export type AnswerFailure = ReachableFailure | 'listing'

export const answerFailure = (error: string): AnswerFailure =>
  TRANSPORT.test(error) ? reachableFailure(error) : 'listing'

export const joinFixes = (kind: AnswerFailure) => kind !== 'unreachable' && kind !== 'listing'

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
        cause: `Yantra can’t reach ${name} because Tailscale asks for a browser sign-in on each connection.`,
        next: `Run the join command on ${name}; it offers normal ssh with the appliance’s key. Or change the tailnet’s SSH rule from check to accept.`,
      }
    case 'unreachable':
      return {
        cause: `Yantra can’t reach ${name} over ssh. A firewall, a changed host key or a machine that is off can do this.`,
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
