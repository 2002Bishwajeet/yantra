<div align="center">

# यन्त्र · Yantra

**A personal developer control plane.**

*One workspace. One interface. Every machine.*

</div>

---

Yantra is a hardware-backed control plane for development work. Instead of remembering which machine
held which repository in which tmux session with which AI agent running, you ask for a **workspace**
and Yantra restores the context — picking a machine, opening the session, and resuming the agent.

```
                    Today                              With Yantra

           which machine was I on?
                     ↓
                    ssh                                  yantra up nexus
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

🚧 **Day zero.** No code yet — this repository currently holds the vision, the architecture decisions,
and the research that has to land before the first line is written.

**Start here → [`tracker.md`](tracker.md)** — the single source of truth for what is decided, what is
being worked on, and what is still an open question.

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
| [`docs/adr/`](docs/adr/) | Architecture decision records |
| [`docs/research/`](docs/research/) | Dated research notes — what exists, what to reuse, what to build |

## Stack

**Rust** for the daemon, CLI and per-machine agent · **TypeScript** for the web UI ·
`tokio` + `axum` · the system `ssh` binary as transport (with `ControlMaster` multiplexing) ·
tmux for persistence · Tailscale as the network · `rusqlite` for state ·
appliance target `aarch64-unknown-linux-musl`.

See [ADR-0004](docs/adr/0004-rust-for-the-daemon.md), which supersedes ADR-0003 (TypeScript on Bun).

## Name

**Yantra** (यन्त्र) — Sanskrit for *machine, instrument, apparatus*; classically, a device that
harnesses and directs power. See [ADR-0002](docs/adr/0002-project-name.md).
