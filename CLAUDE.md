# Yantra — working agreement for AI agents

Part A is general engineering behaviour. Part B is what is specific to this project.
Part A biases toward caution over speed; for trivial tasks, use judgement.

---

# Part A — Behaviour

## 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or configurability that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask: *"Would a senior engineer call this overcomplicated?"* If yes, simplify.

> **Yantra caveat.** Exactly one abstraction is mandated in advance, and it is not speculative:
> SSH, tmux, telemetry and hardware each sit behind a narrow interface (§B2). That is a paid-for
> decision with a written rationale, not flexibility-for-its-own-sake. Everything else obeys this rule.

## 3. Surgical changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that *your* changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the request.

## 4. Goal-driven execution

**Define success criteria. Loop until verified.**

Turn tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

Strong criteria let you loop independently. Weak criteria ("make it work") force constant
clarification. In this project, "verify" means what §B3 says it means.

## 5. Comment sparingly

**Comment only what the code cannot say. One or two lines, never more.**

- Explain **why**, never **what**. If a comment restates the line below it, delete it.
- No banner comments, no section dividers, no ceremony around obvious code.
- Good reasons to comment: a non-obvious invariant, a workaround for someone else's bug, a
  deliberate choice that looks wrong (`// I-21: pane targets must use %id, not =name`).
- Doc comments on public items follow the same rule — say what a caller cannot infer from the
  signature, then stop.

If a block needs a paragraph to explain it, the block is wrong. Fix the code, not the comment.

---

# Part B — Yantra

## B0. Read this first

1. **[`tracker.md`](tracker.md) is the source of truth for project state.** Read it before doing
   anything; update it when you finish. Never start work that isn't represented there — add the task
   first if it's missing. It holds milestones, open tasks, decisions, questions and risks; closed
   tasks are in [`docs/archive/`](docs/archive/) and the session log is
   [`docs/session-log.md`](docs/session-log.md).
2. **[`docs/adr/`](docs/adr/) holds settled decisions.** Do not re-litigate an accepted ADR. If you
   think one is wrong, say so and propose a superseding ADR (that is §A1 applied) — do not quietly
   build something else.
3. **Each crate has its own [`CLAUDE.md`](crates/), `tracker.md`, `llms.txt` and `README.md`.** Read
   the ones for the crate you are changing — the root documents are the map, not the territory, and
   the crate files hold the rules that actually bind the code in front of you. **The invariants live
   in the crate trackers**, not in the root one. [`llms.txt`](llms.txt) at the root indexes
   everything.
4. **[`docs/development.md`](docs/development.md) is the local setup + daily-command reference.**
5. **[`docs/research/`](docs/research/) holds dated evidence.** Notes reflect the world on their
   access date. Re-verify anything version-sensitive before relying on it.

## B1. Runtime

**Rust** for the daemon (`yantrad`), the CLI (`yantra`), and the per-machine agent (`yantra-agent`).
**TypeScript** for the web UI only. See [ADR-0004](docs/adr/0004-rust-for-the-daemon.md).

Stack: `tokio` · `axum` (HTTP + WebSocket) · `tokio::process` (spawning `ssh`, `tmux`, `tailscale`) ·
`portable-pty` · `serde`. Appliance target `aarch64-unknown-linux-musl` via `cargo-zigbuild`.
**The daemon persists nothing.** The `rusqlite` row in that ADR's stack table was never built (Y-044);
see its 2026-08-02 amendment.

**Rust is the whole control plane, not a component of it.** Do not introduce a second runtime into
the daemon, the CLI or the agent. TypeScript's only home is the browser.

**In the browser, reach for the battle-tested package first; write it yourself only where the package
is not worth its cost.** Owner's instruction, 2026-08-09, and it inverts §A2's default *for `web/`
only*: routing, caching, and UI primitives are solved problems with maintained implementations, and a
hand-rolled version is a maintenance liability rather than a saving. The dashboard is meant to be
**fast and genuinely useful**, and that is what the packages buy — TanStack Router's code splitting
took the first load from 170 kB gzip to 111 kB in the change that introduced it (Y-162). This does
**not** relax §B1's first paragraph or §B2: the daemon, the CLI and the agent are unaffected, and
`ssh`/`tmux`/`tailscale` are still orchestrated rather than reimplemented.

**Rust punishes design churn**, and M0–M1 is where the design is least settled. Prefer a working ugly
path over an elegant abstraction. Resist generalising before the third use.

## B2. Orchestrate, don't reinvent

Yantra coordinates `ssh`, `tmux`, `tailscale`, `docker`, and agent CLIs — `docker` names intended
scope, not a shipped capability (Y-125). If your design starts implementing a terminal multiplexer,
an SSH client, or a container runtime, **stop** — that is the signal you have misread the project.

Concretely: transport is the **system `ssh` binary** with `ControlMaster` multiplexing (I-20), not
`russh`. Keep SSH, tmux, telemetry and hardware behind narrow traits — these are the four seams where
Yantra meets an unreliable outside world, and they must be fakeable in tests.

## B3. Verification means reality

Orchestration primitives get integration tests against a **real** sshd and a **real** tmux, running in
a **disposable podman container** — not the host. Mocked SSH proves nothing; it tests your mock. The
container is also a truer stand-in for a remote machine than `ssh localhost` (separate filesystem, user
and network hop) and leaves nothing running on the developer's box.

`cargo test` passing against fakes does not satisfy §A4 for anything in the transport or session layer.
Note the split: the narrow traits from B2 exist so the *layers above* can be tested with fakes; the
traits' own implementations must be tested against the real thing.

## B4. Hard requirements

- **Idempotency.** `yantra up X` twice must attach, not duplicate. Design it in; don't bolt it on.
- **Never store secrets.** Workspaces hold *references* (1Password/pass/sops), never values.
- **Start small.** Prefer the smallest thing that runs end to end. This project's failure mode is a
  beautiful architecture that never boots — see the walking-skeleton milestone in `tracker.md`.

## B5. Conventions

- **Read the invariants for the crate you are changing before writing orchestration code** —
  [`crates/yantra-core/tracker.md`](crates/yantra-core/tracker.md) holds most of them, and
  `tracker.md §1b` says where the rest are. They are rules research proved the hard way; violating
  one produces a bug that looks like something else.
- **Commits carry no AI attribution — no `Co-Authored-By` naming an assistant, no "Generated with",
  no session trailer.** The repo owner set this rule explicitly. Plain, professional messages only.
  **A bot trailer is not AI attribution** (owner, 2026-08-03): GitHub's squash merge lifts
  `Co-authored-by: dependabot[bot]` out of the PR body, and it stays. The rule is about what is
  claimed to have written the code, not about the trailer as a form — so an audit greps for the
  assistant, not for `Co-Authored-By`.
- Task IDs `Y-NNN` from `tracker.md`. Commits: `Y-030: add cargo workspace skeleton`.
  Branches: `y-030-cargo-skeleton`. One branch per issue, one PR per branch. **`Y-2xx` is reserved
  for the landing page**, which keeps its own tracker on its own branch — it has taken a number this
  repo had already used three times, and the cost is two rows in two files claiming one identifier,
  so a commit message stops saying which work it belongs to.
- ADRs: `docs/adr/NNNN-kebab-title.md`, Nygard format (Context / Decision / Consequences),
  immutable once accepted. **Immutable does not mean untouchable**: when a premise behind an accepted
  ADR stops holding, append a **dated blockquote** naming the date and the task, and leave the
  original text in place — see the amendments in [ADR-0006](docs/adr/0006-ssh-exec-transport.md) and
  [ADR-0004](docs/adr/0004-rust-for-the-daemon.md). Say what changed *upstream* of the reasoning
  rather than implying the reasoning was wrong. Supersede only when the decision itself is wrong.
- Research notes: `docs/research/NN-topic.md`, must end with `## Sources` including access dates.
- Paths: config at `~/.config/yantra/`, CLI `yantra`, daemon `yantrad`.
- **A summary is updated by the change it summarises, in the same PR.** This file,
  [`llms.txt`](llms.txt), `README.md` and every crate's `CLAUDE.md`/`llms.txt`/`README.md` restate
  things owned elsewhere, so they go stale with nobody editing them and nothing failing. Y-080 spent
  a session on a research index that had drifted twice; on 2026-08-02 `llms.txt` was found counting
  eleven ADRs against fourteen and 47 invariants against 48. **Prefer a link over a restatement** —
  a link that stops resolving is a broken build, a copied fact is a reader's problem — and when a
  count or a name must be restated, treat changing it as part of the work, not as tidying up
  afterwards.
- **A `tracker.md` row says what to do and what *done* means, and stops.** The reasoning goes in the
  PR, the commit, an ADR or a research note, and the row links it — the rule above, applied to rows.
  Owner's ask, 2026-08-08: rows had grown into multi-sentence prose, and §B0 has every session read
  `tracker.md` first, so its size is a cost every task pays before it starts. The file already cannot
  be opened without targeted line offsets.
- **Prune closed rows into [`docs/archive/`](docs/archive/) as they accumulate**, not only when a
  milestone closes — one file per milestone, whose header records what moved and what deliberately
  stayed behind.
- **A milestone does not close until the whole-system documents say what shipped.**
  [`docs/architecture.md`](docs/architecture.md), the root [`README.md`](README.md) and
  [`llms.txt`](llms.txt) describe *state* rather than a change, so the rule above never catches them —
  no one PR makes them wrong. Sweep them when a milestone row goes ✅: architecture.md still called
  `yantrad` a health-check server three milestones after it stopped being one.
- **A new instruction from the owner lands in the file that binds it, not only in the reply.** If it
  is how work is done it belongs here or in the crate's `CLAUDE.md`; if it is what to build it is a
  `tracker.md` row; if it is a decision it is an ADR. An instruction that lives only in a
  conversation is one the next session does not have.

## B6. If you are a research subagent

Return evidence, not opinions dressed as evidence. Verify against current official docs with
WebSearch/WebFetch — do not answer from memory for anything version-sensitive. **Report negative
findings loudly**: *"this does not work the way everyone assumes"* is the most valuable sentence you
can write. Always include exact commands, flags, JSON shapes, and file paths — those are what the
implementation actually needs.
