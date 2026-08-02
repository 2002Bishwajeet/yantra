# ADR-0004 — Rust for the daemon, CLI and agent; TypeScript for the web UI

- **Date:** 2026-07-28
- **Status:** accepted

## Context

Yantra is a long-lived daemon that will eventually run unattended on a Raspberry Pi appliance, a CLI
the owner types dozens of times a day, and a per-machine agent shipped to Linux, macOS and Windows.
The language question had to be settled before M0, because it decides the build, the test story, the
distribution format and what the appliance costs at idle.

The stated priority is **quality over speed**: *"I don't have to ship fast. I need to ship quality and
ship better products."* That rules out choosing a runtime for how quickly it lets an unsettled design
churn, and rules in choosing one for what it is like to own in year three.

**Research had already removed most of the reasons to reach for something lighter.** Round R1–R7
established that the daemon's real workload is narrower than it first looked:

- **I-20:** the execution transport is the **system `ssh` binary** with `ControlMaster` — not a library
  to write and maintain.
- **The hardware layer needs no separate language.** Pi 5 device-tree overlays
  (`dtoverlay=rotary-encoder`, `dtoverlay=ws2812-pio`) hand the encoder and the LED strip to userspace
  as an evdev node and a char device. The kernel and RP1's PIO already provide the real-time layer.
- **PTY and SSH are both solvable without native extension modules**, in any language.

So the daemon spawns processes, parses their output, serves HTTP and WebSocket, and writes SQLite.
None of that needs the parts of Rust that are hard to learn.

One argument had to be answered directly: *one language across the stack*. It does not survive
contact with the plan — **the web UI is TypeScript regardless**, so the real comparison was always
Rust + TypeScript against something-else + TypeScript, never two languages against one.

## Decision

**The Yantra daemon, CLI, and per-machine agent are written in Rust. The web UI is TypeScript.**

Stack:

| Concern | Choice |
| --- | --- |
| Async runtime | `tokio` |
| HTTP + WebSocket | `axum` |
| Process orchestration | `tokio::process` — spawning `ssh`, `tmux`, `tailscale` |
| Datastore | `rusqlite` (bundled SQLite feature) |
| PTY | `portable-pty` (the WezTerm crate) |
| Serialization | `serde` / `serde_json` |
| Config | `serde` + YAML (later settled as TOML by [ADR-0007](0007-workspace-schema-v1.md)) |
| Appliance target | `aarch64-unknown-linux-musl` via `cargo-zigbuild` or `cross` |

**SSH, tmux, telemetry and hardware each stay behind a narrow trait.** Those are the four seams where
the system meets an unreliable outside world, and they are the seams that must be fakeable in tests —
see §B2 and §B3 of [`CLAUDE.md`](../../CLAUDE.md).

**The appliance still reports RSS, idle CPU and CLI cold-start** as part of M7's definition of done.
They are quality targets, not gates on the language choice.

## Consequences

**Gained:**

- A ~5 MB static musl binary and ~15 MB idle RSS, for a device meant to run continuously for years.
- `rusqlite` has a real `busy_timeout` and, with `spawn_blocking`, no event-loop starvation — see
  I-12 and I-13 in [`crates/yantrad/tracker.md`](../../crates/yantrad/tracker.md).
- One toolchain for all three binaries, and a release matrix that produces every artefact from CI.

**Paid:**

- **Velocity in M0–M1 will be worse**, and Rust punishes design churn — which is exactly what the
  walking-skeleton milestone is. This is the cost that was knowingly accepted.
- **Cross-compiling to macOS from Linux is genuinely hard in Rust** (it needs the Apple SDK via
  osxcross). This matters for the per-machine agent, which must run on macOS and Windows. Mitigation:
  build on native runners in CI rather than cross-compiling. Logged as R-19, and retired by Y-037 when
  the release matrix went green — the workflow sidesteps the problem rather than solving it.

**Explicitly not a reason for this decision:** performance. Yantra orchestrates five machines and
serves one user. Throughput was never the constraint, and no benchmark motivated this.

> **The daemon writes no SQLite, recorded 2026-08-02 (Y-044).** The session state store was dropped
> without being built: five candidate consumers were audited and none needed one, because what the
> store would have held is already held by the workspace TOML, by tmux's `pane_start_command`, and by
> the agent's own transcript. `rusqlite` is in no `Cargo.toml` and no `Cargo.lock`. So three lines
> above describe a part that was never built — *"and writes SQLite"* in the Context, the `Datastore`
> row of the stack table, and the `busy_timeout` bullet under **Gained**. The Y-044 row in
> [`tracker.md`](../../tracker.md) carries the audit and names what would bring a store back. I-12,
> I-13 and I-14 stay parked in [`crates/yantrad/tracker.md`](../../crates/yantrad/tracker.md),
> unexercised rather than withdrawn.
>
> **That bullet's argument was true when it was made, and it is not what changed.** `rusqlite`'s
> `busy_timeout` and `spawn_blocking` were a real advantage over the bindings R6 measured, and
> nothing since has contradicted it. What changed sits upstream of it: the daemon turned out to need
> no datastore at all, so a comparison between datastore bindings no longer decides anything here.
> The decision stands on the rest of the record — the static musl binary, one toolchain for three
> binaries, `tokio::process` around `ssh`, `tmux` and `tailscale`, and `axum` for HTTP and WebSocket.
