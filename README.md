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

🚧 **Usable from the CLI, against real machines, with a real agent.** Four milestones are closed.

`yantra up <workspace>` opens a tmux session in a repo on a machine reached over SSH — idempotently,
so running it twice attaches rather than duplicating. With `--agent claude` it launches Claude Code
in that session, and `logs` / `status` / `down` watch it and stop it. All four were verified end to
end against a live Claude Code on a real machine, not a stub.

`yantrad` now serves too, though only a health check so far — it listens on this machine's Tailscale
addresses and refuses to start anywhere else. Still ahead: the HTTP API, the web UI, the scheduler,
the browser terminal, and the hardware.

**Start here → [`tracker.md`](tracker.md)** — the single source of truth for what is decided, what is
being worked on, and what is still an open question.

## Install

There is **no published release yet**, so build from source. You need
[rustup](https://rustup.rs); the toolchain version is pinned by `rust-toolchain.toml`.

```bash
git clone https://github.com/2002Bishwajeet/yantra
cd yantra
cargo install --path crates/yantra
```

That installs the `yantra` CLI to `~/.cargo/bin`. Nothing else needs installing — the daemon does not
exist yet, and Yantra runs no software on the machines it manages.

**On the machines you want to reach**, you need what Yantra orchestrates rather than anything of
Yantra's own:

| On the target | Why |
| --- | --- |
| SSH access | The transport. Tailscale SSH counts; so does a normal `sshd`. |
| `tmux` | Sessions live in it, and they outlive your connection. |
| Tailscale | Only for `yantra ls machines`. Reaching a machine needs no Tailscale — see [ADR-0009](docs/adr/0009-machine-names-are-ssh-destinations.md). |
| A coding agent | Optional. Claude Code today, and only Claude Code. |

## Usage

A **workspace** is a file at `~/.config/yantra/workspaces/<name>.toml`. The filename is the name, so
the two can never disagree:

```toml
machine = "bishwajeets-macbook-pro"   # an ssh destination — ~/.ssh/config decides what it means
repo    = "/Users/me/code/yantra"     # the path on `machine`, not on this box
startup = "nvim"                      # optional; omit for just a shell
```

That is the whole schema. An unknown key is an error rather than a line that is silently ignored
([ADR-0007](docs/adr/0007-workspace-schema-v1.md)).

**The box you are sitting at is the awkward case.** If it is served by Tailscale SSH rather than its
own `sshd`, it cannot ssh to *itself* — Tailscale SSH is peer-to-peer, and there is no listener behind
it — so a workspace naming it directly fails with `Connection refused`. Route back in through another
machine and name that instead; `~/.ssh/config` is where this is answered, not Yantra
([docs/machines.md](docs/machines.md#a-machine-cannot-reach-itself)).

Then:

```bash
yantra up yantra                 # open the session (run again to attach)
yantra up yantra --agent claude  # ...and start Claude Code in it
yantra attach yantra             # hand this terminal to the session
yantra resume yantra             # start the agent again on the conversation it left off
yantra status yantra             # running, finished, stopped, crashed or killed
yantra logs yantra -n 40         # what the agent has been saying
yantra down yantra               # stop it, giving the agent a chance to shut down
yantra ls machines               # what Tailscale can see
yantra ls workspaces             # what you have defined
yantra ls sessions               # what tmux is holding, across every machine
yantra fix-terminfo <machine>    # teach a machine about your terminal
```

`yantra --help` is the current and complete reference — it is generated from the code, so unlike this
README it cannot drift.

**Exit codes are a contract**, documented in [`crates/yantra/CLAUDE.md`](crates/yantra/CLAUDE.md).
The two worth knowing: `status` exits 1 when nothing is running, so `yantra status x && …` reads the
way it looks; and `ls sessions` exits 1 if a machine was unreachable, so a caller can tell the table
is partial.

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
tmux for persistence · Tailscale as the network · `rusqlite` for state ·
appliance target `aarch64-unknown-linux-musl`.

See [ADR-0004](docs/adr/0004-rust-for-the-daemon.md).

## Name

**Yantra** (यन्त्र) — Sanskrit for *machine, instrument, apparatus*; classically, a device that
harnesses and directs power. See [ADR-0002](docs/adr/0002-project-name.md).
