# D5 — The workspace page

**Status:** proposed. Written 2026-09-03 against the plan [D0](00-plan.md) §5 set, and settled in a
seven-question interview whose answers are recorded inline. Opens no rows (§B0); §10 proposes them
and the owner mints them.

**Read [D3](03-dashboard-surface.md) §11 first.** It gives `/w/{name}` three tabs, a transcript and a
spend figure in about a hundred lines. [Y-198](../../tracker.md#3-task-board) is one row pointing at
all of it. This document settles what that row builds, and **the measurement in §2 changes one thing
D3 promised.**

---

## 0. What this settles, and what it does not

**It settles what a person sees when they open one workspace.** Which tabs there are, what the URL
carries, what the transcript renders, what a read costs, and what each tab says when the machine
behind it cannot be reached.

**It does not settle pigment or type.** D3 §0's split holds, and every rule here is written against
tokens.

**It does not touch the terminal.** The socket, the reconnect budget and the terminfo choice are
Y-129's and Y-132's, and they stay exactly as they are. This document gives the terminal a tab and
takes nothing from it.

**It does not settle `/usage`.** That page shipped with Y-199. §6 reuses what it draws and does not
redesign it.

**It adds nothing to the viewing beacon.** D3 §13's *the page says it is being looked at, and the
daemon stops pushing what the page is already showing* is `useViewing`, called once in
[`Shell.tsx`](../../web/src/routes/Shell.tsx) for every route. This page inherits it and needs no
beacon of its own.

---

## 1. What is there today

Measured 2026-09-03 on `m13-dashboard-surface`, which is where `/w/{name}` lives — `main` does not
have it.

[`OneWorkspace.tsx`](../../web/src/routes/OneWorkspace.tsx) is 91 lines and draws four branches:

| Branch | What it draws |
| --- | --- |
| the workspace list has not answered | the title, and `Section` says why |
| no workspace has that name | a destructive alert pointing at the fleet |
| the file did not load | the error, and a link to `/w/{name}/repair` |
| everything is fine | the title, the machine as a link, and the terminal at `h-[60vh]` |

**It reads the list before it opens the socket**, and the comment says why: a round trip to the
daemon is cheap and an attach is not. That rule survives every change here.

**What D3 §11 asked for and what exists:**

| D3 §11 | Today |
| --- | --- |
| three tabs, `?view=` carrying which | **none** — the page is the terminal |
| the transcript, read from the far machine | **no route serves it** |
| a spend figure on its own tab | `/usage` draws it, behind a workspace picker |
| a desktop lands in the terminal | true by accident: there is nothing else to land in |
| a phone lands in the transcript | **false** — a phone gets 45 columns of a TUI that wants 80 |

**The daemon serves a workspace's status, its terminal, its spend and its broken file — and not its
transcript.** `status`, `terminal`, `tokens`, `repair`, `probe`, `readiness` and `attention` are all
routes. Reading what the agent said is the one thing the dashboard cannot do at all.

---

## 2. The measurements that change the design

Measured 2026-09-03 on `cachyos-g14`, against a real 15,051,890-byte transcript of 5,181 records —
this repository's own, which is the largest on the machine.

### 2.1 The tool inputs already cross the wire, and the parse throws them away

[`logs.rs`](../../crates/yantra-core/src/logs.rs) selects on the far side with `grep`, and its
pipeline drops **tool results** by name:

```sh
grep -E '"type":"(user|assistant)"' "$f" | grep -v '"toolUseResult"' | tail -n {lines}
```

So a `tool_use` block arrives **whole, with its `input`**, inside the assistant record that holds it.
The parse then reads `Block::ToolUse { name }` and lets serde discard everything else.

**This is what makes D3 §11.3's promise buildable at no cost on the wire.** §11.3 says tool calls
render collapsed and *expandable*, and `Entry.tools` is a `Vec<String>` of tool names — so there is
nothing to expand to. *edited Edit* says less than *edited web/src/api.ts*, and the second string is
already in the daemon's hands.

**Carrying the whole input is the wrong correction.** Over the last 200 selected records:

| Projection | Bytes of JSON |
| --- | --- |
| `Entry` as it is today | 40,212 |
| plus one chosen target per call, capped at 120 characters | 54,699 |
| plus every tool input, whole | 99,545 **added** — 2.5× the projection |

The largest single input is 11,753 bytes, and it is a `Write`. A `Write`'s input is the file. **So
the daemon picks one string per call rather than forwarding the object**, and §4.2 says which.

### 2.2 The far-side filter is free; the round trip is not

| Step | Cost |
| --- | --- |
| the shipped pipeline over 15 MB, `tail -n 50` | **0.02 s** |
| the same with a window, `tail -n 250 \| head -n 50` | **0.02 s** |
| counting every selectable record, `grep -c` | **0.01 s** |
| the ssh round trip itself | **0.33 s** ([D4](04-workspace-creation.md) Sources) |

**Reading more of the file costs nothing. Asking at all costs a third of a second, and asking a
sleeping machine costs whatever it costs to wake it.** That ratio is the whole reason §4.3 reads on
request and never polls.

> **2026-09-03, [Y-306](../../tracker.md#3-task-board): measured against a real machine, half of this
> table holds and the header does not.** [`tests/logs.rs`](../../crates/yantra-core/tests/logs.rs)
> built a 17.8 MB transcript of 60,000 selectable records in the container fixture and timed the read
> against a bare ssh round trip: **0.52 s against 0.017 s**. Broken down, the shipped pipeline costs
> 277 ms and **the windowed one costs 278 ms — the window is free, exactly as this section says**.
> The count is not. `grep -c` is a **second full pass** over the file, and it costs another 279 ms
> rather than the 0.01 s above, because that figure was GNU grep on a warm cache and the far side
> here is busybox.
>
> **The decision this section supports is unchanged**: both lines together still finish inside
> [D4](04-workspace-creation.md)'s 0.33 s ssh round trip, so §4.3 still reads on request and still
> never polls. What stops holding is the wording — *the far-side filter is free* is true of the
> window and false of the count, and a later reader pricing a second count at zero would be wrong.

**Two hops carry different amounts.** The last 50 records leave the machine as 121,267 bytes and
reach the browser as 25,703 bytes of JSON — 9,525 gzipped. §4.2's targets take that to 29,314 and
10,234. **The projection is where the saving is, and the projection already exists**: `logs.rs` has
reduced the file to who spoke and what they said since it was written.

### 2.3 Fifty records are forty-one turns

`lines` counts **records**, not turns. Of the last 50, nine carried only a tool result and were
dropped by the parse, which leaves 41 to read.

**So the page cannot promise a number.** It asks for a window of records and draws what came back.
Saying *50 turns* in the interface would be a number the far side never agreed to.

---

## 3. The tabs

### 3.1 Three, and `repair` is not one of them

> **Owner, 2026-09-03, asked whether `repair` becomes a fourth tab:** three tabs, and repair stays
> the separate page it already is.

`terminal · transcript · spend`.

**The reason is that the two sets never overlap.** A workspace whose file will not load has no
machine, no session and no spend — three of four tabs would be dead. A workspace that loads never
opens repair, and `GET /api/workspaces/{name}/repair` answers **409 for a file that loads**, so the
fourth tab would be dead for everything else.

The broken file already draws as a full-page alert with a link, and that stays exactly as it is.
**This decision changes no shipped code**, which is the cheapest kind.

### 3.2 The tab bar is links, and that is forced

**There is no `ui/tabs`.** The ported set has `toggle-group`, `toggle` and `table`, and
[ADR-0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md)'s first rule says never edit
`components/ui/`. So the control is composed rather than adopted.

**Compose it from `Link`, not from `toggle-group`.** A tab here changes the URL, and something that
changes the URL is navigation. A link gives middle-click, copy-link and the browser's own focus
handling for nothing, and D3 §11.1 asks for exactly that: *"A link reopens what you sent."* A toggle
group would need `useNavigate` behind an `onChange` to reach the same place, and would lose the
right-click menu on the way.

The cost: the bar is styled by hand rather than by a primitive, so §8's words and the tokens are the
whole specification. It is three links.

### 3.3 What decides the tab when the URL does not say

**An explicit `?view=` always wins.** No width, no memory, no preference overrides it.

**With no `?view=`, the width decides, once.** `matchMedia('(min-width: 768px)')` is read at first
render. Wide lands in the terminal, narrow lands in the transcript, exactly as D3 §11.1 and §11.2
say.

**768 px is Tailwind's `md`, and the dashboard mostly breaks at `sm`** — 132 `sm:` utilities against
6 `md:`, counted on the branch. This one does not follow the layout, because it is not a layout
question: it is the width at which the terminal stops lying. **Take the ratio from D3 §11.2's own
measurement** — 390 px gives about 45 columns at a readable size, so a column is about 8.7 px and
eighty of them want about 700 px before the page's own padding. That is arithmetic on a measured
number, not a second measurement, and it puts 640 px short and 768 px clear. **Naming the
inconsistency is the point** — a later change to the dashboard's breakpoints must leave this number
alone.

**Resizing does not move you.** A window dragged narrower keeps the tab you are on. A tab that
changes under a resize is a tab that changes under a phone rotating, and nobody asked for that.

**The default stays out of the URL.** Landing on `/w/site` writes no `?view=`, so the link you copy
from a desktop still opens the transcript on a phone. The moment you press a tab, the URL says so and
travels. **This is the behaviour D3 §11.1 and §11.2 both want**, and it only works if the implicit
case stays implicit.

**An unknown `?view=` falls back to the width default.** Not a 404: the workspace is real and the
page can draw. The cost is that a typo is ignored in silence.

### 3.4 A tab replaces, it does not push

Pressing a tab replaces the history entry. Back from `/w/site?view=spend` goes to wherever you came
from, not through two tabs first.

The cost, named: **Back never undoes a tab press.** Three tabs of one page are one place, and making
the browser's Back button walk them is how a phone user gets trapped tapping Back four times to leave
a page they opened once.

### 3.5 Only the open tab is mounted

The terminal tab mounts `Terminal`, and mounting it opens an ssh. Switching away unmounts it and
closes the socket.

**Nothing is lost, because tmux draws the pane for whoever attaches** — Y-132's finding, and the
reason the daemon holds no buffer. Coming back is a fresh attach and a redraw.

The cost is one ssh per return to the tab. It is the same cost as opening the page, and the
alternative is holding a pty open for a tab nobody is looking at.

---

## 4. The transcript

### 4.1 A turn

Who spoke, when, and what they said, in normal type. `who` is *you* or *claude* — the CLI's own two
words in [`main.rs`](../../crates/yantra/src/main.rs)'s `render_logs`, and there is no reason for the
browser to invent two more.

**The timestamps are instants and may be printed as ages.** Claude Code writes
`2026-08-11T18:09:33.178Z`, measured; [`lib/time.ts`](../../web/src/lib/time.ts) refuses a stamp that
names no zone and this one names `Z`. A turn with no timestamp — a few records carry none — prints
none. It does not print *unknown*.

**Text renders as text, not as Markdown.** The agent writes Markdown and rendering it would mean a
Markdown parser inside a 145 kB budget, an XSS surface on text a machine wrote, and code fences that
need a highlighter next. Whitespace is preserved and long lines wrap. **This is a real loss** — a
bulleted plan reads as asterisks — and §10 leaves it as the one thing worth reconsidering after the
page exists.

### 4.2 A tool call

One line per call: the tool's name as a verb, and **one target string**.

> **Owner, 2026-09-03, asked how deep the transcript renders:** carry the tool inputs, so a line reads
> *ran cargo test* or *edited web/src/api.ts* and expands to the command or path. Keep results off the
> wire.

The daemon picks the target by the first key present, from a fixed list:

`command` · `file_path` · `path` · `pattern` · `url` · `query` · `description` · `prompt`

**Measured: this finds a target for 126 of 127 calls** in the last 200 records. The miss is
`SendUserFile`, whose `files` is a list. A call with no target renders as its name alone.

**The target is capped at 120 characters on the far side, and the cap is real.** The median target
is 107 characters and the longest measured is 3,383, so **120 keeps the typical one whole and still
cuts 41%** of them. Eighty would cut 57% and save 2.6 kB over 200 records, which is not worth the
difference.

**So a cut target is marked as cut, and the line does not promise more.** Collapsed, it is one line.
Expanded, it is the target as the daemon sent it — up to the cap, wrapped. **The whole command is in
the terminal and in the file, and this page never claims to be either.** Forwarding every input
whole would cost 19 kB more over 200 records and would carry a `Write`'s file contents to a phone.

**`Entry.tools` becomes `Vec<Call>`, and `Call` is two fields.** This is a change to `yantra-core`
and to what `yantra logs` prints. It sends no more bytes over ssh — §2.1 — and adds 36% to the
daemon's own projection.

> **[D0](00-plan.md) §5 calls this read `yantra logs --json`. There is no such flag.** `Logs` takes a
> workspace and a line count, and `render_logs` prints text. `doctor` is the verb that has `--json`.
> Nothing depends on the mistake, and the JSON shape D5 needs is the daemon's, not the CLI's.

### 4.3 It is read on request, and landing on the tab is the request

> **Owner, 2026-09-03, asked how the transcript reaches the browser:** a `POST`, on request, exactly
> like `tokens`. And, asked what that does to D3 §11.2's promise that a phone lands on the transcript:
> landing on the tab counts as the request.

So:

- **Nothing polls.** A read is an ssh, and §2.2 says what one costs.
- **Opening the tab reads once**, and the page says *reading the transcript on `cachyos-g14` over
  ssh* while it waits — `Usage.tsx`'s skeleton and its exact sentence.
- **A `Refresh` re-reads**, and the answer is stamped with when it arrived.
- **The stamp moves on a one-second clock that fetches nothing.** D3 §11.4's amendment settled this
  for spend and the reason is the same here: a stamp that never moves is the lie the stamp exists to
  prevent.
- **Switching to the terminal and back does not re-read.** The answer is held for as long as the page
  is open, and its stamp keeps ageing so a stale one says so.

**The cost, named:** a phone that opens `/w/{name}` at 3 am spends an ssh before it shows anything,
every time. The alternative — a Read button — puts a tap in front of the one thing D3 §11.2 says the
phone came for.

### 4.4 Older

> **Owner, 2026-09-03, asked how much arrives:** the last N turns, with older on request.

**The window is two far-side numbers**, both free per §2.2:

- `lines` — how many records this page holds. **50**, which measured as 41 turns.
- `before` — how many newer records to skip. `tail -n {lines + before} | head -n {lines}`.

`Older` asks for the next window back and the page keeps what it has. The windows are disjoint, so
the page prepends and stitches nothing.

**The read also returns `total`**, from `grep -c` on the same pipeline — 0.01 s, measured. It counts
**records**, like `lines` and `before` — so the page says *the last 50 of 1,944 records* and never
mixes the two units. §2.3 is why: turns are what came back, records are what was asked for.

**The ground does move.** A running agent appends while you page backwards, and the window is counted
from the end — so a second page can overlap the first or skip a turn between them. **The page
compares `total` against the first read**, and when it has grown it says the conversation moved on
and offers a re-read rather than stitching a window that no longer lines up. Silently drawing a
shifted window is the failure this avoids, and it is the one a reader could never detect.

**Rejected: fetching only what is new.** The file is append-only, but a `resume` forks it
([ADR-0015](../adr/0015-resume-forks-the-conversation.md)) and records have no index that survives
across reads. An incremental protocol would be guessing about someone else's file format, which is
the guess `logs.rs` already stopped making.

### 4.5 What the transcript says when it has nothing

The daemon's two "not an error" cases are `NoTranscript` and `NoTurnYet`, and `/usage` already answers
both as **409** with the daemon's own sentence. The transcript tab uses the same status and the same
words:

| State | What it says |
| --- | --- |
| no transcript on the machine | *No agent has written a turn here.* A transcript appears on the agent's first message, not when it launches (I-49). |
| the session exists and has written nothing | the same, naming the session |
| the read failed | the daemon's whole chain — machine, command, and what ssh said |
| the workspace has no session at all | the same as the first row. A workspace that has never run is not an error. |

**None of these is drawn as a failure**, which is what `Usage.tsx` established and what makes the
distinction visible at all.

### 4.6 Take control

D3 §11.2 gives the transcript a **Take control** button that opens the pane. It is a link to
`?view=terminal` — §3.2's rule, with nothing special about it.

On a narrow screen it is the only thing that reaches the terminal without going through the tab bar,
and that is the point: the phone lands on what happened, and keeps one press to the thing that is
happening.

---

## 5. The terminal tab

### 5.1 Unchanged, with one prop

The component keeps its socket, its `ATTEMPTS`/`PAUSE` budget, its `xterm-256color` and its close
button. The tab wraps it and nothing else.

[D1](01-dashboard.md) §4.5's fidelity requirements are the component's, and none of them is a
height. **So `h-[60vh]` becomes a prop with `60vh` as the default.** The component hardcodes the height today
and takes `{ name, onClose }`. Nothing on this page needs a different height — §5.2 says who does.

### 5.2 The trust prompt is settled, and it is not this page's

[D3](03-dashboard-surface.md) §4.5 already answered D0 §5's question: the trust prompt is **the pane
itself at twelve rows on the existing socket**, not a picture of one and not Yantra's own buttons.
Yantra renders the question and forwards the keystroke, because reading the options and drawing
matching controls would spend I-49's fragility budget on a control and could answer the wrong thing.

**That expansion lives on the fleet row, not on `/w/{name}`.** This page's terminal is the whole pane
at full height, and the dialog is already in it — a workspace at `awaiting_trust` opens on a terminal
showing the question, with no special case anywhere.

What this page owes it is §5.1's prop. **D5 builds the prop; D6's row spends it.**

---

## 6. Spend

### 6.1 The tab is `/usage`'s answer with the picker removed

`POST /api/workspaces/{name}/tokens` already exists and is already per workspace — D3 §11.4's
amendment of 2026-08-11. On this page the workspace is the URL, so there is nothing to pick.

Everything else `Usage.tsx` established holds unchanged: read on request, the `asking` skeleton
naming the machine, 409 drawn as *nothing to add up* rather than as a failure, the refusal table for
403/404/503, `AS_OF` printed verbatim as the day it is, and the page's own arrival stamp on a clock
that fetches nothing.

**So `Answer` and `Figure` move out of [`Usage.tsx`](../../web/src/routes/Usage.tsx) into a module
both routes import.** `/usage` keeps the picker and loses nothing.

### 6.2 Unpriced shows tokens, and no money at all

> **Owner, 2026-09-03:** where any model is unpriced, the headline is the token count, the dollar
> line is absent, and the unpriced model is named underneath.

This is what the daemon already does. A `Spend` carries `cost: null` when any model is unpriced, and
D3 §11.4's third amendment records why: summing an empty list of prices gives zero, and *a zero
beside a date reads as a session that cost nothing*.

**A fast-mode session takes the same shape** — `fast: 3`, `cost: null` — and says so in its own words
rather than borrowing the unpriced ones.

The cost: two sessions that cost very different amounts of money can show the same headline, because
the headline is tokens. That is the honest answer, and the model name underneath is what makes it
actionable.

> **2026-09-04, [Y-311](../../tracker.md#3-task-board): the premise is false and the rule still
> stands.** *This is what the daemon already does* is wrong.
> [`write.rs`](../../crates/yantrad/src/write.rs)'s `Spend::of` nulls `cost` when **every** model is
> unpriced, in fast mode, and for a session that spent nothing — not when **any** model is. It sums
> the models the price table carries and leaves the rest `null`, so `contract.gen.ts`'s own `spend`
> fixture arrives as `cost: 5.4633115` beside a `model: "unknown"` with `cost: null`.
>
> **So the browser withholds a figure the wire carries.** The rule this section states is the one
> built: wherever a model is unpriced, the headline is the token count and no dollar line is drawn.
> A partial sum under *this session* understates what the session spent, which is R-23's refusal one
> level up from the `$0.00` it already refuses per model.
>
> **The model table is untouched.** One model's cost understates nothing, so the `COST` column still
> prices what the table prices and still calls the rest `unpriced`.
>
> The headline is a number rather than the word *unpriced*, which is what *the headline is tokens*
> asks for. It counts the four token fields and never `responses` — a response is not a token.

---

## 7. When the machine cannot be reached

> **Owner, 2026-09-03:** the tabs stay, and each one says what it could not reach.

| Tab | What it says |
| --- | --- |
| terminal | the socket would not open, with the attempt budget spent — the component's own state |
| transcript | the read failed, naming the machine, the command and what ssh said |
| spend | the same, through `Usage.tsx`'s 503 row: *the machine could not be asked, so nothing was counted* |

**Nothing is suppressed and no banner is added.** Only the open tab is mounted (§3.5), so a reader
sees one refusal at a time — and each one names the machine, so the first one already says where the
fault is. A page-level banner would say the same thing once instead of three times, and would cost a
spend figure the reader had already read. **Three quiet repetitions are cheaper than one loud
erasure.**

**The machine's name stays a link.** `/m/{machine}` is where its heartbeat, its readiness and its
last-seen age are, and that is the next thing anyone wants.

---

## 8. Words

| Say | Not |
| --- | --- |
| terminal · transcript · spend | console · log · cost |
| turn | message, entry |
| you · claude | user · assistant |
| ran · edited · read · searched | executed · modified · invoked |
| Older | Load more, Previous |
| Refresh | Reload, Sync |
| Take control | Attach, Open terminal |
| reading the transcript on `X` over ssh | loading… |
| No agent has written a turn here | No data, Empty |
| unpriced | free, $0.00, unknown cost |

**One term, one meaning** (§A6). *Transcript* is the file and the tab. *Turn* is one thing somebody
said. A tool call is not a turn, and the interface never calls it one.

---

## 9. What this needs that does not exist

| Layer | What | Why it is new |
| --- | --- | --- |
| `yantra-core` | `Call { name, target }` replacing `Vec<String>` | §4.2. The bytes are already on the wire and discarded in the parse. |
| `yantra-core` | `before` and a `total` on the probe | §4.4. Two lines of shell, both measured free. |
| `yantrad` | `POST /api/workspaces/{name}/logs` | §1. Nothing serves the transcript today. On `allowed()`, 409 for the two empty cases, 503 naming the ssh chain — `tokens`'s shape exactly. |
| `web` | a tab bar of three `Link`s | §3.2. There is no `ui/tabs`, and ADR-0014's first rule forbids editing one in. |
| `web` | `?view=` on the `/w/$name` route | §3.3. Nothing in the dashboard validates a search param yet; this is the first. |
| `web` | a `height` prop on `Terminal` | §5.1. It is `h-[60vh]` hardcoded. |
| `web` | `Answer`/`Figure` extracted from `Usage.tsx` | §6.1. |

**The weight.** `/w/$name` is already the heaviest split route — xterm.js and its CSS are a third of
the bundle — and everything added here lands in that chunk rather than in the first paint. The
transcript is text and three links. Against D3 §9.1's *≤ 145 kB, hold and do not grow*, this document
proposes nothing that touches the first load.

> **One thing found while measuring, and it is not this document's to fix (§A3).**
> [`Usage.tsx`](../../web/src/routes/Usage.tsx)'s header says *"This route is eager, and a
> `lazyRouteComponent` here fails a test this row may not edit"*, and
> [`router.ts`](../../web/src/router.ts) makes `/usage` a `lazyRouteComponent` with a measurement
> beside it. On one branch tip, one of the two is wrong. Y-194 split the route after Y-199 wrote the
> comment, so the comment is the likely stale half — but `router.test.tsx` is the thing to check
> before believing that, and §10 carries it as a line rather than an assumption.

---

## 10. Work units

Sized to be taken one at a time. **Proposed, not opened** (§B0).

| # | Work | Done when |
| --- | --- | --- |
| **D5.1** | `Entry` carries a call's target (§4.2) | `Call { name, target }` lands, the target is chosen by the eight-key list, it is capped at 120 characters and a cut one says it was cut, `yantra logs` prints it, and a call with no target prints its name alone |
| **D5.2** | The probe takes a window and returns a count (§4.4) | `before` skips newer records, `total` comes from the same pipeline, and a path or session holding a quote still cannot reach the remote shell |
| **D5.3** | `POST /api/workspaces/{name}/logs` (§9) | it answers the projection, sits on `allowed()`, returns 409 for a transcript that is absent or empty, and 503 naming the ssh chain for a machine that could not be asked |
| **D5.4** | The tab bar and `?view=` (§3) | three links, an explicit view always wins, the width decides once at 768 px, a resize moves nothing, an unknown value falls back, and a press replaces rather than pushes |
| **D5.5** | The transcript view (§4) | turns with their ages, tool calls as one line expanding to the target, `Older`, a stamp that moves on a clock that fetches nothing, and the four empty states in §4.5's words |
| **D5.6** | The conversation moved while you paged back (§4.4) | a grown `total` says so and offers a re-read, asserted against a file that gained records between two reads |
| **D5.7** | The spend tab (§6) | `Answer` and `Figure` shared with `/usage`, no picker, and an unpriced session showing tokens with no dollar line |
| **D5.8** | Three tabs against a machine that is not there (§7) | each tab draws its own refusal, the machine stays a link, and no banner is added |
| **D5.9** | `Terminal` takes a height (§5.1) | the prop defaults to `60vh`, this page passes nothing, and D3 §4.5's twelve rows have somewhere to come from |

**D5.1, D5.2 and D5.3 come first**, and the page is worth nothing without them.

> **2026-09-03: the owner minted all nine**, as **Y-305**…**Y-313** in the order above.
> [Y-198](../../tracker.md#3-task-board) stays as their parent and closes when they do.

**Two things are worth doing that this document does not propose as rows.** Check whether
`Usage.tsx`'s header comment or `router.ts` is the stale one (§9). And reconsider rendering the
agent's Markdown (§4.1) **after** the page exists — the loss is real, the cost is a parser and a
highlighter inside a held budget, and neither is worth arguing about against a screen nobody has
read yet.

---

## Sources

Measured **2026-09-03** on `cachyos-g14`, branch `m13-dashboard-surface`, against this repository's
own Claude Code transcript — 15,051,890 bytes over 5,181 records, the largest on the machine. No
number here was taken over ssh: the far-side pipeline was run locally, so §2.2's filter timings are
the filter alone and D4's 0.33 s round trip is the ssh half.

- 1,944 records survive the shipped `grep` selection, out of 5,181. The last 50 of them are 121,267
  bytes; the last 200 are 510,289.
- Those 50 records project to **41 turns** — nine carried only a tool result — and to 25,703 bytes of
  JSON, 9,525 gzipped. With a capped target per call: 29,314 bytes, 10,234 gzipped.
- Over the last 200 records: 154 turns, 127 tool calls, `Entry` as shipped 40,212 bytes. A target
  capped at 120 adds 14,487; uncapped it adds 33,736; every input whole adds 99,545, the largest
  being an 11,753-byte `Write`.
- The eight-key list finds a target for **126 of 127** calls. The miss is `SendUserFile`.
- Target lengths: median 107, longest 3,383. A 120-character cap cuts 52 of 126; an 80-character cap
  cuts 73 and saves 2,637 bytes over the 200 records.
- Tool frequency: `Bash` 80, `Edit` 38, `Write` 5, `Read` 3, `SendUserFile` 1.
- The far-side filter costs 0.02 s over 15 MB, unchanged by a window; `grep -c` costs 0.01 s.
- The transcript's `timestamp` is `2026-08-11T18:09:33.178Z` — zoned, so `lib/time.ts` will read it.
- Breakpoints in `web/src`: 132 `sm:`, 6 `md:`, 4 `lg:`, 2 `xl:`. `OneWorkspace.tsx` is 91 lines.
  There is no `ui/tabs` in the ported set.

**Decisions** — seven taken by the owner on 2026-09-03, in a structured interview: carrying tool
inputs, reading on request, windowing the read, landing as a request, three tabs rather than four,
per-tab refusals, and tokens as the headline where a model is unpriced. Each is recorded at the
section it governs, with its cost.

**Yantra internal** — [D0](00-plan.md) §5; [D1](01-dashboard.md) §4.5;
[D3](03-dashboard-surface.md) §4.5, §9.1, §11, §13; [D4](04-workspace-creation.md) Sources; ADRs
[0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md),
[0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md),
[0015](../adr/0015-resume-forks-the-conversation.md),
[0016](../adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md), and ADR-0020,
which is named rather than linked because it lands with PR #222 and does not resolve on this branch;
[`logs.rs`](../../crates/yantra-core/src/logs.rs), [`tokens.rs`](../../crates/yantra-core/src/tokens.rs),
[`OneWorkspace.tsx`](../../web/src/routes/OneWorkspace.tsx), [`Usage.tsx`](../../web/src/routes/Usage.tsx),
[`Terminal.tsx`](../../web/src/components/Terminal.tsx), [`router.ts`](../../web/src/router.ts),
[`lib/time.ts`](../../web/src/lib/time.ts); I-36, I-49; Y-129, Y-132, Y-181, Y-194, Y-198, Y-199.
