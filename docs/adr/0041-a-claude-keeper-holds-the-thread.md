# ADR-0041 — A Claude keeper holds the thread, not the turn

- **Date:** 2026-11-08
- **Status:** Proposed ([Y-657](../../tracker.md)). The owner accepts or changes it.
- **Evidence:** T3 Code at commit `67eebaca` (2026-11-05), read at `~/Github/t3code-ref`:
  `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`,
  `apps/server/src/orchestration-v2/ProviderSessionManager.ts`, and the fixtures under
  `apps/server/src/orchestration-v2/testkit/fixtures/claude_background_*`. The owner's live QA on
  2026-11-08, below.
- **Amends** [ADR-0035](0035-a-chat-turn-outlives-its-ssh-pipe.md) decisions 3, 4 and 12, and
  [ADR-0026](0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md) decision 2. Each gets a dated
  blockquote when this ADR is accepted.
- **Reads against** [ADR-0033](0033-other-harnesses-speak-acp-and-claude-delegates.md) decision 2
  (an ACP agent lives across turns), I-22 (no tty) and Q5 (no prompt or reply in a log).

## Context

On 2026-11-08 the owner ran the build loop from the Chat on the phone. Claude started a background
workflow and a background agent. Both died twice, during triage, and nothing landed.

The cause is decision 3 of ADR-0035: **a Claude keeper holds one turn.** `yantrad` closes Claude's
stdin after the `result` line, Claude exits, and the keeper ends. Every background Bash command,
Monitor, subagent and workflow that the turn started dies with the process. Nothing tells the owner.
The next message starts a new `claude -p --resume`, which reports that the work "did not finish
before the previous session ended".

T3 Code does the opposite:

1. **One Claude process for each thread, across turns.** T3 uses the Agent SDK with streaming input.
   The SDK runs the same `claude` binary with `--input-format stream-json`, and the process stays
   open while the thread is in use.
2. **It tracks background work.** Claude sends `system` / `background_tasks_changed`. T3 keeps a
   roster of pending background tasks and shows it as *Waiting*.
3. **Background work wakes the thread.** When a background task ends, Claude starts a turn with no
   user message. T3 shows it as a new run (fixture `claude_background_task_wake`).
4. **It protects background work.** A model or setting change that needs a new process is refused
   while background work runs, with the words *wait for them to finish, or press Stop*.
5. **It closes idle sessions.** The default is 30 minutes with no turn. Background work pins the
   session open for at most 4 hours (`DEFAULT_MAX_IDLE_PIN_MS`).

ADR-0035 already has what T3 lacks: the process lives in tmux on the machine, so it survives a
dropped ssh pipe and a restart of the daemon. The ACP keeper already lives across turns. Only Claude
was left at one turn.

## Decision

**A Claude keeper holds the thread's Claude process across turns, as an ACP keeper does. It ends when
the thread is idle and no background work runs.**

1. **One `claude` for each thread.** The keeper starts `claude -p --input-format stream-json
   --output-format stream-json` with `--resume` once. Each turn appends a user message to `in`.
   `yantrad` does not close stdin after a `result`.
2. **`yantrad` tracks background work** from `background_tasks_changed` and from each task's start
   and end events. The thread carries the count, and the Chat shows *Waiting on N background tasks*.
3. **A wake turn is a turn.** A turn that Claude starts with no user message gets the next turn
   number, a checkpoint and a diff, as any other turn does. When no socket is attached, `yantrad`
   sends one ntfy notification in the Y-451 phase for a finished turn.
4. **The keeper ends** after 30 minutes with no turn and no background work, or after 4 hours with
   background work and no turn. A cancel ends the turn and leaves background work running. *Stop
   background work* is a separate action, and the thread's removal ends everything.
5. **A change that needs a new process waits.** A new model, a new permission mode that the process
   cannot take, or an `--add-dir` is refused while background work runs, with T3's words. With no
   background work, `yantrad` closes stdin and starts a new keeper, which resumes the session.
6. **The journals hold the keeper's life**, as they do for ACP. A new turn no longer empties the
   directory. The 64 MiB cap of decision 5 replaces the keeper between turns, as it does for ACP.

## Consequences

- Background work that the Chat starts finishes, and the owner sees it finish. This is the daily
  path of the build loop.
- A thread holds one `claude` process on its machine for up to 30 minutes after its last turn, or
  4 hours with background work. A machine with many threads pays that memory.
- **To measure before the build:** that `claude -p --input-format stream-json` keeps background
  tasks alive after a `result` and starts a wake turn. T3's fixtures show it through the SDK. A
  fixture test against the real binary in the podman machine is the proof (§B3).
- `chat.rs` loses the Claude path that ends a keeper at each turn, and Claude and ACP keepers share
  one life cycle.
- This ADR does not change who answers a permission request, or Q5.
