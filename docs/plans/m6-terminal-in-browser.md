# M6 — Terminal in browser

**Status:** planned 2026-08-04. The architecture was settled in advance by
[research note 02](../research/02-tmux-sessions.md) §3; this plan is what measuring the repo against
that note changed.

## 1. The acceptance test

M5 starts and stops sessions. It never lets you *see* one — the workspace row hands over
`yantra attach` as text to paste, which from a phone is worth nothing. M6 closes that:

> Open the dashboard, tap a workspace that has a live session, and the agent's terminal is there —
> live, scrolling, and typeable.

Concretely: Claude Code is running in a tmux session on `bishwajeets-macbook-pro`, and its TUI draws
in a browser tab on `cachyos-g14` with a working `^C`, a working cursor, and a pane that is the size
of the window it is drawn in.

## 2. What already exists, measured rather than assumed

M6 reads as `⬜ todo` in [`tracker.md`](../../tracker.md) §2, and the tracker is right that no line of
it is written. It is misleading about how far away it is. **The remote command a browser terminal has
to run is already assembled, already tested, and already correct**, in
[`crates/yantra-core/src/attach.rs`](../../crates/yantra-core/src/attach.rs):

```rust
pub fn remote_command(tmux: &str, session: &str, term: &str) -> String    // attach.rs:91
// TERM=xterm-ghostty /opt/homebrew/bin/tmux attach -t '=yantra'
```

Four things that each cost a task to get right are inside it: the machine (`ssh::machine_at`), the
tmux path resolved per-host (**I-34**), the session spelled so a login `zsh` cannot glob it
(**I-35**), and a `TERM` the far side actually has (**I-36**, **I-43**). `attach::plan` returns all
four, and `attach::ensure_session` already refuses a workspace with nothing to attach to — **it never
creates**, which is the property that keeps it from becoming a worse `up`.

**So M6 is not "build attach". It is "run the command `attach` already writes, under a PTY, over a
socket."** That is a smaller milestone than the roadmap implies, and the risk in it sits in two
places the repo has never been: a pseudo-terminal, and a WebSocket.

**Neither of which the existing seam can reach.** `Exec` is the trait every orchestration module is
written against, and it is one-shot by construction — [`ssh.rs:124`](../../crates/yantra-core/src/ssh.rs):

```rust
fn exec(&self, command: &str) -> impl Future<Output = Result<Output, Error>> + Send;
//  Output { status: i32, stdout: Vec<u8>, stderr: Vec<u8> }
```

No stdin, no streaming, no incremental output. Its implementation sets `RequestTTY=no` and
`Stdio::null()` for stdin, both with reasons written down: a forced pty would corrupt stdout with
CRLF and merge stderr into it, and ADR-0008 withdrew the stdin channel. **Those choices are right for
every caller that exists and are exactly wrong for this one.** M6 therefore adds a *third* ssh call
shape beside the library's non-interactive `Exec` and the CLI's `execve` hand-over — the first one
that is neither. It should still ride the same `ControlMaster` socket, which the 30-second refresh
loop keeps warm.

**I-34 is load-bearing here and is easy to under-read.** `tmux` is **not on the Mac's PATH over
ssh** — measured 2026-08-04: a non-interactive `ssh bishwajeets-macbook-pro tmux -V` answers
`command not found`, because `/opt/homebrew/bin` is absent from the PATH a non-login `zsh` gets.
`Tmux::resolve` is what makes `up` work there today, and any PTY that shells out to a hand-written
`ssh … tmux` string instead of reusing it will work on Linux and fail on the machine the acceptance
test names.

## 3. Constraints found before planning around them

### 3.1 The PTY layer is the one part of R2 that was never executed

R2 grades itself, and §3's recommendation carries a **[D]** — documentation only:

> *"The PTY layer is **[D]**-only here — nothing was run. Verify the controlling-terminal behaviour
> (I-18) before committing to (a); fallback is `ssh -tt` + plain pipes (loses proper TTY signalling)."*

The specific claim to verify is that a PTY must be created **with** the child rather than before it,
or `^C` does not work. Everything downstream — the socket, the browser, the resize — is worthless if
the terminal cannot be interrupted, and a browser terminal that cannot send `^C` to an agent is worse
than the paste it replaces. **This is the first task and it is a spike, not a feature**: §B3 says the
transport layer is proven against a real sshd and a real tmux in a disposable podman container, and
this is squarely transport.

> **Answered 2026-08-04 by Y-127**, in [`crates/yantra-core/tests/pty.rs`](../../crates/yantra-core/tests/pty.rs).
> `^C` written to the master kills the process in the remote pane, proved by the process being gone
> rather than by bytes on the screen. Three things the measurement changed. **I-18's rule stands and
> its reason does not**: a pty deliberately built *without* a controlling terminal still interrupts —
> the child here is `ssh`, so the `0x03` is a forwarded byte and the `SIGINT` is made by the far
> side's line discipline — and what the missing controlling terminal actually loses is `SIGWINCH`.
> **R2's fallback is misdescribed**: `ssh -tt` plus plain pipes interrupts perfectly well; what it
> loses is the *window*, reporting an `80x24` nobody chose. So the pty earns its place in Y-128 on
> **resize**, not on `^C`. And the negative control is sharper than expected: with no terminal at
> either end — `Exec`'s shape — tmux does not fail to be interrupted, it refuses to start
> (`open terminal failed: not a terminal`).

### 3.2 R2's mitigation for multi-viewer sizing is already the default, and is not a mitigation

R2 §3 names the one user-visible unknown and offers a fix:

> *"one PTY per viewer means two browser tabs = two tmux clients, so the smaller clamps pane size.
> Set `window-size latest` / `aggressive-resize`, accept it, or go to (c)."*

**Measured 2026-08-04 on tmux 3.7b, with a server started `-f /dev/null` and no user config: the
default `window-size` is already `latest`.** There is no `.tmux.conf` on `cachyos-g14`, and both
machines run 3.7b (the Mac's at `/opt/homebrew/bin/tmux`). So the suggested setting is what is
already in force, and R2's description of the failure is wrong in a way that matters: with `latest`
the window does not clamp to the **smallest** client, it follows the **most recent** one. **[V]** for
the default's value; **[D]** for what it then does with two live clients, because attaching two
sized clients without a terminal did not work in this probe and the honest grade is the one R2 used.

**And for once I-42's hazard does not apply.** That invariant exists because CI runs tmux **3.5a**
(Alpine, the fixture image) while both real machines run **3.7b**, and their format handling differs.
Checked in the fixture container on 2026-08-04: 3.5a also defaults to `window-size=latest` and
`aggressive-resize=off` — **identical to 3.7b**, so a test written about sizing means the same thing
in CI as on the fleet. Worth stating explicitly, because the default assumption in this repo has to
be that it does not.

The consequence is the same size of problem pointing the other way: **opening the dashboard terminal
on a phone resizes the desktop tmux client you are sitting in.** `latest` is not a setting that
avoids this; nothing does, short of `window-size manual` (fix the window and letterbox every client)
or R2's option (c), control mode, which is explicitly v2. **The plan does not pick one here** — it is
a decision with a visible cost either way, it belongs to the row that first attaches a second client,
and that row must measure it against a real browser rather than inherit R2's sentence.

> **2026-08-04 (Y-131): measured, and the choice this section declined to make turned out not to be one.** Two live
> clients on one window, both real, show that `latest` is the client used **last** — not the smallest, and not the
> newest attachment. A phone attaching does shrink the desktop, and the desktop's next keystroke takes it back with
> the phone still attached; the reflow reverses when a client leaves and no pane content is lost. The paragraph above
> is therefore right that nothing avoids the resize and wrong that it is a standing cost. `window-size manual` was
> measured and rejected — it also stops the only client resizing its own window — and control mode stays v2. **Yantra
> sets no tmux option**, and the behaviour is pinned by `crates/yantra-core/tests/two_clients.rs` and recorded as
> I-54.

### 3.3 A terminal is the largest write in the product, and its authoriser has a known hole

Every write route resolves its caller through
[`write.rs`](../../crates/yantrad/src/write.rs)'s `allowed()` — `whois` on the source address, refuse
a tagged node, refuse anyone who is not the owner ([ADR-0016](../adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)).
A WebSocket upgrade is a `GET`, so **it does not get that check for free**; the terminal route has to
ask for it explicitly, and it is the route that most needs it. `up` starts a process Yantra chose. A
terminal runs whatever the person on the other end types.

**[Y-118](../../tracker.md) is therefore a dependency of this milestone's payoff, not a neighbour of
it.** Behind `tailscale serve` the daemon sees the proxy's address, so `allowed()` authorises every
caller that reaches `:8443` — which is fine for `up` on the owner's own untagged node and is not fine
for a shell. And the two ways around it do not exist:

- Refusing forwarded callers ships a terminal that works only on `:7717`, over plain HTTP.
- The dashboard is served over HTTPS on `:8443`, and an HTTPS page **cannot open a `ws://`
  connection** — mixed content, blocked by every browser.

So the terminal cannot be reached through the proxy until Y-118 is decided, and cannot be reached
around it from the page that would host it. **Y-118 is `proposed` as [ADR-0017](../adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md)
and a proposal is not a decision — it is the owner's.** The layers beneath the route do not wait on
it, which is why §5 orders them the way it does.

> **Built 2026-08-04 by Y-129**, in [`crates/yantrad/src/terminal.rs`](../../crates/yantrad/src/terminal.rs),
> and this paragraph is what the route ships behind rather than what it works around. `allowed()` is
> called unchanged: on **7717** the route refuses a tagged node and anyone who is not the owner,
> proved over a real listener; through **8443** it authorises whoever runs the proxy, exactly as
> every write already does. Nothing reads `Tailscale-User-*` and nothing trusts `X-Forwarded-For` —
> the hole stays one hole, in one place, for Y-118 to close for every route at once.

### 3.4 Nothing in the tree can open a socket or a PTY yet

`axum` is pinned at 0.8.9 with `default-features = false, features = ["http1", "json", "tokio"]` —
**no `ws`**. `portable-pty` is named in [`CLAUDE.md`](../../CLAUDE.md) §B1's stack and, until Y-127,
appeared in no `Cargo.toml`; it is now a **dev-dependency of `yantra-core`** and nothing links it,
which is what let the spike answer §3.1 without deciding where the module lives. Both are additions
to a workspace that runs `just deny` on every change, so each lands with its licence and advisory
audit in the same PR that adds it.

> **Settled 2026-08-04 by Y-128**, in [`crates/yantra-core/src/pty.rs`](../../crates/yantra-core/src/pty.rs).
> `portable-pty` is a plain **dependency** of `yantra-core`, on the measurement rather than on the
> argument: `just appliance-size` puts `yantra-agent` at 441,264 bytes against 441,280 before — the
> binary R-12 guards came out *smaller* — while `yantrad` and `yantra`, neither of which calls the
> module yet, grew about 0.15 %. That is the crate's own note about the dependency edge holding a
> second time: the edge is nearly free, the **call graph** is where +319 KB lives. No cargo feature,
> because it would buy an amount invisible to `ls -lh` and cost a build combination CI never
> compiles. `tokio`'s `sync` feature came with it, for the bounded channel that carries output out of
> the reader thread, and measured free.

> **Landed 2026-08-04 by Y-129.** `ws` is on the workspace `axum` line, since `yantrad` is the only
> crate that names axum at all. It brings `tokio-tungstenite`, `tungstenite`, `sha1` and its digest
> stack, and a second `base64` — `just deny` passes, with three duplicate-version warnings added to
> the four already there (`base64`, `getrandom`, `r-efi`; `multiple-versions` is `warn`).

R2 is emphatic about the one to avoid: **do not plan on `node-pty`** — a native N-API addon, and the
whole reason the PTY sits on the daemon side. That is also **R-24** holding: no Rust build may
acquire a Node dependency, and a PTY in the browser-facing layer would be exactly that.

### 3.5 The dashboard has nowhere to put a terminal

Three things about `web/` that a terminal runs into immediately, none of them obstacles and all of
them work:

- **There is no router.** [`App.tsx`](../../web/src/App.tsx) is one `<main>` with five hardcoded
  sections and no `react-router`, no hash routing, no `pushState`. `yantrad`'s
  [`web.rs`](../../crates/yantrad/src/web.rs) *already* falls back to `index.html` for deep links, so
  the server is ready for `/workspaces/<name>/terminal` and the client would 404 into the same page.
  A sixth section or an overlay is the smaller move; a router is a decision this milestone should
  make on purpose rather than by needing one.
- **Five shadcn primitives are vendored** — `alert`, `badge`, `card`, `empty`, `table`. No `dialog`,
  `sheet`, `drawer` or `tabs`, so whatever holds the terminal arrives with it.
- **The service worker caches what it is served.** Y-114 deliberately never caches a *reading*; a
  socket endpoint must be as carefully excluded, and `sw.test.ts` is where that gets asserted.

One more, from the React Compiler: [`useLooked.ts:12`](../../web/src/useLooked.ts) documents a real
bail-out it had to be restructured around, and `npm run compiled` greps the bundle for the compiler's
own sentinel as a build gate. **A socket hook is the same shape of hazard** — an effect with a
cleanup, a ref, and a conditional — so expect to hit it and check the gate rather than assume.

> **Answered 2026-08-04 by Y-130**, and all three went the smaller way.
> **A sixth section**, drawn above the other five when a workspace name is set and by nothing else:
> a route would have to mean something on a reload, and reopening a socket on load is Y-132's. **The
> `Card` the other five sit in** holds it, so no primitive was vendored — `Section` takes a
> `Looked<T>` and a terminal is not a reading, so [`Terminal.tsx`](../../web/src/components/Terminal.tsx)
> composes `Card` directly. **The worker needed no change**: the socket is under `/api`, which Y-114's
> regex already excludes, and a handshake never reaches a `fetch` handler anyway — `sw.test.ts`
> asserts it because moving the route out from under `/api` would break it silently.
> **The compiler's bail-out was real and was not the socket**: it refused `EffectSetState`, so a
> different workspace is a remount rather than a reset. It compiled `Terminal.tsx` and the gate
> passed. The bill is the bundle — **256.61 kB → 592.73 kB**.

### 3.6 The terminal stream is the one place Q5 names by name

Q5 closed *reference-only, always*, and its wording is not incidental:

> *"Yantra resolves it at launch, hands it to the process, and never writes it to SQLite, logs, the
> API, **or a terminal stream**."*

A live terminal is a stream of whatever is on the screen, and the screen belongs to the owner, so
nothing here breaks that rule by existing. What it forecloses is **logging the stream**: R2 §7's
`pipe-pane` transcript and the "replay last N bytes on reconnect" buffer are both places a resolved
secret would land at rest. Replay is therefore in-memory and bounded, or it is not built.

### 3.7 `term()` currently answers a question the browser can answer properly

[`write.rs`](../../crates/yantrad/src/write.rs):

```rust
/// `up` and `resume` want the terminal the session should assume, and a browser
/// has none. `terminfo::FALLBACK` is the entry chosen precisely for far sides
/// that may know nothing better (I-36), and `Chosen` reports what was used.
```

That comment is true today and stops being true in this milestone: a browser running xterm.js **is**
a terminal, and a well-known one. M6 is the first caller that can send a real `TERM`, and
`terminfo::choose` already knows how to negotiate it against what the far side has (I-43). This is a
small thing that will look like an oversight later if it is not written down now.

> **Y-129 did not do it, on purpose.** The socket opens on `terminfo::FALLBACK` exactly as the three
> write verbs do, and its size message is two numbers with `deny_unknown_fields`, so a `term` sent
> today is refused rather than dropped. Y-130 adds the field on both sides in one change: the Rust
> test that names it, `web/src/api.ts`, and `just fixtures`.

> **Done 2026-08-04 by Y-130, and the answer is `xterm-256color` — which is `FALLBACK`'s own value,
> so what changed is provenance and not bytes.** The field is required, the daemon names no terminal
> of its own, and `choose` short-circuits on this value so the attach pays for no `infocmp` probe.
> The evidence is in the tracker row; the part worth repeating here is that the two entries that
> *look* better are both worse. ncurses ships `vscode|xterm.js`, and it is in the optional terminfo
> package, **absent from Apple's 2015 ncurses**, and stale enough to disable `initc` where xterm.js
> implements OSC 4. `xterm-direct` is absent from the same database and misrenders the 256-colour
> palette besides. I-36 is about a terminal the far side has, and the Mac is the machine it names.
> **I-36's other half still holds**: the client's `TERM` is not trusted as an input here either —
> what the browser sends is a constant in Yantra's own code, not something read from a user's
> environment. And `write.rs`'s comment is now true rather than deleted: `up` and `resume` open a
> session nobody is yet sitting at.

### 3.8 The CLI honesty check is already satisfied, which is worth showing rather than assuming

[`crates/yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md) holds a rule that would otherwise stop
Y-129 dead: *"Anything the web UI can do must be expressible in `yantra` first. That is what stops the
daemon growing a second, richer API that the CLI cannot reach."* It is why Y-126 built `yantra edit`
before the route, and why `up`/`down`/`resume` exist as verbs before they were buttons.

**A browser terminal clears it, and does so without adding a verb.** `yantra attach` is the CLI
expression of exactly this capability and already ships — it resolves the same plan and then
`execve`s ssh, handing the process over. M6 does not give the CLI a second way to do that; it gives
the *browser* the way the CLI already has. What the daemon gains is a transport, not a decision, and
[ADR-0005](../adr/0005-core-logic-in-a-library-crate.md) is why the PTY lands in `yantra-core` while
only the socket lands in `yantrad`.

## 4. What this milestone does not settle

- **Control mode (`tmux -CC`)** is R2's v2 streaming transport and stays v2. One connection per
  machine multiplexing N panes is the right end state and is not the shortest path to a working
  terminal.
- **Reboot survival and the reconciler** — R2 §4. That is a manifest and a reconcile loop, and
  Y-044 already established the daemon persists nothing.
- **zellij.** R2 §8's verdict — defer — is unchanged.
- **Writing to a session from the CLI.** `yantra attach` hands over the process and stays as it is;
  this milestone does not give the CLI a second way to do what `exec` already does well.

## 5. The tasks

| # | Task | Why it is where it is |
| --- | --- | --- |
| Y-127 | Prove the PTY: `^C` reaches a process through `ssh -tt` and tmux | 3.1 — R2's only **[D]** on the path it recommends, and the fallback branches here. A spike against a real sshd and tmux in a container; its output is an invariant and a decision, not a feature. |
| Y-128 | `pty.rs`: the attach command under a pseudo-terminal, with resize and close | The core half. Reuses `attach::plan` whole — §2 is the argument for not rewriting it — and adds the third ssh call shape, because `Exec` cannot carry one. Adds `portable-pty` (3.4). |
| Y-129 | `GET /api/workspaces/{name}/terminal` — the WebSocket, authorised | Adds axum's `ws` feature. Calls `allowed()` explicitly, because an upgrade is a `GET` and would otherwise be a read (3.3). **Refuses a forwarded caller until Y-118 is decided.** |
| Y-118 | Identity from the forwarded address | Not new, and not this milestone's to decide — but 3.3 makes it the gate on M6 being reachable from the phone at all. Owner's, `proposed` as ADR-0017. |
| Y-130 | xterm.js in the dashboard, on the workspace that has a session | The browser half, and where 3.5's three answers get chosen — overlay or route, which primitive holds it, what the service worker must not touch. First caller that can send a real `TERM` (3.7). `Command.tsx`'s `attach` paste is what it replaces. **Done**: a sixth section in the `Card` the others use, `xterm-256color`, and the paste is a button. |
| Y-131 | Resize forwarding, and what happens to the other client | 3.2 — the decision R2 could not make and this plan deliberately does not, measured against a real second client rather than inherited. |
| Y-132 | Reconnect without losing the screen | R2 names replay-last-N as Yantra's to build. In-memory and bounded, never at rest (3.6). |

**Y-127 through Y-128 depend on nothing and are the bulk of the risk.** Y-129 ships behind the
refusal in its own row; everything the owner has to decide is downstream of the work, which is the
order that keeps a blocked decision from blocking a night's building.

## 6. Not in scope

- **Multiple panes, windows, or a layout editor.** One session, one pane, one terminal.
- **A terminal for a machine rather than a workspace.** Yantra attaches to sessions it opened; a
  general SSH console is a different product and `tailscale ssh` already exists.
- **Scrollback search, copy-mode, or a file browser.** xterm.js gives scrollback; tmux gives
  copy-mode to anyone who types the prefix.
- **Anything that stores the stream.** 3.6.
