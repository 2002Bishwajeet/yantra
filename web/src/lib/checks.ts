/** D7 §3.5: one name per check on every screen, and what fixes it. `doctor`
 *  keeps the ids; a person reads the names. */

/** Who fixes a check that is missing. */
export type Fix =
  | { by: 'join' }
  | { by: 'install' }
  | { by: 'command'; command: string; where: 'appliance' | 'machine' }
  | { by: 'hand'; words: string }

const CHECKS: Record<string, { name: string; fix: (machine: string) => Fix }> = {
  reachable: { name: 'ssh', fix: () => ({ by: 'join' }) },
  sshd: { name: 'sshd', fix: () => ({ by: 'join' }) },
  tmux: { name: 'tmux', fix: () => ({ by: 'install' }) },
  git: { name: 'git', fix: () => ({ by: 'install' }) },
  'agent-cli': { name: 'claude', fix: () => ({ by: 'install' }) },
  terminfo: {
    name: 'terminfo',
    fix: (machine) => ({ by: 'command', command: `yantra fix-terminfo ${machine}`, where: 'appliance' }),
  },
  'provider-cli': { name: 'gh', fix: () => ({ by: 'hand', words: 'Install gh with that machine’s package manager.' }) },
  'provider-auth': { name: 'gh signed in', fix: () => ({ by: 'command', command: 'gh auth login', where: 'machine' }) },
  // doctor.rs `login_session`: whether claude finds a credential where the agent runs.
  'login-session': { name: 'claude signed in', fix: () => ({ by: 'hand', words: 'Run claude on that machine and log in.' }) },
  heartbeat: {
    name: 'heartbeat',
    fix: () => ({ by: 'hand', words: 'The join command offers yantra-agent, which sends it.' }),
  },
}

export const nameOf = (check: string): string => CHECKS[check]?.name ?? check

export const fixOf = (check: string, machine: string): Fix | null => CHECKS[check]?.fix(machine) ?? null
