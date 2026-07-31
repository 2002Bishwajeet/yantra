# yantra-agent — working notes

**Nothing is implemented. This is the M0 skeleton.**

Scoped to this crate; the root [`CLAUDE.md`](../../CLAUDE.md) still binds.

## Why it has to exist

Two findings, both verified rather than assumed:

- **Tailscale exposes no telemetry at all** — no CPU, RAM, GPU, battery or load. Checked against
  `ipnstate.PeerStatus`, the full API v2 OpenAPI spec, *and* `tailscale metrics` (R1). So the data
  has to come from somewhere, and that somewhere is a process on each machine.
- **SSH polling cannot see a sleeping laptop** (R5), and a scheduler whose main question is *"is this
  machine usable right now"* cannot be blind to sleep. That is what killed the poll-instead-of-agent
  preference.

Push a heartbeat every 10s; the daemon marks a machine stale at 30s.

## The rule that keeps it small

**It reports. It does not decide.** No placement, no remote execution, no configuration management,
no "while I'm here I could also…". Every one of those is how a workspace orchestrator turns into a
fleet-management product (R-12), and this crate is where that drift would start, because it is the
only thing Yantra installs *on* a machine rather than talking *to*.

If a feature would make this agent need privileges, stop and put it in the daemon instead.

## Before writing anything here

The telemetry ADR (**Y-020**) is unwritten — the interval, the transport and the payload are all
still open. Read [`tracker.md`](../../tracker.md) first.
