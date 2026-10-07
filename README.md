<div align="center">

<img src="design/brand/readme-banner.png" alt="Yantra यन्त्र — One workspace. One interface. Every machine." width="1280">

**A personal developer control plane.**

[![CI](https://github.com/2002Bishwajeet/yantra/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/2002Bishwajeet/yantra/actions/workflows/ci.yml?query=branch%3Amain)

</div>

---

Yantra is a hardware-backed control plane for development work. You no longer need to remember which
machine held which repository, in which tmux session, with which AI agent running. You ask for a
**workspace**, and Yantra restores the context. It picks a machine, opens the session and resumes the
agent.

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

🚧 **You can use Yantra from the CLI and from a browser, against real machines, with a real agent.**
M0–M5 and M11–M13 are closed. M14 rebuilt the dashboard in Material 3 Expressive and is not closed
yet ([`web/README.md`](web/README.md)). M6 waits for one run at the Mac's own keyboard. M7 waits for
hardware that is not on the tailnet yet. The owner deferred M10 by choice.

`yantra up <workspace>` opens a tmux session in a repo on a machine that it reaches over SSH. The
command is idempotent: if you run it twice, it attaches and does not duplicate. With `--agent claude`
it starts Claude Code in that session. `logs`, `status` and `down` watch the session and stop it. We
verified all four end to end against a live Claude Code on a real machine, not a stub.

`yantrad` serves that same work to a browser. The page at `/` opens on what needs you. It shows the
pull requests and issues that GitHub waits on, and it reads them with a grant that the daemon holds
from the device flow ([ADR-0023](docs/adr/0023-the-github-grant-lives-beside-the-relay.md)). It also
shows every tmux session on the fleet, whether a workspace names it or not. A workspace page carries
the agent's chat, a live terminal, the transcript and what the session spent. The daemon listens on
this machine's Tailscale addresses and refuses to start anywhere else. Still ahead are the always-on
box, the hardware, and placement. Placement means that Yantra picks the machine for you, and you do
not tap one from a list.

**Start here → [`tracker.md`](tracker.md).** It is the single source of truth for what is decided,
what is in progress, and what is still an open question.

## Install

**[v0.6.0](https://github.com/2002Bishwajeet/yantra/releases/tag/v0.6.0)** is the current release. It
has static musl archives for `aarch64` and `x86_64`, and a `yantra-agent` for macOS on both. We
verified all of them against `SHA256SUMS`. **There is no Windows build**, because the probes refuse to
compile there while Q4 is open. **The released `yantrad` carries the dashboard inside it.** The
appliance is therefore one file, and not a binary, a directory and a variable. The dashboard is the
Material one that M14 built. v0.1.0 carried the dashboard that M14 replaced, and its archive had no
systemd units, so `install.sh` refuses it by name.

[`install.sh`](install.sh) puts the current release on an always-on Linux box with one command. It
reads which release is current, and it verifies what it fetched against `SHA256SUMS`. At a terminal,
it asks before it installs Tailscale and turns on HTTPS. Then it starts the units and prints the
dashboard's address ([docs/appliance.md](docs/appliance.md)). `install.sh --uninstall` reverses it.

**From v0.4.0, the box updates itself.** Settings → About shows *Update to vX* when a newer release is
published. `yantra update` on the box does the same
([docs/appliance.md](docs/appliance.md#update-from-the-dashboard)). A box on v0.3.3 or older has no
updater. To reach v0.6.0, run `install.sh` on that box once more.

To build from source, you need [rustup](https://rustup.rs). The file `rust-toolchain.toml` pins the
toolchain version.

```bash
git clone https://github.com/2002Bishwajeet/yantra
cd yantra
cargo install --path crates/yantra
```

That command installs the `yantra` CLI to `~/.cargo/bin`. It does not install the daemon or the
per-machine agent. You build and copy those. `just appliance` builds all three for the appliance
target. `just appliance-install <host>` copies them, and both systemd units, over ssh onto the
always-on box that Yantra itself runs on. The same recipe updates the box afterwards
([docs/appliance.md](docs/appliance.md)).

**On the machines you want to reach**, you need the tools that Yantra orchestrates. You need nothing
of Yantra's own.

| On the target | Why |
| --- | --- |
| SSH access | The transport. Tailscale SSH counts; so does a normal `sshd`. |
| `tmux` | Sessions live in it, and they outlive your connection. |
| Tailscale | Only for `yantra ls machines`. Reaching a machine needs no Tailscale — see [ADR-0009](docs/adr/0009-machine-names-are-ssh-destinations.md). |
| A coding agent | Optional. Claude Code today, and only Claude Code. |

## Usage

A **workspace** is a file at `~/.config/yantra/workspaces/<name>.toml`. You can write it yourself, or
Yantra can write it:

```bash
yantra new site --machine bishwajeets-macbook-pro --repo /Users/me/code/site
```

`yantra new` refuses to overwrite an existing workspace. It does not check `machine` or `repo`.
The `repo` field is a path on the *far* side. `up` finds out that the path is not there, on that
machine, before it creates a session. `yantra new` does refuse an empty `--startup`. If you leave the
flag off, you get *a shell and nothing else*. A blank value would be a command that cannot run.

`yantra edit` changes a workspace afterwards. It takes the same flags and rewrites only the ones you
name. **It refuses to change `machine` while a session is open on the machine that the field names
now.** That session lives in tmux *on a machine*. `down`, `resume`, `status` and `logs` all find the
session by reading the field. If you moved the field, the session would stay behind where nothing
looks for it. Each of those verbs would then report the missing session as success. Stop the session
first. `yantra edit` also refuses a machine that it cannot reach. *Unreachable* and *empty* are not
the same answer.

The filename is the name, so the two can never disagree:

```toml
machine = "bishwajeets-macbook-pro"   # an ssh destination — ~/.ssh/config decides what it means
repo    = "/Users/me/code/yantra"     # the path on `machine`, not on this box
startup = "nvim"                      # optional; omit for just a shell
```

That is the whole schema. An unknown key is an error. Yantra does not ignore it silently
([ADR-0007](docs/adr/0007-workspace-schema-v1.md)). A blank key is also an error: Yantra refuses
`machine = ""`, `repo = ""` or `startup = ""` when it *reads* the file. The error names the file, the
field and the workspace. Such a file costs only itself. `yantra ls workspaces` and the dashboard's
workspace table still show every workspace that loaded. They name the one that did not, with the
reason underneath. Fix the line or move the file aside.

**`yantra edit` cannot fix such a file.** It loads the file before it writes one. Use
`yantra repair site < fixed.toml` instead. The dashboard offers the same repair on a page at
`/w/site/repair`. Both refuse bytes that still do not load. Both also refuse a file that already
loads ([ADR-0020](docs/adr/0020-a-raw-write-only-from-broken-to-valid.md)).

**The box you are sitting at is the awkward case.** Suppose Tailscale SSH serves it and it has no
`sshd` of its own. Then it cannot ssh to *itself*. Tailscale SSH is peer-to-peer, and no listener sits
behind it. A workspace that names the box directly fails with `Connection refused`. Route back in
through another machine, and name that machine. `~/.ssh/config` is where you answer this, not Yantra
([docs/machines.md](docs/machines.md#a-machine-cannot-reach-itself)).

Then:

```bash
```bash
yantra new site --machine mac --repo /Users/me/code/site   # write a workspace
yantra edit site --repo /Users/me/code/website             # change one that exists
yantra repair site < fixed.toml  # replace a file that will not load, if the bytes do
yantra up yantra                 # open the session (run again to attach)
yantra up yantra --agent claude  # ...and start Claude Code in it
yantra attach yantra             # hand this terminal to the session
yantra resume yantra             # start the agent again on the conversation it left off
yantra status yantra             # running, finished, stopped, crashed or killed
yantra logs yantra -n 40         # what the agent has been saying
yantra tokens yantra             # what that session has spent, in tokens and dollars
yantra down yantra               # stop it, giving the agent a chance to shut down
yantra rm yantra [--force]       # delete the workspace file, refusing while a session is open
yantra kill mac scratch          # stop a session by machine and name, workspace or not
yantra probe mac /code/site      # is that directory there, and what git origin does it hold?
yantra mic mac                   # stream this laptop's microphone into a session there until Ctrl-C
yantra ls machines               # what Tailscale can see
yantra ls workspaces             # what you have defined
yantra ls sessions               # what tmux is holding, across every machine it can reach
yantra ls attention              # what GitHub is waiting on you for
yantra ls repos [--search q]     # every repository the GitHub grant can see
yantra github login              # sign in with the device flow, for yantrad and the dashboard
yantra notify 'needs you'        # publish a message to the relay you configured
yantra relay <url> [--token T]   # configure that relay, and send one test message
yantra doctor [machine] [--json] # what each machine can and cannot do — a read, it changes nothing
yantra fix-terminfo <machine>    # teach a machine about your terminal
yantra ssh-identity              # prepare this account's ~/.ssh, and print the key to place
yantra join-script               # the script a new machine pipes into sh (GET /join)
```

`yantra --help` is the current and complete reference. The code generates it, so unlike this README it
cannot drift.

**Exit codes are a contract.** [`crates/yantra/CLAUDE.md`](crates/yantra/CLAUDE.md) documents them.
Three matter most:

- `status` exits 1 when nothing runs, so `yantra status x && …` reads the way it looks.
- `ls sessions` exits 1 if a machine was unreachable, so a caller can tell that the table is partial.
- `doctor` exits 0 only when every check on every machine is *present*. An installer can re-run it
  until it is clean.

## API reference

Run `cargo doc --open -p yantra-core`.

Every module carries a `//!` header that explains *why* the module has its shape. The header usually
names the bug that forced it. Those headers are the real documentation, and they cannot drift from the
code. There is no separate docs site. There will be none until Yantra is meant for other people. See
Q6 in [`tracker.md`](tracker.md).

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

The dashboard is React 19 with the compiler, TanStack Router, Query, Form, Table and Virtual. It uses
Material 3 Expressive, which we built by hand on Base UI. See [`web/README.md`](web/README.md).

For the browser half, see [ADR-0024](docs/adr/0024-the-dashboard-is-material-3-built-by-hand.md). For
the daemon, see [ADR-0004](docs/adr/0004-rust-for-the-daemon.md) and its 2026-08-02 amendment on the
datastore.

## Name

**Yantra** (यन्त्र) is Sanskrit for *machine, instrument, apparatus*. Classically, it is a device that
harnesses and directs power. See [ADR-0002](docs/adr/0002-project-name.md).
