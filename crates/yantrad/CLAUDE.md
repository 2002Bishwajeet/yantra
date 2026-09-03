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

## The refusal is the retry condition, and systemd is what waits

[`yantrad.service`](yantrad.service) sits beside this file (Y-142). At a prompt `listen_on`'s refusal
is a good error message; at boot it is a race, because `tailscaled` reports itself started when its
socket is up rather than when the netmap has arrived. So the unit is `Restart=on-failure` with a
`RestartSec` far enough apart that five refusals cannot reach systemd's ten-second start limit —
which would leave a headless box `failed` permanently — and `After=tailscaled.service`, which orders
the start and waits for no address. **Do not add an `ExecStartPre` that polls `tailscale status`**:
that is a second retry mechanism in front of one that already exists.

**It is a system unit, and `--user` with lingering lost on a measurement**: the user manager resolves
`After=` among *user* units, where `tailscaled.service` is `not-found`, so the ordering this is
written for would order against nothing. The price is paid in `ControlPath` — a system unit has no
`XDG_RUNTIME_DIR`, so `machine_at` falls back to `data_dir()` and the path is 38 bytes rather than
27, against I-28's 90.

**What no restart covers is an address that changes while the daemon is healthy**, because nothing
fails: I-58, recorded rather than fixed.

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

## The one check it can answer and the library cannot

`GET /api/readiness` and `GET /api/machines/{name}/readiness` (Y-168) serve
[`yantra_core::doctor`](../yantra-core/src/doctor.rs) — [D2](../../docs/design/02-setup.md) §3.1's
checks per machine. **`heartbeat` is why the routes exist.** The library answers it *unknown* from
every caller it has, and that is the architecture rather than a gap: the beats are in this process
and nothing persists them (Y-044), while ADR-0012 keeps the CLI out of the daemon. So `api.rs`
substitutes the check rather than the library changing its answer — *present* with its age where a
beat has arrived, *absent* where none has since this process started, and *unknown* where the tailnet
list holds no node of that name, because the beats are keyed on the node id (I-5) and a report names
a machine the way a workspace does (ADR-0009).

**No age threshold, deliberately — and it is not free.** Any beat that arrived is *present* carrying
how long ago. Which ages mean a dead agent is ADR-0013 §7's, and this daemon names none of those
states, the same rule that keeps `/api/machines` serving an age and `online` rather than a verdict.
**What differs here is that a check is already a verdict**: `/api/machines` hands the page a number
and `State::Present` hands it a green tick, so a machine whose agent died an hour ago is *present* on
this route while the machines table beside it reads *asleep or off*. **The card reconciles it and
this route must not**: `Readiness.tsx` draws the `heartbeat` row out of the machines reading through
`reporting()`, which already owns the threshold — so the state is named once, where every other
heartbeat state is named, and nothing here parses a detail or writes 30 s down a third time beside
`yantra-agent`'s `INTERVAL` and `columns.tsx`'s `FRESH_SECONDS`. A second consumer of this route
inherits the same obligation, and a test in `dashboard.test.tsx` is what says so out loud.

**`GET /api/readiness/github` is the other check the library answers from nobody useful** (Y-175),
and it is the same argument pointed at a different fact: `yantra_core::attention` spawns `gh` on the
host it runs on, so the credential the work inbox reads is the daemon's and never the terminal's. It
is a route rather than a tenth check on every report, because an answer about this machine drawn on
each machine's card claims something no ssh session asked. Two answers are *absent* and both are
earned — no `gh` on `PATH`, and a `gh` that names no credential — and **everything else is
*unknown*, including an unreachable GitHub**, because `gh auth status` reports a token it could not
validate exactly as it reports one that was refused. It has no `failed`: a look it could not take is
already *unknown* inside the check.

**It is a class on the refresh sweep, not a handler that runs `doctor`.** Nine checks over ssh per
machine is the dearest look the daemon takes, and a browser polls whether or not anyone is looking.
It runs at the same `EVERY` as the other four, and **not** because a slower loop would pay a fresh
handshake — the machines, sessions and agents sweeps hold the `ControlPersist=300` masters open on
their own, so readiness rides them at any interval. It is the same constant because Q6 left nothing
to tune and because the load is already this daemon's shape: the agents sweep runs `claude agents
--json` on every machine every 30 s, and this adds the auth gate beside it. The one-machine `GET`
reads that same sweep, so a machine no workspace names is a **404** — `doctor::fleet` asks the
machines workspaces name, and asking a machine per *polled* request is the thing this shape refuses.

**`POST /api/machines/{name}/readiness` is where a person may ask anyway** (Y-197,
[ADR-0019](../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md)): someone who has just
installed `tmux` by hand needs the answer before the next sweep, and the `GET` beside it can only
serve one up to 30 s old. It lives in [`write.rs`](src/write.rs) with the probe, on the same
authoriser, and it answers the sweep's own envelope at `age_seconds: 0` so the page needs no second
type. **It takes any machine name and there is no 404** — ADR-0009 leaves this daemon no register of
ssh destinations to refuse one against, and a name nothing answers to is nine *unknown* checks like
any other machine that did not answer, because `doctor::machine` cannot fail (R-23). It costs a full
`ConnectTimeout` when the machine is asleep. **Nothing stops a client polling it** — ADR-0019 says so
of itself, and debounce belongs in the browser.

## The one thing it sends, and the two rules that keep it useful

`notify.rs` runs off the **agents** loop in `refresh.rs` and adds no poll, no ssh and no timer: two
consecutive readings are its whole input, and [`yantra_core::notify`](../yantra-core/src/notify.rs)
holds what a difference between them means. `Verdict` is the vocabulary — `AwaitingTrust` above all
(I-49), then a `Running` that stopped being one — and **never a telemetry threshold**, which
ADR-0013's non-goals rule out against this milestone by name.

Four rules bind anything that touches it:

- **The first look after a start says nothing.** Nothing is persisted, so a fresh daemon has no
  previous state — and a `None` read as *everything just changed* mails a report about every session
  on the fleet at every reboot. **A restart is therefore a hole**, recorded as I-58's neighbour in
  [`tracker.md`](tracker.md) rather than fixed.
- **A failed send drops that notification.** No queue, no retry, no replay. A queue is state on a box
  whose whole point is that it holds none, and `yantra-agent`'s `Log` is the precedent for the
  logging too: the first failure out loud, the rest swallowed until one lands.
- **A look that failed tells nobody anything.** An unknown fleet is not a changed one, and the same
  rule one level down is why a machine that could not be asked *keeps* the verdicts it had rather
  than reading as gone — otherwise a laptop that sleeps announces itself every night and then hides
  the crash it wakes up with.
- **The reading is in the model before anything is sent**, and the whole pass has a budget well under
  the refresh interval. A notifier that makes a browser wait on a relay is worse than one that drops.

**The body names the workspace and the verdict and nothing else**: `Notification`
has no field for a machine or a repo, so widening what a public relay is told is an edit here. The
destination is a `Relay`, whose `Debug` is hand-written because both halves of it are secrets — the
token by §B4 and Q5, and the topic because on ntfy.sh the topic *is* the password. No error below it
carries either, which is why a failure that could quote the URL back is reported by kind instead.

**Q16 was answered wider than it was asked** (Y-147): the relay is a general publish channel and this
notifier is only its first caller, so a body is whatever the caller passed and Yantra composes
nothing into it. What binds this crate is unchanged — the fleet notification is still a workspace and
a verdict — and what changed is that this is now one caller's choice rather than the channel's limit.

**The relay comes from the environment**: `YANTRA_NTFY_URL` and `YANTRA_NTFY_TOKEN`, read once in
`main.rs` and handed to `refresh::spawn`. An absent URL is a daemon with no relay and is **not** a
refusal to start — it is every deployment but the appliance, and it is the one this crate's tests
run. The token is never a workspace field, never written to disk, never logged and never served,
which is ADR-0013 §4's rule for `YANTRA_DAEMON` applied to the first byte that leaves the tailnet.
The startup line saying which of the two it got is there because a unit's environment is not the
shell's, and a headless box has only the journal to say so.

**The relay is settable now, and the read above is unchanged** —
[ADR-0021](../../docs/adr/0021-the-relay-is-written-to-an-environment-file.md), Y-199. `/settings`
and `yantra relay` write `/etc/yantra/daemon.env`; the unit reads it with `EnvironmentFile=`; this
process still takes both values out of its environment once, in `main.rs`. So a relay written now
reaches the daemon at its **next start**, and both surfaces say so rather than implying it is live.
That ADR bends §B4 and Y-044 on purpose and says what the exposure is; read it before moving either
value anywhere else. **The token is still never logged and never served** — no route reads the file
back, and `tracing` names the caller and never the topic.

**Nothing is pushed while a dashboard is open** (D3 §13). `notify::Viewers` is a last-seen-a-viewer
timestamp beside the snapshot, `POST /api/viewing` writes it, and `refresh` hands the notifier a
bool. **The diff still runs when it is suppressed**: what a watched look produced is dropped rather
than held, so closing the tab does not deliver a backlog of things the page already showed. It is in
memory and a restart forgets it, which is Y-044 exactly as written — that state is not the exception
ADR-0021 carved.

## It serves the dashboard, from a directory — and, for M7 only, from inside itself

`YANTRA_WEB` names a directory of **built** assets and `web.rs` serves it as the router's fallback,
so `/api`, `/healthz` and `/heartbeat` keep winning and everything else is the app. Unknown paths get
`index.html` rather than a 404, which is what makes a deep link work.

**A miss under `/api` is the one path that does not reach it** (Y-169, I-64). A nested router with no
fallback of its own hands the miss to the outer one, so an absent API route used to answer
`200 text/html` — indistinguishable from a served page. `api::router` therefore carries a fallback of
its own: a **JSON 404** in the `{"error": …}` shape every other error on this seam uses. The whole
tree is composed in `main.rs`'s `app`, apart from `serve`, so a test can drive both halves at once.

**The default build embeds nothing, and R-24 is why**: a build that wants `web/dist` unconditionally
makes every `fmt`, `clippy`, `test` and musl cross-build job depend on npm. Y-140 added the other
half for the appliance that wanted one file to copy, and every part of its shape exists to keep that
sentence true. The `embed-dashboard` feature is **absent from `default`**, `include_dir` is an
**optional** dependency, and [`web/embedded.rs`](src/web/embedded.rs) is behind a `#[cfg]` — so a
default build neither reads `web/dist` nor compiles the macro that would.

**Nothing in `just check` or `just ci` may turn it on, and `--all-features` is the specific thing
that must never appear.** `just lint` and `just test` do not pass it today, and one added later for
tidiness would put npm on clippy, on the test job and on the cross-build at once, silently.
**`just no-node` is that omission made into a red build**: it is part of `check`, it greps every
recipe the Rust gate would run and `ci.yml` itself, and it fails if `include_dir` ever reaches the
default dependency graph. The one job that *does* build with the feature is
[`.github/workflows/embed.yml`](../../.github/workflows/embed.yml) — a workflow of its own, because
`ci.yml` has no path filter and a Node step there runs on every Rust pull request.

**`YANTRA_WEB` wins over the embedded copy, and a set-but-wrong one still refuses.** That is Y-140's
one real decision and it is about which of the two may be silently wrong: the embedded dashboard is
fixed at build time and has nothing to mistype, while the variable is typed by a person at deploy
time. Falling back would leave someone editing the directory they pointed at while a stale copy
ignored them — R-23's confident lie, which is what the refusal exists to prevent.

Three failure shapes, deliberately different. **Unset** is a normal deployment — the API serves alone
and `/` says so *and says how*, or serves the embedded copy when the binary was built with one.
**Set but wrong** refuses at startup, because a `ServeDir` over a missing directory answers 404 to
everything, and that reads as a broken dashboard rather than a typo in one environment variable.
**Right at startup and gone afterwards** is the same 404 that the startup refusal exists to prevent,
arriving too late for it: M6's acceptance run had `YANTRA_WEB` pointing into a git worktree that was
then deleted, and the daemon went on answering `/` with an empty 404 and said nothing. It is now a
**`503` naming the path and saying how**, plus a log line said once and another when the directory
comes back. **Do not make it an exit** — the API, the heartbeat and the terminal socket are still
serving, and a daemon that dies because a directory vanished is worse than one that reports it. The
check hangs off the 404 path rather than the request path, because while the directory is there the
SPA fallback means almost nothing 404s. **The embedded half cannot have this failure**: its files are
a table the compiler built.

One thing the tests record because it is not obvious: a path that climbs out of the root answers
**200 with the app**, not 403 or 404. `ServeDir` refuses the climb and the SPA fallback then treats
the path as one the app routes, so a traversal attempt and a deep link are indistinguishable by
status. Assert on the body. **The embedded half answers it identically**, and its tests say so —
there the climb needs no guard at all, because a lookup in a table the compiler built has no
directory to walk.

## The routes that act

`POST /api/workspaces`, `PATCH /api/workspaces/{name}`,
`POST /api/workspaces/{name}/{up,down,resume,tokens,logs,repair}` and `POST /api/relay` — **the CLI's
own verbs and nothing more**, being `yantra new`, `edit`, `up`, `down`, `resume`, `tokens`, `logs`,
`repair` and `relay`. The daemon may do what `yantra` can already do, which is what stops it growing a richer API
the CLI cannot reach. A new verb here starts in the CLI, and `yantra relay` was written before this
route was.

**`POST /api/viewing` is the one write with no verb behind it**, and it is not an exception to that
rule so much as a thing a keyboard cannot mean: it says *a browser is showing this page now* (D3
§13), which no CLI can say truthfully. It is authorised like the rest because it silences
notifications.

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
answer, which covers the trust dialog, an agent whose credential the gate did not find, a session
opened as a shell, a workspace that runs something of its own, a `repo` the machine does not have,
and — since Y-151 — a macOS machine with **no tmux server**, which
[ADR-0018](../../docs/adr/0018-the-tmux-server-carries-the-macos-login-session.md) §1 forbids Yantra
to start there and a person fixes by starting one from their own login session. **`503`** is
nothing decided at all — ssh, tmux, terminfo, a status that could not be read, and a `resume` whose
two sources disagree (R-23). **`500`** is left for what is genuinely this daemon's: no state
directory, and a session id it could not generate. **Adding a variant to `up::Error`,
`down::Error`, `resume::Error`, `agent::Error` or `status::Error` will not compile until it is given
one of the three**, which is the whole point of the shape.

**A workspace written this way is not in the read model yet.** `refresh.rs` looks every 30 s, so
`GET /api/workspaces` keeps answering without it for up to that long — measured at 15 s on the first
try. The `201` and the `PATCH`'s `200` carry the whole workspace back for exactly this reason: a
client that re-reads the list to find what it just wrote will draw what was there before.

**`tokens` is the one that writes nothing** (Y-199). It is here because it asks a machine on demand
and nowhere else fits — ADR-0019 again. Two properties of the answer are the library's and must not
be flattened here: [`tokens.rs`](../yantra-core/src/tokens.rs) sums on the far machine and ships
**numbers rather than records**, so `Spend` has no field a conversation could arrive in (Y-181); and
[`price.rs`](../yantra-core/src/price.rs)'s `AS_OF` travels beside the figure, because a table
written into a binary reports wrong money the day a rate changes. **An unpriced model is `null` and
never `0`**, a fast-mode session withholds every dollar and keeps every token, and a session that
has spent nothing has no figure at all. `render_tokens` in the CLI is the list to check against.

**`logs` opens the same file and writes nothing either** (Y-307,
[D5](../../docs/design/05-workspace-page.md) §9). It is a `POST` for the reason `tokens` is, it sits
on the same authoriser and it shares `from_logs` — so the **two empty cases are `409`** and a machine
that could not be asked is `503` carrying the ssh chain, which names the machine and what ssh said.
The body is `{lines, before}` and both are optional; no body is the first fifty **records**, which
measured as forty-one turns. The projection is the library's: who spoke, when, the text, and one
`Call { name, target }` per tool. **The tool results never cross the wire** (I-46), and the target is
capped on the far side, so widening either is an edit to
[`logs.rs`](../yantra-core/src/logs.rs) rather than to this route.

**`repair` is the one that writes bytes this daemon did not compose**, and
[ADR-0020](../../docs/adr/0020-a-raw-write-only-from-broken-to-valid.md) is the only reason it may.
Every other write here renders a `Workspace` the library has already checked; this one takes a whole
file, because `update` loads before it writes and so no verb could reach a workspace file that will
not parse. Two refusals hold it: a file that **already loads** is `409`, and bytes that **still will
not** are `400` carrying the next error rather than a summary — the caller is answering the one it
was shown. `from_repair` exists for that second one, because `from_workspace` sends `Malformed` and
`Blank` to `500` and is right to: there they are this daemon reading its own files, here they are the
bytes the caller sent. **The `GET` beside it is in `write.rs` too, on the same authoriser**: a file's
raw bytes are the one thing `GET /api/workspaces` does not publish, and it answers the same `409`, so
asking for the file *is* the question whether it is broken.

**These handlers await ssh, and that is deliberate.** The rule below is about a browser polling
reads whether or not anyone is looking; a write happens when a person taps a button, once. Do not
generalise the exception — a *read* that awaits ssh is still the bug that rule exists to prevent.

## The route that hands a terminal over

`GET /api/workspaces/{name}/terminal` and, since
[ADR-0022](../../docs/adr/0022-a-socket-may-address-a-session-rather-than-a-workspace.md),
`GET /api/machines/{machine}/sessions/{session}/terminal` upgrade to a WebSocket carrying
[`pty::Terminal`](../yantra-core/src/pty.rs) (Y-129). **An upgrade is a `GET`, so it does not inherit
the check above — and it is the route that most needs one.** `terminal.rs` calls `allowed()` by name
before the upgrade rather than leaving a reader to notice: `up` starts a process Yantra chose, and a
terminal runs whatever the person on the other end types.

**Two addresses, one bridge, and the second is not a second terminal.** A workspace was only ever
read for the machine and the session it names, so a caller holding both needs no workspace: the
routes share `allowed()`, the protocol, the ping and `pty::Terminal`, and what differs is the
`Target` a socket carries and the name a log line says. **It attaches and never creates**, so a
session that went away between the list and the tap is refused by name. Read that ADR before
narrowing it — a check on whether a workspace claims the session is the alternative it refuses, and
`allowed()` is deliberately the whole of the protection.

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

**`/api/attention` is in it since Y-322**, and what it cost is the lesson. Y-173 shipped the route
with `attention: None` because an entry has to `satisfies` a type in `web/src/api.ts` and no file
read the route yet. Y-314 wrote those types by hand nine rows later, and Y-322 was a whole row to
join them up. **Land a DTO and the type that checks it in one change**, which is why Y-307's
`Transcript` arrived with its own entry rather than with a comment deferring one.

**`/readiness/github` still holds `github: None`**, and that deferral has not expired: nothing in
`web/src` reads that route, so there is no type for an entry to satisfy.

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

**Seven things hold ssh anyway, and each says so where it does it.** `write.rs` awaits it because a
person tapped a button once. `terminal.rs` holds a connection open for as long as someone is looking
at a terminal — and pays for it *after* the upgrade has answered, in a task belonging to the socket
rather than to a request. **`write.rs`'s probe route is the third, and it is a read**
([ADR-0019](../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md)): the answer depends on a
path nobody has typed yet, so no snapshot can hold it, and it is reached over a `POST` rather than
given a `GET` that would await ssh.

**Y-197 and Y-199 add two more reads on that same licence, and both are `POST`s in `write.rs`.**
The readiness re-check asks a machine a person named; `POST /api/workspaces/{name}/tokens` opens the
agent's transcript, which is the **dearest** read this crate has — a file that grows all session, on
a machine over ssh. Neither may be swept and neither may be polled. D3 §11.4 is the same rule stated
as a design: money lives on a tab somebody opens, because a `$` on a fleet row would put that read
into the 5 s loop.

**Y-300 is the sixth, and it is the cheapest of the three reads.** `POST /api/machines/{machine}/dirs`
lists **one level** of a machine's filesystem so a form can walk to a directory rather than trust one
that was typed. [D4](../../docs/design/04-workspace-creation.md) §2 is why it may sit here at all: a
whole-home `find` measured 8.5 s on this fleet's Mac and one level measured 0.23 s, which is what the
probe beside it already costs. **A sweep would have needed an ADR** — eight seconds inside a handler
is a different decision from a probe's — so the shape is the licence, and widening it to recurse
would spend a ruling that was never given.

**Y-307 is the seventh, and it reads the file `tokens` reads.** `POST /api/workspaces/{name}/logs`
carries a window of the transcript to the page, and D5 §4.3 spends the licence the same way: landing
on the transcript tab is the request, `Older` and `Refresh` are the only other reads, and nothing
polls. §2.2 measured the far-side filter free over 15 MB and the ssh round trip at 0.33 s, so **the
round trip is the whole cost** — which is the argument for reading a window on request and against
reading one on a timer.

None of the seven licenses a **read handler** that awaits ssh, which is still the bug this module
exists to prevent. ADR-0019 sets the test for the next candidate, and it is two halves rather than
one: **a person initiated it, and nothing polls it.** A route a page calls on a timer fails the
second half however it is spelled, and choosing `POST` does not rescue it.

The interval is a constant for the same reason the port is. `ControlPersist=300` means anything under
five minutes keeps every ssh master warm, so the poll makes the fleet *faster* — and because the
`ControlPath` is per-user, a running daemon speeds the CLI up too.

**`ssh` is not the only thing this rule is about, and `gh` is the proof** (Y-172). `GET /api/attention`
reads a `Forge` reading the sweep took; a handler that ran `gh` would spawn three subprocesses and
make three round trips to GitHub per browser poll, which is the ssh storm with a different binary in
it. **What is different is the interval, and it is the one class that does not run at `EVERY`.**
The fleet poll pays for itself — `ControlPersist` again — while a `gh` poll warms nothing and is
spent from the owner's own GitHub quota, which their `gh` and their `git push` draw on too. GitHub
asks for the slower poll itself: `/notifications` answered **`X-Poll-Interval: 60`** on 2026-08-10, so
`EVERY` would poll it at twice the rate its server requests. `ATTENTION` is five minutes, and the
freshness that costs is a field rather than a lie — the reading carries its own age like every other.

Two measurements from that day worth keeping, because both invert what the obvious worry would be.
`gh search` spends the **GraphQL** budget (5000 points/hour) and **not** the REST search budget —
which is 30 per *minute* and would have been the tight one, and is untouched. `/notifications` is
`core`, and `/rate_limit`'s own `core.used` field does not move for it; the response header does.
**Read `X-Ratelimit-Used` off the call, not the `/rate_limit` endpoint**, if this is ever measured
again.

**Four states, not three**, and folding any two together is the bug this module exists to avoid:
nobody has looked (`None`), a look succeeded, a look succeeded and a machine within it did not answer,
and *the look itself failed*. I-47 is the same mistake one layer down. All four reach `/api` by name
(`looked` and `reached`), because a client that has to infer a state from a missing field will infer
the wrong one.

**A failed look replaces the previous good one, and that is Y-071's decision rather than an
accident.** Every class-level error here is local and persistent — `tailscale` missing, no config
directory — so retaining a stale reading would hide a fault the operator has to fix, and go on
hiding it. The transient case is a *machine* that did not answer, and that already survives inside a
successful reading. **A malformed workspace file is no longer one of them** (Y-141): it is an entry
of `data` saying `loaded: "no"` with its reason, and the class stays `ok`.

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
