# ADR-0008 — The stdin-EOF watchdog is withdrawn

- **Date:** 2026-07-29
- **Status:** accepted
- **Amends:** [ADR-0006](0006-ssh-exec-transport.md) — the exec payload only. The sentinel trailer,
  the base64 wire format, `-E` diversion and control-path validation all stand unchanged.

## Context

ADR-0006 shipped three mechanisms in the exec payload. Two of them repair defects that make `ssh`
unusable for orchestration; the third turned out to break it.

The withdrawn mechanism: the payload held a duplicate of stdin on fd 9 and sent `SIGTERM` to the
command when that descriptor reached EOF, so that killing the local `ssh` would not leave an orphan
on the remote machine. It required `ssh`'s stdin to be a held-open pipe.

**It killed every command that took longer than a few hundred milliseconds.** Measured against the
container fixture:

```
cmd="echo fast"             status=0    stdout="fast"
cmd="sleep 1; echo slow"    status=143  stderr="Terminated"
cmd="sleep 3; echo slower"  status=143  stderr="Terminated"
cmd="tmux -V"               status=143  stderr="Terminated"
```

143 is `128 + SIGTERM` — the watchdog firing on a connection that was working fine. It reproduces on
the *first* exec as well as later ones, so multiplexing is not involved.

**Y-041's test suite did not catch this**, and the reason is worth recording: every command in it
(`exit 0`, `exit 7`, `kill -9 $$`, `printf`) completes in under a millisecond, which is faster than
the spurious EOF arrives. The suite proved the sentinel worked and said nothing about whether commands
survive. It passed CI, was merged, and the defect surfaced only when Y-042 ran `tmux`, which is merely
slow enough to notice.

The plumbing is not at fault. Reproducing the same payload against a local shell with a genuinely
held-open pipe shows the watchdog never fires — the descriptor stays open as intended. The spurious
EOF is introduced by `ssh` itself, and the exact mechanism was not pinned down before deciding to
withdraw, because the cost/benefit no longer justified further investigation:

- The sentinel — the mechanism that makes exit status trustworthy, and the reason ADR-0006 exists —
  is **unaffected**. It is what Y-042's create-versus-attach decision depends on.
- The watchdog only mattered for **long-running** remote commands, and every command Yantra issues
  today (`tmux new-session`, `set-option`, `respawn-pane`) completes in milliseconds and has nothing
  to orphan.

## Decision

**Remove the watchdog from the exec payload. `ssh` is spawned with `Stdio::null()` for stdin.**

The payload reduces to: decode the command, run it in a child `/bin/sh -c`, print the sentinel.

A regression test (`a_slow_command_runs_to_completion`) runs a three-second command over the real
transport. Any future attempt to reintroduce orphan prevention must keep it passing.

## Consequences

**Gained**

- Commands of arbitrary duration work. This was a hard blocker for everything after Y-041.
- The payload is smaller and has one moving part instead of three.
- `Stdio::null()` for stdin also means a remote command that tries to read stdin gets EOF instead of
  hanging forever waiting for a daemon that will never type.

**Lost**

- **Killing the local `ssh` leaves the remote command running**, reparented to PID 1. I-27's
  measurement of that behaviour stands; only the remedy is withdrawn. This is tracked as **Y-046**
  and matters from M3, when agent sessions become long-running. It does not matter now, because
  nothing Yantra runs outlives a single tmux command.
- Closing stdin is no longer a cancellation primitive. Cancellation will need a different mechanism —
  most likely `tmux kill-session`, which is the correct level for it anyway.

**Not resolved**

- Why `ssh` signals stdin EOF on a pipe that is demonstrably still open. Recorded as an open question
  rather than a settled fact, so that anyone reviving the watchdog starts by answering it rather than
  assuming the plumbing was simply wrong.
