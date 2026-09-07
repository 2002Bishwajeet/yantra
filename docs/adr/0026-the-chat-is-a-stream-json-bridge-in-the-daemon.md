# ADR-0026 — The chat is a stream-json bridge in the daemon, drawn in Material, on T3 Code's vocabulary

- **Date:** 2026-09-07
- **Status:** accepted (Y-356), 2026-09-07, on the condition in decision 8. The owner accepted it
  that day, and set the condition with the acceptance.
- **Evidence:** [R15](../research/15-t3code-for-the-chat.md), read on a shallow clone of
  `pingdotgg/t3code` at `b248f5a`, 2026-09-07.
- **Read against:** [ADR-0011](0011-claude-code-runs-as-a-tui-in-tmux.md) (the agent is a TUI),
  [ADR-0004](0004-rust-for-the-daemon.md) (Rust is the whole control plane),
  [ADR-0022](0022-a-socket-may-address-a-session-rather-than-a-workspace.md) (the socket's address),
  [ADR-0023](0023-the-github-grant-lives-beside-the-relay.md) (where a grant lives),
  [ADR-0024](0024-the-dashboard-is-material-3-built-by-hand.md) (the components and the budget).

## Context

Y-356's row asks for "an ADR that decides the SDK against the TUI in tmux". **R15 shows that is not a
choice.** The TypeScript Agent SDK spawns the `claude` binary as a subprocess — T3 Code keeps a whole
file to find it (`ClaudeExecutable.ts`, naming `pathToClaudeCodeExecutable`), and Anthropic's own
documentation says the SDK ships for Python and TypeScript only and that another language should
"run the CLI as a subprocess with the `-p` flag". The SDK is a typed Node client for a subprocess
protocol, so choosing it means choosing Node on the far side, not a different agent.

The real options are three.

1. **`yantrad` spawns `claude -p --output-format stream-json --verbose --include-partial-messages`
   over the ssh transport it already has, and relays the events to the browser.** This is what the
   SDK does underneath, minus Node. `Exec` already spawns over ssh, `terminal.rs` already serves a
   WebSocket, and [`logs.rs`](../../crates/yantra-core/src/logs.rs) already parses the agent's JSONL.
2. **Keep the TUI in tmux and read the pane.** What ships today, under ADR-0011. The transcript is
   polled 50 lines at a time and the permission dialog is a regex over a redraw stream —
   [`web/src/screens/session/pane.ts`](../../web/src/screens/session/pane.ts) strips ANSI, finds a
   line ending in `?`, and types a number back. It streams nothing.
3. **Run T3 Code's Node server on each machine.** ADR-0004 forbids a second runtime in the daemon,
   the CLI or the agent, and R15 §Architecture shows the server carries SQLite, 64 migrations and an
   event-sourced engine. Adopting it is a different product decision, and it would be its own ADR.

**The owner's instruction of 2026-09-07 was to use what T3 Code has and to attribute them.** R15
answers what that can mean. Their UI does not lift: `ChatView.tsx` is 8,403 lines with 158 imports,
the composer is 5,602 lines on Lexical, the timeline is 3,364 lines on `@legendapp/list`, every file
is typed against `@t3tools/contracts`, Effect is the backbone on both sides, and the Tailwind classes
name shadcn tokens ADR-0024 deleted. Each of those dependencies alone breaks ADR-0024 §7's 145 KiB
first load — `effect` unpacks to 27 MB, `@pierre/diffs` to 7.4 MB, `lexical` to 3.5 MB. **Their
contracts do lift, as design.** `packages/contracts/src/providerRuntime.ts` is one canonical event
union that six agent CLIs are normalised into, with sixteen tool item types, `content.delta`,
`request.opened` / `request.resolved` and a `CanonicalRequestType` list. It is Effect `Schema` and
cannot cross into Rust as code; the vocabulary costs nothing to adopt and is the part that took them
months. Their MIT licence permits both, and their own `apps/web/src/vendor/` shows the attribution
pattern: a file-top block comment naming the upstream project, its URL and the licence text.

## Decision

**Option 1. The chat is a `stream-json` bridge that `yantrad` owns, over the ssh transport, on an
event model re-expressed in Rust from T3 Code's, drawn in `web/src/m3/`.**

**1. `yantra-core` owns a provider-neutral event model, written in Rust from `providerRuntime.ts`'s
vocabulary.** Seven families, and their names are theirs: **content deltas** (`content.delta`, with
its stream kind and content index), **tool items** carrying a canonical item type from one closed
list, **permission requests** (`request.opened` / `request.resolved`) carrying a request type, a
detail, and typed options rather than a number scraped off a screen, **plan updates**, **token
usage**, **turn lifecycle**, and **thread lifecycle**. Yantra normalises one provider today; the
union is provider-neutral because that is what makes the browser's cards independent of the CLI's
output, not because a second agent is planned.

**2. A turn is one `claude -p` process, and `--resume <session-id>` continues the conversation.**
R15's sources verify `--output-format stream-json`, `--include-partial-messages`, `--verbose`,
`--resume <id>` and `--permission-mode` in the headless documentation. They do **not** verify
`--input-format stream-json` or the control channel that would carry a permission answer into a
running turn; R15 names it in prose and stops there. So the per-turn process is what is decided, and
the long-lived bidirectional session is the upgrade this ADR does not take.

**3. The events reach the browser on a socket beside the terminal socket**, in ADR-0022's shape:
`GET /api/workspaces/{name}/chat`, and the session-addressed form where a session is reachable
without a workspace. It carries JSON events rather than bytes, and it is a `GET` upgrade, so
`terminal.rs`'s call to `allowed()` is the pattern — ADR-0016's predicate on ADR-0017's address,
unchanged. Q5's rule holds: the socket's lifecycle is logged and its content never is.

**4. The browser draws it with `web/src/m3/`, and no T3 Code UI code is copied.** The timeline, the
tool cards, the permission card and the composer are ours, on Base UI and the tokens, tested the way
ADR-0024 §6 requires. `react-markdown` with `remark-gfm` and `rehype-sanitize` is the one dependency
choice taken from them, at about 95 KB unpacked, and it is measured against the budget before it
lands.

**5. Attribution is a notice file and a block comment.** `THIRD_PARTY_NOTICES.md` at the repository
root carries T3 Code's MIT text and its `Copyright (c) 2026 T3 Tools Inc.` line. Every file whose
shape derives from theirs opens with a block comment naming the upstream path
(`https://github.com/pingdotgg/t3code/blob/main/<path>`) and the licence, which is their own
precedent. **No name, no wordmark, no icon** — brand is not in the grant.

**6. The tmux session stays, and the two surfaces do not meet.** ADR-0011 is not superseded. `up`
still opens the session and launches the TUI, the Terminal tab still attaches to it through the
terminal socket, and a person can still take the session over from any machine — which is the reason
ADR-0011 refused headless in the first place. The chat's `claude -p` runs beside that session over
its own ssh command; it never types into the pane, so `send-keys` and I-21's pane-addressing trap
stay out of this path. **I-22 is satisfied by intent rather than avoided**: it forbids piping an
*interactive* agent's stdout because that destroys TTY detection and drops the agent into `--print`.
Here `--print` is what is asked for, and no interactive process is piped.

**7. The grant does not move.** The agent authenticates with the machine's own `claude` login, as it
does today. ADR-0023's file holds the daemon's own credentials and gains nothing here; nothing is
sent from the appliance to a machine.

**8. The chat turn and the TUI must never write one working tree, and nothing is built until that
interlock is decided.** This is a hard precondition on Y-356, not a caveat: **no code for this ADR
lands until an amendment here picks one of the three mechanisms below.**
[Y-359](../../tracker.md#3-task-board) is that work, and Y-356 depends on it. Decision 6 says the two
surfaces do not meet. That is true of the pane and false of the working tree, which is the case this
decision covers.

**Refuse.** `yantrad` declines a chat turn while the workspace's machine still holds its tmux
session. The mechanism exists already, for a different write: `edit::ensure_free` refuses a machine
move on what `Tmux::pane` answers ([`edit.rs:91`](../../crates/yantra-core/src/edit.rs),
[`tmux.rs:339`](../../crates/yantra-core/src/tmux.rs)). It has to ask the machine rather than read
the snapshot, which the daemon refreshes every 30 s
([`refresh.rs:25`](../../crates/yantrad/src/refresh.rs)). **The cost is the thing the chat was for.**
`up` leaves the session open and ADR-0011 keeps it attachable, so a live session is the normal state,
and the chat would refuse nearly every time the owner opens it.

**Isolate.** The turn runs in its own `git worktree` for that workspace, so the two agents write
different trees. **A workspace names exactly one path today.** `Workspace::repo` is a single
`PathBuf` ([`workspace.rs:29`](../../crates/yantra-core/src/workspace.rs)), and every caller passes
it verbatim: `up` cds into it ([`up.rs:120` and `:163`](../../crates/yantra-core/src/up.rs)),
`resume` does the same ([`resume.rs:165`](../../crates/yantra-core/src/resume.rs)), `logs` derives
the transcript path from it ([`logs.rs:144`](../../crates/yantra-core/src/logs.rs)), `tokens` sums
spend under it ([`tokens.rs:112`](../../crates/yantra-core/src/tokens.rs)), and `status` reports it
([`status.rs:246`](../../crates/yantra-core/src/status.rs)). A second tree means the chat's directory
is no longer the workspace's `repo`, so the transcript path, the spend figure and the agent registry
all answer about a directory the Terminal tab is not in. It also costs disk and a lifecycle: who
makes the worktree, who prunes it, which branch it holds, and what happens to work a turn leaves
uncommitted.

**Serialize.** A per-workspace lock in `yantrad` gives the tree to one agent at a time. **The daemon
cannot see whether the TUI is mid-edit.** It reads a pane and the agent registry, and it has a named
verdict for those two disagreeing rather than an answer — `Verdict::Unclear`
([`status.rs:68`](../../crates/yantra-core/src/status.rs)), for which `is_running` is deliberately
false ([`status.rs:76`](../../crates/yantra-core/src/status.rs)). A lock released on that reading is
released on a guess. **The lock also binds one caller only.**
[ADR-0012](0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md) keeps `yantra` calling
`yantra_core` in-process with no daemon running, and a person typing in the pane is outside both.

**The order above is not a preference, and this ADR picks none of the three.** The owner picks when
Y-359 is planned. Refuse is the cheapest and the least useful; isolate is the most work and the only
one that lets both surfaces run at once; serialize is cheap to write and hard to make correct.

**What would settle it.** Three measurements, and the first belongs to the owner rather than to a
test. **How often the session is live when the owner wants to chat** — if it almost always is,
Refuse is unusable and the choice is between the other two. **Whether `claude` behaves in a
worktree** — whether `--resume <id>` continues a thread that started in the main tree, and where the
transcript lands when the cwd is the worktree. §B3's podman fixture answers that one with a real
`claude`. **What a worktree per workspace costs on this fleet's disks**, measured rather than
assumed.

## Consequences

**What it buys.** The features R15 lists stop being unreachable: streaming text instead of a 50-line
poll, tool calls as typed items instead of transcript prose, a permission prompt that arrives as a
request with options instead of a regex over a redraw, plan updates, and token usage on the same
stream as the text. The pane regex in `pane.ts` is deleted with the surface it serves. ADR-0011's
own recorded cost — *"no structured events"* — is paid off for the chat without giving up the
attachable session it bought.

**What it costs.** A Rust event model and a bridge in `yantra-core`, an ssh process lifecycle the
daemon has not had before (a turn that is cancelled, a socket that closes mid-turn, a machine that
goes away), a second WebSocket route with its own authorisation test, the chat UI rebuilt on the
new stream, and a budget line for whatever the markdown renderer weighs. **A `claude -p` turn is a
second agent process on the machine**, running beside the TUI in the same repository; decision 8
holds the whole build until the interlock between the two is decided. It also widens
ADR-0022's blast radius by one route, on the same single authoriser that ADR-0022's Consequences
already names as the whole of the protection.

**What it does not do.** No Node reaches any machine. No T3 Code server, no `@t3tools/contracts`, no
Effect, no Lexical, no `@legendapp/list`, no diff panel. It does not supersede ADR-0011, does not
touch the workspace schema, and buys none of T3 Code's fourteen features for free — every card, the
timeline and the composer are written here, in Material, at Yantra's pace.

**What to verify.** §B3 applies to the bridge itself: a **real `claude` on a real machine in the
podman fixture**, asserting that `-p --output-format stream-json --include-partial-messages` emits
partial deltas, that `--resume <id>` continues the thread, and — the open question in decision 2 —
whether a permission request can be answered on the process's stdin. If it cannot, the fallback is
`--permission-mode` chosen per turn from the composer, which is coarser and still typed. The browser
is verified against a fixture scenario that replays a recorded event stream, so the chat's states are
drawn and tested without a fleet.

### Not decided here

- **Whether the chat ever becomes a long-lived `--input-format stream-json` session.** Decision 2's
  verification is what settles it.
- **Whether a second agent CLI is ever normalised into this union.** The vocabulary allows it; no row
  asks for it.
- **The diff surface.** T3 Code has one, Yantra has no row for one.
