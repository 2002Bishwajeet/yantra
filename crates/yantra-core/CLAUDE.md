# yantra-core — working notes

Scoped to this crate. The root [`CLAUDE.md`](../../CLAUDE.md) still binds; this says only what is
different here, so read that first and this second.

## The one rule that is absolute

**Never print. Never exit.** Return a `Result` and let the caller decide how to say it
([ADR-0005](../../docs/adr/0005-core-logic-in-a-library-crate.md)). No `println!`, no `eprintln!`,
no `std::process::exit`, no `unwrap`. A daemon has to survive a bad answer from a machine that
went to sleep mid-command.

Layout, colour, tables and exit codes live in [`crates/yantra`](../yantra/CLAUDE.md). If you find
yourself formatting a column here, it belongs there.

## Read before touching anything

**[`tracker.md`](tracker.md)** — this crate's own, holding the invariants that bind code here,
most of them earned by a bug that looked like something else. They are not style notes. Which ones
bind where:

| Module | Invariants you will trip over |
| --- | --- |
| `ssh.rs` | I-20 (system binary), I-25 (silent failure), I-26 (payload is base64, never quoted), I-27 (orphans), I-28 (`ControlPath` ≤ 90 bytes). `exec` stops `ssh` when the text before the start marker holds `BROWSER_CHECK` (Y-585), because a daemon cannot finish that browser step and a held auth stage outlives `ConnectTimeout`. The error keeps that phrase, which `join.sh` reads, and holds no link. `forget_host_key` (Y-621) runs `ssh -G` with the same `connection_args` and then `ssh-keygen -R`, both system binaries (I-20). It removes one machine's line and writes none |
| `pty.rs` | I-18 (a controlling terminal, or no resize), I-13 (never block a tokio worker), I-27 (a remote *terminal* is hung up where a remote command is orphaned), and `ssh.rs`'s whole list through `Ssh::tty_argv` — **except I-26**: the envelope's `/bin/sh` reads from a pipe, which is the one stdin tmux refuses — and **I-54**, which is why a second viewer needs no tmux option, and since Y-394 `run`, which hands the far login shell `/bin/sh -c` and the command in single quotes (I-35) and runs only a command an install left ([ADR-0030](../../docs/adr/0030-a-one-off-terminal-runs-only-a-command-an-install-left.md)) |
| `acp.rs` | `ssh.rs`'s list through `Ssh::stdio`, the fourth call shape: **I-20** (the same socket), **I-26**/**I-35** (the command is still base64, but sent as `exec /bin/sh -c 'exec /bin/sh -c "$(… \| base64 -d)"'`, because the envelope's pipe would become the agent's stdin, and the single quotes keep the expansion from a csh or fish login shell), **I-63** (`--` before the name). Then [ADR-0033](../../docs/adr/0033-other-harnesses-speak-acp-and-claude-delegates.md) decision 2: **no ACP v1 shape leaves this module** — method names, `session/load`, the prompt result and the diff shape — because v2 changes all of them. The client advertises no `fs` and no `terminal`, and answers either with -32601. `rawInput` and `rawOutput` carry file contents, so they are never named |
| `mic.rs` | `ssh.rs`'s list through `Ssh::stdio`, as `acp.rs` has it: **I-20** (the same socket), **I-26**/**I-35** (the command is base64, sent as `exec /bin/sh -c …`), **I-63** (`--` before the name). Then [ADR-0031](../../docs/adr/0031-the-microphone-reaches-a-machine-as-a-virtual-source.md) §5: `WRITER` is the ADR's command verbatim, there is no pty because a pty changes bytes, and **a `Stream` keeps no buffer and never logs or formats a payload** (Q5). §7's laptop half: `RECORDER` is the ADR's `pw-record` flags, and `relay` holds one chunk and never looks inside it. `record` and `Ssh::stdio_detached` each start their child in its own process group, and `Ssh::stdio` leaves ACP and chat in the caller's, so a terminal's Ctrl-C reaches `yantra` alone and `close` can still drain `pw-cat` |
| `image.rs` | `ssh.rs`'s list through `Ssh::stdio`: **I-20** (the bytes ride the same socket, on stdin), **I-26**/**I-35** (the command is base64), and **I-24**: the only name in the command is the counter `put` generates, and the extension is read from the magic bytes, never from the browser. The directory is `images/` in the thread's keeper directory ([ADR-0035](../../docs/adr/0035-a-chat-turn-outlives-its-ssh-pipe.md) decision 4), outside every repository and worktree, and `thread::remove` deletes it. No image byte or size is logged or formatted (Q5) |
| `keep.rs` / `keep.sh` | [ADR-0035](../../docs/adr/0035-a-chat-turn-outlives-its-ssh-pipe.md). `start` is a plain `new-session`, so `duplicate session` means a turn already runs (**I-1**), then `remain-on-exit` (**I-4**), then `respawn-pane -k` with the script in the base64 envelope (**I-29**, **I-26**, **I-35**), addressed by `%id` (**I-21**). A dead keeper is killed by name (**I-30**). A `duplicate session` that is `stale`, with no script in its pane or a live agent on an empty `in`, is a failed start's leftover, and `start` replaces it (Y-541). `append`, `feed` and `close_stdin` carry their keeper's `run` and act only while `run` names it, so a stale writer cannot write into, close or kill a new keeper (Y-542). While the machine does not answer, `follow` and `feed` ask again (ADR-0035 decision 6). They end once their owner drops them, or once the machine has been silent for the keeper's idle limit. The last read of a dead keeper's `out` is tried six times. The journal directory is 0700, and every path reaches the shell through `sq`. `keep.sh` is POSIX `sh` and passes shellcheck. No journal line is logged (Q5) |
| `delegate.rs` | `acp.rs`'s list, and `ssh.rs`'s through `Exec`: every path reaches the shell through `sq`, and a `repo` of `~/…` through `clone::destination`. [ADR-0033](../../docs/adr/0033-other-harnesses-speak-acp-and-claude-delegates.md) decision 4: the worktree exists **before** the agent starts, and a worktree whose agent did not start is removed. `progress` never asks the machine, because the daemon serves it on a `GET` the main agent polls |
| `thread.rs` | `delegate.rs`'s list, through the worktree code it shares with it: every path reaches the shell through `sq`, and a `repo` of `~/…` through `clone::destination`. [ADR-0026](../../docs/adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md)'s 2026-10-06 amendment picks isolate: a thread's worktree is never the repository. **Ending a session deletes nothing; only `remove` does**, and it kills the thread's terminal session and then its keeper session first (I-30), so no agent writes the journals while they go (Y-542, Y-498). A session that will not go keeps the whole thread. `terminal` opens `yantra-term-<workspace>-<id>` in the worktree with `tmux.ensure` (I-1), makes a dead pane's session again, and on a Mac with no tmux server refuses rather than start one (ADR-0018 §1, I-44); its OS is a parameter, as `up`'s is. A machine with no tmux has no keeper, and a machine that cannot say whether tmux is there keeps the thread. `list` reads git, not memory, so a thread outlives a daemon restart. `remember`/`recall` keep an ACP thread's harness and session in git config under its branch, so the daemon still keeps nothing |
| `mention.rs` | `thread.rs`'s list: the directory reaches the shell through `clone::destination`, and the whole answer is one remote command in the base64 envelope (**I-26**). Only a skill's front matter crosses the wire, never its body. The Claude skill roots match T3 Code's `ClaudeSkills.ts` at 810e8f6; the others are read from each harness's docs |
| `command.rs` | `mention.rs`'s list, and `commit.rs`'s I-27: the probe runs under `commit::bounded` for 30 s. claude is found by `agent::probe` (I-34). It runs in the directory with `--no-session-persistence` and `disableAllHooks`, so no transcript becomes the thread's `--resume` target. Only `name`, `description` and `argumentHint` are read from the answer. The block comment and [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) credit T3 Code |
| `checkpoint.rs` | `thread.rs`'s list: every path and ref reaches the shell through `sq`, one remote command per call. A checkpoint is a parentless commit made through a private index and held by `refs/yantra/checkpoints/<thread id>/<n>`, so **no branch moves** and the daemon still keeps nothing. `GIT_AUTHOR_*` and `GIT_COMMITTER_*` are set in the command, because `commit-tree` refuses on a machine with no git identity. A ref is created with an empty old value, so two captures at once never overwrite each other. A revert deletes the refs above it, each at the value it read, so the numbers stay contiguous; `thread::remove` deletes the rest. `diff` and `branch` set their own prefixes and flags, so a user's git config cannot change what the browser parses. `branch` (Y-490, Y-543) asks `merge-base HEAD <start> <repository HEAD>` each call, so a main checkout on an older branch cannot widen the diff. It marks untracked files with `add -A -N` in a private index and diffs the worktree, so the real index is untouched and no blob is written. One `--numstat -p -z` pass gives the file list and the diff, split by the first two NULs together, which no numstat record holds. Only exit 1 with no output from `merge-base` adds Yantra's own line to git's error. No diff or path is logged or printed (Q5). The block comment and [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) credit T3 Code ([ADR-0026](../../docs/adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md) decision 5) |
| `commit.rs` | `checkpoint.rs`'s list: every path, ref and message reaches the shell through `sq`, one remote command per call. [ADR-0034](../../docs/adr/0034-the-coding-loop-writes-to-github.md) decision 2: the commit uses the machine's own identity, checked with `user.useConfigOnly`, and **never** the checkpoint identity; the push uses the machine's credential and is never forced. The upstream is git's `branch.<b>.remote`/`.merge`, so the daemon keeps nothing, and a generated remote name is an issue number and the thread id, never title text (I-24). `claude -p` runs from a fresh `mktemp -d`, because a transcript under the worktree would become the thread's next `--resume` target (`logs::newest`). **I-44**: on a Mac the draft and the push run inside the login session's tmux server through `tmux::run_shell`, because over ssh claude and an `osxkeychain` helper cannot read the keychain; `run-shell` passes back stdout alone (**I-55**), so the status and stderr follow it after a mark. A Mac with no tmux server gets one from `Tmux::login_server`, and is refused only when no one is logged in at its screen, as `up` refuses (ADR-0018 §1). `open_pr` (Y-449) reads only local refs over `Exec`, so it needs no credential and no Mac tmux server; it calls GitHub with the daemon's grant (ADR-0034 decision 1), and a PR already open is answered, never duplicated (§B4). The commit stages into `checkpoint::SNAPSHOT`'s private index and moves it into place only after the commit, so a failed hook leaves the index as it was. An upstream counts only when its remote is a named remote, never a URL. **I-27**: each call runs under a five-minute bound that stops the command and every process under it. No diff, message or remote URL is logged or returned (Q5). The block comment and [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) credit T3 Code ([ADR-0026](../../docs/adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md) decision 5) |
| `claude.rs` | `acp.rs`'s list through `Ssh::stdio`, and its own rule: **no stream-json shape leaves this module**. A `Session` is one `claude -p` in a thread's worktree, held by a keeper (`keep.rs`), that takes turn after turn on one stdin ([ADR-0041](../../docs/adr/0041-a-claude-keeper-holds-the-thread.md)). `--resume` names the session id `thread.rs` keeps, or the newest transcript when there is none ([R20](../../docs/research/20-claude-stream-json-turn.md)). Each `system/init` opens a turn; one with no user line waiting is a wake, and a `result` whose `origin` is not a person's corrects the guess. The background roster follows `background_tasks_changed`, `task_started` and `task_notification`, and empties when stdout ends, because no task outlives the process. `cancel` refuses what is waiting and sends `interrupt`; stdin stays open, so background tasks run on. Only `close` ends Claude, because dropping the local `ssh` leaves the remote `claude` running (I-27). A tool's input is read for its target alone, except that a `TaskUpdate` input is also read for its task id, subject and status. The plan is the turn's `TaskCreate` and `TaskUpdate` results, and `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is what gives `-p` those tools. No prompt, reply or output is logged |
| `room.rs` | [ADR-0038](../../docs/adr/0038-rooms-and-guest-devices.md) decisions 1 to 5. **No I/O and no clock of its own**: the daemon holds the store and passes the time. The label is an argument the daemon writes from identity, never a field of a call. `wrap` is the only way a message reaches a receiver, and it escapes every `<room` and `</room` in the text. Nothing here logs or formats a message's text (Q5) |
| `room_file.rs` | [ADR-0039](../../docs/adr/0039-a-room-is-a-shared-project.md) decision 2. The name passes `room::valid_name` **before** a path is built from it. Every write goes to `<name>.toml.tmp` and is renamed over the file, and a `.tmp` is never listed. A file gets the checks a request gets. A file that does not load costs only itself, as `workspace::list` has it. No error carries a brief or a file's bytes (Q5) |
| `layout.rs` | [ADR-0036](../../docs/adr/0036-the-dashboard-layout-syncs-through-the-daemon.md). It checks the shape and how an id is spelled, never whether a widget has that id: that is the browser's (Y-504). A save is refused unless its `rev` is the one on disk, and goes to `dashboard.json.tmp` renamed over the file. `replace_in` does not lock: the caller serialises calls. No error carries the file's bytes |
| `chat.rs` | [ADR-0026](../../docs/adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md) decisions 1 and 5 — T3 Code's names, the block comment that credits them, and [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md). It holds only what a source produces today, and no type in it names a provider. `PermissionMode` (Y-453) and `Interaction` (Y-565) come from the browser, as `Decision` does, and each has its own block comment that credits T3 Code |
| `tmux.rs` / `login_server.sh` | I-1 (`duplicate session:` is success), I-2 (name charset), I-4 (`remain-on-exit`), I-21 (`=name` is **session-only**), I-40 (never set `default-terminal`), I-41 (match the bracketed reason), I-42 (no tabs in `-F`), I-47/I-48 (dead-pane status *and* signal, both spellings), **I-55** (`run_shell` reports a failed command on the same stdout as its output). `running` is not `list` being empty: a `tmux -D` server with no session still answers. `login_server` sends `login_server.sh` with the path through `sq`, and maps exit 3 to *no one at the screen* (ADR-0018's 2026-11-04 amendment, Y-632). The plist keeps the job alive on every exit, because `kill-server` ends `-D` with 0. The job waits while `ls` answers and only then runs `-D`, because a second `-D` on a held socket exits 1 and KeepAlive would loop. The job's `PATH` is the login shell's, read after a marker with a 5 s bound, then each fixed directory it lacks; a capture that fails or prints no path gives the fixed `PATH` (Y-640). A plist that differs from the script's is replaced. A loaded job is booted out only while its server holds no session, because the bootout ends that server; `login_server` sends the script to an empty server for this reason, since KeepAlive never lets it end (Y-640). When the script fails, `login_server` asks again, because a failed bootstrap after the bootout leaves no server, and `up` must not start one over ssh. An absent job is installed even while a server answers, and waits in its `ls` loop, so join installs it on a Mac that already runs tmux. The script is POSIX `sh` and passes shellcheck |
| `identity.rs` | ADR-0009 (the config is the only authority on a name, so a block the owner wrote is never rewritten), and `ssh.rs`'s known-hosts half — which is why nothing here writes one. `ssh-keygen -R` in `ssh.rs` removes a line when a person asks (Y-621), and Yantra still writes none. `join_in` (ADR-0029) refuses an account or a machine that is not one plain token **before** writing, because each becomes a config line |
| `join.rs` / `join.sh` | ADR-0029. The daemon's values sit inside single quotes in a script a person pipes into `sh`, so a key holding a quote or a newline is refused. The script asks before every root step, and reads answers from `/dev/tty` because `curl \| sh` makes stdin the script. `script` puts `login_server.sh` in place of `__YANTRA_LOGIN_SERVER__`, so the Mac's LaunchAgent has one copy (Y-632) |
| `terminfo.rs` | I-36, I-43 (two terminfo databases on one machine) |
| `agent.rs` | I-23 (trust dialog), I-34 (`$HOME` is **in** this candidate list and not in tmux's), I-44 (macOS keychain — and since Y-151 the reason the gate runs *inside* the tmux server there, ADR-0018 §5), I-49 (an agent at the trust prompt is inert), **I-53** (`auth status` reports the credential it found, never that it works), I-51 (tmux's own quotes around a start command) |
| `doctor.rs` | **R-23 above all** — every branch answers *unknown* where it could not ask, and an *absent* it did not earn sends someone to install software on a box that already has it. Then, through what it calls: I-34 (`agent::locate`), I-36/I-43 (terminfo, whose *absent* is bounded by the second), I-44/I-53 and ADR-0018 §1 **and** §5 (the login-session gate, which asks `Tmux::running` rather than starting a server, so an empty `-D` server counts, Y-632; on macOS `provider-auth` asks `gh` again inside that server, and both checks name a missing server rather than a sign-out, Y-619), and `github` — the one check about **this** host, a pure mapper over `GET /user`'s answer where R-23 binds hardest: no grant and a refused grant are the two *absent*s, and a GitHub that could not be reached is *unknown*. `hooks` (Y-640) asks for each hook's program where the agent will run: inside a running server through `run_shell` (**I-55**), else over ssh on Linux, and a Mac with no server is *unknown*. Its detail carries command names and nothing else from the files (Q5). Each step that ran fills `took_ms`, and a step with nothing to ask with stays `None`, because zero would say it ran (Y-585). `REACH_LIMIT` bounds the login, so a server that holds the auth stage in words `ssh.rs` does not know still ends |
| `install.rs` | [ADR-0028](../../docs/adr/0028-yantra-installs-the-bare-minimum-on-a-machine.md) — only `BASICS`, only what is missing, and root is `sudo -n` and nothing more: no password is asked for, passed or stored. It asks the predicates `doctor` reports on, so the two never disagree about what a machine has. I-26 through `ssh.rs`: every value it sends is a constant or goes through `sq`. The vendor's command is a parameter of `of`, so no test fetches from claude.ai. The microphone ([ADR-0031](../../docs/adr/0031-the-microphone-reaches-a-machine-as-a-virtual-source.md)) is a step only when asked for, and its card list is a parameter for the same reason: a container has no card |
| `github.rs` | §B4 through [ADR-0023](../../docs/adr/0023-the-github-grant-lives-beside-the-relay.md) — the token is a value on disk in one file and nowhere else, `Token` and `Device` print none of what they hold, and no error carries either; every spawn in this crate removes `SECRETS`, so no child inherits the token or the relay (Y-647); I-13 (every send on a blocking thread). `Forge` is still the seam the daemon and the tests are written against |
| `status.rs` | I-47/I-48 through `tmux.rs`, and **I-49** — the trust state is read from the pane's *screen*, and only in the branch where the two sources already disagree |
| `logs.rs` | I-45 (`stat -c` vs `stat -f`), I-46 (the transcript is a journal, not a log). `newest` is how `claude.rs` finds the conversation to resume, by the same slug |
| `extract.rs` | **I-46** (a `user` record with a tool result, `isMeta`, `isCompactSummary` or `isVisibleInTranscriptOnly` is not an owner message) and **I-61** (one response is several records, so it is grouped by `message.id`). Through `history.rs`, the `Scan` seam: the re-scan fails closed, so a missing or failed gitleaks writes nothing, and a finding in no row drops every row of its transcript. No row text is logged or put in an error (Q5) |
| `tokens.rs` | I-46 through `logs.rs`, whose `locate` finds the same file — then the journal's own two arithmetic traps: **I-61**, one API response written once per content block, so a sum per record double-counts and each record names the counts twice (its totals, then `iterations`); and **I-62**, which is what the three fields read for `price.rs` are guarding — `model` occurs again as a tool call's argument, and a cache write cannot be priced without knowing whether it was bought for five minutes or an hour |
| `price.rs` | **I-62**'s second half, and one rule of its own: `AS_OF` moves in the same edit as a rate. A table written into a binary is wrong the day a price changes, and the printed date is the only thing that says so. A cache read is a quoted figure on each row, never a multiplier. `billed_as` picks Haiku 5.5's card per response, so `tokens.rs` calls it before the counts are summed |
| `workspace.rs` | ADR-0007 `deny_unknown_fields`, ADR-0009, ADR-0010, **I-57** (`InvalidName`'s path is built, not read) |
| `up.rs` / `resume.rs` | I-1 through `tmux.rs`, and **I-44** — on macOS `up` never starts a server over ssh (ADR-0018 §1): with no session held, `Tmux::login_server` loads or refreshes the LaunchAgent, and `NoLoginServer` means only that no one is logged in at the screen (Y-632), and **I-56**, the window between that check and `tmux.ensure`. The far side's OS is a *parameter* of the generic half, so the branch is drivable from a Linux container |
| `edit.rs` | **I-30** — a session the field no longer points at is one every later verb reports as absent, and absence is success |
| `inventory.rs` | I-5 (the stable id is the only safe key), **I-52** (`whois` and `status` spell that id, and the owner, differently) |
| `heartbeat.rs` | ADR-0013 `deny_unknown_fields`, **I-9** (unknown power is unrepresentable, not a convention) |
| `placement.rs` | **I-10** — every term that moves the rank is in `Terms`, and the score is their sum. ADR-0013 §2: power is a score term and never a filter. ADR-0013 §7: the only filter is a beat that *arrived* within 30 s, and a rejection names which of its three reasons applies. The block comment and [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) credit T3 Code ([ADR-0026](../../docs/adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md) decision 5) |
| `notify.rs` | **I-49** through `status.rs` — the trust dialog is the notification that matters — and I-47's lesson one layer up: a machine that could not be asked keeps what it had, because unknown is not changed. **I-59** is the hole this leaves ([`yantrad/tracker.md`](../yantrad/tracker.md)). §B4 binds the other half (Y-147): the relay's URL and token are read from the environment and from nowhere else, and the body is the caller's — nothing here composes a workspace's resolved secret into one. Each notification has one of six phases with a fixed `Title`, a failed run sends a fixed string, and the block comment and [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) credit T3 Code (Y-451) |

**Every script sent to a machine must parse under bash 3.2 and dash, alone and inside `c=$(…)`.**
macOS's bash 3.2 ends a `$(…)` at an unpaired `)`, so a case pattern opens with `(` (Y-634).
`shells.rs` checks every script in one container (Y-635), and with the Mac's own `/bin/bash`, `/bin/sh` and `/bin/dash` on CI's macos runner (Y-661). A new script must reach its `Recorder` or its builder list. A script behind a branch also goes in `REACHED`, so the test fails when no pass takes that branch.

## What `yantra-agent` may call

`heartbeat.rs` and `agent::CANDIDATES` — a type and a `const`, neither of which links any code.
That agent must stay tiny (R-12). The *dependency edge* is nearly free — 11 KB, measured — and the
**call graph** is not: one further call into ssh/tmux costs +319 KB, a 65 % jump, because
`lto = "thin"` only strips what nothing reaches. So the thing to guard is the next `use`, not the
`Cargo.toml` line.

`CANDIDATES` is shared rather than copied because the agent's label probe hits I-34's wall for
`docker` and `tmux` exactly as `claude` does. Two lists that drifted would produce a fleet where one
binary is found and the other is not, which is the bug I-34 exists to name.

**`ureq` is in this crate and `notify.rs` and `github.rs` are the only things that reach it** (Y-146,
Y-342), which is the sharpest measurement of that rule so far. Adding the dependency and calling nothing changed all three
aarch64-musl binaries by **exactly zero bytes**; calling it from the daemon cost `yantrad`
**+1,137,016 bytes (+48.6 %)** while `yantra` and `yantra-agent`, which do not, paid 1,632 and 600.
The cost is TLS: `rustls`, `ring` and a bundled Mozilla root store, which a static musl binary has to
carry because the appliance image is not promised a system trust store. Anything here that grows a
`use ureq` outside `notify.rs` is spending that budget again somewhere it was not weighed.

**Y-147 spent it again without adding a `use`**, which is the part worth reading twice: `yantra
notify` put the CLI into the same call graph and `yantra` went **1,256,496 → 2,451,504 bytes
(+1,195,008, +95.1 %)**, while `yantrad` moved 1,712 for an environment read and `yantra-agent` came
out at **exactly** the byte count it started at for the third measurement running. So the budget is
per *binary that reaches this module*, not per crate and not per import — a second caller pays the
whole bill, and the question to ask of the next one is whether that caller needs to send from itself.

## Anything that reaches a remote shell

Quote it with `tmux::sq`, or send it as a value the shell never parses. A workspace's `repo` and
`machine` come from a file on disk, so they are a code-execution boundary, not user convenience.

**A file gets the same refusals a request gets.** `workspace::parse` asks `blank_field`, which is the
one predicate `create` and `update` ask, so a workspace `create` would not write is one `load` will
not read (Y-137, after Y-119 closed the writing half alone). The consequence to know before changing
it: `yantra edit` cannot repair such a file, because `update` loads before it writes — which is true
of a mistyped key too.

**`repair` is the one write that skips the field checks, and
[ADR-0020](../../docs/adr/0020-a-raw-write-only-from-broken-to-valid.md) is the only reason it is
safe to have.** Two bounds, and they are the whole of it: it refuses a file that parses
(`Error::Loads`), and it refuses bytes that do not, with the next error named. Together they mean it
can move a file from broken to valid and nowhere else. **It asks `broken`, which asks `parse`** — so
the raw path and the reading path share one predicate, exactly as `create` and `load` do, and a
third answer to *is this file usable* cannot appear. Nothing else may be written raw, and `create`
is still the only way a workspace comes into being: a file that is not there is `NotFound`.

**A file that does not load costs only itself** (Y-141). `list` returns a `Listing`: the workspaces
that loaded, and every file that did not under its name with its reason. The outer `Result` is still
there and is about the *directory* — no config dir, a directory that cannot be read — because none of
those says which workspaces exist. Two rules bind anything reading it: a caller that wants workspaces
takes `.workspaces` and never sees past `.unusable` (`status::fleet` carries them to the top of what
it returns, since a file with no machine belongs to no `MachineStatus`), and **whatever displays a
listing names the failures rather than dropping them** — below the table, never as a row in it, since
every column a row has is something to act on and a broken file has none of them.

Two things a test cannot check by searching the output: correctly-escaped text still *contains* the
payload, inside quotes. Assert the exact string, and prove the behaviour on a real `/bin/sh` in a
container test. `tests/agent.rs` does both — copy that shape.

## Talking to someone else's program

`tailscale`, `tmux`, `claude` and `ssh` all emit formats they are free to change.

- **Tolerate unknown fields** in their output (`inventory`, `agent`, `logs`) — the opposite of
  `workspace`, which denies them, because that one is *our* schema and a typo there is a bug.
- **Name only the fields you act on.** `agent::Status` reads two fields from `claude auth status`
  and the command prints six; the four it does not name include an email address and an org id, and
  not naming them is how they never reach a log line. That is a privacy boundary, not tidiness.
- **Never trust a version number to imply behaviour.** The same tmux 3.7b prints a signal as `15` on
  Linux and `term` on macOS (I-48).

## Tests

Unit tests inline in `#[cfg(test)]`; anything touching ssh or tmux goes in `tests/` against a real
sshd and a real tmux in a podman container (root §B3). `tests/common/mod.rs` is the fixture — it
generates a keypair per run, passes `-F /dev/null`, and tears down in `Drop`.

- **A skipped test must be able to fail.** `YANTRA_REQUIRE_PODMAN=1` turns "podman is missing" from
  a skip into an error, and `just test-ci` sets it (I-32).
- `#[ignore]` is for tests needing the tailnet or the MacBook — `just test-mac <machine>`. Ignored,
  never silently skipped. `tests/macos.rs` is ignored too, and CI's `macos` job runs it with
  `just test-macos` on a GitHub runner that sshes to itself (Y-661). It kills the tmux server, so
  it never targets the owner's Mac.
- **Produce the state, do not describe it.** A test that hand-builds a dead pane cannot see I-47;
  one that really runs `kill -9` can.
- `portable-pty` is a **dependency**, reached by `pty.rs` alone. Y-128 measured `just appliance-size`
  either side of the move: `yantra-agent` came out sixteen bytes *smaller*, and the two binaries that
  do not call it grew about 0.15 %. The edge is nearly free here too — it is the next `use` that
  costs, exactly as above.

## Adding a module

The shape every orchestration module already has, and the one to copy:

```rust
pub async fn thing(name: &str) -> Result<Report, Error>   // loads the workspace, opens ssh
pub async fn of<E: Exec>(exec: &E, …) -> Result<Report, Error>  // the testable half
```

The generic half is what the container tests drive. Keep the split.
