# Contributing to Yantra

Yantra is a one-person project with a strong bias toward written decisions. These rules exist so that
work — mine, yours, or an agent's — stays reconstructable six months later. They are short on purpose.

## Read first

1. **[`tracker.md`](tracker.md) is the single source of truth** for project state. Read it before
   doing anything; update it when you finish. Never start work that is not represented there — add
   the task first if it is missing.
2. **The invariants** before writing any orchestration code. They live with the crate they bind —
   [`crates/*/tracker.md`](crates/) — and [`tracker.md` §1b](tracker.md) says which holds what.
   Non-obvious rules that research proved the hard way; violating one produces a bug that looks like
   something else entirely.
3. **[`docs/adr/`](docs/adr/)** holds settled decisions. **[`CLAUDE.md`](CLAUDE.md)** is the working
   agreement for AI agents and applies to humans too.

## Tasks

Task IDs are `Y-NNN`, never reused. `000–039` = M0, `040–079` = M1, then +40 per milestone. Pick a
task that is `todo` and whose dependencies are `done`; set it to `doing` with your name in Owner.

**One task = one reviewable change.** If it cannot be finished in a single sitting, split it. Never
delete a task — move it to `dropped` with a one-line reason. The graveyard is evidence.

If you learn something that changes the plan, do not silently change course: record it in the
tracker's Decisions or Open questions section and flag it.

## Branches and commits

- **Branches** — `y-030-cargo-skeleton`: the lower-cased task ID plus a short slug.
- **Commits** — a conventional-commit prefix (`feat:` `fix:` `docs:` `chore:` `ci:`), imperative mood,
  and the task ID in parentheses when one exists:
  `feat: add cargo workspace skeleton (Y-030)`. Work with no tracker task just takes the prefix.
  One format everywhere, so history stays greppable and machine-readable.
- **No AI attribution.** Commits carry **no `Co-Authored-By` naming an assistant, no "Generated
  with …", no session trailer.** Whoever pressed the button owns the change. This applies to PR
  titles and bodies too. A bot trailer is a different thing and is fine — a dependabot squash
  carries `Co-authored-by: dependabot[bot]`, and that stays.
- Small, logical commits. One giant squashed drop is not reviewable.

## Before you push

```sh
just check      # fmt --check + clippy -D warnings + nextest + deny + no-node. The gate.
just deny       # licence and advisory audit on its own, when dependencies changed
```

`just check` must pass. `-D warnings` is where the workspace clippy lints
(`unwrap_used` / `expect_used` / `panic` = warn, `unsafe_code` = forbid) actually bite.

**`no-node` is a negative assertion and it will fail on a change that looks harmless.** Nothing the
Rust gate runs may pass `--all-features` or enable `yantrad`'s `embed-dashboard`, because that
feature compiles the built dashboard in and so needs npm — R-24. Building the dashboard belongs in
`just appliance-embedded` and in `.github/workflows/embed.yml`, never in `ci.yml`.

## Verification means reality

Every orchestration primitive gets an integration test against a **real sshd and a real tmux inside a
disposable podman container** — not the host, and never mocks. Mocked SSH proves nothing; it tests
your mock. `cargo test` green against fakes does not count for anything in the transport or session
layer.

The narrow traits around SSH, tmux, telemetry and hardware exist so the layers *above* them can be
faked in tests. The traits' own implementations must be tested against the real thing.

## ADRs

A decision earns an ADR if reversing it would cost more than a day, or if a reasonable person would
choose differently. Format is Nygard — Context / Decision / Consequences — at
`docs/adr/NNNN-kebab-title.md`, numbered sequentially, never renumbered, and indexed in `tracker.md`.

**An accepted ADR is immutable and is not re-litigated.** To change a decision, write a new ADR that
supersedes it and mark the old one `superseded by ADR-NNNN`. Do not edit it, and do not quietly build
something else. Open an *ADR proposal* issue if you want the argument first.

## Research notes

`docs/research/NN-topic.md`, and they **must end with a `## Sources` section including access dates**.
Research is dated evidence, not eternal truth: a note describes the world on the day it was written.
Re-verify anything version-sensitive before relying on it. Mark claims you executed yourself as
**[V]** and claims that are documentation-only as **[D]** — the difference matters here.

## Scope

Yantra orchestrates `ssh`, `tmux`, `tailscale`, `docker` and agent CLIs — `docker` names intended
scope, not a shipped capability (Y-125). If a change starts implementing a terminal multiplexer, an
SSH client or a container runtime, stop — that is the signal the project has been misread.
**Provisioning is a permanent non-goal**: Yantra adopts machines that already exist; it never
creates, images or destroys them.

## Pull requests

Base branch is `main`. Fill in the PR template — task ID, what changed, how it was verified, whether
`tracker.md` was updated. Expect review to ask "which invariant covers this?" more often than "is
this idiomatic?".
