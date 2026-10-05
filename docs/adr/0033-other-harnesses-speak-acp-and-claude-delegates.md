# ADR-0033 — Other agent harnesses speak ACP, and Claude delegates work to them

- **Date:** 2026-10-05
- **Status:** Accepted 2026-10-05. The owner chose to leave Claude out of ACP that day
  ([Y-428](../../tracker.md)).
- **Evidence:** [R19](../research/19-acp-for-every-harness.md), 2026-10-05.
- **Extends** [ADR-0026](0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md): its event model
  gains a second source. Its decisions for Claude stand unchanged.
- **Reads against** [ADR-0011](0011-claude-code-runs-as-a-tui-in-tmux.md) (the session lives in
  tmux), [ADR-0015](0015-resume-forks-the-conversation.md) (resume forks) and
  [ADR-0004](0004-rust-for-the-daemon.md) (Rust is the whole control plane).

## Context

The owner wants two things. First, a main agent hands work to Codex, Gemini, Grok or opencode, and
each one works in its own harness with its own tools and login. Second, the Chat tab is on par with
T3 Code for every harness, not only for Claude Code.

Yantra must not invent a protocol for this (CLAUDE.md §B2). The Agent Client Protocol (ACP) already
exists. R19 started all five harnesses over ssh stdio on the QA VM, and each one answered
`initialize`. Gemini, opencode and Grok speak ACP natively. Codex and Claude Code need an adapter.

R19 found three limits:

1. **The Claude adapter is built on the Agent SDK.** Anthropic's page says a third-party tool built
   on the Agent SDK may not offer the claude.ai login. The owner uses that login.
2. **A dropped connection cancels the running turn.** `session/load` restores the history, but the
   work in progress is lost. ACP has no detach.
3. **No existing tool lets one agent start another on a different machine in its own worktree.**
   `codex mcp-server` was removed on 2026-09-05.

T3 Code splits its harnesses the same way as this ADR. It uses its own adapter for Claude and ACP
for the others.

## Decision

1. **Claude Code stays on the ADR-0026 bridge and is the main agent.** It runs the real `claude`
   binary with the machine's own login. It plans the work, delegates it and reviews the result.
   Claude does not go through ACP.
2. **`yantrad` is an ACP client for every other harness.** It starts the agent with
   `ssh <machine> <acp command>` over the system ssh transport (I-20). The launch commands are in
   R19 §1. It speaks ACP v1 and keeps `session/load`, the prompt result and the diff shape behind
   one module, because ACP v2 changes those three.
3. **ACP events map into ADR-0026's event model.** The Chat tab draws one timeline for every
   harness, with no per-harness code in the browser.
4. **A delegated task runs in its own git worktree on the target machine.** `yantrad` creates the
   worktree before it starts the agent. So a delegate never shares a working tree with the TUI or
   with another agent. This answers ADR-0026 decision 8 for delegates by construction.
5. **The main agent delegates through an MCP tool in the `yantra` CLI.** `yantra mcp` runs as a
   stdio MCP server and calls `yantrad`. Its tools start a task on a machine and harness, read its
   state and result, and stop it. The result is the agent's last message and the worktree's diff
   summary. Claude reviews the diff and decides what merges.
6. **Each harness keeps its own login on its machine.** The appliance sends no credential to a
   machine (ADR-0026 decision 7). When an agent answers "Authentication required", the Chat shows
   that state and names the command to run on that machine.
7. **A dropped connection cancels the turn, and v1 accepts that.** The link that matters runs from
   the appliance to the machine over Tailscale, not from the browser. On reconnect, `session/load`
   restores the history, and the main agent can send the task again. A keeper process that holds
   the agent past a drop (R19 §6, option B) is priced only if this proves too weak.
8. **The Terminal tab and ADR-0011 are unchanged.** A person still opens any harness in tmux by
   hand.

## Consequences

**Gained.** One protocol for four harnesses, with no protocol of Yantra's own. One chat timeline
for every harness. Delegation to any harness on any machine, isolated in a worktree, with the main
agent as reviewer. The owner's Max login stays with the real `claude` binary.

**Cost: two relays in the daemon.** The Claude bridge and the ACP client both feed one event model.
T3 Code pays the same cost.

**Cost: an adapter ships its own harness.** The Codex adapter bundles its own `codex` and ignores
the machine's copy (R19 §1), so two versions can exist on one machine.

**Cost: memory on the fleet machine.** An idle ACP agent took 133 to 446 MB on x86-64, before
login for three of them (R19 §6). The appliance pays about 11 MB of ssh client for each one.

**Cost: a delegate's worktree must be cleaned up.** The task's stop and the main agent's review must
remove it, or worktrees fill the disk.

**Not yet measured.** A full turn on Codex, Gemini or Grok, because no login existed in R19. Every
figure on arm64. Grok takes no images.
