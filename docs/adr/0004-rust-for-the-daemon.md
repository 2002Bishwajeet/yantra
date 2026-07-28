# ADR-0004 — Rust for the daemon (supersedes ADR-0003)

- **Date:** 2026-07-28
- **Status:** accepted
- **Supersedes:** [ADR-0003](0003-runtime-and-language.md) — TypeScript on Bun

## Context

ADR-0003 chose TypeScript on Bun and justified it primarily on **iteration speed while the design is
unsettled**, with Rust held back as an escape hatch behind five measurable triggers (T1–T5).

Two things changed on the same day.

**1. The decision criteria changed.** The stated priority moved from iteration speed to *"I don't have
to ship fast. I need to ship quality and ship better products."* ADR-0003's central trade — accept a
heavier, less proven runtime in exchange for moving faster through an unknown design — is a trade that
is no longer wanted. The facts did not change; their weighting did.

**2. Research removed most of the reasons Rust was being deferred.** Research round R1–R6 established:

- **I-20:** the execution transport is the **system `ssh` binary** with `ControlMaster`, not a library.
- **I-16:** the design uses **zero native addons**.
- **T4 did not fire:** Pi 5 device-tree overlays (`dtoverlay=rotary-encoder`, `dtoverlay=ws2812-pio`)
  drive the encoder and LEDs from userspace — no separate firmware language was needed after all.
- **T5 was retired:** PTY and SSH both turned out to be solvable without native modules.

Taken together, the daemon's actual workload is: spawn processes, parse their output, serve HTTP and
WebSocket, and write SQLite. None of that requires the parts of Rust that are hard to learn, and none
of it benefits from the parts of TypeScript that are pleasant.

Two further observations weakened the "one language" argument, which was ADR-0003's other pillar:

- **The web UI is TypeScript regardless.** The real comparison was always Rust + TS versus Bun + TS,
  not two languages versus one.
- **Bun stable had shipped nothing in 76 days** (R-16) while a ~1M-line rewrite to Rust lands as
  v1.4.0, with no ship date and no statement on native-addon compatibility.

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
| Config | `serde` + YAML |
| Appliance target | `aarch64-unknown-linux-musl` via `cargo-zigbuild` or `cross` |

**ADR-0003's trigger table (T1–T5) is void.** It existed to decide when to leave Bun; that question is
now settled. The measurement discipline it introduced is kept — the appliance build still reports RSS,
idle CPU, and CLI cold-start as part of M7's definition of done — but as quality targets, not as
escape-hatch triggers.

**The interface discipline from ADR-0003 is kept and strengthened.** SSH, tmux, telemetry, and hardware
each stay behind a narrow trait. The original reason (making a runtime swap cheap) has expired; the
better reason remains: those are the four seams where the system meets an unreliable outside world, and
they are the seams that must be fakeable in tests.

## Consequences

**Gained:**

- Eight Bun-specific risks are deleted outright: R-0 (Pi 5 16 KB page size — a JSC/Bun issue, not an
  arm64 one), R-9, R-11, R-14 (synchronous SQLite blocking the event loop), R-15, R-16, R-17, R-18.
  **The single appliance-blocking unknown in the entire research round disappears with the runtime.**
- A ~5 MB static musl binary and ~15 MB idle RSS, against Bun's ~90 MB binary — for a device meant to
  run continuously for years, on a Pi 5.
- `rusqlite` has a real `busy_timeout` and, with `spawn_blocking`, no event-loop starvation.
- No dependency on a runtime that is mid-rewrite with a stalled release pipeline.

**Paid:**

- **Velocity in M0–M1 will be worse**, and Rust punishes design churn — which is exactly what the
  walking-skeleton milestone is. This is the cost that was knowingly accepted.
- **Cross-compiling to macOS from Linux is genuinely hard in Rust** (it needs the Apple SDK via
  osxcross), where `bun build --compile` did it trivially. This matters for the per-machine agent,
  which must run on macOS and Windows. Mitigation: build on native runners in CI rather than
  cross-compiling. Logged as R-19.
- Nine research notes were written against a Bun target. Their *findings* about tmux, Tailscale, agent
  CLIs, prior art, and scheduling are language-independent and remain valid; their *runtime* sections
  (06, 06a, 06b, 06c) are now historical. They are kept unedited as dated evidence, with a header
  noting the superseding decision.
- Invariants I-15, I-16, I-17 and I-18 were Bun-specific and are retired. I-12, I-13 and I-14 survive
  with revised reasoning.

**Explicitly not a reason for this decision:** performance. Yantra orchestrates five machines and
serves one user. Throughput was never the constraint, and no benchmark motivated this.
