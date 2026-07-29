# ADR-0005 — Orchestration logic lives in a library crate

- **Date:** 2026-07-29
- **Status:** accepted

## Context

M1 delivers a walking skeleton: `yantra up demo` opens a real tmux session, in a real repo, on a
machine reached over SSH, idempotently. M1 has **no daemon** — `yantrad` is M2 work.

That creates a conflict with an existing principle. The architecture says no client talks directly to
a machine; everything goes through the control plane. But in M1 there is no control plane to go
through, so something has to do the orchestrating. Two options were considered.

**(a) The CLI orchestrates directly.** `crates/yantra` grows `ssh.rs`, `tmux.rs`, `workspace.rs` and
an `up` command. Fastest route to a working demo.

**(b) A `yantra-core` library crate.** The orchestration lives there. The CLI calls it in-process in
M1; `yantrad` calls the same functions from an axum handler in M2.

The argument for (b) is not primarily about M2 — it is about what a binary crate lets you write. In
(a) nothing prevents this, deep inside `tmux.rs`:

```rust
eprintln!("no such session");
std::process::exit(1);
```

That is the natural thing to write in a CLI, and it is correct there. It is fatal in a daemon, which
must survive one bad workspace file. A library crate cannot sensibly print or exit, so it forces a
typed error on day one rather than as an M2 cleanup.

Two smaller consequences pointed the same way:

- **Testability.** M1's definition of done is that `up` run twice attaches rather than duplicating.
  Against a library that is `assert!(matches!(outcome, UpOutcome::Attached))`. Against a binary it is
  string-matching the CLI's stdout, which tests the output format as much as the behaviour.
- **Lints.** `missing_debug_implementations` is configured at the workspace root but only fires on
  publicly-exported types, so it has been dormant while every crate is a binary. A lib crate
  activates it.

Against (b): it costs an extra crate now, and a `pub` surface is an invitation to generalise ahead of
need — which §A2 of `CLAUDE.md` forbids and which this project has explicitly resisted elsewhere.

It is also worth being precise about what (b) does **not** buy. It does not protect against the design
being wrong. If M1 shows the tmux model is mistaken, a library's internals are rewritten exactly as
thoroughly as a binary's. The boundary saves the mechanical extraction in M2 and the error-handling
discipline above — nothing more.

## Decision

**Orchestration logic lives in `crates/yantra-core`, a library crate. The binaries are thin.**

- `yantra-core` — workspace loading, SSH transport, tmux sessions, the `up` operation.
- `yantra` (CLI) — argument parsing, calling core, rendering results. Calls core in-process during
  M1; becomes an HTTP client of `yantrad` in M2.
- `yantrad` (daemon) — M2. Wraps the same core functions in HTTP handlers.
- `yantra-agent` — unchanged, per-machine heartbeat.

Two rules bind the library, and they are restated in `lib.rs` where they will actually be read:

1. **Never print, never exit.** No `println!`, no `eprintln!`, no `std::process::exit`. Fallible
   operations return `Result` with a typed error; the caller decides how to surface it.
2. **Keep the public surface small.** Export the operation and its error type. Everything else stays
   private until something outside genuinely needs it. This is the mitigation for the
   generalise-too-early risk — the crate boundary is a *location*, not an abstraction, and it must not
   be allowed to become one.

## Consequences

**Gained**

- The M2 daemon change is *where* code is called from, not *what* it does. No extraction under
  pressure, no untangling of CLI assumptions from orchestration.
- A typed error enum exists from the first fallible operation rather than being retrofitted.
- `up`'s idempotency is asserted against a return value instead of against stdout.
- `missing_debug_implementations` starts doing work.

**Paid**

- One more crate to build and keep coherent.
- A standing temptation to widen the public API. Rule 2 above is the guard; reviewers should push back
  on any new `pub` item that has exactly one caller inside the crate.
- Slightly more ceremony in M1 — the CLI must convert core's errors into human output rather than
  printing at the point of failure.

**Not affected**

- The narrow-traits rule (§B2 of `CLAUDE.md`) is unchanged. SSH, tmux, telemetry and hardware still
  sit behind fakeable interfaces; they now sit behind them *inside* `yantra-core`.
- Integration tests still run against a real sshd and a real tmux in a disposable podman container
  (§B3). A library boundary makes the layers above fakeable; it does not make the transport's own
  tests fake.
