# yantra-core

The orchestration logic behind Yantra: reach a machine over SSH, open a tmux session on it, launch
and watch a coding agent, read the Tailscale inventory.

It is a library, and it never prints or exits — callers decide how to report things
([ADR-0005](../../docs/adr/0005-core-logic-in-a-library-crate.md)). The `yantra` CLI calls it
in-process today; the daemon will call the same functions over HTTP.

## What it does

```rust
use yantra_core::{up, logs, status, down};

let report = up::up("yantra", "xterm-256color", Some(up::Agent::Claude)).await?;
let recent = logs::logs("yantra", 20).await?;
let state  = status::status("yantra").await?;
let ending = down::down("yantra").await?;
```

Each of those loads `~/.config/yantra/workspaces/<name>.toml`, opens an SSH connection, and does one
thing. Each also has a generic half that takes any `Exec`, which is what the tests drive.

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
