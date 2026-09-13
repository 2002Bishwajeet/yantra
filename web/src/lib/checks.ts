/** D7 §3.5: one name per check on every screen, and what fixes it. `doctor`
 *  keeps the ids; a person reads the names. */

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
  heartbeat: {
    name: 'heartbeat',
    fix: () => ({ by: 'hand', words: 'The join command offers yantra-agent, which sends it.' }),
    session: false,
  },
}

/** `doctor`'s ten ids, in its order. */
export const CHECK_IDS: readonly string[] = Object.keys(CHECKS)

export const nameOf = (check: string): string => CHECKS[check]?.name ?? check

export const fixOf = (check: string, machine: string): Fix | null => CHECKS[check]?.fix(machine) ?? null

/** An id this table does not know is not one a session needs. */
export const sessionNeeds = (check: string): boolean => CHECKS[check]?.session ?? false
