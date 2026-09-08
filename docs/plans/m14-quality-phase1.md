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
| `d4ae96f` | The boards review's accessibility findings: the keyboard trap, the three live regions, the two focus failures |
| `e550211` | Finding 98: the fourteen boards with no picture |
| `aa139e2` | Finding 134: the terminal cell measured after the mono face lands |
| `2f50305` | Row 135: one shell at every width, so a form-factor change keeps the tree |
| `f1193ec` | Rows 79 and 83: one announcement per error layout, and what the e2e clock freezes |
| `170b2a2` | Row 136: axe waits for the transitions to end, so a surface is measured settled |
| `e9136e2` | Rows 66, 67 and the `m3/` package rows of the boards review: 105, 110, 123, 124, 126, 130 |
| `531093b` | Rows 101, 115, 125, 137 and the drawn half of 100: Usage's bar and its cached read, Fleet's Idle header, the gallery spec, the hero's tracking, the palette's verb count |
| `5649eea` | The shell rows of the boards review: 102, 106, 111, 112, 121, 122, 129 and the shell half of 131 |

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
| 79 | `ErrorSurface` carries `role="alert"` and `ErrorBoundary` passes `autoFocus`, so VoiceOver says it twice | `f1193ec` |
| 80 | The bell was named twice | `ec6e17c` |
| 81 | `count={0}` drew a "0" badge | `ec6e17c` |
| 82 | The fixture's invalid-first-frame text and its binary handling | `d837994` |
| 83 | `scenario.ts` freezes `Date` and not the timers, and the helper still says nothing about it | `f1193ec` |
| 85 | `afterEach(cleanup)` in 35 files | `5bb41e6` |
| 86 | `index.css` follows `prefers-color-scheme` and not `data-theme` | `e9e9158` |
| 87 | Row 33 again, on `Fab`, `ExtendedFab` and `IconButton` | `d8e5a5e` |
| 88 | A loader's `ensureQueryData` rejects when the page leaves mid-read | `d8e5a5e` |
| 89 | A terminal socket closed while it was still CONNECTING | `d8e5a5e` |
| 90 | React logs an `ApiError` the boundary already drew | `d8e5a5e` |
| 91 | The terminal pane took Tab and never gave it back (2.1.2, Level A) | `d4ae96f` |
| 92 | Nothing reserved room under the phone's fixed FAB, its bar or the sticky footer (2.4.11) | `d4ae96f` |
| 93 | The four clone stages advanced with no live region and no progress track (4.1.3) | `d4ae96f` |
| 94 | A session going running to crashed was announced nowhere (4.1.3) | `d4ae96f` |
| 95 | The pane took focus when the fonts resolved (2.4.3, 3.2.1) | `d4ae96f` |
| 96 | The palette's arrow keys moved an option the list never scrolled to (2.4.7) | `d4ae96f` |
| 99 | The terminal's `role="status"` unmounted with the session's end (4.1.3) | `d4ae96f` |
| 98 | Fourteen of the 63 boards had no screenshot baseline | `e550211` |
| 134 | xterm cached the cell it measured against the fallback face, so a late webfont left the pty the wrong width | `aa139e2` |
| 135 | `Shell` renders `shells[factor]`, so a form-factor change unmounts the tree and Usage loses the fan-out | `2f50305` |
| 136 | axe sampled the confirm dialog part-way through its 231 ms fade, so `color-contrast` failed on Cancel at 4.05:1 | `170b2a2` |
| 66 | `Button.css` padded S at 20 and M at 28 where the Expressive tokens say 16 and 24 | `e9136e2` |
| 67 | The pressed corner morphed to `medium` at both sizes; S is `small` and M is `medium` | `e9136e2` |
| 105 | A one-of-N choice was announced as independent toggles | `e9136e2` |
| 110 | The focus ring on `inverse-surface` was 2.0:1 in light and 1.3:1 in dark | `e9136e2` |
| 123 | The focus ring's corner was cut on a List's first and last row | `e9136e2` |
| 124 | `Switch`'s `label` was optional, so a nameless switch compiled | `e9136e2` |
| 126 | Five radii in `m3/` were off the shape scale | `e9136e2` |
| 130 | `Card[data-surface="inverse"]`, `m3/divider/` and `m3/tab-pills/` were drawn by nothing; `m3/snackbar/` stays, and the boards ledger says why | `e9136e2` |
| 101 | PhoneFleet's Idle header printed the word twice — `idle IDLE 4` — because `State` supplied its own | `531093b` |
| 115 | No spec opened `/m3`, so the run that gates a merge never rendered the component gallery | `531093b` |
| 125 | The dashboard hero assembled its own `font` shorthand and restated the role's tracking | `531093b` |
| 137 | `Palette.test.tsx`'s *never runs a verb* counted the POSTed reads the e2e version excludes | `531093b` |
| 84 | `web.yml` carried `continue-on-error: true` on the budget step | Y-370 — the ceiling now comes from a load-time target (200 KiB, [R16](../research/16-what-the-first-load-costs-a-phone.md) §6), `/` is 148.4 KiB against it, and the flag is gone |
| 102 | The palette's options were tab stops beside the field's `aria-activedescendant`, and the legend was `aria-hidden` | `5649eea` |
| 106 | The docked 420 px sheet took the tablet's page down to 124 px at 200 % zoom (1.4.10) | `5649eea` |
| 111 | `role="alert"` mounted with its text, so `ErrorSurface` announced by luck | `5649eea` |
| 112 | The session screens lost the sessions rail the boards keep beside them | `5649eea` |
| 121 | The tablet's action row sat outside every landmark, and its bell named no popup | `5649eea` |
| 122 | Ctrl-K fired while the terminal pane held focus | `5649eea` |
| 129 | The tablet drew a search the boards have not, and kept the bell and the avatar out of the rail | `5649eea` |
| 131 | Unreachable offered no **Open Tailscale**; Fleet's stray heading is another row's half | `5649eea` |

Rows 30 to 90 are the phase 1 review's findings table. Rows 91 and above are the boards
review's (`m14-review-boards.md`, 2026-09-07), which numbers from 91 for that reason.

## Open

| Row | Finding | Whose |
| --- | --- | --- |
| 77 | `Card` and `Text` take `as`, while `Row` and `ListItem` take `render`: two polymorphism idioms | Packages; one idiom, and every call site follows |
| 138 | *Never runs a verb* opens and closes the palette once per option — about 3.5 s of Vitest's 5 s — so a loaded box times it out. One run in 25. Found while checking 137, and a different defect from it | Testing; it wants its own row |
| 118 | Eight components draw a visible control under 44 px | **Refused in Y-360**: 40 and 32 are Material's own numbers, which ADR-0024 §4 puts above the brief's 44, and §3 measured the 48 px hit area whole. [Boards ledger](m14-review-boards.md) §4 |
| 100 | Usage draws no per-model token counts, because `ModelSpend` carries `model`, `responses` and `cost` and nothing else | API. Y-360 drew the proportion bar and moved the read into the query cache; the counts need `crates/yantrad/src/write.rs:1387` to send them |


Rows 66, 67, 77 and 79 are nits the review filed against `web/src/m3/`. This pass left them alone
because six screen agents are reading those components right now, and a signature change or a
padding change under them costs more than it buys. They belong in the Y-353 sweep.

**Y-353 did not take them either, and here is why.** That row's brief was rows 84 and 86 and the
deletion. Rows 66 and 67 move a padding and a corner on `Button`, which moves every screenshot
baseline the e2e holds; row 77 changes a signature at every call site; row 79 changes what a screen
reader says on every error layout. Each is its own row, and the one that moves a baseline
re-renders it in the Playwright image in the same change.

> **Y-360 took 79 and 83 on 2026-09-07, and left the other three.** The live region is the
> announcement at every layout: `role="alert"` reads the whole board, where a focus move reads the
> title alone and takes the caret from wherever the reader left it. So `autoFocus` is gone from
> `ErrorSurface` and its four callers, with the heading's `tabIndex` and the focus ring that served
> it. `scenario.ts` now says what `setFixedTime` freezes — `Date`, and not `setTimeout` or
> `setInterval` — and carries the measurement that rules out the alternative: under `install()` and
> `pauseAt()` 49 of the 54 desktop cases in `down`, `smoke`, `dashboard` and `session` fail, and the
> page never draws a first reading. Rows 66, 67 and 77 still move a baseline or a signature, so they
> stay where they are.

> **Y-360 took 66 and 67 on 2026-09-08, and no baseline moved.** The numbers come from the tokens
> themselves: `ButtonSmallTokens` gives `LeadingSpace` 16 and `PressedContainerShape`
> `CornerSmall`; `ButtonMediumTokens` gives 24 and `CornerMedium`. So the padding is 16 and 24, and
> the pressed corner is 8 at S and 12 at M — one shape per size, which is what 67 asked for. The
> baselines were re-rendered in `mcr.microsoft.com/playwright:v1.63.0-noble` and **not one of the
> 112 PNGs changed**: `toHaveScreenshot` carries `maxDiffPixelRatio: 0.01`, and 4 px of padding on
> the buttons of a page is under that. Row 77 stays open.
> **Y-360 took 101, 115, 125, 137 and half of 100 on 2026-09-08.** The refused half is in
> [m14-review-boards.md](m14-review-boards.md) §4: the daemon sends no per-model token counts, so
> the browser has none to draw. Row 137's assertion now excludes the same POSTed reads the e2e
> version excludes. **What the pass could not reproduce, it says:** 60 runs of `Palette.test.tsx`
> on a saturated box never recorded a `/logs` POST, so the change rests on reading both tests
> against ADR-0019 and not on a failure seen twice. Those runs found something else. *Never runs a
> verb* opens and closes the palette once per option, which is about 3.5 s of Vitest's 5 s, and a
> loaded box times it out — one run in 25 here, in the same file and for a different reason. That
> is the timing row 137 said to leave alone, and it wants a row of its own.

**Row 134, and the third diagnosis is the one that held.** The pane opened on the wrong column
count, and `session-terminal-busy-phone` failed at six workers while passing at one. Two readings
were recorded and both were wrong: that the baseline was right and the render wrong, and its
inverse. The measurements that settle it were taken by instrumenting the fit itself, in the
Playwright image, at one worker.

```
FIT#0      cols=52  hostW=358  face=false     the cell is measured, and cached
FIT#n      cols=52  hostW=358  face=true      the face has landed; the count does not move
REMEASURE  cols=43  hostW=358  face=true      a forced re-measure recovers it
```

**xterm measures the character cell once**, against whatever face is live at that instant, and
caches it. `fit()` afterwards only divides the container by that stale cell, and reassigning the
same `fontFamily` is a no-op — verified: the re-measure fired only when the string itself changed.
So a webfont that lands after the pane opens leaves the terminal wrong for good, and no resize
recovers it. The container width never moved, which rules out layout timing as well.

**It is a product bug, not a test artifact.** A pty is opened with that window, so a person on a
cold cache gets a tmux session whose lines wrap where the shell did not break them.

The fix asks for the face and waits before the pane draws, so the first measurement is the right
one. `fonts.ready` alone never held it: it settles on the loads already pending, and nothing on this
route asks for the face until the pane draws.

**Three baselines moved, and they had to.** `session-terminal-busy-phone`,
`session-unclaimed-busy-phone` and `confirm-kill-busy-phone` encoded `FIT#0 face=false` — the bug.
They held **52**, and the corrected count is 43.

**The 49 in the second diagnosis was a misreading, not a third state.** The status line under the
pane prints `cols×rows`, and `session-unclaimed-busy-phone` printed `52×`. Put the old
`Terminal.tsx` back and it redraws that baseline pixel for pixel. So no run ever measured 49, and
nothing was measured while the swap was in flight.

No baseline without a pane moved. The whole suite says so: 513 passed, 171 skipped and none failed
in the Playwright image, with the three specs green four runs out of four at one worker and at six.

## Row 136: axe measured a frame, not a page

CI failed once on PR #263, a documentation change that touched no code. The `e2e (desktop)` job
reported one violation, on the initial run and on the retry:

```
color-contrast (serious)
  .m3-button[data-variant="text"][data-tone="primary"]
  <button type="button" tabindex="0" data-variant="text" data-tone="primary" data-size="s">Cancel</button>
  insufficient color contrast of 4.05 (foreground #567358, background #e0e3da, 14px). Expected 4.5:1
```

That Cancel sits in the Delete-a-workspace dialog. It draws `primary` on the dialog's
`surface-container-high`, and in the light theme those roles are `#48674B` on `#E6E9E0`, which is
**5.15:1** — 14 % clear of the 4.5:1 that 1.4.3 asks of 14 px text. **Neither colour axe named is a
token**, so the pair it measured is not a pair the stylesheet declares.

**Both are composites of a fade in flight.** `.m3-dialog` transitions `opacity` over
`--md-sys-motion-duration-default-effects`, 231 ms. Put the popup at opacity α over the scrim and
the page, and axe's two numbers fall out at **α = 0.907**: the scrim at 32 % black over `surface`
gives `#A9AAA5`, the surface reads 0.907 × `#E6E9E0` + 0.093 × `#A9AAA5` = `#E0E3DA`, and the label
reads 0.907 × `#48674B` + 0.093 × that = `#567358`. The ratio between them is 4.05.

**The fade survives `prefers-reduced-motion`, and it should.** R14 §5 removes movement and keeps
feedback: the reduced-motion rule floors the three spatial durations at 1 ms and leaves the effects
durations alone, and `m3/tokens.test.ts` asserts exactly that. Every e2e project runs under
`reducedMotion: 'reduce'`, so the 231 ms fade runs in CI the way it runs for a reader.

**The focus gate is what starts the race.** `confirm.spec.ts` waits for Base UI to move focus into
the popup, and Base UI moves it when the transition *starts*.

**Measured.** On the tree before the fix, in the Playwright image at six workers, the Delete case
failed **1 run in 260**. Instrumented — reading `getComputedStyle('.m3-dialog').opacity` at the
instant the focus gate returned — the dialog was unsettled in **40 runs of 40**, 35 of them before
the fade had painted a frame, and axe reported a `color-contrast` violation in **4 of the 40**.
Slow the fade to 3 s and the race stops being one: the same call fails **10 runs of 10**, each on a
different composite, and the settle gate passes 10 of 10 on the same page. More than Cancel trips
it — the filled Delete button's white label over `error` read **1.34:1**, and a 24 px label inside
the dialog read 1.42:1 against the 3:1 that 1.4.3 gives large text.

**The fix waits, in `e2e/lib/axe.ts` rather than in one spec.** `axe()` holds until no CSS
transition is running. Transitions only: the skeleton shimmer is an animation and never finishes.
Every call site gains it, which is the point — the bottom sheet, the popover, the menu and the
snackbar all fade the same way.

**No token moved and no baseline moved.** The pair passes at rest in both themes and both
densities: `#48674B` on `#E6E9E0` is 5.15:1 light, `#AFCFAC` on `#282C26` is 8.35:1 dark, the bottom
sheet's `surface-container-low` gives 5.71:1, and Compact changes spacing only. Raising the
threshold, excluding the rule and listing it as `known` were all available and all refused: the
reading was wrong, not the rule.

## Finding 98: the fourteen boards, and what picturing Usage cost

`e2e/fleet.spec.ts` is new on the busy scenario, and `machines.spec.ts`, `machine.spec.ts` and
`usage.spec.ts` now call `screenshot()` beside the `axe()` they already called. MainDark and
MainCompact come from `dashboard.spec.ts`, whose `prefer()` helper writes `shell/prefs.ts`'s key
before the first paint, so the theme and the density are set the way a person sets them. The
fourteen baselines were rendered in `mcr.microsoft.com/playwright:v1.63.0-noble`, never on the host.
All 63 boards have a picture.

**One of the fourteen would not hold still, and the cause is a defect.** `usage-busy-desktop` was
first written with *Nothing read yet* on it, and it then passed five runs out of six against that
wrong picture. A full-page capture makes Chromium report a **1x1 viewport** for a frame. Then
`useFormFactor` reads *phone*, `Shell.tsx:290` renders `shells[factor]`, and that is a different
component type, so React unmounts the tree and mounts a new one. Every other screen reads its query
cache again and looks the same. Usage holds the fan-out in `useFleetSpend`'s own state, which no
cache can give back, so the read is gone.

The Usage picture is the viewport rather than the page for that reason. The boards are drawn at
1440x1024, 834x1194 and 390x844, so the viewport is the board's own frame, and the capture no longer
resizes anything. Eight repeats at three sizes pass. **The defect stands**: a person who drags a
window across 600 px or 1240 px loses the read the same way, and that is row 135 above, beside
row 100.

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

**Y-352's accessibility fixes then add 317 B**, for **147.6 KiB** (151 124 B) and a gap of 2.6 KiB.
The entry chunk carries 294 B of that — the shell's live region — and the stylesheet 23 B, the
phone's `scroll-padding-bottom`. Everything else the row fixed sits in a lazy chunk. Measured on
`y-352-a11y` at `d61b61e` against 150 807 B on `main` at `75c46fa`; fonts are 78.5 KiB on both.

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
