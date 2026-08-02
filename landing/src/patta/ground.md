# patta/ground.css

Three surface classes. Load `tokens.css` first; every colour derives from a token.

- **`.patta-cloth`** — the interior field: tamarind-primed cloth, weave + slow mottle + an
  edge drift toward `--patta-deep`. Works as a background on any block element.
- **`.patta-band`** — the lighter cream ground the border tiles sit on. Same weave at
  `--patta-grain: 0.3`, no drift.
- **`.patta-rule`** — the double rule between band and field: `--line-pen` ink, 2px `--band`
  gap, `--line-rule` ink. Add `.patta-rule--v` for the vertical edge; it stretches, so it
  needs a flex or grid parent.

Override `--patta-grain` (default `1`) on either ground to scale the whole texture.

## Periods — nothing in 60–250px, where the eye counts repeats

- **Weave 3 / 4 / 7 / 11px** — pairwise co-prime, so the pitches beat over 3·4·7·11 = 924px.
  That beat *is* the mid-scale slub, for two gradients instead of a lattice of blobs.
- **Cloud 887 / 941 / 1013 / 1063 / 1103 / 1201 / 1279 / 1447px** — all prime, hence pairwise
  co-prime (period ~2e24px), and each longer than a viewport axis, so no single layer
  repeats often enough to read as a tile.

## Rejected, with reasons

- **`feTurbulence`** — Chromium tiles the filter region, leaving a rectangular patch seam.
- **Co-prime sizes alone** — they stop the *stack* repeating but not a single layer's own
  lattice. One blob per 89px cell reads as a grid whatever its neighbours do.
- **`--ink` as the dark half of the pair** — `--ink` is the *light* token in dark mode, so the
  pair stops straddling the ground and the weave collapses to scanlines. `--patta-deep` /
  `--shankha` straddle in both themes; plain alpha then needs no blend mode (an `overlay`
  tuned on cream goes muddy on near-black).
- **`block-size: 100%` on `--v`** — resolves to 0 against an indefinite parent and suppresses
  flex stretch; the rule vanishes. Use `auto` + `align-self: stretch`.

Measured light cloth high-pass std 3.09/255 vs the reference patta's 3.03. Nothing animates.
