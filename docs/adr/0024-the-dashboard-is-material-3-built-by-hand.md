# ADR-0024 — The dashboard is Material 3, built by hand on Base UI, TanStack and tokens

- **Date:** 2026-09-06
- **Status:** accepted (2026-09-06, by the owner's instruction — Y-337)
- **Supersedes** the *Components* and *Styling* rows of
  [ADR-0014](0014-react-with-the-compiler-for-the-web-ui.md) and its seam sentence. It keeps
  ADR-0014's Framework, Optimisation, Build and Lint rows unchanged.
- **Evidence:** [R14](../research/14-material-3-expressive-on-the-web.md), the two inventories
  [m14-screen-inventory.md](../plans/m14-screen-inventory.md) and
  [m14-rust-inventory.md](../plans/m14-rust-inventory.md).

## Context

The owner redesigned the dashboard in Material 3 Expressive: sixty-five artboards on the canvas
(Y-332 to Y-336, merged in #247), a sage scheme in `palette-sage.json`, and the rules in
[`BRIEF.md`](../design/canvas/BRIEF.md). On 2026-09-06 the owner asked for the build: React 19,
"full TanStack", fanned-out subagents with one role each, minimal comments, **"fully Material 3
compliant"**, a stack that is "memory efficient and less bundling", and every screen tested end to
end. The owner also lifted §A3's keep-dead-code rule for `web/` the same day.

ADR-0014 said the design system would land as `index.css` and nothing else, and that if it turned
out to be more the ADR "was wrong and should be superseded rather than quietly worked around". It
is more. The boards change the information architecture, add a navigation rail and a bottom bar,
a stepper, sheets, a chat surface and Appearance, and they use a type scale and motion D3 §5.4 and
§9.2 forbade. So this is the supersession ADR-0014 asked for.

R14 measured what the web has to offer for Material 3 in 2026:

- Material Web (`@material/web` 2.5.0) is in maintenance mode, needs Lit, has no Expressive, and
  costs 14.4 kB gzip for one button. No maintained React Material 3 library exists.
- `@material/material-color-utilities` 0.4.0 builds the whole scheme from a seed, including the
  surface-container tiers and `SchemeExpressive`, for 20.2 kB gzip. `palette-sage.json` matches no
  stock variant; it is reproducible with `DynamicScheme` and four explicit tonal palettes.
- Expressive motion is twelve spring tokens whose curves depend only on the damping ratio, so they
  are four CSS `linear()` strings and a duration table, at no runtime cost. Safari 17.2 and up.
- Google Sans Flex is OFL and on Google Fonts; `@fontsource-variable/google-sans-flex` exists for
  self-hosting. The weight-only latin face is about 51 kB.
- Seven of the brief's numbers are near a Material token and equal to none: body 13, title 18,
  display 64, 44 px pills and targets, an 80 px navigation bar, an 80 px rail.

## Decision

**The dashboard is hand-built Material 3 Expressive: Base UI for behaviour, TanStack for routing
and data, CSS custom properties for every token, and nothing else at runtime.**

**1. Components are ours, on Base UI.** Every visible component lives in `web/src/m3/` as plain
TSX and CSS, one directory per component, and takes its behaviour from `@base-ui/react` where
Base UI has it (dialog, menu, popover, tabs, switch, combobox, field). Material Web, Lit and every
React Material library are rejected; R14 §3 has the reasons. The shadcn stylesheet, the `shadcn`
package and the copy-ins under `web/src/components/ui/` are deleted as each is replaced, and the
directory is gone when M14 closes. ADR-0014's "never edit `components/ui/`" rule ends with it.

**2. Tokens are the seam now.** `web/src/m3/tokens.css` declares every `--md-sys-color-*`,
`--md-sys-shape-*`, `--md-sys-typescale-*` and `--md-sys-motion-*` role. Light and dark sage
are **precomputed and shipped as CSS**. The colour engine (`material-color-utilities`) loads
**only** when a seed other than sage is stored, and on the Appearance page, so the first load
carries no scheme code. Tailwind v4 stays as the utility compiler with its `@theme` mapped onto
those roles, because it emits only what is used; `class-variance-authority` and `tailwind-merge`
stay until the quality pass measures them. Call sites still pass a role, never a colour.

**3. Full TanStack, split by route.** Router and Query stay. Form (`@tanstack/react-form`) carries
the New session stepper and the Settings sheets; Virtual carries the transcript and the
notifications list; Table carries Usage's sessions table and the machines comparison. Each loads
with the first route that needs it and never on `/`. Query keys come from one factory; every read
is a `queryOptions` the route can preload; every mutation invalidates by key.

**4. Material's numbers win over the brief's.** The owner asked for full compliance, so the seven
near-misses become tokens: body-medium 14, title-large 22 (card) and title-medium 16 (row), the
hero is display-large emphasized 57 on desktop and display-small 36 on the phone, hit areas are
48 px with a 44 px visible control, the navigation bar is 64 and the rail 96. The type ramp is
Material's fifteen roles plus emphasized; D3 §5.4's four sizes are amended. Motion uses the
Expressive springs; D3 §9.2's one duration and one easing are amended. State stays a mark plus a
word (D3 §6), and R14 §7 gives the number: `outline-variant` guarantees 1:1 contrast, so it is
never a control's only edge.

**5. Preferences are browser-local.** Appearance (Clean or Compact, seed, Light/Dark/System) and
General (clone home, default machine, time format) live in `localStorage` under one versioned key.
The daemon persists nothing for them. The boards' "on every device you sign in from" becomes "on
this device".

**6. Verification is Playwright with axe, at three sizes, against a fixture daemon.** `web/e2e/`
runs every screen at 390, 834 and 1440 with `wcag22aa` tags, keyboard walks and screenshots, on a
Node fixture server that answers `/api` from `contract.gen.ts`. Vitest keeps unit and component
tests. The `web` workflow runs both. A screen is done when its e2e passes and the reviewer has
compared its screenshot to its board.

**7. The budget moves once, and is written down.** D3 §9.1's first-load ceiling of 145 KiB holds
for `/`. Fonts move from 30 KiB to **80 KiB** for Google Sans Flex (weight axis, latin) and IBM
Plex Mono (latin), self-hosted, `font-display: swap`. Anything above either number is a failing
test, not a note.

## Consequences

- **ADR-0014's seam sentence is false and replaced**: the design system landed as a component
  library, a token file and a router change. Its Framework, Compiler, Vite and oxlint rows stand.
- **`web/src/components/ui/` and everything only it served are deleted during M14**, with the
  owner's explicit permission of 2026-09-06. Each PR names what it deleted.
- **D3 is amended, not superseded**: §0 already carries Q6's reversal; §5.4, §9.1 and §9.2 get a
  dated blockquote each pointing here. §4, §6, §11 and §13 stand, and so do D5 §5.2 and D6 §4.3,
  §5.1: no trust buttons of Yantra's own, Attach and Kill for unclaimed sessions, no fleet total.
- **Every screen now has three form factors**, so the router gains no form-factor logic; the
  shell reads one media query and each component lays itself out.
- **The colour engine special-cases sage**: R14 §2.3's four tonal palettes reproduce
  `palette-sage.json` within two hex units, and a custom seed gets `SchemeExpressive`.
- **Safari below 17.2 gets ease-out instead of springs**; nothing breaks.

### What was rejected, and why

- **Material Web**: maintenance mode, Lit, no Expressive, 14 kB for a button.
- **A React Material library**: none maintained (R14 §3).
- **Dropping Tailwind for CSS Modules**: possible and smaller by a little, but it rewrites every
  existing class string for no visible gain, and Tailwind emits nothing unused. Revisit in the
  quality pass with a measurement.
- **Loading Google Sans Flex from Google Fonts**: the appliance's dashboard must open offline on
  the tailnet (the service worker exists for that), and a third-party fetch is a privacy leak on
  every open.
- **Server-held preferences**: a third bend of *persists nothing* for a colour.

### Not decided here

- Whether `tailwind-merge` and `class-variance-authority` survive the quality pass.
- The GitLab grant, Usage time windows, streaming chat: rows of their own in `tracker.md`.
- Shape morphing: `corner-shape` is Chrome-only; radii animate between scale steps instead.

> **2026-09-06, Y-338: the sage reproduction is not within two hex units for every role.** The
> Packages agent fitted `palette-sage.json` with `DynamicScheme` and five tonal palettes: every
> role lands within two units except `primary-container` and its on-colour at three and the
> tertiary group at six to thirteen, because the file's tertiary sits at tone 45.5 where Material
> fixes 40. Nothing visible depends on it: sage ships from the file as CSS, and only the
> Appearance picker's sage preview goes through the engine. `scheme.test.ts` names the six roles
> and their ceilings.

> **2026-09-07, Y-352: the eyebrow is label-medium, and its case and tracking are the brief's.**
> §4 names the seven numbers where the brief and Material disagreed, and says nothing about the
> small-caps label the boards put above a title. It is Material's **label-medium**: `.m3-eyebrow`
> in `tokens.css` takes `--md-sys-typescale-label-medium` whole — 500 12px/16px on the plain
> typeface — and colours itself `on-surface-variant`. Two properties are not Material's, and both
> are BRIEF.md's and kept: `text-transform: uppercase`, and 0.8 px of tracking where the role gives
> 0.5. The boards' eyebrow must read as a label rather than a small title, and the case is what
> does that.

> **The owner picked 200 KiB (204,800 B) on 2026-09-08**, on the target *the dashboard is
> interactive within two seconds on a cold load on Lighthouse's mobile preset*.
> [R16](../research/16-what-the-first-load-costs-a-phone.md) §6 prices the two alternatives they
> did not take: 175 KiB at 1.75 s, and 396 KiB for first paint over the relay.

> **2026-09-08, Y-370: §7's first-load ceiling gets a target under it, and counts `index.html`.**
> §7 holds D3 §9.1's 145 KiB and gives no reason a reader can check. Three premises moved
> underneath it, and none of them makes the original wrong.
>
> **The wire was not compressed when the number was set.** Until Y-357 merged on 2026-09-08,
> `npm run budget` measured gzip while `yantrad` sent identity bytes. The 19 files `index.html`
> names are **488,913 B** uncompressed against **151,102 B** gzipped, a ratio of 3.24, and the
> entry chunk alone is 327,376 B. The test read a number the phone had never downloaded.
>
> **The budget sees 56% of the wire.** A cold `/` against a real `yantrad` is **41 requests and
> 271,018 B**. Outside the ceiling: 65,930 B of fonts, **45,415 B of chunks the shell's own
> `lazy()` calls fetch on every load** — `Account`, `BellPopover` and `NotificationsSheet` are
> drawn on every page — `index.html`, and five API reads. R16 §3 has the table.
>
> **The dashboard grew.** `router.ts` has thirteen routes, and the entry chunk's fixed cost —
> react-dom, TanStack Router, TanStack Query, Base UI — is 74% of the old ceiling before Yantra
> writes a line ([the last kilobytes](../plans/m14-the-last-kilobytes.md)).
>
> **The new number comes from a target**: *the dashboard is interactive within two seconds on a
> cold load on the worst phone we can describe*, which is Lighthouse's mobile preset — 1.6 Mbit/s
> down, 150 ms RTT, 4× CPU. Today that is 1,606 ms; a kilobyte costs 5.25 ms there; 394 ms of
> headroom is 75 KiB; rounded down, **200 KiB**. R16 §1 has the profiles and §4 the measurements.
>
> **The ratchet stays, and it was right.** xterm (86,407 B gzip), the colour engine (19,187 B) and
> nine screens are lazy because something failed when they were not. A 200 KiB ceiling still
> refuses xterm in the entry by 33,865 B and every screen eager by 48,423 B. It no longer refuses
> the colour engine by arithmetic — **§2's rule keeps that**, and no target between 1.70 s and
> 2.5 s both leaves the project room and holds that line by byte count.
>
> **The fonts line does not move**: 80 KiB, and 78.5 KiB today. `font-display: swap` keeps them off
> the paint path, so they stay a ceiling of their own; the two-second arithmetic counts them
> because they share the link with the script.
>
> **What is not decided here.** The appliance's half sends no `ETag`, no `Last-Modified` and no
> `Cache-Control`, and `sw.js` is network-first by design, so **every open downloads all 271,018 B
> again** — measured, three visits running, in R16 §3. The directory half, which gets `tower-http`'s
> validators for free, costs 4,941 B on the second visit. Four response headers in
> `crates/yantrad/src/web/embedded.rs` are worth more than every byte this ceiling governs, and they
> need a row of their own.
