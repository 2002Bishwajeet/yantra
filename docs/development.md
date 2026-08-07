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
just fixtures     # rewrite web/src/contract.gen.ts after a DTO moves
just appliance    # cross-compile the appliance binaries (arm64 by default)
just appliance-runtime  # idle RSS, idle CPU and CLI cold-start, on this machine
```

`just fixtures` is the one recipe you run *because* a test told you to: `just
test` compares `web/src/contract.gen.ts` against what `/api` now answers, and a
DTO that moved without it fails there. See
[`crates/yantrad/CLAUDE.md`](../crates/yantrad/CLAUDE.md).

`just ci` is exactly what CI runs — the workflow in `.github/workflows/ci.yml`
invokes these same recipes rather than its own copy of the commands, one recipe
per job, so the two cannot silently drift. If you add a check, add it to the
`justfile` first and give it a job second.

`check` is the fast subset to run before every push; `ci` additionally
cross-compiles for the appliance, which CI does on a runner anyway.

## Running the dashboard

Two ways, and they are for different jobs.

**Developing the UI** — Vite, with hot reload, proxying the API across to the daemon:

```bash
cargo run --bin yantrad          # one terminal
npm --prefix web run dev         # another; open the URL it prints
```

**Looking at the dashboard from anywhere else**, which is what a phone needs — `yantrad` serves the
built assets itself, from one origin, so there is no CORS and no second process:

```bash
npm --prefix web run build
YANTRA_WEB=$PWD/web/dist cargo run --bin yantrad
```

`YANTRA_WEB` is a directory of **built** assets. Unset it and the daemon serves the API alone and
says so on `/`; point it somewhere with no `index.html` and it refuses to start rather than answering
404 to every request, which reads as a broken dashboard instead of a wrong path.

**A directory that vanishes *after* start is the same mistake one step later** — a `YANTRA_WEB`
pointing into a git worktree that was then removed, which is how M6's acceptance run found it. The
daemon keeps serving the API, the heartbeat and the terminal socket, and every request for the
dashboard answers **503** naming the path and saying how, with one line in the journal the first time
and another when the directory comes back.

**The default build embeds nothing**, and that is R-24: a build that wants `web/dist`
unconditionally makes every `fmt`, `clippy`, `test` and cross-build job depend on npm.

The M7 appliance is the one thing that wants a single file to copy, and it gets it from a cargo
feature that is **absent from `default`** (Y-140):

```bash
just appliance-embedded    # npm build, then yantrad --features embed-dashboard for the Pi 5
just test-embedded         # the feature's own tests; `just test` cannot reach them
```

Both need npm and neither is reachable from `just check` or `just ci`, the same rule the
`landing-*` recipes follow. **`just no-node` is what holds the line** — it is part of `check`, it
greps every recipe the Rust gate runs and `ci.yml` itself for the feature, for `--all-features` and
for npm, and it fails if the default dependency graph ever carries `include_dir`. A green build says
nothing about *which* jobs needed npm to get there, which is why the assertion is a negative one.

**`just build-without-node` is the other half, and it runs rather than reads** (Y-148). It writes
stubs for `node`, `npm` and `npx` that exit non-zero, puts them first on `PATH`, and runs `just build
lint` behind them, so a `build.rs` that shells out by name reds the build instead of passing quietly
on a runner that happens to ship Node. It is CI-only, like `test-ci` — `ci.yml` runs it on every pull
request and `no-node` fails if that job ever disappears — but it takes no arguments and no fixture,
so run it by hand whenever a build script or a proc macro is what you are changing.

**`YANTRA_WEB` still wins over the embedded copy, and a wrong one still refuses.** A binary that
carries a dashboard does not quietly serve it over a directory you named and mistyped — the variable
is the half a person can get wrong, so it keeps the refusal.

## Notifications

Two environment variables, read by `yantrad` at startup and by `yantra notify` per run:

```bash
export YANTRA_NTFY_URL=https://ntfy.sh/<topic>   # where to publish
export YANTRA_NTFY_TOKEN=tk_...                  # only if the topic is protected

yantra notify 'needs you' --title api --priority 4
```

`YANTRA_NTFY_URL` unset means no relay, which is not an error — the daemon runs exactly as it did and
sends nothing, and it says which of the two it got in its first few log lines, because a unit's
environment is not the shell's. Subscribe to the same topic in the ntfy app to receive them.

**The relay is a general publish channel, not the notifier's private wire.** Anything with something
to say can send a line — a session's status, *needs attention*, a workflow, a reminder — and the
fleet notifier is only the first caller. There is no message taxonomy: the body is whatever you
passed, and one channel per session is a second URL rather than a second feature.

**On the public server the topic name is the only password there is** — ntfy's own docs say so, and
anyone who knows a topic can read it and publish to it. So use a high-entropy topic, or run your own
ntfy and keep the body on the tailnet. **The token is read from the environment and from nowhere
else**: never a workspace field, never a file Yantra writes, never a log line and never the API
(§B4). For the appliance it belongs in a systemd drop-in — `systemctl edit yantrad` — rather than in
the unit this repo ships.

`yantra notify` is the diagnostic for a box with no screen: it proves the topic, the token and egress
in one command, and every refusal names the variable that would change it without printing its value.

## The dashboard over HTTPS

`yantrad` speaks plain HTTP and will keep doing so. TLS is `tailscale serve`'s job: it already holds
a publicly-trusted certificate for this machine's `*.ts.net` name and renews it, so terminating TLS
in `axum` would mean owning cert renewal to gain nothing (§B2).

A browser needs this for more than the padlock. Service workers do not register outside a secure
context, so the PWA (Y-114) cannot exist over HTTP, and `navigator.clipboard` already fails for the
same reason.

Run the daemon as above, then, **once**:

```bash
just https        # tailscale serve --bg --https=8443 "http://$(tailscale ip -4):7717"
```

Open **`https://<machine>.<tailnet>.ts.net:8443/`** from anything on the tailnet — a phone included.
`--bg` makes it a stored `tailscaled` setting, so it survives reboots and outlives the shell; you set
it once per machine, not once per session. To undo it:

```bash
just https-off    # tailscale serve --https=8443 off
tailscale serve status
```

Four things about that command are deliberate, and three of them were measured rather than assumed.

**It proxies to the tailnet address, never `127.0.0.1`.** Y-069 has the daemon bind only the
addresses Tailscale says this machine holds, and loopback is deliberately not among them, so
`http://127.0.0.1:7717` is refused by design. `$(tailscale ip -4)` is the target that works.

**Port 8443, not `/`.** `/` on this machine's HTTPS is code-server's and stays that way. A subpath
would have cost the PWA its service-worker scope — a worker's scope is its path — and made every
asset path relative for the rest of the project's life, so Yantra takes its own port instead. 8443 is
the conventional alternate-HTTPS port and is the one Tailscale's own `serve` and `funnel` help pages
use as their example.

**Not 7717.** `tailscale serve --https=7717` is accepted without complaint even though `yantrad`
already holds that address and port; `ss -lntp` then still shows the socket belonging to `yantrad`,
so `tailscaled` never got it and the HTTPS endpoint quietly does not exist. Keeping one meaning per
port avoids that: 7717 is the daemon's plain-HTTP listener that `yantra-agent` posts heartbeats to,
8443 is the browser's door.

**The target address is stored, not resolved per request.** `tailscale serve status` shows the
literal `100.x.x.x` the shell expanded. If this machine's tailnet address ever changes, re-run
`just https`.

### What the proxy does to caller identity

**Behind `tailscale serve`, `yantrad` cannot see who is calling**, and
[ADR-0016](adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md) authorises writes
by source address. Measured on 2026-08-03 with a listener standing in for the daemon: a request made
from `bishwajeets-macbook-pro` arrived from peer address `100.x.x.x` — *this* node — with the real
caller only in `X-Forwarded-For`, alongside `Tailscale-User-Login`. So every write through the HTTPS
port is attributed to whichever machine runs the proxy.

**Closed on 2026-08-05 by [ADR-0017](adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md)
(Y-118).** The daemon now takes the caller's address from `X-Forwarded-For` when — and only when —
the TCP peer is one of its own bind addresses, which is what a request that came through the proxy on
this machine looks like and what nothing off it can produce. Everywhere else the peer is the caller
as before, so a forged header on `:7717` still changes nothing, and a forwarded value that is not
exactly one address is refused rather than repaired. A tagged CI runner or a node shared in from
another tailnet is now refused on both ports.

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

**There is a second container, and it runs a real `systemd`.**
`crates/yantrad/tests/service_unit.rs` installs the appliance's units under
systemd as PID 1 (Fedora, because Alpine ships none) and starts the real
`yantrad` in a container that has no `tailscale` — so it refuses exactly as it
would while `tailscaled` is still learning its address, and what the test watches
is the supervisor retrying instead of giving up. It skips and labels itself the
same way. What no container can show is the boot ordering against a real
`tailscaled`.

## Cross-compiling for the appliance

```bash
just appliance
file target/aarch64-unknown-linux-musl/release/yantrad
# ELF 64-bit LSB executable, ARM aarch64, statically linked, stripped
```

**Every `appliance*` recipe takes a target and defaults to `aarch64-unknown-linux-musl`**, because
[Q15](../tracker.md#6-open-questions) has not answered which box and *Pi 5 / N100* is two
architectures. `just appliance x86_64-unknown-linux-musl` builds the mini-PC's, after one
`rustup target add x86_64-unknown-linux-musl`.

Getting those binaries onto a box is `just appliance-install <host>`, which is also the update.
[`appliance.md`](appliance.md) is the runbook: what the box needs first, where the workspace TOMLs
come from, and why a running binary is replaced by a rename rather than a copy.

Statically linked, no runtime on the target. `just appliance-size` reports what
each one costs; measured on 2026-08-06 that is **3.4 MB** for `yantrad`, **2.4 MB**
for `yantra` and 432 KB for `yantra-agent`, or **4.1 MB** for the `yantrad` that
carries the dashboard — the one file the appliance copies. Both of the first two
grew by about 1.1 MB for the same reason, an HTTPS client with a bundled root
store: `yantrad` when Y-146 called it, `yantra` when Y-147 gave the CLI `notify`
([`yantra-core/CLAUDE.md`](../crates/yantra-core/CLAUDE.md) has the bytes either
side of each). Both are still inside ADR-0004's ~5 MB. If any of this stops
working, say so loudly — [ADR-0004](adr/0004-rust-for-the-daemon.md) chose Rust
partly on the strength of it.

## What the appliance costs at idle

Size is the number a cross-compile can report; the other three ADR-0004 owes M7
need a binary that runs, so they are measured on the musl target this machine
executes rather than on the one it builds for.

```bash
just appliance-runtime
```

Measured 2026-08-06 on `cachyos-g14`, `x86_64-unknown-linux-musl`, with `yantrad`
idle over an **empty workspace directory** and nothing running but its own
30-second refresh loops:

| | Measured | ADR-0004 |
| --- | --- | --- |
| Idle RSS | **3,780 kB**, of which 1,080 kB is anonymous — the rest is the binary's own pages. Three runs landed between 3,504 and 3,780 | ~15 MB |
| Idle CPU | **0.053 % of one core** over five minutes, and 0.050 of that is the `tailscale` the refresh loop spawns rather than the daemon itself | — |
| `yantra --version`, cold | **p50 4.0 ms**, p90 4.4 ms, max 10.5 (warm: p50 1.5 ms) | — |

**The ADR names all three and priced one**, so only the first row is a
comparison; idle CPU and CLI cold-start were promised as reports, not as targets.

RSS is `/proc/PID/status`, CPU is that process's own jiffies **plus the ones it
reaped** — leave the children out and a daemon whose idle workload is spawning
`tailscale` prices itself at almost nothing. *Cold* means the binary's page cache
dropped before every run with `posix_fadvise(DONTNEED)`, which needs no root; the
warm row is the same loop without it, so the pair prices the read rather than
guessing at it.

**Why the recipe uses a namespace.** `yantrad` refuses to start unless Tailscale
tells it which addresses this machine holds (R-22), and on the machine that
builds it 7717 is usually already bound by the developer's own daemon. So it runs
in a user + network namespace carrying this node's real addresses on `lo` — the
real `tailscale` answers over its socket, which crosses the namespace, so the
refusal is *satisfied* rather than worked around, and the bind is a real one on a
port nobody else holds. No root, and nothing of the daemon is stubbed.

**These are not the appliance's numbers.** Q15 has not picked a box, and this is
a laptop: slower cores and an SD card would move cold-start most. It is a floor
in the other direction too — an empty workspace directory buys no ssh, and a
daemon holding a real fleet's snapshot costs more than this by whatever the
snapshot weighs.

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
