# yantrad — working notes

**It serves, it looks, it answers, and it acts.** Y-069 made it an `axum` server, Y-070 gave it a
background read model, Y-071 put that model on the wire at `/api`, Y-108 added `POST /heartbeat`, and
Y-112, Y-116 and Y-126 gave it the writes a dashboard needs. The most useful thing you can do here is
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

**The read side of it is `GET /api/machines`**, which joins the beats onto what Tailscale said,
keyed on the node id — the one field that route still does not serve. `null` there is **never heard
from**, and it is a different state from a beat that reports zero (I-47). The daemon names none of
ADR-0013 §7's four display states: it serves the beat's age and `online`, and the page decides, because
a state named in two places is a disagreement waiting to happen (§3's argument against shipping `os`).
`sent_at` is the one field of the seven not exposed — it feeds nothing, and no consumer has asked.

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

`POST /api/workspaces`, `PATCH /api/workspaces/{name}` and
`POST /api/workspaces/{name}/{up,down,resume}` — **the CLI's own verbs and
nothing more**, being `yantra new`, `edit`, `up`, `down` and `resume`. The daemon
may do what `yantra` can already do, which is what stops it growing a richer API the CLI cannot
reach. A new verb here starts in the CLI.

Authorisation is [ADR-0016](../../docs/adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md):
the caller's address is resolved **live** through `whois`, and anything that is not this owner's own
untagged node is refused. *Which* address that is, is ADR-0017's — see the proxy section below.
Three rules that are easy to get subtly wrong:

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

**`PATCH` is the one that refuses**, and the refusal is [`edit.rs`](../yantra-core/src/edit.rs)'s
rather than a guard added here (Y-126). Moving `machine` while a tmux session is open on the machine
being left is **`409`**: the session would stay where nothing looks for it and every later verb would
report it as absent (I-30), and `yantra down` is what clears it. A machine that could not be asked is
**`503`** — R-23's shape, and the same reason a `tailscale` that cannot answer is not a `403`.
**Absent and `null` are different on this route**: `"startup": null` clears the command and no
`startup` key leaves it alone, which serde folds together unless the field is read into an
`Option<Option<_>>` by hand — getting that wrong is how a `PATCH` blanks a field nobody named. A body
naming no field is a `400`, exactly as `yantra edit` with no flags is a usage error.

**`up`, `down` and `resume` name every variant they can refuse with, and none of them has a
wildcard** (Y-135). Before this each mapped a workspace error and sent *everything else* to `500`, so
a state the daemon had correctly identified reached the dashboard as *the verb ran and failed*: an
agent holding at claude's trust dialog (I-49), and — far commoner — one that cannot read the macOS
login keychain (I-44). The rule the mappers apply is the one `from_create` and `from_edit` already
wrote down. **`409`** is a refusal about state: the world already answers and a person changes that
answer, which covers the trust dialog, an agent that is not logged in, a session opened as a shell, a
workspace that runs something of its own, and a `repo` the machine does not have. **`503`** is
nothing decided at all — ssh, tmux, terminfo, a status that could not be read, and a `resume` whose
two sources disagree (R-23). **`500`** is left for what is genuinely this daemon's: no state
directory, and a session id it could not generate. **Adding a variant to `up::Error`,
`down::Error`, `resume::Error`, `agent::Error` or `status::Error` will not compile until it is given
one of the three**, which is the whole point of the shape.

**A workspace written this way is not in the read model yet.** `refresh.rs` looks every 30 s, so
`GET /api/workspaces` keeps answering without it for up to that long — measured at 15 s on the first
try. The `201` and the `PATCH`'s `200` carry the whole workspace back for exactly this reason: a
client that re-reads the list to find what it just wrote will draw what was there before.

**These handlers await ssh, and that is deliberate.** The rule below is about a browser polling
reads whether or not anyone is looking; a write happens when a person taps a button, once. Do not
generalise the exception — a *read* that awaits ssh is still the bug that rule exists to prevent.

## The route that hands a terminal over

`GET /api/workspaces/{name}/terminal` upgrades to a WebSocket carrying
[`pty::Terminal`](../yantra-core/src/pty.rs) (Y-129). **An upgrade is a `GET`, so it does not inherit
the check above — and it is the route that most needs one.** `terminal.rs` calls `allowed()` by name
before the upgrade rather than leaving a reader to notice: `up` starts a process Yantra chose, and a
terminal runs whatever the person on the other end types.

**The frames carry no envelope, because the protocol already carries two kinds.** Binary is terminal
bytes, in both directions. Text is control: from the browser it is `{"rows":…,"cols":…,"term":…}`,
and it must arrive **before** anything else, because a pty is opened with a window and a terminal and
nothing else tells the daemon how big a browser is or which one it is; from the daemon it is the
reason a terminal could not be opened, which a close frame cannot hold — that reason is capped at 123
bytes and an ssh diagnosis is longer. The size is in `contract.gen.ts` beside every other shape on
this seam, and is the first entry there that the *browser* writes rather than reads.

**`term` is the caller's and this crate names none of its own** (Y-130). I-36 refuses a *user's*
`TERM` as an input, and this is not one: it is a constant in the dashboard's own code, `xterm-256color`
for the xterm.js it runs, and `terminfo::choose` probes it against the far side regardless. One
message does both jobs, so it arrives again on every resize and is not read there — a caller cannot
become a different terminal without opening another socket.

**Do not log the stream, and do not buffer it.** Q5 closed *reference-only, always* and names a
terminal stream in the sentence that closed it, so a resolved secret can be on this one. Log the
lifecycle; never the payload, not truncated and not at debug. **Reconnect needs no buffer here**
(Y-132): a browser whose socket dropped opens another, this route opens another pty, and the tmux on
the far side draws the pane's current contents for whichever client attaches — measured, alternate
screen included, in [`tests/pty.rs`](../yantra-core/tests/pty.rs). A window of the last N bytes would
be a second copy of what tmux already has, and it is the copy Q5 is about.

**The daemon originates a ping, and a peer that stops answering loses the socket** (Y-134). Nothing
else here is on a timer, so before this a socket whose peer vanished held the `ssh` child, the pty
master and the tmux client on the far side until a `send` failed — and a send needs the far side to
print first, which an agent thinking quietly never does. **A timer measured on traffic is the wrong
instrument in both directions**: output in progress is not idleness, and silence is not death. Only
the pong separates them, and it is a protocol frame rather than the stream, so Q5's line above is
untouched — nothing reads what is on it. Two consecutive unanswered pings twenty seconds apart end
the socket, which drops the `Terminal`; a pong resets the count, so a terminal that prints nothing
for an hour is never closed. The ping starts at the upgrade rather than at the pty, because the
socket outlives the terminal at both ends and a caller that never sends a size holds a task too.
`MissedTickBehavior::Delay` is load-bearing: `pty::open` can outlast an interval, and the default
burst would deliver catch-up ticks as misses the peer was given no chance to answer.

This route is authorised on both ports since Y-118 (ADR-0017), and its test is the refusal that
proves it: a forwarded address resolving to a **tagged** node does not get an upgrade even though the
TCP peer is ours. That the peer must be a real one is why these tests bind a **real `TcpListener`** —
`WebSocketUpgrade` strips `OnUpgrade` during extraction, so a `tower::oneshot` never reaches the
handler and would assert a status the authoriser never produced.

## The dashboard's types are checked against these routes, not trusted to match

`contract.rs` (Y-124) drives the real `api::router()` over a fake snapshot and commits every answer
to [`web/src/contract.gen.ts`](../../web/src/contract.gen.ts) as TypeScript that `satisfies` the
types in `web/src/api.ts`. **Move a DTO here and `just test` goes red**, saying `just fixtures`;
regenerate without moving `api.ts` and `tsc` goes red instead. Before this the two sides were kept in
step by convention, and a renamed field left every test green and the dashboard blank.

TypeScript rather than JSON because an imported JSON module has its string literals widened to
`string`, which none of `api.ts`'s discriminated unions accepts — the assertion has to sit where the
literal is written. The write answers are serialised from their DTOs rather than fetched, since those
handlers authorise a live tailnet caller and then await ssh; what that leaves unchecked is status
codes, headers and every refusal body, none of which is JSON.

**`terminalSize` is the entry travelling the other way** — a shape the *browser* writes and the
daemon reads (Y-129). `satisfies` checks the same thing about it, which is that the two sides spell
one message identically; that the daemon then accepts it is `terminal.rs`'s own test.

## TLS is not this crate's job, and the proxy costs it something

Y-111 put the daemon behind `tailscale serve` on port 8443 (`just https`,
[`docs/development.md`](../../docs/development.md)). §B2: Tailscale already holds and renews a
publicly-trusted certificate for the machine's `*.ts.net` name, so **do not terminate TLS here, and do
not add a cert crate** — the daemon speaks plain HTTP on 7717 and that is the whole design. It also
proxies to the **tailnet address**, because loopback is refused above.

**The proxy launders the source address, and [ADR-0017](../../docs/adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md)
is what unlaunders it** (Y-118, 2026-08-05). Measured 2026-08-03: a request from another machine
arrives at the backend from *this* node's address, with the caller in `X-Forwarded-For` and
`Tailscale-User-Login`. So the caller's address is the TCP peer **unless the peer is one of the
addresses `listen_on` bound**, and then it is `X-Forwarded-For` — that condition and no other.
`allowed()` is now protection on both ports.

Three things about that rule are easy to get subtly wrong, and each is a security bug in a different
direction:

- **The trusted set is the bound addresses, not "local".** Not loopback, which is never bound; not
  any private range. Widening it by one address gives whatever holds that address the run of the
  fleet.
- **An absent header is not a refusal.** It means nothing proxied the request, which is every call on
  7717 — refusing it would leave the CLI's own port answering 503.
- **One address or refuse.** `tailscaled` writes exactly one with `Set`, so a comma list, a second
  header line or anything unparseable means something unmeasured is in the path. Do not take the
  leftmost entry; that is how a caller-supplied entry becomes an identity.

**The trust is in the local hop, not in `tailscale serve`.** Any process on this machine can connect
to a bind address and name whatever caller it likes — no escalation under
[ADR-0012](../../docs/adr/0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md), since a
local process can already call the library, but it is now written down. **Putting a second reverse
proxy in front of 7717 is the condition to revisit that ADR.**

## Nothing expensive happens on the request path

`ssh.rs` sets `ConnectTimeout=10`, so one asleep machine costs ten seconds. A browser polls whether
or not anyone is looking, so a handler that calls `sessions::list` per request turns one open tab
into a permanent ssh storm. `refresh.rs` looks on its own schedule; a handler clones the snapshot and
reads memory. **Never `await` ssh inside a handler.**

**Two things hold ssh anyway, and each says so where it does it.** `write.rs` awaits it because a
person tapped a button once. `terminal.rs` holds a connection open for as long as someone is looking
at a terminal — and pays for it *after* the upgrade has answered, in a task belonging to the socket
rather than to a request. Neither licenses a **read** that awaits ssh, which is still the bug this
module exists to prevent.

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
