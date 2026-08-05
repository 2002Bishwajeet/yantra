# yantra web — the dashboard

One page — a terminal when one is open, then machines, workspaces, a form that
edits one when a row asks for it, a form that makes one, sessions, agents — over
the API `yantrad` serves at `/api`. The four readings poll; the forms and every
workspace row write. No router, no state library, no navigation.
[ADR-0014](../docs/adr/0014-react-with-the-compiler-for-the-web-ui.md) settled
what it is built with; [R8](../docs/research/08-react-and-the-compiler.md) and
[R9](../docs/research/09-component-libraries.md) are the evidence.

Serving these assets from the binary is [Y-073](../tracker.md) and is not here.
Nothing in this directory is on the Rust build's path — `cargo build` still needs
no Node, including the musl cross-build.

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

Three files under `src/components/ui/` bail out today and the build says so.
They are shadcn's generated source; see below.

## The four heartbeat states

The machines table draws ADR-0013 §7, and it has four states rather than two because a page that
says *asleep* when it means *we have not heard from it* is the lie the read model exists not to tell
(R-23). A beat inside 30 s is **ready**; past that, Tailscale's `online` chooses between **up, but
not reporting** — an agent problem, a different thing to go and fix — and **asleep or off**; and a
machine with no beat at all is **never heard from**, which is `heartbeat: null` and never a row of
zeros. `online` picks the explanation and never decides whether a beat arrived (R-8).

The daemon names none of this: `reporting()` in `columns.tsx` owns the threshold, the way `Age.tsx`
owns the staleness one. Most of this tailnet is a phone, a tablet and two dead laptops, so *never
heard from* is the permanent and correct state on most rows.

## A workspace file that did not load (Y-141)

`GET /api/workspaces` lists one entry per **file**, and each says whether it
loaded: `api.ts`'s `Listed` is `{loaded: 'yes'} & Workspace` or `{loaded: 'no',
name, error}`. Before this one broken `.toml` made the whole class
`looked: 'failed'` and this page drew nothing at all — for every workspace the
operator has.

**The failure is named below the table, never drawn as a row in it.** That is the
row's real decision and it is about the columns: a file that did not load has no
machine to show a `<Status>` for, nothing for `ACT` or `TERMINAL` to target, and
`EDIT` cannot repair it — the daemon's `update` loads before it writes, so the
file is the fix. A table of things you can act on must not carry a row you
cannot, and R-23 is met by naming the file loudly with its whole reason, in the
same `<Alert variant="destructive">` an unreachable machine gets in Sessions.

`App.tsx`'s `loaded()` is the one narrowing: everything that acts on a workspace
— the edit form, `workspaceColumns`, `attachable`, `sessionCommand` and
`useAgents` — takes the entries that loaded, so **no per-workspace status is ever
fetched for a file that is not one**.

## The buttons that act (Y-113, Y-136)

`Act.tsx` is one cell of every workspace row and one cell of every agent row:
**start, stop and resume**, posting to `/api/workspaces/{name}/{up,down,resume}`.
It is what M5 exists for — a phone has no terminal to paste into.

- **There is no machine argument, and adding one would be a bug.** The target is
  `workspace.machine`, chosen when the workspace was written. A transient
  override would place a session where `down`, `resume`, `status` and `logs` all
  look elsewhere and report the absence as success — [Y-117](../tracker.md).
  What the picker is, is the machine and Y-109's reading of it in the cell
  beside the buttons, said before the button is tapped. A machine the tailnet
  does not list — an `~/.ssh/config` alias, which ADR-0009 allows — gets **no**
  state, because none was looked up.
- **An asleep machine is not refused here.** The daemon decides; the page shows
  *asleep or off* and leaves the button live (R-23, ADR-0009). There is no wake
  button, because waking is not possible from here (Q10, Y-115).
- **`launched: false` is a success, not a failure.** `up` twice attaches (§B4,
  I-30). It also reports an *agent*, and a workspace's own `startup` is not one,
  so a created session with `launched: false` says "running the workspace's own
  startup" where there is one and "a plain shell" where there is not — measured
  against a `startup` that really was running.
- **Every status keeps its own sentence** — `404` no such workspace, `400` an
  unusable name, `403` a node that is not the owner's, `422` a field the daemon
  does not know, `409` a refusal about state, `503` nothing asked and nothing
  decided, `500` the verb itself. The plain-text body is the whole `source()`
  chain and is shown whole.
- **The `409` is drawn as a refusal rather than a crash** (Y-135), the same way
  the edit form draws its own. It is an agent holding at claude's trust dialog
  (I-49) or one that is not logged in (I-44) — a state the daemon named
  correctly, which a person changes at the machine itself, so the daemon's own
  sentence is what says how. **The `503` no longer claims to be about Tailscale**
  either: since the verbs answer it for a machine that could not be asked, a
  sentence naming only the tailnet would be wrong half the time. `NewWorkspace`
  keeps the narrower wording on purpose — `POST /api/workspaces` touches no
  machine, so `whois` is still the only thing that can leave it undecided.
- **Nothing may read as done while it is in flight.** These handlers `await`
  ssh and `ConnectTimeout` is 10 s, so the tapped button names what it is doing,
  the row says which machine it is waiting on, and all three are disabled — a
  second tap cannot fire a second request.
- **`up` sends `{"agent":"claude"}` only where `startup` is null**, because
  ADR-0007 refuses an agent beside a workspace's own startup; the button says
  which it is. **Resume is not offered** to such a workspace at all, for
  ADR-0015's reason, which is the shape Y-097 already chose.
- **The agents section gets the same component and one verb of it** (Y-136).
  It reads `status.status.state`, so unlike the workspaces table it knows which
  verb the row is for: `up` where no session is open, `resume` at each of the
  four endings, and nothing at all where a `startup` makes ADR-0015 refuse. So
  `Act` takes a `verb` prop that narrows it to that one, rather than being
  forked or dropped in whole — a **Stop** beside an agent that has already
  stopped is answerable, `down` on nothing saying exactly that, and still says
  the page does not know what it is looking at. The workspaces table passes no
  `verb` and keeps all three, because it reads no state and the daemon is the
  only thing that can decide. That cell's header is `ACT`, not `COMMAND`.
- **`USABLE_NAME` guards a paste and never a button.** The name in a command
  someone types into a shell is checked against what `workspace::validate_name`
  allows; the name in a button's URL is `encodeURIComponent`'d and refused by
  the daemon's own `400`, which is the rule Y-130 already applied to the
  terminal button.

`Command` stays exactly where no write exists, and what is left there is `attach`
in both places it appears. The workspace row's paste became a button in
[Y-130](../tracker.md) — see below — and the agent row's `up` and `resume` became
buttons in Y-136. The sessions section and the four agent states that answer
`attach` keep theirs for one reason: `attach` execs `ssh -t` and hands *this*
terminal over (ADR-0011), which is also who answers the trust prompt. A session
Yantra did not open has no command at all, every verb taking a workspace name.

## The terminal (Y-130)

`Terminal.tsx` is xterm.js on `GET /api/workspaces/{name}/terminal`, opened by the
`Open terminal` button in a workspace row and closed by the one in its header. Four
decisions, each of which could reasonably have gone the other way:

- **A sixth section, not a route and not an overlay.** `App.tsx` holds one
  `string | null`; the terminal draws above the other five when it is set. `yantrad`
  would serve a deep link — `web.rs` falls back to `index.html` — but a URL for a
  terminal promises a socket reopened on load, which Y-130 left to
  [Y-132](../tracker.md) and Y-132 answered only for a terminal already on the
  screen; whether this page gets a router is still nobody's decision. An overlay
  would be the first thing here that traps focus, over a screen a phone gives the
  whole of anyway.
- **The same `Card` the other sections use, so no primitive was vendored.**
  `Section` takes a `Looked<T>` and a terminal is not a reading, so this composes
  `Card` itself. `Act.tsx` exports its button class rather than having it copied.
- **`TERM` is `xterm-256color`**, sent in the first control frame and on every
  resize. It is what every xterm.js consumer sends and the one entry both
  `ncurses-base` and Apple's 2015 ncurses carry; ncurses' own `xterm.js` alias and
  `xterm-direct` are in neither, and I-36 says an entry the far side lacks is an
  attach that aborts. This is not the client's `TERM` in I-36's sense — it is a
  constant in this code, not something read from a user's environment.
- **The stream is never stored.** No frame reaches `console`, nothing is persisted,
  and the scrollback is xterm.js's own, in the element, gone with it (Q5).

**Text frames from the daemon are errors, not output.** Writing one to the screen
would make it indistinguishable from something the session printed, so it is drawn
as an alert beside the terminal. A close with nothing said is not an error at all,
and is what reconnect turns on.

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
`WebSocket`, so nothing in `Terminal.tsx` participates and nothing here changed.

**`ws: true` on the dev proxy is load-bearing.** The string form of a Vite proxy
entry forwards plain requests only, so without it the terminal in `npm run dev`
connects to nothing.

Two things `src/terminal.test.tsx` records because they cost an hour each.
**jsdom's own `WebSocket` cannot connect under vitest** — jsdom builds it on
undici's, undici constructs the global `Event`, and the jsdom environment has
replaced that class, so the handshake dies in `dispatchEvent` saying *"must be an
instance of Event. Received an instance of Event"* and the socket times out. The
`ws` client is stubbed in for it: a second real implementation talking to a real
server, not a stand-in for the socket under test. And **xterm.js wants the legacy
`MediaQueryList.addListener`**, which the `matchMedia` stub `dashboard.test.tsx`
carries does not have.

What that suite cannot reach: `FitAddon.proposeDimensions()` answers `undefined`
where nothing has a width, so the sizes asserted in CI are xterm's own 80x24 and
the arithmetic needs a browser. Nor has any of this met a real daemon — the server
it talks to speaks the protocol and knows nothing of a pty.

## The shape a phone gets (Y-121)

Below **48rem** `DataTable` draws one labelled block per row instead of one table
row, and above it the table is unchanged. All four tables share the component, so
all four get it. The width is read with `matchMedia` through
`useSyncExternalStore`, which is why narrowing a window swaps the shape without a
reload.

- **A table could not be made to fit, and no column order could save it.** Y-113
  had already moved `ACT` third and stacked the heartbeat badge under the machine
  name. Measured at 390 px over the real URL: the table is **924 px** inside a
  **310 px** box and the start button lands at **x 358–443**, its centre past the
  edge of the screen. In blocks it is at **x 140–225** at 390 px and at 320 px
  alike, and `document.elementFromPoint` at its centre returns the button.
- **No column is dropped, and that is not politeness.** The first two cells alone
  measure **127 + 184 px** — wider than the 310 px a phone shows — so a table cut
  to `WORKSPACE`, `MACHINE` and `ACT` would still hide the buttons. Hiding a fact
  buys nothing here, so every header becomes a `<dt>` and every cell a `<dd>`,
  including the empty ones: a blank `STARTUP` is what the table showed too.
- **The cost is vertical.** The workspaces card grows from 322 px to 527 px at
  390 px. That is the scroll a page already has; a sideways one is not.
- **`48rem` is measured.** 768 px is the narrowest viewport where the table's own
  `ACT` cell is on screen without a swipe, so it is where the table is allowed
  back.

**Every number above is the workspaces table's, and it is the only one that was
ever put in front of a phone.** The machines, sessions and agents tables were
given the blocks by the component rather than by a measurement, and none of them
has been drawn at 390 px in a real browser (Y-138). The widest unbounded thing
left on the page is the agents table's `DETAIL` cell, which renders free-form
daemon prose in `whitespace-pre-wrap`.

**jsdom implements no `matchMedia` at all** — not a stub returning false, nothing
— so `dashboard.test.tsx` supplies a width to every test and its stub evaluates
the query `DataTable` really asks. The breakpoint stays the component's to choose.

## The write that makes a workspace

`NewWorkspace.tsx` posts `{name, machine, repo, startup?}` to `/api/workspaces`
(Y-116). Three things about it are not free choices:

- **It renders the `201`'s own body and never re-reads the list to confirm.**
  `refresh.rs` looks every 30 s and a create does not poke it — measured at 15 s
  during which `GET /api/workspaces` still answered without the new workspace. A
  form that confirmed by re-reading would draw an empty list after a success.
- **The machine is a picker over the machines reading, and an offline machine can
  be chosen.** [ADR-0009](../docs/adr/0009-machine-names-are-ssh-destinations.md):
  Yantra never resolves a machine, and a sleeping Mac is a legitimate target.
- **Each status the route answers keeps its own sentence** — `409` a name already
  taken, `400` an unusable name or an empty field, `422` a field the daemon does
  not know, `403` a node that is not the owner's, `503` a `tailscale` that could
  not answer, which is not the caller's fault. The body is plain text, not JSON,
  and is shown whole.

There is **nowhere to type a secret**, and that is what keeps root §B4 here: the
schema has three keys and none of them is one. `startup` is a shell command, so a
secret in it stays a reference (`op://…`, `pass show …`) the shell resolves. No
check is made over that string — a heuristic over an arbitrary command either
misses the real case or refuses a legitimate one.

## The write that changes one (Y-126)

`EditWorkspace.tsx` sends `PATCH /api/workspaces/{name}`, opened by the **Edit**
button every workspace row carries and closed by the one in the form. It is what
the row exists for: a typo in `repo` used to need an ssh session, which a phone
does not have.

- **A field nobody touched is not in the body.** The form diffs what was typed
  against the workspace it opened from and sends only what differs, because
  absent means *leave it alone*. A form that PATCHed all three every time would
  turn fixing a typo in `repo` into a move of `machine` — and a move is the one
  edit a live session refuses ([Y-117](../tracker.md), I-30). Nothing differing
  sends nothing at all, since a body naming no field is the daemon's `400`.
- **Emptying `startup` sends `"startup": null`, which is the only `null` that
  means anything on this route.** It is `--no-startup`; a missing key leaves the
  command alone. Without it a startup command set once could never be taken away
  from a phone, which is half of why the row was opened.
- **The `409` is a refusal, not a crash, and is drawn as one.** A session still
  open on the machine being left keeps the plain alert rather than the
  destructive one, and the daemon's own sentence is shown whole — it names the
  workspace, the machine it may not leave and the `yantra down` that ends the
  refusal. Inventing wording for it here would be a second, worse copy of a
  sentence [`edit.rs`](../crates/yantra-core/src/edit.rs) already writes. `503`
  covers both a `tailscale` that could not answer and a machine that could not
  be asked, so its sentence claims neither: nothing was decided and nothing
  changed.
- **It renders the `200`'s own body, and the next edit is measured against
  that.** Same reason the create form renders its `201`: the read model is up to
  30 s behind, so re-reading to confirm draws what was just replaced. Comparing
  a second edit against the answer rather than the stale row is what stops it
  re-sending a `machine` that already moved.
- **The picker keeps a machine the tailnet does not list.**
  [ADR-0009](../docs/adr/0009-machine-names-are-ssh-destinations.md) allows an
  `~/.ssh/config` alias, and a `<select>` without the workspace's own machine in
  it would silently select another — turning a repo fix into a move nobody
  asked for.

A section beside the create form rather than a control inside the row: three
fields and a picker do not fit a table column, and the row already opens a
section this way for the terminal. **There is no name field** — the route
addresses a workspace by its name, so renaming is a create and a delete, which
neither `yantra edit` nor this route is.

What it cannot catch: the row it opens from is up to 30 s old, so a workspace
changed elsewhere in between is drawn as it was. It is not clobbered — an
untouched field is compared to the stale value, matches, and is never sent — but
the form will show what it replaced until the next look.

## Installable on a phone (Y-114)

`public/manifest.webmanifest` plus `public/sw.js`, registered from `main.tsx` on
production builds only. It needs HTTPS — a service worker will not register
outside a secure context — which is `just https` in the repo root.

**The one rule: the worker never caches a reading.** `/api`, `/healthz` and
`/heartbeat` are not intercepted at all, so the browser makes those requests
itself and a daemon that cannot be reached becomes `useLooked`'s `failed`
envelope, exactly as it does with no worker installed. Offline reads as offline.
A cached reading would be R-23's confident lie with a longer memory, and
`src/sw.test.ts` runs the shipped `sw.js` against a fake `caches` to prove it —
including that a reading planted in the cache by hand is still not served.

**The terminal socket is covered by that same exclusion and is asserted anyway.**
It is under `/api`, and a WebSocket handshake never reaches a `fetch` handler in
the first place, so nothing had to change for Y-130. What the test pins is the
route's *address*: moving it out from under `/api` would put a terminal in the
cache silently.

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
literal, and `index.css` is the swap point a design system replaces; neither is
required for installability, so neither is here.

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

Every test in `dashboard.test.tsx` stubs `fetch` and returns a literal typed to
match `api.ts`, so the two sides of the wire were kept in step by convention:
renaming a field in `crates/yantrad/src/api.rs` left both suites green and this
page blank. `src/contract.gen.ts` is the answer — the daemon's own routes
rendered into TypeScript that `satisfies` the types above, written by a Rust test
and regenerated with `just fixtures` in the repo root.

**Never edit it, and do not import it.** `tsc` type-checks every file under
`src/`, which is the whole of how it runs; `npm run build` and the CI type-check
step are where a mismatch surfaces. A DTO that moved without the file being
regenerated fails on the Rust side first, saying so.

It does not cover status codes, headers or the refusal bodies — those are plain
text, and `Act.tsx`, `NewWorkspace.tsx` and `EditWorkspace.tsx` still map them by
hand.

## The seam

A design system is arriving from elsewhere. Two rules keep it a one-file change:

1. **Never edit `src/components/ui/`.** It is shadcn's output and is regenerable;
   all composition wraps it. `components.json` has `"cssVariables": true`, which
   **cannot be changed after init** — switching would mean deleting and
   reinstalling every component.
2. **Call sites pass a `tone`, never a colour.** `Status.tsx` is the only file
   that maps a domain state to an appearance.

`src/index.css` holds the token vocabulary at shadcn's default values and is
marked as the swap point. Light and dark both work through
`prefers-color-scheme`; Q6 ruled out a theme switcher, so shadcn's `.dark` class
was rewired to the media query rather than left with nothing to toggle it.

## Layout

```
public/
  sw.js              the service worker; caches the shell and never a reading
  manifest.webmanifest
  favicon.svg  icon-192.png  icon-512.png  apple-touch-icon.png
src/
  api.ts             the wire shapes, read and written; every state is a tag
  contract.gen.ts    yantrad's own answers, `satisfies` those shapes. Generated
  useLooked.ts       the poll — every read, class or agent
  columns.tsx        four Column<T>[] arrays: the four tables, as data
  components/
    Section.tsx      the looked switch; children run only in the ok branch
    NewWorkspace.tsx the create form; owns the field class
    EditWorkspace.tsx the edit form — sends only the fields that differ, and
                     `startup: null` where one was emptied
    Act.tsx          start / stop / resume per workspace row, and the one verb
                     an agent row's state is for; owns the button class
    Terminal.tsx     xterm.js on the session's WebSocket, reopened when it
                     drops. Key it on the name
    DataTable.tsx    a table, or a block per row on a phone; owns "we looked
                     and there is nothing"
    Status.tsx       tone -> appearance; the only file that knows about colour
    Age.tsx          age_seconds -> <time>; owns the staleness threshold
    ui/              shadcn output. NEVER EDITED.
  index.css          the token vocabulary — the whole integration surface
  App.tsx            the sections, and which terminal is open
```
