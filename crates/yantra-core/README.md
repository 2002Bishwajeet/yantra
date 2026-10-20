# yantra-core

The orchestration logic behind Yantra: reach a machine over SSH, open a tmux session on it, launch
and watch a coding agent, read the Tailscale inventory.

It is a library, and it never prints or exits — callers decide how to report things
([ADR-0005](../../docs/adr/0005-core-logic-in-a-library-crate.md)). The `yantra` CLI calls it
in-process today; the daemon will call the same functions over HTTP.

## What it does

```rust
use yantra_core::{up, resume, logs, status, down, edit, workspace};

let report = up::up("yantra", "xterm-256color", Some(up::Agent::Claude)).await?;
let again  = resume::resume("yantra", "xterm-256color").await?;
let recent = logs::logs("yantra", 20).await?;
let state  = status::status("yantra").await?;
let ending = down::down("yantra").await?;
let moved  = edit::edit("yantra", &workspace::Changes {
    machine: Some("bishwajeets-macbook-pro".into()),
    ..Default::default()
}).await?;   // refused while a session is open on the machine it would leave
```

`delegate::Task` is the one that does not load a workspace: it takes an `Ssh`, a harness, a
repository and a prompt, and runs an ACP agent in a new git worktree of that repository (ADR-0033).
`thread` gives a chat session the same kind of worktree, on `yantra/chat/<workspace>/<id>`: the
chat edits there while the workspace's TUI keeps the repository. Ending a session deletes nothing;
`thread::remove` does. `claude::Turn` is one chat turn in that worktree: `claude -p` over
stream-json, resumed from the newest transcript there, with permission requests answered on its
stdin. A thread for any other harness runs an ACP agent there instead, and `thread::remember` keeps
its harness and session id in git config under the thread's branch. `keep` holds either kind of agent on its machine, in a tmux session that journals
its input and output, so a turn outlives its ssh pipe and the daemon
([ADR-0035](../../docs/adr/0035-a-chat-turn-outlives-its-ssh-pipe.md)). `thread::start` opens a
thread from a GitHub issue and keeps the issue there too; `thread::threads` lists each thread with
its issue and the PR its upstream has (Y-488). `checkpoint` keeps the
thread's tree after each turn under a hidden ref, diffs one turn, diffs the whole branch against
the newest commit it shares with its start or `HEAD`, and reverts the files to a checkpoint; no
branch moves. `commit`
commits a thread's work with the machine's own git identity, with a message `claude -p` writes
there, and pushes its branch and sets the upstream (Y-492). It also opens a PR from the pushed
branch to the default branch with the daemon's GitHub grant, or answers the one already open (Y-449).

Each of those loads `~/.config/yantra/workspaces/<name>.toml`, opens an SSH connection, and does one
thing. Each also has a generic half that takes any `Exec`, which is what the tests drive.

`room` reaches no machine either. It holds the rooms that live agents talk in, as pure logic with
an injected clock: the ring of messages, the members and their cursors, the turn budget, and the
`<room>` wrapper a receiver reads. It also defines the two MCP tools, `room_send` and `room_read`,
and their argument checks, so `yantrad` and `yantra mcp` list the same tools
([ADR-0038](../../docs/adr/0038-rooms-and-guest-devices.md)).

`history::stage()` is the exception: it reaches no machine. It writes a redacted copy of this
account's agent transcripts for Syncthing to send to the appliance
([ADR-0032](../../docs/adr/0032-the-appliance-keeps-the-conversation-history-encrypted.md)).

## Why it looks the way it does

Yantra orchestrates `ssh`, `tmux`, `tailscale` and `claude` rather than reimplementing them, so most
of this crate is about talking to other people's programs carefully. The `//!` header on each module
explains the specific reason it is shaped that way — usually a bug that presented as something else.

## Tests

Unit tests run anywhere. Anything touching SSH or tmux runs against a **real** sshd and a **real**
tmux in a disposable podman container, because a mocked SSH only ever tests the mock.

```sh
just test          # skips the container tests if podman is missing
just test-ci       # fails instead of skipping — what CI runs
just test-mac <machine>   # the handful that need a real remote machine
```

## More

- [llms.txt](llms.txt) — a map of the crate
- [CLAUDE.md](CLAUDE.md) — the rules that bind changes here
- [tracker.md](tracker.md) — the invariants that bind this crate
- [../../tracker.md](../../tracker.md) — project state, milestones and open tasks
