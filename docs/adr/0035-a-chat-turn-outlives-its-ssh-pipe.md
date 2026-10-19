# ADR-0035 — A Chat turn outlives its ssh pipe

- **Date:** 2026-10-19
- **Status:** Accepted 2026-10-19 by the owner ([Y-446](../../tracker.md)), with no changes.
  [Y-447](../../tracker.md) builds it.
- **Evidence:** [R19](../research/19-acp-for-every-harness.md) §3 and §6 option B,
  [R20](../research/20-claude-stream-json-turn.md), and the owner's decision 3 in
  [R21](../research/21-t3code-and-yantra.md) §6.
- **Amends** [ADR-0033](0033-other-harnesses-speak-acp-and-claude-delegates.md) decision 7 and
  [ADR-0026](0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md) decision 6, each by a dated
  blockquote in that ADR.
- **Reads against** [ADR-0011](0011-claude-code-runs-as-a-tui-in-tmux.md) (tmux outlives every
  client), [ADR-0006](0006-ssh-exec-transport.md) and [ADR-0008](0008-withdraw-the-stdin-watchdog.md)
  (the ssh exec), I-20 and I-27, [ADR-0018](0018-the-tmux-server-carries-the-macos-login-session.md)
  (the macOS login server) and [ADR-0028](0028-yantra-installs-the-bare-minimum-on-a-machine.md)
  (Yantra installs no binary of its own on a machine).

## Context

Today a Chat turn ends in three ways that its owner did not choose.

1. **The browser closes.** `crates/yantrad/src/chat.rs` cancels a running turn when its socket
   closes (`hang_up`). A phone that locks its screen ends the turn.
2. **The ssh pipe drops.** The agent's stdin and stdout are the ssh channel. When the channel
   closes, the agent reads EOF. R19 §3 measured this on `claude-agent-acp`: the adapter and its
   `claude` exited, and the running tool never finished. R20 measured that `claude -p` exits once
   its stdin closes.
3. **`yantrad` restarts.** Each turn's local `ssh` is the daemon's child. A restart for an update
   (ADR-0027) kills that `ssh`, and the far side then meets case 2.

ADR-0033 decision 7 accepted this for v1. It said the link from the appliance to the machine is the
one that matters, and that a keeper (R19 §6 option B) "is priced only if this proves too weak". Two
premises changed upstream.

- **The owner decided on 2026-10-07** that a Chat turn outlives its ssh pipe (R21 §6 decision 3).
- **M16 runs turns that nobody watches** ([the M16 plan](../plans/m16-the-coding-loop.md)). The owner
  taps **Fix with agent** on the phone and puts the phone away. The appliance watches the PR. The
  appliance will run in India, far from the machines, so its ssh links are long and drop more
  often. The M16 plan asks for Y-447 before the owner relies on unattended fixes.

The fix must keep five rules. **The daemon persists nothing** (CLAUDE.md §B1). **Yantra
orchestrates `tmux` and `ssh` and writes no new daemon** (§B2). **No Yantra binary goes to a machine
by default** (ADR-0028 §1 keeps `yantra-agent` a manual install). **Killing a local `ssh` leaves the
remote command running** (I-27), so any remote reader must end by itself. **ACP has no detach**
(R19 finding 2), so the keeper must not depend on the protocol.

### Options

| | **A. `yantra-agent keep`** | **B. The agent on the pane's tty** | **C. A shell keeper in a tmux pane, with file journals** |
| --- | --- | --- | --- |
| What holds the agent | A Rust subcommand on the machine | tmux; `send-keys` in, `pipe-pane` out | tmux holds a POSIX `sh` script, and the script holds the agent |
| Buffer | Its own, in Rust | `pipe-pane` output | Two files on the machine |
| What it needs on a machine | `yantra-agent` on every machine, for every OS and architecture | Nothing new | Nothing new: `sh`, `tail`, `mkfifo`, `base64`, tmux |
| Fatal cost | ADR-0028 and R-12 keep Yantra's binary off machines. It is also a new daemon (§B2) | A pty rewrites `\n` as `\r\n`, echoes input, and limits an input line (1024 bytes on macOS). An agent with a tty may act as if it is interactive (I-22) | Yantra owns about 30 lines of shell |

A harness's own server (`opencode serve`, `codex app-server`) also outlives a client. ADR-0033
already refused it, because each one speaks its own protocol and Claude has none. `dtach` and
`abduco` are not on the machines, and ADR-0028 installs neither.

## Decision

**Option C. A POSIX `sh` keeper in its own tmux session on the machine holds the agent. Its stdin is
fed from a journal file and its stdout goes to a second journal file. `yantrad` reads and writes
those files over ssh. A pipe drop, a closed browser and a daemon restart now detach the turn, and
none of them cancel it.**

### 1. tmux holds the keeper

- **One keeper session for each thread that has a live agent.** Its name is
  `yantra-keep-<workspace>-<thread id>`. It is in the machine's default tmux server, so on a Mac it
  is in the login server that ADR-0018 §1 requires, and not in a `Background` one.
- **`yantrad` opens it the way it opens every session.** It uses plain `new-session -d`, and
  `duplicate session` counts as success (I-1). It sets `remain-on-exit` (I-4) and puts the keeper
  in the pane with `respawn-pane -k` (I-29). It addresses the pane by `%id` (I-21).
- **The session is the thread's lock.** `duplicate session` at a turn's start means a turn is
  already running, and the Chat reports `busy`. The lock holds across daemon restarts and across
  tabs. The in-memory `Running` claim goes.
- **The session list hides `yantra-keep-` sessions.** `yantra new` refuses a workspace name that
  starts with `yantra-keep-`.

### 2. The keeper is a shell script that Yantra sends each time

- The script is `crates/yantra-core/src/keep.sh`, read with `include_str!` in the same way as
  `join.sh`. `keep.rs` owns it.
- Nothing is installed. Each start sends the script inside ADR-0006's base64 envelope, as the
  pane's start command. The agent command reaches the script base64-encoded too, so nothing is
  quoted (I-26, I-35).
- The script does not read the protocol. It does not know Claude's stream-json or ACP. It moves
  bytes and enforces two limits (decision 5).

Its shape is below. Y-447 owns the final text and shellchecks it.

    d=$1 cap=$2 idle=$3 agent=$4
    cd "$d" || exit 1
    umask 077
    : >>in; rm -f feed; mkfifo feed || exit 1
    tail -n +1 -f in >feed & echo $! >feed.pid
    /bin/sh -c "$(echo "$agent" | base64 -d)" <feed >>out 2>>err & a=$!
    ( while sleep 60; do
        [ "$(wc -c <out)" -le "$cap" ] || { echo "yantra: output passed $cap bytes" >>err; kill "$a"; }
        [ -n "$(find in out -mmin -"$idle")" ] || { echo "yantra: idle $idle minutes" >>err; kill "$a"; }
      done ) & w=$!
    wait "$a"; s=$?
    kill "$w" "$(cat feed.pid)" 2>/dev/null; rm -f feed feed.pid
    exit "$s"

### 3. What one keeper holds

- **A Claude keeper holds one turn.** ADR-0026 decision 2 stands: one `claude -p` for each turn,
  with `--resume`. The command is the one `claude::command` builds today.
- **An ACP keeper holds the thread's agent across turns.** ADR-0033 decision 2 stands. Today the
  agent lives as long as the browser socket. Now it lives as long as the keeper.
- **The agent never sees a tty.** All three of its streams are redirected, so I-22 is kept for the
  same reason as in ADR-0026 decision 6.

### 4. The journals: where, and what

Each thread has one directory on the machine, `~/.yantra/keep/<workspace>/<thread id>/`, mode
`0700`. It sits beside the thread's worktree directory and not inside it, so a checkpoint never
captures it.

| File | Who writes it | What it holds |
| --- | --- | --- |
| `in` | `yantrad` only, by append | Every line sent to the agent: the prompt, each permission answer, each cancel |
| `out` | the agent (its stdout) | Every line the agent printed, in order |
| `err` | the agent's stderr, and the keeper's two limit messages | Diagnostics, for a failed turn's message |
| `run` | `yantrad`, at the keeper's start | A random id for this keeper's life |
| `mode` | `yantrad`, at each turn's start | The turn's `PermissionMode` (Y-453) |
| `images/` | `yantrad` | The Chat's images (Y-424). They move here from the per-socket directory |

**A file and not a fifo is the buffer.** A fifo holds 64 KiB on Linux and less on macOS, and then
blocks the agent. A file keeps everything until the keeper ends. The keeper's own fifo (`feed`)
only connects `tail -f in` to the agent's stdin.

**A new Claude turn empties the directory first**, apart from `images/`. So the journals always
hold one Claude turn, or one ACP keeper's life.

### 5. Two limits, in the keeper

- **Size: `out` is capped at 64 MiB.** The keeper checks every 60 seconds, then stops the agent with
  `SIGTERM` and writes the reason to `err`. A long Claude turn with partial deltas writes a few MiB.
- **Idle: the keeper ends after 24 hours** in which neither `in` nor `out` changed. A permission
  request that the owner leaves overnight still waits.
- **An ACP keeper is replaced between turns** when `out` has passed half the cap. `yantrad` closes
  its stdin and starts a new keeper, which calls `session/load`. So the size limit never stops a
  running ACP turn because of earlier turns.
- **Both limits are arguments to the script**, so a fixture test can run them small.

### 6. How `yantrad` reads

- **One reader for each live keeper.** It is an ADR-0006 stdio `ssh` that runs
  `tail -c +<offset+1> -f out`. A loop around the `tail` asks tmux every 2 seconds whether the pane
  is alive, and ends the `tail` once the pane is dead. So a reader that I-27 orphans ends with its
  keeper.
- **The daemon keeps the offset in memory.** It is the number of bytes of whole lines it has read
  so far.
- **When the reader's `ssh` ends and the pane is alive, the daemon reconnects from that offset.**
  It waits 1, 2, 4 and then 8 seconds between tries, then tries every 8 seconds while the keeper
  lives. ControlMaster (I-20) gets a new master by itself (ADR-0006, Y-079).
- **The daemon reads every live keeper, and not only the ones that a browser has open.** So it sees
  each permission request and each turn end with nobody attached.

### 7. How `yantrad` writes

- **Each line to the agent is one ADR-0006 exec that appends to `in`.** `yantrad` is the only
  writer, and a thread's lock (decision 1) keeps it to one turn.
- **An answer is idempotent.** `yantrad` appends an answer only when `in` has no answer for that
  request id. It knows this from memory, or from reading `in` again after a restart (decision 9).
- **To close the agent's stdin, `yantrad` kills the `tail` that `feed.pid` names.** That is how a
  Claude turn ends after its `result`. It is also how an ACP keeper stops when the thread is idle:
  15 minutes with no turn and no socket.

### 8. Sequence numbers, and replay without duplicates

- **The sequence number is a byte offset in `out`.** The keeper gets it for free, and it survives
  any daemon restart because it is a fact about a file on the machine.
- **Each event that `yantrad` makes from a line of `out` carries a cursor:**
  `<run>:<offset where the line ends>:<part>`. Here `part` counts the events made from that line,
  from 0. One `result` line, for example, gives `thread.token-usage.updated` and then
  `turn.completed`.
- **The parse is a pure function of `out` and `in`.** So the same bytes always give the same events
  with the same cursors.
- **The browser keeps the last cursor it drew** and reconnects with
  `?thread=<id>&after=<cursor>`.
- **On every attach, `yantrad` parses `out` again from byte 0.** It stops at the offset its live
  reader has reached, which rebuilds the parser's state. It sends only the events after the
  browser's cursor, and then the live events from that same offset. No event is sent twice, and
  none is missed.
- **A cursor from an older `run` means "send all of the current run".** Without a cursor, a Claude
  thread replays its transcript, as today, and then the current run. An ACP thread replays all of
  `out`, whose start is the `session/load` history.
- **Events that the daemon makes itself carry no cursor.** On attach it makes again the ones that
  still matter: a `request.resolved` for each request that was opened before the cursor and
  answered since, and the last turn's `turn.diff.updated`.

### 9. A daemon restart

- At start, and on each 30-second pass of `refresh.rs`, `yantrad` finds `yantra-keep-` sessions in
  the session list it already reads. It adopts each one it does not hold.
- **To adopt a keeper, `yantrad` reads `in` and `out`, parses them, and starts a reader at the end
  of `out`.** It does this before any browser attaches.
- **A request is still open when it appears in `out` with no answer in `in`.** This works for
  Claude's `control_request` and for ACP's `session/request_permission`. The same rule finds the
  daemon's own ACP requests that have no response in `out`, such as a `session/prompt`. A new
  daemon uses JSON-RPC ids with a new random prefix, so they never collide with ids in `in`.
- **A keeper whose pane is already dead is finished.** `yantrad` reads the rest of `out`, reads the
  pane's exit (I-47, I-48), keeps the checkpoint, and kills the session (I-30).

### 10. A permission request while nobody is attached

- **The agent waits.** Both protocols block the tool until an answer arrives, and the keeper keeps
  the agent alive meanwhile.
- **When the turn's mode answers the request, `yantrad` answers it**, from the `mode` file, as
  `chat.rs` does today.
- **Otherwise `yantrad` sends one ntfy notification** in the Y-451 phase for a wait. It names the
  workspace and the thread, and no word of the request (Q5). A restart can send it a second time.
- **Nothing denies a request by itself.** The request waits for the owner, or for the 24-hour idle
  limit (decision 5), which ends the turn as failed with the keeper's reason.

### 11. A socket close detaches, and only `cancel` cancels

- The browser socket subscribes to a turn. It no longer owns the turn. `hang_up`'s cancel goes.
- The `cancel` frame and thread removal are the only ways to stop a turn on purpose. A cancel
  appends Claude's `interrupt` or ACP's `session/cancel` to `in`. For Claude it then closes stdin
  (decision 7).
- When the agent has not ended 10 seconds after a cancel, `yantrad` kills the keeper session, and
  tmux sends the pane `SIGHUP`.

### 12. How the keeper ends, and what is cleaned up

- **The agent exits.** Claude exits after its stdin closes; an ACP agent exits when the thread is
  idle, after a cancel, or when a limit stops it.
- **The keeper then cleans up and ends.** It kills its watcher and its `tail`, removes `feed`, and
  exits with the agent's status. The dead pane keeps that status (I-4).
- **`yantrad` reads the dead pane and then removes the session.** It reads the rest of `out`, keeps
  the checkpoint (Y-448), sends `turn.diff.updated` to any socket that is attached, and kills the
  session (I-30). If the daemon is down at that moment, it does this when it adopts the keeper
  (decision 9).
- **The journal directory stays until the next turn empties it, or until `thread::remove` deletes
  it** together with the worktree. The last turn therefore replays in full, tool cards included.

### 13. What the daemon persists

**Nothing.** The journals, `run`, `mode` and the lock are on the machine. The offsets, the parser
state and the list of live keepers are in the daemon's memory, and decision 9 rebuilds them. The
cursor is in the browser. `yantrad` writes no file.

## Consequences

**Gained.**

- A Chat turn continues through a dropped link, a locked phone and a daemon update. ADR-0011's
  promise, that the work continues while nobody watches, now holds for the Chat too.
- Fix with agent and review comments sent from the phone run to the end with the phone shut.
- One keeper serves both relays, because it moves bytes and reads no protocol.
- A permission request that nobody answers waits, and the owner gets one notification.
- The tmux session is the thread's lock, so "one turn at a time" now holds across restarts and
  tabs.
- **Possible, not measured:** on a Mac, a turn started in the login tmux server may read the
  keychain, and R20 expects a turn over plain ssh to fail there (I-44). Y-447 does not claim this.
  A later run at the Mac can check it.

**Costs.**

- Yantra owns about 30 lines of shell, and they run on every OS in the fleet. I-42, I-43 and I-45
  show that the fleet's tools differ. `tail -f`, `find -mmin` and `mkfifo` must be tested on GNU,
  BSD and busybox.
- Each live keeper costs one more `ssh` on the appliance, about 11 MB (R19 §6). A Claude agent that
  finishes while the daemon is down waits idle, up to the daemon's return or 24 hours, at about
  200 MB on the machine.
- The journals put prompts and code output on the machine's disk, up to 64 MiB for each thread.
  The transcripts there already hold the same text. Directory mode `0700` keeps other accounts out.
- `chat.rs` changes shape. Turns move from the socket to a registry in the daemon that sockets
  subscribe to. The `Running` claim goes. Images move from the socket's lifetime to the thread's.
- The contract gains `after` on the Chat route and a `cursor` on each event, and
  `crate::contract` checks both.

**Not changed.**

- ADR-0026 decisions 1 to 5, 7 and 8, ADR-0033 decisions 1 to 6 and 8, and ADR-0011.
- **Delegated tasks (ADR-0033 decision 5) still end with their connection.** A later row can move
  them into the keeper. Y-447 does not.

**Not verified.**

- Whether `claude -p` or any ACP agent gives up on a permission request that waits for hours.
- Whether BSD `tail -f` passes a line on into a fifo at once, or holds it in a buffer, on macOS.
- `find -mmin` on busybox.
- Whether any harness opens `/dev/tty` when the pane gives it a controlling terminal.

### What proves it (Y-447's done line)

**The test is `crates/yantrad/tests/chat_keeper.rs`.** It runs in §B3's podman fixture, with a real
sshd, tmux 3.5a, git and bash, and a real `yantrad` binary started by the test. The agent is
`claude` on the fixture's `PATH`:

- **With a login on the host:** the real `claude`, as `tests/claude.rs` does. CI skips this case.
- **In CI:** a shell stand-in that plays `tests/recordings/claude-2.1.291-accept.jsonl` with a
  0.5-second gap between lines. It holds at the `control_request` until a `control_response` line
  arrives on its stdin. Then it creates `made.txt` and prints `result`.
- **A second case does the same with an ACP stand-in**, for the ACP relay.

Steps:

1. Start `yantrad` A. Open the Chat socket and send a turn. Read events until the first
   `content.delta`, and keep its cursor C.
2. **Kill the ssh pipe.** Run `ssh -O exit` on the control socket and kill the reader's `ssh`.
   Assert that the agent's PID in the container did not change and that `out` still grows.
3. Close the socket. When `out` holds the `control_request`, send `SIGKILL` to `yantrad` A.
4. Wait 10 seconds. Assert that the agent is alive, that the keeper session exists, and that `in`
   holds no answer.
5. Start `yantrad` B. Open the socket with `?thread=<id>&after=C`. Assert that every event's cursor
   is after C, and that `request.opened` arrives exactly once. Send `accept`.
6. Assert that `turn.completed` arrives with state `completed`, `made.txt` is in the worktree, and
   `turn.diff.updated` arrives. Join the events of both sockets by cursor. Assert that the result
   equals an uninterrupted control run of the same stand-in, with no cursor twice and none missing.
7. Assert that, within 10 seconds, the keeper session is gone and no `claude`, `tail` or keeper
   `sh` process remains in the container. Assert that `yantrad` B wrote no file on the host outside
   its ssh socket directory.

**Done** when this test passes in CI with the stand-ins, and once on the owner's machine with the
real `claude`.
