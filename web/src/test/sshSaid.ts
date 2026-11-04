/** What a daemon before v0.10.1 sends for a Tailscale SSH `check` rule: the
 *  two lines forum.tailscale.com/t/4539 and flaviocopes.com quote (both read
 *  2026-11-04), after the prefix `diagnose` gave a server that answered. */
export const CHECK_RULE =
  'ssh got no answer: # Tailscale SSH requires an additional check.\n' +
  '# To authenticate, visit: https://login.tailscale.com/a/1a2b3c4d5e6f'

/** doctor.rs `diagnose` on OpenSSH's own words for a changed host key, as
 *  `ssh -E` logged them on 2026-11-04 (Y-621). */
export const CHANGED_KEY =
  'the machine answered with a host key the appliance did not record for it: ' +
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n' +
  '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n' +
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n' +
  'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\n' +
  'Offending ED25519 key in /run/user/1000/yantra/known_hosts:1\n' +
  'Host key for pi has changed and you have requested strict checking.\n' +
  'Host key verification failed.'
