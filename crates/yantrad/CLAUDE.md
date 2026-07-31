# yantrad — working notes

**It serves, and that is all it does.** Y-069 made it a real `axum` server with one route; the read
model (Y-070) and the API (Y-071) are not written yet. The most useful thing you can do here is still
not write code before M4 needs it.

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
