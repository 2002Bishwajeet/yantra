# D0 — The plan for the dashboard's design

**Status:** proposed. Written 2026-08-25 from the owner's instruction of the same day — *"lets make a
plan for dashboard designing, we go step by step, make proper design plan spec docs and move forward
with it"* — and from two answers given in the same exchange, recorded in §3 and §7. Opens no rows
(§B0).

This document orders the others. It settles **what gets written next, in what order, and how each one
is written.** It settles nothing about the dashboard itself; the documents below do that.

It exists because four design documents have accumulated with no index, and because the two halves
still missing are different jobs that were about to be confused with each other.

---

## 1. What the four existing documents settle

| Doc | Settles | Left open, deliberately |
| --- | --- | --- |
| [D1](01-dashboard.md) | The plumbing: routes, endpoints, work units, which decision blocks which. | *"pigment or type"* — its own words, D1 §0. |
| [D2](02-setup.md) | Provisioning: what Yantra does, what it names and refuses to do, and `yantra doctor` as the one probe the dashboard, the installer and an agent all read. | — |
| [D3](03-dashboard-surface.md) | The **structure** of the surface: navigation, grouping by who must act next, density, four type sizes, four state marks, words, failure states, the weight and motion budget. Settled in a 27-question interview. | *"pigment, type or motif"* — D3 §0, restated as a rule and not an oversight. |
| [D4](04-workspace-creation.md) | How a directory becomes a choice on `/new`: what Yantra asks a machine, how often, and what it does with an answer it could not get. | Pigment and type again, under D3 §0's split. |

**D4 is the precedent that sets the depth of everything below.** D3 gave `/new` two sentences
(§14). D4 spent 442 lines on it and found the measurement that changed its shape — a whole-home
`find` costs 8.5 s on this fleet's Mac against 0.026 s on its Linux box, so the directory is walked
one level at a time rather than swept. A surface named in a table is not a surface designed.

---

## 2. What is left

### 2.1 Surfaces D3 named and did not detail

Five of them, each in the position `/new` was in before D4.

| Surface | Named in | Row | Goes in |
| --- | --- | --- | --- |
| `/w/{name}`: three tabs, `?view=`, a per-width default | D3 §11.1 | Y-198 | **D5** |
| The transcript, read live from the far machine | D3 §11.3 | Y-198 | **D5** |
| The trust prompt answered in place, at twelve rows | D3 §4.5 | Y-198 | **D5** |
| A session drawn as something to act on | D3 §14 | Y-180 | **D6** |
| The attention band inside *Needs you* | D3 §14 | Y-174 | **D6** |
| `/usage` and the `spend` tab | D3 §11.4 | Y-183 | **D6** |
| The terminal on any session, not only a workspace's | — | Y-179 | **D6**, after an ADR nobody has written |

`/w/{name}/repair` is **not** in this list. D3 §7.5 and §12.1 designed it, ADR-0020 decided its
bound, and Y-190 built it — it lands with PR #222.

### 2.2 The half D3 refused

D3 §0: *"It does not settle pigment, type or motif."* The dashboard runs today on stock shadcn
tokens and the Geist face, which is a correct structure wearing a default. That is **D7**, and §7
says why it is written differently from the rest.

---

## 3. The order, and what it costs

**Structure first, then pigment.** The owner chose this on 2026-08-25 over doing the visual pass
first.

**It is safe because of one guarantee.**
[ADR-0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md) promises that *"the expected diff
when the design system lands is `index.css`, and nothing else."* D3 and D4 were both written against
tokens to keep that promise, and D5 and D6 will be. So a screen built before D7 is not a screen built
wrong.

**The cost, named.** Every surface built between now and D7 ships in the default palette, and the
owner looks at it in that state for the whole of that time. The alternative — pigment first — was
refused because a visual document written against three screens that do not exist yet is a document
that gets retrofitted twice.

**One thing that guarantee does not cover.** ADR-0014 promises the *styling* diff. If D7 wants a
motif, an empty-state illustration or a sigil, those are components and files, not token values.
D7 must say so out loud where it asks for one, and count it against D3 §9.1's weight budget.

---

## 4. How each document is written

The convention D3 and D4 set, written down once so D5, D6 and D7 do not each reinvent it:

1. **Measure what is there today**, with evidence and a date. D3 §2 and D4 §1 are that section.
2. **Interview the owner.** Record every answer inline, beside the decision it settles.
3. **Write against tokens, never against colours.**
4. **Name the cost of a decision next to the decision.**
5. **Propose work units in the last section, and open no rows.** The owner mints them (§B0).

D7 adds a step in front of step 2, and §7 says what it is.

---

## 5. D5 — the workspace page

**What it settles.** What a person sees when they open one workspace, on a phone and on a desktop,
in each of the states it can be in.

**Why it is one document and not three rows.** D3 §11 is about a hundred lines covering three tabs,
a transcript, a spend figure and a terminal. Y-198 is a single row pointing at all of it. The gap
between those two facts is the same gap D4 filled.

**What the interview has to settle.** Named here so the owner can see the shape before it is asked:

- What the transcript actually renders. A turn, a tool call collapsed, a diff, an error — these are
  four different render jobs and D3 §11.3 names them as one.
- What it costs to fetch. `yantra logs --json` reads a file on the far machine over ssh; a long
  conversation is not a small read, and nothing is cached (D3 §11.3).
- Whether the tabs are three or four now that `repair` exists as a route.
- What the page shows for a workspace whose machine cannot be reached at all.
- Whether the trust prompt's twelve rows are a terminal or a picture of one.
- What `spend` shows when the price table has no entry for the model (D3 §11.4 says *unpriced*, and
  does not say what that looks like at a glance).

**Gate:** none. It can be written today.

---

## 6. D6 — sessions, attention and spend

**What it settles.** What the fleet owes a reader when they are not inside one workspace: a session
that no workspace claims, the GitHub queue, and where the money went.

**Why these three are one document.** They are three bands of the same reading — *what is running
that I did not start, what is waiting on me elsewhere, what did it cost*. D3 §14 already made all
three smaller than they were, and each is small enough that three documents would be ceremony.

**What the interview has to settle.**

- Whether an unclaimed session can be adopted into a workspace, or only attached to and killed.
- What the attention band does when `gh` is absent or unauthorised — D3 §7.1's rule says it may not
  render as *nothing to do*.
- Whether `/usage` is per machine on request (D3 §11.4) or gains a fleet total, and what a total
  costs in fan-out.
- What Y-179's missing ADR has to decide before the terminal may open on an arbitrary session.

**Gate:** Y-179's part waits on that ADR. The rest does not.

**This document could be folded into D5.** The cost of folding is one larger interview and one
larger file; the cost of splitting is a cross-reference. Splitting is proposed. Say so if you want
one document.

---

## 7. D7 — the visual system, and the round that comes before it

**The owner chose on 2026-08-25: show rendered options first, then write the document from what
survives.**

**Why the order is inverted here and nowhere else.** Two landing-page designs were built from a
brief and rejected, the second after a full branch. Both rejections came from the same place — the
direction was invented and then shown only at the end. The correction is to make something
renderable early enough to be cheap to throw away.

### 7.1 What an option is

**A candidate `index.css`, applied to the real page — not a mockup.** ADR-0014 claims the design
system lands as that one file. Producing options as that file tests the claim while it is still
free to be wrong, and it means the option the owner picks is already most of the implementation.

Each option is rendered at **390 px and at desktop width**, on the fleet page with **ten workspaces
and three machines** — D3 §10 and D3.17's measurement case, so density is judged where it is
hardest rather than on an empty page.

### 7.2 What an option may not change

D3's structure is settled. An option may repaint it and may not argue with it:

- four type sizes, not five (D3 §5.4)
- two row heights (D3 §5.3)
- four state marks that survive a greyscale render (D3 §6.1)
- three semantic roles, and no state that uses the accent (D3 §6.2)
- one duration and one easing, and the reduced-motion floor (D3 §9.2, §9.3)
- the first-load weight ceiling (D3 §9.1)

An option that needs a fifth type size is not an option. It is an argument with D3, and it goes in a
superseding document.

### 7.3 What the round produces

Three or four options, on one page, openable on the phone — because the phone is D3 §10's constraint
and a palette judged on a laptop is judged in the wrong place. The owner picks, rejects, or mixes.
**D7 is written afterwards**, from what survived, and it is the document that finally answers what
[docs/design-system.md](../design-system.md) §7 asked: whether the dashboard inherits the Pattachitra
pigments, derives its own semantic colour, and what it does with the motif vocabulary.

**Gate:** the options round needs nothing. D7 needs the owner's pick.

---

## 8. What is in flight

| PR | Branch | Carries | Bearing on this plan |
| --- | --- | --- | --- |
| [#222](https://github.com/2002Bishwajeet/yantra/pull/222) | `m13-dashboard-surface` | D3's structure, ADR-0020 and the repair page | D5's and D6's **rows** land after it. The documents do not wait. |
| [#223](https://github.com/2002Bishwajeet/yantra/pull/223) | `d4-workspace-creation` | D4 and Y-300…Y-304 | This document sits on top of it, because D4's link does not resolve on `main`. |

`d4-workspace-creation` was **21 commits behind** `m13-dashboard-surface` when this was written, so a
tracker read on that branch reports Y-189, Y-190, Y-194 and Y-199 as unfinished when M13's tip has
them done. Rebase before believing a row status.

---

## 9. Proposed rows

**None.** This document proposes documents, not work. D5, D6 and D7 each propose their own units in
their last section, and the owner mints those (§B0).

---

## Sources

- Owner's instruction and the two answers behind §3 and §7, 2026-08-25, in session.
- Row statuses read from `tracker.md` at `m13-dashboard-surface` tip `cfc47f8`, 2026-08-25.
- Branch divergence measured with `git log HEAD..m13-dashboard-surface`, 2026-08-25.
