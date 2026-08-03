# yantra web — the dashboard

One page, five sections — machines, workspaces, a form that makes one, sessions,
agents — over the API `yantrad` serves at `/api`. The four readings poll; the form
and every workspace row write. No router, no state library, no navigation.
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

## The buttons that act (Y-113)

`Act.tsx` is one cell of every workspace row: **start, stop and resume**, posting
to `/api/workspaces/{name}/{up,down,resume}`. It is what M5 exists for — a phone
has no terminal to paste into.

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
  does not know, `503` a `tailscale` that could not answer, `500` the verb
  itself. The plain-text body is the whole `source()` chain and is shown whole.
- **Nothing may read as done while it is in flight.** These handlers `await`
  ssh and `ConnectTimeout` is 10 s, so the tapped button names what it is doing,
  the row says which machine it is waiting on, and all three are disabled — a
  second tap cannot fire a second request.
- **`up` sends `{"agent":"claude"}` only where `startup` is null**, because
  ADR-0007 refuses an agent beside a workspace's own startup; the button says
  which it is. **Resume is not offered** to such a workspace at all, for
  ADR-0015's reason, which is the shape Y-097 already chose.

`Command` stays exactly where no write exists: a row offers `yantra attach` when
a session really was seen, and nothing otherwise. The agents section still hands
over `up` and `resume` as pastes — [Y-097](../tracker.md)'s derivation, untouched
here.

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
  useLooked.ts       the poll — every read, class or agent
  columns.tsx        four Column<T>[] arrays: the four tables, as data
  components/
    Section.tsx      the looked switch; children run only in the ok branch
    NewWorkspace.tsx the create form
    Act.tsx          start / stop / resume, per workspace row
    DataTable.tsx    the table; owns "we looked and there is nothing"
    Status.tsx       tone -> appearance; the only file that knows about colour
    Age.tsx          age_seconds -> <time>; owns the staleness threshold
    ui/              shadcn output. NEVER EDITED.
  index.css          the token vocabulary — the whole integration surface
  App.tsx            five <Section>s
```
