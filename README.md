<div align="center">

# यन्त्र · Yantra

**A personal developer control plane.**

*One workspace. One interface. Every machine.*

[![CI](https://github.com/2002Bishwajeet/yantra/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/2002Bishwajeet/yantra/actions/workflows/ci.yml?query=branch%3Amain)

</div>

---

Yantra is a hardware-backed control plane for development work. Instead of remembering which machine
held which repository in which tmux session with which AI agent running, you ask for a **workspace**
and Yantra restores the context — picking a machine, opening the session, and resuming the agent.

```
                    Today                              With Yantra

           which machine was I on?
                     ↓
                    ssh                                  yantra up yantra
                     ↓                          ────────────────────────────────
                find the repo                    machine chosen · ssh · tmux
                     ↓                           restored · repo open · agent
              restore tmux                              resumed · ready
                     ↓
              relaunch agent
                     ↓
                start coding
```

## Status

🚧 **Usable from the CLI, against real machines, with a real agent.** M0–M4 are closed, and M5's
buildable work is finished — what is left of it is a demonstration on the Mac, not code.

`yantra up <workspace>` opens a tmux session in a repo on a machine reached over SSH — idempotently,
so running it twice attaches rather than duplicating. With `--agent claude` it launches Claude Code
in that session, and `logs` / `status` / `down` watch it and stop it. All four were verified end to
end against a live Claude Code on a real machine, not a stub.

`yantrad` serves that same work to a browser: the read model the dashboard draws, the writes behind
its buttons, and a pty for each terminal attached from a page. It listens on this machine's Tailscale
addresses and refuses to start anywhere else. Still ahead: placement — picking the machine for you
rather than offering a list to tap — and the hardware.

**Start here → [`tracker.md`](tracker.md)** — the single source of truth for what is decided, what is
being worked on, and what is still an open question.

## Install

**[v0.1.0](https://github.com/2002Bishwajeet/yantra/releases/tag/v0.1.0)** is the first release — static musl archives for `aarch64` and `x86_64`, plus a `yantra-agent` for macOS on both, all verified against `SHA256SUMS`. **No Windows build**: the probes refuse to compile there while Q4 is open. **The released `yantrad` carries the dashboard inside it**, so the appliance is one file rather than a binary, a directory and a variable. [`install.sh`](install.sh) puts that release on an always-on Linux box in one pinned command — it verifies what it fetched, enables nothing and enrols nothing ([docs/appliance.md](docs/appliance.md)). To build from source you need
[rustup](https://rustup.rs); the toolchain version is pinned by `rust-toolchain.toml`.

```bash
git clone https://github.com/2002Bishwajeet/yantra
cd yantra
cargo install --path crates/yantra
```

That installs the `yantra` CLI to `~/.cargo/bin`. The daemon and the per-machine agent are built and
copied rather than installed here: `just appliance` builds all three for the appliance target, and
`just appliance-install <host>` copies them and both systemd units over ssh onto the always-on box
Yantra itself runs on — the same recipe that updates it afterwards
([docs/appliance.md](docs/appliance.md)).

**On the machines you want to reach**, you need what Yantra orchestrates rather than anything of
Yantra's own:

| On the target | Why |
| --- | --- |
| SSH access | The transport. Tailscale SSH counts; so does a normal `sshd`. |
| `tmux` | Sessions live in it, and they outlive your connection. |
| Tailscale | Only for `yantra ls machines`. Reaching a machine needs no Tailscale — see [ADR-0009](docs/adr/0009-machine-names-are-ssh-destinations.md). |
| A coding agent | Optional. Claude Code today, and only Claude Code. |

## Usage

A **workspace** is a file at `~/.config/yantra/workspaces/<name>.toml`. Write it yourself, or have
Yantra write it:

```bash
yantra new site --machine bishwajeets-macbook-pro --repo /Users/me/code/site
```

It refuses to overwrite an existing one, and it checks nothing about `machine` or `repo` — `repo` is
a path on the *far* side, and `up` is what discovers it is not there, on that machine, before a
session exists. It does refuse an empty `--startup`: leaving the flag off is what means *just a
shell*, and a blank one would be a command that cannot run.

Changing one afterwards is `yantra edit`, which takes the same flags and rewrites only the ones you
name. **It refuses to change `machine` while a session is open on the machine that field currently
points at**: that session lives in tmux *on a machine*, and `down`, `resume`, `status` and `logs`
all find it by reading the field — so moving it would leave the session behind where nothing looks
for it, and every one of those verbs would then report its absence as success. Stop it first. A
machine that cannot be reached is refused for the same reason, because *unreachable* and *empty*
are not the same answer.

The filename is the name, so the two can never disagree:

```toml
machine = "bishwajeets-macbook-pro"   # an ssh destination — ~/.ssh/config decides what it means
repo    = "/Users/me/code/yantra"     # the path on `machine`, not on this box
startup = "nvim"                      # optional; omit for just a shell
```

That is the whole schema. An unknown key is an error rather than a line that is silently ignored
([ADR-0007](docs/adr/0007-workspace-schema-v1.md)), and so is a key left blank: `machine = ""`,
`repo = ""` or `startup = ""` is refused when the file is *read*, naming the file, the field and the
workspace. Such a file costs only itself: `yantra ls workspaces` and the dashboard's workspace table
still show every workspace that loaded, and name the one that did not with its reason underneath —
fix the line or move the file aside.

**The box you are sitting at is the awkward case.** If it is served by Tailscale SSH rather than its
own `sshd`, it cannot ssh to *itself* — Tailscale SSH is peer-to-peer, and there is no listener behind
it — so a workspace naming it directly fails with `Connection refused`. Route back in through another
machine and name that instead; `~/.ssh/config` is where this is answered, not Yantra
([docs/machines.md](docs/machines.md#a-machine-cannot-reach-itself)).

Then:

```bash
yantra new site --machine mac --repo /Users/me/code/site   # write a workspace
yantra edit site --repo /Users/me/code/website             # change one that exists
yantra up yantra                 # open the session (run again to attach)
yantra up yantra --agent claude  # ...and start Claude Code in it
yantra attach yantra             # hand this terminal to the session
yantra resume yantra             # start the agent again on the conversation it left off
yantra status yantra             # running, finished, stopped, crashed or killed
yantra logs yantra -n 40         # what the agent has been saying
yantra tokens yantra             # what that session has spent, in tokens
yantra down yantra               # stop it, giving the agent a chance to shut down
yantra rm yantra [--force]       # delete the workspace file, refusing while a session is open
yantra kill mac scratch          # stop a session by machine and name, workspace or not
yantra probe mac /code/site      # is that directory there, and what git origin does it hold?
yantra ls machines               # what Tailscale can see
yantra ls workspaces             # what you have defined
yantra ls sessions               # what tmux is holding, across every machine it can reach
yantra ls attention              # what GitHub is waiting on you for
yantra notify 'needs you'        # publish a message to the relay you configured
yantra doctor [machine] [--json] # what each machine can and cannot do — a read, it changes nothing
yantra fix-terminfo <machine>    # teach a machine about your terminal
yantra ssh-identity              # prepare this account's ~/.ssh, and print the key to place
```

`yantra --help` is the current and complete reference — it is generated from the code, so unlike this
README it cannot drift.

**Exit codes are a contract**, documented in [`crates/yantra/CLAUDE.md`](crates/yantra/CLAUDE.md).
The three worth knowing: `status` exits 1 when nothing is running, so `yantra status x && …` reads
the way it looks; `ls sessions` exits 1 if a machine was unreachable, so a caller can tell the table
is partial; and `doctor` exits 0 only when every check on every machine is *present*, which is what
lets an installer re-run it until clean.

## API reference

`cargo doc --open -p yantra-core`.

Every module carries a `//!` header explaining *why* it is shaped the way it is, usually naming the
bug that forced it. Those headers are the real documentation, and they cannot drift from the code.
There is no separate docs site and there will not be one until Yantra is meant for other people —
see Q6 in [`tracker.md`](tracker.md).

## Principles

- **Orchestrate, don't reinvent.** SSH, tmux, Tailscale, Docker and ntfy already work. Yantra conducts them.
- **Workspace-first.** The unit of thought is a project you are continuing, not a host you are connecting to.
- **Walking skeleton first.** One thin end-to-end path that works badly beats four layers that work perfectly and never meet.
- **Local-first, over Tailscale.** No cloud dependency, no public exposure.
- **The CLI is the API's first client.** No UI until the CLI is good.
- **Hardware is earned.** The appliance comes after the software is boring.

## Layout

| Path | What |
| --- | --- |
| [`tracker.md`](tracker.md) | **Project state** — milestones, task board, decisions, open questions |
| [`docs/vision.md`](docs/vision.md) | The destination: full scope, first-class objects, 9-phase roadmap |
| [`docs/brainstorm.md`](docs/brainstorm.md) | The founding intent document, archived unedited |
| [`docs/architecture.md`](docs/architecture.md) | **How it fits together** — diagrams of the structure, the request path, the trust boundaries and the roadmap |
| [`docs/development.md`](docs/development.md) | **Local dev setup** — prerequisites, daily commands, gotchas |
| [`crates/*/tracker.md`](crates/) | **The invariants** — rules research proved the hard way, filed with the crate each one binds |
| [`crates/*/CLAUDE.md`](crates/) | Per-crate working rules; `llms.txt` and `README.md` sit beside them |
| [`docs/adr/`](docs/adr/) | Architecture decision records — immutable once accepted |
| [`docs/plans/`](docs/plans/) | Per-milestone implementation plans, written before the code |
| [`docs/research/`](docs/research/) | Dated research notes — what exists, what to reuse, what to build |
| [`docs/session-log.md`](docs/session-log.md) | One line per working session, append-only |

## Stack

**Rust** for the daemon, CLI and per-machine agent · **TypeScript** for the web UI ·
`tokio` + `axum` · the system `ssh` binary as transport (with `ControlMaster` multiplexing) ·
tmux for persistence · Tailscale as the network · nothing persisted — state is declared, derived, or
held in memory · appliance target `aarch64-unknown-linux-musl`.

See [ADR-0004](docs/adr/0004-rust-for-the-daemon.md) and its 2026-08-02 amendment on the datastore.

## Name

**Yantra** (यन्त्र) — Sanskrit for *machine, instrument, apparatus*; classically, a device that
harnesses and directs power. See [ADR-0002](docs/adr/0002-project-name.md).
