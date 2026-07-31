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

**[`tracker.md` §1b](../../tracker.md)** — 46 live invariants, numbered to I-49, most of them earned
by a bug that looked like something else. They are not style notes. Which ones bind where:

| Module | Invariants you will trip over |
| --- | --- |
| `ssh.rs` | I-20 (system binary), I-25 (silent failure), I-26 (payload is base64, never quoted), I-27 (orphans), I-28 (`ControlPath` ≤ 90 bytes) |
| `tmux.rs` | I-1 (`duplicate session:` is success), I-2 (name charset), I-4 (`remain-on-exit`), I-21 (`=name` is **session-only**), I-40 (never set `default-terminal`), I-41 (match the bracketed reason), I-42 (no tabs in `-F`), I-47/I-48 (dead-pane status *and* signal, both spellings) |
| `terminfo.rs` | I-36, I-43 (two terminfo databases on one machine) |
| `agent.rs` | I-23 (trust dialog), I-34 (`$HOME` is **in** this candidate list and not in tmux's), I-44 (macOS keychain), I-49 (an agent at the trust prompt is inert) |
| `logs.rs` | I-45 (`stat -c` vs `stat -f`), I-46 (the transcript is a journal, not a log) |
| `workspace.rs` | ADR-0007 `deny_unknown_fields`, ADR-0009, ADR-0010 |

## Anything that reaches a remote shell

Quote it with `tmux::sq`, or send it as a value the shell never parses. A workspace's `repo` and
`machine` come from a file on disk, so they are a code-execution boundary, not user convenience.

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

## Adding a module

The shape every orchestration module already has, and the one to copy:

```rust
pub async fn thing(name: &str) -> Result<Report, Error>   // loads the workspace, opens ssh
pub async fn of<E: Exec>(exec: &E, …) -> Result<Report, Error>  // the testable half
```

The generic half is what the container tests drive. Keep the split.
