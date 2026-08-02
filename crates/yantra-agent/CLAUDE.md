# yantra-agent — working notes

**The loop and the transport are implemented (Y-107). The probes are not (Y-106)** — `measure()` in
[`src/main.rs`](src/main.rs) reports a machine that fails every hard filter until they land.

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

## What it may call, and what it may not

`yantra_core::heartbeat` is the **whole** of the library this binary reaches. The dependency edge is
nearly free — 11 KB, measured — and the call graph is not: one further call, into ssh or tmux, costs
**+319 KB (65 %)**, because `lto = "thin"` only strips what nothing reaches. **Guard the next `use`,
not the `Cargo.toml` line** ([`yantra-core/CLAUDE.md`](../yantra-core/CLAUDE.md) says the same from
the other side).

**No HTTP crate and no async runtime**, and the numbers rather than the taste: `ureq` +57 %,
`hyper` + `tokio` +87 %, `tokio` alone +28 % for one timer, and `reqwest` **cannot cross-build to
musl at all** — default features resolve `native-tls` → `openssl-sys` and the build script exits 101,
which would take Y-037's five-target release pipeline down while looking like a CI problem
([the M5 plan §2](../../docs/plans/m5-the-heartbeat-agent.md)). §B2's *orchestrate, don't reinvent*
is about SSH clients and terminal multiplexers; this is a fixed-shape POST to a known port with no
redirects, no keep-alive, no chunked encoding and no TLS. **If it ever needs one of those, this
decision is wrong and the answer is `ureq`** — so if the request starts growing content negotiation,
stop.

## What the loop must keep doing (ADR-0013 §7)

- **10 s, never changing.** No backoff: 10 s is slow enough that backoff is ceremony, and three of
  them is the daemon's staleness threshold.
- **A failed POST drops that beat.** No queue, no buffer, no replay — a heartbeat delivered 40 s late
  is a false statement with a timestamp attached.
- **It never exits on a failed POST.** A restarted daemon must not require reinstalling five agents.
- **The first failure is logged and the rest are not**, until a beat lands again. `Log` is the only
  state in the process and the obvious implementation logs 8,640 times a day.
- **The response is read for its status and never acted on.** A reply the agent obeys is a control
  channel, and a control channel is how this crate stops being a reporter (R-12).

## Its whole configuration

`YANTRA_DAEMON=100.x.x.x:7717`, from the service unit — no flags, no config file, no state
(ADR-0013 §4). **It is an address and the agent resolves no names**: a MagicDNS short name resolves
to `127.0.1.1` and the daemon does not listen there (I-50), so a name works for four of five agents
and fails on the machine the developer is sitting at. A value that is not an address is refused at
startup with that reason; a value that is an address but wrong fails per beat, once, and the agent
keeps running.

The local agent is **not** a special case: a host dialling its own tailnet address reaches the
listener and is attributed by that same address (the M5 plan §5), so there is no "is this me" branch
here or in the daemon.

## Tests

Unit tests inline in `#[cfg(test)]`, and the transport is tested **against a real `TcpListener`** —
the exact request bytes asserted, `204` answered, and the failure paths (refused, accepted then
closed, a status that is not 204, log-once-then-quiet) driven for real. A mocked socket would only
test the mock (root §B3).
