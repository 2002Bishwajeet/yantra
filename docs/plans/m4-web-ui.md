# M4 — Web UI: implementation plan

**Written** 2026-07-31. **Status:** proposal, awaiting owner review.

This is a plan, not a decision record. Where it reaches a fork that deserves to be settled
permanently, it says so and defers to an ADR rather than quietly picking. §7 lists every such fork in
one place, because those are the parts that need a human before code starts.

Milestone claim, from [`tracker.md`](../../tracker.md) §2:

> Read-only dashboard over the same HTTP API the CLI uses: machines, workspaces, sessions, live
> status. Served over Tailscale.

---

## 1. What M4 has to prove

Five things, each independently checkable:

1. A browser on the tailnet — including a phone — shows machines, workspaces, sessions and agent
   status, without a terminal open anywhere.
2. It is **read-only**. Nothing in the UI can change the state of a machine.
3. The browser never talks to a managed machine. It talks to `yantrad`, and `yantrad` talks to the
   fleet.
4. An unreachable machine degrades the page instead of hanging it. This is the one that will
   actually bite — see §3.
5. `cargo build` still works on a machine with no Node installed.

(5) is not padding. The moment a Rust build needs a JavaScript toolchain, every `fmt`/`clippy`/`test`
job in CI grows a dependency on npm, and the appliance cross-build (`aarch64-unknown-linux-musl`)
grows one too. That is a guardrail, not a preference.

## 2. What is already true

The library is done for read purposes. Verified at `485aeef`:

| Capability | Where | Cost |
| --- | --- | --- |
| Machines from Tailscale | `inventory::Tailscale::machines` | local, no network hop |
| Workspaces | `workspace::list` | local disk |
| Sessions across the fleet | `sessions::list` | **ssh per machine**, already concurrent |
| Agent verdict for one workspace | `status::status` | **ssh** |
| Agent transcript | `logs::logs` | **ssh** |

So M4 writes no orchestration. Everything the dashboard shows already exists as a function that
returns a `Result`, which is exactly the position [ADR-0005](../adr/0005-core-logic-in-a-library-crate.md)
was arguing for two milestones before there was a second caller.

**`yantrad` today is 15 lines that print a version.** Its dependency list is `anyhow`. Nothing has to
be undone.

## 3. The constraint that shapes everything: a browser is not a person

This is the finding that makes M4 more than plumbing, and it comes straight out of the code.

`ssh.rs:175` sets **`ConnectTimeout=10`**. A machine that is asleep, off, or holding an expired node
key (I-39 — two of six on this tailnet) costs **ten seconds** before `sessions::list` can report it
as unreachable. Y-054 already made that cost concurrent rather than additive, so the *fleet* answer
still arrives in about ten seconds rather than ten times ten.

That is fine for a CLI. A human typed `yantra ls sessions`, is watching, and knows they asked.

It is not fine for a dashboard. A browser polls, and it polls whether or not anyone is looking. A
handler that calls `sessions::list` per request turns one open tab into a permanent ssh connection
storm against every machine in the fleet, most of it into a ten-second timeout, and every viewer
multiplies it.

**So the API cannot be a passthrough over the library, and that is the daemon's first real job.**
One background refresher polls; every handler reads a snapshot that is already in memory. Requests
never touch ssh.

Two consequences fall out of that, both good:

- **`ControlPersist=300`** (`ssh.rs:31`) keeps an ssh master alive for five minutes after last use.
  A refresh interval under five minutes therefore keeps every connection permanently warm — M2
  measured **20 ms warm against 150 ms cold** to the MacBook. The poll is not merely tolerable; it is
  what makes the fleet fast.
- The `ControlPath` is `state_dir/cm/%C` (`ssh.rs:71`), and `state_dir` is per-user and stable.
  Running as the same user, **the CLI reuses the daemon's warm masters**. A running `yantrad` makes
  `yantra ls sessions` faster as a side effect, which is an odd and pleasant result for a milestone
  about a web page.

Three different costs, three different treatments — this is the actual shape of the API:

| Data | Source | Refresh |
| --- | --- | --- |
| Machines | `tailscale status --json`, local | often; it is cheap |
| Workspaces | local `~/.config/yantra/workspaces/` | on request; it is a directory read |
| Sessions, agent status | **ssh to every machine** | background only, never on the request path |

## 4. Constraints that shape the design

Each one closes off a design that would otherwise look reasonable.

| Constraint | What it forbids |
| --- | --- |
| **§B1** Rust for the daemon, TS for the web UI only | Any logic in the browser beyond rendering. The daemon decides; the page displays. |
| **§B2** orchestrate, don't reinvent | Reimplementing Tailscale identity. The bind address comes from the inventory reader that exists (§5.1). |
| **§B4** never store secrets | A workspace DTO that serialises a resolved secret rather than the reference. Reference-only survives into JSON. |
| **ADR-0005** core never prints | Deriving the wire format from library structs. **JSON is presentation** — see §5.3. |
| **Q6** personal-first (2026-07-31) | A settings screen, a theme switcher, multi-user, and an auth model. One owner, one fleet. |
| **I-39** online ≠ usable | A green dot per machine. Online, offline and *expired key* are three states, and the third is the one a person can act on. |
| **Y-054's partial answer** | An endpoint that fails because one machine did. A machine that did not answer is data, not an error. |
| **Y-044 dropped** | Reaching for `rusqlite`. A read-only dashboard derives everything; nothing needs to survive a restart. |

> **Y-044 is dropped, not deferred, recorded 2026-08-02.** The row above said *still deferred* when it was written, and the guidance under it is what the audit went on to confirm — the dashboard derives everything and nothing needs to survive a restart. What changed is that this stopped being a deferral: five candidate consumers were audited and none needed a store, so `rusqlite` is not waiting for a better moment. See the Y-044 row in [`tracker.md`](../../tracker.md) and the 2026-08-02 amendment to [ADR-0004](../adr/0004-rust-for-the-daemon.md).

## 5. The work

### 5.1 Y-069 — `yantrad serve`: bind to the tailnet, or refuse

The daemon becomes an `axum` server. The only interesting part is where it listens.

"Served over Tailscale" is the milestone's own wording, and with Q6 answered — personal-first, no
auth beyond Tailscale — the bind address *is* the security boundary. Getting it wrong means an
unauthenticated read API on every interface.

**Verified 2026-07-31:** `tailscale status --json` reports `Self.TailscaleIPs` with both a v4 and a
v6 address on this machine. The inventory reader already parses that document, so the bind address
comes from the seam Yantra already has, rather than from a second copy of Tailscale's identity
(§B2). `inventory` gains a way to report the local node's addresses; it gains no new dependency.

**Fail closed.** If Tailscale is not running, or reports no address, `yantrad` exits with an error
naming the reason. It must never fall back to `0.0.0.0`, and it should never be *possible* to ask it
to — no `--bind` flag in M4. A flag that can expose the API is a flag someone will eventually pass.

Also: `/healthz`, structured logs via `tracing` (already in the workspace dependency list, unused),
and a clean shutdown on `SIGTERM` — the appliance in M7 will run this under a supervisor, and I-27
is a standing reminder about what happens to processes nobody reaps.

### 5.2 Y-070 — the read model

The answer to §3. One `tokio` task per data class, each on its own interval, writing into a snapshot
behind an `RwLock`. Handlers clone the snapshot and return; no handler awaits ssh.

Three things this must get right, all of them about honesty rather than mechanism:

- **A snapshot carries its own age.** Every reading is stamped with when it was taken, and the API
  returns that stamp. A dashboard that shows a two-minute-old session list as though it were live is
  lying, and the fix is one field, not a faster poll. `logs::Transcript` already established this
  shape by reporting `idle_for` from the far side's own clock rather than the local one.
- **A machine that did not answer says so.** Not absent, not stale-but-shown — reported as
  unreachable, with the reason, exactly as Y-054 already does for `ls sessions`. The dashboard's
  most useful state is "this machine is not talking to me", and it is the one a naive cache erases.
- **The first refresh has not happened yet.** A snapshot is `Option`, not an empty `Vec`. "No
  sessions" and "we have not looked yet" are different answers, and I-47 is this project's standing
  lesson about what happens when a missing value is defaulted into a real one.

Interval is a constant, not configuration (Q6). Under `ControlPersist=300` anything below five
minutes keeps masters warm; 30 s is the obvious starting point and the number is cheap to change.

### 5.3 Y-071 — the HTTP API

Four endpoints, mirroring the CLI one-for-one:

| Endpoint | CLI equivalent |
| --- | --- |
| `GET /api/machines` | `yantra ls machines` |
| `GET /api/workspaces` | *(none yet — see below)* |
| `GET /api/sessions` | `yantra ls sessions` |
| `GET /api/workspaces/:name/status` | `yantra status <name>` |

**The CLI is the honesty check**, per `crates/yantrad/CLAUDE.md`: anything the web UI can do must be
expressible in `yantra` first. That rule immediately earns itself — there is no `yantra ls
workspaces`, even though `workspace::list()` exists and `ls sessions` already calls it. Adding the
subcommand is a five-line change and it keeps the two surfaces honest, so M4 adds it rather than
letting the API get ahead of the CLI on its first day.

**DTOs live in `yantrad`, not derived on core's types.** ADR-0005 put rendering in the caller because
core has no opinion about who calls it; a JSON body is rendering. Deriving `Serialize` on
`MachineInfo` would make every field name a public API and turn a rename into a silently broken UI.
The cost is a struct per endpoint, which is the same cost the CLI already pays in `render_machines`.

`logs` is deliberately **not** an endpoint in M4. Reading a transcript is an ssh round trip that
cannot be usefully cached — it is per-workspace, unbounded, and only wanted when someone is looking
at it. It belongs with the terminal in M6, where the streaming question is being answered anyway.

### 5.4 Y-072 — the dashboard

One page, four sections, no navigation. Machines, workspaces, sessions, and per-workspace agent
status. It polls `/api` on a timer, which against an in-memory snapshot costs nothing, and every
reading is displayed with its age from §5.2.

What it deliberately is not: a settings screen, a login page, a theme switcher, a router, or a state
management library (Q6). It is one owner's read-only view of one fleet.

The framework is **not** decided here — see §7.2. Whatever it is, the constraint from §1 is that its
build output is static files and its absence never blocks `cargo build`.

### 5.5 Y-073 — shipping the assets

Two modes, because they have different jobs:

- **Development:** `yantrad` serves from a directory, Vite (or equivalent) serves the UI with hot
  reload and proxies `/api`. No Rust rebuild to change a stylesheet.
- **Release:** the built assets are embedded in the binary, so the appliance is still one file to
  copy. M7 wants that; M4 is where it is cheap to arrange.

Embedding goes behind a cargo feature that is **off by default**, so `cargo build`, `cargo clippy`
and the musl cross-build never need Node — §1's guardrail, enforced by the fact that CI's existing
eight checks would break loudly if it were violated. A separate CI job builds the UI. The release
workflow turns the feature on.

**Do not commit built assets.** A generated file in git is a merge conflict that no one can read and
a diff that hides what changed.

## 6. What M4 deliberately does not do

- **No writes.** No `up`, `down`, or `fix-terminfo` from the browser. The milestone says read-only,
  and a button that opens a session is the point at which authentication stops being optional.
- **No terminal.** M6, and it is the reason `axum`'s WebSocket support is in §B1's stack list rather
  than in this plan.
- **No placement or `why`.** M5.
- **No session store.** Y-044 has receded three times now; a read-only dashboard is the strongest
  case yet for deriving rather than storing, since nothing it shows is worth surviving a restart.
- **No telemetry.** The dashboard shows what Tailscale and tmux already know. Whether a machine is
  *busy* needs `yantra-agent` and the telemetry ADR (Y-020), and that is M5's input, not M4's.
- **No Windows work.** Q4 stays open; nothing here touches it.

## 7. Forks that need the owner

### 7.1 Does the CLI start talking HTTP to the daemon?

The milestone says "the same HTTP API **the CLI uses**", and today the CLI does not use an HTTP API —
it calls `yantra-core` in-process. `crates/yantrad/CLAUDE.md` states the eventual architecture
plainly: *every client talks to this and nothing else.* So the wording is either a description of M4
or a description of the destination, and the two differ.

**(a) Two callers of one library.** The CLI keeps calling `yantra-core` in-process; `yantrad` becomes
a second caller. "The same API" means the daemon exposes exactly what the CLI can express and no
more, enforced by the honesty check in §5.3.

**(b) The CLI becomes an HTTP client.** One path to the fleet, matching the stated destination — and
`yantra up` stops working unless a daemon is running, which is a real regression for the tool that is
currently the whole product.

**Recommendation: (a), explicitly and in writing.** (b) is the right long-term shape and the wrong
thing to do in the milestone that first proves the daemon can serve a page; it would take the one
working interface and make it depend on the one that does not exist yet. It is also strictly harder
to reverse. This is ADR-sized either way, because the answer decides what `yantrad` is for — and if
it is (a), the ADR should say what would later justify (b), so the destination does not quietly
disappear.

### 7.2 What is the web UI built with?

`ADR-0004` settled TypeScript and said nothing further, correctly — there was no UI to have an
opinion about. Three honest options, and Q6 (personal-first) rules out the usual tiebreakers about
hiring and ecosystem:

- **No framework** — TypeScript, Vite, and the DOM. Four tables and a timer genuinely do not need
  more, it is the smallest thing that can work, and it has no upgrade treadmill. It gets less
  pleasant the moment M6 adds an interactive terminal and real state.
- **Svelte** — small output, little ceremony, compiles away. Least code for this shape of page.
- **React** — the one most likely to already be familiar, and the one with the most prior art for
  the terminal work in M6. Heaviest for four tables.

**No recommendation.** This one is about what the owner will still want to maintain in a year, which
is not a thing the plan can measure — and it is the kind of decision this project has already agreed
to make on maintainability rather than fashion. It should be an ADR, because M6 will build on it.

### 7.3 Should Q6 become an ADR?

Personal-first is currently recorded as a closed open question. It is doing more work than that
implies — it removes auth, settings, theming, multi-user and plugin surface from M4, and it will be
re-argued the first time one of them looks easy. `docs/adr/` is this repo's mechanism for *do not
re-litigate this*. Cheap to write, and §B0.2 already forbids quietly building around an ADR.

### 7.4 How does the dashboard get live status — poll or push?

Not an owner fork; recorded here because it looks like one. **Poll, and stop worrying about it.**
Polling an in-memory snapshot is a memory read; the expensive work already happens on the daemon's
own schedule (§5.2), so a push channel would optimise the one hop that is already free. `inventory.rs`
already notes that Tailscale's LocalAPI can stream and calls it "the upgrade path when M4 wants live
status" — that upgrade improves the daemon's own refresh, not the browser's, and it can land any time
without the API changing. SSE is the right answer when M6 has something genuinely live to send.

## 8. Suggested task rows

| ID | Task | Depends |
| --- | --- | --- |
| Y-069 | `yantrad serve` — axum, bound to the tailnet address, fails closed | §7.1 |
| Y-070 | The read model — background refresh, snapshot with an age, unreachable is data | Y-069 |
| Y-071 | The HTTP API + `yantra ls workspaces` to keep the CLI honest | Y-070 |
| Y-072 | The dashboard | Y-071, §7.2 |
| Y-073 | Asset serving: directory in dev, embedded at release, Node never required by `cargo build` | Y-072 |

Y-069 and Y-070 are the milestone's actual content. Y-071 is mechanical once Y-070 exists. Y-072 and
Y-073 cannot start before §7.2 is answered.

## 9. Risks this plan introduces

- **R-22 — the bind address is the whole security model.** With Q6 answered there is no auth, so a
  misconfigured listener is a public read API over the fleet's shape. Mitigated by taking the address
  from Tailscale and refusing to start without it, and by not shipping a flag that can override it.
  Worth a test that asserts the daemon refuses rather than one that asserts it binds.
- **R-23 — a cached dashboard tells confident lies.** Every failure mode of §5.2 looks like working
  software: a stale session list, a machine silently dropped, an empty page that means "not yet".
  Mitigated by the three rules in §5.2, each of which is a display requirement and not just a data
  one.
- **R-24 — the JS toolchain leaks into the Rust build.** Starts as convenience and ends with the
  musl cross-build needing npm. Mitigated by §1's guardrail and the default-off feature in §5.5.
