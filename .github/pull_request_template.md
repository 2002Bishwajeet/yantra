<!-- Keep it short. Delete any line that does not apply. -->

**Task:** Y-NNN <!-- the tracker.md task this closes, or "none" with a reason -->

## What changed

<!-- One or two sentences. Why, not just what. -->

## How it was verified

<!--
`just check` output is the floor, not the answer.
Orchestration primitives (SSH, tmux) must be tested against a real sshd and a real
tmux inside a disposable podman container — never mocks (tracker.md §1, CLAUDE.md §B3).
Say which container/fixture ran, or say explicitly that this change touches no primitive.
-->

- [ ] `just check` passes
- [ ] Integration-tested against the real sshd + tmux fixture, or N/A because: …

## Tracker

- [ ] `tracker.md` updated — task status, Notes artifact path, session log line
- [ ] Any course change is recorded in Decisions or Open questions (not made silently)
- [ ] No accepted ADR was edited; if a decision changed, a superseding ADR is included
