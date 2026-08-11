# D3 — The dashboard's surface

**Status:** proposed. Written 2026-08-11 from the owner's instruction: *"we can keep the page but we
need proper dashboard spec planning."* Opens no rows (§B0) — §11 proposes them and the owner mints
them.

**Read [D1](01-dashboard.md) first.** D1 settles the plumbing: routes, endpoints, work units, and
which decisions block which. It says of itself that it *"settles nothing about pigment or type"*
(D1 §0). This document fills the half D1 named and left open — with one part still withheld, and §0
says which.

---

## 0. What this settles, and what it does not

**It settles the structure.** What the page is about, how it is navigated, how dense it is, what
words it uses, which states every surface owes a reader, and what it may weigh. None of that depends
on a palette.

**It does not settle pigment, type or motif.** The owner rejected two landing designs and took the
visual direction back (`tracker.md` Y-206, Y-208). That instruction stands, and this document does
not work around it.

The split is safe because [ADR-0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md) already
guarantees it: *"the expected diff when the design system lands is `index.css`, and nothing else."*
Every rule below is written against tokens, never against colours. A prototype arriving later
re-grounds this page; it does not re-plan it.

**Two decisions were the owner's and were taken on 2026-08-11**, before any of this was drafted:

1. The fleet page is about **work**, not inventory. Machines, readiness and sessions move behind it.
2. The structural spec proceeds now. Pigment waits.

---

## 1. What the dashboard is for

One person, their own machines, over a tailnet, often on a phone.

[`docs/brainstorm.md:394`](../brainstorm.md) is the founding UI principle: *"Everything should be
configurable from the interface. No YAML editing. No configuration files."* D1 §0 sharpened it: the
dashboard is where you **work**, not only where you launch.

**The consequence was never drawn.** A page about work opens on work in flight. Today the page
opens on an inventory of everything the daemon knows, and the work is the third card down.

> **[Q6](../../tracker.md#6-open-questions) binds this and is worth restating.** Personal-first:
> single-tenant, no auth beyond Tailscale, no theming, no settings screen. So this document proposes
> no theme switcher and no preferences. It does propose `/settings` for the ntfy relay (D1 §6),
> because a relay URL is the owner's own configuration rather than a second user's — but Q6 says
> *no settings screen* in those words, so the owner should confirm it. Flagged, not resolved.

---

## 2. What is wrong today

Measured 2026-08-11 on `y-182-price-table`, against the daemon's own contract fixtures.

| # | Finding | Evidence |
| --- | --- | --- |
| 1 | The fleet page is seven equally-weighted cards. Nothing is primary. | [`Fleet.tsx:54-113`](../../web/src/routes/Fleet.tsx) |
| 2 | The same ten workspaces are drawn twice, in two tables, with two different verb sets. | `Workspaces` [`Fleet.tsx:163`](../../web/src/routes/Fleet.tsx), `Agents` [`Fleet.tsx:204`](../../web/src/routes/Fleet.tsx) |
| 3 | The create-workspace form sits permanently between them. | [`Fleet.tsx:101`](../../web/src/routes/Fleet.tsx) |
| 4 | `looked 0s ago` prints seven times. D1 §2 asked for one, when there were four. | [`Section.tsx:28-57`](../../web/src/components/Section.tsx) |
| 5 | The page has one heading. Section titles are `div`s, so the page has no outline. | [`Shell.tsx:7`](../../web/src/routes/Shell.tsx), `ui/card.tsx:37` |
| 6 | There is no navigation. The only global link is the `Yantra` wordmark. | [`Shell.tsx:6-10`](../../web/src/routes/Shell.tsx) |
| 7 | **A first paint is drawn as *nobody looked*.** The two are the same sentence. | [`useLooked.ts:44`](../../web/src/useLooked.ts), [`Section.tsx:41`](../../web/src/components/Section.tsx) |
| 8 | The terminal shows nothing while it connects, and retries five times in silence. | [`Terminal.tsx:97-102`](../../web/src/components/Terminal.tsx) |
| 9 | Two forms hand-roll inputs, labels and buttons beside the ported ones. | [`NewWorkspace.tsx:56`](../../web/src/components/NewWorkspace.tsx), [`Act.tsx:121`](../../web/src/components/Act.tsx) |
| 10 | Nothing anywhere honours `prefers-reduced-motion`. Two animations loop forever. | `index.css:17`, `ui/spinner.tsx:10` |
| 11 | Five Geist subsets ship. The interface is English. | `index.css:4` |
| 12 | The phone view is 6,004 px. That is seven screens for the primary page. | measured, 390 px viewport |

**Three things are already right, and this document must not break them.**

- **Contrast passes.** Thirteen distinct text-and-background pairs on the whole page; one falls under
  4.5:1 (the `destructive` badge in light mode, 4.25:1) and it passes in dark. The palette is
  disciplined and no `.tsx` names a colour, which is ADR-0014's second rule holding.
- **The copy is good.** It gives reasons, names who must act, and refuses to guess. §8 keeps it.
- **The three staleness states are distinguishable** — *never*, *failed*, *ok with an age*. That is
  rare. Finding 7 is a hole in it, not an argument against it.

**One suspicion was measured and is false.** The twenty-two unimported primitives cost **zero**
bytes: Rollup drops them, and `Autocomplete`, `Combobox`, `ScrollArea` and `ToggleGroup` appear in
no chunk. Deleting them buys clarity, not weight. §9 says so rather than claiming a saving.

---

## 3. Routes and navigation

The shell gains a nav of three, and every route below it is reachable without going back to `/`.

| Path | Draws | Change |
| --- | --- | --- |
| `/` | **work**: what needs you, what is running, what is idle | §4 |
| `/machines` | the tailnet, readiness, sessions no workspace claims | new; takes three cards off `/` |
| `/m/{machine}` | one machine: beat, readiness detail, its workspaces | as today |
| `/w/{name}` | the workspace, landing in the terminal | as today (D1 §1) |
| `/usage` | spend per model, per session, per workspace | **Y-183** |
| `/new` | the create-workspace form | **Y-185**; takes a fourth card off `/` |

Nav is `fleet · machines · usage`. Three items, because a fourth would be `/new`, and `/new` is a
verb reached from the page that shows you there is nothing to open.

**Every route names itself in `<title>`.** A PWA on a phone shows the title in the switcher, and
today every route is `Yantra`.

---

## 4. The fleet page

Three groups, ordered by **who must act next**: you, the agent, nobody.

```
NEEDS YOU  2
 ⬤ waiting   claude's trust prompt        Answer
 ⬤ broke     crashed — exit 1             Resume

RUNNING  1
 ⬤ api       cachyos-g14 · 47m · $2.11    Open

IDLE  7                                   ＋ New
 ○ done  ○ halted  ○ shell  ○ ghost  …
```

### 4.1 Which state goes in which group

Every input already exists in the reads. **The grouping adds no data and no round trip.**

| Group | States | The one verb |
| --- | --- | --- |
| **Needs you** | `awaiting_trust` | Answer |
| | `crashed`, `killed` | Resume |
| | `unclear` | none — it carries `because` |
| | machine `reached: no` | Fix → `/m/{machine}` |
| | file `loaded: no` | none — the file is the fix |
| **Running** | `running`, `no_agent` | Open |
| **Idle** | `no_session` | Start |
| | `finished`, `stopped` | Resume, or Open (ADR-0015) |

The verbs are [Y-167](../../tracker.md#3-task-board)'s `chosen()` unchanged. This regroups rows; it
does not re-decide a single one.

**A group heading is not a state.** A `finished` row still says *finished* inside Idle, and a
`no_agent` row still says *no agent — opened as a shell* inside Running. The groups answer *who acts
next*, so `no_agent` sits in Running because its session is live, not because an agent is working in
it. Collapsing nine verdicts into three words would throw away the vocabulary R-23 protects.

### 4.2 The footer, and the seven stamps

One line, at the foot of the page:

```
3 machines · 1 unreachable · as of 4s
```

The age is the **oldest** of the five reads, not an average. When one read is more than 30 s older
than the rest, the line names it: `as of 4s · readiness 51s`. A single average would hide the one
stale answer, which is the failure `Age.tsx` was written to prevent.

The three staleness states survive intact. *Never*, *failed* and *ok* are still three different
things, and a failed read still says which read failed.

### 4.3 Idle is a list, not a table

Ten idle workspaces are ten names and a verb. They do not need `MACHINE`, `REPO` and `STARTUP`
columns — those belong on `/w/{name}`, where you go to look at one.

---

## 5. Hierarchy, density and type

### 5.1 Three surfaces, not one

Today every section is a `Card`, so every section weighs the same. A card that holds everything
communicates nothing.

| Surface | What it is | Chrome |
| --- | --- | --- |
| page | the route | none |
| group | *Needs you*, *Running*, *Idle* | a heading and a count; a rule above it |
| row | one workspace, machine or session | hover and focus only |

**Cards are kept for one job**: a panel that is genuinely a separate object on the page — the
terminal, a form. Not for grouping rows.

### 5.2 Headings are headings

`h1` is the route. `h2` is a group. `h3` is a subgroup. Today the page has one `h1` and every
section title is a `div`, so the page cannot be outlined, skimmed by a screen reader, or navigated
by heading.

### 5.3 Density

| Token | Phone | ≥ 48rem |
| --- | --- | --- |
| container | 100% − 2rem | 72rem |
| row height | 3.5rem | 2.5rem |
| gutter | 1rem | 2rem |
| group gap | 1.5rem | 2rem |

A phone row is 3.5rem because a touch target is 44 px and a row carries a button.

### 5.4 Four type sizes

`0.75rem` meta and column labels · `0.875rem` rows and body · `1.125rem` group heading · `1.5rem`
route title. A fifth size is a request to add a level of hierarchy that §5.1 says does not exist.

### 5.5 Numbers need a second face, and this was measured

This page is ages, percentages, memory, token counts and money, in columns. Proportional digits make
a column that does not line up.

**`font-variant-numeric: tabular-nums` will not fix it, because Geist has no `tnum` feature.**
Measured 2026-08-11 in Chromium against the shipped
`geist-latin-wght-normal-BgDaEnEv.woff2`: ten `1`s render 186.64 px and ten `0`s render 200.00 px —
a 7 % difference per digit — and the declaration changes neither number.

So numeric cells take the **system monospace stack**, `ui-monospace, SFMono-Regular, monospace`. It
costs nothing to download, it is always tabular, and this page already uses it for commands and
errors ([`Command.tsx`](../../web/src/components/Command.tsx), `Section.tsx:51`).

**This is a requirement on the identity, not a decision taken for it.** Whatever face arrives later
must carry tabular figures if it wants to serve numbers. `design-system.md` §5 already names IBM
Plex Mono as the utility face, and IBM Plex Mono is monospaced, so the eventual answer is likely to
be *that* face rather than the system stack. Until it lands, the system stack holds the shape.

### 5.6 Column labels stay uppercase

`MACHINE`, `OS`, `STATUS` are correct. [`docs/design-system.md`](../design-system.md) §5 says
*"uppercase, tracked, for labels and meta only"* — of its **utility face**, not of the page — so this
is a convention the eventual identity already agrees with rather than a rule it imposes. Keep them
small, tracked and muted; the face they are set in is still open.

---

## 6. State must be readable without colour

`design-system.md` §7 asked for this and nothing answered it: *"state encoded in form as well as
colour."*

Today a machine's state is a grey pill and a crashed agent is a red one. Grey against grey is
the difference between *online* and *offline*, which is the most important bit on the row.

**Every state carries a shape, not only a tint.**

| Class | Mark | Used by |
| --- | --- | --- |
| needs you | filled dot | `awaiting_trust`, `crashed`, `killed`, unreachable |
| running | filled dot, one weight lighter | `running`, `no_agent` |
| idle | hollow dot | `no_session`, `finished`, `stopped` |
| unknown | hollow dot, dashed | `unclear`, a read that failed |

Four marks, and the fourth is the one this project cares about most: **unknown is drawn, not
omitted** (R-23). A `Status` tone map already exists at [`Status.tsx:3-8`](../../web/src/components/Status.tsx)
and is the right place for it.

---

## 7. The six states every surface owes

loading · empty · error · success · focus · disabled.

Most are present: every fetching surface already draws an empty state and an error state, and every
write draws an in-flight one. Two holes, and the first is a rule rather than a gap.

### 7.1 A question not yet asked was not answered *never*

**This is the sharpest finding in this document.** `useLooked` returns `{ looked: 'never' }` before
the first fetch resolves ([`useLooked.ts:44`](../../web/src/useLooked.ts)), and `Section` draws that
as *"Not looked at yet."* ([`Section.tsx:41`](../../web/src/components/Section.tsx)). So a page
opening for the first time claims the daemon has never looked at the fleet.

That is R-23 broken inside the browser: an answer the page could not yet have is being reported as a
fact about the fleet. Every other layer of this project refuses to do that.

**The fix is a fourth state, not a fourth word.** React Query already distinguishes pending from
resolved. A pending read draws a **skeleton** — `ui/skeleton.tsx` is ported and unused. A resolved
read that says `never` keeps its sentence.

### 7.2 The terminal says nothing while it connects

[`Terminal.tsx:97-102`](../../web/src/components/Terminal.tsx) retries five times, 500 ms apart, in
silence. A person on a phone on bad wifi sees an empty black box for two and a half seconds and then
either a terminal or an error. Name the two: *connecting…*, and *reconnecting, attempt 3 of 5*.

### 7.3 Forms use the ported primitives

Two forms hand-roll inputs, labels and submit buttons ([`NewWorkspace.tsx:56`](../../web/src/components/NewWorkspace.tsx),
[`Act.tsx:121`](../../web/src/components/Act.tsx)) while `ui/input`, `ui/label`, `ui/field`,
`ui/select` and `ui/form` sit unimported. Y-164 ported them for this. A hand-rolled control is a
control that misses a focus ring when the tokens change, which is the exact failure ADR-0014's
second rule exists to prevent.

---

## 8. Words

**The prose rules bind the interface too.** Simplified Technical English for the sentences, Zinsser
for the judgement — the owner's instruction of 2026-08-10, which lands in
[`CLAUDE.md`](../../CLAUDE.md) on the `write-plainly` branch. One idea per sentence. Active voice.
One word, one meaning.

The copy is already the strongest thing about this dashboard. It explains rather than labels, it
names who must act, and it says what it does not know. Two rules keep it that way:

- **A refusal names what would change it.** *"A tmux session is still open on the machine this would
  leave, so nothing was changed."* Keep this shape.
- **A word means one thing.** *Resume* is the POST; *Open* is a URL (Y-167). Do not spend either
  somewhere else.

Group headings are sentence case. Column labels are the exception (§5.6).

---

## 9. Weight, and motion

### 9.1 The budget

Measured on this branch: **141 kB gzip** first load (124 kB JS, 17 kB CSS) and **76 kB** of fonts.

| Budget | Now | Target |
| --- | --- | --- |
| first-load JS + CSS | 141 kB | ≤ 145 kB — hold, do not grow |
| fonts | 76 kB | ≤ 30 kB |

**The JS is React, TanStack Router and Query, and it is the cost of the owner's own ruling** (§B1:
reach for the battle-tested package). It is not a target for cutting. Holding it flat is the goal.

**The fonts are the free win.** `index.css:4` imports every Geist subset, so cyrillic,
cyrillic-ext, latin-ext and vietnamese ship for an English interface. Importing
`@fontsource-variable/geist/latin.css` drops 47 kB and changes no glyph anyone sees.

**The twenty-two unimported primitives are not a weight problem** (§2). Whether they stay is a
clarity question: they are a ported set at a pinned commit, and deleting half of it makes the next
port harder to reconcile. Recommendation: keep them, and say in
[`THIRD-PARTY.md`](../../web/src/components/ui/THIRD-PARTY.md) that the set is complete on purpose.

### 9.2 The motion floor

Nothing in `web/` or `design/` mentions `prefers-reduced-motion`, and two animations loop forever:
the skeleton shimmer (`index.css:17`, 2 s) and the spinner.

`design-system.md` §6 already ruled how to answer this, and the ruling transfers unchanged:

> `prefers-reduced-motion: reduce` renders **one static frame** rather than nothing. Blanking a
> visual is a regression, not an accommodation.

So under reduced motion the skeleton becomes a flat tint and the spinner becomes a static ring. Both
still say *waiting*. One rule in `index.css`.

---

## 10. The phone is the constraint

6,004 px today, against 3,147 px on a desktop. The phone is not the degraded case — it is a PWA
(D1 §4.6), and it is where the owner reads the fleet away from a desk.

**Acceptance: `/` fits in under three phone screens with ten workspaces and three machines.** §4
gets it there on its own: three cards leave the page, idle collapses to a list, and the seven
freshness stamps become one line.

`DataTable`'s label-and-value stack ([`DataTable.tsx:65`](../../web/src/components/DataTable.tsx))
is the right idea and is applied to tables that should not be on this page at all. It stays, on
`/machines`.

---

## 11. What this changes about the four open rows

Three of the four get **smaller**.

| Row | What it drew | What it draws now |
| --- | --- | --- |
| [Y-174](../../tracker.md#3-task-board) | an eighth card, listing three kinds of GitHub attention | a band inside **Needs you**, under its own `h3`. Its verbs open GitHub rather than a terminal, so it is a subgroup and not a merge |
| [Y-180](../../tracker.md#3-task-board) | a session table made actionable | nothing new on `/`. A claimed session **is** its workspace row; an unclaimed one is a row on `/machines` with Kill and Open terminal |
| [Y-183](../../tracker.md#3-task-board) | a page of spend | `/usage`, a nav item — plus a `$` on a running row (§4). The AS_OF date sits beside the figure, as [`price.rs`](../../crates/yantra-core/src/price.rs) already requires of the CLI |
| [Y-185](../../tracker.md#3-task-board) | a better form on `/` | `/new`, a route. It selects with `ui/select` and `ui/combobox` and confirms the directory through `yantra probe` (Y-184) |

None of the four is blocked by anything here. Each is smaller with §3 and §4 landed first.

---

## 12. Work units

Sized to be taken one at a time. **Proposed, not opened** (§B0). Each names what makes it done.

| # | Work | Done when |
| --- | --- | --- |
| **D3.1** | The shell gets navigation and a heading outline | three nav items, an `h1` per route, `h2` per group, and a `<title>` that names the route |
| **D3.2** | `/` groups by who must act next (§4) | three groups from existing reads, no new endpoint, and every verdict keeps its own word |
| **D3.3** | Machines, readiness and sessions move to `/machines` | `/` draws no machine table, and nothing that was reachable stops being reachable |
| **D3.4** | A pending read stops claiming nobody looked (§7.1) | a first paint draws a skeleton; `never`, `failed` and `ok` stay three different things |
| **D3.5** | One freshness line (§4.2) | the oldest read sets the age, and a read more than 30 s behind the rest is named |
| **D3.6** | Density and type tokens (§5.3, §5.4) | four sizes, two row heights, and one container width per breakpoint |
| **D3.7** | Numeric cells take the monospace stack (§5.5) | every numeric column lines up, and no cell asks Geist for a figure it does not have |
| **D3.8** | State carries a mark, not only a tint (§6) | the four marks render, and a greyscale screenshot still distinguishes them |
| **D3.9** | The reduced-motion floor (§9.2) | under `reduce`, both animations hold one frame and neither disappears |
| **D3.10** | Latin-only Geist (§9.1) | fonts under 30 kB, no glyph changed |
| **D3.11** | The terminal names connecting and reconnecting (§7.2) | both states are visible on a socket that takes two seconds |
| **D3.12** | The two forms use the ported primitives (§7.3) | no hand-rolled input, label or submit button remains in app code |
| **D3.13** | `/` fits in under three phone screens (§10) | measured at 390 px with ten workspaces and three machines |

**D3.1 and D3.2 come first.** Every other row is cheaper once the page has an outline and a subject.

---

## Sources

Measured **2026-08-11** on branch `y-182-price-table`, commit `76204c2`, against the daemon's own
`web/src/contract.gen.ts` fixtures served from a throwaway stub. Chromium via Playwright, 1440×900
and 390×844, both colour schemes.

- Page height 3,147 px desktop and 6,004 px phone; 48 interactive elements; one `h1`.
- Geist has no `tnum` feature and its digits are proportional: ten `1`s measure 186.64 px against
  200.00 px for ten `0`s at 40 px, and `font-variant-numeric: tabular-nums` changes neither.
- Contrast: 13 distinct text-and-background pairs in light, 15 in dark; one under 4.5:1
  (`destructive` badge, 4.25:1, light only).
- Bundle: `index` 396,065 B raw / 124,633 B gzip; CSS 119,373 B / 17,620 B; five Geist woff2
  totalling 76,420 B.
- `Autocomplete`, `Combobox`, `ScrollArea` and `ToggleGroup` appear in no built chunk.

**Yantra internal** — [D1](01-dashboard.md); [R13](../research/13-dashboard-revamp-and-github.md);
[`docs/design-system.md`](../design-system.md) §§5–7;
[`docs/plans/m4-dashboard-next.md`](../plans/m4-dashboard-next.md) §"What the design system should be
asked for"; [`docs/brainstorm.md:394`](../brainstorm.md);
ADRs [0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md),
[0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md),
[0015](../adr/0015-resume-forks-the-conversation.md); Q6; R-2, R-23; I-47, I-49.
