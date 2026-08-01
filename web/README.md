# yantra web — the dashboard

One page, three sections — machines, workspaces, sessions — polling the read-only
API `yantrad` serves at `/api`. No router, no state library, no navigation.
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
src/
  api.ts             the wire shapes; every state is a tag, never a missing key
  useLooked.ts       the poll — the only place a fetch happens
  columns.tsx        three Column<T>[] arrays: the three tables, as data
  components/
    Section.tsx      the looked switch; children run only in the ok branch
    DataTable.tsx    the table; owns "we looked and there is nothing"
    Status.tsx       tone -> appearance; the only file that knows about colour
    Age.tsx          age_seconds -> <time>; owns the staleness threshold
    ui/              shadcn output. NEVER EDITED.
  index.css          the token vocabulary — the whole integration surface
  App.tsx            three <Section>s
```
