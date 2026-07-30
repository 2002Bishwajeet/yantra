# ADR-0011 — Claude Code runs as a TUI in tmux, and the transcript is the log

- **Date:** 2026-07-30
- **Status:** accepted
- **Closes:** Q7, Y-024

## Context

Every agent CLI surveyed in [R3](../research/03-ai-agent-clis.md) can be driven two ways: as an
interactive TUI, or headlessly with a prompt flag and structured output. R3's own verdict was blunt —
*"the tmux TUI path is the hazard, not the headless path… all five are safer driven headless"* — and
that sentence has been the recorded prior ever since, in the shape of "tmux is the human attach view,
headless is what Yantra automates".

Two paths, then. The tracker has carried that as Q7 since M0 without committing to it.

**The hazard R3 named has since been measured, and it is smaller than it looked.** Its three examples
were Gemini exiting on TTY loss, OpenCode's tmux corruption bugs, and Claude Code issue #63545 — a
detached tmux session that stops writing its transcript. The first two belong to agents Yantra does
not ship (the one-agent-first guardrail), and the third **did not reproduce**: Y-023 ran interactive
`claude` 2.1.220 in a fully detached session and found 18,427 bytes across 10 entries on disk within
five seconds. The macOS half of that claim is still untested — Q12, now blocked behind Y-059 — but
what stopped the re-run was authentication, not transcript writing: the file was created and grew to
57,841 bytes while `session_attached` stayed 0 throughout.

So the argument for headless has weakened, and the argument against it has not moved.

**Headless costs the product its point.** Yantra exists so that a session started on one machine can
be picked up from another, mid-run, by a human. `claude -p` produces no session to attach to. A
design where Yantra automates through one channel and the human attaches through a second means
either running two agent processes or reconstructing the TUI, and the second channel is the one the
whole project is named for.

**And the two paths are not equally cheap to keep honest.** §B3 requires integration tests against a
real tmux, which the podman fixture already provides. A headless path adds a second control surface
that has to be tested and kept working alongside it, in the milestone where the design is least
settled and [ADR-0004](0004-rust-for-the-daemon.md) warns that Rust punishes churn.

## Decision

**Claude Code runs as an ordinary interactive TUI inside the tmux session Yantra already opens.
There is no headless path in M3.**

Concretely:

- **Launch** is `cd <repo> && claude --session-id <uuid>`. There is no cwd flag, so the `cd` is
  mandatory; `--session-id` chooses the UUID up front, which is what makes the transcript path
  predictable rather than discovered. The command reaches the pane via `respawn-pane -k`, never
  `new-session` (**I-29**), and `hasTrustDialogAccepted` is pre-seeded first (**I-23**).
- **Output comes from the transcript JSONL**, at
  `~/.claude/projects/<repo path, non-alphanumerics → ->/<uuid>.jsonl`, written append-per-message.
  Never from `pipe-pane`, which on a TUI captures the raw redraw stream — a liveness channel, not a
  log (**I-3**, **I-22**).
- **Status comes from `claude agents --json`**, which prints `{pid, sessionId, cwd, status, …}` and
  **requires no TTY**. This is free process↔session correlation that would otherwise be Yantra's
  bookkeeping, and it is why Y-044's session store recedes another milestone.
- **Yantra refuses to launch an agent it cannot authenticate.** `claude auth status` emits JSON with
  `loggedIn`, and it is checked before launch. This is not defensive coding for an impossible case:
  **I-44** is exactly the case, and its whole danger is that the session comes up looking healthy.
  A pre-flight check turns a silent useless session into a refusal that names the reason.

**Not decided here:** whether Yantra ever *sends input* to the agent programmatically. Nothing in M3
requires it — `up`, `logs` and `down` are all satisfied by launching, reading and stopping. `send-keys`
into a TUI is the brittle part of this design (I-23 is the scar), so it stays unbuilt until something
actually needs it.

## Consequences

**Gained**

- One control path, one thing to test, one thing that can break.
- Attach-and-take-over works by construction, because there is nothing to reconstruct — it is the
  same session a human would have opened.
- The `--session-id` / transcript-path / `agents --json` trio means Yantra stores no session state at
  all in M3.

**Cost**

- **Yantra is now exposed to Claude Code's TUI behaviour**, including #63545 if it ever reproduces.
  The mitigation is in Y-061: assert the transcript's mtime is **advancing**, not that the file
  exists. That failure mode looks healthy until you tail it.
- **No structured events.** Headless `stream-json` gives typed `assistant` / `result` events; the
  transcript gives the same content in a format R3 verified but Anthropic does not version. Parsing
  it is reading someone else's file format, and it can change under us.
- **R3's recommendation is knowingly overruled**, on evidence R3 did not have. If a second agent is
  ever added and it has Gemini's TTY-loss behaviour, this decision is the first thing to re-open —
  R-2 is real and it exits **0**.

**Not decided here**

- Headless remains available and unbuilt. Adding it later is additive; nothing in this decision
  forecloses it.
- Whether the agent is *driven* rather than merely launched. See above.
