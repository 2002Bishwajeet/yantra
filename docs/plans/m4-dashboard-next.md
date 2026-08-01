# M4 — the dashboard, after Y-072: what is needed and what can be built now

- **Date:** 2026-08-02
- **Status:** proposal, awaiting review
- **Follows:** [m4-web-ui.md](m4-web-ui.md), which planned M4's daemon half and the first dashboard

[Y-072](../../tracker.md) shipped three sections — machines, workspaces, sessions — over the
read-only API, polling every 5 s, with [ADR-0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md)'s
token seam in place and nothing painted. This plan covers what comes next.

**The organising constraint is that a design system is arriving from elsewhere** and needs more
direction before it lands. So the work below is split by whether it can proceed without knowing what
the page will look like. Most of it can: the open questions are about colour, density and motif, and
almost nothing here is about those.

---

## 1. What the dashboard is missing, ranked

### 1.1 The state a human has to act on is invisible — Y-084

An agent holding at Claude Code's trust prompt is **the only state in the whole system where the
machine has stopped and is waiting for a person** (I-49). Everything else on the page is information.
The dashboard cannot show it at all, because agent status is not in the read model.

This is the highest-value addition and it is also the one with a real cost to think about first.
[Y-071](../../tracker.md) recorded why: `status::status` opens ssh, so it needs a **fourth refresh
class**, and it is the first refresh that is per-*workspace* rather than per-fleet. Three classes
being free at 30 s does not imply N are.

**A shape worth considering before building one-task-per-workspace.** The sessions class already
reaches every machine a workspace names, once per machine. Agent status needs a pane query and
`claude agents --json` — both of which are *also* per machine, not per workspace. Folding the agent
reading into the machine-shaped refresh would cost one round trip per machine rather than one per
workspace, and workspaces on the same machine would share it. That is a design question for the task,
not a decision this plan should make, but building it per-workspace without asking would be the
expensive answer chosen by default.

**Y-091 changes what this section can say.** `status` now distinguishes a session opened as a shell
from R-2's genuine contradiction, so the fourth section can render *no agent — opened as a shell* as
an ordinary state rather than as an alarming one. Before Y-091 it would have shown `unclear` for the
most common case on the page.

### 1.2 The page shows state and offers nothing to do about it

Every row is a fact you then act on somewhere else. The API answers **405 to every write**, and
[Y-071](../../tracker.md) recorded why that is not an oversight: a write route is where
[Q6](../../tracker.md)'s absent authentication stops being free.

**Recommended: the page hands you the command.** Each row carries a copy-pasteable
`yantra resume api`, exactly as `up` already prints an attach hint you copy. Zero new auth surface,
zero new failure modes, and it teaches the CLI rather than replacing it. The attach hint is the
strongest precedent — it is the shape this project already chose for the same problem.

Rejected for now: real write routes. Correct eventually, and they drag in authentication, CSRF and
what-happens-when-two-tabs-both-hit-stop. M6's terminal forces that conversation anyway; having it
twice is worse than having it once.

### 1.3 Staleness is rendered as a timestamp, not as a reading

`age_seconds` above roughly 40 does not mean *slightly old*. It means **the refresh task is wedged in
ssh** — one unreachable machine costs a full `ConnectTimeout`. Those are two different messages
sharing one number today. `Age.tsx` already owns the threshold, so this is one file and no new API.

### 1.4 Three tables is the API's shape, not the operator's

The read model has three classes because they refresh on three clocks — a *daemon* fact. The mental
model is **workspaces**; a machine and a session are things a workspace has.

A workspace-centric layout inverts it: one card per workspace showing machine reachability and
session state inline, with machines demoted to a fleet-health footer. **The cost is real and is the
hard part**: the three classes can legitimately be in three different states at once, so a merged
card has to admit *which part* it does not know, rather than rendering a confident row from a mix of
fresh and failed readings. `Section` currently enforces that honesty per class and would have to
enforce it per field.

This is the one item that genuinely benefits from waiting, because it is the item the design system
has an opinion about.

---

## 2. What can be built before the design lands

In dependency order. None of these needs to know what the page looks like.

| | Work | Why it is design-independent |
| --- | --- | --- |
| 1 | **Y-084** — agent status in the read model | Daemon-side. Adds a class and an endpoint; renders as one more `Section` in the shape that already exists |
| 2 | **Copy-paste commands on rows** (§1.2) | A `<code>` and a copy button. Whatever the design system says about buttons, the *decision* not to add write routes is unaffected |
| 3 | **Staleness treatment** (§1.3) | The threshold and the wording are the work; the appearance is one `tone`, which is already the seam |
| 4 | **Y-073** — asset serving | No UI surface at all |

**Y-073's constraint is worth restating because it is easy to violate accidentally.** Embedding the
built assets goes behind a cargo feature that is **off by default**, and the UI is handed over as a
CI artifact rather than by a `build.rs` that shells out to npm. The moment a Rust build needs a
JavaScript toolchain, every `fmt`, `clippy`, `test` and the musl cross-build grow a dependency on
Node (R-24). Y-072 kept this clean — `cargo build` still needs no Node — and the check is that it
stays that way.

---

## 3. What waits, and what it is waiting for

| Waiting on | Blocked work |
| --- | --- |
| The token vocabulary the design system delivers | Anything filling in `index.css` beyond shadcn's defaults |
| A decision on density and motif | §1.4's workspace-centric layout |
| The `--accent` collision (below) | Nothing yet, but it will look like a styling bug when it bites |

**One collision is already known and recorded rather than designed around.** shadcn's
`cssVariables` mode defines `--accent` as a *muted hover surface*; the incoming design system defines
it as a pigment. Both are `:root`, so **the cascade decides and neither import order errors** —
import one way and every hover surface in the dashboard takes the accent colour, the other way and
the design system's accent quietly goes neutral. This is the first thing to check when the two meet,
and it is the kind of defect that reads as a styling mistake rather than a naming one.

**What the design system should be asked for, in dashboard terms.** The landing page and the
dashboard do not want the same things, and its own notes say so — a dashboard framed in ornament is a
dashboard you cannot read. What this page needs from it:

- **Semantic colour kept separate from the accent.** `Status.tsx` maps a domain state to a `tone`, and
  those tones — running, stopped, crashed, unreachable, stale — must not be the same axis as brand
  accent, or a crashed agent and a hyperlink end up the same colour.
- **A staleness treatment**, per §1.3 and [ADR-0013](../adr/0013-the-heartbeat-carries-only-what-placement-scores.md)'s
  reading ages. This is a real visual state, not a shade of grey.
- **Density tokens.** Four tables on one page is the whole product surface.

---

## 4. What this plan still does not do

Unchanged from [m4-web-ui.md §6](m4-web-ui.md#6-what-m4-deliberately-does-not-do), and worth
restating because each has become slightly more tempting since:

- **No writes**, per §1.2.
- **No terminal.** M6, and it is why `axum`'s WebSocket support is in §B1's stack list and not here.
- **No telemetry.** The page shows what Tailscale and tmux already know. Whether a machine is *busy*
  needs `yantra-agent`, which is **still a 19-line stub that prints its version** — the largest
  functional gap in the project, and M5's input rather than M4's.
- **No session store.** Y-044 recedes again: [Y-091](../../tracker.md) found that
  `pane_start_command` already holds the agent's session id and keeps it current across a respawn.

---

## 5. Suggested task rows

| ID | Task | Depends |
| --- | --- | --- |
| Y-084 | Agent status in the read model — decide per-machine vs per-workspace first | Y-071 |
| Y-096 | The dashboard's fourth section: agent status, including the trust prompt | Y-084 |
| Y-097 | Rows carry the command that acts on them | — |
| Y-098 | Staleness is a reading, not a timestamp | — |
| Y-073 | Asset serving: directory in dev, embedded at release, feature off by default | Y-072 |

Y-096, Y-097 and Y-098 are new; the first two rows of the table already exist.

## 6. Risks

- **The fourth refresh class is the first per-workspace one.** Built naively it is N ssh connections
  every 30 s against a fleet where an unreachable machine costs ten seconds each. §1.1 has the
  cheaper shape; the risk is building before asking.
- **A copy-paste command is a command someone runs.** It must be built from the same workspace name
  the API returned and never from anything a browser can influence.
- **Waiting for the design system is only free while the work above is design-independent.** If it
  arrives late and §1.4 has been built anyway against shadcn's defaults, the integration diff stops
  being `index.css` and ADR-0014 was wrong — which the ADR says should be recorded by superseding it,
  not worked around.
