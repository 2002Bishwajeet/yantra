# Yantra design system — Pattachitra

**Status:** in use by the landing site (`landing/`). Adoptable by the M4 dashboard — see §7.

The tokens are [`design/tokens.css`](../design/tokens.css) and that file is the source of truth.
This document explains the reasoning; where the two disagree, the CSS wins.

---

## 0. What this does and does not settle

It settles **what Yantra looks like**: pigments, type, line weight, motif vocabulary, and the
two grounds. It is deliberately plain CSS custom properties — no Tailwind, React, Astro or build
step — so it costs nothing to adopt.

It settles **nothing about how the dashboard is built.**
[ADR-0014](adr/0014-react-with-the-compiler-for-the-web-ui.md) answered that separately, and the
two decisions meet cleanly: it picks **plain CSS + CSS custom properties** as the styling layer,
and it left *"what the incoming design system is delivered as"* deliberately open between CSS
variables, a Tailwind preset, and React components. **This is the first of those three** — which is
also the one that keeps ADR-0014's promise that the diff when the design system lands is
`index.css` and nothing else.

---

## 1. The thesis

A *yantra* is two things at once: a machine or instrument, and a sacred geometric diagram used as
a focus for attention. The project is named for the first meaning. The design leans on the second.

So the page is a **patta** — a single painted cloth — and the figure enshrined in its arch is not a
deity but the diagram itself, drawn live by a fragment shader. Folk frame, computed core. That
tension is the whole identity; every choice below serves it, and anything that dilutes it into
generic "warm cream + serif + terracotta" should be rejected.

Source of the vocabulary: an Odisha Pattachitra of an arched shrine, whose actual conventions are
copied rather than approximated — see §4.

---

## 2. Pigments

Named for the **material**, not the role. A chitrakar names the pigment; naming it `--primary-500`
would throw away the only thing that makes this palette not arbitrary.

| Token | Hex | Traditional source | Used for |
| --- | --- | --- | --- |
| `--patta` | `#D0A87F` | tamarind-treated cloth | the ground of everything |
| `--patta-lit` | `#DFC1A0` | cloth catching light | raised panels, border bands |
| `--patta-deep` | `#B98E63` | cloth in shadow | recesses |
| `--kalam` | `#101010` | *kala*, lamp soot | **every** structural line |
| `--hingula` | `#BB1F15` | *hingula*, cinnabar | accents, buds, the one hot note |
| `--haritala` | `#D8A611` | *haritala*, orpiment | ornament points, jewellery |
| `--haritala-lit` | `#F4E02C` | brighter orpiment | bud centres, small highlights |
| `--sabaja` | `#227845` | *sabaja*, boiled leaves | foliage only — never UI |
| `--neela` | `#345C9F` | *khandaneela*, indigo | held in reserve (the deity's skin) |
| `--halo` | `#FF8000` | specific to the source piece | the arch interior, and only the arch |
| `--shankha` | `#FAF0E6` | *shankha*, conch shell | eye-whites, tiny ornament points |

**Roles** (`--ink`, `--ground`, `--panel`, `--accent`, `--rule`) point at pigments. Components
reference roles, never pigments, so a re-ground is a token edit rather than a component edit.

Two rules that are easy to break and expensive to unbreak:

- **`--sabaja` is foliage, not a status colour.** The moment green means "healthy" it stops being
  a leaf and the palette starts drifting toward a generic dashboard. M4 needs semantic colour; it
  should derive it (§7), not annex the pigments.
- **`--halo` fills the arch and nothing else.** It is the strongest colour in the system. Spending
  it anywhere else flattens the one place the eye is supposed to land.

---

## 3. The two grounds

Not an inversion — a **repaint**. The day patta is treated cloth with lamp-soot line. The night
patta is the same cloth blacked, with conch-white line and the accents left hot.

```
              day                night
ground        #D0A87F            #191108
line          #101010            #F0E2C8
accent        #BB1F15            #E5432F
halo alpha    .92                .34        ← the niche burnishes rather than glares
cloth blend   multiply           screen     ← texture darkens by day, lifts by night
```

**Contract.** `prefers-color-scheme` carries the OS preference; the viewer's own toggle stamps
`data-theme="dark"|"light"` on the root and must win over the media query **in both directions**.
Both are therefore spelled out in `tokens.css` rather than left to the cascade. No component ever
appears inside a theme block — only tokens are redefined.

---

## 4. Motifs

Four forms, taken from the reference painting. All are **generated from parameters**, never
hand-authored path data — hand-authored folk motifs come out wobbly and off-register, and a
parameter is reviewable in a way that 400 path coordinates is not.

**The running vine** (`Vine`). One S-wave stem; alternating spiral curls; a cinnabar teardrop bud
and an orpiment dot at each curl; paired leaves off the stem. Tiles horizontally; rotated 90° for
the vertical bands. This is the page's frame on all four edges.

**The corner rosette** (`Rosette`). Concentric petal ring with 12 ruled spokes, a halo-orange
centre and a cinnabar bindu. Sits over the seam where two border bands meet.

**The cusped arch** (`Arch`). A half-ellipse whose radius is modulated by `1 − amp·|sin(N·θ)|`.

> Two findings worth keeping, both learned by getting them wrong:
>
> - **`N` must be even.** `|sin(N·θ)|` then vanishes at `θ = 0, π/2, π`, putting a cusp at each
>   springing *and* at the apex. An odd `N` scoops the apex into a dome.
> - **Cusp the inner rim only, never the silhouette.** The reference's outer line is a calm arch;
>   only the rim is foiled. Cusping both turns a shrine into a sunburst.

**The hanging lamp** (`Lamp`). Hairline stem, flared bell, clapper. Mirrored pairs at matched
drops — unmatched drops read as a mistake rather than as rhythm.

Support: a **pearl band** rides between the arch's two structural lines and down the jambs, and a
**bindu-in-triangle** sigil (the smallest complete yantra there is) serves as the wordmark glyph.

---

## 5. Line and type

**Line.** Pattachitra linework is uniform-weight and never tapers. Three weights, no more:
`--line-hair` (1px, detail), `--line-pen` (1.5px, standard), `--line-contour` (3.5px, structure).

**Type.** Three faces, each earning its place:

| Role | Face | Why |
| --- | --- | --- |
| Display | **Rozha One** | A Devanagari didone. Its thick/thin contrast is the closest type gets to a brush-loaded kalam, and it carries Latin, so यन्त्र and "Yantra" sit in one lockup. |
| Body | **Anek Devanagari** (variable) | The quiet floor. The only one of the three that stays legible at 14px in both scripts. |
| Utility | **IBM Plex Mono** | The modern/technical note the folk frame is set against. Uppercase, tracked, for labels and meta only. |

All three are self-hosted via `@fontsource`. Scale is `--step--1` … `--step-3` — sparse on purpose.

> **On Sarvam AI.** Their site was checked as a reference for Indic type and is **not** a model to
> follow. It self-hosts three commercial Displaay faces (Matter, Season Mix, Matter Semi Mono) —
> not licensable here — and, for a company whose pitch is Indian-language AI, loads **no Devanagari
> webfont at all**; Devanagari falls back to system fonts. Their wordmark is custom-drawn, so it is
> not a licensable face either.

---

## 6. Motion

Ambient, slow, and never the reason to look. The diagram turns at ~0.012 rad/s — you notice it
only if you stay. The bindu breathes on a 3.4s cycle. Nothing else moves.

`prefers-reduced-motion: reduce` renders **one static frame** rather than nothing. Blanking a
visual is a regression, not an accommodation. The shader also listens for `change` on the query so
the toggle takes effect live, and pauses via `IntersectionObserver` when scrolled out of view.

---

## 7. Extending this for M4

The dashboard is a different job: scanned and operated, not read. Inherit the identity, add what a
UI needs, and do not bend the pigments into roles they cannot hold.

**Import as-is** — `design/tokens.css` is plain CSS with no framework dependency, so this is one
line from the dashboard's `index.css`.

### The one known collision: `--accent`

[ADR-0014](adr/0014-react-with-the-compiler-for-the-web-ui.md) chose **shadcn/ui in
`cssVariables: true` mode**. shadcn defines its own `:root` token set, and exactly one name
overlaps with this one — but it is the worst possible one to get wrong silently:

| Token | Here | shadcn |
| --- | --- | --- |
| `--accent` | cinnabar, the one hot note | a **muted hover surface**, paired with `--accent-foreground` |

Both are `:root`, so whichever stylesheet loads second wins, and there is no error either way.
Import this file second and every hover surface in the dashboard turns cinnabar; import it first
and `--accent` here quietly becomes a near-neutral. **Bridge it, do not let the cascade decide:**

```css
/* index.css — the whole integration, per ADR-0014 */
@import "../../design/tokens.css";

:root {
  --background: var(--patta);      --foreground: var(--kalam);
  --card:       var(--patta-lit);  --card-foreground: var(--kalam);
  --primary:    var(--hingula);    --primary-foreground: var(--shankha);
  --border:     var(--rule);       --ring: var(--hingula);
  --accent:     var(--patta-lit);  /* shadcn's meaning wins for shadcn's name */
  --accent-foreground: var(--kalam);
}
```

Then reach for `--hingula` directly where the *pigment* is wanted. The rest of this file's names
(`--patta`, `--kalam`, `--hingula`, …) are Odia pigment words and collide with nothing.

The other four role tokens here — `--ink`, `--ground`, `--panel`, `--rule` — do not appear in
shadcn's set. They are left unprefixed deliberately: namespacing all of them to guard against a
consumer that does not exist yet is the speculative work §A2 of `CLAUDE.md` forbids, and the real
collision is one line, now written down.

**Adopt directly:** the two grounds and their contract (§3); the three faces and the scale; the
three line weights; the double rule as a register separator; the cloth and fleck surfaces.

**Add, because a dashboard needs them and this system does not have them:**

- **Semantic colour.** `good` / `warn` / `critical`, kept *separate* from `--accent` and derived so
  they sit on both grounds. Do not repurpose `--sabaja`; derive a green that is legibly not foliage.
- **Density tokens.** Row heights, cell padding, a tighter type step below `--step--1`. The landing
  page is one screen; the dashboard is tables.
- **State encoded in form as well as colour** — a pill, a chip, a severity stripe — so what needs
  attention reads at a glance and survives both grounds.
- **Age display.** Every reading in the M4 snapshot has an age
  ([ADR-0013](adr/0013-the-heartbeat-carries-only-what-placement-scores.md)); staleness needs a
  visual treatment, and it is closer to a tint ramp than to a semantic colour.

**Do not carry over:** the border frame and the shrine niche. They are a *coming-soon* gesture —
one screen, one thing to look at. A dashboard framed in vines is a dashboard you cannot read. The
motif vocabulary should survive there as accents and empty states, not as chrome.

**Leave the arch to the landing page.** If the dashboard wants a signature, the bindu-in-triangle
sigil is the piece that scales down.

---

## Sources

- Reference painting: Odisha Pattachitra, arched shrine with scroll borders —
  `gitagged.com/wp-content/uploads/2021/03/OPC-01-TOL-KRISHNA-2-5.jpg` (accessed 2026-08-01).
- Palette brief supplied by the repo owner, 2026-08-01, with traditional pigment references.
- Sarvam AI typography inspected at `sarvam.ai` and `sarvam.ai/brand` (accessed 2026-08-01);
  faces identified from `/_astro/CookieConsent.B9R_l8_3.css`.
- Shader component structure informed by `github.com/DavidHDev/canvas-ui` (MIT + Commons Clause —
  adaptable, **not** redistributable as a component library) and its sibling `react-bits`
  (accessed 2026-08-01).
