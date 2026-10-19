# ADR-0037 — Continue is a handoff

- **Date:** 2026-10-19
- **Status:** Proposed 2026-10-19 ([Y-519](../../tracker.md)). The owner accepts or changes it.
- **Evidence:** [the continue-elsewhere plan](../plans/continue-elsewhere.md), and
  [R22](../research/22-claude-mem-shared-memory.md) for why the summary is Yantra's own.
- **Amends** [ADR-0011](0011-claude-code-runs-as-a-tui-in-tmux.md) (a TUI may start with a prompt).
  It reads with the 2026-10-19 note in
  [ADR-0032](0032-the-appliance-keeps-the-conversation-history-encrypted.md), which replaced decision 7.

## Context

The owner wants to continue a session on another machine: *continue on the MacBook*, or *on Linux*.
On 2026-10-19 the owner ruled that the full transcript must not move, because old turns fill the
new session's context. A session has three parts that matter on the other machine: what it was
doing, the branch, and the uncommitted work. R22 found that claude-mem cannot serve one shared
memory from the appliance today, so the summary must come from Yantra.

## Decision

1. **Continue is a handoff, not a resume.** The target machine starts a fresh session. Its first
   prompt is a short handoff with five headings: goal, decisions made, files touched, what is next,
   and open questions. No transcript moves. ADR-0015 still governs *resume*.
2. **The source machine writes the handoff** with `claude -p` and its own login, from a scratch
   directory and with no tools, so the source's own conversation does not change. The owner sees
   and can edit the handoff before it is sent.
3. **The work moves as a git bundle that `yantrad` relays in memory.** The source makes a WIP commit
   through a private index under `refs/yantra/handoff/<id>` and writes a bundle of what `origin`
   lacks. `yantrad` streams it to the target over ssh and writes nothing to its own disk. Nothing is
   pushed to `origin`. Ignored files, such as `.env`, never move.
4. **The target is a workspace whose repository has the same `origin` URL.** Continue writes no
   workspace file. Git config on both branches records where the work came from and went, so a
   second run returns the same thread (§B4).
5. **A TUI started by a handoff takes the handoff as its launch prompt.** This is a launch argument,
   not keystrokes into a running pane. ADR-0015's "Yantra sends the agent no input" still holds for
   a running agent.
6. **The source must be awake**, because it writes the handoff and holds the work. A source that is
   asleep gets no offer, and the page says why.

## Consequences

- One feature works for any agent on the target, because the handoff is plain text. v1 covers
  Claude Chat threads and Claude TUI sessions. An ACP source is refused with its harness named.
- The handoff can repeat a secret the model chose to quote. The prompt forbids it, and the owner
  reads the draft before it is sent.
- The summary costs one `claude -p` turn on the source machine.
- A sleeping source cannot hand off until a later row takes the summary from the archive and the
  branch from `origin`.
- On acceptance, ADR-0011 gets a dated note that points here.
