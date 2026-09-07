# M14 Phase 1 review — what was fixed, what stays open (Y-352, 2026-09-07)

The companion to [m14-review-phase1.md](m14-review-phase1.md), which stays as it was written: that
file records what one read-only pass saw on 2026-09-06, and this one records what the branch did
about it. Row numbers below are the line numbers of the review's findings table. Hashes are on
`y-345-m14-shell`; `git log --oneline 29e5128..HEAD` lists them.

## The commits

| Hash | What it closed |
| --- | --- |
| `017c45a` | Both blockers: the navigation bar's height, and the uncontrolled Segmented group |
| `179693b` | The `light-dark()` fallback, the three CSS utilities, three token nits |
| `5bb41e6` | One Vitest setup file, `src/test/daemon.ts` and `src/test/inApp.tsx` |
| `ec6e17c` | The accessibility rows and the M3 token rows in `web/src/m3/` |
| `2d5818f` | The `web/src/api/` rows: refusal bodies, the refused upgrade, the two races, the hook tests |
| `d837994` | The `web/e2e/` rows: the fixture's refusal shapes, the axe list, the screenshot image, motion |

## Closed

| Row | Finding | Hash |
| --- | --- | --- |
| 30 | Navigation bar height under the home-indicator inset (blocker) | `017c45a` |
| 31 | Uncontrolled Segmented empties on a click on the pressed segment (blocker) | `017c45a` |
| 32 | `light-dark()` with no fallback breaks Safari 17.2–17.4 | `179693b` |
| 33 | `nativeButton` on a rendered `Link` | `ec6e17c` |
| 34 | `outline: none` on menu items | `ec6e17c` |
| 35 | `outline: none` on the tab panel | `ec6e17c` |
| 36 | The snackbar's live region mounts with its text | `ec6e17c` |
| 37 | The Disclosure trigger is named "Show" | `ec6e17c` |
| 38 | The side sheet manages no focus | `ec6e17c` |
| 39 | The text field notch paints `surface` on every container | `ec6e17c` |
| 40 | `overflow: hidden` clips the Segmented hit area | `ec6e17c` |
| 41 | `.m3-clip`, `.m3-mono` and `.m3-eyebrow` ship per chunk | `179693b` |
| 42 | A 404 body is JSON from `api.rs` and a bare string from `write.rs` | `2d5818f` |
| 43 | The fixture answers JSON for every refusal | `d837994` |
| 44 | A refused upgrade reads as an outage and reopens five times | `2d5818f` |
| 45 | `useSpend.ask` and `useTranscript.read` race | `2d5818f` |
| 46 | A 2xx body's shape is never checked | `2d5818f` |
| 47 | Only `useMachines` had a test | `2d5818f` |
| 48 | A deleted workspace keeps polling its status | `2d5818f` |
| 49 | Tests named Enter/Space fired a click | `ec6e17c` |
| 50 | `nested-interactive` in the gallery's Row | `ec6e17c` |
| 51 | A plain Pill announces as an unpressed toggle | `ec6e17c` |
| 52 | The bar and rail were tested as buttons, not links | `ec6e17c` |
| 53 | No focus assertions on dialog, sheet, popover and menu | `ec6e17c` |
| 54 | `aria-describedby` and the `supporting`/`error` rule untested | `ec6e17c` |
| 55 | The `<li>`-outside-the-control shape untested | `ec6e17c` |
| 56 | The tab panel swap left unasserted | `ec6e17c` |
| 57 | Five hand-built `Response`s and two hand-built mounts | `5bb41e6`, `2d5818f` |
| 58 | Screenshot baselines rendered on a developer's machine | `d837994` |
| 59 | Every e2e project ran under `reducedMotion: 'reduce'` | `d837994` |
| 60 | A known axe id marked the whole test `fixme` | `d837994` |
| 61 | The budget measures gzip the daemon never sends | `d837994` and §Y-357 below |
| 62 | The fixture ignores `?force` and answers no verb 409 | `d837994` |
| 63 | `text()` and `new WebSocket()` could leave a bare `Error` | `2d5818f` |
| 64 | `dirs` and `probe` sat under the `machines` prefix | `2d5818f` |
| 65 | `attention` and `repos` polled at 5 s against a 300 s clock | `2d5818f` |
| 68 | The dialog sat on `surface-container-low` | `ec6e17c` |
| 69 | The switch thumb animated `width`, `height` and `margin` | `ec6e17c` |
| 70 | The tab indicator and the track sprang on `left` and `width` | `ec6e17c` |
| 71 | Disabled was one opacity for every variant | `179693b` |
| 72 | The eyebrow typescale was recorded nowhere | this pass; see below |
| 73 | The popover had no elevation | `ec6e17c` |
| 74 | The lucide stroke shrank with the drawn size | `179693b` |
| 75 | An unused spring token | `179693b` |
| 76 | The drag handle used the wrong role | `ec6e17c` |
| 78 | `key={one}` on free text | `ec6e17c` |
| 80 | The bell was named twice | `ec6e17c` |
| 81 | `count={0}` drew a "0" badge | `ec6e17c` |
| 82 | The fixture's invalid-first-frame text and its binary handling | `d837994` |
| 85 | `afterEach(cleanup)` in 35 files | `5bb41e6` |
| 86 | `index.css` follows `prefers-color-scheme` and not `data-theme` | `e9e9158` |
| 87 | Row 33 again, on `Fab`, `ExtendedFab` and `IconButton` | `d8e5a5e` |
| 88 | A loader's `ensureQueryData` rejects when the page leaves mid-read | `d8e5a5e` |
| 89 | A terminal socket closed while it was still CONNECTING | `d8e5a5e` |
| 90 | React logs an `ApiError` the boundary already drew | `d8e5a5e` |

## Open

| Row | Finding | Whose |
| --- | --- | --- |
| 66 | `Button.css` pads S at 20 and M at 28; the Expressive tokens say 16 and 24 | Packages, and it needs the token file read before either number moves |
| 67 | The pressed corner morphs to `medium` for both sizes; Expressive gives one shape per size | Packages, same reading |
| 77 | `Card` and `Text` take `as`, while `Row` and `ListItem` take `render`: two polymorphism idioms | Packages; one idiom, and every call site follows |
| 79 | `ErrorSurface` carries `role="alert"` and `ErrorBoundary` passes `autoFocus`, so VoiceOver says it twice | Packages; pick one per layout |
| 83 | `scenario.ts` freezes `Date` and not the timers, and the helper still says nothing about it | Testing |
| 84 | Plan §3 says the budget fails above the ceilings; `web.yml` still carries `continue-on-error: true` | Still open after Y-353: `/` is 147.3 KiB against 145, so the step cannot be made to fail yet. Y-357 |

Rows 66, 67, 77 and 79 are nits the review filed against `web/src/m3/`. This pass left them alone
because six screen agents are reading those components right now, and a signature change or a
padding change under them costs more than it buys. They belong in the Y-353 sweep.

**Y-353 did not take them either, and here is why.** That row's brief was rows 84 and 86 and the
deletion. Rows 66 and 67 move a padding and a corner on `Button`, which moves every screenshot
baseline the e2e holds; row 77 changes a signature at every call site; row 79 changes what a screen
reader says on every error layout. Each is its own row, and the one that moves a baseline
re-renders it in the Playwright image in the same change.

## The eyebrow, and the amendment it earned

Row 72 asked where the small-caps label above a title comes from. `.m3-eyebrow` lives in
`web/src/m3/tokens.css`, and `Text.tsx`'s `Eyebrow` is its only writer. It takes
`--md-sys-typescale-label-medium` whole — 500 12px/16px on the plain typeface — and colours itself
`on-surface-variant`. So the Material role is **label-medium**. Two properties are not Material's:
`text-transform: uppercase`, and 0.8 px of tracking where the role gives 0.5. Both are BRIEF.md's,
both are kept, and ADR-0024 now says so in a dated blockquote.

## Y-357: the wire is not compressed

Row 61 was right, and the row it named needs a shape. `yantrad` serves the dashboard two ways and
neither one compresses:

- The directory half is `ServeDir::new(dir).fallback(ServeFile::new(&index))`
  (`crates/yantrad/src/web.rs:66`). There is no `precompressed_gzip()` and no `CompressionLayer`,
  and the workspace pins `tower-http = { version = "0.7", features = ["fs"] }` (`Cargo.toml:36`),
  which carries no compression feature at all.
- The `embed-dashboard` half answers from `include_dir!` with a hand-written content-type table and
  sets no `Content-Encoding` (`crates/yantrad/src/web/embedded.rs`). This is the appliance's half,
  so it is the one that matters most.

`web/vite.config.ts` emits no `.gz` either. The phone therefore downloads the raw bytes: 253 kB for
the entry chunk the budget reports as 80 KiB.

A Y-357 row would need five things. **One**, a post-build step in `web/scripts/` that gzips every
`.js`, `.css` and `.svg` in `dist` beside the original — `node:zlib` does it, so no new dependency
needs a line in a PR (plan §3). **Two**, `precompressed_gzip()` on the `ServeDir` and on the
`ServeFile` fallback; this needs no new tower-http feature, because `precompressed_gzip` sits on
`fs` and answers the identity file when the `.gz` is absent or the client did not ask. **Three**,
the same choice in `embedded.rs`: carry both files in `DIST`, read `Accept-Encoding`, and set
`Content-Encoding: gzip`. **Four**, a router test for each half — `Accept-Encoding: gzip` gets the
compressed body and the header, a request without it gets the identity body. **Five**, the header
comment in `web/scripts/budget.mjs` comes off, and the number it prints becomes the wire.

`CompressionLayer` is the alternative and it is worse here: it spends CPU on the appliance for every
request and compresses the same bytes again each time. Precompressing is one cost at build time.

## The measurement, 2026-09-07

Two builds, because the tree is moving under six screen agents.

**At `d837994`, the last commit** (`npx vite build` then `node scripts/budget.mjs --no-build`):

| | measured | ceiling | verdict |
| --- | --- | --- | --- |
| first load of `/` | **192.7 KiB** gzip -9 | 145 KiB | **47.7 KiB over** |
| fonts | **78.5 KiB** raw woff2 | 80 KiB | under, by 1.5 KiB |

The three fonts are Google Sans Flex latin at 49.6 KiB and IBM Plex Mono 400 and 500 at 14.4 and
14.5. The first load is 38 files. The four that carry it are the entry chunk at 107.7 KiB,
`index.css` at 19.0, `Text` at 16.8 and `phrase` at 15.4.

**In the working tree** (the shell plus the screens in flight): **237.5 KiB** first load, the same
78.5 KiB of fonts. The entry chunk drops to 77.5 KiB and a `Shell` chunk of 50.0 KiB appears beside
it, so the growth is the screens, not the shell.

Neither number meets the ceiling. `index.css` is 19 KiB of it and still carries the shadcn sheet,
which Y-353 deletes. That deletion, and the routes under `web/src/routes/` that only it serves, are
the first place to look before anyone splits a chunk.

### After Y-353, 2026-09-07

Measured on `y-353-cleanup` at `e9e9158`, with `npx vite build` then `node
scripts/budget.mjs --no-build`:

| | before | after | ceiling |
| --- | --- | --- | --- |
| first load of `/` | 159.1 KiB | **146.7 KiB** | 145 KiB — **1.7 KiB over** |
| `index.css` in it | 21.0 KiB | **8.6 KiB** | — |
| fonts | 78.5 KiB | 78.5 KiB | 80 KiB — under |

`index.css` is 366 lines to 18, and Tailwind's whole remaining output is the preflight reset:
nothing writes a utility, so the scanner was buying seventeen rules from English words in the
`.tsx`. **What is left is not a stylesheet.** The entry chunk is 761 kB before minifying, and
react-dom is 453 kB of it, TanStack Router about 90, TanStack Query about 40, and `Shell.tsx` plus
`Dashboard.tsx` 68 between them. Nothing on `/` is an eager import that could be lazy: `Setup` and
the Kill confirm already load on demand, and the Dashboard is the landing route. Two bundler
settings were measured and neither merged a chunk under Rolldown — `output.advancedChunks.minSize`
and `output.experimentalMinChunkSize`. So row 84 stays open and Y-357 is the next lever: gzip on
the wire is the same bytes measured honestly rather than a smaller build.

**Merging `main` puts it at 147.3 KiB.** Y-358's unreachable screen adds `reached.ts` and
`NotReached.tsx` to the shell, which is on `/`, so the gap to the ceiling is 2.3 KiB rather than
1.7. Nothing above changes; the lever is still Y-357.

### The `/` chunk carries none of the five

The rule in plan §3 holds. Read `dist/index.html`, take the entry script and every `modulepreload`,
and search that set:

| Package | In the first load | Where it is |
| --- | --- | --- |
| `@tanstack/react-form` | no | `NewSession-*.js`, lazy |
| `@tanstack/react-table` | no | imported nowhere yet; Usage and the machines table are unwritten |
| `@tanstack/react-virtual` | no | imported nowhere yet; the transcript and the notifications list are unwritten |
| `xterm` | no | `Keys-*.js` and `socket-*.js`, lazy |
| `@material/material-color-utilities` | no | `scheme-*.js`, lazy |

## Structure

- **No barrel files.** `find web/src -name index.ts -o -name index.tsx` is empty.
- **`components/ui` has ten importers left**, all outside the new code: `web/src/index.css`
  (ten `@source not` lines and one comment), `web/src/motion.test.ts`, `web/src/primitives.test.tsx`
  and the seven pre-M14 routes `Fleet`, `Machines`, `OneMachine`, `OneWorkspace`, `Repair`,
  `Settings` and `Usage` under `web/src/routes/`. Nothing under `web/src/m3/`, `web/src/api/`,
  `web/src/shell/` or `web/src/screens/` touches it. Y-353 deletes all ten; this pass deleted none,
  because the screens that replace those routes are still landing.
- **Every `web/src/m3/` component has a test.** `gallery/` is the exception, and it is the dev-only
  route the e2e opens rather than a component. `error-boundary/` and `theme/` have no CSS file and
  need none: the first renders `ErrorSurface` and the second sets attributes.
- **`npx oxlint` is clean** on `src/m3`, `src/api`, `src/shell`, `src/test`, `scripts` and
  `vite.config.ts`.
- **`npx tsc --noEmit -p tsconfig.app.json` reports nothing in those paths.** Everything it reports
  is in `web/src/screens/`, mid-write.

### What the screen agents own

Four things this pass found and did not touch, because they are in `web/src/screens/`:

1. `Dashboard.tsx:724` uses `Setup`, which nothing imports. `tsc` and `oxlint` both fail on it, and
   the whole build's `tsc -b` step stops there.
2. `Dashboard.tsx:788,796` pass no `fleetEmpty` to a component that requires it.
3. `GithubRepos.tsx` references `whereIs`, `trimSlash`, `cloneHome`, `byOrigin` and `probes`, none
   of which resolve, and imports `useQueries` and `probeQuery` without using them.
4. `LocalDirs.tsx` holds a `try`/`finally`, which the React Compiler declines to lower:
   `react-compiler: CompileError in .../LocalDirs.tsx: Handle TryStatement with a finalizer`. The
   build still exits 0 — `panicThreshold` is `none` — so that component ships unmemoised while
   `npm run compiled` stays green. Rewrite the `finally` as a plain statement after the `try`.

Three shell tests fail in the working tree and pass at `d837994`:
`Palette.test.tsx › opens with Ctrl-K`, `Shell.test.tsx › has the four destinations` and
`Shell.test.tsx › pushes settings`. The second one now finds two `banner` landmarks, because the
Machines screen renders a `<header>` the accessibility tree reads as a second one. The Machines
agent owns the fix; the shell is unchanged.
