# Local development

How to get Yantra building and running on your machine. For *how to contribute*
(branches, PRs, commit style) see `CONTRIBUTING.md`. For *what to work on*, see
[`../tracker.md`](../tracker.md) — always read that first.

## Prerequisites

Arch / CachyOS:

```bash
sudo pacman -S --needed rustup just zig mold podman
rustup default stable
rustup target add aarch64-unknown-linux-musl
cargo install --locked cargo-zigbuild cargo-deny cargo-nextest
```

Other distros: same set, plus `rustup` from <https://rustup.rs>. The toolchain
version itself is pinned by `rust-toolchain.toml` — don't override it.

| Tool | Why it's needed |
| --- | --- |
| `rustup` | Toolchain. Distro `rust` packages can't add the musl target. |
| `just` | Task runner — every command below is a `just` recipe. |
| `zig` + `cargo-zigbuild` | Cross-compiles the appliance target without a container. |
| `mold` | Linker. Cuts the slowest part of the edit-compile loop. |
| `cargo-nextest` | Test runner with real per-test process isolation — needed because tests spawn actual `ssh` and `tmux`. |
| `cargo-deny` | Licence and advisory checks. |
| `podman` | Runs the sshd test fixture. Docker works too if you prefer. |

You do **not** need to run `sshd` on your own machine. Integration tests use a
disposable container — see [Testing](#testing).

## Layout

```
crates/yantrad         the control-plane daemon
crates/yantra          the CLI  (the daemon's first client)
crates/yantra-agent    per-machine heartbeat agent
docs/adr/              architecture decisions - immutable once accepted
docs/research/         dated evidence behind those decisions
tracker.md             single source of truth for project state
```

## Daily commands

```bash
just              # list every recipe
just check        # the gate: fmt + clippy + tests. Run before every push.
just fmt          # apply formatting
just test         # tests only
just deny         # licence + advisory audit
just appliance    # cross-compile arm64 binaries for the Pi 5
```

`just check` is exactly what CI runs. If they ever disagree, that's a bug — fix
the divergence rather than working around it.

## Testing

**Mocks lie about SSH.** Orchestration primitives are tested against a real
`sshd` and a real `tmux`, in a throwaway podman container. The container is a
truer stand-in for a remote machine than `ssh localhost` — separate filesystem,
separate user, real network hop — and it leaves nothing running on your box.

Unit-test pure logic (placement scoring, config parsing) freely. Anything that
touches SSH, tmux, or an agent CLI gets an integration test against the real thing.

## Cross-compiling for the appliance

```bash
just appliance
file target/aarch64-unknown-linux-musl/release/yantrad
# ELF 64-bit LSB executable, ARM aarch64, statically linked, stripped
```

~330 KB per binary, statically linked, no runtime on the target. If this stops
working, say so loudly — [ADR-0004](adr/0004-rust-for-the-daemon.md) chose Rust
partly on the strength of it.

## Gotchas that will cost you an afternoon

These are the short version. The full list with evidence is `tracker.md` §1b, and
each one is there because it already caught somebody out.

- **tmux:** create sessions with plain `new-session -d` and treat
  `duplicate session:` as success. `new-session -A -d` is broken when called from
  a non-TTY daemon, and `has-session || create` is a race.
- **tmux targets:** `=name` works for session-level commands but **not** as a pane
  target. Capture the `pane_id` (`%N`) at creation and address panes by that.
- **Never pipe an agent's stdout** (`claude ... | tee`). It destroys TTY detection
  and the agent silently switches to non-interactive mode. Log with `pipe-pane`.
- **`remain-on-exit on`**, always. Without it a crashed pane vanishes and "crashed"
  is indistinguishable from "finished".
- **SQLite:** set `busy_timeout` and `journal_mode = WAL` explicitly on every
  connection. Bindings default the timeout to 0, which surfaces as random
  `SQLITE_BUSY` that looks like a network fault.

## Optional: local agent skills

Rust reference skills can be installed for AI agents working in this repo:

```bash
npx skills add wshobson/agents@rust-async-patterns -y
npx skills add apollographql/skills@rust-best-practices -y
npx skills add affaan-m/everything-claude-code@rust-testing -y
```

They land in `.claude/skills/` and are **gitignored** — local tooling, not part of
the project. They are documentation only (no scripts), but skills run with full
agent permissions, so review anything you add.
