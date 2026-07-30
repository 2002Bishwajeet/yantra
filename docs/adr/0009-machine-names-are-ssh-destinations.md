# ADR-0009 — A workspace's `machine` is an ssh destination, not a Yantra identifier

- **Date:** 2026-07-30
- **Status:** accepted
- **Confirms:** [ADR-0006](0006-ssh-exec-transport.md) — the reason it chose the system `ssh` binary
  extends to name resolution, which ADR-0006 did not state explicitly.

## Context

`Workspace.machine` is the only field that names a target, and the code has been carrying two
incompatible readings of it.

`up.rs:51` passes it to `ssh` verbatim and defends that in a comment:

> `machine` is used as an ssh destination verbatim, so `~/.ssh/config` decides what it means — the
> fidelity I-20 chose the system binary for. Yantra does not maintain a second copy of that mapping.

`workspace.rs:19` documents the same field as *"An alias; Y-041 resolves it to a host"*. Y-041 turned
out to be the SSH exec primitive, which deliberately resolves nothing — so that sentence was a
forward reference to work that was never scoped, and it was stale before it was written.

Nothing depended on the disagreement while there was one machine and one workspace. **M2 makes it
load-bearing.** Y-050 adds a Tailscale inventory reader, and an inventory that can produce a hostname
is exactly the component that would quietly start rewriting `Machine.host`. If that is going to
happen it should be a decision; if it is not, the inventory needs a stated boundary before it is
written, not after.

The two coherent answers, from [the M2 plan](../plans/m2-real-machines.md) §7.1:

**(a) `ssh` resolves; the inventory only observes.** `machine` keeps reaching `ssh` untouched.
Tailscale data is used to list machines and to say something useful when a name looks wrong.

**(b) Yantra resolves.** The inventory maps a name to a `DNSName` and fills `Machine`, which opens
the door to per-machine `user`, `port` and `identity`.

Three things decide it:

- **`~/.ssh/config` already solves this, correctly, for cases Yantra cannot see.** Jump hosts,
  per-host identities, `Match` blocks, non-tailnet machines, an address pinned by hand because
  MagicDNS is unreliable on this box — all of that is expressible there and none of it is expressible
  in a `DNSName` lookup. Option (b) does not replace that file; it adds a second mapping that
  disagrees with it, and the failure mode is a connection that goes somewhere the user did not
  configure.
- **MagicDNS is not dependable here.** `tailscale status` on `cachyos-g14` warns that
  systemd-resolved and NetworkManager are wired together incorrectly and that MagicDNS "will probably
  not work" — it happens to work anyway. Making resolution Yantra's job would make Yantra own that
  fragility. Leaving it to `ssh` means the escape hatch (`~/.ssh/config`) is one file edit away.
- **Nothing in M2 needs (b).** Per-machine `user`/`port`/`identity` is the only capability it buys,
  and no workspace has asked for one.

## Decision

**`Workspace.machine` is passed to `ssh` verbatim. `~/.ssh/config` is the single authority on what a
name means.**

The Tailscale inventory (Y-050) is **advisory**. It may:

- power `yantra ls machines`,
- report reachability, OS and last-seen for display,
- suggest a correction when a workspace names something no machine resembles.

It may **not**:

- rewrite `Machine.host`,
- populate `user`, `port` or `identity`,
- **reject a name for being absent from the tailnet.** An unknown name is a *warning*, never an
  error. `mac-via-jump` may be a perfectly good `~/.ssh/config` alias, and a machine that is merely
  offline must still produce an ssh error rather than a Yantra one.

That last point is the one this ADR exists to pin down. A validator that hard-fails on an unknown
name reimplements option (b) with worse ergonomics — it makes the inventory authoritative over which
names are legal, having just declined to make it authoritative over what they mean.

## Consequences

**Gained**

- One mapping, in the file that already owns it, with a documented escape hatch when MagicDNS fails.
- I-20's fidelity argument stays whole: Yantra uses the system `ssh` *and* the system `ssh`'s
  configuration, rather than the binary alone.
- `Machine.user`/`port`/`identity` stay `None` at every call site, so the struct's optional fields
  remain genuinely unused rather than half-used.
- Y-050's trait can be read-only, which makes it smaller and its fake simpler.

**Lost**

- **No per-machine `user`, `port` or `identity` from Yantra.** A workspace that needs a non-default
  user must get it from `~/.ssh/config`. This is the real cost, and it is the thing to watch: if
  three workspaces end up needing `~/.ssh/config` entries that exist only to serve Yantra, that is
  the signal to revisit with a superseding ADR (§B0.2), not a reason to special-case one of them now.
- A workspace can name a machine that does not exist and fail at connect time rather than load time.
  The suggestion in the error message is the mitigation; blocking is not.

**Not resolved**

- Whether an *offline* machine should be refused before `ssh` spends its connect timeout on it. That
  is a reachability question, not a naming one; it is deferrable to M5, where placement has to reason
  about availability anyway.
