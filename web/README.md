# yantra web — the dashboard

Twelve routes over the API `yantrad` serves at `/api`, on TanStack Router — the
work at `/`, every workspace and machine at `/fleet`, the machines compared at
`/machines`, one machine at `/m/$machine`, one tmux session's terminal at
`/m/$machine/s/$session`, one workspace's chat, terminal, transcript and spend
at `/w/$name`, its file at `/w/$name/repair`, the four-step create at `/new`,
spend at `/usage`, the preferences at `/settings` and `/settings/$category`, and
the phone's notifications at `/notifications`. A thirteenth, `/m3`, is the
component gallery and has a chunk behind it in dev builds only.
`/` is the one eager route; every other screen arrives with its own chunk
(ADR-0024 §3). The readings poll on TanStack Query and every write is a
mutation in [`src/api/`](src/api/README.md).

`⌘K` opens the palette ([`shell/Palette.tsx`](src/shell/Palette.tsx)): six
pages, the workspaces that loaded, and the machines. **No entry is a verb**
(D3 §3.2), which is what keeps a destructive action further than two keystrokes
from anywhere.

**While a tab is visible the page says so**, and the daemon stops pushing what
the page is already showing (D3 §13). `useViewing` posts `/api/viewing` every
20 s. It is an explicit beacon rather than a read counted as presence: a
background tab still polls, and a poll is not a person watching.

**`/` opens on work, not on an inventory.** Four groups ordered by who must act
next — you, the agent, nobody, and *not read yet* for a workspace nothing has
answered about. The order recomputes only when you ask
([`held.ts`](src/screens/fleet/held.ts)), so nothing moves under a thumb.
[D3](../docs/design/03-dashboard-surface.md) settles the surface: what the page
is about, how dense it is, what words it uses and what every surface owes a
reader.
[ADR-0024](../docs/adr/0024-the-dashboard-is-material-3-built-by-hand.md)
settles what it is built with — hand-built Material 3 on Base UI, TanStack and
CSS custom properties — and
[R14](../docs/research/14-material-3-expressive-on-the-web.md) is the evidence.
[ADR-0014](../docs/adr/0014-react-with-the-compiler-for-the-web-ui.md) keeps its
framework, compiler, build and lint rows and nothing else.

[`design/`](design/README.md) is Y-330's options round for the visual system
(D0 §7): the same page on fixture data under candidate stylesheets. It is a
second Vite root and ships nothing. **Switching an option now changes nothing on
the page**: the four candidates set shadcn's variable names, which no Material
component reads. The owner has not closed Y-330.

Serving these assets from the binary is [Y-073](../tracker.md) and is not here.
Nothing in this directory is on the Rust build's path — `cargo build` still needs
no Node, including the musl cross-build (R-24).

## Running it

```sh
cargo run -p yantrad      # in the repo root, and leave it running
cd web && npm ci && npm run dev
```

Then open <http://localhost:5173>.

**Node `^22.18` or `>=24.11`**, as `package.json` declares. Babel 8 sets that floor, and
it is worth checking rather than assuming: this repo's own development machine
was on **24.0.0**, which is below it, so `npm ci` warns `EBADENGINE` there. CI runs
24.18.1. The build works either way; the warning is real and is not noise.

**The dev server must proxy.** `yantrad` runs axum with no `tower-http`, so there
are no CORS headers and a cross-origin `fetch` cannot work. `vite.config.ts`
proxies `/api` to the daemon.

**Seeing it from another device on the tailnet.** `npm run dev:tailnet` binds the dev server
to this machine's Tailscale address, so a Mac or a phone opens
`http://<this machine>.<tailnet>.ts.net:5173` (the MagicDNS name is allowed in `vite.config.ts`).
With no `yantrad` running, `npm run fixture` starts the e2e fixture daemon on 7790 with the
`busy` scenario (`FIXTURE_SCENARIO=` picks any of the ten below), and
`npm run dev:fixture` proxies `/api` to it instead, so every screen draws with fleet data. Plain
HTTP: the service worker and the PWA install need HTTPS and are for the daemon's own build.

**The proxy target is a tailnet address, not loopback.** `yantrad` binds only the
addresses Tailscale says this machine holds and fails closed otherwise, so
`127.0.0.1:7717` is refused by design (R-22). `npm run dev` fills the target in
from `tailscale ip -4`; override it with `YANTRA_API=http://<host>:7717 npx vite`
if the daemon is on another machine.

## Commands

| | |
| --- | --- |
| `npm run dev` | dev server on :5173, proxying `/api` |
| `npm run build` | `tsc -b`, then Vite, then the compiler check below |
| `npm run lint` | oxlint, with `react/react-compiler` on |
| `npm test` | vitest |
| `npm run e2e` | Playwright, on all three form factors |
| `npm run budget` | builds, then measures the two ceilings below |
| `npm run fixture` | the e2e fixture daemon on 7790, with no browser |

## Proving the React Compiler ran

A bail-out is silent: `panicThreshold` defaults to `"none"`, so a component the
compiler declined still builds, exits 0, and is emitted byte-identical to an
unoptimised one. An oxlint error does **not** imply a bail-out, and — measured
here — a bail-out does not imply an oxlint error either. So there are two checks,
and neither is optional:

- **`vite.config.ts` passes a `logger`** to `reactCompilerPreset`, which warns on
  every event that is not `CompileSuccess` and names the file and the reason.
- **`npm run compiled`** greps the bundle for `react.memo_cache_sentinel`, which
  only the compiler emits. `npm run build` runs it.

**An `AssignmentPattern` in a destructured default bails out wherever it is
written.** That is what the vendored primitives used to trip on, and deleting
them did not end it: `Terminal`'s `height` still defaults at the use site rather
than in the signature (Y-313), measured both ways.

**A component the compiler kept can still stop redrawing.** Memoised JSX is
reused where its props did not move, and a clock that only bumped a counter
therefore ticked while the stamp beside it stayed at `0s` — measured on `/usage`.
So [`useTick`](src/useTick.ts) returns the instant it last ticked and every
component that stamps takes that instant as a prop: the clock is a value the
compiler can see change, not a re-render it cannot.

**A chunk reporting `0` is not a bail-out.** `npm run compiled` counts the
sentinel per chunk, and the constant is emitted once and hoisted, so a lazily
split chunk can hold compiled components and still count zero — measured on the
pre-M14 overflow menu (Y-167), whose compiled memo-cache indexing was in the
chunk while the sentinel was not. The per-file check is the `logger`, and it is
the one to read.

## What a machine's state says

[`facts.ts`](src/screens/machines/facts.ts)'s `machineState()` names three
things and no more: **key expired** where Tailscale says the key is, otherwise
**online** or **unreachable**. The beat is drawn beside it as an age — a machine
card says `beat 12s ago` or `no beat has arrived`, and the machine page says
`never` with *nothing has ever arrived from this machine*. `heartbeat: null` is
never a row of zeros (I-47).

**ADR-0013 §7's four states are no longer named by any screen.** The pre-M14
table computed *ready*, *up, but not reporting*, *asleep or off* and *never heard
from* from a 30 s threshold; the M14 screens put the tailnet's own word and the
beat's own age side by side and let the reader combine them. Most of this tailnet
is a phone, a tablet and two dead laptops, so *no beat has arrived* is the
permanent and correct line on most cards.

## The one verb a row computes

A row offers one verb rather than three, so the reader works nothing out.
`chosen()` in [`verbs.ts`](src/screens/fleet/verbs.ts) reads the agent status and
[`Verb.tsx`](src/screens/fleet/Verb.tsx) draws what it names — `Start`, `Resume`,
`Open`, an answer to a trust prompt, or a link to the machine.
[D1](../docs/design/01-dashboard.md) §2 is the specification.

Two of the readings are the ones worth knowing about. **A row that has read
nothing gets no verb**: `Start` there would be a guess drawn as knowledge, so
`chosen()` answers `wait` (R-23) — and that is the state every row spends its
first seconds in. **`Fix` is a link, not a verb**: a machine that did not answer
ssh cannot be repaired from a workspace row, so the row hands over to
`/m/{machine}` rather than offering something that could only fail.

`stoppable()` is what adds **Stop** beside **Open** on a running agent's session
and not on a plain shell. `confirms()` is D3 §4.7 in one line: only Kill and
Delete ask first, and [`Confirm.tsx`](src/screens/fleet/Confirm.tsx) asks them in
a dialog on a desktop or a tablet and a bottom sheet on a phone, repeating the
row word for word under the question.

## The doctor checks

`GET /api/readiness` and `GET /api/machines/{name}/readiness` serve
[D2](../docs/design/02-setup.md) §3.1's checks off the daemon's own sweep, so the
page draws them rather than running anything. A machine card draws four of them
(`CARD_CHECKS`) and the machine page draws all nine. Three states, three marks,
and `unknown` is never a shade of `absent` — one sends you to install something,
the other to go and look (R-23).

**`Doctor` asks again now, and is a button rather than a timer.** `POST
…/readiness` is a full ssh round trip ([ADR-0019](../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md)),
and its answer lands in the same query key the sweep fills, which is why
[`Doctor.tsx`](src/screens/machines/Doctor.tsx) holds no result of its own.

## A workspace file that did not load (Y-141)

`GET /api/workspaces` lists one entry per **file**, and each says whether it
loaded: `api.ts`'s `Listed` is `{loaded: 'yes'} & Workspace` or `{loaded: 'no',
name, error}`. Before this one broken `.toml` made the whole class
`looked: 'failed'` and the page drew nothing at all — for every workspace the
operator has.

**The failure is a row of its own kind, never a row that offers verbs.** A file
that did not load has no machine to read a state from and nothing for a verb to
target, so `work.ts` files it as `unusable` and the Dashboard and Fleet screens
draw its whole reason with one link, to
[`/w/{name}/repair`](src/screens/repair/Repair.tsx), where the file itself is
edited ([ADR-0020](../docs/adr/0020-a-raw-write-only-from-broken-to-valid.md)).
R-23 is met by naming the file loudly rather than by hiding it.

`loaded()` in [`api/hooks.ts`](src/api/hooks.ts) is the one narrowing:
everything that acts on a workspace takes the entries that loaded, so **no
per-workspace status is ever fetched for a file that is not one**.

## The verbs, and the writes behind them

[`mutations.ts`](src/api/mutations.ts) is every write: create, edit, delete, up,
down, resume, kill, and the settings writes. Each one invalidates what it changed
**and returns that refetch**, so `isPending` holds until the page can draw the
answer rather than the row it replaced.

- **There is no machine argument on a verb, and adding one would be a bug.** The
  target is `workspace.machine`, chosen when the workspace was written. A
  transient override would place a session where `down`, `resume`, `status` and
  `logs` all look elsewhere and report the absence as success —
  [Y-117](../tracker.md).
- **An asleep machine is not refused here.** The daemon decides; the page shows
  the machine's state and leaves the button live (R-23, ADR-0009). There is no
  wake button, because waking is not possible from here (Q10, Y-115).
- **`launched: false` is a success, not a failure.** `up` twice attaches (§B4,
  I-30). It reports an *agent*, and a workspace's own `startup` is not one.
- **`up` sends `{"agent":"claude"}` only where `startup` is null**, because
  ADR-0007 refuses an agent beside a workspace's own startup. **Resume is not
  offered** to such a workspace at all, for ADR-0015's reason.
- **`killed: false` is a session that was already gone**, which is the state that
  was asked for (I-30).
- **A delete's `force` skips the daemon's refusal to strand a live session**, so
  a surface sends it only where a person meant it. What was held about the name
  goes with it, or a mounted status would keep polling a workspace that is gone.
- **Every refusal keeps the daemon's own sentence.** The status table and the
  five error kinds live in [`src/api/README.md`](src/api/README.md) and
  [`errors.ts`](src/api/errors.ts); nothing invents wording for a sentence
  [`edit.rs`](../crates/yantra-core/src/edit.rs) or `write.rs` already writes.
- **A refusal is drawn as a refusal rather than as a crash.** A `409` is an agent
  holding at claude's trust dialog (I-49) or one that is not logged in (I-44) — a
  state the daemon named correctly, which a person changes at the machine itself.
- **Nothing may read as done while it is in flight.** These handlers `await` ssh
  and `ConnectTimeout` is 10 s, so the tapped control names what it is doing and
  is disabled while it does.

**There is nowhere to type a secret**, and that is what keeps root §B4 here: a
workspace has three keys and none of them is one. `startup` is a shell command,
so a secret in it stays a reference (`op://…`, `pass show …`) the shell resolves.
No check is made over that string — a heuristic over an arbitrary command either
misses the real case or refuses a legitimate one.

**A form renders the answer it got and never re-reads to confirm.** `refresh.rs`
sweeps every 30 s and a write does not poke it, so a form that confirmed by
re-reading would draw the row it just replaced — or an empty list after a
success. The edit form diffs what was typed against what it opened from and sends
only what differs, because absent means *leave it alone*; emptying `startup`
sends `"startup": null`, which is `--no-startup` and the only `null` that means
anything on that route.

## The terminal

[`Terminal.tsx`](src/screens/session/Terminal.tsx) is xterm.js on the socket
[`api/socket.ts`](src/api/socket.ts) opens. Four decisions, each of which could
reasonably have gone the other way:

- **A view of `/w/{name}`, not an overlay.** The URL promises a socket reopened
  on load, and an overlay would be the first thing here that traps focus, over a
  screen a phone gives the whole of anyway.
- **`TERM` is `xterm-256color`**, sent in the first control frame and on every
  resize. It is what every xterm.js consumer sends and the one entry both
  `ncurses-base` and Apple's 2015 ncurses carry; ncurses' own `xterm.js` alias and
  `xterm-direct` are in neither, and I-36 says an entry the far side lacks is an
  attach that aborts. This is not the client's `TERM` in I-36's sense — it is a
  constant in this code, not something read from a user's environment.
- **The stream is never stored.** No frame reaches `console`, nothing is persisted,
  and the scrollback is xterm.js's own, in the element, gone with it (Q5).
- **Text frames from the daemon are errors, not output.** Writing one to the
  screen would make it indistinguishable from something the session printed, so it
  becomes an `ApiError` of kind `socket` and is drawn beside the terminal. A close
  with nothing said is not an error at all, and is what reconnect turns on.

## The transcript (Y-309, Y-310)

[`Transcript.tsx`](src/screens/session/Transcript.tsx) draws `POST
/api/workspaces/{name}/logs` — what the agent said, as turns of `you` and
`claude` with the tool calls between them.
[D5](../docs/design/05-workspace-page.md) §4 settles it; four things about the
code are not obvious from it:

- **The state lives in `useTranscript`, which the page holds and the view calls.**
  Only the open view is mounted, so a component holding its own answer would
  re-read on every return from the terminal — and a read is an ssh.
- **Text is rendered as text.** No Markdown parser, so a bulleted plan reads as
  asterisks. That is D5 §4.1's decision and its cost: a parser inside a held
  budget, an XSS surface on text a machine wrote, and a highlighter after it.
- **`Older` asks for what is left.** Windows are `tail -n {lines + before} | head
  -n {lines}`, so past the start of the file `tail` stops skipping and a full
  window would repeat what is drawn. The last one asks for `total - asked`.
- **A grown `total` is refused, not stitched.** The window is counted from the
  end of a file a running agent appends to, so a second read of a longer file
  does not line up with the first. `merge()` sets `moved`, the page says the
  conversation moved on, and `Refresh` is the way back (D5 §4.4).

## A terminal on any session (Y-179)

`Terminal.tsx` takes a `Target`, which is the daemon's own enum in TypeScript: a
workspace, or a machine and a session
([ADR-0022](../docs/adr/0022-a-socket-may-address-a-session-rather-than-a-workspace.md)).
`terminalAddress()` picks the URL and the label a refusal says — `scratch on pi`,
never a workspace — and nothing else in the file knows which address it is on.
**There is no second terminal**, which is what D6 §6.2 refuses.

Three decisions:

- **The verb on an unclaimed session is a link, not a button.** D6 §4.3 asks for
  a link, and `/m/{machine}/s/{session}` gets middle-click and copy-link for free
  (D5 §3.2). It carries the accessible name Y-320 gave it, `Terminal for
  {session} on {machine}`, because the address is a machine and a session and a
  typo lands in a live shell.
- **The route is split.** `/machines` would otherwise put xterm.js on the first
  load of a page that attaches to nothing.
- **Nothing is read before the socket.** `/w/{name}` reads the workspace list
  first, because a workspace the daemon never heard of is a typo worth catching
  without an ssh. A session is known only to its machine, so this attaches and
  lets the daemon refuse a name that is not there (ADR-0022 §5).

## The spend view

`/w/$name?view=spend` is `/usage`'s answer with the picker removed
([D5](../docs/design/05-workspace-page.md) §6.1): the workspace is the URL, so
there is nothing to pick. [`Spend.tsx`](src/screens/session/Spend.tsx) draws it,
`useSpend` holds the answer in the page for the transcript's reason, and mounting
the view is the request.

**Any unpriced model makes the headline a token count, with no dollar line.**
That is D5 §6.2, and it holds on `/usage` too. The daemon does not help here: it
sums the models the price table carries and nulls only the rest, so a
partly-priced session arrives with a figure that is short of what it spent.
Drawing it under *this session* is the understatement R-23 refuses per model.
**The per-model figures stay** — one model's cost understates nothing. See the
2026-09-04 amendments in D5 §6.2 and
[D6](../docs/design/06-sessions-attention-spend.md) §5.2.

## A machine that cannot be reached (Y-312)

**Each view draws its own refusal and there is no page-level banner** (D5 §7).
Only the open view is mounted, so a reader sees one at a time — and each one
names the machine, so the first one already says where the fault is. A banner
would say it once instead of three times and would erase a figure the reader had
read.

**The machine's name is a link wherever it appears**, in the page's own line and
inside every refusal: an unreachable machine is still one you can go and look at,
and `/m/{machine}` has its beat.

## Reconnect (Y-132)

**A socket that went away with nothing to say is reopened, and nothing here replays
anything.** tmux draws the pane's current contents for whichever client attaches
next — measured against a real tmux in `crates/yantra-core/tests/pty.rs`, alternate
screen included — so a second socket is a second attach and the screen arrives from
the far side. A buffer of the last N bytes would have been a second, worse copy of
what tmux already holds, and Q5 names a terminal stream in the sentence that closed
it.

Three rules, and the second is why this is not a loop:

- **A close with a reason is not retried.** Text from the daemon means the terminal
  could not be opened — no session, an asleep machine — and reopening a refused
  socket refuses again.
- **`ATTEMPTS` and `PAUSE` are the cap, and it is a cap on attempts rather than on
  anything kept.** Five reopens half a second apart: a phone waking or a network
  changing hands costs one of them and is invisible, and every attempt beyond that
  is an `ssh` connection and a tmux client on a machine that may be asleep. The
  budget refills on any frame received, so it bounds an outage rather than a
  terminal's life.
- **Unmounting means it.** Closing the terminal clears the pending reopen before it
  closes the socket, or `cleanup()` in one test reconnects into the next one's
  server.

What this cannot see: whether a phone's `close` event fires at all when the screen
wakes. If a socket dies without either end noticing, nothing here reopens and
nothing here would know — but **the daemon now notices** (Y-134). It pings every
20 s and ends a socket that misses two in a row, so the `ssh`, the pty and the
tmux client behind an abandoned terminal are released without anything on this
side having to detect the loss. The browser answers those pings itself, below
`WebSocket`, so nothing in `Terminal.tsx` participates.

**`ws: true` on the dev proxy is load-bearing.** The string form of a Vite proxy
entry forwards plain requests only, so without it the terminal in `npm run dev`
connects to nothing.

Two things [`Terminal.test.tsx`](src/screens/session/Terminal.test.tsx) and its
harness record because they cost an hour each. **jsdom's own `WebSocket` cannot
connect under vitest** — jsdom builds it on undici's, undici constructs the
global `Event`, and the jsdom environment has replaced that class, so the
handshake dies in `dispatchEvent` saying *"must be an instance of Event. Received
an instance of Event"* and the socket times out. The `ws` client is stubbed in
for it: a second real implementation talking to a real server, not a stand-in for
the socket under test. And **xterm.js wants the legacy
`MediaQueryList.addListener`**, which a bare `matchMedia` stub does not have.

What that suite cannot reach: `FitAddon.proposeDimensions()` answers `undefined`
where nothing has a width, so the sizes asserted in CI are xterm's own 80x24 and
the arithmetic needs a browser. Nor has any of this met a real daemon — the server
it talks to speaks the protocol and knows nothing of a pty.

## Three form factors

[`formFactor.ts`](src/shell/formFactor.ts) is Material's window size classes at
the brief's three widths: **phone** under 600 px, **tablet** to 1239 px,
**desktop** from 1240 px. Two media queries through `useSyncExternalStore`, which
is why narrowing a window changes the shape without a reload.

**The shell reads it once and the router never does** (ADR-0024, consequences).
`Shell.tsx` has three shells — a header bar of pills beside a sessions rail on a
desktop, a navigation rail on a tablet, a top app bar over a bottom navigation
bar on a phone — and each screen lays itself out below that. A component that needs
the width asks for it: the confirm is a dialog above 600 px and a bottom sheet
below it, and the bell opens a popover, a side sheet or the `/notifications`
route.

**jsdom implements no `matchMedia` at all** — not a stub returning false, nothing
— so every unit harness that mounts the shell or a component reading the width
supplies one that evaluates the query really asked. The breakpoints stay
`formFactor.ts`'s to choose.

## Installable on a phone (Y-114)

`public/manifest.webmanifest` plus `public/sw.js`, registered from `main.tsx` on
production builds only. It needs HTTPS — a service worker will not register
outside a secure context — which is `just https` in the repo root.

**The one rule: the worker never caches a reading.** `/api`, `/healthz` and
`/heartbeat` are not intercepted at all, so the browser makes those requests
itself and a daemon that cannot be reached becomes a `failed` envelope, exactly
as it does with no worker installed. Offline reads as offline. A cached reading
would be R-23's confident lie with a longer memory, and
`src/sw.test.ts` runs the shipped `sw.js` against a fake `caches` to prove it —
including that a reading planted in the cache by hand is still not served.

**The terminal socket is covered by that same exclusion and is asserted anyway.**
It is under `/api`, and a WebSocket handshake never reaches a `fetch` handler in
the first place, so nothing had to change when the terminal arrived. What the
test pins is the route's *address*: moving it out from under `/api` would put a
terminal in the cache silently.

The shell is **network first**, one path for navigations and assets alike, so a
cached response only ever means the network was not there. Navigations share the
key `/`, because `yantrad`'s SPA fallback answers every one of them with
`index.html`; that is what makes a deep link work offline. `install` fetches `/`
and the root-relative `src`/`href` it names, so the first launch from a home
screen can be the first launch offline. Fonts are reached from CSS rather than
from the HTML, so they arrive on first use and their absence costs a typeface,
not a reading.

**No `vite-plugin-pwa`.** The only thing it adds over 45 lines is a build-time
precache manifest of Vite's hashed filenames, which `install` reads out of
`index.html` for four lines — and against that it brings a Workbox runtime, a
config to audit, and defaults that cache far more than the shell.

**No colour in the manifest.** `theme_color` and `background_color` take a
literal, and the tokens are where colour is decided; neither is required for
installability, so neither is here.

Icons are the existing `favicon.svg` rasterised onto white — opaque because iOS
composites a transparent home-screen icon onto black — with `librsvg` and
ImageMagick:

```sh
rsvg-convert -h 348 -o /tmp/glyph.png public/favicon.svg
magick /tmp/glyph.png -background white -gravity center -extent 512x512 \
  -alpha remove -alpha off public/icon-512.png
magick public/icon-512.png -resize 192x192 public/icon-192.png
magick public/icon-512.png -resize 180x180 public/apple-touch-icon.png
```

`apple-touch-icon.png` is a separate file because Safari takes the home-screen
icon from the `<link>` and not from the manifest.

## Where `api.ts` is checked against the daemon (Y-124)

A unit test stubs `fetch` and returns a literal typed to match `api.ts`, so the
two sides of the wire were kept in step by convention: renaming a field in
`crates/yantrad/src/api.rs` left both suites green and the page blank.
`src/contract.gen.ts` is the answer — the daemon's own routes rendered into
TypeScript that `satisfies` the types above, written by a Rust test and
regenerated with `just fixtures` in the repo root.

**Never edit it, and do not import it from `src/`.** `tsc` type-checks every file
under `src/`, which is the whole of how it runs; `npm run build` and the CI
type-check step are where a mismatch surfaces. A DTO that moved without the file
being regenerated fails on the Rust side first, saying so. The one thing that
does import it is [`e2e/fixture/server.mjs`](e2e/fixture/server.mjs), which
answers the browser from it.

It does not cover status codes, headers or the refusal bodies — those are plain
text, and `errors.ts` maps them by hand.

## The tokens

[`m3/tokens.css`](src/m3/tokens.css) is the seam ADR-0024 §2 names. It declares
every `--md-sys-color-*`, `--md-sys-shape-*`, `--md-sys-typescale-*` and
`--md-sys-motion-*` role, and the three faces.

- **Sage light and dark are precomputed and shipped as CSS.** One declaration
  carries both through `light-dark()`, so there is no second block to keep in
  step. The theme is the root's `color-scheme`: unset follows the OS, and
  `data-theme` pins it in either direction.
- **`index.html` reads `localStorage` before the first paint**, under
  [`shell/prefs.ts`](src/shell/prefs.ts)'s key and version, so the theme and the
  density land with the first frame rather than one after it. Keep the inline
  script and `prefs.ts` in step: preferences are browser-local and the daemon
  persists none of them (ADR-0024 §5).
- **The colour engine is not on this path.** `m3/theme/scheme.ts` loads only for
  a seed other than sage, and on Appearance; the first load carries no scheme
  code. `scheme.test.ts` names the six roles where the fitted scheme and
  `palette-sage.json` disagree, and by how much (ADR-0024's 2026-09-06
  amendment).
- **Call sites pass a role, never a colour.** State is a mark plus a word
  ([`m3/mark/`](src/m3/mark/Mark.tsx)), never colour alone (D3 §6).

**Tailwind v4 stays, and now emits only its preflight reset.** `index.css` is
`@import "tailwindcss" source(none)` with no `@source`, because no call site
writes a utility: each M3 component ships a BEM class and its own stylesheet. The
scan was reading English words out of the `.tsx` files and buying `.container`,
`.hidden`, `.collapse` and fourteen more that nothing drew. Add a `@source` back
the day a call site writes a utility.

[`src/index.css`](src/index.css) is three statements: that import, the token
import, and the page under them.

## What it weighs

**145 KiB for the first load of `/`, and 80 KiB of fonts** — D3 §9.1 and
ADR-0024 §7, measured by [`scripts/budget.mjs`](scripts/budget.mjs) over
`dist/index.html`'s own entry, preloads and stylesheets at gzip -9.

**As of 2026-09-07 it is not green.** `/` is **147.6 KiB** and the fonts are
**78.5 KiB**, so the fonts hold and the first load misses by 2.6 KiB. `web.yml`
runs the budget with `continue-on-error: true` until it does hold. Deleting the
pre-M14 stylesheet took `/` from 159.1 KiB to 146.7 (Y-353), the unreachable
screen took it to 147.3 (Y-358) and the shell's live region to 147.6 (Y-352);
what is left is react-dom, TanStack Router, TanStack Query, Base UI, the shell
and the dashboard screen — there is no single thing to remove.

**The build is not the wire.** `yantrad` serves `dist` through `ServeDir` with
neither `precompressed_gzip` nor a `CompressionLayer`, so a phone downloads the
raw bytes. Y-357 is that row; until it lands, the number above is the build.

The plan's bundle rules are what hold the line: no barrel files, every route
lazy except `/`, and Form, Table, Virtual, xterm and the colour engine never in
the `/` chunk ([the plan](../docs/plans/m14-the-material-dashboard.md) §3).

## Testing

**Vitest covers the units and the components.** A test file sits beside almost
every module under `src/`: each M3 component's own `.test.tsx`, the api layer (`client`, `errors`,
`hooks`, `mutations`, `socket`, the boundary), each screen's logic and its
render, the shell, the tokens, the colour scheme, `sw.test.ts` and
`router.test.tsx`. jsdom, and the harnesses live in
[`src/test/`](src/test/): `daemon.ts` stubs `fetch` the way `yantrad` answers,
`inQuery`, `inRouter` and `inApp` supply the context a hook or a `<Link>` needs.

**Playwright covers the screens, in a browser** ([ADR-0024](../docs/adr/0024-the-dashboard-is-material-3-built-by-hand.md) §6).
[`e2e/`](e2e/) runs three projects over every spec — **phone 390×844, tablet
834×1194, desktop 1440×1024** ([`lib/sizes.ts`](e2e/lib/sizes.ts)) — against
`vite preview` over a real build rather than the dev server. `lib/axe.ts` runs
axe with `wcag2a wcag2aa wcag21a wcag21aa wcag22aa` and fails on any violation
outside a spec's `known` list, and fails again the day a known one is fixed
without the list being edited. **It waits for every CSS transition to end
first**: a surface caught part-way through its fade composites the colour axe
measures, and the reading belongs to no frame a reader sees (Y-363).
`lib/screenshot.ts` writes one file per screen, scenario and size.

**The fixture daemon is Node, not `yantrad`.**
[`e2e/fixture/server.mjs`](e2e/fixture/server.mjs) answers every `/api` route the
dashboard calls from `src/contract.gen.ts`, plus both terminal sockets, under one
of ten scenarios — `busy`, `empty`, `unreachable`, `nogrant`, `refused`, `flaky`,
`contract`, `broken`, `repair`, `firstrun`. A test picks one with a cookie
carrying its own key, so a write in one worker is not a row in another, and
`page.clock` pins the instant so an age reads the same on every run.

**The screenshot baselines are rendered in
`mcr.microsoft.com/playwright:v1.63.0-noble`** — the image CI's e2e jobs run in —
so a developer's own fonts never enter one. Regenerate them the same way, run
from `web/`:

```sh
podman run --rm -v "$PWD/..:/work" \
  -v "$(readlink -f node_modules):$(readlink -f node_modules)" \
  -w /work/web mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test --update-snapshots
```

The second mount matters in a git worktree, where `node_modules` is a symlink
to the main checkout's. The container has no mount for the symlink's target,
so it cannot resolve it — and `npx` does not fail loudly. It silently installs
its own copy of Playwright, then dies with a misleading `Cannot find package
'@playwright/test'`, which names the config file rather than the missing
mount. The second mount makes the symlink resolve, and it is a harmless
no-op in the main checkout, where `node_modules` already resolves to itself.

[`.github/workflows/web.yml`](../.github/workflows/web.yml) runs lint, both
type-checks, the build, `npm test` and the budget in one job, and the e2e suite
in three more — one per form factor, in that image.

## Layout

```
public/
  sw.js              the service worker; caches the shell and never a reading
  manifest.webmanifest
  favicon.svg  icon-192.png  icon-512.png  apple-touch-icon.png
src/
  api.ts             the wire shapes, read and written; every state is a tag
  contract.gen.ts    yantrad's own answers, `satisfies` those shapes. Generated
  router.ts          TanStack Router: twelve routes and a dev-only gallery, one
                     of them eager, each with a loader that warms its reads
  work.ts            D3 §4's bands — who must act next, and the fourth state
                     that is nobody having read yet
  views.ts           the four views of `/w/{name}`. Its own module so `router.ts`
                     validates `?view=` without pulling xterm.js into `/`
  useTick.ts         the one-second clock. It returns the instant rather than
                     re-rendering, which is the compiler note above
  index.css          three statements: Tailwind's reset, the tokens, the page
  lib/               `name`, `path`, `spend`, `time` — the formatting every
                     screen shares, so an age or a figure reads the same twice
  api/
    keys.ts          every query key, hierarchical, from one factory
    queries.ts       one `queryOptions` per read, so a route can preload it
    mutations.ts     one `useMutation` per write, invalidating by key
    hooks.ts         what a screen calls, and the `Looked<T>` it hands back
    client.ts        `fetchJson`, the envelope, the `QueryClient` defaults
    errors.ts        `ApiError` and its five kinds — the only rejection here
    socket.ts        the two terminal sockets, `TERM`, and the reopen budget
    types/           the daemon shapes that are not on the swept routes
    README.md        the error table, and what each file owns
  m3/
    tokens.css       every Material role, sage light and dark. The seam
    <one per        `Button.tsx`, `Button.css`, `Button.test.tsx`, and Base UI
     component>      underneath wherever it has the behaviour
    theme/           the colour engine, loaded only for a seed that is not sage
    gallery/         every component on one page, for the reviewer and
                     Playwright. Dev builds only
  shell/
    Shell.tsx        the three shells, and the outlet under one boundary that a
                     navigation resets
    Palette.tsx      the search pill and `⌘K`; the popup is its own chunk
    Bell.tsx  BellPopover.tsx  NotificationsSheet.tsx  NotificationsScreen.tsx
                     one set of notifications, at three widths
    formFactor.ts    phone / tablet / desktop, from two media queries
    prefs.ts         `localStorage` under one versioned key (ADR-0024 §5)
  screens/
    dashboard/       `/` — the bands, the status strip, and the first run
    fleet/           `/fleet` — every workspace and machine, the one computed
                     verb (`verbs.ts`), and the Kill and Delete confirms
    machines/        `/machines` — a card per machine, its checks, and Doctor
    machine/         `/m/$machine`
    session/         `/w/$name` — chat, terminal, transcript, spend
    session-terminal/`/m/$machine/s/$session` — the same terminal on a session
                     no workspace claims (ADR-0022)
    repair/          `/w/$name/repair` — the file itself (ADR-0020)
    new-session/     `/new` — four steps on one TanStack Form
    settings/        `/settings` and `/settings/$category`
    usage/           `/usage`
    setup/           the first run, drawn inside `/` while there is no fleet
  test/              the unit harnesses: `daemon.ts`, `inQuery`, `inRouter`,
                     `inApp`, and the vitest setup
e2e/
  lib/               sizes, scenario, axe, screenshot, keyboard, routes
  fixture/           the Node daemon and its ten scenarios
  __screenshots__/   one baseline per screen, scenario and size
design/              Y-330's options round. A second Vite root; ships nothing
```

## The router (Y-161, Y-162)

**[TanStack Router](https://tanstack.com/router)**, code-based routes in
`src/router.ts`. Y-161 hand-rolled one over the History API; the owner ruled on
2026-08-09 that `web/` takes battle-tested packages and writes its own only where
a package is not worth it — [CLAUDE.md](../CLAUDE.md) §B1.

- **The history is a parameter, and so is the query client.** `getRouter(history,
  client)` is [T3 Code](https://github.com/pingdotgg/t3code)'s shape, copied: the
  entry point passes a browser history and a test passes a memory one, with no
  branch inside.
- **One route is eager and the rest are `lazyRouteComponent`.** xterm.js, the
  stepper's form, the tables and the virtualiser are each a third of somebody's
  chunk and none of them is `/`'s.
- **A loader warms its screen's reads and is never awaited.** `prefetchQuery`
  rather than `ensureQueryData`, so a warm read is cancelled when the last
  observer leaves, and `defaultPreload: 'intent'` starts it on a hover. The
  screen draws its own skeleton meanwhile; awaiting would hold the whole page.
- **Query holds the cache, so `defaultPreloadStaleTime` is 0.** The router's own
  copy of a loader result could only ever be stale.
- **Params are typed.** `<Link to="/m/$machine" params={{ machine }}>` fails to
  compile on a typo, which the string builders in Y-161 could not do.
- **Search params are validated where they exist.** `?view=` on `/w/$name` and
  `?step=` on `/new` are narrowed to their unions, and an unknown value is no
  view rather than a 404 — the workspace is real and the page can draw.
- **`notFoundComponent` is a state, not a redirect.** `web.rs` answers every
  unknown path with `index.html`, so a mistyped URL arrives as a page; drawing
  the dashboard under it would make the address bar a lie.
- **Every route names itself in its `<title>` first** (`{name} · Yantra`), because
  a phone's app switcher shows the front of the title.
- **The error component is the shell's own.** `defaultErrorComponent` is
  `RouteError`, and `useResetOnRouteChange()` clears both the boundary and
  Query's error state on a navigation.

**A `<Link>` needs a router in context**, so a test that renders a component on
its own supplies one: `src/test/inRouter.tsx`'s `renderRouted` builds a one-route
memory router around the subject. It **awaits `router.load()`** — a router
resolves its first match asynchronously, and rendering without that draws an
empty document, which reads as a missing element rather than as a race.

## The readings (Y-165)

**[TanStack Query](https://tanstack.com/query)** replaces the `useState` +
`useEffect` + `setTimeout` poll this page used to run — the same ruling as the
router, [CLAUDE.md](../CLAUDE.md) §B1. Every read is a `queryOptions` in
`queries.ts`, and the hooks in `hooks.ts` hand back a `Looked<T>`.

**`Looked<T>` is the daemon's envelope and Query wraps it — it does not replace
it.** `api.ts`'s three variants say *nobody looked*, *a look failed* and *a
machine did not answer*, and R-23 is the whole reason they are three things.
Query's `isLoading` and `isError` are a second, weaker vocabulary for the first
two, so a swept read never uses them:

- **A swept read's query function never throws**, except to re-raise an abort. A
  non-200 becomes `failed` inside it, because every fleet state answers 200 — so
  a status code is a fact about this browser reaching the daemon, never about the
  fleet — and the page keeps **one** failure path.
- **`data === undefined` is `{looked: 'never'}`**, which is the same sentence the
  daemon sends before its first sweep. Nothing distinguishes them, and nothing
  should: neither is a reading.
- **The abort is re-raised rather than swallowed** so Query cancels the query on
  unmount instead of caching an envelope nobody asked for. Consuming the
  `signal` is what makes cancellation happen at all — a query whose function
  ignores it runs to completion after the component is gone.
- **A read a person asked for is the other kind, and it throws.** A transcript, a
  spend, a directory listing and a doctor check each cost an ssh round trip, so
  they are `enabled: false`, never retried, never refetched on a focus or a
  mount, and their failures are `ApiError`s a surface draws under a boundary
  (ADR-0019, D4 §2).

**The 5 s interval is not about freshness.** `refresh.rs` sweeps every 30 s, so a
faster poll buys no newer data; it keeps the age each card prints ticking, and
`staleTime` is the sweep's own 30 s. The two classes on the daemon's 300 s clock
— attention and the repo list — poll every 30 s instead, since 5 s there buys
nothing but a request.

**`useQueries` waits for every name** before the agent class reads `ok`, which is
what one `Promise.all` used to say — a workspace whose status is still in flight
is not a workspace with no report, and rendering it as `null` would be R-23's lie
in the one place the envelope cannot spell the difference. A `404` still *is*
`null` for that row, because that is what the daemon means by it: the agent look
has not seen a name the workspaces look has.

**Two readings of the same path are one request.** The key comes from
`keys.ts`, so `/` and `/m/{machine}` asking for `/api/workspaces` share a cache
entry and a poll instead of running two of each. The keys are hierarchical for
the writes' sake: everything the daemon says about one workspace sits under
`['workspaces', name, …]`, so a write invalidates by prefix rather than by
remembering every key it touched.

**A hook that reads a client out of context needs one supplied**, the same way a
`<Link>` does: `src/test/inQuery.tsx`'s `renderHookQueried` makes a
`QueryClient` **per call**, since one shared between tests answers the second
from the first's cache, and sets `retry: false` so a rejected fetch is one
fetch.
