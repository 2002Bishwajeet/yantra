# ADR-0006 — The SSH exec primitive

- **Date:** 2026-07-29
- **Status:** accepted

## Context

Invariant I-20 already settled that transport is the system `ssh` binary with `ControlMaster`
multiplexing, not a library. That decision is not revisited here. What it left open is how to run one
command and find out what happened — which turns out to be harder than it looks, because `ssh(1)`
cannot express the answer.

Research on 2026-07-29 (`docs/research/07-ssh-transport.md`) verified the following against a real
`sshd` in a container, client OpenSSH 10.4p1:

**`ssh` discards the remote signal death.** A remote command killed by a signal exits **255 with empty
stderr and nothing in the log at any verbosity**. Confirmed in OpenSSH source and re-verified here
against current `master`: `client_input_channel_req()` in `clientloop.c` handles `"exit-status"` and
`"eow@openssh.com"` but has **no branch for `exit-signal`**, so `exit_status` keeps its initial `-1`,
which surfaces as 255.

Three distinct conditions therefore collapse onto "exit 255, no output":

| Condition | `ssh` exit | stderr |
| --- | --- | --- |
| remote command exits 255 | 255 | empty |
| remote command killed by a signal | 255 | empty |
| connection dropped mid-command, multiplexed | 255 | empty |

No `-o` option separates them. Pattern-matching stderr cannot work, because there is nothing to
match. This matters immediately: Y-042 decides *create a session* versus *attach to the existing one*
by reading an exit status, and `tmux has-session` returns non-zero when the session is absent. A
dropped connection that looks like "absent" produces a duplicate session — a direct violation of the
idempotency requirement in §B4.

**`ssh` hands its arguments to the remote login shell.** Everything after the destination is
space-joined into one string and interpreted remotely. `Command::new("ssh").args([...])` gives no
protection whatsoever — verified by watching `$(id -un)` expand on the remote side. Workspace `repo`
paths come from a config file, so this is a code-execution path. POSIX `'\''` escaping was also
tested and **breaks on an embedded newline**.

**Killing the local `ssh` does not kill the remote command**, multiplexed or not; it leaves an orphan
reparented to PID 1.

## Decision

`yantra_core::ssh` runs commands through the system `ssh` binary with three mechanisms that exist
solely to repair the defects above.

**1. A sentinel trailer carries the real status.** The remote side reports its own exit status on
stderr as `\n<nonce>:<n>`. Presence of the sentinel is the *transport* verdict; its value is the
*command* verdict. This also recovers information `ssh` cannot express at all — a SIGKILLed command
reports 137.

The nonce is random per exec so remote output cannot forge it, the trailer is stripped before stderr
reaches the caller, and the last trailer wins. Absence of the sentinel is `Error::Transport`, which is
a different type from a command that ran and failed — the caller cannot confuse them by accident.

The user's command runs in a **child** `/bin/sh -c`. Running it in the wrapper's own shell means
`exit 3` terminates the wrapper before the sentinel is printed.

**2. A base64 wire format, so nothing is quoted.** The command is base64-encoded, and the remote side
decodes and executes it. The base64 alphabet contains no shell metacharacters, which removes the
quoting problem rather than trying to solve it. Verified with command substitution, backticks, mixed
quotes and embedded newlines.

**3. A stdin-EOF watchdog kills the remote command.** The payload holds a duplicate of stdin on fd 9
(`exec 9<&0` — the remote shell redirects a background job's stdin to `/dev/null`, so the watchdog
needs its own copy) and sends SIGTERM when it closes. Consequently `ssh`'s stdin must be a
**held-open pipe**: `Stdio::null()` makes the watchdog fire immediately.

Supporting flags: `-E <file>` diverts `ssh`'s own diagnostics off stderr so stderr belongs to the
command; `BatchMode=yes` prevents an indefinite hang when the daemon has inherited `DISPLAY` and `ssh`
invokes `SSH_ASKPASS`; `ServerAliveInterval`/`ServerAliveCountMax` are the only defence against a host
that freezes without closing TCP; `RequestTTY=no` stops a user's `~/.ssh/config` forcing a pty and
corrupting stdout with CRLF.

**Control socket paths are validated at construction**, not at first use. The budget is **90 bytes on
Linux, 86 on macOS** — below `sun_path` because the master also binds a 17-character temporary
suffix. `%C` contributes a fixed 40 characters. Exceeding it otherwise produces an opaque 255.

### Deliberately deferred

**No explicit master process and no per-host mutex.** `ControlMaster=auto` gives multiplexing (which
is what I-20 requires) with no lifecycle code. The explicit `-N -f` master, and the mutex that stops
concurrent first-connections racing, only pay for themselves under concurrency M1 does not have —
20 concurrent cold starts all *succeed*, they just run unmultiplexed and log noise. Revisit when
`yantrad` serves more than one workspace at a time.

**`StrictHostKeyChecking=accept-new`, not `yes`.** There is no enrolment flow yet. Tightening this is
part of adding one, and is tracked rather than silently left permissive.

## Consequences

**Gained**

- A remote command's status is always its own. `Output.status` is never `ssh`'s 255.
- Signal deaths are visible (`137`, `143`) where plain `ssh` reports nothing.
- Transport failure is a distinct error type, so Y-042 cannot mistake "connection dropped" for
  "session does not exist" and create a duplicate.
- Config-sourced paths cannot inject remote commands.
- An over-long control path fails at construction with a message naming the limit.

**Paid**

- The remote side must have `/bin/sh` and `base64`. Both are in POSIX/coreutils and present in the
  Alpine test image, but this is a real assumption about target machines and Q4 (Windows) must not
  quietly inherit it.
- Every exec ships a ~200-byte wrapper script, and stderr carries a trailer that must be stripped.
- The watchdog forbids `Stdio::null()` and `-n` on stdin. That is a non-obvious coupling; it is
  commented at the call site because getting it wrong makes every command die instantly.
- `-E` writes a per-exec temp file that has to be cleaned up.

**Not resolved**

- Windows OpenSSH still has no `ControlMaster` (Win32-OpenSSH #1328, open since 2019), and the
  payload assumes a POSIX shell. Q4 remains open; this ADR does not close it.
