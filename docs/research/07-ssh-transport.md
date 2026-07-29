# SSH exec primitive over the system `ssh` binary — operational research

Access date: **2026-07-29**. Everything below marked *[verified]* was executed in a disposable
podman container running a real `sshd`, per CLAUDE.md §B3. The container and image were removed
afterwards; the developer's `~/.ssh/` was never written to.

**Lab versions**
- client: `OpenSSH_10.4p1, OpenSSL 3.6.3` (Arch/CachyOS, Linux 7.1.3)
- server: `OpenSSH_9.2` (Debian bookworm container), `MaxSessions 50`
- transport tested over `127.0.0.1:2222` → container, key auth only, isolated `-F /dev/null` config

Where a claim is version-sensitive it is cited to upstream docs or release notes, not memory.

---

## 0. Executive summary — what changes the code

Five findings dominate; the rest is detail.

1. **`ssh` destroys the remote exit status in two of three failure modes.** A remote command killed
   by a signal exits **255 with an empty stderr and no log line at any verbosity** — byte-identical
   to a connection failure. A sentinel wrapper is not a nicety; it is the only way to tell them
   apart, and it *recovers information `ssh` never had a way to report*.
2. **`-E <file>` diverts essentially all of `ssh`'s own diagnostics off stderr**, leaving stderr
   byte-clean for the remote command. The single exception is the `quit_message()` family, which
   writes to fd 2 directly. Without `-E`, multiplexing warnings land in your command's stderr.
3. **Killing the local `ssh` does not kill the remote command** — direct *or* multiplexed. You get
   an orphan reparented to PID 1. `-t` fixes it but merges stderr into stdout and CRLF-mangles the
   bytes, so it is unusable here. The working fix is a stdin-EOF watchdog, with two non-obvious
   traps (§6).
4. **`ControlPath` must be ≤ 90 bytes on Linux, ≤ 86 on macOS** — not 108/104. The master binds
   `ControlPath` + a 17-char temp suffix, and *that* is what must fit.
5. **Argument safety: passing separate argv to `ssh` buys you nothing.** `ssh` space-joins
   everything and hands it to the remote *login shell*. Config-sourced repo paths are a command
   injection vector. A quote-free base64 wire format removes the entire class of problem.

---

## 1. ControlMaster setup

### Documented semantics (`ssh_config(5)`, OpenSSH 10.4p1 / upstream master)

| Value | Behaviour |
|---|---|
| `no` (default) | Never listens. Connects as a *client* to an existing `ControlPath`. **Falls back to a normal connection if the socket is absent or not listening.** |
| `yes` | Listens on `ControlPath`. Does not attempt to be a client first. |
| `auto` | Opportunistic: try to be a client; if that fails, connect normally *and* try to become the master. |
| `ask` / `autoask` | As above but require `ssh-askpass(1)` confirmation. **Never use in a daemon** — it is an interactive prompt. |

`ControlPersist`:
- `no` (default) — master dies when the initial client session ends. Useless for a daemon.
- `yes` / `0` — master lives until killed or `ssh -O exit`.
- `<seconds>` (or an `sshd_config`-style time spec) — master exits after that long **idle**, i.e.
  with no client connections attached.

### Measured trade-offs for a daemon *[verified]*

**Multiplexing is worth 25×.** 20 sequential client sessions over an established master vs. fresh
connections, same host:

```
5x multiplexed:   7 ms/conn
5x fresh      : 174 ms/conn
```

20 concurrent multiplexed clients cost **0** new `sshd` authentications (counted from `Accepted
publickey` in the server log). That is the whole reason I-20 exists.

**`auto` has a thundering-herd problem.** 20 concurrent "first" connections against a nonexistent
`ControlPath`, `ControlMaster=auto`:

```
exit codes:      20 0
     19 ControlSocket /tmp/.../m-38cae72d... already exists, disabling multiplexing
sockets created: 1
```

All 20 *succeeded*, but 19 lost the race to bind, **printed a warning to stderr**, and opened their
own full TCP + auth connection. So under a burst you get: no multiplexing benefit, and 19 spurious
stderr lines mixed into 19 command outputs. Correctness survives; observability does not.

The source explains it — on `EADDRINUSE`/`EINVAL` `muxserver_listen()` calls `error()` (non-fatal),
sets `options.control_master = SSHCTL_MASTER_NO`, and returns, so the connection proceeds
unmultiplexed.

**`yes` is wrong for clients** — it never tries to reuse an existing master, so every invocation
either becomes a master or collides with one.

### Recommendation

Split the roles explicitly rather than relying on `auto`:

- **Master** (one per host, created under a per-host async mutex in the daemon):
  `-M -N -f` with `ControlPersist`.
- **Clients** (every exec): `ControlMaster=no`. Never emits the "already exists" warning, and
  degrades to a normal connection if the master is gone *[verified: rc=0, clean stderr]*.

This makes master creation a decision the daemon owns, instead of an emergent property of a race.

**Caveat — `ControlMaster=no` does not self-heal a stale socket.** See §7.

### `MaxSessions` is a real ceiling *[verified]*

60 concurrent sessions over one master against `MaxSessions 50`: **all 60 exited 0 and all 60 ran**,
but 10 of them printed
`mux_client_request_session: session request failed: Session open refused by peer`
to stderr and **silently fell back to their own fresh connection** (confirmed: 10 new `sshd`
authentications). So exceeding `MaxSessions` is not an error you can detect from the exit code — it
shows up only as stderr noise and a latency cliff. With `-E` the noise is diverted and it becomes
invisible. Budget concurrency per host below the server's `MaxSessions` (default **10** on stock
`sshd`, not 50 — the lab raised it deliberately).

---

## 2. The ControlPath socket length limit

### The real budget is 90 bytes, not 108 *[verified]*

The master does not bind `ControlPath`. It binds `ControlPath` + `.` + 16 random chars (17 bytes),
then renames. `sun_path` is 108 bytes on Linux **including the NUL**, so:

```
max ControlPath = 107 - 17 = 90 bytes   (Linux)
max ControlPath = 103 - 17 = 86 bytes   (macOS, sun_path[104])
```

Measured threshold, exact:

```
ControlPath len= 90 -> OK
ControlPath len= 91 -> unix_listener: path ".../zzz….5UffEKnIby8C19dj" too long for Unix domain socket
```

### Two different failure messages, at two different lengths *[verified]*

| ControlPath length | Message | Exit | Source |
|---|---|---|---|
| 91 – 107 | `unix_listener: path "<path>.XXXXXXXXXXXXXXXX" too long for Unix domain socket` | 255 | master-side bind |
| ≥ 108 | `ControlPath too long ('<path>' >= 108 bytes)` | 255 | `fatal()` in `muxclient()` |

Both are fatal. This became fatal in **OpenSSH 6.7**; ≤ 6.6p1 silently disabled multiplexing
instead. Do not expect graceful degradation.

Note the `.XXXXXXXXXXXXXXXX` suffix is what appears in the first message — an implementation detail
that makes the error look like the path is longer than what you configured. Match on
`too long for Unix domain socket`, not on the path.

### `%C` vs `%r@%h:%p` *[verified]*

`%C` = **SHA-1 hash, 40 lowercase hex chars, fixed length**:

```
-o ControlPath=/tmp/yl/cm-%C  ->  /tmp/yl/cm-38cae72d0b047e0291df62f2711b35c45e5474bb
```

It varies with user, host, port, and ProxyJump *[verified]* — distinct hashes for `root@…:2222`,
`root@…:2200`, `other@…:2222`, and `-J bastion`.

`%r@%h:%p` is **unbounded** — it embeds the hostname. A realistic Tailscale name already costs 69
bytes under `~/.ssh/`:

```
/home/user/.ssh/cm-root@a-very-long-machine-name.tailnet.ts.net:22  = 69 bytes
```

Add a longer home directory or a longer MagicDNS name and it exceeds 90. **Use `%C`.**

**Version-sensitive:** what `%C` hashes changed.

| OpenSSH | `%C` |
|---|---|
| 6.7 (introduced) – 9.0ish | `Hash of %l%h%p%r` (verified: Ubuntu focal 8.2, jammy 8.9 man pages) |
| ≥ 9.6 (verified noble) through 10.4 / upstream master | `Hash of %l%h%p%r%j` (`%j` = ProxyJump contents) |

Consequence: **the socket name for the same host differs across OpenSSH versions**, and because `%l`
is the *local* FQDN, it also changes if the daemon's hostname changes. Both orphan the old socket
rather than break anything. Don't persist a socket path across upgrades — recompute it, or better,
don't store it at all and always let `ssh` expand `%C`.

### Where a daemon should put control sockets

Budget: `dir + "/" + prefix + 40` ≤ 90, so the directory + prefix must be ≤ **49** bytes.

Recommended: **`~/.config/yantra/cm/%C`** (per §B5 paths) — 20 bytes of prefix under a typical home,
leaving comfortable headroom. Requirements, all confirmed by docs or observation:
- Directory must not be writable by other users (`ssh_config(5)` says so explicitly). Create `0700`.
- `ssh` creates the socket `srw-------` (0600) *[verified]*.
- **Do not use `$XDG_RUNTIME_DIR`-relative paths blindly** and do not use a path containing the
  session/container id — those are exactly the long-prefix cases that blow the limit.
- Do not use `/tmp` with a multi-tenant-writable directory.

Yantra should **validate the expanded length at startup** and fail loudly with a clear message,
rather than discovering it as a 255 that looks like a network fault.

---

## 3. Exit code disambiguation — the important one

### The problem is worse than "255 is ambiguous" *[verified]*

| Scenario | `ssh` exit | stderr | `-E` log |
|---|---|---|---|
| remote `exit 0` | 0 | — | — |
| remote `exit 7` | 7 | — | — |
| remote `exit 255` | **255** | *(empty)* | *(empty)* |
| remote killed by SIGTERM/SIGKILL/SIGINT/SIGSEGV | **255** | *(empty)* | *(empty, even at `LogLevel=DEBUG3`… see below)* |
| connection refused | 255 | `ssh: connect to host … Connection refused` | diverted by `-E` |
| connection dropped mid-command (direct) | 255 | `Connection to <h> closed by remote host.` | **not divertible** |
| connection dropped mid-command (**via mux client**) | 255 | *(empty)* | *(empty)* |
| `ServerAlive` timeout | 255 | *(empty)* | *(empty)* |

Three separate conditions collapse onto "255 with no output". Through a multiplexed client — the
normal path for Yantra — **a dropped connection is completely silent**.

### Signal deaths are silently discarded — negative finding

`man ssh` says only *"ssh exits with the exit status of the remote command or with 255 if an error
occurred."* It does not say that a signal death is reported as 255. It is:

```
$ ssh … 'kill -9 $$'      # LogLevel=DEBUG3
debug1: client_input_channel_req: channel 0 rtype exit-signal reply 0
debug1: Exit status -1
rc=255
```

Confirmed in `clientloop.c`: `client_input_channel_req()` handles `"exit-status"` and assigns
`exit_status = exitval`. There is **no branch for `exit-signal`** — `exit_status` keeps its initial
`-1`, which surfaces as 255. The protocol *does* carry the signal name (the server sent it), but
`ssh(1)` has no way to give it to you. **This is unrecoverable at the `ssh` layer.**

Practically: a remote build killed by the OOM killer is indistinguishable from the network dropping,
and there is no flag, log level, or option that changes this.

### What does *not* work

- **No `-o` option disambiguates.** There is none.
- **stderr pattern matching is not reliable.** Three of the failure rows above produce *empty*
  stderr. You cannot pattern-match on nothing. And the one distinctive message
  (`Connection to … closed by remote host.`) does not appear on the multiplexed path at all.
- **`-E` alone does not solve it.** It cleanly separates diagnostics (§4), which is necessary but not
  sufficient: it does not manufacture information `ssh` never received.
- **Checking `ssh -O check` after the fact is racy** and answers a different question (is the master
  alive *now*), not whether *this* session completed.

### What works: a sentinel trailer *[verified]*

Have the remote side report its own status out-of-band. Presence of the sentinel is the transport
verdict; its value is the command verdict.

```
cmd=[exit 0]        ssh_rc=0  sentinel=YEXIT:0
cmd=[exit 255]      ssh_rc=0  sentinel=YEXIT:255
cmd=[exit 7]        ssh_rc=0  sentinel=YEXIT:7
cmd=[kill -9 $$]    ssh_rc=0  sentinel=YEXIT:137     <- signal recovered
cmd=[kill -TERM $$] ssh_rc=0  sentinel=YEXIT:143     <- signal recovered
transport failure   ssh_rc=255 sentinel=ABSENT
```

Decision rule:

| sentinel | meaning |
|---|---|
| present, value *n* | remote command completed; status *n* is authoritative (128+*sig* if signalled) |
| absent | transport failure; `ssh`'s own exit code and the `-E` log are the diagnosis |

This does more than disambiguate: **`YEXIT:137` tells you the command was SIGKILLed, which plain
`ssh` cannot express at all.** Two bugs fixed by one mechanism.

Put the sentinel on **stderr**, not stdout, so stdout stays byte-exact (verified: NUL bytes survive
intact). Use a **per-exec random nonce** so remote output cannot forge it, and strip the trailer
before returning stderr to the caller.

**Trap:** `CMD; printf sentinel` is wrong — if `CMD` is `exit 3`, it terminates the wrapper shell and
the sentinel never fires *[verified]*. The user command must run in a **child** (`/bin/sh -c "$CMD"`),
never in the wrapper's own shell.

---

## 4. Flags a non-interactive daemon needs

### `BatchMode=yes` — prevents a real, indefinite hang *[verified]*

The folklore ("without it ssh hangs waiting for a password") is **half wrong and half worse than
stated**:

- With `stdin=/dev/null` and no tty, a missing `BatchMode` does **not** hang. `ssh` reads EOF and
  fails after 3 attempts: `Permission denied, please try again.` ×2 then rc=255.
- **But if the daemon inherited `DISPLAY` (or `SSH_ASKPASS_REQUIRE=force`), `ssh` spawns
  `SSH_ASKPASS` and blocks forever**, stdin and tty notwithstanding:

```
no BatchMode, DISPLAY set: rc=124 (killed by 15s timeout)  askpass invoked: 1 time
   BatchMode=yes         : rc=255 (immediate)              askpass invoked: 0 times
```

A `yantrad` started from a desktop session or a user systemd unit can absolutely inherit `DISPLAY`.
`BatchMode=yes` is mandatory, and it also collapses 3 auth attempts into 1 clean failure.
(`SSH_ASKPASS_REQUIRE` was added in **OpenSSH 8.4**.)

### `StrictHostKeyChecking` — pick deliberately *[verified]*

Default is `ask`. With no tty it does **not** hang; it fails cleanly:
`Host key verification failed.`, rc=255, and **known_hosts is not written**.

- `accept-new` (added **OpenSSH 7.6**): TOFU — adds unknown keys, still refuses *changed* keys.
  Verified: rc=0, writes known_hosts, emits
  `Warning: Permanently added '[127.0.0.1]:2222' (ED25519) to the list of known hosts.` on stderr
  (divertible with `-E`).
- `no`/`off`: accepts changed keys too. **Do not use** — it discards MITM protection, which matters
  precisely because Yantra drives machines over Tailscale.

For Yantra: `accept-new` on first enrolment, `yes` afterwards, with an explicit
`UserKnownHostsFile` under `~/.config/yantra/` so the daemon never mutates the developer's
`~/.ssh/known_hosts`.

### `ConnectTimeout` — bounds connection setup only *[verified]*

```
ConnectTimeout=5, blackholed IP : rc=255 in 5s   "ssh: connect to host … Connection timed out"
no ConnectTimeout, same         : still trying at 30s
```

Covers TCP connect **and** the initial handshake/kex (per `ssh_config(5)`). It does **not** bound the
session. Omit it and a dead host pins a task for the OS SYN timeout (~130s on Linux).

### `ServerAliveInterval` / `ServerAliveCountMax` — the only defence against a frozen host *[verified]*

Froze the container mid-command with `podman pause`:

```
no ServerAlive                          : still hanging at 45s (would hang indefinitely)
ServerAliveInterval=5 ServerAliveCountMax=3 : disconnected after 17s, rc=255
```

Matches the documented `interval × countmax` formula. This is the difference between a task that
fails in 45s and one that never returns. Note the disconnect is a **silent 255** — another argument
for the sentinel.

Prefer these over `TCPKeepAlive`: the man page notes server-alive messages go through the encrypted
channel and are unspoofable, unlike TCP keepalives.

### `ExitOnForwardFailure` *[verified]*

```
=yes : rc=255, command NOT run,  "bind [127.0.0.1]:22: Permission denied"
=no  : rc=0,   command RAN,      same warning on stderr
```

Irrelevant for a plain exec with no forwards. It matters **if the master carries forwards** — then
`=yes` on the master turns a silent half-broken master into a loud failure. Set it on the master.

### `-n` / `-N` / `-T` / `StdinNull`

- **`-n`** (= `StdinNull=yes`, config keyword added **OpenSSH 8.7**): redirects stdin from
  `/dev/null`. Verified: without it the remote command consumes the parent's stdin
  (`head -1` returned `LINE1`); with it, nothing.
  **In Rust this is redundant if you set `Stdio::null()` — and actively harmful if you use the §6
  watchdog, which needs stdin held open.** Control stdin from Rust, not with `-n`.
- **`-N`**: do not execute a remote command. For the **master only**.
- **`-T`**: disable pty allocation. Already the default when a command is given and stdin is not a
  tty, but set `RequestTTY=no` explicitly so a stray `RequestTTY force` in a config file cannot
  merge your streams (§6). Verified `RequestTTY=no` keeps stdout/stderr split.

### `-E <logfile>` — the flag nobody mentions, and the one that matters most *[verified]*

`-E` redirects `ssh`'s **own** diagnostics away from stderr, leaving stderr as pure remote-command
output.

| message | stderr | `-E` file |
|---|---|---|
| `ssh: connect to host … Connection refused` | — | ✔ |
| `…: Permission denied (publickey,password).` | — | ✔ |
| `No ED25519 host key is known …` / `Host key verification failed.` | — | ✔ |
| `unix_listener: … too long for Unix domain socket` | — | ✔ |
| `ControlSocket … already exists, disabling multiplexing` | — | ✔ |
| `Control socket connect(…): Connection refused` (stale socket) | — | ✔ |
| **`Connection to <host> closed by remote host.`** | **✔** | — |

End-to-end check with `-E` and a stale socket:

```
stdout : [OUT]
stderr : [CMDERR]          <- only the command's stderr
-E file: [Control socket connect(…): Connection refused]
```

**The one exception is by design.** `quit_message()` in `clientloop.c` writes with
`atomicio(vwrite, STDERR_FILENO, …)`, bypassing the log system entirely:

```c
static void quit_message(const char *fmt, ...) {
	...
	(void)atomicio(vwrite, STDERR_FILENO, msg, strlen(msg));
	...
	quit_pending = 1;
}
```

Call sites: `"Connection to %s closed by remote host."`, `"Connection to %s closed."`, `"poll: %s"`.
`"Killed by signal %d."` uses `verbose()` and *is* divertible.

Mitigating detail: **these do not appear on the multiplexed path** *[verified]* — a mux client
observing a drop is entirely silent. So in Yantra's normal path stderr is clean, and on the fallback
direct path you may strip the two known `Connection to … closed` lines.

Practical `-E` notes *[verified]*:
- It **appends** (3 lines after 3 runs) — use a fresh file per exec or it grows without bound.
- Created `-rw-------` (0600).
- Works with a **FIFO**, so Rust could stream it — but opening a FIFO for write blocks until a
  reader attaches, which is a deadlock risk. **A per-exec temp file is the safe choice**: spawn,
  wait, read, delete.
- `/dev/fd/N` on a pipe failed: `Couldn't open logfile /dev/fd/9: No such file or directory`,
  and note this exits **1**, not 255.

---

## 5. Argument safety

### Separate argv gives you nothing *[verified]*

`man ssh`: *"If supplied, the arguments will be appended to the command, separated by spaces, before
it is sent to the server to be executed."*

```
ssh host ls -d '/home/user/my repo'
  ls: cannot access '/home/user/my': No such file or directory
  ls: cannot access 'repo': No such file or directory
```

`Command::new("ssh").args(["host", "ls", "-d", path])` is **not** safe. There is no argv on the wire.
The remote side receives one string and runs it through the **login shell** (verified:
`ps -p $$ -o comm=` → `bash`).

### It is a command injection vector *[verified]*

```
ssh host "ls -d /root/$(id -un)"   ->  remote shell expanded $( )
```

Repo paths come from config files (§B4/§B5). A path containing `$(…)`, backticks, `;`, or a quote is
arbitrary remote code execution as the workspace user.

### POSIX single-quote escaping works — but not everywhere *[verified]*

The standard `'` → `'\''` transform:

```
/root/my repo                 -> ok
/root/we"ird                  -> ok
/root/$(id -un)`whoami`       -> printed literally, not expanded
```

**Negative finding, contradicting the usual advice:** it survives a `tcsh` login shell for simple
cases (`'it'\''s'` → `it's`), **but breaks on a newline inside the quoted string**:

```
bash login shell : line1\nline2|     (ok)
tcsh login shell : Unmatched '''.    (fails)
```

And `tcsh` mangles unquoted `$`: `echo "cost: $5"` → `cost: `. So "just single-quote it" is only
correct if every remote login shell is POSIX. That is an assumption about *other people's machines*.

### The fix: a wire format with no quoting at all *[verified]*

Make the string `ssh` hands to the login shell contain **only** base64 characters, spaces, `|` and
`-`. Every shell — sh, bash, zsh, ksh, csh, tcsh, fish — parses that identically.

Wire format:

```
echo <OUTER_B64> | base64 -d | /bin/sh
```

where `OUTER_B64` decodes to a POSIX script (interpreted only by `/bin/sh`, so POSIX quoting rules
are guaranteed):

```sh
CMD=$(echo <INNER_B64> | base64 -d)
/bin/sh -c "$CMD"
printf "\n<NONCE>:%d" $? >&2
```

Verified identical, correct behaviour under **both bash and tcsh** login shells:

| command | ssh_rc | sentinel | stdout |
|---|---|---|---|
| `echo hi` | 0 | `:0` | `h i \n` |
| `exit 255` | 0 | `:255` | — |
| `kill -9 $$` | 0 | `:137` | — |
| `printf "a\000b"` | 0 | `:0` | `a \0 b` (byte-exact) |
| `echo "it's $(id -un) /my repo"` | 0 | `:0` | literal, not expanded |
| two lines separated by `\n` | 0 | `:0` | both lines |

Note the inner `/bin/sh -c "$CMD"` is what makes `exit 255` report correctly instead of killing the
wrapper (§3).

**Length ceiling** *[verified]*: at ~200 000 bytes the **local** `execve` fails —
`/usr/bin/ssh: Argument list too long` — because Linux caps a single argument at `MAX_ARG_STRLEN`
(32 pages = 131 072 bytes). 100 000 worked. base64 inflates 4/3, so the usable payload is ≈ 98 KB.
In Rust this surfaces as an `io::Error` from `Command::spawn`, **not** an ssh failure — handle it
distinctly. For anything larger, stage a script file over the connection instead.

`base64 -d` is present on GNU coreutils and macOS (Ventura+). For older macOS remotes, `-D` or
`openssl base64 -d` would be needed — irrelevant if Yantra only drives Linux machines.

---

## 6. Killing a remote command

### The assumption is wrong *[verified]*

Killing the local `ssh` leaves the remote command running, in **every** non-pty configuration:

```
SIGTERM local ssh, no tty        -> remote survives
SIGKILL local ssh, no tty        -> remote survives; ps shows: 197  1  sleep 302   (reparented to init)
SIGKILL local mux client         -> remote survives; master shows the session channel still open
```

`ssh -O channels` after killing a mux client confirms the master holds it:
`#2 client-session (t4 [session:command] …)`.

### What actually governs it

The remote command is killed only if it receives a signal. `sshd` sends `SIGHUP` to the session
process group **when a pty is torn down**. With no pty there is no controlling terminal, no `SIGHUP`,
and the process simply loses its stdout/stderr pipes — which it will not notice unless it writes
enough to fill them.

`-t`/`-tt` therefore does reap the remote command *[verified: remote died]* — **but it is unusable
here**:

```
no tty  : stdout=[OUT]      stderr=[ERR]
with -tt: stdout=[OUT,ERR]  stderr=[]
hexdump : O U T \r \n E R R \r \n
```

It merges stderr into stdout and inserts CRLF. For a control plane that must return separate,
byte-exact streams, that disqualifies it.

### The reliable mechanism: a stdin-EOF watchdog *[verified]*

When `ssh` dies, the session's stdin channel closes, so a remote reader gets EOF. Use that as the
death signal:

```sh
exec 9<&0
<CMD> &
c=$!
( cat <&9 >/dev/null; kill -TERM $c 2>/dev/null ) &
wait $c
```

Verified, both direct and multiplexed:

```
corrected watchdog, direct connection : running_before_kill=1  running_after_kill=0  -> REAPED
corrected watchdog, multiplexed client: running_before_kill=1  running_after_kill=0  -> REAPED
control, no watchdog                  : running_before_kill=1  running_after_kill=1  -> ORPHANED
```

**Two traps, both of which cost me several wrong results before I found them:**

1. **`Stdio::null()` makes the watchdog fire instantly.** With stdin `/dev/null` the remote `cat`
   reads EOF immediately and kills the command before it starts *[verified: command dead within 3s]*.
   The daemon **must give `ssh` a real pipe it holds open** (`Stdio::piped()`, never written, never
   closed until cancellation). This also means **do not pass `-n`/`StdinNull=yes`**.
2. **`exec 9<&0` is load-bearing.** A shell with job control off (i.e. any non-interactive remote
   shell) redirects a background job's stdin to `/dev/null`. Writing the watchdog as
   `( cat >/dev/null; kill … ) &` means `cat` reads `/dev/null`, gets instant EOF, and kills the
   command immediately. Duplicating stdin to fd 9 first and reading `<&9` is what makes it work.

### Bonus: this gives you clean cancellation *[verified]*

Closing `ssh`'s stdin — without killing `ssh` — cancels the remote command gracefully:

```
remote running=1, ssh alive=yes
-> close ssh's stdin
remote running=0, ssh alive=no
ssh exit=0   sentinel=[Y7f3a91c:143]
```

`ssh` exits **0**, no orphan, and the sentinel attributes the cancellation precisely (143 = SIGTERM).
So `stdin.take()`/drop is a better cancellation primitive than `child.kill()`, which orphans.

### Residual noise

On signal death the remote **login shell** may report job status into the command's stderr
(`bash: line 1: 1523 Killed  /bin/sh -c '…'`). This is the remote bash, not `ssh`, so `-E` cannot
divert it. The base64 envelope reduces it to a bare `Killed`. If it must be eliminated, the payload
can redirect the wrapper's own stderr and re-emit only the sentinel.

### Belt and braces

For genuinely long-running work Yantra should use tmux (as the architecture already intends), where
the remote process is owned by the tmux server and survives deliberately. The watchdog is for
short-lived exec, where an orphan is always a bug.

---

## 7. First-connection behaviour and the race

### First connection, socket absent

- `ControlMaster=no`: connects normally, **no** master created, **no** stderr noise
  *[verified: `FELL_BACK`, rc=0]*. Documented fallback behaviour.
- `ControlMaster=auto`: connects normally, then tries to bind the socket and become master.
- `ControlMaster=yes`: binds `ControlPath` + 17-char temp suffix, then renames into place.

### The concurrent-first-connection race is benign but noisy *[verified]*

20 simultaneous `auto` connections to a cold path: **all 20 succeeded**, 1 became master, **19
printed `ControlSocket … already exists, disabling multiplexing`** and ran unmultiplexed.

So: no failures, no corruption, no lost commands — but no multiplexing benefit during the burst, and
19 stderr lines that a naive implementation will attribute to the user's command. The race is a
**performance and observability** bug, not a correctness bug. That is worth stating precisely,
because the usual framing ("there's a ControlMaster race, be careful") implies data loss.

**Mitigation:** the daemon already needs a per-host structure; give it a per-host async mutex, create
the master explicitly once, and let all execs use `ControlMaster=no`. Combined with `-E`, both the
noise and the herd disappear.

### Stale sockets — the sharp edge *[verified]*

If the master is `SIGKILL`ed (crash, OOM, `kill -9`), **the socket file is left on disk**.

| client setting | behaviour against a stale socket |
|---|---|
| `ControlMaster=no` | **Recovers** (rc=0, command runs) but prints `Control socket connect(…): Connection refused` and **does not unlink the stale socket** — so *every* subsequent exec repeats the message, forever. |
| `ControlMaster=auto` | Recovers **cleanly**: unlinks the stale socket, becomes the new master, **no stderr output**. |

The asymmetry is deliberate in the source — the unlink is guarded by
`options.control_master != SSHCTL_MASTER_NO`.

This is the one place the clean "`no` for clients" recommendation has a hole. Two acceptable fixes:

1. **`-O check` before dispatch** (`Master running (pid=…)` / `Control socket connect(…): …`,
   rc=255 when absent *[verified]*). On failure, unlink the socket and re-create the master under
   the per-host mutex. Deterministic, and the daemon stays in control.
2. Rely on `-E` to swallow the message and let a periodic reaper fix the socket. Simpler, but the
   connection silently runs unmultiplexed until someone notices.

Prefer (1) — it keeps the "daemon owns master lifecycle" invariant.

### Master lifetime vs. daemon lifetime *[verified]*

A `-M -N -f` master **reparents to PID 1** and outlives the daemon:

```
master ppid: 1
```

So a `yantrad` restart leaves live masters behind. They are reusable (that is a feature — restarts
stay fast), but the daemon must (a) `-O check` rather than assume, and (b) `ssh -O exit` on clean
shutdown, with `ControlPersist=<seconds>` as the backstop for unclean shutdown. Do **not** use
`ControlPersist=yes` — an unclean shutdown then leaks a master forever.

Observed: `-O exit` while a client session is running let that session **complete normally** (rc=0,
output intact), so shutdown does not have to abort in-flight work.

---

## 8. Windows OpenSSH

**ControlMaster/ControlPath multiplexing is not supported by native Win32-OpenSSH, and still is not
as of 2026-07.** `PowerShell/Win32-OpenSSH` issue **#1328 ("Support for Control Master")** was opened
2019-01-23 and remains **open**, labelled *"0 - Backlog"*, with no maintainer commitment. The cause
is that the Windows port does not implement the Unix-domain-socket behaviour multiplexing needs;
the observed failures are `getsockname failed: Not a socket` and, on older builds,
`muxclient socket(): Unknown error`. Microsoft's own VS Code Remote-SSH tracked the same limitation
(`microsoft/vscode-remote-release` #96). The standard workaround is WSL.

**Relevance to Yantra:** none for the daemon — `yantrad` targets Linux (`aarch64-unknown-linux-musl`
appliance, Linux dev box). Recorded so the constraint is not rediscovered later. If a Windows client
is ever in scope, note that other projects found it insufficient to merely *omit* the flags — a
user's `~/.ssh/config` can still enable multiplexing, so they must pass explicit
`-o ControlMaster=no -o ControlPath=none` to override it. Yantra's use of `-F /dev/null`-style
isolated config (see §9) already avoids this class of problem.

---

## 9. Concrete invocations

Verified end to end against real `sshd`. Stdout byte-exact (NUL preserved), stderr clean, exit status
fully attributed including signals.

### Master (once per host, under a per-host async mutex)

```
ssh
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new          # or =yes after enrolment
  -o UserKnownHostsFile=/home/<u>/.config/yantra/known_hosts
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=3
  -o ExitOnForwardFailure=yes
  -o ControlMaster=yes
  -o ControlPath=/home/<u>/.config/yantra/cm/%C
  -o ControlPersist=300
  -N -f
  <user>@<host>
```

Give it `Stdio::null()` for stdin and `-E <tmp>` if you want its diagnostics.

### Exec (per command)

```
ssh
  -E <per-exec temp file>                      # diverts ssh's own diagnostics off stderr
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile=/home/<u>/.config/yantra/known_hosts
  -o LogLevel=ERROR
  -o RequestTTY=no                             # never let a config file force a pty
  -o ControlMaster=no
  -o ControlPath=/home/<u>/.config/yantra/cm/%C
  <user>@<host>
  "echo <OUTER_B64> | base64 -d | /bin/sh"
```

- stdin: `Stdio::piped()`, **held open**; drop it to cancel.
- stdout/stderr: `Stdio::piped()`.
- **No `-n`, no `-t`/`-tt`, no `StdinNull`.**

`OUTER_B64` decodes to:

```sh
exec 9<&0
CMD=$(echo <INNER_B64> | base64 -d)
/bin/sh -c "$CMD" &
c=$!
( cat <&9 >/dev/null; kill -TERM $c 2>/dev/null ) &
w=$!
wait $c; r=$?
kill $w 2>/dev/null
printf "\n<NONCE>:%d" "$r" >&2
```

`<NONCE>` is per-exec random alphanumeric. `<INNER_B64>` is the user's command.

### Result interpretation

```
if stderr contains "\n<NONCE>:<n>":
        strip trailer  ->  Completed { status: n }        # n = 128+sig if signalled
else if ssh_exit == 255:
        Transport error; diagnosis = contents of the -E file
        (may be empty: silent drop, or ServerAlive timeout)
else:
        Transport error; ssh_exit is ssh's own (e.g. 1 = bad -E path)
```

Also strip, if present on a fallback direct connection:
`Connection to <host> closed by remote host.` / `Connection to <host> closed.`

### Startup validation

Expand `ControlPath` (or compute `dir + 41`) and refuse to start if > 90 bytes on Linux / 86 on
macOS, with a message naming the limit. This converts a confusing 255 into a config error.

---

## Sources

Official documentation and source (all accessed **2026-07-29**):

- `man 1 ssh` — OpenSSH 10.4p1, local system (SYNOPSIS, `-E`, `-M`, `-N`, `-n`, `-O`, `-S`, `-T`,
  `-t`, EXIT STATUS)
- `man 5 ssh_config` — OpenSSH 10.4p1, local system (ControlMaster, ControlPath, ControlPersist,
  BatchMode, ConnectTimeout, ConnectionAttempts, ServerAliveInterval, ServerAliveCountMax,
  StrictHostKeyChecking, RequestTTY, SessionType, TOKENS, ENVIRONMENT VARIABLES)
- https://raw.githubusercontent.com/openssh/openssh-portable/master/mux.c — `muxserver_listen()`,
  `muxclient()`, ControlPath length `fatal()`, EADDRINUSE handling, stale-socket unlink
- https://raw.githubusercontent.com/openssh/openssh-portable/master/clientloop.c — `quit_message()`
  (direct `atomicio` write to `STDERR_FILENO`), `client_input_channel_req()` exit-status handling
- https://raw.githubusercontent.com/openssh/openssh-portable/master/ssh_config.5 — current `%C`/`%j`
  token definitions
- https://man.openbsd.org/ssh_config — ssh_config(5), OpenBSD
- https://www.openssh.org/txt/release-6.7 — `%C` token introduced; ControlPath length became fatal
- https://www.openssh.org/txt/release-8.4 — `SSH_ASKPASS_REQUIRE` added (bz#69)
- https://www.openssh.org/txt/release-8.7 — `StdinNull` config keyword added
- https://www.openssh.org/releasenotes.html — release index
- https://manpages.ubuntu.com/manpages/focal/en/man5/ssh_config.5.html — OpenSSH 8.2: `%C` =
  `Hash of %l%h%p%r`, no `%j`
- https://manpages.ubuntu.com/manpages/jammy/en/man5/ssh_config.5.html — OpenSSH 8.9: `%C` =
  `Hash of %l%h%p%r`, no `%j`
- https://manpages.ubuntu.com/manpages/noble/en/man5/ssh_config.5.html — OpenSSH 9.6: `%C` =
  `Hash of %l%h%p%r%j`, `%j` present
- https://man7.org/linux/man-pages/man7/unix.7.html — `sockaddr_un.sun_path` 108 bytes on Linux
- https://pubs.opengroup.org/onlinepubs/009695399/basedefs/sys/un.h.html — POSIX `sys/un.h`
- https://kohlschutter.github.io/junixsocket/unixsockets.html — sun_path 104 (macOS/4.4BSD) vs 108
  (Linux/4.3BSD)
- https://groups.google.com/g/opensshunixdev/c/2w30g_fKqHM — ControlPath-too-long became fatal in
  6.7 (was non-fatal ≤ 6.6p1)
- https://github.com/PowerShell/Win32-OpenSSH/issues/1328 — "Support for Control Master", opened
  2019-01-23, still open, "0 - Backlog"
- https://github.com/PowerShell/Win32-OpenSSH/issues/405 — ControlPath failure on Windows
- https://github.com/microsoft/vscode-remote-release/issues/96 — "ControlMaster is not supported on
  Windows"
- https://bugs-devel.debian.org/1021122 — Debian #1021122, unix_listener socket path limit

Empirical results marked *[verified]* were produced in a disposable podman container
(`debian:bookworm-slim` + `openssh-server`, sshd 9.2, client 10.4p1) created and destroyed during
this session, per CLAUDE.md §B3. No real remote host was contacted; `~/.ssh/` was not modified.
