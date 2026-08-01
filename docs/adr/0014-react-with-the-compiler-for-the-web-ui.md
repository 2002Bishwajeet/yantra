# ADR-0014 — React with the compiler for the web UI, and a token seam for the design system

- **Date:** 2026-08-01
- **Status:** accepted
- **Answers:** Q14

## Context

[ADR-0004](0004-rust-for-the-daemon.md) settled that the web UI is TypeScript and correctly said no
more — there was no UI to have an opinion about. M4 gives it one, and M6's browser terminal will build
on whatever is chosen, so the question had to be answered before Y-072 rather than discovered inside it.

**[Q6](../../tracker.md) removed the usual tiebreakers.** Personal-first means there is no team to hire
for, no onboarding cost, no ecosystem argument. What is left is what the owner will still want to
maintain in a year.

**The constraint that shaped the second half of this decision:** a separate effort is producing a
design system that will be handed to this project and integrated later. So the styling layer is a
**moving part**, and the question was never which library looks best — it was which choice welds the
look in place.

Two research notes were written to answer this, both by execution rather than by reading:
[R8](../research/08-react-and-the-compiler.md) scaffolded a real Vite app, enabled the compiler, and
ran both linters against deliberately-violating components. [R9](../research/09-component-libraries.md)
pulled component registry source across four style presets and compared it line by line.

## Decision

**React with the React Compiler, Vite, and shadcn/ui in CSS-variable mode.**

| Concern | Choice | Why this and not the alternative |
| --- | --- | --- |
| Framework | **React** | Owner's call. Most prior art for M6's terminal; the one they will still read fluently in a year. |
| Optimisation | **React Compiler** (`babel-plugin-react-compiler`, stable since 2025-10-07) | Removes the memoisation discipline a polling dashboard would otherwise need to get right by hand. |
| Build | **Vite** + `@vitejs/plugin-react` + `@rolldown/plugin-babel` | The compiler has **no SWC path and no Babel-free path** today (R8). |
| Components | **shadcn/ui, `cssVariables: true`** | For this page the components are dependency-free plain markup — see below. |
| Lint | **oxlint** with `react/react-compiler` enabled | The Vite template no longer emits an ESLint config; oxlint found strictly more than `eslint-plugin-react-hooks` on the same files, at zero new dependencies (R8). |
| Styling | plain CSS + CSS custom properties | Nothing in the compiler setup pins styling, and CSS-in-JS would add `jsxImportSource` coupling. |

### Why shadcn is barely a dependency here

R9 pulled the Table registry source for four different style presets. **Identical in all four,
`dependencies: null`** — forty lines of plain `<table>` with `data-slot` attributes. Table, alert,
card, skeleton, empty and spinner are all dependency-free; only badge pulls anything, and it is one
deletable import.

So this is not a bet on a component library. **The code is what we would have hand-written anyway**,
arriving already wired to a token vocabulary. The runner-up — hand-written components over CSS
variables — converges on the same file contents.

### The seam, stated so it can be checked later

`tailwind.cssVariables` **cannot be changed after initialisation**; switching means deleting and
reinstalling every component. It is therefore set explicitly at init, and that single flag is what
makes the design system swappable.

Two rules keep it that way:

1. **Never edit `components/ui/`.** All composition wraps those files. Regeneration stays free, and
   `shadcn apply <preset> --only theme` re-themes without touching them.
2. **Call sites pass a `tone`, never a colour.** The whole token swap rests on this one discipline.

**The expected diff when the design system lands is `index.css`, and nothing else.** If it turns out
to be more, this ADR was wrong and should be superseded rather than quietly worked around.

## Consequences

**Gained:**

- A dashboard whose four tables are four *arrays* of column definitions rather than four blocks of
  markup, and whose three-state envelope (`ok` / `failed` / `never`) is enforced by a component that
  only calls `children` in the `ok` branch — so a section **cannot** render a table for a failed
  response. R-23 becomes a type property rather than a discipline.
- ≈10 KB gzip for the component layer, on two packages.
- M6 inherits the largest body of prior art for `xterm.js` in a browser.

**Paid:**

- **Babel is back in the toolchain.** The compiler has no SWC path, so the build grows
  `@babel/core` and a Rolldown Babel plugin.
- **Compiler bail-outs are silent.** Default `panicThreshold: "none"` means a component the compiler
  declined to optimise still builds, exits 0, and is emitted byte-identical to an unoptimised one.
  React's own documentation claims an ESLint error implies the compiler skipped the component; R8
  measured a counter-example. **Proving optimisation happened requires a `logger` callback or a
  build-output check** — assume nothing from a green build.
- **Version floors bite before they break.** `@babel/core` resolves to Babel 7 on Node 24.0.0 and
  Babel 8 on CI's Node 22 from the same install command, silently. Node and `@babel/core` are pinned
  for that reason.
- **TypeScript 7 is not yet safe with the ESLint path** (`typescript-eslint` throws on it), which is
  part of why oxlint is the lint choice rather than a preference about linters.
- One more toolchain in a repo that had exactly one. [Y-073](../../tracker.md) keeps it out of the
  Rust build: embedding the built assets goes behind a cargo feature that is **off by default**, and
  the UI is handed over as a CI artifact rather than by a `build.rs` that shells out to npm. A musl
  cross-build must never acquire a Node dependency.

**Explicitly not a reason for this decision:** bundle size or performance. This page serves one user
over a tailnet and re-renders four tables every few seconds. R9 measured weight and found it
irrelevant at this scale; it is recorded because it is the argument someone will later assume was made.

**Deliberately not decided here:** what the incoming design system is delivered *as* — CSS variables,
a Tailwind preset, or React components. Two of those three favour this decision outright and the third
is neutral, so the answer does not change it; it changes only how much of the theme layer is worth
building before it arrives.
