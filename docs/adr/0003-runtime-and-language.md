# ADR-0003 — TypeScript on Bun, with a pre-agreed Rust escape hatch

- **Date:** 2026-07-28
- **Status:** **superseded by [ADR-0004](0004-rust-for-the-daemon.md)**

## Context

Yantra needs one language for a long-running daemon, a CLI, and a web UI, eventually running 24/7 on
a Raspberry Pi 5 or Intel N100 appliance and driving hardware (OLED, rotary encoder, RGB LEDs, E-Ink).

Options weighed: Go (single static binary, `tsnet`, mature SSH), Python + FastAPI (fastest to
prototype, heavy runtime), TypeScript (one language across daemon/UI/CLI), Rust (best for the
hardware layer, slowest to iterate while the design is still moving).

Two facts dominate:

1. The design is not settled. Iteration speed matters more than peak efficiency in M0–M4.
2. The appliance target is genuinely constrained, and the hardware layer has hard real-time
   requirements that no garbage-collected language can meet (WS2812 LED timing, encoder interrupts).

**TypeScript means Bun**, explicitly — not Node. Bun is the runtime, test runner, package manager,
bundler, and `bun:sqlite` is the datastore. Node is the fallback only if Bun proves unusable on arm64.

## Decision

**Write Yantra in TypeScript on Bun.** Bun is the sole runtime: `bun` for execution, `bun test` for
tests, `bun:sqlite` for persistence, `bun build --compile` for distribution.

**Rust is a pre-approved escape hatch, not a debate.** The following are agreed *in advance* as
triggers. If any fires, the affected component moves to Rust (or C) without re-opening the question:

| # | Trigger | Component that moves |
| --- | --- | --- |
| T1 | Bun does not run reliably on Pi 5 arm64 (crashes, page-size faults, unsupported build) | Entire daemon |
| T2 | Idle daemon RSS on the appliance exceeds **250 MB**, or idle CPU exceeds 2% | Entire daemon |
| T3 | Cold start of the CLI exceeds **300 ms** on the appliance | CLI only (thin Rust client over the HTTP API) |
| T4 | Any GPIO/display/LED path needs sub-millisecond or interrupt-driven timing | Hardware layer, as a separate process |
| T5 | `node-pty` or the chosen SSH library does not work under Bun | Transport layer, as a helper binary |

The hardware layer is expected to move regardless of triggers: **assume from day one that GPIO, the
rotary encoder, the display, and the LEDs are a separate process** speaking to the daemon over a local
socket. Whether that process is Rust on the Pi or firmware on an RP2040/ESP32 over USB-serial is
deferred to research note R6.

Consequently: **no Bun-specific API leaks into domain logic.** SSH, tmux, telemetry, and hardware are
each behind a narrow interface so that swapping the implementation for a subprocess or FFI call is a
one-file change.

## Consequences

- Fast iteration in M0–M4, one language across daemon + CLI + UI, and a single-file distribution via
  `bun build --compile`.
- We accept that Bun's native-module and arm64 story is less proven than Node's or Go's. Research note
  R6 exists specifically to measure this before M1 code is written; its verdict may fire T1 immediately.
- The interface discipline above costs a little indirection now and buys the ability to honour the
  escape hatch cheaply later. Without it, "switch to Rust, no questions asked" would be a rewrite.
- Measurement is not optional: T2 and T3 are numbers, so the appliance build must report RSS, idle CPU,
  and CLI cold-start as part of the M7 definition of done.
