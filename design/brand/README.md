# Brand

The owner approved these assets on 2026-09-13. This directory holds the sources, so a later
change can re-render them instead of redrawing them.

## What each file is for

- `readme-banner.png` — the root [`README.md`](../../README.md) heading.
- `social-preview.jpg` — GitHub's repository social preview. GitHub has no API for this: the owner
  uploads it by hand, in Settings → General → Social preview.
- `mark.webp` — the mandala mark. It feeds `cards.html`, and it is the source for a landing
  `og.jpg` and for the dashboard's icons when that work happens.
- `icon.svg`, `icon-32.svg`, `icon-16.svg`, `icon-maskable.svg` — the mark drawn per size, for
  favicons and app icons. Not yet wired into `landing/public/` or `web/public/`.
- `cards.html`, `render.mjs` — the template and the script that render the two rasters above.

## The owner's rulings, 2026-09-13

- The cards frame Vishvakarma at the left of the painting. Never mirrored.
- The banner is the mark plus the wordmark, on M3 Expressive shapes drawn from the brass scheme.
- Icons are drawn per size, not scaled from one drawing: 16 px carries no ring and no triangle,
  32 px carries no triangle, and the full drawing starts at 48 px.
- The maskable icon's motif sits inside the central 80% circle, so a host that crops to a circle
  keeps it whole.

## Re-rendering

`cards.html` needs `landing`'s fonts and painting, so `npm ci` in `landing/` and in `web/` (for
`playwright-core`, mounted into the container) come first — `just brand` runs both. It renders in
the pinned image the web e2e baselines already use ([`web/README.md`](../../web/README.md)), so a
developer's own fonts never enter a screenshot:

```sh
just brand
```

That is:

```sh
cd web && npm ci
cd landing && npm ci
podman run --rm -v "$PWD/..:/work" \
  -v "$PWD/../web/node_modules:/nm:ro" \
  -w /work mcr.microsoft.com/playwright:v1.63.0-noble \
  node design/brand/render.mjs
```

It overwrites `readme-banner.png` and `social-preview.jpg` in place. Font rasterization is not
byte-for-byte stable across runs; `magick compare -metric RMSE` against the checked-in files reads
about 0.011 for the banner and 0.018 for the social preview — visually the same, not identical
bytes.
