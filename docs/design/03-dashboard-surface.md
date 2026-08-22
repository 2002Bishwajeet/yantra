# D3 — The dashboard's surface

**Status:** proposed. Written 2026-08-11 from the owner's instruction — *"we can keep the page but we
need proper dashboard spec planning"* — and settled the same day in a **27-question interview** whose
answers are recorded inline. Opens no rows (§B0); §16 proposes them and the owner mints them.

**Read [D1](01-dashboard.md) first.** D1 settles the plumbing: routes, endpoints, work units, and
which decisions block which. It says of itself that it *"settles nothing about pigment or type"*
(D1 §0). This document fills the half D1 named and left open.

Every decision below is the owner's. Where a decision has a cost, the cost is written next to it.

---

## 0. What this settles, and what it does not

**It settles the structure.** What the page is about, how it is navigated, how dense it is, what
words it uses, what states every surface owes a reader, how it fails, and what it may weigh.

**It does not settle pigment, type or motif.** The owner rejected two landing designs and took the
visual direction back (`tracker.md` Y-206, Y-208). That instruction stands.

The split is safe because [ADR-0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md)
guarantees it: *"the expected diff when the design system lands is `index.css`, and nothing else."*
Every rule below is written against tokens, never against colours. §6 fixes the **number** of
semantic roles, which is identity-neutral; it fixes none of their values.

**The reference is Linear** — quiet, dense, keyboard-first, near-monochrome, motion close to absent.
Chosen 2026-08-11 over Tailscale's admin, k9s and Grafana. It is a reference for *register*, not for
appearance: it sets how much chrome is allowed and how loud state may be.

> **[Q6](../../tracker.md#6-open-questions) binds this, and the owner amended it on 2026-08-11.**
> Q6 closed personal-first: single-tenant, no auth beyond Tailscale, *no theming, no settings
> screen*. **What it refused is preferences, not configuration.** So there is no theme switcher, no
> density control and no layout choice — and `/settings` exists for the things a person must set
> before the product works: the ntfy relay's URL and token (D1 §6), which are environment variables
> nothing in the product can write today.

---

## 1. What the dashboard is for

One person, their own machines, over a tailnet, often on a phone.

[`docs/brainstorm.md:394`](../brainstorm.md) is the founding UI principle: *"Everything should be
configurable from the interface. No YAML editing. No configuration files."* D1 §0 sharpened it: the
dashboard is where you **work**, not only where you launch.

**The consequence was never drawn.** A page about work opens on work in flight. Today it opens on an
inventory of everything the daemon knows, and the work is the third card down.

§7.5 closes the one place the founding principle is currently broken.

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
| 13 | One page carries four time formats, one of them a raw ISO timestamp. | `columns.tsx:93`, `:100`, `:268`; `Age.tsx:54` |
| 14 | Nothing confirms anything. `Stop` is a 44 px target beside `Open`. | [`Act.tsx:173-272`](../../web/src/components/Act.tsx) |

**Three things are already right, and this document must not break them.**

- **Contrast passes.** Thirteen distinct text-and-background pairs on the whole page; one falls under
  4.5:1 (the `destructive` badge in light mode, 4.25:1) and it passes in dark. No `.tsx` names a
  colour, which is ADR-0014's second rule holding.
- **The copy is good.** It gives reasons, names who must act, and refuses to guess. §8 keeps it.
- **The three staleness states are distinguishable** — *never*, *failed*, *ok with an age*. Finding 7
  is a hole in it, not an argument against it.

**One suspicion was measured and is false.** The twenty-two unimported primitives cost **zero**
bytes: Rollup drops them, and `Autocomplete`, `Combobox`, `ScrollArea` and `ToggleGroup` appear in no
chunk. Deleting them buys clarity, not weight. §9.1 says so rather than claiming a saving.

> **Finding 10 reaches one word too far, and its substance is unchanged. Recorded 2026-08-11
> (Y-194).** One `prefers-reduced-motion` rule already shipped, inside a sheet the page imports:
> `shadcn/tailwind.css` stops `.shimmer`'s animation under `reduce` and restores the text colour it
> was painting over. So *nothing anywhere* is too strong. Read the finding as **nothing in app code
> honours it**, which is what it was counting and what §9.3 answers.
>
> The correction costs the finding nothing, because the page uses no `.shimmer` — the rule protects a
> utility this interface never draws. The two animations the finding names, the skeleton and the
> spinner, were both unguarded exactly as it says.
>
> One detail is worth carrying for whoever greps next: the rule is in `shadcn/tailwind.css`, **not**
> in `tw-animate-css`, which ships no `prefers-reduced-motion` at all at 1.4.0. §9.3 repeats the
> claim in its own words and takes the same correction; its ruling is untouched.

---

## 3. Routes and navigation

| Path | Draws | Change |
| --- | --- | --- |
| `/` | **work**: what needs you, what is running, what is idle | §4 |
| `/machines` | every machine compared, plus sessions no workspace claims | new; takes three cards off `/` |
| `/m/{machine}` | one machine as a subject: beat, readiness detail, its workspaces | as today, plus a re-check |
| `/w/{name}` | the workspace: terminal · transcript · spend | §11 |
| `/usage` | spend, one machine at a time, on request | **Y-183**, §11.4 |
| `/new` | the create-workspace form | **Y-185**; takes a fourth card off `/` |
| `/settings` | the ntfy relay's URL and token | §0's Q6 amendment; D1 §6 |
| `/w/{name}/repair` | the raw file, for a workspace that will not parse | §7.5 |

Nav is `fleet · machines · usage`. Three items. The other three are reached from the thing that needs
them: `/new` from the page that shows you there is nothing to open, `/repair` from the failure it
fixes, and `/settings` from the readiness check that reports notifications cannot be sent.

**Every route names itself in `<title>`.** A PWA shows the title in the phone's app switcher, and
today every route is `Yantra`.

### 3.1 `/machines` compares; `/m/{name}` is a subject

Without a rule these drift into two pages showing the same thing.

| | Answers | Holds |
| --- | --- | --- |
| `/machines` | *which one* | one row per machine, the same columns, sortable; orphan sessions below |
| `/m/{name}` | *what about this one* | readiness detail, its beat, its workspaces, its sessions, its re-check |

No detail table on `/machines`. No comparison on `/m/{name}`.

### 3.2 A palette, for navigation only

`⌘K` opens [`ui/command.tsx`](../../web/src/components/ui/command.tsx), ported in Y-166 and never
used. It finds workspaces, machines and routes. **It runs no verbs.**

The reason is the next section: once `/` holds the work rather than the inventory, the palette is how
you reach the ninety per cent of your fleet that is idle. Keeping verbs out means a destructive
action is never two keystrokes from anywhere, which §4.7 depends on.

---

## 4. The fleet page

Three groups, ordered by **who must act next**: you, the agent, nobody.

```
NEEDS YOU  2
 ⬤ waiting          claude's trust prompt    Answer
 ◌ pi unreachable   4 workspaces             Fix

RUNNING  1
 ⬤ api      claude   cachyos-g14 · 47m       Open

IDLE  5                                      ＋ New
 ○ done  ○ halted  ○ shell  ○ ghost  ○ old

3 machines · 1 unreachable · 2 sessions unclaimed · as of 4s
```

### 4.1 Which state goes in which group

Every input already exists in the reads. **The grouping adds no data and no round trip.**

| Group | State | The one verb |
| --- | --- | --- |
| **Needs you** | `awaiting_trust` | Answer, **in place** (§4.5) |
| | `crashed`, `killed` | Resume |
| | `unclear` | none — it carries `because` |
| | a machine that did not answer | Fix → `/m/{machine}` |
| | a file that will not parse | Repair → `/w/{name}/repair` |
| **Running** | `running`, `no_agent` | Open |
| **Idle** | `no_session` | Start |
| | `finished`, `stopped` | Resume, or Open (ADR-0015) |

The verbs are [Y-167](../../tracker.md#3-task-board)'s `chosen()` unchanged. This regroups rows; it
re-decides none of them.

**An unreachable machine is one row, and its workspaces are not listed.** A dead Pi holding four
workspaces would otherwise push four rows into the group that means *act now*, and they would all
name the same cause. The machine is the problem; the workspaces are downstream of it. The row reads
`pi unreachable · 4 workspaces` and links to `/m/pi`.

**A group heading is not a state.** A `finished` row still says *finished* inside Idle, and a
`no_agent` row still says *no agent — opened as a shell* inside Running. The groups answer *who acts
next*, so `no_agent` sits in Running because its session is live, not because an agent works in it.
Collapsing nine verdicts into three words would throw away the vocabulary R-23 protects.

> **A workspace the agent class answered 404 for has no state, and this table has no row for it.
> Recorded 2026-08-11 (Y-188).** `useAgents` collapses that 404 to `null` (Y-084), and `chosen()`
> reads `null` as *nothing has been looked at yet*. Filing it under *needs you*, *running* or *idle*
> would be a guess painted as knowledge, which is what R-23 forbids.
>
> So there is a quiet fourth group, **Not read yet**, drawn last and empty in normal operation.
> [`web/src/work.ts`](../../web/src/work.ts) carries it as the `unknown` band. It adds no data and no
> round trip, exactly as the three above it do not.
>
> **It forced a consequence in §4.4, and the consequence is §7.1's mistake in a second place.** Every
> row starts unread. Held order therefore pinned all of them in this group, and the first read never
> moved them, so the page kept saying *unread* about something it had read. **Held order never holds
> a row in this band**: a row leaves it the moment its first read arrives. A row nobody has seen
> before takes its live band at once for the same reason — appearing is not moving, and no thumb is
> over a row that was not there.

### 4.2 The agent has a column, and there is one agent

Each row names its agent. Today every value is `claude`, and a plain shell reads `—`.

[ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md) has one `Agent` variant and its comment
invites a second; D1 §4.2 records that the owner wants Codex and others. **Design for several, ship
one.** Nothing here builds a second variant.

The cost to know: state detection is per-agent. I-49 matches a fragment of *Claude's* trust dialog,
so a second agent needs its own matcher or an honest `Verdict::Unclear`. A column that exists does
not make the detection generic.

### 4.3 The footer

One line, at the foot of the page.

```
3 machines · 1 unreachable · 2 sessions unclaimed · as of 4s
```

The age is the **oldest** of the five reads, never an average. When one read is more than one refresh
period (30 s) behind the rest, the line names it: `as of 4s · readiness 51s`. An average would hide
the one stale answer, which is the failure `Age.tsx` exists to prevent.

`2 sessions unclaimed` links to `/machines`. A session no workspace claims is holding a machine and
nothing else in Yantra will mention it, so the work page counts it without giving it a group.

### 4.4 The order is held; the rows are not

Rows update in place every 5 s. **The order recomputes only when you ask.**

A change shows as a pill above the groups: `↻ 2 changed · reorder`. Nothing moves under a thumb.

**The cost, stated plainly:** between the change and your tap, a row shows its true state inside the
group it had when the order was last computed. A crashed agent reads *crashed — exit 1* while still
sitting under Running. That is the price of not moving a target under a finger on a phone, and the
pill is what stops it being a lie.

### 4.5 Answering the trust prompt in place

`awaiting_trust` is the one state waiting on a person, and
[ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md) says the person is never Yantra.

The row expands to show **the pane itself** — the dialog as the agent drew it, with the options it
offers — and you press the key. Yantra renders the question and forwards your keystroke. It does not
read the options and draw its own buttons: that would spend I-49's fragility budget on a control
rather than on a status, and a mismatched match would answer the wrong thing.

**It is the terminal component at twelve rows, on the existing socket.** No new route, no new write
path, and every fidelity guarantee in D1 §4.5 already covers it. The cost is one socket per expanded
row.

### 4.6 Idle collapses

Idle shows a count and the few most recently used. The rest sits behind one disclosure.

Thirty idle workspaces would otherwise be the longest thing on the page and the least urgent. `⌘K`
is how you reach a specific one.

### 4.7 Confirming

**Only what cannot be undone asks first.** Deleting a workspace and killing an unclaimed session
confirm. `Stop` and `Resume` do not — a stopped session starts again, and a dialog on every action
trains you to tap through the one that matters.

Undo was considered and refused: the daemon persists nothing, so undoing a stop means re-running
`up`, and ADR-0015 says the conversation may not come back identically. A control that promises to
reverse something it cannot reverse is worse than a question.

### 4.8 First run

**When no workspace exists, `/` becomes the setup checklist.** It draws [D2](02-setup.md) §3.1's nine
checks per machine — what is missing, and what only you can fix — with the re-check button and a New
workspace call to action below.

It returns to the work page the moment one workspace exists.

The reason is that the alternative sends a fresh install to a form whose `up` will fail, because
`claude` is not installed on the target and nothing said so. R13 §6 named this gap: *the interface
has never been given a way to say what is still missing.*

> **On the install this section exists for, the checklist has nothing to draw. Found while planning
> Y-197, recorded 2026-08-11.** Readiness is swept only for **the machines a workspace names** —
> `doctor::fleet`, and `/api/readiness/{machine}` says so in the words of its own 404: *"no workspace
> names a machine called `x`, so none was asked"*. A fresh install has no workspace, so no machine is
> asked and D2 §3.1's nine checks would draw blank. The page would say nothing at the one moment it
> is the whole page.
>
> **So the page lists the tailnet's machines and asks each one on request**, through §12's re-check
> `POST`. Nothing fans out on open: one machine is asked per tap, which is §11.4's rule applied to a
> second page.
>
> The re-check is therefore not an extra affordance beside the checklist. **It is what gives the
> checklist anything to show**, and this section depends on the row §12's table calls *"re-check
> readiness now"* — **D3.21 before D3.20**. That is an order, not a block, so §16's count of two
> blocked units stands.

---

## 5. Hierarchy, density and type

### 5.1 Three surfaces, not one

Today every section is a `Card`, so every section weighs the same. A card that holds everything
communicates nothing.

| Surface | What it is | Chrome |
| --- | --- | --- |
| page | the route | none |
| group | *Needs you*, *Running*, *Idle* | a heading, a count, a rule above |
| row | one workspace, machine or session | hover and focus only |

**Cards keep one job**: a panel that is genuinely a separate object — the terminal, a form, the
expanded trust pane. Never for grouping rows.

### 5.2 Headings are headings

`h1` is the route. `h2` is a group. `h3` is a subgroup. Today the page has one `h1` and every section
title is a `div`, so it cannot be outlined, skimmed by a screen reader, or navigated by heading.

### 5.3 Density

| | Phone | ≥ 48rem |
| --- | --- | --- |
| container | 100% − 2rem | 72rem |
| row height | 3.5rem | 2.5rem |
| gutter | 1rem | 2rem |
| group gap | 1.5rem | 2rem |

A phone row is 3.5rem because a touch target is 44 px and a row carries a button.

### 5.4 Four type sizes

`0.75rem` meta and column labels · `0.875rem` rows and body · `1.125rem` group heading · `1.5rem`
route title. A fifth size asks for a level of hierarchy §5.1 says does not exist.

### 5.5 Numbers need a second face, and this was measured

This page is ages, percentages, memory, token counts and money, in columns. Proportional digits make
a column that does not line up.

**`font-variant-numeric: tabular-nums` will not fix it, because Geist has no `tnum` feature.**
Measured 2026-08-11 in Chromium against the shipped `geist-latin-wght-normal-BgDaEnEv.woff2`: ten
`1`s render 186.64 px and ten `0`s render 200.00 px — 7 % per digit — and the declaration changes
neither number.

So numeric cells take the **system monospace stack**, `ui-monospace, SFMono-Regular, monospace`. It
downloads nothing, it is always tabular, and this page already uses it for commands and errors
([`Command.tsx`](../../web/src/components/Command.tsx), `Section.tsx:51`).

**This is a requirement on the identity, not a decision taken for it.** Whatever face arrives must
carry tabular figures if it is to serve numbers. `design-system.md` §5 already names IBM Plex Mono as
the utility face, so the eventual answer is likely that face rather than the system stack.

### 5.6 Column labels stay uppercase

`MACHINE`, `OS`, `STATUS` are correct. [`docs/design-system.md`](../design-system.md) §5 says
*"uppercase, tracked, for labels and meta only"* — of its **utility face**, not of the page — so this
is a convention the identity already agrees with rather than one it imposes. Small, tracked, muted.

### 5.7 One clock

Four formats appear on the fleet page today, including a raw `2026-07-07T09:00:00Z`.

**Under 24 hours reads as an age. Over 24 hours reads as a date.** `4s`, `12m`, `6h`, then `7 Jul`.
The exact timestamp is in the `title` attribute throughout.

`36d` is a number you have to convert; `7 Jul` is a day you remember. The boundary is arbitrary and
is chosen once here so it is not chosen four times by four components.

**tmux's `created` string is the exception.** [`api.ts`](../../web/src/api.ts) calls it opaque —
tmux formats it on the remote machine's clock, in that machine's timezone. Parse it to an age where
it parses; show it verbatim where it does not. Guessing a remote clock's timezone would be a lie in
a page whose whole discipline is refusing to guess.

> **Those two sentences cannot both hold, and parsing is the guess. Recorded 2026-08-11 (Y-192).**
> `created` arrives as `Thu Jul 30 13:02:31 2026`, and that string names **no zone**. V8 reads it
> happily, on the *browser's* clock, so a machine in another zone yields an age wrong by the offset
> with nothing on screen to reveal it. *Where it parses* is not the safe half of the rule — it is the
> half that lies. The parse is also implementation-defined, so another engine can fail where Chromium
> succeeds.
>
> **So a stamp is read only where it names its zone** — a trailing `Z` or `±HH:MM`. `last_seen` is
> ISO and zoned, so it still reads `7 Jul`; tmux's `created` shows verbatim.
> [`web/src/lib/time.ts`](../../web/src/lib/time.ts) holds the one test, and returns `null` where no
> instant can be read out of a string, which is the caller's cue to print it as it arrived.
>
> What changed sits upstream of the sentence above: the string was taken to carry an instant, and it
> carries a wall-clock reading. **The fix that would give this page a real age is in the daemon, and
> nobody has proposed it.** [`tmux.rs`](../../crates/yantra-core/src/tmux.rs) asks tmux for
> `#{t:session_created}`, which is tmux's own formatting; `#{session_created}` is a Unix epoch, which
> needs no zone because it is not a wall clock. No row asks for that change today.

---

## 6. State without colour

`design-system.md` §7 asked for this and nothing answered it: *"state encoded in form as well as
colour."*

### 6.1 Four marks

| Class | Mark | States |
| --- | --- | --- |
| needs you | filled dot | `awaiting_trust`, `crashed`, `killed`, unreachable |
| running | filled dot, one weight lighter | `running`, `no_agent` |
| idle | hollow dot | `no_session`, `finished`, `stopped` |
| unknown | hollow dot, dashed | `unclear`, a read that failed |

The fourth is the one this project cares about most: **unknown is drawn, not omitted** (R-23).
[`Status.tsx:3-8`](../../web/src/components/Status.tsx) already holds the tone map and is where this
belongs.

### 6.2 Three semantic colours, and the accent is not one

| Role | Carries |
| --- | --- |
| `critical` | `crashed`, `killed`, unreachable, a file that will not parse |
| `warn` | `awaiting_trust`, a reading that has gone stale |
| `good` | `running`, a readiness check that is present |
| — | idle, finished, stopped: the page's own foreground |
| — | `unclear`, a failed read: **no colour**, the dashed mark alone |
| `accent` | links and the primary button. **Never state.** |

Five roles including the accent. Two rules behind them:

**Unknown gets no tint.** Colouring uncertainty makes it look like a decision. The dashed hollow mark
is the whole treatment, and it is the one that must survive a greyscale screenshot.

**The accent never means a state.** `design-system.md` §7's warning, verbatim in effect: otherwise *a
crashed agent and a hyperlink end up the same colour*.

> **Two of the three roles have no value to take, so today they take the foreground. Recorded
> 2026-08-11 (Y-193).** §0 fixes the **number** of roles and none of their values, and the owner
> holds the visual direction. The shadcn sheet the page ships carries one semantic colour,
> `--destructive`. So `--tone-critical` takes `--destructive`, and `--tone-warn` and `--tone-good`
> take `currentColor` until the design system grounds them.
>
> **`warn` and `good` are therefore visually identical to the page's own foreground.** The separation
> a reader sees is carried entirely by §6.1's four marks — which is what this section already
> requires of them, so nothing promised is lost. No pigment was invented, which is §0 holding rather
> than bending.
>
> Say it plainly: the roles exist and two are unpainted. Grounding them is one line each in
> `index.css`, which is the diff ADR-0014 already expects. What those two values should be is the
> owner's to decide and is not decided.

---

## 7. What every surface owes a reader

loading · empty · error · success · focus · disabled.

Every fetching surface already draws an empty and an error state, and every write draws an in-flight
one. Five holes follow.

### 7.1 A question not yet asked was not answered *never*

**The sharpest finding in this document.** `useLooked` returns `{ looked: 'never' }` before the first
fetch resolves ([`useLooked.ts:44`](../../web/src/useLooked.ts)), and `Section` draws that as *"Not
looked at yet."* ([`Section.tsx:41`](../../web/src/components/Section.tsx)). A page opening for the
first time therefore claims the daemon has never looked at the fleet.

That is R-23 broken inside the browser. Every other layer of this project refuses to report an answer
it could not have.

**A fourth state, not a fourth word.** React Query already separates pending from resolved. A pending
read draws a **skeleton** — `ui/skeleton.tsx` is ported and unused. A resolved read that says `never`
keeps its sentence.

### 7.2 The whole page cannot be reached

Off the tailnet, the service worker serves the shell and every fetch fails. Today that is seven
sections each repeating the same failure.

**When every read fails the same way, the page says it once.** And it says what it cannot tell:

> Nothing here can be reached. Every read failed the same way, so this is the connection to `yantrad`
> rather than the fleet. Whether you are off the tailnet or the daemon is down is not something this
> page can tell.

R-23 applied to the browser's own network. The page does not draw the last data it had — old fleet
state on screen during an outage is the failure mode this project spends the most effort avoiding.

### 7.3 The terminal says nothing while it connects

[`Terminal.tsx:97-102`](../../web/src/components/Terminal.tsx) retries five times, 500 ms apart, in
silence. On bad wifi you see an empty black box for two and a half seconds. Name both states:
*connecting…* and *reconnecting, attempt 3 of 5*.

### 7.4 Forms use the ported primitives

Two forms hand-roll inputs, labels and submit buttons
([`NewWorkspace.tsx:56`](../../web/src/components/NewWorkspace.tsx),
[`Act.tsx:121`](../../web/src/components/Act.tsx)) while `ui/input`, `ui/label`, `ui/field`,
`ui/select` and `ui/form` sit unimported. Y-164 ported them for this. A hand-rolled control is one
that loses its focus ring when the tokens change — the failure ADR-0014's second rule prevents.

### 7.5 A workspace file that will not parse

`yantra edit` cannot repair one: `update` loads before it writes, so the file is the fix (I-30,
Y-137). Today the dashboard names the error and offers nothing, and you go to a terminal — which is
the founding UI principle broken in exactly one place.

**`/w/{name}/repair` shows the file's bytes with the parse error beside them.** You edit and save.

Two bounds, both decided by the owner on 2026-08-11:

1. **It opens only on a file that will not load.** A workspace that parses is edited through the
   validated form, as today.
2. **The save re-validates.** The daemon parses the bytes and refuses to write a file that still
   will not load, naming the next error.

Together they mean the raw path can only ever move a file from *broken* to *valid*. It cannot create
a broken one, and it cannot bypass the refusals Y-137 deliberately put on both sides of `create` and
`update`.

**The cost is real and worth naming.** You cannot save a partial fix and come back to it. On a phone,
half-way through a file with two errors, that is a genuine loss — and it is the price of the daemon
never holding a write that skips `workspace::parse`.

§12 records the decision this needs.

---

## 8. Words

**The prose rules bind the interface too.** Simplified Technical English for the sentences, Zinsser
for the judgement — the owner's instruction of 2026-08-10, which lands in
[`CLAUDE.md`](../../CLAUDE.md) on the `write-plainly` branch. One idea per sentence. Active voice.
One word, one meaning.

The copy is already the strongest thing about this dashboard. Two rules keep it that way:

- **A refusal names what would change it.** *"A tmux session is still open on the machine this would
  leave, so nothing was changed."* Keep this shape.
- **A word means one thing.** *Resume* is the POST; *Open* is a URL (Y-167). Do not spend either
  elsewhere.

Group headings are sentence case. Column labels are the exception (§5.6).

### 8.1 Yantra's sentence first; the other program's text behind it

`connect to host pi port 22: Connection refused` is truthful and 46 characters wide on a 390 px
phone.

The row says what it means and what to do. The exact text from `ssh`, `tmux` or `git` is one tap
away, and copyable. Nothing is hidden, and what you read at a glance is the sentence Yantra wrote.

---

## 9. Weight and motion

### 9.1 The budget

Measured on this branch: **141 kB gzip** first load (124 kB JS, 17 kB CSS) and **76 kB** of fonts.

| Budget | Now | Target |
| --- | --- | --- |
| first-load JS + CSS | 141 kB | ≤ 145 kB — hold, do not grow |
| fonts | 76 kB | ≤ 30 kB |

**The JS is React, TanStack Router and Query, and it is the cost of the owner's own ruling** (§B1:
reach for the battle-tested package). Holding it flat is the goal, not cutting it.

**The fonts are the free win.** `index.css:4` imports every Geist subset, so cyrillic, cyrillic-ext,
latin-ext and vietnamese ship for an English interface. Importing
`@fontsource-variable/geist/latin.css` drops 47 kB and changes no glyph anyone sees.

**The twenty-two unimported primitives are not a weight problem.** Whether they stay is a clarity
question: they are a ported set at a pinned commit, and deleting half makes the next port harder to
reconcile. Keep them, and say in
[`THIRD-PARTY.md`](../../web/src/components/ui/THIRD-PARTY.md) that the set is complete on purpose.

> **The saving is right and the file named does not exist. Recorded 2026-08-11 (Y-194).**
> `@fontsource-variable/geist@5.3.0` publishes **no per-subset stylesheet**. It ships `index.css`,
> `wght.css` and `wght-italic.css`; `index.css` and `wght.css` are byte-identical, and each declares
> all five subsets. There is no `latin.css` to import.
>
> **The 47 kB was measured and holds: 76,420 B to 29,400 B, a saving of 47,020 B.** What works is a
> local `@font-face` in `index.css`, copied from the package's own latin block:
>
> ```css
> @font-face {
>   font-family: 'Geist Variable';
>   font-style: normal;
>   font-display: swap;
>   font-weight: 100 900;
>   src: url("@fontsource-variable/geist/files/geist-latin-wght-normal.woff2") format('woff2-variations');
>   unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;
> }
> ```
>
> Two details are worth carrying. **Vite resolves a bare package specifier inside `url()`**, so no
> relative path into `node_modules` is needed and no build step copies the file by hand. And the
> `unicode-range` and the `format()` are the package's own, so **no glyph changes** — which is the
> half of D3.12 that a hand-written `@font-face` could quietly break.
>
> Two figures elsewhere were checked and left alone. Sources' *"five Geist woff2 totalling 76,420 B"*
> is correct: it measures the branch this document was written on. §16's D3.12 asks for fonts under
> 30 kB, and 29,400 B meets it. The table above still reads **76 kB** under *Now*, which is what
> *now* meant on 2026-08-11 before this landed.

> **The budget is met at 144.38 kB, and the unimported primitives were a weight problem after all.
> Recorded 2026-08-22 (Y-194).** First load is the entry script and every `modulepreload` and
> stylesheet `dist/index.html` names, gzip -9, decimal kB. It was **149.73 kB**; it is **144.38 kB**,
> against the 145 kB ceiling. **Fonts are unchanged and are not in that figure.**
>
> | | before | after |
> | --- | --- | --- |
> | entry JS | 116.82 | 106.16 |
> | Base UI core, preloaded | 13.63 | 13.63 |
> | TanStack Query, preloaded | — | 8.31 |
> | `button`, preloaded | — | 1.64 |
> | react-dom, preloaded | 1.36 | 1.36 |
> | CSS | 17.91 | 13.28 |
> | **total** | **149.73** | **144.38** |
>
> **The paragraph above says the twenty-two unimported primitives are not a weight problem. For the
> JS that is right, and for the CSS it is wrong.** Tailwind reads a file whether or not a route
> imports it, so eleven primitives nothing can reach were worth **3.74 kB gzip** — a fifth of the
> stylesheet — in rules for markup the browser never draws. **The files stay**, which is what this
> section actually settles; `index.css` skips them in the scan and `motion.test.ts` recomputes the
> list from the import graph, so importing one is enough to get its CSS back. A further **0.57 kB**
> was the automatic scan reading `README.md`, `package.json` and the tests and taking an English word
> for a class name — `.container`, `.hidden`, `.transition`, `.tabular-nums`. `source(none)` and two
> `@source` lines end that.
>
> **`tailwind-merge` at 8.9 kB was the obvious cut and it is load-bearing.** Logging every `cn` call
> across the suite found 22 distinct class strings where the merge drops a class, all in the ported
> set: the table head keeps `text-muted-foreground` over `text-foreground`, the autocomplete input
> keeps `h-9.5` over `h-8.5`, a badge keeps `border-border` over `border-transparent`, and
> `text-body` beats `text-sm` — which is the extension D3 §5.4 needed. A `clsx`-only `cn` changes all
> of them and no test sees it. It stays (§B1).
>
> **`/usage` is split and no other route pays to be.** It is worth 0.72 kB on its own. Splitting
> `/machines` and `/m/$machine` beside it lands **1.34 kB above the unsplit build**, so those two
> cost more than `/usage` saves — Y-197's reason, which the setup checklist already found: Rollup
> hoists what they share with the fleet into preloaded chunks of their own, and many small gzip
> streams lose the dictionary one large one shares.

### 9.2 What moves

**Motion exists only where something would otherwise teleport.** Overlays fade. Disclosures slide.
The `↻ changed` pill enters. One duration and one easing, both tokens.

Rows never animate. Groups never visibly re-flow — §4.4 already holds the order, so there is nothing
to animate. Nothing loops except the skeleton.

Motion is not used as signal. A row entering *Needs you* is marked by the pill and by its position,
not by a flash: a page you glance at from across a room should not depend on having been watched at
the right moment.

> **Two tokens cannot reach the things that animate, so they ground Tailwind's defaults instead.
> Recorded 2026-08-11 (Y-194).** The overlays and disclosures named above live in
> `web/src/components/ui/`, and ADR-0014 forbids editing that directory. A rule written as two
> classes those files would have to spend has no way in.
>
> So `--motion-duration` and `--motion-ease` ground Tailwind's own `--default-transition-duration`
> and `--default-transition-timing-function`. Every `transition-colors` and `transition-all` that
> names no duration of its own then takes them, which is most of the ported set — `popover`,
> `button`, `input`, `select`, `badge` and the rest. Verified in the built CSS. **The rule holds, and
> it is reached indirectly.**
>
> **Four primitives name a duration on the base class and keep it**: `sheet`, `collapsible`, `switch`
> and `menu`, all at 200 ms, and `sheet` names `ease-in-out` as well. Two of those four are the
> overlay fade and the disclosure slide this section names, so the timing a reader sees there is the
> port's rather than D3's. A utility class cannot be overruled from a token, and editing the file is
> what ADR-0014 refuses. **Named, not solved.**

### 9.3 The reduced-motion floor

Nothing in `web/` or `design/` mentions `prefers-reduced-motion`, and two animations loop forever:
the skeleton shimmer (`index.css:17`, 2 s) and the spinner.

`design-system.md` §6 already ruled how to answer this, and the ruling transfers unchanged:

> `prefers-reduced-motion: reduce` renders **one static frame** rather than nothing. Blanking a
> visual is a regression, not an accommodation.

So the skeleton becomes a flat tint and the spinner a static ring. Both still say *waiting*. One rule
in `index.css`.

---

## 10. The phone is the constraint

6,004 px today against 3,147 px on a desktop. The phone is not the degraded case — it is a PWA
(D1 §4.6), and it is where the owner reads the fleet away from a desk.

**Acceptance: `/` fits in under three phone screens with ten workspaces and three machines.** §4 gets
it there: three cards leave the page, idle collapses, and seven freshness stamps become one line.

`DataTable`'s label-and-value stack ([`DataTable.tsx:65`](../../web/src/components/DataTable.tsx)) is
the right idea applied to tables that should not be on this page. It stays, on `/machines`.

---

## 11. The workspace page

`/w/{name}` holds three things: the live pane, the transcript, and spend.

### 11.1 Three tabs, and the URL carries which

`terminal · transcript · spend`, as `?view=`. A link reopens what you sent.

**The default differs by width.** A desktop lands in the terminal — D1 §1 already says that is what
you came for. A phone lands in the transcript.

### 11.2 Why a phone does not land in a terminal

Claude Code's TUI assumes roughly 80 columns. A 390 px viewport gives about 45 at a readable size.

So the phone lands on the transcript — what the agent has done, in normal type — with a **Take
control** button that opens the actual pane. The terminal is not weakened; it stops being the only
way to find out what happened.

### 11.3 The transcript is the history, and it lives on the far machine

**Nothing is added to the daemon.** The daemon persists nothing (Y-044), so *what happened overnight*
is answered by reading the agent's own transcript where the work happened.
[`logs.rs`](../../crates/yantra-core/src/logs.rs) already opens that file and
[`tokens.rs`](../../crates/yantra-core/src/tokens.rs) already sums it.

**The view shows turns, with tool calls collapsed.** What the agent said and what you said, in normal
type. Each tool call is one line — *ran cargo test*, *edited api.ts* — expandable. It reads as a
record of work rather than a log, which is what you want at 3 am on a phone.

> **This sends the conversation over the wire, and that reverses something Y-181 chose deliberately.**
> Y-181's headline property was that spend is summed on the far machine and returned as **numbers
> rather than records**, *"so no conversation crosses the wire."*
>
> The owner accepted the reversal on 2026-08-11, and the distinction is worth stating so nobody later
> reads it as an accident. What Y-181 protected is that **a token count need not cost a
> conversation** — not that a conversation may never travel. The terminal already carries the same
> conversation, live, on every attach. The wire is the owner's own tailnet, WireGuard-encrypted,
> between two machines they own.
>
> **What does not change:** `tokens` still sums on the far side. Nothing here makes the cheap path
> expensive.

### 11.4 Spend, and `/usage`

Money is **not** on the fleet page. Y-181 made `tokens` a separate verb precisely because reading a
whole transcript is the wrong price for something polled every 5 s. A `$` on every running row would
have put that read back into the 5 s loop.

A running row shows elapsed time. The figure lives on the `spend` tab and on `/usage`.

**`/usage` reads one machine at a time, on request.** It opens holding a machine picker and whatever
you last asked for. No background loop, no fan-out you did not ask for, and every answer stamped with
its age.

`AS_OF` prints beside the figure, exactly as [`price.rs`](../../crates/yantra-core/src/price.rs)
already requires of the CLI. An unknown model shows unpriced rather than free; a fast-mode session
shows tokens and no money.

> **2026-08-11, [Y-199](../../tracker.md#3-task-board): the picker is a workspace, not a machine.**
> Spend is counted per workspace and there is no per-machine verb to publish. `yantra tokens
> <workspace>` loads a workspace and finds *its* transcript, and
> [`tokens.rs`](../../crates/yantra-core/src/tokens.rs) has no other entry point. A per-machine
> figure would need either the fan-out this section itself forbids — one read per workspace on that
> machine, on open — or new CLI surface that nothing has asked for.
>
> So the daemon publishes `POST /api/workspaces/{name}/tokens` and `/usage` opens holding a
> **workspace** picker. Everything else in this section stands unchanged: on request rather than on
> open, `AS_OF` beside the figure, unpriced shown as unpriced, and a fast-mode session showing tokens
> and no money.
>
> **What is still unknown:** whether a per-machine total is worth having at all. Nobody has asked for
> one, and the honest way to get it is a verb in the CLI first — this repo's own rule — rather than a
> loop in the browser.

> **2026-08-11, [Y-199](../../tracker.md#3-task-board): this section says the figure is stamped and
> does not say by whom, and the answer turned out to be the page.** `POST /api/workspaces/{name}/
> tokens` answers a bare `Spend` rather than the `Looked<T>` envelope every other read carries, so it
> is the only reading on the dashboard with no `age_seconds`. The page stamps its own arrival instead,
> and because nothing here polls, it keeps a one-second clock to move the figure — a clock that
> fetches nothing. A stamp that never moves is the lie the stamp exists to prevent.
>
> `AS_OF` is a **day**, not an instant. [`lib/time.ts`](../../web/src/lib/time.ts) refuses to read a
> stamp that names no zone (§5.7's amendment) and so prints it verbatim, which is correct — this
> document nowhere says a date is not a time, and now it does.
>
> **Building this found a bug in shipped code, and it is worth recording here because it is this
> document's own rule broken one layer in.** A session carrying only models the price table does not
> know published `cost: 0.0`: summing an empty list of prices gives zero, and zero beside a date reads
> as a session that cost nothing. `price.rs` already refused to price an unknown model *per model*;
> the total then added them up as free. Both the daemon and `yantra tokens` now report no figure at
> all, and the CLI's own test had been asserting `$0.00` under the name
> *an_unpriced_model_is_named_rather_than_counted_as_free*.

---

## 12. What this needs that does not exist

[`crates/yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md): *anything the web UI can do must be
expressible in `yantra` first.* Four things here are new daemon surface.

| Need | § | CLI first | Decision needed |
| --- | --- | --- | --- |
| read and repair a workspace file's bytes | 7.5 | **see below** | **an ADR**, whose decision §12.1 already states |
| write the ntfy relay's URL and token | 0, 3 | `yantra notify` reads them; nothing writes them | where they are written — see §12.2 |
| re-check readiness now | 4.8 | `yantra doctor <machine>` exists | none — a POST, on [ADR-0019](../adr/0019-a-probe-that-asks-a-machine-is-a-post.md)'s precedent |
| the transcript as records rather than printed text | 11.3 | `yantra logs --json` | none, beyond §11.3's blockquote |
| a viewer-presence beacon | 13 | none — the browser is its only caller | none |

### 12.1 The repair ADR, and what it decides

**The owner decided the scope on 2026-08-11, so the ADR records rather than explores it:**

> The daemon may write bytes to a workspace file it did not compose **only when the file currently on
> disk does not parse, and only when the bytes it is given do**. Every other raw write is refused.

That is the bound, and it is the rule rather than the first caller. **The refusals are the tests**,
which is this crate's own convention: a raw write against a file that loads is refused, and a raw
write of bytes that still will not load is refused with the next error named.

**The CLI-first rule.** The CLI is not missing this capability: on the machine holding the file,
repairing it is `$EDITOR ~/.config/yantra/workspaces/x.toml`. The rule exists so the CLI is never
second-class, and here it is not. **That is a reading, not a ruling** — the rule is the owner's. If it
should be a verb, `yantra put <workspace>` reading bytes from stdin is the smallest one that matches,
and it inherits both refusals unchanged.

### 12.2 Where the relay settings live

`YANTRA_NTFY_URL` and `YANTRA_NTFY_TOKEN` are read from the environment and from nowhere else
(Y-147, §B4). `/settings` has to write them somewhere the daemon reads on the next send.

**This is the one part of §0's Q6 amendment that is not yet designed**, and it is not a UI question:
it is where a daemon that persists nothing keeps a value that must survive a restart. An environment
file the unit reads, a config file beside `~/.config/yantra/workspaces/`, or a token the browser holds
and sends per-notification are three different answers with three different §B4 consequences.
**Named, not decided.**

---

## 13. Notifications and the open page

ntfy already pushes when a snapshot diff shows an agent needs attention (D1 §6). The fleet page now
has a group meaning the same thing.

**While the dashboard is open, Yantra stops pushing.** D1 §4.3 noted Claude Code's
`CLAUDE_CLIENT_PRESENCE_FILE` does exactly this.

**The page sends an explicit beacon.** It POSTs while the tab is visible and stops when the Page
Visibility API says it is hidden. The alternative — treating any `/api` read as presence — was
refused: a background tab polls every 5 s and is not a person watching.

**This adds daemon state, and the state is in memory.** Y-044 says the daemon persists nothing, which
means no disk and no SQLite; the 30 s snapshot already lives in RAM and a last-seen-a-viewer
timestamp sits beside it. A restart forgets it, which is correct — a restart also forgets the
snapshot, and the first look after a start already says nothing (D1 §6).

---

## 14. What this changes about the four open rows

Three of the four get **smaller**.

| Row | What it drew | What it draws now |
| --- | --- | --- |
| [Y-174](../../tracker.md#3-task-board) | an eighth card, listing three kinds of GitHub attention | a band inside **Needs you**, under its own `h3`. Its verbs open GitHub rather than a terminal, so it is a subgroup and not a merge |
| [Y-180](../../tracker.md#3-task-board) | a session table made actionable | nothing new on `/`. A claimed session **is** its workspace row; an unclaimed one is a row on `/machines`, counted in the fleet footer |
| [Y-183](../../tracker.md#3-task-board) | a page of spend | `/usage`, one machine at a time on request (§11.4), plus the `spend` tab on `/w/{name}` |
| [Y-185](../../tracker.md#3-task-board) | a better form on `/` | `/new`, a route. It selects with `ui/select` and `ui/combobox` and confirms the directory through `yantra probe` (Y-184) |

None is blocked by anything here. Each is smaller with §3 and §4 landed first.

---

## 15. Verifying

**Assertions gate the build. Screenshots are advisory.**

`vitest` asserts what D3 names as a number or a structure: page height at 390 px, heading levels, that
a pending read renders a skeleton, that reduced motion holds a frame, that a greyscale render still
separates the four marks, that every numeric cell is monospaced.

Playwright screenshots are generated per commit and attached for a human to glance at. **They never
fail CI.** Y-204 opened golden-file regression for the landing and was dropped because fonts and
rendering differ on the runner, so goldens churn. Advisory pictures cost the render time and buy the
one thing assertions cannot: *this looks wrong*.

---

## 16. Work units

Sized to be taken one at a time. **Proposed, not opened** (§B0).

| # | Work | Done when |
| --- | --- | --- |
| **D3.1** | The shell gets navigation and a heading outline | three nav items, `h1` per route, `h2` per group, a `<title>` that names the route |
| **D3.2** | `/` groups by who must act next (§4.1) | three groups from existing reads, no new endpoint, every verdict keeps its own word, and an unreachable machine is one row |
| **D3.3** | Machines, readiness and sessions move to `/machines` (§3.1) | `/` draws no machine table, nothing reachable becomes unreachable, and `/m/{name}` holds no comparison |
| **D3.4** | A pending read stops claiming nobody looked (§7.1) | a first paint draws a skeleton; `never`, `failed` and `ok` stay three different things |
| **D3.5** | One freshness line, and the footer counts (§4.3) | the oldest read sets the age, a read 30 s behind is named, and unclaimed sessions are counted |
| **D3.6** | The order is held; the pill offers it (§4.4) | nothing reorders without a tap, and a row in the wrong group still shows its true state |
| **D3.7** | Density and type tokens (§5.3, §5.4) | four sizes, two row heights, one container width per breakpoint |
| **D3.8** | Numeric cells take the monospace stack (§5.5) | every numeric column lines up, and no cell asks Geist for a figure it does not have |
| **D3.9** | One clock (§5.7) | ages under 24 h, dates over, exact time in `title`, and tmux's string parsed or shown verbatim |
| **D3.10** | Four marks and five colour roles (§6) | a greyscale screenshot separates all four, and no state uses the accent |
| **D3.11** | The reduced-motion floor and the motion budget (§9.2, §9.3) | under `reduce` both animations hold one frame; nothing else in app code animates |
| **D3.12** | Latin-only Geist (§9.1) | fonts under 30 kB, no glyph changed |
| **D3.13** | The terminal names connecting and reconnecting (§7.3) | both states visible on a socket that takes two seconds |
| **D3.14** | The two forms use the ported primitives (§7.4) | no hand-rolled input, label or submit button left in app code |
| **D3.15** | The page says once when nothing can be reached (§7.2) | one state, naming what it cannot tell apart, and no stale data drawn |
| **D3.16** | Confirm what cannot be undone (§4.7) | delete and kill ask; stop and resume do not |
| **D3.17** | `/` fits in under three phone screens (§10) | measured at 390 px with ten workspaces and three machines |
| **D3.18** | `⌘K` finds workspaces, machines and routes (§3.2) | it navigates, it runs no verb, and it uses the ported `command` |
| **D3.19** | Idle collapses past a threshold (§4.6) | a count, the recent few, one disclosure |
| **D3.20** | `/` becomes the setup checklist when no workspace exists (§4.8) | D2's checks draw as the page, and it reverts on the first workspace |
| **D3.21** | Readiness re-checks on request (§4.8) | a POST, and a machine fixed by hand confirms without waiting a sweep |
| **D3.22** | `/w/{name}` gets three tabs and a per-width default (§11.1) | `?view=` round-trips, desktop opens the terminal, a phone opens the transcript |
| **D3.23** | The transcript view (§11.3) | turns with tool calls collapsed, read live from the far machine, nothing cached |
| **D3.24** | `/usage`, one machine at a time (§11.4) | no fan-out on open, `AS_OF` beside the figure, unpriced shown as unpriced |
| **D3.25** | The trust prompt is answered in place (§4.5) | the pane renders inline at twelve rows and one keystroke reaches it |
| **D3.26** | `/w/{name}/repair` (§7.5) | both refusals hold — a file that loads is refused, and bytes that still will not load are refused with the next error. **After §12.1's ADR** |
| **D3.27** | The presence beacon suppresses ntfy (§13) | one event produces one notification while a tab is visible, and none of it survives a restart |
| **D3.28** | Assertions gate, screenshots advise (§15) | every number in this document is asserted somewhere, and no image comparison fails CI |
| **D3.29** | `/settings` writes the ntfy relay (§0, §12.2) | the relay URL and token are set from the browser and a test message arrives. **After §12.2 is decided** |

**D3.1 and D3.2 come first.** Every other unit is cheaper once the page has an outline and a subject.

**Two are blocked**: D3.26 on §12.1's ADR, and D3.29 on §12.2. Nothing else is.

> **These twenty-nine units are thirteen rows.** The owner opened **M13** on 2026-08-11 and grouped
> them, because `tracker.md` reserves Y-200 upward for the landing page and Y-187–Y-199 is what was
> left. Grouping was the better answer regardless: §B5 says that file is already too large to open
> without line offsets. **The rows are the work; this table is the detail each row links to.**

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

**Decisions** — 27 taken by the owner on 2026-08-11, in a structured interview. Each is recorded at
the section it governs, with its cost.

**Yantra internal** — [D1](01-dashboard.md); [D2](02-setup.md);
[R13](../research/13-dashboard-revamp-and-github.md);
[`docs/design-system.md`](../design-system.md) §§5–7;
[`docs/plans/m4-dashboard-next.md`](../plans/m4-dashboard-next.md) §"What the design system should be
asked for"; [`docs/brainstorm.md:394`](../brainstorm.md); ADRs
[0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md),
[0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md),
[0015](../adr/0015-resume-forks-the-conversation.md),
[0016](../adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md),
[0019](../adr/0019-a-probe-that-asks-a-machine-is-a-post.md); Q6; R-2, R-23; I-30, I-47, I-49.
