# ADR-0001 — Record architecture decisions

- **Date:** 2026-07-28
- **Status:** accepted

## Context

Yantra spans nine milestones, a hardware build, and a plugin surface. Decisions made in week one
(transport, schema, runtime) will be questioned in month six, usually at 1am, usually by me, usually
after I have forgotten why. Reconstructing intent from code is expensive and unreliable.

The project also delegates research and implementation to subagents. Agents have no memory across
sessions. Without written decisions they will re-litigate settled questions or, worse, silently
contradict them.

## Decision

Use Architecture Decision Records, one file per decision, in `docs/adr/NNNN-kebab-title.md`, in
Michael Nygard's format: **Context → Decision → Consequences**.

- ADRs are numbered sequentially and never renumbered.
- An accepted ADR is immutable. To change a decision, write a new ADR that supersedes it and mark the
  old one `superseded by ADR-NNNN`.
- Every ADR is indexed in [`tracker.md`](../../tracker.md) §5.
- A decision earns an ADR if reversing it would cost more than a day, or if a reasonable person would
  choose differently.

## Consequences

- Small overhead per decision; large saving on every "why is it like this?"
- Subagents get a canonical, greppable answer to design questions instead of guessing.
- The ADR log doubles as the project's honest history, including the decisions that turned out wrong.
