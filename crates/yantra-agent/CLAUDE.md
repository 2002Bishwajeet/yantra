# yantra-agent — working notes

**The agent is complete apart from its install story** (R-12, M7): [`src/probes.rs`](src/probes.rs)
measures the seven fields and [`src/main.rs`](src/main.rs) is the loop and the POST.

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

`yantra_core::heartbeat`'s type and `yantra_core::agent::CANDIDATES` are the **whole** of the library
this binary reaches, and neither links any code. The dependency edge is
nearly free — 11 KB, measured — and the call graph is not: one further call, into ssh or tmux, costs
**+319 KB (65 %)**, because `lto = "thin"` only strips what nothing reaches. **Guard the next `use`,
not the `Cargo.toml` line** ([`yantra-core/CLAUDE.md`](../yantra-core/CLAUDE.md) says the same from
the other side).

**No HTTP crate and no async runtime**, and the numbers rather than the taste: `ureq` +57 %,
`hyper` + `tokio` +87 %, `tokio` alone +28 % for one timer, and `reqwest` **cannot cross-build to
musl at all** — default features resolve `native-tls` → `openssl-sys` and the build script exits 101,
which would take Y-037's five-target release pipeline down while looking like a CI problem
([the heartbeat-agent plan §2](../../docs/plans/the-heartbeat-agent.md)). §B2's *orchestrate, don't reinvent*
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

`YANTRA_DAEMON=100.x.x.x:7717`, which [`yantra-agent.service`](yantra-agent.service) reads from
`/etc/yantra/agent.env` — no flags, no config file, no state (ADR-0013 §4). It is outside the unit so
that installing a newer unit cannot overwrite the address, and the unit does not prefix the
`EnvironmentFile=` with `-`, so a machine nobody wrote that file on refuses and says which file. **It is an address and the agent resolves no names**: a MagicDNS short name resolves
to `127.0.1.1` and the daemon does not listen there (I-50), so a name works for four of five agents
and fails on the machine the developer is sitting at. A value that is not an address is refused at
startup with that reason; a value that is an address but wrong fails per beat, once, and the agent
keeps running.

The local agent is **not** a special case: a host dialling its own tailnet address reaches the
listener and is attributed by that same address (the heartbeat-agent plan §5), so there is no "is this me" branch
here or in the daemon.

## Tests

Unit tests inline in `#[cfg(test)]`, and the transport is tested **against a real `TcpListener`** —
the exact request bytes asserted, `204` answered, and the failure paths (refused, accepted then
closed, a status that is not 204, log-once-then-quiet) driven for real. A mocked socket would only
test the mock (root §B3).

The probes' parsers are exercised against output recorded from both fleet machines, which is not a
substitute for §B3 but the only way to reach the states this fleet has not produced: a desktop with
no battery, and an unplugged Linux machine. **A fixture is not evidence about a platform** — run the
binary on both machines ([the heartbeat-agent plan §9](../../docs/plans/the-heartbeat-agent.md), I-32).

`PMSET_BATTERY` was hand-written until Y-110 unplugged the Mac, and the guess was wrong twice: the
real line reads **100 % while discharging** — the same percentage the AC fixture carries — and macOS
prints `(no estimate)` for the first minutes off mains before it prints a time. Both real forms are
fixtures now.

## What binds the probes

[ADR-0013](../../docs/adr/0013-the-heartbeat-carries-only-what-placement-scores.md) settles the
payload and [the heartbeat-agent plan](../../docs/plans/the-heartbeat-agent.md) §3 measures every probe on both
fleet machines, verbatim. It is the probes' specification; read it before touching `probes.rs`.

Four rules, each earned by a measurement that would otherwise ship as a bug:

- **Fixed facts are measured once, at start.** `nvidia-smi` costs 1.25 s here; a 10 s loop cannot
  afford it, and ADR-0013 §1 says so independently.
- **Every reader fails toward the value that loses a placement.** A failed load-average read reports
  100, never 0 — `cpu_busy_pct: 0` is a *perfect* CPU-idle score, so a broken reader would win.
- **`Power::Battery` has exactly one construction site**, `power_from`. The type cannot enforce
  ADR-0013 §2's two-reading rule and nothing downstream can catch a violation, so a test counts the
  construction sites in this file.
- **Find binaries through `yantra_core::agent::CANDIDATES`, never a second list.** A LaunchAgent's
  `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`, which finds neither Docker nor Homebrew tmux; I-34
  already recorded that measurement for `claude`.

**Do not add a Windows path.** Q4 is open by the owner's choice, and a `compile_error!` says so.
