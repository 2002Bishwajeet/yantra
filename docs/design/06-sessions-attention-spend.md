# D6 — Sessions, attention and spend

**Status:** proposed. Written 2026-09-03 against the plan [D0](00-plan.md) §6 set, and settled in a
four-question interview whose answers are recorded inline. Opens no rows (§B0); §9 proposes them and
the owner mints them.

**Read [D3](03-dashboard-surface.md) §14 first.** It made three of these four rows *smaller* — an
attention band rather than an eighth card, an unclaimed session on `/machines` rather than a table on
`/`, and `/usage` rather than a page of spend. This document settles what is left of them.

**One finding shapes the whole document: almost all of this is built and unwired.** The daemon
serves the GitHub queue and no page asks for it. The kill verb exists at every layer including a
React control, and nothing renders it. §1 is the inventory, and it is why §9's rows are small.

---

## 0. What this settles, and what it does not

**It settles what the fleet owes a reader outside one workspace.** A session no workspace claims,
the GitHub queue, and where the money went.

**It does not settle pigment or type.** D3 §0's split holds, and every rule here is written against
tokens.

**It does not redesign `/usage`.** That page shipped with Y-199 and §5 keeps it.

**It does not settle `/w/{name}`.** That is [D5](05-workspace-page.md), and the `spend` tab is its
section, not this one's.

**It does not write Y-179's ADR.** §6 says what the ADR has to decide and records the owner's
direction for it. The ADR is its own document.

---

## 1. What is there today

Measured 2026-09-03 on `main`, after PR #222 and #223 landed.

**Three of these readings are complete in the daemon and absent from the browser.**

| Reading | Daemon | Browser |
| --- | --- | --- |
| the GitHub queue | `GET /api/attention`, polled on its own 300 s clock | **no file references `/api/attention`** |
| whether `gh` can answer at all | `GET /api/readiness/github` | **no file references it** |
| killing an unclaimed session | `DELETE /api/machines/{machine}/sessions/{session}` | `Kill` is exported from [`Act.tsx`](../../web/src/components/Act.tsx) and **nothing renders it** |
| listing unclaimed sessions | `GET /api/sessions` | **built** — `/machines` draws them through `unclaimed()` |
| a workspace's spend | `POST /api/workspaces/{name}/tokens` | **built** — `/usage` |

**So the shape of this milestone's remaining work is wiring, not architecture.** `sessionColumns`
draws MACHINE, SESSION, WINDOWS, ATTACHED, CREATED and COMMAND, and has no ACT column — that one
missing column is most of Y-180.

**What the fleet page's model already supports.** [`work.ts`](../../web/src/work.ts) has four bands —
`needs`, `running`, `idle`, `unknown` — and a `WorkRow` of three kinds: `workspace`, `machine`,
`unusable`. D3 §14 puts attention *inside* `Needs you` under its own `h3`, so it is a fourth kind or
a sibling block, and §3.1 chooses.

---

## 2. Three readings, three clocks

**Nothing here shares a clock, and the page may not imply it does.**

| Reading | Cadence | Where |
| --- | --- | --- |
| machines, workspaces, sessions, readiness | **30 s** | `refresh.rs`'s `EVERY` |
| the GitHub queue | **300 s** | `refresh.rs`'s `ATTENTION` — *"the only one not on `EVERY`"* |
| a workspace's spend | **never** — on request | Y-181's whole reason |

**This is why the attention band carries its own stamp.** A band inside `Needs you` sits beside rows
refreshed ten times more often. D3 §5.7 already requires every reading to say its own age; here the
requirement has teeth, because a five-minute-old queue drawn under a thirty-second-old fleet is the
exact reading a shared stamp would get wrong.

**GitHub's own ages are separate again.** An `Item` carries `updated_at` as RFC 3339 *as GitHub sent
it*, and `attention.rs` deliberately does not parse it: *"the age a reader wants is against now, not
against the poll."* So a row shows **how old the pull request is**, and the band shows **how old the
answer is**. Two ages, and they mean different things.

---

## 3. The attention band

### 3.1 It is a block inside `Needs you`, not a fourth band

D3 §14: *"a band inside **Needs you**, under its own `h3`. Its verbs open GitHub rather than a
terminal, so it is a subgroup and not a merge."*

**So it is a sibling block under the `Needs you` heading, not a `WorkRow` kind.** Making it a row
kind would put it in the same table as workspaces, and a table whose rows have different verbs and
different clocks is a table that has to explain itself in every cell.

**It draws below the workspace rows in that band.** A crashed agent on your own fleet is more urgent
than a review request, and the band is ordered by that.

**When both are empty, `Needs you` is empty**, and D3's existing empty state says so. The band does
not add a second sentence about GitHub having nothing.

### 3.2 A row is a repository, a number, a title and two links

`gh` is asked for five fields and no more —
`number,title,url,repository,updatedAt` — and `attention.rs` says why: *"naming only what is drawn
is how the rest never reaches a log line."* The row draws exactly those.

- **`owner/name#123`** in mono, which is the only spelling unique across GitHub.
- **The title**, truncated to one line.
- **The age**, from `updated_at` against now.
- **The link is the row.** `Item.url` is GitHub's own web URL, kept *"so the page links out rather
  than rebuilding it from the parts and getting `/issues` versus `/pull` wrong."* Nothing here
  constructs a URL.

**Reviews and issues are two lists, so they are two subheadings.** The `Item` carries no kind field —
which list you are in *is* the kind, and inventing a badge would be re-encoding it.

**The verbs open GitHub in a new tab and Yantra does nothing else.** There is no approve, no
comment, no assign. That is R13 §6's boundary and this document does not move it.

### 3.3 Notifications are a count, and stay one

`Attention.notifications` is a `u32`. The comment says why: *"A count rather than a list: the titles
are the part that would land in a journal, and nothing draws them."*

So the band shows **one line**: *27 unread notifications*, linking to `github.com/notifications`.
**Not a list, and this is a privacy property rather than a layout choice** — turning it into a list
means the titles cross the wire and reach a log, which is what the count exists to avoid.

### 3.4 When `gh` cannot answer, the band names which

> **Owner, 2026-09-03:** name the reason and the fix.

D3 §7.1 forbids drawing an unanswerable question as *nothing to do*. The daemon already tells apart
four reasons, and **each error string is already written as an instruction**:

| Reason | What the band says |
| --- | --- |
| `NotInstalled` | *could not spawn `gh` — is the GitHub CLI installed and on PATH?* |
| `LoggedOut` | *`gh` is installed but not logged in — run `gh auth login`* |
| `Unreachable` | *`gh` could not reach GitHub* |
| `Command` / `Parse` | the daemon's own text, naming the `gh` argv that failed |

**The band draws as unanswered, not as empty** — D3 §7.1's fourth state, with the skeleton while
pending and the sentence when resolved. **This costs nothing new**: the strings exist, and the
browser has only never asked for them.

**Where this bites hardest is the appliance**, and it is Q20 rather than this document's: `gh` holds
the token on the machine a person logged into, and a Pi has no such person. On that box the band's
permanent answer is `NotInstalled` or `LoggedOut` — which is the correct answer, said in the words
above, rather than a queue that looks empty.

### 3.5 `/api/readiness/github` is the same question asked earlier

The readiness route answers whether `gh` can answer *before* anything asks it for a queue. The band
does not need it — an `Attention` reading that failed carries its own reason — so **this document
proposes nothing that consumes it**, and records that it exists so the next reader does not build a
second path to the same fact.

---

## 4. The unclaimed session

### 4.1 It already has a home

`/machines` draws *Unclaimed sessions* through `unclaimed(answers, workspaces)`, with the two empty
states D3 asks for: *every tmux session on the machines that answered belongs to a workspace*, and
*no workspace list to check these against, so none can be called unclaimed*. The second is R-23 in
one sentence and it stays exactly as it is.

**Nothing about where these live changes.** They are not on `/`, and D3 §14 settled that: a claimed
session **is** its workspace row.

> **2026-09-03, [Y-317](../../tracker.md#3-task-board): `sessionColumns` has two call sites, and this
> section reasoned about one.** `Machines.tsx` passes `unclaimed(answers, workspaces)`, so the ACT
> column §4.2 adds reaches only unclaimed rows there. `OneMachine.tsx` passes every session the
> machine reported, claimed ones included, so `/m/{machine}` draws `Kill` on a session a workspace
> owns. The owner accepted this on the day it was found. The cost is one verb: `kill` stops a session
> and `down` reads how the agent ended, so a person who kills a workspace's session from
> `/m/{machine}` loses that reading. The confirm dialog names what it destroys, and the alternative
> — gating the cell on a workspace lookup — adds a third state for a list that has not loaded, which
> D3 §7.1 refuses to draw as an empty cell.

### 4.2 Kill, wired at last

> **Owner, 2026-09-03:** attach and kill, and no adoption.

`sessionColumns` gains an **ACT** column holding the `Kill` that `Act.tsx` already exports.

Everything the control needs is built. It confirms first — D3 §4.7: *only what cannot be undone asks
first*, and killing an unclaimed session is named there. And it already draws the answer Yantra's
idempotency rule produces: `killed: false` is *"a session that was already gone, which is the state
asked for (I-30)"*, and the control says *no session named X was running on Y, so there was nothing
to kill* rather than reporting a failure.

### 4.3 Attach, after the ADR

The same column holds a **Terminal** link once §6's ADR lands. Until then the column holds one verb.

### 4.4 Adoption is refused, and the reason is a guess nobody should make

> **Owner, 2026-09-03:** no adoption.

A workspace file needs a machine, a repo and a name. **A tmux session gives you two of the three.**
The machine is where it runs and the name is what it was called; the repo is not in
`tmux::Summary` — which carries `name`, `windows`, `attached` and `created` — and nothing else on the
wire has it either.

**So adopting would mean guessing the repo**, most likely by reading a pane's working directory over
ssh. That produces a workspace file whose `up` cd's somewhere the person never chose, and it fails at
the moment they most want it to work — [D4](04-workspace-creation.md) §1's exact failure, rebuilt on
purpose after D4 spent a document removing it.

**The honest path stays `/new`**, which walks a real directory at a probe's price and derives the
name from it. Adopting is refused, not deferred.

---

## 5. Spend

### 5.1 No fleet total

> **Owner, 2026-09-03:** keep it per workspace, and record the refusal.

**A total costs one ssh transcript read per workspace, on open.** That is the fan-out D3 §11.4 exists
to forbid, and §11.4 already named the honest route: a verb in the CLI first, *"rather than a loop in
the browser."* Nobody has asked for one.

**The number this document could not measure.** No workspace is configured on `cachyos-g14` today, so
the fan-out was not measured, only reasoned: N workspaces at [D5](05-workspace-page.md) §2.2's 0.33 s
ssh round trip, serial or parallel. **Say so rather than quoting an estimate as a measurement**, and
re-measure before anyone reopens this.

**What is refused is the total, not the question.** If a fleet figure is ever wanted, the order is
`yantra tokens` gaining it, tests proving it, and the page publishing it — this repo's own rule, and
the same order Y-181 followed to get the per-workspace figure.

### 5.2 What `/usage` keeps

Unchanged: a workspace picker, read on request, nothing polling, the `asking` skeleton naming the
machine, 409 drawn as *nothing to add up* rather than as a failure, `AS_OF` printed verbatim as the
day it is, an unpriced model showing tokens and no money, and the page's own arrival stamp on a clock
that fetches nothing.

**D5 §6.1 moves `Answer` and `Figure` into a shared module** so `/w/{name}`'s `spend` tab draws the
same figure. `/usage` keeps the picker and loses nothing. That is D5's row, not one of §9's.

---

## 6. The terminal on any session

### 6.1 What the ADR has to decide, and the owner's direction

> **Owner, 2026-09-03:** any session on your own fleet is reachable. Yantra does not decide a session
> is off-limits.

The reasoning to write into the ADR:

- **The boundary is already the tailnet plus Tailscale identity**
  ([ADR-0016](../adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md),
  [ADR-0017](../adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md)). A socket that
  reaches an unclaimed session crosses no boundary a workspace's socket does not.
- **A workspace's pane is a shell too.** Treating a workspace session as safe and an unclaimed one as
  dangerous would be a distinction with nothing behind it — both are `tmux attach` on a machine the
  caller owns.
- **The alternative was considered and refused**: allowing only sessions Yantra could have started
  means guessing from a name or writing a marker, and it refuses exactly the sessions a person most
  wants to reach.

**What the ADR must still state plainly is the consequence**: the socket's address becomes
machine-plus-session, so a mistyped address lands in a *different* live shell rather than answering
404. §6.3 is what pays for that.

### 6.2 The socket needs one function, not a second terminal

**The workspace is used for exactly two facts.** [`attach.rs`](../../crates/yantra-core/src/attach.rs)'s
`plan(name, term)` loads a workspace and then reads `workspace.machine` for the ssh destination and
`workspace.name` for the tmux session. **`remote_command(tmux, session, term)` below it is already
session-addressed**, and so is `Tmux::pane`.

So Y-179 is **a second `plan` that takes machine and session directly**, not a new terminal, not a new
bridge, and not a change to `Plan`'s consumers beyond what carries those two facts. The daemon gains
one route — `GET /api/machines/{machine}/sessions/{session}/terminal` — on the same `allowed()` the
workspace socket sits on.

**One thing genuinely differs.** `plan` calls `ensure_session`, which fails with
`NoSession { workspace, machine }` when there is no pane. For a session-addressed attach the error
cannot name a workspace, so it names the session — and *that* session vanishing between the list and
the tap is the ordinary case rather than an error.

### 6.3 What the page says before it attaches

**An unclaimed session is somebody else's shell until proven otherwise**, so the link says which one
it is opening: the machine, the session name, and its age. No confirm dialog — D3 §4.7 keeps those
for what cannot be undone, and attaching to a terminal undoes itself by closing.

**The pane is not cleared, not resized beyond the browser's own window, and nothing is typed into
it.** Attaching is a read until the person types.

---

## 7. Words

| Say | Not |
| --- | --- |
| unclaimed | orphan, stray, untracked |
| Kill | terminate, destroy, remove |
| Needs you | inbox, todo, action items |
| review requested · assigned to you | PRs · issues |
| unread notifications | notifications badge |
| could not be read | unavailable, error |
| run `gh auth login` | authenticate with GitHub |

**One term, one meaning** (§A6). A *session* is a tmux session. *Unclaimed* means no workspace names
it — never *orphaned*, which implies Yantra lost something it owned.

---

## 8. What this needs that does not exist

| Layer | What | Why it is new |
| --- | --- | --- |
| `web` | the attention band inside `Needs you` | §3. The daemon has served it since Y-173 and nothing asks. |
| `web` | an ACT column on `sessionColumns` | §4.2. The control exists; the column does not. |
| `yantra-core` | a session-addressed `plan` | §6.2. `plan` needs a workspace for two facts it could be handed. |
| `yantrad` | `GET /api/machines/{machine}/sessions/{session}/terminal` | §6.2. On the same `allowed()`. |
| `docs/adr/` | the ADR §6.1 describes | Y-179's gate. |

**Nothing here needs a new reading, a new poll or a new clock.** That is the difference between this
document and [D5](05-workspace-page.md), which had to add a route because nothing served the
transcript.

**The weight.** The band is text and links on a route that is already eager; the ACT column adds a
control `/machines` does not yet import. Against D3 §9.1 — **≤ 145 KiB, and `main` is at 141.5 KiB
after that section's 2026-09-03 amendment** — this is small, and §9's last row is where it gets
checked rather than assumed.

---

## 9. Work units

Sized to be taken one at a time. **Proposed, not opened** (§B0).

| # | Work | Done when |
| --- | --- | --- |
| **D6.1** | The attention band draws (§3.1–§3.3) | it sits under `Needs you`'s `h3` below the workspace rows, reviews and issues are two subheadings, a row is `owner/name#123` with its title and its own age linking to `Item.url`, and notifications are one counted line |
| **D6.2** | The band carries its own age (§2, §3.5) | its stamp is the reading's, not the fleet's, and a 300 s clock beside a 30 s one is visible as such |
| **D6.3** | `gh` that cannot answer says which (§3.4) | the four reasons draw as four sentences carrying the daemon's own text, a pending read draws a skeleton, and none of them renders as nothing to do |
| **D6.4** | An unclaimed session can be killed (§4.2) | `sessionColumns` gains ACT holding `Kill`, it confirms first, and an already-gone session reads as nothing to kill rather than as a failure |
| **D6.5** | The ADR for a session-addressed socket (§6.1) | written and accepted, stating the boundary, the refused alternative, and the mistyped-address consequence |
| **D6.6** | A session-addressed `plan` (§6.2) | it takes machine and session, `remote_command` is unchanged, and a missing pane names the session rather than a workspace |
| **D6.7** | `GET /api/machines/{machine}/sessions/{session}/terminal` (§6.2) | it bridges on the same `allowed()`, and the Terminal verb joins §4.2's column naming what it will open |
| **D6.8** | The first load is still under budget (§8) | measured after D6.1 and D6.4, against D3 §9.1's 145 KiB, and recorded |

**D6.1 through D6.4 are unblocked and independent of each other.** D6.5 gates D6.6 and D6.7.

> **2026-09-03: the owner minted all eight**, as **Y-314**…**Y-321** in the order above.
> [Y-174](../../tracker.md#3-task-board) is D6.1–D6.3's parent, [Y-180](../../tracker.md#3-task-board)
> is D6.4's, and [Y-179](../../tracker.md#3-task-board) is D6.5–D6.7's. [Y-183](../../tracker.md#3-task-board)
> mints nothing, because §5 settled it as a refusal.

**One thing worth doing that is not a row.** Re-measure §5.1's fan-out once a workspace exists on
this machine again. The refusal does not depend on the number, but the number is what anyone
reopening the question will ask for.

---

## Sources

Measured **2026-09-03** on `main`, after PR #222 and #223 landed. Code read rather than run: this
document adds no reading, so there was nothing new to time.

- `GET /api/attention` is served by [`api.rs`](../../crates/yantrad/src/api.rs) and **no file under
  `web/src` references it**. The same is true of `GET /api/readiness/github`.
- `Kill` is exported from [`Act.tsx`](../../web/src/components/Act.tsx) and **no component renders
  it**. `sessionColumns` in [`columns.tsx`](../../web/src/columns.tsx) has six columns and no ACT.
- [`refresh.rs`](../../crates/yantrad/src/refresh.rs): `EVERY` is 30 s, `ATTENTION` is 300 s, and its
  comment names attention as the only reading off the common clock.
- [`attention.rs`](../../crates/yantra-core/src/attention.rs): `gh` is asked for
  `number,title,url,repository,updatedAt`; `Item` holds those five; `notifications` is a `u32` with
  the reason written beside it; `Error` has `NotInstalled`, `LoggedOut`, `Unreachable`, `Command` and
  `Parse`.
- [`attach.rs`](../../crates/yantra-core/src/attach.rs): `plan` reads `workspace.machine` and
  `workspace.name` and nothing else off the workspace; `remote_command(tmux, session, term)` and
  `Tmux::pane` are already session-addressed.
- [`tmux.rs`](../../crates/yantra-core/src/tmux.rs): `Summary` is `name`, `windows`, `attached`,
  `created` — **no repo**, which is what §4.4 turns on.
- **Not measured:** the fan-out cost of a fleet spend total. `~/.config/yantra/workspaces/` holds no
  workspace on this machine today, so there was nothing to fan out to. §5.1 says so rather than
  estimating.

**Decisions** — four taken by the owner on 2026-09-03, in a structured interview: attach and kill
with no adoption, naming the reason `gh` cannot answer, refusing a fleet total, and making any session
on the owner's own fleet reachable. Each is recorded at the section it governs, with its cost.

**Yantra internal** — [D0](00-plan.md) §6; [D3](03-dashboard-surface.md) §4.7, §5.7, §7.1, §9.1, §14;
[D4](04-workspace-creation.md) §1; [D5](05-workspace-page.md) §2.2, §6.1;
[R13](../research/13-dashboard-revamp-and-github.md) §2.2, §6; ADRs
[0005](../adr/0005-core-logic-in-a-library-crate.md),
[0016](../adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md),
[0017](../adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md);
[`work.ts`](../../web/src/work.ts), [`Machines.tsx`](../../web/src/routes/Machines.tsx),
[`sessions.rs`](../../crates/yantra-core/src/sessions.rs); I-30; Q20; Y-172, Y-173, Y-174, Y-179,
Y-180, Y-181, Y-183.
