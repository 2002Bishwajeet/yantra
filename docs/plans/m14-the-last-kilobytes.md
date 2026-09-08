# M14 — the last kilobytes (Y-370, 2026-09-08)

`npm run budget` on a clean `main` is **151,102 B**, which is **2,622 B over** the 145 KiB ceiling
that [D3 §9.1](../design/03-dashboard-surface.md) and
[ADR-0024 §7](../adr/0024-the-dashboard-is-material-3-built-by-hand.md) set. This note says what
those bytes are, prices the cuts, and gives the owner the evidence for the one decision it does not
take: whether 145 KiB is still the right number.

**The answer to the ranked question is yes.** One change removes 3,637 B on its own. Two changes
together remove 4,202 B and leave the build 1,580 B under the ceiling. Both were built and
measured, not estimated.

## How this was measured

`npx vite build`, then `node scripts/budget.mjs --no-build`, on `main` at `8168a63` with a fresh
`npm ci`. A second build with `--sourcemap` produced the attribution: a script decodes each chunk's
sourcemap, gives every byte of minified output to the source that emitted it, and scales the result
by that chunk's own gzip ratio. The candidates were then applied one at a time in a throwaway copy
of `web/`, rebuilt, and re-measured — no file under `web/src/` was changed on this branch.

The scaling is the one soft edge: gzip does not divide cleanly among the modules that share a
window, so a per-package figure is a share, not a receipt. Every *cut* figure below is a real
before-and-after build, and those carry no such caveat.

## What the first load holds

Nineteen files, gzip -9: the entry script, fourteen `modulepreload` chunks and four stylesheets.

| Source | gzip | Share of the ceiling |
| --- | --- | --- |
| React and react-dom (with `scheduler`, `use-sync-external-store`) | 61,292 B | 41.3% |
| TanStack Router (`router-core`, `react-router`, `history`, `store`) | 27,557 B | 18.6% |
| TanStack Query (`query-core`, `react-query`) | 12,177 B | 8.2% |
| Base UI (with `@floating-ui/utils`, `clsx`) | 7,386 B | 5.0% |
| `lucide-react` | 1,568 B | 1.1% |
| Yantra's own JS (screens, shell, m3, api, router) | ~29,100 B | 19.6% |
| CSS | 10,065 B | 6.8% |

**Four packages are 74% of the ceiling before Yantra writes a line.** `react-dom-client.production.js`
alone is 56,354 B — 38% of the whole budget, in one file, with nothing to cut inside it. That is the
cost of §B1's ruling, and it was bought deliberately.

Yantra's own largest first-load files are `screens/dashboard/Dashboard.tsx` (8,681 B),
`shell/Shell.tsx` (2,562 B), `api/hooks.ts` (1,781 B), `router.ts` (1,351 B) and
`shell/SessionsRail.tsx` (1,021 B).

### The chunks, and whether `/` needs them

Every preloaded chunk is reached by the first paint, with one exception.

| Chunk | gzip | What is in it |
| --- | --- | --- |
| `index-*.js` | 103,130 B | react-dom (55,010), router-core (12,044), Dashboard.tsx (8,681), Shell.tsx (2,562) |
| `Text-*.js` | 9,418 B | **TanStack Query core (7,700) and `api/client.ts`.** `m3/text/Text.tsx` is 489 B of it |
| `index-*.css` | 8,776 B | tokens, `.dash`, Tailwind's preflight, the shell |
| `useRenderElement-*.js` | 8,411 B | **`react` itself (2,720)**, the react-dom shim, Base UI internals, `@floating-ui/utils/dom` (799) |
| `link-*.js` | 6,422 B | the router's route-tree processing (3,428) and `Link` |
| `queries-*.js` | 4,209 B | `queryObserver` and `api/queries.ts` |
| `hooks-*.js` | 3,170 B | `api/hooks.ts` and `queriesObserver` |
| `useStore-*.js` | 1,692 B | `router-core/utils.js` |
| `useOpenChangeComplete-*.js` | 1,262 B | **Base UI's transition machinery, for the Disclosure and nothing else** |
| eight chunks under 800 B | 3,612 B | the two `Button`s, `Mark`, the lucide factory, `useTick`, `redirect`, `useRender` |

**`Text-*.js` is not a text primitive.** Rolldown named a shared chunk after one of its members;
what it actually carries is nearly all of `@tanstack/query-core`. That answers the "9.4 KiB is large
for a text primitive" question — the name is the surprise, not the weight. About 1,900 B of it is
`mutation.js`, `mutationCache.js` and `infiniteQueryBehavior.js`, which `/` cannot reach but
`queryClient.js` imports statically; getting those out means forking query-core, and it is not worth
it.

**`useOpenChangeComplete-*.js` is the one chunk the first paint does not need on its merits.** It is
`useAnimationFrame`, `useAnimationsFinished`, `useTransitionStatus` — Base UI's enter/exit
machinery, pulled in by `Collapsible`, which only `m3/disclosure` uses, which only the Dashboard
draws. See cut 1.

### Three things that are already right

- **xterm is lazy.** `Terminal-*.js` is 86,950 B gzip and is named by no preload. Had it reached the
  entry it would be 59% of the ceiling by itself. The route split holds.
- **lucide is tree-shaken.** Every call site writes `import { Plus } from 'lucide-react'`, and the
  build emits one chunk per icon behind a shared 781 B factory. The barrel costs nothing here; the
  entry carries 1,568 B of lucide for the icons `/` actually draws. No change needed.
- **`@material/material-color-utilities` is lazy.** `scheme-*.js` is 19,300 B gzip and is not
  preloaded.

### And one that is not a problem

No screen sits in the entry chunk that only one form factor draws. `Dashboard.tsx` and `Shell.tsx`
branch on `useFormFactor()` per element — a row renders as a link on a phone and a grid row on a
desktop — rather than shipping two screens. Splitting that would be a rewrite of both files for a
figure no one has measured, so this note does not propose it. `shell/SessionsRail.tsx` (1,021 B) is
the only genuinely desktop-only whole component in the first load.

## The cuts, cheapest risk first

### 1. Hand-roll the Disclosure — **3,637 B**

`m3/disclosure/Disclosure.tsx` wraps Base UI's `Collapsible`. That one import costs 2,392 B inside
the entry chunk and pulls the whole 1,262 B `useOpenChangeComplete-*.js` chunk into the preload set.
It buys one animated open and close, on the Dashboard's Idle row, and nowhere else — every other
Base UI popup consumer (Dialog, Menu, Popover, BottomSheet) is already behind a lazy route.

Replacing it with a `useState` and a button measured **151,102 → 147,465 B**, which clears the
overage on its own with 1,015 B to spare.

**What it costs the user.** Nothing they can name, if the spring is kept. `Disclosure.css` reads
three things Base UI writes: `--collapsible-panel-height`, `[data-starting-style]` /
`[data-ending-style]`, and `[data-panel-open]` on the trigger. A `grid-template-rows: 0fr → 1fr`
transition reproduces the height animation in CSS with no measurement, and the other two become an
`open` boolean. That is roughly thirty lines.

**What it might break.** The spring's feel, if the grid transition is written carelessly.
`Disclosure.test.tsx` asserts `aria-expanded` and the mounted/unmounted content, and a hand-rolled
version passes both — the probe kept the same roles and attributes. The Playwright motion and axe
specs should be run, because they are what would catch a panel that jumps instead of opening.

### 2. Delete the tokens nothing reads — **580 B**

`m3/tokens.css` declares 248 `--md-*` properties. **88 are read by no `.css`, `.ts` or `.tsx` in
`src/`**: every `--md-sys-motion-duration-*` and `--md-sys-motion-easing-*` (the springs are used;
the durations and easings beside them are not), `elevation-level0/4/5`, `shape-corner-none`,
`state-dragged-state-layer-opacity`, and the typescale *parts* — `-font`, `-weight`, `-size`,
`-line-height` — that were superseded by the composed `--md-sys-typescale-*` shorthands, plus eight
`emphasized-*` shorthands nothing draws.

No `--md-sys-color-*` token is in that list, so `m3/theme/scheme.ts`, which writes colour roles onto
the root at runtime, is untouched.

**What it costs the user.** Nothing. **What it might break.** A future screen that wanted a token
that is now gone has to add it back; the M3 set stops being complete-by-construction, which was
arguably the point of shipping all of it. The owner may prefer to keep them and say so.

**Cuts 1 and 2 together measured 146,900 B — 1,580 B under the ceiling.**

### 3. Replace `<HeadContent />` — **1,680 B**

The shell renders TanStack Router's `<HeadContent />` to write one `<title>` per route. That drags
in `Asset.js`, `headContentUtils.js` and their supporting code. Removing it measured
**151,102 → 149,422 B**. The route `head()` functions already produce the string, so a
`useEffect` that assigns `document.title` replaces it in about ten lines and perhaps 150 B, for a
net saving near 1,500 B.

**What it costs the user.** Nothing visible; the tab title still changes per route. **What it might
break.** Anything that reads `<meta>` from the head — nothing does today, every `head()` in
`router.ts` returns only a title — and any test that asserts on head elements rather than
`document.title`. It also spends a maintained feature to save bytes, which is the shape §B1 warns
about, so take it only if cuts 1 and 2 are not enough.

### 4. Drop Tailwind's preflight — 694 B, and not recommended

With `source(none)` and no `@source`, `@import "tailwindcss"` now emits a banner, two font
variables and the preflight reset, and no utilities at all. Removing the import entirely measured
**151,102 → 150,408 B**. A hand-written reset would cost 200–300 B of that back, so the real saving
is near 400 B — for a change that every M3 stylesheet in the repo silently depends on
(`margin: 0`, `list-style: none`, `img { display: block }`, the button font reset). Poor trade.
Named here so the next session does not re-measure it.

### 5. Things that were measured and are not worth doing

- **`scrollRestoration: false`** saves **20 B**. `router-core` imports the module either way.
- **`@floating-ui/utils/dom`** is 799 B in the eagerly preloaded `useRenderElement-*.js`, reached
  through Base UI's `useButton`. Getting it out means taking Base UI out of `m3/button`, which is a
  much larger change than the byte figure justifies.
- **Making `/` a lazy route** would take `Dashboard.tsx` out of what `index.html` names and drop the
  measured number by roughly 8.7 KiB while making the first paint slower. That is gaming the metric.
  Do not.

## Is 145 KiB still the right number?

**Not this note's decision.** The evidence, so the owner can take it:

**For holding the ceiling.** It is reachable today, twice over: cut 1 alone clears it, and cuts 1
and 2 land at 146,900 B with 1,580 B in hand. Neither costs the user anything they can perceive.
The ceiling did its job — it is why this note exists at all, and why xterm, the colour utilities and
nine screens are behind route splits rather than in the entry.

**Against holding it.** 74% of the ceiling is four packages the project has decided to keep, and
109,980 B of that is not negotiable without reversing §B1. Yantra's own first-load JS is about
29,100 B — a fifth of the budget for a shell, a dashboard, eleven primitives and the API layer.
After cuts 1 and 2 the headroom is 1,580 B, which is roughly two more eager components. The next
session that adds a surface to `/` will be back here, and it will not have a 3,637 B cut waiting for
it, because that one is being spent now.

**What an amendment would have to say**, if the owner wants one: not that 145 KiB was wrong, but
that the M14 dashboard grew from four screens to thirteen and the entry chunk's fixed cost —
react-dom, the router, Query — is now 74% of it. That is a premise change upstream of the reasoning,
which is what §B5 asks a dated blockquote on ADR-0024 to record.

## What could not be measured

- **Per-package gzip is apportioned, not weighed.** Modules share a compression window; a package's
  row above is its share of its chunk's raw output scaled by that chunk's gzip ratio. Trust the
  before-and-after cut figures, not the arithmetic difference of two rows in the table.
- **The sourcemap build warns `SOURCEMAP_BROKEN` for `@tailwindcss/vite`.** CSS attribution in this
  note therefore comes from parsing the built stylesheet and re-gzipping it with each block removed,
  not from the map. That method double-counts nothing but does under-report shared prefixes.
- **Cut 3's replacement was not written.** The 1,680 B is what removing `<HeadContent />` saves; the
  ten lines that put the title back were not built, so the net figure is an estimate.
- **No cut was run against the Playwright suite.** The probe builds prove the bytes, not the
  behaviour. Whoever lands Y-370 runs `npm test` and `npm run e2e`.
