# 14 — Material 3 Expressive on the web

Research note for Yantra. Evidence retrieved **2026-09-06**, for the build of the design in
[`docs/design/canvas/`](../design/canvas/BRIEF.md) (Y-332 to Y-336) on the React 19 + Vite 8 app in
`web/`. The question: what does *M3 Expressive, hand-built, small, memory-light* mean in numbers.

> **How the numbers were verified.** Every page under `m3.material.io` renders through JavaScript.
> No fetch tool used here could read one; each returned the page title only. So this note cites the
> guideline URLs and takes the values from the sources Google generates from the same tokens: the
> Compose Material 3 token files (`// GENERATED CODE`), the MDC-Android docs, and the published
> `material-color-utilities` source. Where a number comes from a secondary source, the note says so.

## Summary

- **Expressive is a token update, not a new framework.** Same colour roles, a longer shape scale
  (20, 32, 48 dp added), a second type scale (*emphasized*), springs instead of durations, five button
  sizes, and seven new components. Nothing needs a library; it needs the tables in §1, §4, §5, §6.
- **`@material/material-color-utilities` 0.4.0** builds the full scheme, surface-container tiers
  included, from a seed: **20.2 kB gzip** measured for the TonalSpot path. `SchemeExpressive` exists.
  **Two loud findings:** the package fails under bare Node ESM (a missing `.js` in two imports; Vite
  and esbuild resolve it), and **`palette-sage.json` is not a stock scheme from any seed** — the
  mockup's sage cannot come out of "seed plus variant". It *can* come out of `DynamicScheme` with
  explicit palettes (§2.3), within one or two hex units.
- **Material Web (`@material/web`)** is still "in maintenance mode pending new maintainers" (since
  2024-06-10), still releases (2.5.0 on 2026-07-15), has **no Expressive**, needs Lit, and costs
  14.4 kB gzip for one filled button. No maintained React M3 library exists that is worth the
  dependency. **Hand-build on CSS custom properties** (§3).
- **Google Sans Flex** is on Google Fonts under the OFL with six axes. Google Fonts serves only the
  axes you name: weight-only Latin is 51 kB, weight + optical size is 120 kB, everything is 1.4 MB.
- **Springs map to `linear()`** with no runtime: the curve shape depends only on the damping ratio,
  so four strings and a duration table cover all twelve tokens (§5). Safari 17.2+ / iOS 17.2+.
- **The brief's 44 px targets** are WCAG AAA (2.5.5) and above the AA floor (24 px, 2.5.8), but
  **below Material's 48 dp**. Keep 44 visible, pad the hit area to 48 (§6.3).
- **The brief's type sizes are off the M3 scale** (13 px body, 18 px title, 64 px display do not
  exist in it). "Fully M3 compliant" and "build the mockups as drawn" conflict; §8 lists the choice.

## 1. What Expressive is, and what changed

Google's research statement (design.google): "46 separate research studies … more than 18,000
participants"; expressive design is "the use of color, shape, size, motion, and containment";
participants spotted key elements "up to four times faster". The guideline hub is
<https://m3.material.io/blog/building-with-m3-expressive>.

### 1.1 New and changed components (MDC-Android component docs, Compose tokens)

| Component | What is new | Numbers (dp) |
| --- | --- | --- |
| Buttons | Five sizes, *round* and *square* shape families, corner morph on press | XS 32 · S 40 · M 56 · L 96 · XL 136; square corner M 12 / L 16 / XL 28; pressed corner one step smaller |
| Button group | New. Standard (spaced) and connected; siblings resize on press | spacing 12; pressed child grows `15%` |
| Split button | New. Leading action + trailing menu that spins and morphs | same five sizes; gap 2 |
| FAB | *Medium* added, *small* deprecated; types by size not colour | small 40 (deprecated) · FAB 56 · medium 80 · large 96; corner L 16 / L-increased 20 / XL 28 |
| FAB menu | New; opens from any FAB | items 56 high, corner full, 4 apart |
| Loading indicator | New; replaces most indeterminate circular progress | active 38 in a 48 × 48 container |
| Floating toolbar | New; horizontal or vertical | height 64, corner full, 16 from edges |
| Docked toolbar | New; replaces bottom app bar | height 64 |
| Navigation bar | Shorter; horizontal items at ≥ 600 dp | 80 → **64** (`TallContainerHeight` 80 stays a token); indicator 64 → 56 × 32 |
| Navigation rail | Collapsed and expanded; expanded replaces the drawer | 80 → **96** collapsed (`NarrowContainerWidth` 80 stays); expanded 220–360 |
| Top app bar | *Medium* and *large* deprecated for *medium flexible* and *large flexible* | small 64; medium-flexible 112 (136 large title); large-flexible 120 (152) |
| List item | Expressive shapes by state | one-line 56; hovered corner 12, pressed/selected/focused 16 |

### 1.2 Shape scale (`ShapeTokens.kt`, MDC `Shape.md`)

`none` 0 · `extra-small` 4 · `small` 8 · `medium` 12 · `large` 16 · **`large-increased` 20** ·
`extra-large` 28 · **`extra-large-increased` 32** · **`extra-extra-large` 48** · `full` (50 %).
The three bold entries are the Expressive additions. The brief's 28 px card is `extra-large`; its
999 px pill is `full`. Shape *morphing* (35 new shapes, animated corner and polygon transitions) is
documented at <https://m3.material.io/styles/shape/shape-morph>; the shape count is from a secondary
source (supercharge.design) and the morphing implementation is Compose-only. On the web, the
`corner-shape` property that would draw squircles is Chrome 139 only (Firefox no, Safari preview):
animate `border-radius` between scale steps and stop there.

### 1.3 Colour roles

The scheme getters in `dynamic_scheme.ts`, which are the `--md-sys-color-*` names in kebab case:
`primary`, `on-primary`, `primary-container`, `on-primary-container`, `primary-fixed`,
`primary-fixed-dim`, `on-primary-fixed`, `on-primary-fixed-variant`, `inverse-primary`, and the
same eight for `secondary` and `tertiary`; `error` and its four; `surface`, `surface-dim`,
`surface-bright`, `surface-container-lowest`, `-low`, `surface-container`, `-high`, `-highest`,
`on-surface`, `surface-variant`, `on-surface-variant`, `inverse-surface`, `inverse-on-surface`,
`outline`, `outline-variant`, `shadow`, `scrim`, `surface-tint`, `background`, `on-background`.
The 2025 spec (the Expressive colour spec) adds `primary-dim`, `secondary-dim`, `tertiary-dim`.
`palette-sage.json` already uses this vocabulary.

### 1.4 Motion tokens

Two schemes, each with six springs; the `Standard` scheme is the baseline, `Expressive` is the
recommended default. Values from `ExpressiveMotionTokens.kt` and `StandardMotionTokens.kt`
(damping ratio, stiffness):

| Token | Expressive | Standard |
| --- | --- | --- |
| fast spatial | 0.6, 800 | 0.9, 1400 |
| default spatial | 0.8, 380 | 0.9, 700 |
| slow spatial | 0.8, 200 | 0.9, 300 |
| fast effects | 1.0, 3800 | 1.0, 3800 |
| default effects | 1.0, 1600 | 1.0, 1600 |
| slow effects | 1.0, 800 | 1.0, 800 |

*Spatial* moves, resizes or reshapes; *effects* fades or recolours, and never overshoots. Fast is
for a switch or a button, default for a sheet, slow for a full screen. The duration tokens still
exist for legacy easing: `short1–4` 50–200 ms, `medium1–4` 250–400, `long1–4` 450–600,
`extra-long1–4` 700–1000; `emphasized`, `standard` and their accelerate/decelerate cubic-beziers
(standard is `cubic-bezier(0.2, 0, 0, 1)`).

**Negative:** the MDC-Android Views library documents its six `motionSpring*` attributes with the
**standard** values (0.9 / 1400, 700, 300). Only Compose carries the Expressive set. Do not copy
the Android XML table and call it Expressive.

### 1.5 Type scale

Same fifteen roles as baseline plus fifteen *emphasized* roles; §4 has the table.

## 2. Colour: `@material/material-color-utilities`

### 2.1 Package facts (npm registry, 2026-09-06)

Version **0.4.0**, published 2026-01-21 (the previous release was 0.3.0, 2024-06-24). Apache-2.0,
no dependencies, ESM only (`"module": "index.js"`), unpacked 1.06 MB. Measured with esbuild
(`--bundle --minify`): importing `Hct`, `argbFromHex`, `hexFromArgb` and `SchemeTonalSpot` is
**88.6 kB minified, 20.2 kB gzip**; adding `SchemeExpressive` and `SchemeVibrant` adds 33 bytes gzip
(the schemes share one engine, so the variants are free once one is paid for). The weight is the
CAM16/HCT solver and the 2021 + 2025 colour specs, which cannot be tree-shaken apart.

**Loud negative.** `scheme/scheme_content.js` and `scheme/scheme_fidelity.js` import
`'../dynamiccolor/dynamic_scheme'` with no `.js`, so `import '@material/material-color-utilities'`
**fails under Node 24 with `ERR_MODULE_NOT_FOUND`**. esbuild and Vite resolve it. Vitest externalises
`node_modules` and loads them with Node, so a unit test that imports the package may hit the same
error; the documented fix is `server.deps.inline` (not tested here). Compute the scheme in the
browser, or behind a module the tests can stub.

### 2.2 The API

```ts
import { Hct, argbFromHex, hexFromArgb, SchemeTonalSpot, SchemeExpressive,
         SchemeVibrant, SchemeNeutral, MaterialDynamicColors } from '@material/material-color-utilities';

const seed = Hct.fromInt(argbFromHex('#48674B'));
// (seed, isDark, contrastLevel −1…1, specVersion? '2021' | '2025', platform? 'phone' | 'watch')
const light = new SchemeTonalSpot(seed, false, 0);
const dark  = new SchemeTonalSpot(seed, true, 0);
hexFromArgb(light.surfaceContainerHigh);                    // '#e5e9e1' — the tiers are getters
hexFromArgb(MaterialDynamicColors.surfaceContainer.getArgb(light)); // same value, the long way
new SchemeExpressive(seed, false, 0);                       // exists; Variant.EXPRESSIVE
new SchemeTonalSpot(seed, false, 0, '2025');                // the Expressive colour spec
```

Variants exported: `SchemeTonalSpot` (the Android default), `SchemeExpressive`, `SchemeVibrant`,
`SchemeNeutral`, `SchemeMonochrome`, `SchemeFidelity`, `SchemeContent`, `SchemeRainbow`,
`SchemeFruitSalad`. `scheme_cmf.ts` exists in the source but is not exported from `index.js`.
`contrastLevel` is continuous: 0 standard, 0.5 medium, 1 high, −1 reduced. `specVersion` defaults
to `'2021'`; `'2026'` falls back to `'2025'` for the four common variants. The older
`themeFromSourceColor()` + `applyTheme()` helper on the README **does not emit the surface-container
tiers** (its `toJSON()` stops at `surfaceVariant`): use the `Scheme*` classes and write the custom
properties yourself.

### 2.3 Against `palette-sage.json`

The seed `#48674B` is HCT (151°, chroma 24, tone 41). Run against every stock variant, light and
dark, the file matches 4 of 24 roles at best (the error roles and pure white). TonalSpot forces
chroma 36 and gives `primary #35693F`; its tertiary is teal (`#39656D`), not the beige `#7A6A45`;
Neutral gives `#556254`; Content and Fidelity put the seed into `primary-container`. The surfaces
sit within one or two hex units of TonalSpot's, so the neutrals came from a TonalSpot-like run and
the primary and tertiary were picked by hand. **Consequence:** the Appearance seed picker cannot
reproduce the sage default with "seed + variant". It can with explicit palettes, verified:

```ts
new DynamicScheme({ sourceColorHct: seed, variant: Variant.TONAL_SPOT, contrastLevel: 0, isDark: false,
  primaryPalette:   TonalPalette.fromHueAndChroma(151.2, 24.2),
  tertiaryPalette:  TonalPalette.fromHueAndChroma(89, 19),
  neutralPalette:   TonalPalette.fromHueAndChroma(151.2, 5),
  neutralVariantPalette: TonalPalette.fromHueAndChroma(151.2, 9),
  secondaryPalette: TonalPalette.fromHueAndChroma(151.2, 12) });
// primary #47664A (file #48674B) · primaryContainer #C8ECC8 (#CBE8C6) · tertiary #6C5D39 (#7A6A45)
// surface #F8FAF3 (exact) · onSurface #191D18 (exact) · surfaceContainer #ECEFE8 (#ECEEE6)
```

So: sage is a *custom* scheme with four hue/chroma pairs, and the other seeds (beige, terracotta,
slate, plum, custom hex) can be plain `SchemeTonalSpot`. The dark values in the file were "a first
pass and unreviewed"; the library's dark output is the review.

## 3. Component implementations

**Material Web.** README, verbatim: "MWC is in maintenance mode pending new maintainers". The
announcement (discussion #5642, 2024-06-10, asyncliz): "New features and components are no longer
planned. GitHub PRs will not be accepted by default." The repo is not archived and still ships:
2.5.0 on 2026-07-15 (a custom-elements manifest and labs utility classes), nightlies to 2026-08-29,
last push 2026-09-03. Depends on `lit`, `@lit/context`, `tslib`; 7.9 MB unpacked. Measured:
`filled-button` alone **49.6 kB min / 14.4 kB gzip**; button + icon button + FAB + switch + list +
list item **24.4 kB gzip**. It has no Expressive tokens, sizes or components, and the roadmap has
no owner. Not a candidate.

**React libraries claiming M3 Expressive** (GitHub API, npm, 2026-09-06): `m3you` 0.2.1 (0 stars,
one author); `react-material-expressive` 1.1.2 (2 stars); `material-expressive-react` 0.2.1 (wraps
`@material/web`, so inherits Lit and no Expressive); `actify` 0.5.7 (190 stars, last push
2025-10-26, pulls `react-aria-components`, `motion`, `date-fns`); `@m3e/*` 1.3.1 (222 stars, Lit,
active). None is both maintained by more than one person and React-native. **Verdict: hand-build.**
`@base-ui/react` already covers the hard behaviours (menus, dialogs, popovers, switches); M3 is the
*values* in this note, not a component set. §B1's "battle-tested package first" is met by Base UI
for behaviour; there is no battle-tested package for the look.

## 4. Typography

**Google Sans Flex** is on Google Fonts, `license: ofl`, `isOpenSource: true`, metadata last
modified 2026-07-30 (press coverage puts the open-source release in November 2025). Axes from the
Google Fonts metadata endpoint:

| Axis | Range | Default |
| --- | --- | --- |
| `wght` | 1–1000 | 400 |
| `wdth` | 25–151 | 100 |
| `opsz` | 6–144 | 18 |
| `GRAD` | 0–100 | 0 |
| `ROND` | 0–100 | 0 |
| `slnt` | −10–0 | 0 |

**Google Fonts serves only the axes named in the `css2` query**, and the Latin file grows with each
(measured): `wght@300..1000` 51 kB · `opsz,wght` 120 kB · `GRAD,wght` 69 kB · `ROND,opsz,wdth,wght`
472 kB · all six 1.40 MB. Without `opsz` in the query, `font-optical-sizing: auto` has nothing to
act on; with it, a 64 px display number and a 12 px eyebrow get different drawings for 69 kB more.
`@fontsource-variable/google-sans-flex` 5.3.1 (2026-08-02) self-hosts the same cuts: `wght` 51 kB,
`opsz` 120 kB, `standard` (wght+wdth+slnt) 528 kB, `full` 1.40 MB. The app already self-hosts Geist
through fontsource, so the same path applies. IBM Plex Mono 500 Latin is 10 kB from Google Fonts;
`@fontsource/ibm-plex-mono` 5.3.0 exists (no variable cut). Fallback stack: `"Google Sans Flex",
"Google Sans", Roboto, system-ui, sans-serif`; the mockups use `"Instrument Sans"` second, which is
a Google Font too and not on the user's machine, so drop it.

**Type scale** (`TypeScaleTokens.kt`; size / line height in px, tracking in px). *Brand* is the
display face (Google Sans Flex here), *Plain* the text face; M3 lets them be the same family.

| Role | Size / line | Baseline weight, tracking | Emphasized weight, tracking | Face |
| --- | --- | --- | --- | --- |
| display-large | 57 / 64 | 400, −0.2 | 500, 0 | Brand |
| display-medium | 45 / 52 | 400, 0 | 500, 0 | Brand |
| display-small | 36 / 44 | 400, 0 | 500, 0 | Brand |
| headline-large | 32 / 40 | 400, 0 | 500, 0 | Brand |
| headline-medium | 28 / 36 | 400, 0 | 500, 0 | Brand |
| headline-small | 24 / 32 | 400, 0 | 500, 0 | Brand |
| title-large | 22 / 28 | 400, 0 | 500, 0 | Brand |
| title-medium | 16 / 24 | 500, 0.2 | 700, 0.15 | Plain |
| title-small | 14 / 20 | 500, 0.1 | 700, 0.1 | Plain |
| body-large | 16 / 24 | 400, 0.5 | 500, 0.15 | Plain |
| body-medium | 14 / 20 | 400, 0.2 | 500, 0.25 | Plain |
| body-small | 12 / 16 | 400, 0.4 | 500, 0.4 | Plain |
| label-large | 14 / 20 | 500, 0.1 | 700, 0.1 | Plain |
| label-medium | 12 / 16 | 500, 0.5 | 700, 0.5 | Plain |
| label-small | 11 / 16 | 500, 0.5 | 700, 0.5 | Plain |

Emphasized never changes size or line height: display to title-large go 400 → 500, everything
else one weight up. The custom-property names are `--md-sys-typescale-<role>-<size|line-height|
weight|tracking>` and `--md-sys-typescale-emphasized-<role>-…`.

**Against the brief:** display 64/44 Bold, title 18 SemiBold, row 14/15 Medium, body 13, meta 12,
eyebrow 12 uppercase. 64, 44 (as a size), 18, 15 and 13 are not on the scale, and Bold (700) is
above the emphasized display weight (500). The nearest legal mapping: hero number → display-large
emphasized (57) on desktop and display-small emphasized (36) on the phone; card title → title-large
emphasized (22) or title-medium emphasized (16); row title → body-medium emphasized (14, 500); body
→ body-medium (14); meta → body-small (12); eyebrow → label-medium (12, 500). The uppercase eyebrow
with 0.8 px tracking is not an M3 style at all. This is the one place "as drawn" and "compliant"
disagree; the owner should pick (§8).

## 5. Motion on the web

A spring with mass 1, stiffness *k* and damping ratio ζ has a response whose *shape* depends only on
ζ; *k* only scales time. So the twelve tokens need four `linear()` curves and a duration table.
Settle time below is when the curve stays within 0.1 % of its target (computed here):

| ζ | Used by | Settle (ms) | Overshoot |
| --- | --- | --- | --- |
| 0.6 | expressive fast spatial | 360 | 9.5 % |
| 0.8 | expressive default / slow spatial | 435 / 600 | 1.5 % |
| 0.9 | standard fast / default / slow spatial | 224 / 317 / 484 | 0.2 % |
| 1.0 | all effects (fast / default / slow) | 150 / 231 / 327 | none |

```css
/* ζ 0.6 — expressive fast spatial, 360ms */
--md-sys-motion-spring-fast-spatial: linear(0, 0.075, 0.249, 0.458, 0.659, 0.827, 0.952, 1.034,
  1.078, 1.094, 1.091, 1.076, 1.056, 1.037, 1.02, 1.007, 0.998, 0.993, 0.991, 0.991, 0.992,
  0.994, 0.996, 0.998, 1);
/* ζ 0.8 — expressive default 435ms, slow 600ms */
--md-sys-motion-spring-default-spatial: linear(0, 0.052, 0.17, 0.316, 0.464, 0.598, 0.712, 0.804,
  0.875, 0.927, 0.964, 0.988, 1.003, 1.011, 1.014, 1.015, 1.014, 1.012, 1.01, 1.008, 1.006,
  1.004, 1.003, 1.002, 1);
/* ζ 1.0 — effects: fast 150ms, default 231ms, slow 327ms */
--md-sys-motion-spring-effects: linear(0, 0.058, 0.18, 0.321, 0.455, 0.573, 0.671, 0.75, 0.812,
  0.86, 0.897, 0.924, 0.945, 0.96, 0.971, 0.979, 0.985, 0.989, 0.992, 0.994, 0.996, 0.997,
  0.998, 0.999, 1);
```

Twenty-four stops each; the standard scheme (ζ 0.9) is a near-ease-out and not needed here. The
Chrome team's Linear Easing Generator produces the same strings from any JS easing.

**Which is lightest.** `linear()` in a CSS transition: 0 bytes, off the main thread for
`transform` and `opacity`, enough for a press, a chip select, a card expand and a nav indicator.
Its one loss against a true spring is *retargeting*: an interrupted transition restarts with zero
velocity, a spring carries momentum. That matters for drag-to-dismiss and a FAB menu closed
mid-open, nowhere else on these boards; the Web Animations API with the same string handles those
without a library. A spring library is the only option that costs bundle; do not add one.

**View Transitions** (`document.startViewTransition`) cover the route change and the shared-element
move from a row to its session screen: Chrome 111, Safari 18 / iOS 18, Firefox 144; the
`{types, update}` options form is Chrome 125 / Safari 18.2 / Firefox 147. React 19's
`<ViewTransition>` wraps it. `@starting-style` for enter animations without JS: Chrome 117,
Safari 17.5, Firefox 129. **Safari iOS:** `linear()` 17.2, View Transitions 18.0, `@starting-style`
17.5 (BCD marks `safari_ios` as mirroring desktop Safari). Every one is behind current iOS by two
major versions. Honour `prefers-reduced-motion: reduce` by setting the spatial durations to 0 and
keeping the effects (fades) — Material's own guidance is to remove movement, not feedback.

## 6. Navigation and sizes

### 6.1 Navigation bar (phone)

Expressive height **64 dp** (`ContainerHeight`), with `TallContainerHeight` 80 kept for the old
layout; 3–5 destinations; active indicator 56 × 32, corner full, icon 24, 4 dp icon-to-label, 6 dp
top and bottom padding. **The brief draws 80.** Both are tokens; 64 is the Expressive one, and the
phone boards would gain 16 px of content by taking it. Horizontal items (icon beside label,
indicator 40 high) only at ≥ 600 dp, which is the tablet, where the rail is used instead.

### 6.2 Navigation rail (tablet)

Collapsed **96 dp** (`ContainerWidth`), `NarrowContainerWidth` 80 for the old rail; expanded
220–360 dp, modal expanded corner large (16); top space 44; item 64 high, 4 apart; 3–7
destinations collapsed. The brief's 80 px rail is the baseline width, valid but pre-Expressive.
Elevation moved 0 → 3 dp in Expressive; the brief says no shadows, so use `surface-container-low`
as the rail tint and keep it flat (a tonal step is the M3 way to show elevation without a shadow).

### 6.3 FAB, app bars, toolbars, targets

FAB 56 (corner 16), medium 80 (corner 20), large 96 (corner 28); extended FAB matches by height;
small 40 is deprecated. Small top app bar 64; medium-flexible 112 (136 with a large title);
large-flexible 120 (152). Floating toolbar 64 high, corner full, 16 from the edge; docked 64.
Buttons XS 32, S 40, M 56, L 96, XL 136; the brief's 44 px pills fall between XS and S and match
no token, S (40) with a 48 hit area is the nearest.

**Touch targets.** Material: 48 × 48 dp, and Compose's `minimumInteractiveComponentSize()` reserves
exactly that; WCAG 2.2 SC 2.5.8 (AA) is 24 × 24 CSS px with a spacing exception; SC 2.5.5 (AAA)
is 44 × 44. The brief's 44 clears the law and misses Material by 4 px on each side. A 40 dp icon
button inside a 48 dp target is how Material itself resolves this: keep the drawn 44, extend the
hit area to 48 with padding or a `::before` inset of −2 px, and let the axe `target-size` rule
(§7) enforce the 24 px floor in CI.

## 7. Accessibility

**What the scheme guarantees** (contrast curves in `color_spec_2021.ts`, value at contrast level 0):
`on-primary` on `primary` 4.5:1 (curve 4.5 / 7 / 11 / 21); `on-primary-container`,
`on-secondary-container`, `on-tertiary-container` on their containers 4.5:1 (3:1 at reduced
contrast); `outline` on surface 3:1; **`outline-variant` 1:1** and **`primary-container` on surface
1:1**, so neither a container tint nor an `outline-variant` border may be the only signal of a
state or the only edge of a control. That is the brief's mark-plus-word rule with a number on it.
Contrast level 0.5 lifts text to 7:1 and outlines to 4.5:1; 1.0 to 11:1 and 7:1. The 4.5:1 for
text and 3:1 for UI and large text are WCAG 1.4.3 and 1.4.11 verbatim.

**Focus.** Material Web's focus-ring tokens: 3 px `secondary` ring, 2 px outward offset, corner
full, animates over `duration-long4` (600 ms) with an 8 px active flash. On the web that is
`outline: 3px solid var(--md-sys-color-secondary); outline-offset: 2px` under `:focus-visible`,
which also satisfies WCAG 2.4.7 (AA) and the 2 px / 3:1 minimum of 2.4.13 (AAA).

**What axe catches, run through `@axe-core/playwright`** (rule descriptions, axe 4.13):
`color-contrast` (wcag2aa, 1.4.3; reports *needs review* on gradients and images),
`color-contrast-enhanced` (wcag2aaa), `button-name` and `aria-command-name` (4.1.2 — every icon
button needs an accessible name), `target-size` (wcag22aa, 2.5.8; **runs only when the `wcag22aa`
tag or the rule is requested**, so `.withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa'])`),
`focus-order-semantics` (best-practice, experimental, off by default). **What it will not catch:**
invisible focus rings, state carried by colour alone, 1.4.11 contrast on the custom marks,
reduced-motion handling, and a hit area of 44 not 48. Those need Playwright scripts: tab through
a page and assert `:focus-visible` bounds, `page.emulateMedia({ reducedMotion: 'reduce' })` and
assert no transform transitions, and a contrast check of the five marks on every surface tier.

## 8. Negative findings

1. **No fetch tool reads `m3.material.io`.** Every guideline page is JS-rendered. This note's
   numbers come from Google's generated token sources, which is the better citation anyway.
2. **`palette-sage.json` is not a seed scheme.** No exported variant produces it from `#48674B`;
   TonalSpot gives a brighter green and a teal tertiary. Four explicit tonal palettes do (§2.3).
3. **`material-color-utilities` 0.4.0 breaks under bare Node ESM** (missing `.js` in two imports).
   Bundlers hide it; Vitest may not.
4. **The Android Views "spring" attributes are the *standard* scheme.** Expressive values are only
   in Compose (`ExpressiveMotionTokens.kt`). Most blog posts copy the wrong table.
5. **Material Web is not dead, but it is not Expressive either**: a release two months ago, a
   README that still says maintenance mode, no Expressive tokens, and Lit under it.
6. **Google Fonts serves only the axes you ask for.** "Add Google Sans Flex" is 51 kB or 1.4 MB
   depending on the query string; the default Google Fonts embed gives weight only.
7. **The brief's type sizes and its 44 px targets are not M3 tokens.** Body 13, title 18, display
   64, hit 44, nav bar 80, rail 80, pill 44 are all near a token and equal to none. The owner has
   to choose between *drawn* and *compliant* for those seven numbers; everything else in the brief
   (28 px cards, `full` pills, tonal surfaces, no shadows) is Expressive as specified.
8. **`outline-variant` has no contrast guarantee.** The brief uses it for dividers and one
   outlined card; fine for decoration, not for a control's only edge.
9. **Shape morphing does not travel.** `corner-shape` is Chrome-only; squircles and the 35-shape
   library stay in Compose and Figma. `border-radius` transitions between scale steps are the web
   equivalent.
10. **The small FAB and the medium/large app bars are deprecated.** The phone boards use a regular
    56 FAB and a small app bar, so nothing on the canvas is affected; do not add them later.

## Sources

Accessed 2026-09-06 unless noted.

- M3 Expressive hub — <https://m3.material.io/blog/building-with-m3-expressive> (JS-rendered; title only)
- Motion specs — <https://m3.material.io/styles/motion/overview/specs>; shape scale —
  <https://m3.material.io/styles/shape/corner-radius-scale>; shape morph —
  <https://m3.material.io/styles/shape/shape-morph>; type tokens —
  <https://m3.material.io/styles/typography/type-scale-tokens> (all JS-rendered; title only)
- Google research statement — <https://design.google/library/expressive-material-design-google-research>
- Compose Material 3 tokens (generated), branch `androidx-main` —
  <https://github.com/androidx/androidx/tree/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens>:
  `ExpressiveMotionTokens`, `StandardMotionTokens`, `MotionTokens`, `TypeScaleTokens`, `ShapeTokens`,
  `NavigationBar*`, `NavigationRail*`, `Fab*`, `AppBar*`, `FloatingToolbar`, `DockedToolbar`,
  `Button*`, `LoadingIndicator`, `List`; `MotionScheme.kt` and `InteractiveComponentSize.kt` one level up
- MDC-Android docs — <https://github.com/material-components/material-components-android>:
  `docs/theming/{Motion,Shape}.md`, `docs/components/{BottomNavigation,NavigationRail,
  FloatingActionButton,TopAppBar,ButtonGroup,SplitButton,FloatingToolbar,LoadingIndicator}.md`
- material-color-utilities — <https://github.com/material-foundation/material-color-utilities>
  (`typescript/README.md`, `dynamiccolor/{dynamic_scheme,color_spec_2021,color_spec_2025}.ts`,
  `scheme/scheme_expressive.ts`); npm registry; sizes and outputs measured with esbuild and Node 24
- Material Web — <https://github.com/material-components/material-web> README, discussion #5642,
  release v2.5.0, npm registry, `tokens/_md-comp-focus-ring.scss`; bundle sizes measured
- React candidates — GitHub API and npm registry for `m3you`, `react-material-expressive`,
  `material-expressive-react`, `actify`, `@m3e/core`
- Google Sans Flex — <https://fonts.google.com/specimen/Google+Sans+Flex>, the
  `fonts.google.com/metadata/fonts/Google Sans Flex` endpoint, `css2` responses and woff2 sizes
  measured, `@fontsource-variable/google-sans-flex` 5.3.1 file listing
- `linear()` — <https://developer.chrome.com/docs/css-ui/css-linear-easing-function>; MDN
  browser-compat-data `css/types/easing-function.json`, `api/Document.json`,
  `css/at-rules/starting-style.json`, `css/properties/corner-shape.json`
- WCAG 2.2 — <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html> and
  `target-size-enhanced.html`; axe-core —
  <https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md>
- Secondary (component list and shape count only): 9to5google, supercharge.design, ProAndroidDev
  posts on M3 Expressive, 2025
