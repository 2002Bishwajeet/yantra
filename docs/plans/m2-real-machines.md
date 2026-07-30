# M2 — Real machines: implementation plan

**Written** 2026-07-30. **Status:** proposal, awaiting owner review.

This is a plan, not a decision record. Where it reaches a fork that deserves to be settled
permanently, it says so and defers to an ADR rather than quietly picking. §7 lists every such fork in
one place, because those are the parts that need a human before code starts.

Milestone claim, from [`tracker.md`](../../tracker.md) §2:

> Same command targets a *remote* tailnet machine chosen by name. Machine inventory from Tailscale.
> `yantra ls machines` / `yantra ls sessions` work.

---

## 1. What M2 has to prove

Four things, each independently checkable:

1. `yantra up <ws>` where the workspace names a **different machine** opens a session on that machine.
2. The machine list comes from Tailscale, not from a file someone maintains by hand.
3. `yantra ls machines` and `yantra ls sessions` exist and tell the truth.
4. None of it special-cases the local box. The guardrail in §1 of the tracker — *"localhost is not a
   special case. One code path, forever"* — still holds afterwards.

M1 already did (1) against a podman container. What makes M2 different is that the target is a real
machine with a different OS, a different userland, and a network in between — and as of last night
that machine exists and is reachable.

## 2. What is already true

Verified 2026-07-30 against `bishwajeets-macbook-pro` (macOS 26.5.1, Darwin 25.5.0, arm64) — full
evidence in [`docs/machines.md`](../machines.md).

| Assumption | State |
| --- | --- |
| Key auth under `BatchMode=yes` | ✅ exit 0 |
| base64 → `/bin/sh` payload (I-26) | ✅ decodes and runs |
| BSD `base64` accepts `-d` | ✅ FreeBSD base64 |
| stderr sentinel trailer (I-25) | ✅ intact |
| `ControlMaster` multiplexing (I-20) | ✅ **20 ms vs 150 ms cold**, `ControlPath` 27 bytes |
| Idempotency (§B4) | ✅ `session_created` unchanged on a second run |
| `tmux` on the target | ✅ 3.7b — at `/opt/homebrew/bin/tmux` |

So the transport is not the risk. **The risk is everything around it**: name resolution, tool
discovery, and the fact that a remote environment is not the environment a human sees when they log
in. Three of last night's five invariants are about exactly that.

## 3. Constraints that shape the design

Not a list of rules to remember — each one closes off a design that would otherwise look reasonable.

| Constraint | What it forbids |
| --- | --- |
| **I-34** non-interactive `PATH` ≠ login `PATH` | Invoking `tmux` bare and hoping. Today's code does exactly this. |
| **I-35** zsh eats `=name` | Ever sending a tmux command outside the base64 → `/bin/sh` envelope. |
| **I-36** unknown `TERM` kills tmux | Propagating the client's `TERM` to a remote `attach`. |
| **I-33 / I-5** `HostName` is not an identifier | Keying anything on `HostName`. Use `Peer.ID`; derive display names from `DNSName`'s first label. |
| **I-38** own MagicDNS name → loopback | Treating the local machine as reachable by its own short name. |
| **I-21** `=name` is session-scoped only | Pane/window targets by name. Use `%id` / `@id`, or `=name:`. |
| **§B2** orchestrate, don't reinvent | A second copy of `~/.ssh/config`'s mapping (see §7.1). |
| **§B3** verification means reality | Proving the inventory reader with a mock of itself. |
| **§A2** simplicity first | Building an abstraction for machines before the third use. |

## 4. The seams, as they actually are

Audited 2026-07-30 at `8a5a779`. Signatures verbatim.

**The SSH seam** — `crates/yantra-core/src/ssh.rs:104`:

```rust
pub trait Exec {
    fn exec(&self, command: &str)
        -> impl std::future::Future<Output = Result<Output, Error>> + Send;
}
```

`Ssh` is the **only** implementor in the workspace. There is no fake. Every integration test drives
the real `Ssh` against the podman fixture, which is right for the transport layer and a problem for
Y-050 — see §5.1.

**The target type** — `ssh.rs:33`:

```rust
pub struct Machine {
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity: Option<PathBuf>,
    pub state_dir: PathBuf,
}
```

**Where a name becomes a host** — `up.rs:51`, and this is the seam M2 turns on:

```rust
fn machine_for(workspace: &Workspace) -> Result<Machine, Error> {
    Ok(Machine {
        host: workspace.machine.clone(),
        user: None,
        port: None,
        identity: None,
        state_dir: state_dir()?,
    })
}
```

`workspace.machine` goes straight through. `user`, `port` and `identity` are hardcoded `None`, so
`~/.ssh/config` decides everything. The comment above it is a deliberate position, not an oversight:

> `machine` is used as an ssh destination verbatim, so `~/.ssh/config` decides what it means — the
> fidelity I-20 chose the system binary for. Yantra does not maintain a second copy of that mapping.

Meanwhile `workspace.rs:19` documents the field as *"An alias; Y-041 resolves it to a host"* — which
never happened. **The code and its own doc comment disagree about whether resolution is Yantra's
job.** Settling that is §7.1, and it is the single most important thing to decide before writing
code.

**tmux** — `crates/yantra-core/src/tmux.rs`. No trait; free functions generic over `E: Exec`, so tmux
rides the SSH seam instead of adding a second one. That was a good call and stays.

```rust
pub async fn ensure<E: Exec>(exec: &E, name: &str, cwd: &str, startup: Option<&str>)
    -> Result<Opened, Error>;                                    // :80
pub async fn kill<E: Exec>(exec: &E, name: &str) -> Result<(), Error>;   // :142
fn sq(s: &str) -> String;                                        // :239 — POSIX single-quoting
```

The binary is a bare literal in every `format!` — `"tmux new-session -d -s {} …"`. **There is no
`list` function**, so `yantra ls sessions` starts from nothing.

**CLI** — `crates/yantra/src/main.rs:24`, a slice match over `&[&str]`, with its own note: *"Argument
parsing is hand-rolled because there is one command. When there are three, this becomes `clap`."*
M2 adds the second and third. See §7.4.

**Test harness** — `tests/common/mod.rs:55`. `SshFixture::start()` returns `Ok(None)` when podman is
missing so local runs skip; `just test-ci` sets `YANTRA_REQUIRE_PODMAN=1` so CI cannot silently stop
testing (I-32's lesson, wired in). Each fixture gets a unique container name (pid + nanoseconds), its
own `0700` temp directory, its own ed25519 keypair and an ephemeral published port.

**Concurrent fixtures already work — measured, not assumed.** `just test-ci` on `8a5a779` ran
**33 tests, 33 passed, 0 skipped in 4.44 s wall clock**, while the last four tests alone account for
9.6 s of individual runtime. Sum-of-parts exceeding wall-clock is only possible if containers
overlapped, so nextest is already running several fixtures at once. **Y-055's two-machine test needs
no harness changes.**

The fixture has no `tailscaled` in it and is not on a tailnet, so it can never stand in for
"Tailscale sees two machines" — that is what Y-050's `Fake` is for.

## 5. The work

Six tasks, `Y-050`..`Y-055`, ordered by dependency. Each is one PR (§B5).

### 5.1 Y-050 — Tailscale inventory reader

**New module** `crates/yantra-core/src/inventory.rs`, behind a trait so the layers above are fakeable
(§B2) — because the podman fixture cannot provide a tailnet, this is the one place in the project
where a fake is the *correct* test double rather than a cop-out:

```rust
pub struct MachineInfo {
    pub id: String,          // `ID` — StableNodeID, the only stable key (I-5)
    pub name: String,        // `DNSName`'s first label (I-33)
    pub dns_name: String,    // `DNSName` verbatim, trailing dot included
    pub os: Os,
    pub online: bool,
    pub last_seen: Option<OffsetDateTime>,
}

pub trait Inventory {
    fn machines(&self)
        -> impl std::future::Future<Output = Result<Vec<MachineInfo>, Error>> + Send;
}
```

Verified against Tailscale 1.98.9 (`ipn/ipnstate/ipnstate.go`) and a live capture on 2026-07-30. The
details serde will get wrong if nobody writes them down:

| Fact | Consequence |
| --- | --- |
| Every field is Go **PascalCase** except `sshHostKeys`, the one with an explicit rename tag | No blanket `rename_all` |
| The `Peer` map's key is `nodekey:<hex>`, not the node ID | Iterate values and index by `ID`; never key on the map key |
| `DNSName` carries a **trailing dot** | Strip before splitting labels |
| `OS` values are `linux`, `macOS`, `windows`, `iOS`, `android` — Go's `GOOS` with `darwin` split in two | Not the same casing as ACL `node:os`, which is all-lowercase. Normalise explicitly if the two are ever compared |
| `LastSeen` is *"only present if offline"*; online peers carry the zero value `0001-01-01T00:00:00Z` | Zero does **not** mean "never seen". Combine with `Online` |
| `Expired` exists on peers but not on `Self` | Peer-only field |
| `Addrs` is populated on `Self` and `null` on peers | Don't rely on it for peers |

**Correction to something I asserted last night.** I reported the MacBook as advertising
`tailscaleSSHEnabled: false`. **There is no such field** — not in `status --json`, not in the
LocalAPI, not in API v2. It read as `false` because it was absent. Worse, `sshHostKeys` is
`omitempty` and its absence is *inconclusive*: this host has `RunSSH: true` in `tailscale debug prefs`
while `Self.sshHostKeys` is missing from the JSON entirely. So neither field can answer "does this
peer run Tailscale SSH" — the only real signal is the presence of the `https://tailscale.com/cap/ssh`
key in `CapMap`, and even that reflects an ACL grant rather than a running server.

The *conclusion* still holds, because it never rested on that field: the Mac refused TCP on port 22,
and Tailscale's docs independently state the SSH server does not run on the App Store build. But
`MachineInfo` should carry **no `ssh_enabled` field at all** — M2 does not need one, and any value it
held would be a guess.

**Verified bonus for I-33:** the control plane *deduplicates `DNSName` labels* even when `HostName`
collides — the dual-boot laptop's two nodes share a `HostName` and get distinct labels via a numeric
suffix. And `DNSName` is assigned even with MagicDNS disabled, because it comes from the netmap rather
than from resolution. So I-33's transformation is pure string handling and never depends on DNS
working — which matters on this box, where a health warning says MagicDNS probably will not.

**CLI or LocalAPI?** They return byte-identical data — the CLI is a thin client over
`/localapi/v0/status`. The socket is `/run/tailscale/tailscaled.sock`, mode `666`, and **unprivileged
reads work** via peer credentials, but the request must carry `Host: local-tailscaled.sock` or it is
`403 invalid localapi request`. The socket also offers `/localapi/v0/watch-ipn-bus` for push updates,
which the CLI cannot give at all.

**Recommendation: shell out to `tailscale status --json` for M2**, and keep the LocalAPI as the
documented upgrade path. Reasons: it is the §B2 default, it is portable to the macOS and Windows
clients without the token and named-pipe handling the socket needs there, and M2 only ever needs a
snapshot. `watch-ipn-bus` becomes genuinely valuable at M4, where the web UI wants live status — and
the trait makes that swap cheap, which is the point of having it. Both surfaces are marked unstable by
Tailscale (*"this format has changed between releases and might change more in the future"*), so
parsing must be unknown-field-tolerant and snapshot-tested either way; that is not an argument for
one over the other.

Also fix the stale doc comment on `Workspace::machine`.

**Done when:** machines parse out of real `tailscale status --json`, with unit tests over recorded
fixtures covering the ugly real cases — colliding `HostName`s, a `HostName` containing U+2019, two
nodes that are one physical machine, an offline peer with a real `LastSeen`, and an online peer with
the zero value — plus a `Fake` the later tasks build on.

### 5.2 Y-051 — `yantra ls machines`

Reads the inventory, prints a table. Must not present the dual-booted laptop's two nodes as two
available machines — they are mutually exclusive and can never both be online. Formatting lives in
`main.rs`; `yantra-core` never prints (ADR-0005).

### 5.3 Y-052 — Resolve remote tool paths

The concrete bug: `tmux` is invoked bare, and on the MacBook that finds nothing (I-34). Options and a
recommendation are in §6 once the investigation lands; the shape either way is that the resolved
path is discovered once per machine and cached, not probed per command.

### 5.4 Y-053 — `TERM` handling

Scoped smaller than it first looked. `Ssh::exec` already sets `RequestTTY=no`, so **no PTY is
allocated anywhere in the current code** and I-36 cannot bite today. What M2 owes is:

- set `default-terminal` when creating a session, so the *inner* terminal is sane regardless of who
  attaches later;
- make sure the attach hint `up` prints does not imply the user's `TERM` will work on the far side.

The real fix — pinning `TERM` on a PTY we allocate ourselves — belongs to M6, where Yantra owns both
ends. Recording it here so it is not rediscovered then.

### 5.5 Y-054 — `yantra ls sessions`

Derive from tmux rather than storing state (Y-044 says prefer deriving, and a store that can
disagree with reality is worse than no store). Fan out `tmux list-sessions -F …` across the online
machines concurrently. `no server running` means "no sessions", not an error — the same class of
"absence is not failure" that I-30 already covers for `kill`.

### 5.6 Y-055 — `up` against a remote machine, end to end

The milestone's actual claim. Two levels of verification, and they are not interchangeable:

- **CI:** two podman fixtures at once, proving the code path that handles more than one machine.
- **Manual:** against the MacBook, proving the parts CI structurally cannot reach — a real network,
  a real different OS, and Tailscale itself. Scripted and committed so it is repeatable, not a
  sequence of commands someone remembers.

## 6. Tool-path resolution (Y-052)

The question: given I-34, how does the daemon learn where `tmux` lives on a machine?

The interesting part is that **the two mechanisms that look native to macOS both fail on the exact
machine that raised I-34**, which is why this needed evidence rather than a guess.

**`sh -lc` — a login shell for the probe only — cannot see the fix.** Homebrew's own installation
docs say the Apple Silicon installer does *not* write to `/etc/paths.d`; it tells the user to put
`eval "$(/opt/homebrew/bin/brew shellenv)"` in `~/.zprofile`. `/bin/sh` never sources `~/.zprofile`.
So the probe misses precisely the edit that makes `brew` work interactively.

It is worse than macOS-specific. Measured on this box, `sh -lc`, `bash -lc` and `fish -lc` return
**three different `PATH`s for the same user**, because the distro-default `~/.bashrc` opens with:

```sh
# If not running interactively, don't do anything
[[ $- != *i* ]] && return
```

`bash -lc` is a non-interactive login shell, so it returns at that line — before any `PATH` edit
placed below it, which is where convention says interactive customisation goes. That guard is the
default on Arch, Debian and Ubuntu. So even a probe that correctly matches the target's real login
shell can miss the thing it is looking for.

**`getconf PATH` is a compiled-in constant.** It returned `/bin:/usr/bin` here. It is
`confstr(_CS_PATH)` from libc, read from no config file, and will never contain Homebrew, Nix or
linuxbrew on any machine.

**`/etc/paths` + `/etc/paths.d`** would be macOS-specific code for a mechanism the default Apple
Silicon install does not populate — it would have failed silently on the box in evidence.

Cost, measured locally before any network RTT:

| Probe | Time |
| --- | --- |
| `sh -c 'command -v tmux'` | 5 ms |
| `sh -lc …` | 93 ms |
| `bash -lc …` (the real login shell) | 90 ms |
| `fish -lc …` | 23 ms |

An 18× penalty for a login shell locally, against a warm multiplexed exec that measured 20 ms to the
MacBook — and the dotfiles it runs are arbitrary, so the price has no upper bound.

**Recommendation: probe a fixed candidate list through the existing envelope.** One `Exec::exec` call
per machine, reusing the open `ControlMaster`, no login shell:

```sh
for d in /opt/homebrew/bin /home/linuxbrew/.linuxbrew/bin /usr/local/bin \
         /run/current-system/sw/bin /usr/bin /bin; do
  [ -x "$d/tmux" ] && { printf '%s\n' "$d/tmux"; break; }
done
```

Cached per machine keyed on `Peer.ID` (I-5 — never the display name), in memory rather than in
SQLite, per Y-044's preference for deriving over storing. **Invalidation is self-healing, not
time-based:** if a cached path fails to exec, treat that as a miss, re-probe once, then report a
typed error. Install locations do not drift on a schedule, so periodic re-probing spends round trips
for nothing.

A `tmux` override on the machine/workspace config is the escape hatch for nonstandard prefixes,
following the existing optional-override pattern (`identity`, `port`). It must not be the *only*
mechanism, or every new machine needs hand configuration for a problem the list solves.

Explicitly rejected: a login-shell probe as the primary mechanism — it misses the edit, costs 18×,
and quietly reintroduces the login shell that I-35 proves is hazardous; `/etc/paths` parsing; and
chasing every package manager's prefix.

**Tests** — the existing podman fixture, no new harness:

1. Put the binary at a path *off* the container's default non-interactive `PATH`, and assert as a
   precondition that a bare `command -v` finds nothing. Otherwise the test can pass by accident.
2. Nothing anywhere and no override → a distinct typed "tool not found", not a transport error.
3. Seed the cache with a path that no longer exists → the next call re-probes and recovers.
4. A note in the test module that the container reproduces the *shape* (tool present, off the default
   `PATH`) but cannot exercise the macOS specifics — zsh's `~/.zprofile`, `path_helper`, Homebrew's
   installer choices. Those stay doc-verified plus manual verification against the real MacBook.
   Per I-32, a green CI run must not be allowed to stand in for that.

## 7. Forks that need the owner

### 7.1 Does Yantra resolve machine names, or does `ssh`? — **decided 2026-07-30: (a)**

**Settled in [ADR-0009](../adr/0009-machine-names-are-ssh-destinations.md).** `machine` reaches `ssh`
verbatim; the inventory observes and never resolves. The ADR adds one constraint this section did not
anticipate: an unknown name is a **warning, never an error**, because a hard-failing validator makes
the inventory authoritative over which names are legal, having just declined to make it authoritative
over what they mean. The rest of this section is the reasoning that got there.

The live contradiction from §4. Two coherent answers:

**(a) `ssh` resolves; inventory only validates.** `machine` keeps going to `ssh` verbatim.
Tailscale inventory is used to *check* the name exists and to give a good error — "no machine
`macbok` in the tailnet, did you mean `bishwajeets-macbook-pro`?" — plus to power `ls machines`.
Keeps I-20's fidelity, keeps `~/.ssh/config` authoritative, adds no second mapping.

**(b) Yantra resolves.** Inventory maps a name to a `DNSName` and fills `Machine`. More control,
enables per-machine user/port/identity later, and breaks the stated position that Yantra does not
duplicate `~/.ssh/config`.

**Recommendation: (a).** It delivers everything M2 claims, it is less code, and it does not
contradict a decision that already has a written rationale. If per-machine `user`/`identity` becomes
necessary later, that is the moment to revisit — with a superseding ADR, per §B0.2. Either way this
is an ADR-sized choice, so it should be written down rather than absorbed into a PR.

### 7.2 Y-047 — `branch` is still parsed and ignored

Untouched by this plan. Checking out a branch under a dirty worktree can destroy work, so the
semantics — refuse? stash? warn? — is a product decision, not an implementation detail.

### 7.3 Q4 — Windows

No `cfg(windows)` branching exists anywhere in the transport or session layer; the only
platform-conditional code is the `ControlPath` limit constant. Two findings narrow the question:
the Windows node is the second boot of a laptop that already runs Linux, so supporting it buys zero
extra machines; and Tailscale SSH can never serve it. Still open, still deferred.

### 7.4 clap, now?

The CLI's own comment sets the threshold at three commands. M2 brings it to three. Nesting
`ls machines` / `ls sessions` into a slice match is where hand-rolled parsing starts to hurt.
Recommend a small separate task rather than smuggling it into Y-051.

## 8. What M2 deliberately does not do

No placement or scheduling (M5). No agent launching (M3). No web UI (M4). No session store unless
deriving genuinely fails (Y-044). No Windows (Q4). No `branch` checkout (Y-047).

## 9. M3 preview — and one closed finding that should reopen

Re-verified against current official Claude Code docs on 2026-07-30. Claude Code is still v2.1.220,
the same version [R3](../research/03-ai-agent-clis.md) tested, so nothing has shipped since — but the
re-read turned up several things the note did not cover, and one that matters before M3 starts.

### 9.1 R-1 was refuted on the wrong operating system

Issue #63545 — the one R-1 was named after — is a **macOS + tmux** report. Y-023's spike ran on
`cachyos-g14`, which is Linux, because the MacBook was not SSH-reachable until Y-049 closed on
2026-07-30. So the spike reproduced the *scenario* on a different platform than the *report*.

That does not make Y-023 wrong. What it did observe was real: interactive `claude` 2.1.220 in a fully
detached tmux session wrote 18,427 bytes within 5 s. That is genuine evidence, and it is also
evidence against the open Linux issue #70632, which claims a live session's JSONL is only flushed at
exit on 2.1.190. But it is Linux evidence, and R-1, Q7 and the Claude Code integration ADR were all
retired or unblocked on the back of it.

Independent support exists — open issue #79188 (macOS, 2.1.215) is a controlled comparison across
multiplexers that found plain tmux *does* persist correctly. That is someone else's experiment on
someone else's machine, which is exactly the standard §B3 says not to accept.

**Two concrete consequences for M3:**

1. Re-run Y-023's spike against the real MacBook before building on it. It is cheap now that the
   machine is reachable, and it closes a platform gap rather than re-litigating a result.
2. `yantra logs` must verify the transcript's **mtime is advancing**, not merely that the file
   exists. The #70632 failure mode looks healthy at a glance and only fails at tail time — a
   liveness check catches it, an existence check does not.

Flagged as **Q12** in the tracker rather than reopened unilaterally, per §B0 rule 4.

### 9.2 Never set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`

With that variable set, the binary detects `$TMUX` and silently reclassifies the session as an
agent-teams "teammate" pane, which **skips transcript persistence entirely** (open issue #70219).
Yantra launches into tmux by design, so this is a landmine specific to this architecture. Invariant
material once M3 starts.

### 9.3 Authentication on macOS is not a file

R3 said "provision the OAuth credential file once per host". That is **wrong for macOS**, which is
now the first real target:

| OS | Credential storage |
| --- | --- |
| Linux | `~/.claude/.credentials.json`, mode 0600 — copyable |
| **macOS** | **encrypted Keychain — there is no file to copy** |
| Windows | `%USERPROFILE%\.claude\.credentials.json` |

`CLAUDE_CONFIG_DIR` relocates the file on Linux and Windows and has no effect on the Keychain. So the
Mac needs either a one-time interactive login on that machine, or a token forwarded per launch. Note
also that the new `--bare` flag deliberately skips OAuth and keychain reads, so a `--bare` invocation
needs an API key rather than an OAuth token.

### 9.4 There are two independent gates, not one

I-23 covers the trust dialog. It is still correct, but its scope narrows: **trust verification is
disabled under `-p`**, so I-23 only applies to the TUI-in-tmux path — which is the path Y-024 chose,
so it still matters.

The gate the note missed: entering `bypassPermissions` interactively for the first time raises a
*separate* confirmation dialog, with no documented settings key to pre-accept it, and a `--bg`
session is refused until it has been accepted interactively. And `--dangerously-skip-permissions`
does **not** bypass the trust dialog — Anthropic closed the requests for that as `not_planned`, so
the separation is intentional.

**Prefer `dontAsk` over `bypassPermissions` for anything unattended.** It denies whatever is not
pre-approved and never prompts, which is unattended-safe by construction; the docs recommend it for
"locked-down CI and scripts". `bypassPermissions` also refuses to start under root/sudo outside a
recognised sandbox — worth knowing given Yantra chooses the remote user.

### 9.5 Two smaller corrections

- **The transcript format is officially unstable**: *"The entry format is internal to Claude Code and
  changes between versions, so scripts that parse these files directly can break on any release."*
  The path is unchanged, but `yantra logs` must parse defensively.
- **Resume is scoped to the project directory.** `--resume <id>` from a different cwd than the
  session started in fails outright. Yantra must resume from the workspace repo, not from wherever
  the daemon happens to be.

Everything else in R3 held: `-p` / `--output-format`, `-r` / `-c` / `--session-id` / `--fork-session`,
`cleanupPeriodDays`, `setup-token`, and SIGTERM → 143 all verified unchanged.

## Sources

- Code audit of `8a5a779`, 2026-07-30 — signatures and line numbers quoted inline.
- [`docs/machines.md`](../machines.md) — the fleet and the 2026-07-30 probe evidence.
- [`tracker.md`](../../tracker.md) §1b — invariants I-5, I-20, I-21, I-26, I-28, I-33..I-38.
- ADR-0005 (crate split), ADR-0006 (SSH exec transport), ADR-0007 (workspace schema v1).
