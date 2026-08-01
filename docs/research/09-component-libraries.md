# 08 — M4 web UI: component library, and the seam a design system plugs into

Research note for Yantra. Evidence retrieved **2026-08-01**. Written for Y-072, against the API
Y-071 already ships.

> **Scope.** React + React Compiler is settled and not re-argued here. The question this note
> answers is narrower and harder: *a design system is being built elsewhere and will arrive later —
> which choice makes the styling layer swappable, and which choices weld it in place?* Everything
> below is judged on that, not on looks.

---

## Summary

- **`oat.ink` is real.** It is **Oat UI** by Kailash Nadh (`knadh`) — a classless semantic CSS
  library, MIT, v0.7.1 (2026-07-28), 5.4k stars, 7 KB CSS + 2.9 KB JS. The requester could not
  verify it; it exists and is actively developed. **It is also not React, and that is why it loses**
  — see §3. It is the most interesting near-miss in this note.
- **Oat and shadcn independently converged on the same token names** — `--background`,
  `--foreground`, `--card`, `--primary`, `--muted-foreground`, `--border`, `--ring`. That is the
  single most useful finding here: **the token vocabulary is more standard than any library**, so
  the bet to place is on the vocabulary, not on the component set.
- **shadcn/ui is very actively maintained** — CLI `shadcn@4.16.1` published **2026-07-31**, five
  releases in the preceding ten days; repo pushed the same day, 120k stars, MIT.
- **The premise "shadcn is copy-in source, not a dependency" is now only half true.** `init` adds
  `@import "shadcn/tailwind.css"` to your global CSS, so the `shadcn` npm package is a real
  dependency of the CSS layer. `shadcn eject` inlines it and removes it — **irreversible**. Loud
  negative, because the copy-in premise is the usual reason people pick it.
- **For Yantra's actual surface the "which primitive base" question is a no-op.** shadcn made
  **Base UI the default in July 2026** (Radix and React Aria also supported), but the Table source
  is **byte-identical across `base-*`, `radix-*` and `new-york-v4`** and has **zero dependencies**.
  Table, Alert, Card, Skeleton, Empty and Spinner are all `dependencies: null`. Only Badge pulls
  anything (`radix-ui`, solely for `Slot`), and it is one deletable import.
- **Four of the six headless libraries have no table component at all.** Radix closed its Table
  primitive request as `not_planned` (2025-01-25). Adopting Radix / Base UI / Ark UI / Headless UI
  for this page means hand-writing the `<table>` anyway and paying a dependency for nothing.
- **Headless UI is dying. Do not use it.** Zero commits since **2026-04-13**; 35 commits in twelve
  months. Tailwind Labs cut 3 of 4 engineers in January 2026. Its sole author is the one engineer
  left across all their projects.
- **Radix is *not* stalled** — the common community claim is out of date. 248 commits in twelve
  months, maintained by WorkOS.
- **The decisive config flag is `tailwind.cssVariables`, and it cannot be changed later.** Docs,
  verbatim: *"This cannot be changed after initialization. To switch between CSS variables and
  utility classes, you'll have to delete and re-install your components."* Set it `true` at init or
  the swappable seam does not exist.
- **Recommendation: shadcn/ui, `cssVariables: true`, taking only the six dependency-free
  components — and understanding that this is a bet on a token vocabulary, not on a library.**
  Total added runtime JS ≈ **9.9 KB gzip across 2 packages**. §8 ranks the field and names the one
  fact that would flip the decision.

---

## 1. Version floor (verified 2026-08-01, npm registry + official docs)

| Package | Latest | Published |
| --- | --- | --- |
| `react` | **19.2.8** | 2026-07-21 |
| `tailwindcss` / `@tailwindcss/vite` | **4.3.3** | 2026-07-16 |
| `babel-plugin-react-compiler` | **1.0.0** (GA) | 2025-10-07 |
| `eslint-plugin-react-hooks` | **7.1.1** | 2026-04-17 |
| `shadcn` (CLI) | **4.16.1** | 2026-07-31 |
| `vite` | 8.2.0 | 2026-07-30 |
| `@vitejs/plugin-react` | 6.0.5 | 2026-07-30 |

**No React 20. No Tailwind v5.** React Compiler went stable 2025-10-07; `target` defaults to
`'19'`, which needs **no** `react-compiler-runtime` package.

**Sharp edge worth knowing before Y-073 picks versions:** `@vitejs/plugin-react@6.x` peer-requires
**Vite 8** and removed the inline Babel option. The current documented compiler wiring is:

```
npm install -D babel-plugin-react-compiler@latest @rolldown/plugin-babel eslint-plugin-react-hooks@latest
```

```js
// vite.config.ts
import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
});
```

On Vite ≤ 7 you must instead pin `@vitejs/plugin-react@5.2.0` and use the old
`react({ babel: { plugins: ['babel-plugin-react-compiler'] } })` form. React Compiler **must run
first** in the Babel pipeline. `@tailwindcss/vite` peers `vite ^5.2 || ^6 || ^7 || ^8`, so Tailwind
does not constrain the choice.

**shadcn × React Compiler:** the only compiler-specific bug ever filed against shadcn
(`shadcn-ui/ui#3905`, *data-table pagination breaks with React Compiler*) was **closed 2025-10-09**,
and it concerned `data-table` pagination — a component Y-072 does not use. No open incompatibility
found. React 19 support is complete: current registry source has no `forwardRef` and uses
`data-slot` attributes throughout.

---

## 2. shadcn/ui — what it actually is in August 2026

### 2.1 It stopped being one library and became a matrix

The July 2026 changelog is the important change. **Base UI is now the default base for new
projects**; Radix remains fully supported and is explicitly *not* deprecated; React Aria was added
as a third first-class base. Orthogonally there are **eight visual styles** — Vega (the classic
look), Nova (compact), Maia (soft/rounded), Lyra (boxy, mono-friendly), Mira (dense), Luma, Sera,
Rhea.

`components.json`'s `style` enum is the cross-product, verified from the live schema:

```
default | new-york |
radix-{vega,nova,maia,lyra,mira,luma,sera,rhea} |
base-{…same 8…} |
aria-{…same 8…}
```

CLI: `-b, --base <base>` accepts `base | radix | aria`. `--defaults` means
`--template=next --preset=nova`.

### 2.2 …and none of that matters for Yantra

This is the finding that collapses most of the decision. I pulled the Table registry item for
`new-york-v4`, `base-nova`, `radix-nova` and `base-vega`. **The component source is identical in all
four** — same `data-slot` attributes, same classes, differing only in the import path for `cn`. In
full, the entire `Table` primitive is:

```tsx
function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  )
}
```

Dependency manifests from the registry, for exactly the components Y-072 needs:

| Component | `dependencies` | `registryDependencies` |
| --- | --- | --- |
| `table` | *none* | *none* |
| `alert` | *none* (imports `cva`) | *none* |
| `card` | *none* | *none* |
| `skeleton` | *none* | *none* |
| `empty` | *none* | *none* |
| `spinner` | *none* | *none* |
| `badge` | **`radix-ui`** (only for `Slot`) | *none* |

So: the base library exists to serve Dialog, Select, Combobox, Popover, Tabs, DropdownMenu — the
interactive widgets. **Y-072 has none of those.** Picking Base UI over Radix over React Aria is,
for this page, a choice with no observable consequence. Badge's `import { Slot } from "radix-ui"`
is the only tether, it exists solely to support `asChild`, and because the file is *your source* you
delete the import and the prop.

### 2.3 The copy-in premise needs a correction

The task framed shadcn as "copy-in source, not a dependency". That was true and is now partly
false. Verified from the npm tarball, `shadcn@4.16.1` exports `./tailwind.css`, `./utils`,
`./preset`, `./registry`, `./icons`, `./schema`, `./mcp`. `init` writes
`@import "shadcn/tailwind.css"` into your global CSS — shared custom variants (`data-open:`,
`data-closed:`) and accordion keyframes. That is a live package dependency in the CSS layer.

The escape hatch exists and is documented: `pnpm dlx shadcn@latest eject` inlines
`shadcn/tailwind.css` into your global CSS and drops the dependency. The docs are blunt that this is
**irreversible** — future CLI updates to that file stop applying.

For Yantra this is a small dependency (it is CSS for accordions and overlay state variants, almost
none of which a four-table page uses), and `eject` is available if Y-073 wants the UI build to have
one fewer moving part. Worth recording rather than discovering later.

### 2.4 Maintenance: unambiguous

- `shadcn` CLI **4.16.1**, published **2026-07-31**. Preceding: 4.16.0 (07-27), 4.15.0 (07-25),
  4.14.1 (07-23), 4.14.0 (07-22).
- `github.com/shadcn-ui/ui`: 120,237 stars, `pushed_at` **2026-07-31T13:58Z**, not archived, MIT.
  2,196 open issues — high, but that is a popularity artefact, not a liveness signal.
- Four changelog entries in July 2026 alone.

---

## 3. `oat.ink` — it exists, and it is good, and it is wrong for this

**Loud correction to the brief: Oat UI is real.** https://oat.ink, source at
`github.com/knadh/oat`, MIT, by Kailash Nadh. Created **2026-01-15** — it is about seven months old,
which is why it is unfamiliar. v0.7.1 released **2026-07-28**, `pushed_at` 2026-07-29, 5,439 stars,
**2 open issues**. Actively maintained by a maintainer with a strong track record.

**What it is:** an ultra-lightweight *classless* semantic HTML + CSS library with a few
WebComponents. **7 KB CSS + 2.9 KB JS minified+gzipped, zero dependencies, no build step.** You
include two files and write semantic HTML; elements are styled by tag and by `data-*` attribute
rather than by class.

It covers Yantra's surface almost suspiciously well:

```html
<!-- table: the wrapper class exists only for horizontal scroll -->
<div class="table"><table><thead><tr><th>Name</th></tr></thead><tbody>…</tbody></table></div>

<!-- alert: four variants -->
<div role="alert" data-variant="error"><strong>Failed.</strong> …</div>

<!-- skeleton / busy -->
<div class="skeleton line" role="status"></div>
<div aria-busy="true" data-spinner="overlay">…</div>
```

Table, alert with `success|warning|error`, skeleton, spinner, badge, card. That is Y-072's whole
vocabulary in 10 KB.

**Its token layer is genuinely strong** — better documented in source than on the site (`src/css/01-theme.css`), and this is where the convergence finding comes from:

```css
:root {
  color-scheme: light dark;
  --background: light-dark(#fff, #09090b);
  --foreground: light-dark(#09090b, #fafafa);
  --card: …; --card-foreground: …;
  --primary: …; --primary-foreground: …;
  --secondary: …; --muted: …; --muted-foreground: …; --accent: …;
  --danger: …; --success: …; --warning: …; --faint: …;
  --border: …; --input: …; --ring: …;
  --space-1…--space-18; --radius-small|medium|large|full;
  --font-sans; --font-mono; --text-1…--text-8; --shadow-small|medium;
}
```

Note what that is: **shadcn's token names**, plus `--success`/`--warning`/`--faint` (which shadcn
lacks and which a three-state dashboard actually wants), plus a fuller spacing/typography scale, all
using CSS `light-dark()` so dark mode needs no class toggle. Two projects that share no code picked
the same names. That is the vocabulary becoming a standard.

### Why it still loses

1. **It is not React, and this is a React project.** There is no React wrapper and the README does
   not mention one. You would write raw semantic JSX and hand-roll the `looked` states — which is
   fine, but then you are really choosing option 2 (hand-written) with a stylesheet on top.
2. **Classless is maximal swappability *only until the replacement is class-based*.** Oat styles
   global element selectors. If the incoming design system is a React/Tailwind system — the
   overwhelmingly likely shape — its utilities and Oat's global `table {…}` / `th {…}` rules fight
   each other at the same specificity layer, and you win by deleting Oat entirely. Deleting Oat is
   admittedly one `<link>` and leaves valid semantic HTML, so the failure is cheap; but "the plan is
   that we delete it" is not an integration strategy.
3. **Sub-v1 with declared breaking changes.** README: *"currently sub v1 and is likely to have
   breaking changes until it hits v1."* Y-073 embeds assets in a release binary; a churning
   stylesheet is a poor thing to pin at the same moment.
4. **The site does not document its CSS variables.** I had to read `src/css/01-theme.css` to find
   them. For a library whose entire theming story *is* the variables, undocumented variables is a
   real maturity signal.

**Verdict: real, well-made, genuinely tempting, ranked third.** If Yantra's UI were server-rendered
HTML with no framework — the "no framework" option in the M4 plan §7.2 — Oat would be the
recommendation, and it would be a good one. React is what disqualifies it.

---

## 4. The headless field — mostly negative findings

All figures verified 2026-08-01 from the npm registry, GitHub API, and official docs.

| Library | Version | Last release | Commits/12mo | React peer | **Table?** | Deps | gzip |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `radix-ui` | 1.6.7 | 2026-07-24 | ✅ 248 | ^16.8‖17‖18‖19 | ❌ **No** | 55 | 70.1 kB |
| `@base-ui/react` | 1.6.0 | 2026-06-18 | ✅ 1854 | ^17‖18‖19 | ❌ **No** | 5 | 145.4 kB |
| `react-aria-components` | 1.20.0 | 2026-07-31 | ✅ 916 | ^16.8‖17‖18‖19 | ✅ **Yes** | 6 | 245.3 kB |
| `@ark-ui/react` | 5.37.2 | 2026-06-08 | ✅ 606 | >=18 | ❌ **No** | 67 | 268.8 kB |
| `@headlessui/react` | 2.2.10 | 2026-04-07 | 🔴 **35** | ^18‖19 | ❌ **No** | 5 | 61.5 kB |
| `@tanstack/react-table` | 8.21.3 | **2025-04-14** | ⚠️ v8 frozen | >=16.8 | logic only | 1 | 14.6 kB |

Sizes are whole-package (tree-shaking reduces the real figure); they are listed to show order of
magnitude, not to be quoted as bundle cost.

**Report these loudly:**

- **Headless UI is effectively unmaintained.** No commits since **2026-04-13**. Adam Wathan's
  2026-01-08 podcast episode ("We had six months left") documents Tailwind Labs cutting three of
  four engineers in January 2026 after an AI-driven collapse in docs traffic; Headless UI's sole
  author is the one remaining engineer across all their projects. **Do not adopt.**
- **Radix is healthy — the "Radix is abandoned" claim is stale.** 248 commits in twelve months,
  commits landing 2026-07-31, now maintained by WorkOS. If someone raises this objection, it is out
  of date.
- **Base UI renamed its package.** `@base-ui-components/react` is **deprecated** and frozen at
  `1.0.0-rc.0` with the message *"Package was renamed to @base-ui/react"*. Any guide naming the old
  package is stale.
- **Radix will never have a Table.** Issue #2455 (*[New Primitive] Table*, opened 2023-10-14) was
  **closed `not_planned` on 2025-01-25**.
- **TanStack Table v8 has not shipped in ~16 months** (8.21.3, 2025-04-14) while work goes into the
  v9 beta (`9.0.0-beta.65`, 2026-07-31). Adopting v8 now buys a major migration later.
- **No library declares a React 20 peer range.** React 20 does not exist, so this is not a finding
  against them — but it is **UNVERIFIED** territory for all six.

### The question that settles it

*For a static table with no sorting, no pagination, no selection, no virtualization — what does any
of these give you over `<table>`?*

**Nothing.** Four of the six have no table primitive, so adopting them means hand-writing the
`<table>` and paying for a dependency you did not use. React Aria Components is the only real Table
and it renders actual `<table>/<thead>/<tr>/<th>/<td>` — its additions are arrow-key cell
navigation, selection, sorting, drag-and-drop and row expansion, **every one of which Y-072
explicitly excludes**. You would pay ~245 kB and a stateful collection model to obtain the semantics
the `<table>` element already emits. TanStack Table with every feature disabled degrades to
column-definition ceremony around `data.map()`.

The three `looked` states are a `<span>` with a `data-*` attribute. Polling is `useEffect` +
`setInterval`. Neither wants a library.

---

## 5. The token seam — the question that decides it

*When the design system arrives as colors, spacing, radii and typography, what has to change?*

| Option | What changes | Verdict |
| --- | --- | --- |
| **shadcn, `cssVariables: true`** | **One CSS file.** The `:root` / `.dark` custom-property block, and the `@theme inline` mapping. No component file is touched. | ✅ token swap |
| **shadcn, `cssVariables: false`** | Every component file — colors are baked in as `bg-zinc-950` literals. Docs say you must **delete and re-install** every component. | ❌ rewrite |
| **Hand-written + CSS custom properties** | One CSS file, by construction. | ✅ token swap |
| **Oat UI** | One CSS file *if* the system is token-shaped; a **delete-and-replace** if it is class- or component-shaped. | ⚠️ conditional |
| **Radix / Base UI / Ark UI** | Nothing to re-token — they provide no theming layer at all. Radix documents explicitly: no CSS variables, no theme provider, no functional styles. Styling is your `className` either way, so you inherit whichever seam you built yourself, plus a markup structure the new system must accommodate. | ⚠️ neutral-to-negative |
| **React Aria Components** | `className` passthrough plus default `.react-aria-*` classes and render-prop className functions. Same as above, with more imposed markup. | ⚠️ negative |

**The most important operational fact in this note:**

> `tailwind.cssVariables` — *"This cannot be changed after initialization. To switch between CSS
> variables and utility classes, you'll have to delete and re-install your components."*
> — shadcn/ui `components.json` docs, retrieved 2026-08-01

The same page says `tailwind.baseColor` also cannot be changed after init. So the init command is
where swappability is won or lost, and it is a one-way door. `shadcn init` defaults
`--css-variables` to `true`; **pass it explicitly anyway** so the decision is legible in the repo
rather than resting on a default that could move.

### How Tailwind v4 makes this work

Tailwind v4 compiles every theme variable into a real CSS custom property on `:root`
(*"Tailwind also generates regular CSS variables for your theme variables"*). shadcn layers a
semantic set on top and binds them to utilities via `@theme inline`:

```css
@import "tailwindcss";

:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --primary: …; --muted-foreground: …; --destructive: …; --border: …; --ring: …;
}
.dark { /* same names, different values */ }

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  /* … */
}
```

`bg-background` and `text-muted-foreground` resolve through that indirection. Change the `:root`
block, everything re-skins, no `.tsx` is touched. `@theme inline` is required here specifically
because the variables reference other variables — without `inline`, `var()` resolves at the
definition site and values defined deeper in the tree fall back unexpectedly.

### The mechanism built for exactly this situation

shadcn ships a command for "a theme arrives later":

```
pnpm dlx shadcn@latest apply <preset> --only theme
```

`--only` accepts `theme` and `font`, and applies them **without reinstalling UI components**. If the
incoming design system is published as a shadcn preset — or can be expressed as one — integration is
literally that one command. If it arrives as a plain CSS variable block, it is one file replacement.

**The caveat, stated plainly:** a *style* (Vega/Nova/Lyra/…) is not a token swap. Styles rewrite
component source at generate time — spacing, structure, class choices. Switching style later means
**regenerating** components. This produces one concrete architectural rule, and it is the most
important instruction in this note:

> **Never edit the generated files in `components/ui/`.** All Yantra-specific composition lives in
> your own components that *wrap* them. Then a later `shadcn add --overwrite` to change style is
> free, and the four sections do not notice.

Paired with the SKILL.md rule that shadcn itself enforces — *"`className` for layout, not styling…
Use semantic colors: `bg-primary`, `text-muted-foreground` — never raw values like `bg-blue-500`"* —
that is an auditable invariant: **grep the UI for a raw color literal; if there are none, the token
swap works.**

---

## 6. Accessibility — what you get free, and what you would not miss

For this surface, less than the usual argument assumes.

**Native `<table>` already provides:** the full table semantics tree, screen-reader table navigation
mode, row/column announcement, and `<caption>`/`scope` associations. NVDA, JAWS and VoiceOver all
implement table navigation against the element itself. A headless library adds nothing here — React
Aria Components renders the same elements.

**What a headless library would add, and Yantra ruled all of it out:** roving tabindex / arrow-key
cell navigation, selection state and its ARIA, `aria-sort` on sortable headers, focus management for
overlays and menus, and typeahead. There are no overlays, menus, sorts or selections on this page.

**What still needs deliberate work, from either option:**

- **The `looked` states must be announced, not just drawn.** `looked: failed` should render inside
  `role="alert"`; the polling region should be `aria-live="polite"` so a refresh that changes a
  machine from online to expired is spoken. No library does this for you — it is an attribute on the
  component you write. Oat gets partial credit: its alert example is `role="alert"` by convention
  and skeletons carry `role="status"`.
- **Never encode a state in colour alone.** I-39 says online / offline / expired-key are three
  states; if the third is a differently-coloured dot it is invisible to a colour-blind viewer and to
  a screen reader. The `Status` component in §9 exists to make that impossible.
- **`age_seconds` should render as `<time>`** with a machine-readable stamp, so "6s ago" is not the
  only representation.

**Conclusion: accessibility is not a tiebreaker here.** It is roughly equal across every option and
is decided by four attributes you write yourself.

---

## 7. Weight — measured for the surface actually used

Runtime JS added beyond `react` + `react-dom`, for the recommended path (bundlephobia, 2026-08-01):

| Package | Version | gzip | Transitive deps |
| --- | --- | --- | --- |
| `clsx` | 2.1.1 | **353 B** | 0 |
| `tailwind-merge` | 3.6.0 | **8,964 B** | 0 |
| `class-variance-authority` | 0.7.1 | **655 B** | 1 (`clsx`) |
| **Total** | | **≈ 9.9 KB gzip** | **2 unique packages** |

`tailwind-merge` is 90% of that and exists only to make `cn()` resolve class conflicts. For a page
this small you could define `cn = (...a) => a.filter(Boolean).join(' ')` and drop it, at the cost of
diverging from the shadcn convention and from the SKILL.md rule about `cn()`. **Recommendation: keep
it.** 9 KB gzip is noise next to `react-dom`, and matching the upstream convention is precisely what
keeps regeneration free — which is the whole thesis. Revisit only if M7 measures a problem.

Avoided by deleting one import from `badge.tsx`: `radix-ui` at **71.7 KB gzip / 55 packages**.

CSS: Tailwind v4 emits only utilities actually used, so four tables and a few states produce a small
sheet. `shadcn/tailwind.css` adds accordion keyframes and overlay state variants that this page does
not use — `eject` removes it if Y-073 wants that.

**Comparison for scale:** Oat is 7 KB CSS + 2.9 KB JS and no npm packages — genuinely lighter, but
it does not include React and it does not include the four components you would still write.
React Aria Components alone is ~245 kB.

**On the M7 Raspberry Pi constraint:** this is the wrong axis to worry about. Y-073 embeds built
assets in the binary; the delta between these options is single-digit kilobytes of gzipped JS
against a Rust binary. None of these choices threatens the appliance. Weight is not the tiebreaker
either — it is only a reason to reject React Aria Components and Ark UI, which §4 already rejects on
better grounds.

---

## 8. Recommendation

**Ranked, with swappability as the tiebreaker:**

1. **shadcn/ui — `--base base`, a compact style, `cssVariables: true`, importing only `table`,
   `alert`, `badge`, `card`, `skeleton`, `empty`.** ✅ **Recommended.**
2. **Hand-written components over CSS custom properties.** A genuinely close second — see below.
3. **Oat UI.** Real, well-built, right philosophy, wrong runtime. Would win if this were not React.
4. **React Aria Components.** The only real Table; every feature is one Y-072 excludes; ~245 kB.
5. **Radix / Base UI / Ark UI.** No Table at all. Nothing to offer this surface. (Both Radix and
   Base UI are healthy and are the right answer *later*, if M6's terminal needs real overlays.)
6. **TanStack Table.** v8 frozen ~16 months, v9 in beta; pure ceremony for a static table.
7. **Headless UI.** Actively dying. Avoid.

### Why #1 over #2 — and the honest admission

**They converge, and that is the argument, not a weakness.** shadcn's Table *is* the hand-written
table: 40 lines of plain `<table>` with Tailwind classes, `data-slot` attributes and zero
dependencies. Choosing shadcn here is not choosing a library — the code you get is the code you
would have written. What you additionally get is:

- **A token vocabulary that is becoming a de facto standard.** Oat arrived at the same names
  independently. An incoming design system is more likely to speak `--background` / `--foreground` /
  `--primary` than to speak names you invented.
- **A documented, one-command integration path** (`shadcn apply <preset> --only theme`) for exactly
  the scenario driving this decision.
- **Regeneration as an upgrade path.** If the design system implies different structure rather than
  different colors, `shadcn add --overwrite` re-emits the primitives in a new style — provided you
  never edited them.
- **The `data-slot` attribute on every element**, which gives a future design system a stable
  styling hook that does not depend on class names at all.

Cost: `shadcn` as a CSS-layer dependency (ejectable), and ≈ 9.9 KB gzip.

### What would flip it

**One fact: the shape the design system arrives in.**

- Arrives as **CSS custom properties / a token file** → shadcn wins outright; integration is one
  file, possibly one command.
- Arrives as **a React component library with its own components** → *both* options get replaced at
  identical cost, and hand-written would have wasted less. But note it is a wash, not a loss —
  because the shadcn surface here is 40-line dependency-free files that are already yours to delete.
- Arrives as **Tailwind classes / a Tailwind preset** → shadcn wins; it is already a Tailwind
  project with `@theme inline`.

Two of three favour shadcn and the third is neutral, so the recommendation does not depend on
guessing. **If the design-system agents can be asked one question, ask what artefact they will
hand over.** If the answer is "CSS variables", this decision is settled with no residual risk.

### Exact starting commands

```sh
npm create vite@latest yantra-ui -- --template react-ts
cd yantra-ui
npm install tailwindcss @tailwindcss/vite
npx shadcn@latest init --base base --css-variables      # one-way door: cssVariables
npx shadcn@latest add table alert badge card skeleton empty
```

Then delete `import { Slot } from "radix-ui"` and the `asChild` branch from `badge.tsx`, and
`npm uninstall radix-ui` if the CLI added it.

**Guardrails to record with the decision** (each is checkable):

1. `components.json` has `"cssVariables": true`. It cannot be changed later.
2. No file under `components/ui/` is ever edited. Composition happens in `components/`.
3. No raw color literal anywhere in the UI — grep for `bg-`/`text-` followed by a Tailwind color
   name. Tokens only.
4. All tokens live in one CSS file, and that file is the entire integration surface for the design
   system.
5. §1's guardrail is unchanged: none of this may make `cargo build` need Node (Y-073, R-24).

---

## 9. The component decomposition

Four components and one hook. The design is driven by one observation: **the `looked` envelope is
identical across all four sections, and the four tables differ only in their columns.** Everything
else is duplication waiting to happen.

The wire shapes Y-071 already ships:

```ts
type Looked<T> =
  | { looked: "ok";     age_seconds: number; data: T[] }
  | { looked: "failed"; age_seconds: number; error: string }
  | { looked: "never" };

type MachineRow   = { name; dns_name; os; online: boolean; expired: boolean; last_seen };
type WorkspaceRow = { name; machine; repo; startup };
type SessionsRow  = { machine: string; reached: "yes"; sessions: Session[] }
                  | { machine: string; reached: "no";  error: string };
```

### `useLooked<T>(path): Looked<T>` — the hook

Polls `path` on the shared interval and returns the envelope **as-is**. Two rules give it its whole
reason to exist:

- **It never throws and never returns `undefined`.** A network failure, a dead daemon or a non-200
  is mapped into `{ looked: "failed", error: … }` — the *same shape the daemon produces*. Without
  this you grow a second failure path, and a page with two failure paths will render one of them
  wrong. The browser losing the daemon and the daemon losing Tailscale are the same *kind* of fact
  to a viewer.
- **Before the first response it returns `{ looked: "never" }`,** which is already the daemon's own
  word for "not looked yet". Loading and never-looked collapse into one honest state instead of a
  spinner that lies.

No state library. `useEffect` + `setInterval`, or `setTimeout` recursion so a slow response cannot
stack requests.

### `<Section>` — owns the three states, and is the only thing that may

```tsx
<Section title="Machines" query={machines}>
  {(rows) => <DataTable columns={machineColumns} rows={rows} empty="No machines on this tailnet." />}
</Section>
```

```ts
function Section<T>(props: {
  title: string;
  query: Looked<T>;
  children: (data: T[]) => React.ReactNode;
}): React.ReactNode
```

It renders the heading, the `<Age>` stamp, and switches on `looked`:

- `"never"` → `Empty`, worded as *"Not looked at yet."* — never a spinner, never an empty table.
- `"failed"` → `Alert variant="destructive"` inside `role="alert"`, printing the **whole** error
  string. Y-071 deliberately puts the full `source()` chain in that field because
  `sessions::Error::Workspace` is `#[transparent]` and the headline alone says nothing. **Do not
  truncate it**; a parse error with a filename and line number is the entire value of the state.
- `"ok"` → `children(data)`.

**This is the component that makes R-23 structurally impossible.** Because `children` is only ever
called in the `ok` branch, a section physically cannot render a table for a failed or never-looked
response. The honesty rule is enforced by the type, not by discipline. It is used four times and
written once.

### `<DataTable<T>>` — owns the four tables

```ts
type Column<T> = {
  header: string;
  cell: (row: T) => React.ReactNode;
  align?: "start" | "end";
};

function DataTable<T>(props: {
  columns: Column<T>[];
  rows: T[];
  empty: string;
  caption?: string;
}): React.ReactNode
```

Each section contributes a **column array, not JSX**. That is what stops four tables from becoming
four near-identical blocks of `<thead>/<tbody>` markup that drift apart.

It also owns the fourth state nobody lists: **`ok` with zero rows**. "We looked and there is
nothing" is a real answer and is not `never` — `empty` is required, not optional, so no caller can
forget to distinguish them.

**The sessions section needs no extra component, which is the check that this decomposition is
right.** `SessionsRow` is a union; the `reached: "no"` case is a *row* whose sessions cell renders
`<Status tone="bad">` plus the error. A machine that did not answer therefore renders **as itself**,
occupying a row, exactly as the brief requires — because it was never filtered out of the array.
Rendering it as an empty list would take extra code.

### `<Status>` — owns every mapping from domain state to appearance

```ts
function Status(props: {
  tone: "ok" | "warn" | "bad" | "unknown";
  label: string;         // always rendered as text
  detail?: string;       // title/tooltip, e.g. the per-machine error
}): React.ReactNode
```

Wraps `Badge`. **Call sites pass a tone, never a color.** That single constraint is what makes the
token swap total: a design system re-maps four tones in one file, and no section knows a color
exists. It is also the enforcement point for the accessibility rule — `label` is always rendered as
text, so no state is conveyed by color alone.

Its four current users, and note that they are exactly the states this project has argued about:

| Where | Tones |
| --- | --- |
| Machine online/offline/**expired key** | I-39's three states, and `expired` is `warn` — the one a person can act on, so it must not be a shade of the offline dot |
| Session `reached: yes` / `no` | `ok` / `bad` + `detail` = the error |
| Workspace startup present/absent | `ok` / `unknown` |
| Agent status (Y-084) | already has a home; the section is the only new code |

### `<Age>` — owns the honesty stamp

```ts
function Age(props: { seconds: number }): React.ReactNode   // renders <time>
```

Renders `age_seconds` as text and carries the staleness signal — past some multiple of the 30 s
refresh interval it changes tone, because a reading that has stopped updating is the symptom of a
refresher that has died, and that is invisible otherwise. Trivial, but it is in every section
header, it is §5.2's explicit display requirement, and putting the threshold in one place means the
"how stale is stale" question is asked once.

### What is deliberately not a component

- **No `<MachinesTable>` / `<WorkspacesTable>` / `<SessionsTable>`.** Those are column arrays —
  data, in `columns.ts`. Four components that each wrap `DataTable` with fixed columns would be
  three levels of indirection for a `const`.
- **No `<Dashboard>` layout component.** Four `<Section>`s in a `<main>` is the layout.
- **No error boundary.** `useLooked` cannot throw, which is the point of writing it that way.
- **No theme provider.** Tokens are CSS. `.dark` on `<html>` if ever wanted — and Q6 already ruled
  out a theme switcher.

### Layout

```
src/
  api.ts                 Looked<T> and the row types — mirrors Y-071's DTOs
  useLooked.ts           the poll; the only place a fetch happens
  columns.ts             four Column<T>[] arrays — the four tables, as data
  components/
    Section.tsx          the looked switch; the only file that knows the three states
    DataTable.tsx        the table; owns "ok but empty"
    Status.tsx           tone -> appearance; the only file that knows about color
    Age.tsx              age_seconds -> <time>; owns the staleness threshold
    ui/                  shadcn output. NEVER EDITED.
  index.css              @import "tailwindcss"; :root tokens; @theme inline
                         <- the entire integration surface for the design system
  App.tsx                four <Section>s
```

**Nine hand-written files, four of them components.** When the design system arrives, the expected
diff is `index.css` and nothing else.

---

## 10. What this note does not settle, and what is unverified

- **Q14 is still the owner's.** This note answers "which component library" *given* React. It does
  not re-open React vs Svelte vs no-framework, and it is not an ADR.
- **The design system's delivery format is unknown**, and §8 says plainly that it is the one fact
  that could change the ranking. Asking the other agent system what artefact it produces is worth
  more than any further research here.
- **Nothing below was executed.** No `shadcn init` was run, no bundle was built, no page was
  rendered. Registry JSON, npm metadata and docs were read; the component sources quoted are the
  literal registry payloads, but the install has not been performed. The 9.9 KB figure is the sum of
  published package sizes, **not a measured build**.
- **`@base-ui/react` at 1.6.0 was reported by a delegated search**, and the rename from
  `@base-ui-components/react` is stated on the deprecated package. I did not independently confirm
  Base UI's stable-release date. Not load-bearing — §2.2 shows the base choice does not affect this
  surface.
- **Bundlephobia's indexed versions can lag npm.** `clsx@2.1.1` and `cva@0.7.1` match npm latest;
  `react-aria-components` was indexed at 1.19.0 while 1.20.0 had just shipped.
- **`react@19.2.8`'s existence rests on the npm registry `time` field only** — react.dev/versions
  still lists 19.2.7 as newest, and there is no release blog post for 19.2.8.
- **React 20 compatibility is unverifiable for every library named here**, because React 20 does not
  exist. No library declares a React 20 peer range.
- **The shadcn docs site lags its own schema.** `/docs/components-json` still shows
  `"style": "new-york"` and a `baseColor` enum, while the live `schema.json` carries the 26-value
  `{base}-{style}` enum. Trust the schema. **`/docs/styles` returns 404** — the eight styles are
  documented only in changelog entries and third-party write-ups, so the style descriptions in §2.1
  are the weakest-sourced claims in this note.
- **Oat's `--space-*`/`--text-*` scales were read from `src/css/01-theme.css` at `master`**, not
  from a tagged release; v0.7.1 is sub-v1 and the README warns of breaking changes.
- **`shadcn apply --only theme` was read from the CLI docs, not exercised.** Whether an
  externally-authored design system can be expressed as a shadcn preset is untested and is the
  practical question behind §8's "what would flip it".

---

## Sources

*All retrieved **2026-08-01** unless stated.*

**shadcn/ui**
- [ui.shadcn.com/docs/installation/vite](https://ui.shadcn.com/docs/installation/vite) ·
  [/docs/theming](https://ui.shadcn.com/docs/theming) ·
  [/docs/components-json](https://ui.shadcn.com/docs/components-json) (the `cssVariables` /
  `baseColor` "cannot be changed after initialization" text) ·
  [/docs/cli](https://ui.shadcn.com/docs/cli) (`apply --only theme`, `eject`, `--base`) ·
  [/docs/changelog](https://ui.shadcn.com/docs/changelog) ·
  [/docs/changelog/2026-07-base-ui-default](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default) ·
  [/docs/changelog/2026-07-react-aria](https://ui.shadcn.com/docs/changelog/2026-07-react-aria) ·
  [/docs/components/table](https://ui.shadcn.com/docs/components/table)
- Live registry payloads (component source + dependency manifests):
  `ui.shadcn.com/r/styles/{new-york-v4,base-nova,radix-nova,base-vega}/{table,alert,badge,card,skeleton,empty,spinner}.json`
- [ui.shadcn.com/schema.json](https://ui.shadcn.com/schema.json) — the 26-value `style` enum
- [github.com/shadcn-ui/ui/blob/main/skills/shadcn/SKILL.md](https://github.com/shadcn-ui/ui/blob/main/skills/shadcn/SKILL.md)
  — the official styling rules (`className` for layout not styling; semantic tokens only)
- [api.github.com/repos/shadcn-ui/ui](https://github.com/shadcn-ui/ui) — 120,237 stars,
  `pushed_at` 2026-07-31T13:58Z, MIT
- [shadcn-ui/ui#3905](https://github.com/shadcn-ui/ui/issues/3905) — React Compiler bug, closed 2025-10-09
- [registry.npmjs.org/shadcn](https://registry.npmjs.org/shadcn) — 4.16.1 @ 2026-07-31;
  `unpkg.com/shadcn@4.16.1/tailwind.css`

**Oat UI**
- [oat.ink](https://oat.ink/) · [oat.ink/components/](https://oat.ink/components/)
- [github.com/knadh/oat](https://github.com/knadh/oat) — MIT, 5,439 stars, 2 open issues,
  created 2026-01-15, `pushed_at` 2026-07-29; releases v0.7.1 (2026-07-28), v0.7.0 (2026-07-21)
- [`src/css/01-theme.css`](https://raw.githubusercontent.com/knadh/oat/master/src/css/01-theme.css)
  — the token block quoted in §3

**React / Tailwind / Compiler / Vite**
- [registry.npmjs.org](https://registry.npmjs.org/) for `react`, `tailwindcss`,
  `@tailwindcss/vite`, `babel-plugin-react-compiler`, `react-compiler-runtime`,
  `eslint-plugin-react-hooks`, `@vitejs/plugin-react`, `vite`, `clsx`, `tailwind-merge`,
  `class-variance-authority`
- [react.dev/blog](https://react.dev/blog) · [react.dev/versions](https://react.dev/versions) ·
  [react.dev/blog/2025/10/07/react-compiler-1](https://react.dev/blog/2025/10/07/react-compiler-1) ·
  [react.dev/learn/react-compiler/installation](https://react.dev/learn/react-compiler/installation) ·
  [react.dev/reference/react-compiler/target](https://react.dev/reference/react-compiler/target)
- [tailwindcss.com/docs/installation/using-vite](https://tailwindcss.com/docs/installation/using-vite) ·
  [tailwindcss.com/docs/theme](https://tailwindcss.com/docs/theme) ·
  [tailwindcss.com/blog](https://tailwindcss.com/blog) ·
  [github.com/tailwindlabs/tailwindcss/releases](https://github.com/tailwindlabs/tailwindcss/releases)

**Headless libraries**
- [radix-ui/primitives](https://github.com/radix-ui/primitives) ·
  [issue #2455 — Table, closed `not_planned` 2025-01-25](https://github.com/radix-ui/primitives/issues/2455) ·
  [Radix styling guide](https://www.radix-ui.com/primitives/docs/guides/styling)
- [mui/base-ui](https://github.com/mui/base-ui) · [base-ui.com](https://base-ui.com/react/overview/quick-start)
- [adobe/react-spectrum](https://github.com/adobe/react-spectrum) ·
  [react-aria.adobe.com/Table](https://react-aria.adobe.com/Table) ·
  [react-aria.adobe.com/styling](https://react-aria.adobe.com/styling)
- [chakra-ui/ark](https://github.com/chakra-ui/ark) · [ark-ui.com](https://ark-ui.com/)
- [tailwindlabs/headlessui](https://github.com/tailwindlabs/headlessui) — no commits since 2026-04-13 ·
  [Adam Wathan, "We had six months left" (2026-01-08)](https://adams-morning-walk.transistor.fm/episodes/we-had-six-months-left)
- [TanStack/table](https://github.com/TanStack/table) · [TanStack Table docs](https://tanstack.com/table/latest/docs/introduction)
- [bundlephobia.com](https://bundlephobia.com/) — all gzip figures

**Yantra internal** — `docs/plans/m4-web-ui.md` §5.2–5.5, §7.2; `tracker.md` rows Y-071, Y-072,
Y-084 and Q14; `CLAUDE.md` §B1, §B5, §B6.
