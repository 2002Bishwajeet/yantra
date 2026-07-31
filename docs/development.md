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
crates/yantra-core     the orchestration logic - everything Yantra actually does
crates/yantrad         the control-plane daemon
crates/yantra          the CLI  (the daemon's first client)
crates/yantra-agent    per-machine heartbeat agent
docs/adr/              architecture decisions - immutable once accepted
docs/research/         dated evidence behind those decisions
tracker.md             single source of truth for project state
crates/*/tracker.md    the invariants binding each crate
```

`yantra-core` is a library; the other three are thin binaries around it. Two rules
apply inside it and nowhere else: it **never prints and never exits**, and its
`pub` surface stays small. See [ADR-0005](adr/0005-core-logic-in-a-library-crate.md).

## Daily commands

```bash
just              # list every recipe
just check        # the gate: fmt + clippy + tests + deny. Run before every push.
just ci           # everything CI runs: check + the arm64 cross-build
just fmt          # apply formatting
just test         # tests only
just deny         # licence + advisory audit
just appliance    # cross-compile arm64 binaries for the Pi 5
```

`just ci` is exactly what CI runs — the workflow in `.github/workflows/ci.yml`
invokes these same recipes rather than its own copy of the commands, one recipe
per job, so the two cannot silently drift. If you add a check, add it to the
`justfile` first and give it a job second.

`check` is the fast subset to run before every push; `ci` additionally
cross-compiles for the appliance, which CI does on a runner anyway.

## Testing

**Mocks lie about SSH.** Orchestration primitives are tested against a real
`sshd` and a real `tmux`, in a throwaway podman container. The container is a
truer stand-in for a remote machine than `ssh localhost` — separate filesystem,
separate user, real network hop — and it leaves nothing running on your box.

Unit-test pure logic (placement scoring, config parsing) freely. Anything that
touches SSH, tmux, or an agent CLI gets an integration test against the real thing.

The fixture is `crates/yantra-core/tests/common/mod.rs`. Its image is built from
`crates/yantra-core/tests/fixture/Containerfile` (Alpine + `openssh-server` +
`tmux`, ~12 MB) the first time a test needs it, then reused. Each run generates
its own throwaway keypair and publishes sshd on an ephemeral loopback port —
your `~/.ssh` is never read — and the container is removed in `Drop`, so it goes
away even when a test panics.

```bash
just test                                   # the fixture runs as part of the suite
podman ps -a --filter label=yantra-fixture  # must be empty afterwards
```

Without `podman` the test prints `SKIPPED:` and passes, so a machine that cannot
run containers is not blocked. CI sets `YANTRA_REQUIRE_PODMAN=1` (via
`just test-ci`), which turns that skip into a failure — a silent skip there
would mean the test had stopped checking anything.

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

These are the short version. The full list with evidence is in the crate trackers —
mostly [`crates/yantra-core/tracker.md`](../crates/yantra-core/tracker.md) — and each
one is there because it already caught somebody out.

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
