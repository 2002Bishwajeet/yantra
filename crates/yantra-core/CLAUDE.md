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
| `ssh.rs` | I-20 (system binary), I-25 (silent failure), I-26 (payload is base64, never quoted), I-27 (orphans), I-28 (`ControlPath` ≤ 90 bytes) |
| `pty.rs` | I-18 (a controlling terminal, or no resize), I-13 (never block a tokio worker), I-27 (a remote *terminal* is hung up where a remote command is orphaned), and `ssh.rs`'s whole list through `Ssh::tty_argv` — **except I-26**: the envelope's `/bin/sh` reads from a pipe, which is the one stdin tmux refuses — and **I-54**, which is why a second viewer needs no tmux option, and since Y-394 `run`, which hands the far login shell `/bin/sh -c` and the command in single quotes (I-35) and runs only a command an install left ([ADR-0030](../../docs/adr/0030-a-one-off-terminal-runs-only-a-command-an-install-left.md)) |
| `acp.rs` | `ssh.rs`'s list through `Ssh::stdio`, the fourth call shape: **I-20** (the same socket), **I-26**/**I-35** (the command is still base64, but sent as `exec /bin/sh -c 'exec /bin/sh -c "$(… \| base64 -d)"'`, because the envelope's pipe would become the agent's stdin, and the single quotes keep the expansion from a csh or fish login shell), **I-63** (`--` before the name). Then [ADR-0033](../../docs/adr/0033-other-harnesses-speak-acp-and-claude-delegates.md) decision 2: **no ACP v1 shape leaves this module** — method names, `session/load`, the prompt result and the diff shape — because v2 changes all of them. The client advertises no `fs` and no `terminal`, and answers either with -32601. `rawInput` and `rawOutput` carry file contents, so they are never named |
| `mic.rs` | `ssh.rs`'s list through `Ssh::stdio`, as `acp.rs` has it: **I-20** (the same socket), **I-26**/**I-35** (the command is base64, sent as `exec /bin/sh -c …`), **I-63** (`--` before the name). Then [ADR-0031](../../docs/adr/0031-the-microphone-reaches-a-machine-as-a-virtual-source.md) §5: `WRITER` is the ADR's command verbatim, there is no pty because a pty changes bytes, and **a `Stream` keeps no buffer and never logs or formats a payload** (Q5). §7's laptop half: `RECORDER` is the ADR's `pw-record` flags, and `relay` holds one chunk and never looks inside it. `record` and `Ssh::stdio_detached` each start their child in its own process group, and `Ssh::stdio` leaves ACP and chat in the caller's, so a terminal's Ctrl-C reaches `yantra` alone and `close` can still drain `pw-cat` |
| `image.rs` | `ssh.rs`'s list through `Ssh::stdio`: **I-20** (the bytes ride the same socket, on stdin), **I-26**/**I-35** (the command is base64), and **I-24**: the only name in the command is the counter `put` generates, and the extension is read from the magic bytes, never from the browser. The directory is `${TMPDIR:-/tmp}/yantra-chat-<id>`, outside every repository and worktree, and `remove` deletes it. No image byte or size is logged or formatted (Q5) |
| `delegate.rs` | `acp.rs`'s list, and `ssh.rs`'s through `Exec`: every path reaches the shell through `sq`, and a `repo` of `~/…` through `clone::destination`. [ADR-0033](../../docs/adr/0033-other-harnesses-speak-acp-and-claude-delegates.md) decision 4: the worktree exists **before** the agent starts, and a worktree whose agent did not start is removed. `progress` never asks the machine, because the daemon serves it on a `GET` the main agent polls |
| `thread.rs` | `delegate.rs`'s list, through the worktree code it shares with it: every path reaches the shell through `sq`, and a `repo` of `~/…` through `clone::destination`. [ADR-0026](../../docs/adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md)'s 2026-10-06 amendment picks isolate: a thread's worktree is never the repository. **Ending a session deletes nothing; only `remove` does.** `list` reads git, not memory, so a thread outlives a daemon restart. `remember`/`recall` keep an ACP thread's harness and session in git config under its branch, so the daemon still keeps nothing |
| `claude.rs` | `acp.rs`'s list through `Ssh::stdio`, and its own rule: **no stream-json shape leaves this module**. A turn is one `claude -p` in a thread's worktree, `--resume` names the newest transcript there, and the daemon keeps no session id ([R20](../../docs/research/20-claude-stream-json-turn.md)). `cancel` refuses what is waiting, sends `interrupt` and closes stdin, because dropping the local `ssh` leaves the remote `claude` running (I-27). A tool's input is read for its target alone, and no prompt, reply or output is logged |
| `chat.rs` | [ADR-0026](../../docs/adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md) decisions 1 and 5 — T3 Code's names, the block comment that credits them, and [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md). It holds only what a source produces today, and no type in it names a provider |
| `tmux.rs` | I-1 (`duplicate session:` is success), I-2 (name charset), I-4 (`remain-on-exit`), I-21 (`=name` is **session-only**), I-40 (never set `default-terminal`), I-41 (match the bracketed reason), I-42 (no tabs in `-F`), I-47/I-48 (dead-pane status *and* signal, both spellings), **I-55** (`run_shell` reports a failed command on the same stdout as its output) |
| `identity.rs` | ADR-0009 (the config is the only authority on a name, so a block the owner wrote is never rewritten), and `ssh.rs`'s known-hosts half — which is why nothing here writes one. `join_in` (ADR-0029) refuses an account or a machine that is not one plain token **before** writing, because each becomes a config line |
| `join.rs` / `join.sh` | ADR-0029. The daemon's values sit inside single quotes in a script a person pipes into `sh`, so a key holding a quote or a newline is refused. The script asks before every root step, and reads answers from `/dev/tty` because `curl \| sh` makes stdin the script |
| `terminfo.rs` | I-36, I-43 (two terminfo databases on one machine) |
| `agent.rs` | I-23 (trust dialog), I-34 (`$HOME` is **in** this candidate list and not in tmux's), I-44 (macOS keychain — and since Y-151 the reason the gate runs *inside* the tmux server there, ADR-0018 §5), I-49 (an agent at the trust prompt is inert), **I-53** (`auth status` reports the credential it found, never that it works), I-51 (tmux's own quotes around a start command) |
| `doctor.rs` | **R-23 above all** — every branch answers *unknown* where it could not ask, and an *absent* it did not earn sends someone to install software on a box that already has it. Then, through what it calls: I-34 (`agent::locate`), I-36/I-43 (terminfo, whose *absent* is bounded by the second), I-44/I-53 and ADR-0018 §1 **and** §5 (the login-session gate, which asks whether a server exists rather than starting one), and `github` — the one check about **this** host, a pure mapper over `GET /user`'s answer where R-23 binds hardest: no grant and a refused grant are the two *absent*s, and a GitHub that could not be reached is *unknown* |
| `install.rs` | [ADR-0028](../../docs/adr/0028-yantra-installs-the-bare-minimum-on-a-machine.md) — only `BASICS`, only what is missing, and root is `sudo -n` and nothing more: no password is asked for, passed or stored. It asks the predicates `doctor` reports on, so the two never disagree about what a machine has. I-26 through `ssh.rs`: every value it sends is a constant or goes through `sq`. The vendor's command is a parameter of `of`, so no test fetches from claude.ai. The microphone ([ADR-0031](../../docs/adr/0031-the-microphone-reaches-a-machine-as-a-virtual-source.md)) is a step only when asked for, and its card list is a parameter for the same reason: a container has no card |
| `github.rs` | §B4 through [ADR-0023](../../docs/adr/0023-the-github-grant-lives-beside-the-relay.md) — the token is a value on disk in one file and nowhere else, `Token` and `Device` print none of what they hold, and no error carries either; I-13 (every send on a blocking thread). `Forge` is still the seam the daemon and the tests are written against |
| `status.rs` | I-47/I-48 through `tmux.rs`, and **I-49** — the trust state is read from the pane's *screen*, and only in the branch where the two sources already disagree |
| `logs.rs` | I-45 (`stat -c` vs `stat -f`), I-46 (the transcript is a journal, not a log). `newest` is how `claude.rs` finds the conversation to resume, by the same slug |
| `tokens.rs` | I-46 through `logs.rs`, whose `locate` finds the same file — then the journal's own two arithmetic traps: **I-61**, one API response written once per content block, so a sum per record double-counts and each record names the counts twice (its totals, then `iterations`); and **I-62**, which is what the three fields read for `price.rs` are guarding — `model` occurs again as a tool call's argument, and a cache write cannot be priced without knowing whether it was bought for five minutes or an hour |
| `price.rs` | **I-62**'s second half, and one rule of its own: `AS_OF` moves in the same edit as a rate. A table written into a binary is wrong the day a price changes, and the printed date is the only thing that says so |
| `workspace.rs` | ADR-0007 `deny_unknown_fields`, ADR-0009, ADR-0010, **I-57** (`InvalidName`'s path is built, not read) |
| `up.rs` / `resume.rs` | I-1 through `tmux.rs`, and **I-44** — on macOS `up` refuses when no tmux server is running rather than starting one (ADR-0018 §1), and **I-56**, the window between that check and `tmux.ensure`. The far side's OS is a *parameter* of the generic half, so the branch is drivable from a Linux container |
| `edit.rs` | **I-30** — a session the field no longer points at is one every later verb reports as absent, and absence is success |
| `inventory.rs` | I-5 (the stable id is the only safe key), **I-52** (`whois` and `status` spell that id, and the owner, differently) |
| `heartbeat.rs` | ADR-0013 `deny_unknown_fields`, **I-9** (unknown power is unrepresentable, not a convention) |
| `placement.rs` | **I-10** — every term that moves the rank is in `Terms`, and the score is their sum. ADR-0013 §2: power is a score term and never a filter. ADR-0013 §7: the only filter is a beat that *arrived* within 30 s, and a rejection names which of its three reasons applies. The block comment and [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) credit T3 Code ([ADR-0026](../../docs/adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md) decision 5) |
| `notify.rs` | **I-49** through `status.rs` — the trust dialog is the notification that matters — and I-47's lesson one layer up: a machine that could not be asked keeps what it had, because unknown is not changed. **I-59** is the hole this leaves ([`yantrad/tracker.md`](../yantrad/tracker.md)). §B4 binds the other half (Y-147): the relay's URL and token are read from the environment and from nowhere else, and the body is the caller's — nothing here composes a workspace's resolved secret into one |

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
  never silently skipped.
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
