# ADR-0029 — A machine joins itself

- **Date:** 2026-09-12
- **Status:** Accepted 2026-09-12, by the owner's rulings in the
  [QA walk-through](../plans/m15-qa-walkthrough.md) §2.5 and §3.5. [Y-387](../../tracker.md) builds it.
- **Reads against** [ADR-0009](0009-machine-names-are-ssh-destinations.md) for who owns the ssh
  config, [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md) and
  [ADR-0017](0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md) for who the caller is,
  [ADR-0013](0013-the-heartbeat-carries-only-what-placement-scores.md) §4 for `agent.env`, and
  [ADR-0028](0028-yantra-installs-the-bare-minimum-on-a-machine.md) for what crosses ssh.

## Context

On a first install no machine can go green. `ssh::machine_at` passes no user and no key, and leaves
both to the `yantra` account's `~/.ssh/config` (ADR-0009). `yantra ssh-identity` writes a `Host`
block only for a machine a workspace names, and a first install has no workspace. So ssh offers only
its default key names and logs in as `yantra`, which is an account no laptop has. The walk-through
measured this with `ssh -G` on 2026-09-12 (§2.2).

Yantra cannot know the account on the far side. A person can type it into the dashboard, but a typed
name is one more thing to get wrong, and the person must still go to that machine to place the key.

## Decision

**A person runs one command on the new machine, and the machine joins itself.**

1. **`GET /join` serves a POSIX `sh` script** that holds the daemon's own address, its public key
   and its version. The daemon **makes the key on first use**: generation is Yantra's (D2.10, closed).
   `yantra join-script` prints the same bytes.
2. **The script runs as the person, and asks before each root step.** It turns on `sshd`, adds the
   key to that account's `authorized_keys`, offers `tmux` and `git`, and offers `yantra-agent` with
   its unit and an `agent.env` it writes only when absent. On a Mac it cannot turn on Remote Login
   (`systemsetup` needs Full Disk Access), so it names the System Settings step.
3. **The account is whoever ran the command.** The script sends `POST /api/join` with `{ "user" }`
   and nothing else.
4. **The machine is named from the caller's address, never from the body.** The route is behind
   `allowed()`, and it takes the name from `whois` joined to the tailnet list on the stable id. A
   body with a `machine` field is refused, so a machine can only join itself.
5. **The daemon appends `Host`, `User`, `IdentityFile` and `IdentitiesOnly`** to the `yantra`
   account's config. A config that already names the machine is left as it is, whoever wrote it.
   The join is an event in the notifications ring, and a readiness re-check follows it.

`yantra ssh-identity --machine <m> --user <u>` writes the same block from a terminal.

## Consequences

- **The daemon writes a second file.** ADR-0004's amendment says it writes one. That file is
  configuration, and so is this one: the `yantra` account's `~/.ssh/config`, which ADR-0009 already
  made the authority on every name.
- **A `GET` can make a key.** `GET /join` is authorised like a write for that reason.
- **Nothing crosses ssh.** The person runs the script in their own terminal, so ADR-0028 §6 stands.
- **A machine joined twice under two accounts keeps the first.** The config already names it, so
  the second account is reported and not written. The owner edits the file to change it.
- **The macOS half is not measured.** Remote Login detection and the LaunchAgent for `yantra-agent`
  were written from Apple's documentation, and no Mac has run them yet.
