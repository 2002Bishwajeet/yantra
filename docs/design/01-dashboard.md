# D1 — The dashboard you work in

**Status:** proposed. Written 2026-08-09 from the owner's spec. Opens no rows (§B0) — §9 proposes
them and the owner mints them. **The owner minted the first on 2026-08-09**:
[Y-161](../../tracker.md#3-task-board) is D1.2, and D1.3, D1.5 and [D2](02-setup.md).3 were all
waiting on it.

**Read [R13](../research/13-dashboard-revamp-and-github.md) first.** It measured what the page is
against the founding UI principle and priced a clone against the decisions it collides with. This
document is the design that follows from it plus what the owner decided after reading it.

---

## 0. What this settles

**The dashboard is where you work, not only where you launch.** The owner's words:

> *we work and launch in the dashboard … we launch claude code, codex, or other agentic CLI,
> terminals, swap it with sshed terminal, if we want to work it in the dashboard. or activate
> remote control to work in their own respective app.*

That answers the question R13 §6 left open and prices everything below. A terminal you live in
justifies real investment; a launcher would not have.

**It settles nothing about pigment or type.** [`docs/design-system.md`](../design-system.md) owns
that, and §8 records the one collision.

---

## 1. Routes

One URL today. Nothing is bookmarkable and nothing survives a reload — that, not the feature count,
is what "handle everything via the dashboard" collides with.
[`crates/yantrad/src/web.rs`](../../crates/yantrad/src/web.rs) already serves any path as the app,
so the router is web-only work blocked on nothing.

| Path | Draws | Needs |
| --- | --- | --- |
| `/` | fleet: machine cards, readiness, what is live | existing reads |
| `/m/{machine}` | one machine: beat, readiness detail, its sessions and agents | existing reads, filtered |
| `/m/{machine}/repos` | that machine's view of your repositories | §5, new endpoint |
| `/m/{machine}/shell` | a shell not tied to a workspace | new socket, **ADR needed** (§4.4) |
| `/w/{name}` | the workspace: terminal full height, agent ⇄ shell tabs, act, `/rc` | existing socket |
| `/launch` | the reconcile screen (§3) | new endpoint |
| `/settings` | ntfy relay, provider auth status, terminfo | §6, §5 |

`/w/{name}` **lands in the terminal.** That is what you came for; status and actions sit around it.

---

## 2. The card, and one verb

[`Act.tsx`](../../web/src/components/Act.tsx) shows up/down/resume and makes the reader choose. A
card should already know:

| State | The one button |
| --- | --- |
| session exists, agent alive | **Resume** |
| up, no agent | **Open** |
| down | **Start** |
| machine unreachable | **Fix** → `/m/{machine}` |

Everything else goes in an overflow. Fewer decisions is the whole job.

> **Built 2026-08-09 by [Y-167](../../tracker.md#3-task-board), and the first row's label
> changed.** *Resume* is already the name of a route that respawns an agent that **ended**, so
> using the same word for a session that is **alive** would have made one word mean two things in
> one column. A live session is **Open** — a URL, not a verb the daemon runs — and *Resume* stays
> the POST. Two states the table does not name were read off the same reading rather than guessed:
> an ended agent whose `startup` is not an agent gets **Open** too, because ADR-0015 refuses resume
> for it; and a row whose agent look has not landed yet gets no verb at all, because Start would be
> a guess painted as knowledge (R-23). `awaiting_trust` gets its own word, **Answer** — it is the
> one state waiting on a person, and ADR-0011 says the person is never Yantra.
>
> **The overflow is loaded on the first tap, not the first paint.** Base UI's menu is 29 kB gzip
> measured on this branch, which is a quarter of the fleet's whole first load, and the trigger is
> anchored to rather than wrapped so nothing about the button waits on the chunk.

**Keep the staleness honesty.** The page distinguishes *nobody looked* from *a look failed* from *a
machine did not answer*, and stamps every reading's age
([`useLooked.ts`](../../web/src/useLooked.ts)). That is rare and correct — never drop it. But four
age lines become one freshness dot per card plus a single global *as of*.

---

## 3. Reconcile before launch

The owner's ask:

> *if i browse a repo in github, and want to open a machine maybe in macos, check if i have it in
> macos already, and check if we had previous sessions, check if we were working to reduce
> redundance and then work. else we setup it from scratch.*

**Nothing in Yantra does this.** It is the most valuable missing piece and it is cheap, because
the daemon persisting nothing (Y-044) means the answer is *probed*, not *remembered* — and every
probe already has a call site.

### 3.1 The four probes

| Question | Command on the target | Existing call site |
| --- | --- | --- |
| is the repo there? | `test -d <path>` | [`up.rs:216`](../../crates/yantra-core/src/up.rs) `exists_command` |
| is it *that* repo? | `git -C <path> remote get-url origin` | new, one line |
| was there a session? | tmux session listing | [`sessions.rs`](../../crates/yantra-core/src/sessions.rs) `list()` |
| was anything running in it? | the workspace verdict | [`status.rs`](../../crates/yantra-core/src/status.rs) `Verdict` |

### 3.2 The four outcomes

The screen runs the probes and states **which one thing is about to happen**:

| Probes say | Outcome | Calls |
| --- | --- | --- |
| session exists for this repo | **Attach** — you were already working | existing `resume` |
| repo present, no session | **Start here** | existing `up` |
| repo absent, machine reachable | **Clone, then start** | `clone` (§5.3) then `up` |
| machine unreachable, or origin mismatches | **Blocked**, with the reason | — |

An origin mismatch must **not** silently reuse the directory. Say the path is taken by a different
remote and let the reader choose a new path.

### 3.3 Where it lives

`GET /api/machines/{machine}/reconcile?repo=<url>` returning the four readings and the recommended
outcome. It **awaits ssh**, which [`crates/yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md)
forbids inside a read handler. Two ways out — pick one in the ADR of §4.4:

- shape it as a **write** (the handler's stated exception), or
- fold it into [`refresh.rs`](../../crates/yantrad/src/refresh.rs)'s snapshot and read the cache.

---

## 4. Working in it

### 4.1 Agent ⇄ shell tabs

`up(name, term, agent: Option<Agent>)` already treats *no agent* as "open a plain shell", so the
launch-time choice exists ([`up.rs:99`](../../crates/yantra-core/src/up.rs)). What is missing is
swapping **within** an open workspace: a second pane, a second tab, one socket each.

### 4.2 A second agent

```rust
/// Which agent to launch. One variant, and it stays one until a second agent is
/// genuinely wanted — the guardrail, and ADR-0011.
pub enum Agent { Claude }
```

The owner now wants Codex, Cursor and others. That is an **ADR-0011 amendment**, not a bug — the
comment invites it. It costs: a second variant, a second `agent::prepare`, and
[`agent.rs`](../../crates/yantra-core/src/agent.rs)'s `CANDIDATES` (six Claude-shaped install paths)
becoming per-agent. Note also that `agent.rs` matches a fragment of Claude's trust dialog to detect
an inert agent (I-49) — each new agent needs its own equivalent or an honest `Verdict::Unclear`.

### 4.3 Remote control

Claude Code's `/remote-control` (alias **`/rc`**) pairs a **local** session to claude.ai/code and
the Claude mobile app. The docs' own recommendation for surviving an ssh disconnect is *"start it
inside `tmux` or `screen`"* — which is [ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md)
verbatim. **Every session Yantra starts is already a valid `/rc` host.** It makes outbound HTTPS
only and opens no inbound ports, so it does not conflict with tailnet-only.

Three constraints it drags in:

1. **A claude.ai login is required and API keys are refused.** `claude setup-token` and
   `CLAUDE_CODE_OAUTH_TOKEN` are rejected as not full-scope.
2. **Therefore I-44 applies.** On macOS the credential is in the login keychain and ssh lands in
   launchd's `Background` domain, so `/rc` will work **only in a tmux server started at that Mac's
   own keyboard** — the exact condition
   [ADR-0018](../adr/0018-the-tmux-server-carries-the-macos-login-session.md) documents. This is the
   second feature to land on that constraint and it strengthens the case for its §7 launchd job.
   **Unverified: not yet measured.** One `/rc` in a Yantra-started session on that Mac settles it.
3. **Its push notifications overlap with ours.** Claude's `/config` offers *Push when Claude decides*
   and *Push when actions required*, which is the same event class as `Verdict::AwaitingTrust` going
   out over ntfy (§6). **Do not send both.** Suppress ours while `/rc` is live, or make it a
   per-workspace choice.

**The button.** Claude Code prints the session URL, shows a QR, and puts an `/rc active` indicator in
the footer. Reading that URL means **matching it in the tmux pane** — the same technique
`agent.rs` already uses for the trust dialog, with the same fragility budget. So `/w/{name}` gets:
*enable remote control* → the URL and a QR → tap it on your phone.

For agents with no equivalent, fall through to the PWA terminal (§4.5).

### 4.4 A free shell, and the decision it needs

`GET /api/machines/{machine}/shell` mirrors
[`terminal.rs`](../../crates/yantrad/src/terminal.rs) exactly, so the code is cheap. **But it widens
what a browser tab reaches** from "a pane inside a workspace's session" to "any command on any
machine", and [ADR-0016](../adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)'s
authoriser is all that stands between that and the tailnet. R13 flags this as decision **D**; the
owner has made it MVP, so it must be written before the button ships. **Next free ADR number is
0019.**

### 4.5 The terminal must be a real TUI surface

The owner: *"make sure TUI is there since the webapp terminal needs interactiveness."*

This is **not** a request for a `ratatui` client — R13 §5's *build no TUI* recommendation stands, and
tmux is already the TUI (§B2). It is a requirement that the **browser terminal be interactive**
rather than a log tail. Yantra already tracks this:

- **I-36 / I-43** — forward a `TERM` the far side actually has;
  [`terminfo.rs`](../../crates/yantra-core/src/terminfo.rs) opens *"Whether the machine you attach to
  knows the terminal you sit at."*
- **`yantra fix-terminfo <machine>`** exists as a verb because this bites.
- **I-35** — do not glob the tmux path.

What still needs proving, each a test:

| # | Behaviour | Passes when |
| --- | --- | --- |
| 1 | resize | a browser resize reaches the pane; `tput cols` matches |
| 2 | `Ctrl-C` | interrupts the far process, is not swallowed by the browser |
| 3 | `Ctrl-B` | reaches tmux rather than bookmarking the page |
| 4 | arrows / Home / End | move the far cursor |
| 5 | 256 colour + true colour | a colour ramp renders |
| 6 | mouse mode | a TUI that requests it receives clicks |
| 7 | bracketed paste | a multi-line paste does not execute line by line |
| 8 | reconnect | a dropped socket resumes the same pane, not a new one |

### 4.6 PWA

Already scaffolded: [`web/public/manifest.webmanifest`](../../web/public/manifest.webmanifest),
[`web/public/sw.js`](../../web/public/sw.js), 192/512 icons, an apple-touch-icon, and registration at
[`main.tsx:14`](../../web/src/main.tsx). Cards must survive a narrow screen; wide tables do not.

---

## 5. Git providers

### 5.1 Cloning is not provider-specific

R13's §B4-clean mechanism — **the credential never enters Yantra, it lives on the target machine** —
has a consequence R13 did not state: it makes cloning **provider-agnostic by construction**.
`git clone <url>` on the far machine uses whatever credential helper or ssh key that machine already
has. GitHub, gitlab.com, self-hosted GitLab, Gitea, Forgejo, a bare repo on a NAS — identical to
Yantra.

| Capability | Provider-specific? |
| --- | --- |
| clone | **no** — `git clone` + the machine's own credential |
| launch · session · terminal · `/rc` | no |
| browse my repositories | **yes** — one adapter per provider |

**So the MVP supports every provider on day one by accepting a clone URL.** Browsing is an optional
adapter added one provider at a time and blocks nothing.

### 5.2 A provider is a CLI name, a list command, and a JSON shape

Measured 2026-08-09 on `cachyos-g14` `[V]`:

```
gh   2.96.0     gh repo list --json …
glab 1.109.0    glab repo list -F json -P <n>      (-F/--output text|json, --jq)
tea  absent
```

Not an OAuth app, not a token, not a webhook, not a callback URL. That satisfies §B4 by construction
and makes **self-hosted free**: `glab auth login` takes `--hostname`, `--api-host` and
`--api-protocol`, so another GitLab is configuration, not a code path.

**Self-hosted is the primary case here, not the edge case.** `glab auth status` on this box `[V]`
reports gitlab.com with *no token found*, and a self-hosted GitLab logged in and working.

**§B4 note.** `glab` resolved that credential to its plaintext config file (it checks config file,
keyring, then environment). Yantra must never read it, pass it, or echo it. Running `glab` *as* that
user over ssh does none of those things — which is exactly why this mechanism is the right one.

### 5.3 The consequence: browsing is per-machine

If browsing runs on the target machine, **two machines can return different repository lists**,
because they hold different credentials. That inverts R13's flow into:

> **pick machine → browse that machine's view → reconcile (§3) → launch**

which is also closer to how the owner described it. The alternative — one global list from a
daemon-held token — is R13's decision **A** taken the expensive way: supersede ADR-0004's amendment,
change §B1, and reopen Q5. **Not for MVP.**

### 5.4 Endpoints

Every one implies a CLI verb first — `crates/yantrad/CLAUDE.md`: *"Anything the web UI can do must be
expressible in `yantra` first."*

| Method + path | CLI verb first | Blocked on |
| --- | --- | --- |
| `GET /api/machines/{m}/repos` | `yantra ls repos --machine <m>` | the read-awaits-ssh question, §3.3 |
| `GET /api/machines/{m}/reconcile?repo=` | `yantra reconcile <url> --machine <m>` | same |
| `POST /api/machines/{m}/clone {url,path}` | `yantra clone <url> --machine <m> --into <p>` | decision **C** — may a write handler await an unbounded operation? |
| `GET /api/machines/{m}/shell` | `yantra shell <m>` | decision **D**, §4.4 |
| `POST /api/workspaces` | `yantra new` | — already shipped |

**A workspace may need an origin.** Today `Workspace` is `{ name, machine, repo, startup }` and
`repo` is a path on the far machine — there is no url, origin, remote or provider field. Adding one
is [ADR-0007](../adr/0007-workspace-schema-v1.md)'s decision **B**, in the shape
[ADR-0010](../adr/0010-drop-branch-from-the-workspace-schema.md) already used to remove a field.

---

## 6. Notifications are already built

[`crates/yantra-core/src/notify.rs`](../../crates/yantra-core/src/notify.rs), wired through
[`yantrad/src/refresh.rs`](../../crates/yantrad/src/refresh.rs) and
[`yantrad/src/notify.rs`](../../crates/yantrad/src/notify.rs). `yantra notify 'hello'` posts to
`YANTRA_NTFY_URL` (`YANTRA_NTFY_TOKEN` optional). Q16 answered it; the M7 plan §3.6 designed it.

"Agents that need attention" is already a named verdict — `AwaitingTrust`, `Crashed`, `Killed`,
`NoSession`, `Finished`, `Stopped`, `NoAgent`, `Unclear`. The notifier is a **diff of two consecutive
snapshots**: no poll, no ssh, no timer. Two rules already enforced follow from persisting nothing —
the first look after a start says nothing, and a failed send is dropped rather than queued.

**What is missing is only the UI.** `YANTRA_NTFY_URL` is an environment variable and nothing sets it
from the dashboard — the "everything from the dashboard" gap, and a small one.

Worth borrowing from Claude Code: `CLAUDE_CLIENT_PRESENCE_FILE` suppresses pushes while a marker file
exists, i.e. while you are at the machine. Yantra's notifier could honour the same idea.

---

## 7. Component vocabulary

Yantra's `web/src/components/ui/` holds five primitives — alert, badge, card, empty, table. The
routes above need roughly thirty.

**[T3 Code](https://github.com/pingdotgg/t3code) is MIT-licensed and built on the same foundation**:
`@base-ui/react`, Tailwind v4, `class-variance-authority`, `tailwind-merge`, React 19 with the React
Compiler, Vite — the same stack down to the `cn()` helper. Its `components/ui/` is about forty
components, and only five files there touch its Effect runtime (`qr-code`, `sidebar`, `toast`). The
rest port by copying, fixing the import alias, and deleting what is unused.

**Take:** button · dialog · sheet · popover · menu · select · combobox · command · kbd · tooltip ·
scroll-area · skeleton · spinner · switch · field/form/input/label · separator · collapsible ·
toggle-group.

**Do not take:** its Effect runtime, ~~TanStack Router~~, zustand, Clerk, its `libghostty-vt` WASM
terminal (Yantra has xterm.js), its `packages/ssh` (it sets `ControlMaster=no`, the opposite of I-20,
because its case is one long tunnel and Yantra's is repeated short exec), or its
`native/resource-monitor` (Yantra's [`probes.rs`](../../crates/yantra-agent/src/probes.rs) is
zero-dependency and documents per-platform findings `sysinfo` would discard).

> **TanStack Router struck from that list, 2026-08-09.** The owner ruled for battle-tested packages
> in `web/` ([CLAUDE.md](../../CLAUDE.md) §B1, [ADR-0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md)'s
> amendment), and [Y-162](../../tracker.md#3-task-board) adopted it. What stays refused is T3 Code's
> *runtime* — Effect, zustand, Clerk — which is what this line was really about.

**Attribution.** MIT requires the copyright notice and licence text to ship with any substantial
portion. A `web/src/components/ui/THIRD-PARTY.md` naming T3 Tools Inc., the MIT text, the upstream
URL and the commit taken from, plus a header on anything copied near-verbatim.

---

## 8. The design-system collision

[`docs/design-system.md`](../design-system.md) §7 was written to be adopted by the dashboard and
**never was**: [`web/src/index.css`](../../web/src/index.css) imports `tailwindcss`,
`tw-animate-css` and `shadcn/tailwind.css`, and does not import `design/tokens.css`.

This does **not** block §7 above — the ported primitives use the same shadcn CSS-variable names, so
design-system §7's `--accent` bridge applies to them unchanged. Adopting Pattachitra stays a separate
piece of work whose diff is `index.css`, exactly as
[ADR-0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md) promised.

> **Not quite unchanged, 2026-08-09 ([Y-164](../../tracker.md#3-task-board)).** T3 Code's primitives
> also name five tokens shadcn's sheet does not have — `--control-radius`, `--destructive-foreground`,
> `--placeholder` and the two `--app-scrollbar-thumb*`. The port added them to
> [`index.css`](../../web/src/index.css) at T3's values. The bridge still applies; the swap point is five
> lines larger than this section assumed. Tooltip's opt-in `variant="glass"` was **not** bridged — it
> wants T3's `dropdown-glass`, which is a glass system rather than a token.
>
> **And the overlays made that system compulsory, 2026-08-09
> ([Y-166](../../tracker.md#3-task-board)).** `dropdown-glass` is not optional for `menu`, `select`
> and `combobox`, and `dialog-glass`/`dialog-backdrop` are not optional for `dialog` and `command`:
> a popup with no rule behind those class names has **no background at all**, not merely a plainer
> one. All three are now in `index.css`, along with `--glass-blur`, `--glass-opacity`,
> `--glass-saturation`, `--icon-muted`, `--secondary-label` and the two `--command-*-inset` tokens.
> T3's `.dark` selector became this repo's `prefers-color-scheme` media query, because
> [Q6](../../tracker.md#6-open-questions) ruled out a theme switcher. Tooltip's `glass` variant works
> as a side effect. **A design system replacing this file must replace the three rules too** — they
> are the first thing in `index.css` that is a surface rather than a token.

---

## 9. Work units

Sized to be picked up one at a time. **Proposed, not opened** (§B0). Each names what must be true
before it starts and what makes it done.

### Blocked on nothing

| # | Work | Done when | Touches |
| --- | --- | --- | --- |
| **D1.1** | Port T3 Code's `ui/` primitives, with the attribution file | ✅ **[Y-164](../../tracker.md#3-task-board)** and **[Y-166](../../tracker.md#3-task-board)**, 2026-08-09 — the whole take list, twenty-four files pinned to commit `963ebf5b`. Y-164 took the fifteen that need no icon; Y-166 added `lucide-react` and the seven overlays | `web/src/components/ui/`, `web/src/index.css`, `web/package.json` |
| **D1.2** | Add a router; split `App.tsx` into `/`, `/m/{machine}`, `/w/{name}` | ✅ **[Y-161](../../tracker.md#3-task-board)**, 2026-08-09 — the History API, no dependency | `web/src/App.tsx`, `web/src/routes/` |
| **D1.3** | One computed verb per workspace card (§2) | ✅ **[Y-167](../../tracker.md#3-task-board)**, 2026-08-09 — `chosen()` reads the agent state and the row draws the one button it is for; TERMINAL and EDIT stopped being columns and became overflow items | `web/src/components/Act.tsx`, `Overflow.tsx`, `columns.tsx` |
| **D1.4** | Collapse four age lines into a freshness dot and one global *as of* (§2) | the three staleness states remain distinguishable | `web/src/useLooked.ts`, `Age.tsx` |
| **D1.5** | `/w/{name}` lands in a full-height linkable terminal | the URL reopens the same pane after reload | `web/src/components/Terminal.tsx` |
| **D1.6** | Terminal fidelity tests 1–8 (§4.5) | eight tests, each named for its row, green against a real pty | `web/src/terminal.test.tsx`, `crates/yantra-core/src/pty.rs` |
| **D1.7** | ntfy relay settings in the UI (§6) | the relay URL is set from `/settings` and a test message arrives | `web/src/routes/settings`, `crates/yantrad/src/write.rs` |
| **D1.8** | Suppress Yantra's ntfy for a workspace whose `/rc` is live (§4.3) | one event produces one notification, not two | `crates/yantrad/src/notify.rs` |

### Blocked on a decision

| # | Work | Blocked on |
| --- | --- | --- |
| **D1.9** | `yantra shell <machine>` and `GET /api/machines/{m}/shell` | **ADR-0019** — what a free shell may reach (§4.4) |
| **D1.10** | The reconcile endpoint and `/launch` (§3) | the read-awaits-ssh question (§3.3) |
| **D1.11** | `yantra clone` and `POST …/clone` | decision **C**, and **B** if a workspace gains an origin |
| **D1.12** | `yantra ls repos --machine` and `/m/{m}/repos` | §3.3, and a provider CLI authenticated on that machine (see [D2](02-setup.md)) |
| **D1.13** | A second `Agent` variant (§4.2) | an **ADR-0011 amendment** |

### Blocked on a measurement

| # | Question | Settled by |
| --- | --- | --- |
| **D1.14** | Does `/rc` work in a Yantra-started tmux session on the Mac? | running `/rc` there; predicted to need a keyboard-started server (I-44, ADR-0018) |
| **D1.15** | Can the `/rc` session URL be read from the pane reliably? | matching it in a detached 80-column pane, as `agent.rs` does for the trust dialog |

### Not engineering

Provisioning and readiness moved to **[D2 — Setting a machine up](02-setup.md)**, which owns
`yantra doctor` — the probe the dashboard, the installer and the agent path all read.

**No milestone claims any of this.** GitHub integration sits under *Future Possibilities* in
[`brainstorm.md:535`](../brainstorm.md) and *Stretch Goals* in [`vision.md`](../vision.md), and M0–M10
contain nothing about a router, a repository or a clone. Creating the milestone is the owner's
(§B0).

---

## Sources

Accessed **2026-08-09**.

- [Claude Code — Remote Control](https://code.claude.com/docs/en/remote-control) — `/remote-control`
  and its `/rc` alias, `claude --remote-control` / `--rc`, `claude remote-control` server mode; the
  claude.ai subscription requirement and the refusal of API keys and `setup-token` tokens; *"Local
  process must keep running… To keep a session running on a remote machine after you disconnect from
  SSH, start it inside `tmux` or `screen`"*; *"outbound HTTPS requests only and never opens inbound
  ports"*; the session URL and QR; the `/config` push toggles and `CLAUDE_CLIENT_PRESENCE_FILE`.
- [T3 Code](https://github.com/pingdotgg/t3code) — MIT, © 2026 T3 Tools Inc. Read at commit
  `963ebf5b`, 2026-08-09. `apps/web/package.json` for the shared stack; `apps/web/src/components/ui/`
  for the primitive set; `packages/ssh/src/tunnel.ts` for `ControlMaster=no`;
  `native/resource-monitor/Cargo.toml` for `sysinfo`.

**`[V]` — measured 2026-08-09 on `cachyos-g14`:** `gh version 2.96.0`; `glab 1.109.0`; `tea` absent;
`glab auth status` reporting gitlab.com with no token and a self-hosted GitLab logged in from its
config file; `glab auth login --help` showing `--hostname`, `--api-host`, `--api-protocol`;
`glab repo list --help` showing `-F/--output text|json`, `--jq` and `-P/--per-page`.

**Yantra internal** — [R13](../research/13-dashboard-revamp-and-github.md);
[`docs/brainstorm.md`](../brainstorm.md) lines 266-302, 394-404, 535;
[`docs/design-system.md`](../design-system.md) §7; ADRs
[0004](../adr/0004-rust-for-the-daemon.md), [0007](../adr/0007-workspace-schema-v1.md),
[0010](../adr/0010-drop-branch-from-the-workspace-schema.md),
[0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md),
[0013](../adr/0013-the-heartbeat-carries-only-what-placement-scores.md),
[0014](../adr/0014-react-with-the-compiler-for-the-web-ui.md),
[0016](../adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md),
[0018](../adr/0018-the-tmux-server-carries-the-macos-login-session.md); invariants I-20, I-34, I-35,
I-36, I-43, I-44, I-49.
