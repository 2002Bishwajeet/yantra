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

---

# Part B — Yantra

## B0. Read this first

1. **[`tracker.md`](tracker.md) is the source of truth for project state.** Read it before doing
   anything; update it when you finish. Never start work that isn't represented there — add the task
   first if it's missing.
2. **[`docs/adr/`](docs/adr/) holds settled decisions.** Do not re-litigate an accepted ADR. If you
   think one is wrong, say so and propose a superseding ADR (that is §A1 applied) — do not quietly
   build something else.
3. **[`docs/development.md`](docs/development.md) is the local setup + daily-command reference.**
4. **[`docs/research/`](docs/research/) holds dated evidence.** Notes reflect the world on their
   access date. Re-verify anything version-sensitive before relying on it.

## B1. Runtime

**Rust** for the daemon (`yantrad`), the CLI (`yantra`), and the per-machine agent (`yantra-agent`).
**TypeScript** for the web UI only. See [ADR-0004](docs/adr/0004-rust-for-the-daemon.md).

Stack: `tokio` · `axum` (HTTP + WebSocket) · `tokio::process` (spawning `ssh`, `tmux`, `tailscale`) ·
`rusqlite` · `portable-pty` · `serde`. Appliance target `aarch64-unknown-linux-musl` via `cargo-zigbuild`.

**ADR-0003 (TypeScript on Bun) is superseded.** Do not reintroduce Bun, Node, `bun:sqlite`, or
`Bun.Terminal` into the daemon. Research notes 06/06a/06b/06c were written against the Bun target and
are retained as **historical evidence only** — their tmux, Tailscale, agent-CLI, prior-art and
scheduling findings remain valid; their runtime recommendations do not.

**Rust punishes design churn**, and M0–M1 is where the design is least settled. Prefer a working ugly
path over an elegant abstraction. Resist generalising before the third use.

## B2. Orchestrate, don't reinvent

Yantra coordinates `ssh`, `tmux`, `tailscale`, `docker`, and agent CLIs. If your design starts
implementing a terminal multiplexer, an SSH client, or a container runtime, **stop** — that is the
signal you have misread the project.

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

- **Read `tracker.md` §1b (Invariants) before writing orchestration code.** Twenty non-obvious rules
  that research proved the hard way; violating one produces a bug that looks like something else.
- **Commits carry no co-author, "Generated with", or AI-attribution trailers of any kind.** The repo
  owner set this rule explicitly. Plain, professional messages only.
- Task IDs `Y-NNN` from `tracker.md`. Commits: `Y-030: add cargo workspace skeleton`.
  Branches: `y-030-cargo-skeleton`. One branch per issue, one PR per branch.
- ADRs: `docs/adr/NNNN-kebab-title.md`, Nygard format (Context / Decision / Consequences),
  immutable once accepted.
- Research notes: `docs/research/NN-topic.md`, must end with `## Sources` including access dates.
- Paths: config at `~/.config/yantra/`, CLI `yantra`, daemon `yantrad`.

## B6. If you are a research subagent

Return evidence, not opinions dressed as evidence. Verify against current official docs with
WebSearch/WebFetch — do not answer from memory for anything version-sensitive. **Report negative
findings loudly**: *"this does not work the way everyone assumes"* is the most valuable sentence you
can write. Always include exact commands, flags, JSON shapes, and file paths — those are what the
implementation actually needs.
