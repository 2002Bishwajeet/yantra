# ADR-0010 — `branch` is dropped from the workspace schema

- **Date:** 2026-07-30
- **Status:** accepted
- **Amends:** [ADR-0007](0007-workspace-schema-v1.md) — the `branch` field only. Filename-as-identity,
  `deny_unknown_fields`, name validation, the `OnDisk`/`Workspace` split and the provisioning
  non-goal all stand unchanged.

## Context

ADR-0007 put four keys on disk. Three of them do something. `branch` was parsed into
`Workspace::branch`, asserted on by two parse tests, and read by nothing — for the whole of M1 and
M2. The ADR describes it as *"optional — omitted leaves the tree alone"*, which says plainly that a
value present does not leave the tree alone. Nothing ever checked anything out.

That is a documentation defect rather than a runtime one: an ignored field has never broken a run.
But it is the same species as the contradiction [ADR-0009](0009-machine-names-are-ssh-destinations.md)
closed, where `workspace.rs` documented `machine` as an alias that Y-041 would resolve while `up.rs`
passed it to `ssh` verbatim. Two files describing one field two ways, shipped. It was left open
through M1 (tracked as Y-047) because switching branches under a dirty worktree is destructive and
the semantics looked like a real decision.

Two things settle it, and neither is the refuse/stash/warn question the tracker recorded.

**The question is *when*, not *what*.** `up` returns `Created` or `Attached`. Changing the branch
under an `Attached` session changes the tree beneath whatever is already running in it — in M3 that
is a live agent process. So a checkout could only ever happen at creation, where the tree is not yet
in use and most of the dirty-worktree problem does not arise.

**Checkout semantics break what M3 is for.** Nothing stops two workspaces naming the same `repo` on
the same `machine`. One directory holds one branch, so under `git checkout` those two workspaces
fight: whichever opened last wins, and the other's agent is now on the wrong tree. M3 makes exactly
that case ordinary — one agent per feature, one clone. `git worktree` does not have the problem,
because each workspace gets its own directory.

So the honest options were to implement checkout semantics that M3 would replace, to implement
worktrees now on a guess about what M3 needs, or to stop claiming something untrue.

## Decision

**Remove `branch` from the schema, from `Workspace`, and from `OnDisk`.**

Schema v1.1 is three keys:

```toml
machine = "pi"          # required — an ssh destination (ADR-0009)
repo    = "/path/on/machine"
startup = "claude"      # optional — omitted means just a shell
```

A file that still carries `branch` now **fails to load**, loudly, because `deny_unknown_fields` is
part of ADR-0007 and stays. That is deliberate and consistent: ADR-0007's own reasoning is that
silently ignoring a key produces "a workspace that opens correctly and does nothing, which is the
worst kind of bug". Accepting `branch` and ignoring it *is* that bug; the fix is to stop accepting
it, not to ignore it more politely.

Branch selection returns when M3 says what it needs, and it returns as **worktrees** rather than
checkouts — a design this ADR does not settle, only points at.

## Consequences

**Gained**

- Schema and behaviour agree. Every key on disk now does something.
- Nothing is built that M3 is likely to replace.
- The remaining question is stated where it will be found, instead of living as a field that looks
  implemented.

**Cost**

- A workspace file carrying `branch` breaks rather than being ignored. The migration is deleting one
  line. There were no workspace files on disk when this was decided, so the real cost was zero.
- `branch` is a natural thing to reach for, so its absence will be noticed before its replacement
  exists. The error names the field, which is the whole of the remedy available today.

**Not decided here**

- Whether worktrees are the right model, where they live on disk, and what `repo` then means. That
  needs M3's actual requirements, and it amends more of ADR-0007 than this does.
