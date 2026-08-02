# patta — the Pattachitra drawing stacks

Framework-free modules that draw the painted frame. Pure functions returning SVG markup
strings: no imports, no DOM, no build step assumed, and **every colour via a custom property**
so a re-ground is a token edit.

| file | exports | what it draws |
| --- | --- | --- |
| `border.ts` | `floretTile` · `cornerPanel` · `borderFrame` | the floret tile band and the full four-edge frame |
| `torana.ts` | `torana` · `lamp` · `spandrelRosette` | the cusped gate, its jambs, lamps and rosettes |
| `instrument.js` | `jaiPrakash` · `sunPosition` | the hemispherical bowl, read against the viewer's real sky |
| `tokens.css` | — | the palette, sampled from the reference photograph |
| `ground.css` | `.patta-cloth` · `.patta-band` · `.patta-rule` | the cloth and cream surfaces (see `ground.md`) |

## Status

**These are not wired into the site yet.** `src/pages/index.astro` still renders the previous
design. Both exist deliberately: replacing the page also means rewriting the Playwright
baselines, and what goes inside the frame is still an open decision.

## Where the values come from

Everything is measured against an Odisha Pattachitra of the Nabagunjara
(`gitagged.com` `OPC-01-TOL-NABAGUNJARA-1-2-1.jpg`, accessed 2026-08-02), not eyeballed.
Palette values are the top-decile-saturation mean of each hue family across the whole image.

## Things that were got wrong first, and cost real time

- **A Bézier aimed at its own endpoint always arrives as a spike.** That is why the first
  petals came out as thorns. `almond()` uses a width profile truncated by a real semicircular
  cap instead.
- **Cells must stay square.** The tiles carry `preserveAspectRatio="none"`, so any caller that
  makes `tile ≠ band` stretches every floret. Density scales both together.
- **Co-prime background sizes do not stop tiling on their own.** They kill the combined
  super-period, not a single layer's own lattice. `ground.css` leaves 60–250px empty.
- **`feTurbulence` is unusable for a full-page ground** — Chromium tiles the filter region and
  leaves a rectangular seam.
- **`--ink` is the wrong half of a texture pair**: it is the *light* token on the dark ground,
  so the pair stops straddling and the weave collapses into scanlines.
- **There is no second border band.** The leafy creeper belongs to the arch's spandrel, inside
  the field. It only looks like a border if you crop the top edge, where the arch runs
  near-horizontal.
- **Both rims of the torana band are cusped equally**, and the apex needs a *local* tent
  (half-width ~0.15 rad) — an even lobe count alone still reads as a dome.

`cornerPanel` is exported but unused: the reference has no corner panels, all four corners are
ordinary florets. It is kept only because removing an export is a breaking change.
