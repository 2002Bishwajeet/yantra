# yantrad — working notes

**It serves, it looks, and it answers — read-only.** Y-069 made it an `axum` server, Y-070 gave it a
background read model, Y-071 put that model on the wire at `/api`. Nothing here writes. The most
useful thing you can do here is still not write code before M4 needs it.

Scoped to this crate; the root [`CLAUDE.md`](../../CLAUDE.md) still binds.

## What it will be — aspiration, not today

The control-plane daemon. Every client — CLI, web UI, hardware panel — talks to this and nothing
else; **no client ever talks directly to a managed machine.** It will own machine inventory,
workspace definitions, session state and placement.

[ADR-0012](../../docs/adr/0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md) dates that
paragraph: it describes M6 onward. **Today the CLI does not go through the daemon**, and the ADR
records what would justify changing that — a client not on the operator's machine, state that must
not be derived twice, or a placement decision the CLI must also see.

## The bind address is the security boundary

Q6 settled that Yantra is personal-first, so there is **no authentication**. That makes where the
daemon listens the entire security model (R-22), and it is why `listen_on` fails closed: every branch
that cannot prove an address belongs to this machine returns an error, because the only default
available is one that listens to the whole world.

**Do not add a `--bind` flag, a `--port` flag, or a config file for either.** A flag that can expose
the API is a flag someone eventually passes. The port is a constant with a test asserting it is one.

The addresses come from `inventory::Inventory::addresses`, which reports `Self` only — a peer's
address would be name resolution, which [ADR-0009](../../docs/adr/0009-machine-names-are-ssh-destinations.md)
declined.

**Test the refusal, not the bind.** A test asserting the daemon binds passes just as well when the
fallback is `0.0.0.0`. That is R-22's stated retire condition and the shape to keep.

## Nothing expensive happens on the request path

`ssh.rs` sets `ConnectTimeout=10`, so one asleep machine costs ten seconds. A browser polls whether
or not anyone is looking, so a handler that calls `sessions::list` per request turns one open tab
into a permanent ssh storm. `refresh.rs` looks on its own schedule; a handler clones the snapshot and
reads memory. **Never `await` ssh inside a handler.**

The interval is a constant for the same reason the port is. `ControlPersist=300` means anything under
five minutes keeps every ssh master warm, so the poll makes the fleet *faster* — and because the
`ControlPath` is per-user, a running daemon speeds the CLI up too.

**Four states, not three**, and folding any two together is the bug this module exists to avoid:
nobody has looked (`None`), a look succeeded, a look succeeded and a machine within it did not answer,
and *the look itself failed*. I-47 is the same mistake one layer down. All four reach `/api` by name
(`looked` and `reached`), because a client that has to infer a state from a missing field will infer
the wrong one.

**A failed look replaces the previous good one, and that is Y-071's decision rather than an
accident.** Every class-level error here is local and persistent — `tailscale` missing, a malformed
workspace file — so retaining a stale reading would hide a fault the operator has to fix, and go on
hiding it. The transient case is a *machine* that did not answer, and that already survives inside a
successful reading.

## What is already decided

- **The CLI does not go through this.** [ADR-0012](../../docs/adr/0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md):
  `yantra` keeps calling `yantra-core` in-process and keeps working when no daemon is running. The
  aspiration below — every client talking to the daemon — describes M6 onward, not today.
- **The logic is not written here.** `yantrad` becomes an HTTP surface over
  [`yantra-core`](../yantra-core/CLAUDE.md), which already holds the orchestration. If a handler is
  about to contain a decision, that decision belongs in the library, where the CLI can reach it too
  ([ADR-0005](../../docs/adr/0005-core-logic-in-a-library-crate.md)).
- **The CLI is the honesty check.** Anything the web UI can do must be expressible in `yantra`
  first. That is what stops the daemon growing a second, richer API that the CLI cannot reach.
- Stack: `axum` and `tokio`, both in use since Y-069. `rusqlite` *only if* state genuinely cannot be
  derived from tmux — prefer deriving (Y-044, which has now receded three times; a read-only
  dashboard is the strongest case yet for deriving).
- **Never store secrets.** Workspaces hold references; the daemon resolves them at launch and never
  writes a value to SQLite, a log, the API, or a terminal stream (root §B4).

## Before writing anything here

M4 is the milestone that needs it. Read [`tracker.md`](../../tracker.md) first — the daemon's shape
depends on decisions that are still open, including the telemetry ADR (Y-020) and whether a session
store is needed at all.
