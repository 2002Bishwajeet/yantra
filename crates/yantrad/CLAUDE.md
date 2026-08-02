# yantrad — working notes

**It serves, it looks, it answers, and it acts.** Y-069 made it an `axum` server, Y-070 gave it a
background read model, Y-071 put that model on the wire at `/api`, Y-108 added `POST /heartbeat`, and
Y-112 and Y-116 gave it the four writes a dashboard needs. The most useful thing you can do here is
still not write code before a milestone needs it.

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

## The one write, and what it may not grow into

`POST /heartbeat` ([ADR-0013](../../docs/adr/0013-the-heartbeat-carries-only-what-placement-scores.md)
§4–§6) is the whole of it. Three rules bind anything that touches `heartbeat.rs`:

- **The response is `204` with an empty body, permanently.** A reply the agent acts on is a control
  channel, and a control channel is how `yantra-agent` stops being a reporter (R-12).
- **Identity is the source address, never a field in the body**, matched against the
  background-refreshed inventory. Do not call the LocalAPI per request, and do not add a machine name
  to the payload — a body that names its sender can name someone else's.
- **It writes to memory.** One row per machine, overwritten every beat, so a flood costs CPU and
  cannot fill a disk. `Beats` sits beside `Model` rather than inside `Snapshot`: a beat is not a look
  the daemon took and has no `Result` to carry.

R-22 is unchanged as a boundary and larger as a blast radius — anything that reaches the tailnet can
now write, and the tailnet holds a phone and a tablet. What stops that mattering is that a heartbeat
is data for a score and never a path, name or command, so nothing in it reaches ADR-0006.

## It serves the dashboard, from a directory

`YANTRA_WEB` names a directory of **built** assets and `web.rs` serves it as the router's fallback,
so `/api`, `/healthz` and `/heartbeat` keep winning and everything else is the app. Unknown paths get
`index.html` rather than a 404, which is what makes a deep link work.

**Assets are a directory, not an embed.** R-24 is the reason: embedding makes every `fmt`, `clippy`,
`test` and musl cross-build job depend on npm, and the only thing that needs one file to copy is the
M7 appliance. Y-073's row describes a cargo feature for that; it arrives with the appliance that
wants it, not before.

Two failure shapes, deliberately different. **Unset** is a normal deployment — the API serves alone
and `/` says so *and says how*. **Set but wrong** refuses at startup, because a `ServeDir` over a
missing directory answers 404 to everything, and that reads as a broken dashboard rather than a typo
in one environment variable.

One thing the tests record because it is not obvious: a path that climbs out of the root answers
**200 with the app**, not 403 or 404. `ServeDir` refuses the climb and the SPA fallback then treats
the path as one the app routes, so a traversal attempt and a deep link are indistinguishable by
status. Assert on the body.

## The routes that act

`POST /api/workspaces` and `POST /api/workspaces/{name}/{up,down,resume}` — **the CLI's own verbs and
nothing more**, being `yantra new`, `up`, `down` and `resume`. The daemon
may do what `yantra` can already do, which is what stops it growing a richer API the CLI cannot
reach. A new verb here starts in the CLI.

Authorisation is [ADR-0016](../../docs/adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md):
the source address is resolved **live** through `whois`, and anything that is not this owner's own
untagged node is refused. Three rules that are easy to get subtly wrong:

- **A `tailscale` that cannot answer is `503`, never `403`.** Nothing was decided about the caller,
  and blaming them is a lie about which thing broke.
- **Tags are checked even when the owner matches.** A tagged node *is* owned by the tailnet, so the
  user check alone would let a CI runner through.
- **Identity never comes from the body**, for ADR-0013 §5's reason: a body that names its sender can
  name someone else.

`POST /api/workspaces` is the odd one: it touches no machine, and its interesting failure is a name
already taken, which is **`409`** rather than `400`. The caller asked for something reasonable that
the world already answers, and telling them to fix their request would send them looking for a
mistake they did not make.

**A workspace created this way is not in the read model yet.** `refresh.rs` looks every 30 s, so
`GET /api/workspaces` keeps answering without it for up to that long — measured at 15 s on the first
try. The `201` carries the whole workspace back for exactly this reason: a client that re-reads the
list to find what it just made will draw an empty one.

**These handlers await ssh, and that is deliberate.** The rule below is about a browser polling
reads whether or not anyone is looking; a write happens when a person taps a button, once. Do not
generalise the exception — a *read* that awaits ssh is still the bug that rule exists to prevent.

## TLS is not this crate's job, and the proxy costs it something

Y-111 put the daemon behind `tailscale serve` on port 8443 (`just https`,
[`docs/development.md`](../../docs/development.md)). §B2: Tailscale already holds and renews a
publicly-trusted certificate for the machine's `*.ts.net` name, so **do not terminate TLS here, and do
not add a cert crate** — the daemon speaks plain HTTP on 7717 and that is the whole design. It also
proxies to the **tailnet address**, because loopback is refused above.

**The proxy launders the source address, and that defeats the identity check.** Measured 2026-08-03:
a request from another machine arrives at the backend from *this* node's address, with the caller in
`X-Forwarded-For` and `Tailscale-User-Login`. Writes through 8443 are therefore all attributed to
whichever machine runs the proxy — which is this owner's own untagged node, so they succeed, and
ADR-0016's check rejects nothing it would otherwise have rejected. Its dated amendment records this;
**Y-118** decides what to do. Until then, do not read `allowed()` as protection against a tagged or
shared-in node — it is only that on the direct port.

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
- Stack: `axum` and `tokio`, both in use since Y-069. **Nothing is persisted, and `rusqlite` is in no
  `Cargo.toml`** — Y-044 was dropped on 2026-08-02 after an audit of five candidate consumers found
  none: state is declared in the workspace TOML, derived from tmux, or held in memory and re-read
  every 30 s. A store returns only for a question about the *past*; the tracker row names which ones.
- **Never store secrets.** Workspaces hold references; the daemon resolves them at launch and never
  writes a value to SQLite, a log, the API, or a terminal stream (root §B4).

## Before writing anything here

M4 is the milestone that needs it. Read [`tracker.md`](../../tracker.md) first — the daemon's shape
depends on decisions that are still open, including the telemetry ADR (Y-020) and whether a session
store is needed at all.
