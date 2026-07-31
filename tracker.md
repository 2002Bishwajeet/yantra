# Yantra — Tracker

**This file is the single source of truth for project state.**
Read it first. Update it last. If it disagrees with your memory, the file wins.

| | |
| --- | --- |
| **Project** | Yantra (यन्त्र) — personal developer control plane |
| **Current milestone** | `M4 — Web UI` (M3 closed 2026-07-31) |
| **Status** | ✅ **M0, M1, M2 and M3 all closed.** M3 closed 2026-07-31 on **real-agent evidence**: `up --agent claude`, `logs`, `status` and `down` all ran against a live Claude Code 2.1.220 on a real machine, ending in `stopped cleanly (exit 143)`. 128 tests, 4 deliberate `#[ignore]`s. Six invariants out of M3 (I-44…I-49) and Y-046 closed after two milestones open — the detail is in [docs/archive/m2-m3.md](docs/archive/m2-m3.md).<br>**Q1 and Q6 both answered by the owner on 2026-07-31**: Coder is not useful for this case (kill criterion cleared, Y-021 done), and Yantra is **personal-first** — open source for others later, which binds M4's scope.<br>**M4 — Web UI is broken down** into Y-069..Y-073 — [the plan](docs/plans/m4-web-ui.md) is a proposal, and **Q13** (does the CLI go over HTTP?) and **Q14** (what the UI is built with) are the owner's before code starts. Open elsewhere: **Y-066** (name the trust-prompt state, I-49), **Y-044** (session store, receding). |
| **Runtime** | **Rust** (daemon, CLI, per-machine agent) + **TypeScript** (web UI) — see [ADR-0004](docs/adr/0004-rust-for-the-daemon.md), which supersedes ADR-0003 |
| **Top risk** | **R-7** — Windows is a second path with no tmux and no Tailscale SSH server, and Q4 is still deliberately open. *R-21 (macOS agents cannot authenticate over ssh, I-44) is **downgraded**: it is real and unfixed, but Y-059 found a machine that works without touching it, so it costs a target rather than the milestone. R-0 retired with Bun; R-1 refuted on Linux, still untested on macOS; R-2 is now handled in code — see I-47 and `status.rs`.* |
| **Last updated** | 2026-07-31 |
| **Updated by** | Claude (session: Q1, Q6 and Q13 answered; tracker split per crate, Y-068; M4 planned; Y-037 and Y-074 closed) |

---

## 0. How to use this file

**Rules for every contributor, human or agent:**

1. **Before starting work** — read §2 (milestones) and §3 (task board). Pick a task that is `todo` and whose dependencies are `done`.
2. **When starting** — set the task to `doing` and put your name in Owner.
3. **When finishing** — set to `done`, add the artifact path in Notes, and append a line to §8 (Session log).
4. **When you learn something that changes the plan** — do NOT silently change course. Add an entry to §5 (Decisions) or §6 (Open questions) and flag it.
5. **Never delete a task.** Move it to `dropped` with a one-line reason. The graveyard is evidence.
6. **One task = one reviewable change.** If a task cannot be finished in a single sitting, split it.

**Status vocabulary:** `todo` · `doing` · `blocked` · `review` · `done` · `dropped`

---

## 1. Guardrails (read before writing any code)

These exist because this project's failure mode is obvious: it is a nine-phase mega-vision, and
mega-visions die in Phase 4 with a beautiful architecture and nothing that runs.

- **Walking skeleton first.** M1 is one thin end-to-end slice, not a layer. No layer gets built to completion before the whole path works badly.
- **One machine before many.** Everything must work against a single machine before it works against the tailnet.
- **Localhost is not a special case.** Every machine — including the one the daemon runs on — is reached over SSH. One code path, forever. The tempting shortcut (spawn `tmux` directly when local) buys a little convenience now and costs two divergent code paths for the life of the project, where the well-tested one is the one that matters least. Decided 2026-07-28; goes into ADR-0005.
- **Orchestrate, don't reinvent.** If a task's description starts to look like "implement SSH/terminal multiplexer/scheduler", stop and re-read the brainstorm.
- **Provisioning is a permanent non-goal.** Yantra adopts machines that already exist; it never creates, images, or destroys them. This is precisely the line that separates it from Coder — and R4's verdict is blunt: *if Yantra ever grows a provisioning layer it becomes a worse Coder and should be deleted.* To be written into ADR-0005 as a non-goal, not left as folklore.
- **One agent first. Do not build the universal adapter.** The vision doc says every agent should behave identically; that is the *destination*, not the starting point. Yantra supports **Claude Code only** in M3 — the one actually installed, with the strongest resume story (`--session-id` presets the UUID, verified in Y-023). A second agent gets added when a second agent is genuinely wanted, and the shared interface is extracted **from two working implementations**, never guessed ahead of one. Owner's framing, 2026-07-28: *"use the cli that we want, not to join everything. If needed we can do it later."*
- **No UI until the CLI is good.** The CLI is the API's first client and its honesty check.
- **No hardware until the software is boring.** Phases 7–9 are a reward, not a shortcut.
- **Test hard.** Every orchestration primitive gets an integration test against a real sshd + real tmux. Mocks lie about SSH. **The fixture is a disposable podman container**, not the host — a separate filesystem, user and network hop make it a more honest stand-in for a remote machine than `ssh localhost`, and it changes nothing about the host's security posture.
- **Rust for the daemon, TypeScript for the web UI** — [ADR-0004](docs/adr/0004-rust-for-the-daemon.md). Chosen for quality and appliance fit over iteration speed, with that trade made explicitly. Rust punishes design churn, so **think before writing**: this is the milestone where the shape is still unknown.
- **Orchestration lives in `yantra-core`, a library crate** — [ADR-0005](docs/adr/0005-core-logic-in-a-library-crate.md). The binaries are thin. The library never prints and never exits, which forces a typed error from the first fallible call instead of an M2 cleanup; M2's daemon changes *where* the code is called from, not *what* it does.
- **Keep SSH, tmux, telemetry and hardware behind narrow traits.** Not to enable a runtime swap any more — to keep the four seams that touch an unreliable outside world fakeable in tests.

---

## 1b. Invariants

Non-obvious rules that research proved the hard way. Violating one produces a bug that looks like
something else entirely — which is why they are worth more than the code they constrain. **47 live**,
numbered to I-50.

**They live with the crate they bind**, because that is the file open on the screen of whoever is
about to break one. Moved there on 2026-07-31 (Y-068).

| Where | Holds | What, and how load-bearing |
| --- | --- | --- |
| [crates/yantra-core/tracker.md](crates/yantra-core/tracker.md) | **34** | I-1…I-6, I-8, I-20…I-30, I-33…I-37, I-39…I-49 — ssh, tmux, agent, terminfo, logs, inventory, workspace. Every one earned by execution against a real machine. [`CLAUDE.md`](crates/yantra-core/CLAUDE.md) maps them to modules. |
| [crates/yantrad/tracker.md](crates/yantrad/tracker.md) | 7 | I-7, I-10…I-14, I-18 — SQLite, scheduling, PTY. **None exercised by shipped code**, and two were measured against runtimes ADR-0004 removed. |
| [crates/yantra-agent/tracker.md](crates/yantra-agent/tracker.md) | 2 | I-9, I-19 — telemetry and hardware. Neither exercised by shipped code. |
| [crates/yantra/tracker.md](crates/yantra/tracker.md) | 0 | and that is the finding: the CLI talks to nobody else's program, so it has nothing to be surprised by. Its contract is its exit codes. |

The four below bind no crate. They are about how this project *works* — what counts as evidence —
rather than what it talks to, so they stay here where the guardrails are.

| # | Invariant | Why | Src |
| --- | --- | --- | --- |
| I-31 **[D]** | **A test suite of instantaneous commands proves nothing about duration.** Any primitive that wraps a remote process needs at least one test with a command that takes seconds. | Y-041 shipped a watchdog that killed everything slower than ~200 ms and passed CI, because every command in its suite finished in under a millisecond. Found only when Y-042 ran `tmux`, which is merely slow enough to notice. | Y-042 |
| I-32 **[V]** | **A green CI run is not evidence unless it ran on the environment that failed.** GitHub rolls runner images out gradually, so a fix can go green five times on machines that were never broken. Re-run until the job lands on the failing image, and print the versions that matter so you can tell which one you got. | Y-048's fix passed five consecutive runs on image `20260720.247`, which had the working podman. Only the sixth landed on `20260726.254` and actually tested anything. Without the version printout, all six looked identical. | Y-048 |
| I-38 **[V]** | **A machine's own MagicDNS short name is not its tailnet address.** | `getent hosts cachyos-g14` returns `127.0.1.1`: `/etc/hosts` shadows MagicDNS for the local hostname. Self-dialling also never traverses the WireGuard path, so `tailscaled`'s port-22 interception is never reached and a self-directed `ssh` gets `Connection refused`. A workspace that names the local machine therefore fails looking like a network problem. | Y-049 |
| I-50 **[V]** | **A host *can* reach a normally-bound listener on its own tailnet address — it is the MagicDNS *name* that fails, not the address.** Anything dialling this machine must use the address. | Sharpens **I-38**, which generalised too far. I-38's "self-directed traffic never traverses the WireGuard path" is about `tailscaled` **intercepting** port 22 — interception needs that path. A real listener bound to the tailnet address needs no interception, because the address is on a local interface. Measured against a running `yantrad` on `cachyos-g14`: `curl` to its own tailnet address returned `ok`, while the same request to its own short name failed, `getent hosts` giving `127.0.1.1`. So the machine running the daemon is **not** a special case for a heartbeat, and ADR-0013 no longer has to assume it might be. | Y-020 |

### Retired

| # | Invariant | Why | Src |
| --- | --- | --- | --- |
| ~~I-15~~ | ~~tsconfig `erasableSyntaxOnly`~~ — **retired by ADR-0004.** Applies only to the web UI now, where it carries no benefit. | | R6b |
| ~~I-16~~ | ~~Zero native addons~~ — **retired by ADR-0004.** Meaningless in Rust, where everything is native. The Bun N-API minefield no longer applies. | | R6c |
| ~~I-17~~ | ~~`trustedDependencies` replaces Bun's allow-list~~ — **retired by ADR-0004.** | | R6c |

---

## 2. Milestones

Renumbered from the original 9-phase roadmap in [docs/vision.md](docs/vision.md) to front-load a working
end-to-end path. The original phases still map: M1 covers old Phases 1–3, M2 = Phase 5, M3 = Phase 4, etc.

| ID | Milestone | Definition of done (the demo that proves it) | Status |
| --- | --- | --- | --- |
| **M0** | Foundations | Research notes landed, ADRs written, repo skeleton + test harness runs green. | ✅ **done**, [archived](docs/archive/m0-m1.md) — 9 research notes, 4 ADRs, cargo workspace, CI + release pipelines, repo scaffolding. 29 commits. |
| **M1** | Walking skeleton | `yantra up demo` on my Linux box: reads one workspace file → opens tmux session → cd's to repo → runs startup cmd → prints attach hint. Idempotent (running twice attaches, doesn't duplicate). Integration-tested against a real sshd + tmux in a disposable podman container (§B3 — stricter than the `ssh localhost` this originally said). | ✅ **done**, [archived](docs/archive/m0-m1.md) — PRs #6–#11. `yantra_core::{workspace,ssh,tmux,up}` + the CLI, 4 ADRs (0005–0008), 8 invariants (I-24…I-31), 33 tests. |
| **M2** | Real machines | Same command targets a *remote* tailnet machine chosen by name. Machine inventory from Tailscale. `yantra ls machines` / `yantra ls sessions` work. | ✅ **done** 2026-07-30 — Y-050..Y-058, 9 tasks. `up` opens a session on the MacBook by name and attaches on the second run, as a committed test; `ls machines` and `ls sessions` both work. 10 invariants came out of it (I-34…I-43). Q4 (Windows) stays open by choice and blocks nothing. |
| **M3** | Agent orchestration | `yantra up demo --agent claude` launches Claude Code in the session; `yantra logs demo` tails its transcript; `yantra down demo` stops cleanly. **Claude Code only** — no plugin abstraction until a second agent is actually wanted. | ✅ **done** 2026-07-31 — Y-059..Y-065. All four commands verified end to end against a **real** Claude Code 2.1.220, not a stub: the agent launched under the id Yantra chose, `status` read it back from `claude agents --json`, `logs` rendered its transcript, and `down` produced `stopped cleanly (exit 143)`. Six invariants, I-44…I-49. |
| **M4** | Web UI | Read-only dashboard over the same HTTP API the CLI uses: machines, workspaces, sessions, live status. Served over Tailscale. | 🔵 **planned** 2026-07-31 — [docs/plans/m4-web-ui.md](docs/plans/m4-web-ui.md), Y-069..Y-073. A proposal awaiting review; **Q13 and Q14 both need the owner before code starts.** |
| **M5** | Placement | `preferred` and `automatic` modes with an explainable decision record (`yantra why demo`). | ⬜ todo |
| **M6** | Terminal in browser | Live interactive terminal attached to a session from the web UI. | ⬜ todo |
| **M7** | Appliance | Runs 24/7 on the Pi 5 / N100. Survives reboot. Notifications via ntfy. | ⬜ todo |
| **M8** | Hardware prototype | Display + rotary encoder + LEDs driving real workspace actions. **Simpler than planned:** R6 found `dtoverlay=rotary-encoder` (evdev, IRQ-decoded in kernel) and `dtoverlay=ws2812-pio` (`/dev/leds0`, RP1 PIO) — **no Rust, no microcontroller**. Panel stays a second **Rust** process for lifecycle isolation only. | ⬜ todo |
| **M9** | Enclosure & PCB | University workshop build. | ⬜ todo |

---

## 3. Task board

Closed tasks live in the archive — [M0 and M1](docs/archive/m0-m1.md),
[M2 and M3](docs/archive/m2-m3.md). This section is only what is open, so a short section is the
goal rather than a sign of a slow week.

**M4 has no breakdown yet.** It is the next thing to write, and it is two milestones wearing one
name: `yantrad` must serve `yantra-core` over HTTP before a web UI has anything to read.

### Open

| ID | Task | Status | Owner | Depends | Notes |
| --- | --- | --- | --- | --- | --- |
| Y-020 | Synthesise research → architecture decisions | ✅ done | claude | Y-010..Y-015 | ADR-0004, 0005, 0006, 0007, 0009, 0010, 0011, 0012 ✅ — and the last one, the telemetry ADR, is now **[ADR-0013](docs/adr/0013-the-heartbeat-carries-only-what-placement-scores.md)** (`proposed`; accepting it is the owner's). **Seven payload fields, chosen by the reverse of I-10** — a signal that cannot change a placement decision has no reason to be collected — which cut GPU metrics, uptime, load averages, core count, temperatures and WoL readiness, all of which R5's own fact table collected and R5's own scorer never reads. **I-9 is enforced by the type, not by a rule**: `enum Power { Ac, Battery { percent } }` makes unknown power *unrepresentable*, so the bug that scores every always-on desktop down cannot be written. `os` is excluded because Tailscale already reports it and two sources can disagree. **Identity is the source address**, not a body field, which honours I-5 and I-33 for free and is address→identity rather than name→address — so it does not reopen ADR-0009. Produced **I-50**, which sharpens I-38 and removes the special case the ADR had been braced for. |
| Y-037 | Release rehearsal via `workflow_dispatch` | ✅ done | claude | Y-034 | **Green on the first run** ([30652293147](https://github.com/2002Bishwajeet/yantra/actions/runs/30652293147)), 2026-07-31 — five targets, five archives, `publish release` correctly **skipped** because `if: github.ref_type == 'tag'` and a dispatch is a branch. Version resolved to `0.0.0-dev.<sha>`, so a rehearsal cannot be mistaken for a release. **This is the first evidence the macOS and Windows halves of the matrix work at all** — they had never been built, and [R-19](#7-risk-register) said cross-compiling to Apple targets from Linux is genuinely hard. The workflow sidesteps R-19 rather than solving it: both Apple triples build on a **macOS runner** with Apple's own toolchain, one runner covering both slices. **R-19 downgraded** accordingly — the risk is real and simply not on Yantra's path. **R-7 is untouched**: what builds for Windows is `yantra-agent`, which is still a stub that prints its version, and Windows' actual problem is that it has no tmux and cannot serve Tailscale SSH. A compiling stub refutes nothing. Archive sizes recorded for M7's budget: **963 KB** aarch64-musl and **998 KB** x86_64-musl for all three binaries, against 72–161 KB for the single-stub platforms. **Still no release**, deliberately — publishing needs a tag, and a version worth tagging. |
| Y-044 | Session state store (`rusqlite`) | ⬜ todo | — | Y-043 | Only if state genuinely can't be derived from tmux. Prefer deriving. |
| Y-066 | Say when an agent is waiting at the trust prompt | ⬜ todo | — | Y-059 | **I-49.** A fresh agent in an unseen directory is inert until a human answers *Is this a project you trust?* — no registry entry, no transcript — so `status` reports `unclear` and `logs` reports `no transcript`, both correct and both unreadable. It is distinguishable: pane alive, `claude` running in it, absent from the registry. ADR-0011's rule holds — Yantra still sends no input and still does not decide that you trust a folder — this only names the state and says to attach. |

### M4 — Web UI

Broken down 2026-07-31 — the plan is [docs/plans/m4-web-ui.md](docs/plans/m4-web-ui.md), and **it is
a proposal awaiting review, not a decision.** Two milestones wearing one name: `yantrad` must serve
`yantra-core` over HTTP before a web UI has anything to read. **Q6 binds the scope** — personal-first,
so single-tenant, no auth beyond Tailscale, no settings screen. **Q13 and Q14 block the back and
front halves respectively** and both are the owner's.

The library needs no new orchestration: everything the dashboard shows already exists as a function
returning a `Result`, which is [ADR-0005](docs/adr/0005-core-logic-in-a-library-crate.md) collecting
on an argument it made two milestones before there was a second caller. `yantrad` is still the
15-line M0 skeleton, so nothing has to be undone.

| ID | Task | Status | Owner | Depends | Notes |
| --- | --- | --- | --- | --- | --- |
| Y-068 | Split the tracker per crate | ✅ done | claude | Y-067 | Owner's ask, 2026-07-31. `tracker.md` had grown to **115 KB** — 94 KB at the start of the previous session alone — while being the file every contributor is told to read first. Split three ways, by what each part *is* rather than uniformly: the **invariants** are per-crate, because they bind code and the crate file is what is open when one is about to be broken; the **closed tasks** went to [docs/archive/m2-m3.md](docs/archive/m2-m3.md), following M0/M1's precedent; the **session log** went to [docs/session-log.md](docs/session-log.md), 40 KB of append-only history that is read approximately never. **34 KB left**, and every one of the 49 invariant rows and 23 task rows verified to appear exactly once across the repo, with all relative links re-rooted and resolved. `yantra` ended up with **zero** invariants, which is a finding rather than an omission: it talks to no one else's program, so it has nothing to be surprised by. |
| Y-069 | `yantrad serve` — bind to the tailnet or refuse | ✅ done | claude | ADR-0012 | **The daemon exists.** `axum` + `tokio`, one route (`/healthz`), a `SIGTERM` shutdown for M7's supervisor, and `tracing` — which had been a workspace dependency with no user since M0. **No clap**: the CLI's own threshold was three commands (Y-056) and this has one, so `yantrad` serves when run. The whole point is the bind address. Q6 removed authentication, so **where it listens is the entire security model** (R-22), and `listen_on` fails closed — every branch that cannot prove an address belongs to this machine returns an error, because the only default available listens to the world. Addresses come from `Self.TailscaleIPs` via a new `Inventory::addresses`, which is **`Self` only**: a peer's address would be name resolution, and [ADR-0009](docs/adr/0009-machine-names-are-ssh-destinations.md) declined that — the trait method carries the boundary so the next person cannot widen it by accident. **No `--bind` and no `--port`**; a flag that can expose the API is a flag someone eventually passes, and a test asserts the port is a constant. **Verified against the real tailnet, not just the fake**: it bound both the v4 and the v6 address, `/healthz` answered over the tailnet, `curl 127.0.0.1:7717` was **refused**, `ss -ltnp` showed the two tailnet addresses and no `0.0.0.0`, and `SIGTERM` exited **0** with the port released. 4 unit tests, and the one that matters asserts the **refusal** — a test that asserts it binds passes just as well when the fallback is `0.0.0.0`, which is R-22's stated retire condition. 136 tests, 4 skipped. |
| Y-070 | The read model — refresh in the background, never on the request path | ✅ done | claude | Y-069 | `yantra_core::snapshot` holds the **shape** and `yantrad::refresh` holds the **clock** — split that way because [ADR-0012](docs/adr/0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md) gives the daemon no logic of its own, `inventory::Fake` lives in core so the honesty rules are testable there, and anything defined in a binary crate that only tests use trips `dead_code` under `-D warnings`. One task per class: a fleet-wide session query costs a full `ConnectTimeout` per sleeping machine and the two cheap classes must not queue behind it. `EVERY = 30s`, a constant, **below `ControlPersist=300` so the poll keeps every ssh master warm rather than taxing the fleet** — and the `ControlPath` is per-user, so it speeds the CLI up too. Age leaves as a `Duration` from a monotonic `Instant`, never a wall-clock stamp, so a reading cannot get *younger* when the clock moves. **The plan named three honesty rules and there are four.** A look that *failed* is not "nobody has looked yet": if the snapshot stored only successes, a tailnet down since boot would be indistinguishable from a daemon that started a second ago — I-47 one layer up. Each class therefore stores the whole `Result` inside the reading. 6 unit tests, including one the plan never asked for. **Two things the plan got wrong**, both recorded rather than papered over: §3 says workspaces refresh *on request* while §5.2 says one task per class (§5.2 was followed), and it does not settle what a **failed** look should do to a **previous good** one — today the failure replaces it, so the API will show the failure rather than an ageing stale answer. **That is Y-071's to decide.** **144 tests**, 4 skipped. |
| Y-071 | The HTTP API, and `yantra ls workspaces` to keep the CLI honest | ⬜ todo | — | Y-070 | Four endpoints mirroring the CLI one-for-one. **The honesty check earns itself immediately**: `crates/yantrad/CLAUDE.md` says anything the web UI can do must be expressible in `yantra` first, and there is no `yantra ls workspaces` even though `workspace::list()` exists — so M4 adds it rather than letting the API get ahead of the CLI on day one. **DTOs live in `yantrad`, not `Serialize` derived on core's types**: ADR-0005 put rendering in the caller, and a JSON body is rendering — deriving it would make every field name public API and turn a rename into a silently broken page. `logs` is **not** an endpoint; an unbounded per-workspace ssh read that cannot be usefully cached belongs with M6's terminal. |
| Y-072 | The dashboard | ⬜ todo | — | Y-071, Q14 | One page, four sections, no navigation, no router, no state library. Polls `/api` against an in-memory snapshot, so it costs nothing, and shows every reading's age. **Blocked on Q14** (what it is built with). |
| Y-073 | Asset serving: directory in dev, embedded at release | ⬜ todo | — | Y-072 | Vite with hot reload in development; assets embedded in the binary for release, so the M7 appliance stays one file to copy. **Embedding goes behind a cargo feature that is off by default** — the moment a Rust build needs a JavaScript toolchain, every `fmt`/`clippy`/`test` job and the musl cross-build grow a dependency on npm (R-24). Built assets are never committed. |
| Y-074 | README: install, usage, and a Status that is not two milestones stale | ✅ done | claude | — | Owner's ask, 2026-07-31: *"I know how to use it, but what after 1 month?"* **The answer was not an API docs site** — `cargo doc` already renders every `//!` header, and those headers are the best documentation in the repo, so a site would be a second copy with a build step for an audience [Q6](#) says does not exist yet. The real gaps were smaller and all in the README: its Status still described **M1** (*"no agent integration"* — that shipped in M3), it had never shown a single command, and the workspace schema was reachable only by reading [ADR-0007](docs/adr/0007-workspace-schema-v1.md) and then applying [ADR-0010](docs/adr/0010-drop-branch-from-the-workspace-schema.md)'s amendment yourself — a decision record standing in for a reference. Now: install from source (**verified** by installing to a throwaway `--root`, not asserted), what each target machine needs and why, the workspace file as a copy-pasteable block, all eight commands, the exit-code contract, and `cargo doc --open` named as the API reference. Layout table gained the per-crate files, `docs/plans/` and the session log. **No install instructions for a release** — Y-037 has never run, so there are no binaries to point at, and instructions for an unbuilt release are instructions that do not work. |

---

## 4. Research index

| # | Topic | File | Status | Key question it must answer |
| --- | --- | --- | --- | --- |
| R1 | Tailscale / Headscale inventory | [01](docs/research/01-tailscale-inventory.md) | ✅ done | Does Tailscale give live CPU/RAM/battery, or must Yantra ship its own agent? → **Zero telemetry. Agent required.** Verified absent from `ipnstate.PeerStatus`, the full 235 KB API v2 OpenAPI spec, *and* `tailscale metrics`. |
| R2 | tmux sessions & terminal streaming | [02](docs/research/02-tmux-sessions.md) | ✅ done | How do we stream a live terminal to a browser with least work? → **Daemon-side PTY + xterm.js over WebSocket, using `Bun.Terminal`.** node-pty dropped from the plan entirely. Control mode deferred to v2 as the scaling transport; ttyd rejected as primary. |
| R3 | AI agent CLIs | [03](docs/research/03-ai-agent-clis.md) | ✅ done | Is "resume exactly where it left off" actually possible across all 5 agents? → **Not uniformly.** Only Claude Code & Gemini let you *preset* a session id; Codex & OpenCode force capture-after-launch; Aider has no session concept at all. |
| R4 | Workspace prior art | [04](docs/research/04-workspace-prior-art.md) | ✅ done | Why should Yantra exist instead of Coder / DevPod? → **Justified, but narrowly.** Coder's workspace is a Terraform build artefact; an always-on laptop it must never destroy is unrepresentable. Floor is coderd + Postgres + provisioners, sized for 1,000 users. |
| R5 | Scheduling | [05](docs/research/05-scheduling.md) | ✅ done | What is the 100-line version of a scheduler for 5 machines? → **Filter→Score→Bind, ~100 lines.** 6 hard filters, 6 weighted signals summing to 100, deterministic tie-break, never queue. Everything else from Nomad/K8s explicitly rejected. |
| R6 | Runtime feasibility | [06](docs/research/06-runtime-feasibility.md) | ✅ done | Does Bun survive the Pi 5? Where is the Rust boundary? → **GO-WITH-CAVEATS. And there is no Rust boundary** — T4 does not fire; Pi 5 device-tree overlays handle the encoder and LEDs from userspace. |
| R6a | `bun:sqlite` as datastore | [06a](docs/research/06a-bun-sqlite.md) | ✅ done | Sync-only, `busy_timeout` defaults to 0, no ORM in v1. |
| R6b | Node.js fallback runtime | [06b](docs/research/06b-node-fallback.md) | ✅ done | Node 24 LTS is the target if T1 fires. Bun keeps the job on cross-compilation + `bun:ffi` alone. |
| R6c | Bun native modules / release health | [06c](docs/research/06c-bun-native-modules.md) | ✅ done | Bun stable frozen 76 days mid Rust-rewrite. Yantra is immune to the N-API minefield — it uses zero native addons. |
| R7 | SSH exec over the system binary | [07](docs/research/07-ssh-transport.md) | ✅ done | How do you run one command over `ssh` and learn what actually happened? → **You cannot, unaided.** `ssh` reports a signal-killed command as 255 with empty stderr — `clientloop.c` has no `exit-signal` branch — so signal death, remote 255 and a dropped multiplexed connection are indistinguishable. Needs a sentinel. Separate argv buys nothing: `ssh` joins arguments and feeds the remote *login shell*. |

---

## 5. Decisions

Architecture decisions live in [`docs/adr/`](docs/adr/). Index:

| ADR | Decision | Date | Status |
| --- | --- | --- | --- |
| [0001](docs/adr/0001-record-architecture-decisions.md) | Record architecture decisions | 2026-07-28 | accepted |
| [0002](docs/adr/0002-project-name.md) | Project is named **Yantra (यन्त्र)** | 2026-07-28 | accepted |
| [0003](docs/adr/0003-runtime-and-language.md) | ~~TypeScript on **Bun**; Rust escape hatch with trigger criteria~~ | 2026-07-28 | **superseded by [0004](docs/adr/0004-rust-for-the-daemon.md)** |
| [0004](docs/adr/0004-rust-for-the-daemon.md) | **Rust for the daemon, CLI and agent; TypeScript for the web UI** | 2026-07-28 | accepted |
| [0005](docs/adr/0005-core-logic-in-a-library-crate.md) | Orchestration logic lives in a **library crate**; binaries stay thin | 2026-07-29 | accepted |
| [0006](docs/adr/0006-ssh-exec-transport.md) | The SSH exec primitive: **system `ssh` + `ControlMaster`**, sentinel trailer, base64 payload | 2026-07-29 | accepted, amended by [0008](docs/adr/0008-withdraw-the-stdin-watchdog.md) |
| [0007](docs/adr/0007-workspace-schema-v1.md) | Workspace schema v1 in TOML, **with provisioning as an explicit non-goal** | 2026-07-29 | accepted, amended by [0010](docs/adr/0010-drop-branch-from-the-workspace-schema.md) |
| [0008](docs/adr/0008-withdraw-the-stdin-watchdog.md) | The stdin-EOF watchdog is withdrawn | 2026-07-29 | accepted |
| [0009](docs/adr/0009-machine-names-are-ssh-destinations.md) | A workspace's `machine` is an **ssh destination, not a Yantra identifier** — the Tailscale inventory observes, never resolves | 2026-07-30 | accepted |
| [0010](docs/adr/0010-drop-branch-from-the-workspace-schema.md) | **`branch` is dropped** — it was parsed and never acted on; branch selection returns in M3 as worktrees, not checkouts | 2026-07-30 | accepted |
| [0011](docs/adr/0011-claude-code-runs-as-a-tui-in-tmux.md) | **Claude Code runs as a TUI in tmux; the transcript JSONL is the log** — no headless path in M3. Closes Q7/Y-024 | 2026-07-30 | accepted |
| [0012](docs/adr/0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md) | **The CLI and the daemon are two callers of one library** — the CLI keeps calling `yantra_core` in-process | 2026-07-31 | accepted |
| [0013](docs/adr/0013-the-heartbeat-carries-only-what-placement-scores.md) | **The heartbeat carries only what placement scores** — seven fields, identity from the source address | 2026-07-31 | **proposed** |

**Still to write.** Numbers are assigned when an ADR is written, never reserved — this list had
drifted a full four rows out of step with `docs/adr/` before it was rebuilt on 2026-07-30, because
planned decisions were holding numbers that written ones then took.

| Decision | Blocked on |
| --- | --- |
| ~~Machine telemetry~~ | ✅ **written 2026-07-31 as [ADR-0013](docs/adr/0013-the-heartbeat-carries-only-what-placement-scores.md)**, status `proposed` — awaiting the owner, since accepting an ADR is not Claude's call. |

---

## 6. Open questions

| # | Question | Blocks | Owner |
| --- | --- | --- | --- |
| ~~Q1~~ | ~~Why not just run Coder / DevPod?~~ | — | ✅ **CLOSED 2026-07-31: signed off by the owner — "Coder is not useful for my case."** The kill criterion is cleared; Y-021 done. |
| ↳ | **R4's answer:** Coder models a workspace as a *Terraform build artefact* — `start`/`stop`/`delete` are `terraform apply` transitions. A machine that already exists, is always on, and must **never be destroyed** (my MacBook) is unrepresentable in that model. Its floor is coderd + Postgres 13+ + provisioners, with the smallest validated architecture sized for 1,000 users. Yantra's niche: **pre-existing, personally-owned, heterogeneous machines**. | | |
| Q2 | Which machines actually exist today, with what specs and OS? | M2 | biswa |
| Q3 | Is a per-machine Yantra agent required, or can we get by with SSH polling? | ADR-0007 | ✅ **CLOSED. Push-heartbeat agent, 10s interval, stale at 30s.** R1: Tailscale exposes zero telemetry, so an agent is required. R5 then killed my SSH-poll preference outright — **SSH cannot see a sleeping laptop**, and a scheduler whose main job is "is this machine usable right now" cannot be blind to sleep. node_exporter/Glances also rejected. |
| Q4 | Windows: first-class, or WSL2-only? | M2 scope | 🟡 **deliberately left OPEN.** Owner declined to commit to WSL2 (2026-07-28). Deferred to M2, when real remote machines first matter — it does not block M1.<br>**Binding constraint meanwhile: write no code that assumes either answer.** The transport trait must not hard-code POSIX-isms in its signature, and nothing may assume `tmux` or `ControlMaster` exist on a target. Windows genuinely lacks all three of tmux, `ControlMaster` and Tailscale-SSH-as-server (R-7), so whatever is decided, it is a second path — the job now is to keep adding that path cheap rather than to pick it early. <br>**Y-022 narrows it:** the tailnet's only Windows node is the second boot of a laptop that already runs Linux, so supporting Linux-only costs **zero machines**. Meanwhile macOS is one of just two online hosts, making it the more urgent portability question. Also: **Tailscale SSH can never serve Windows** — its server component is Linux and open-source-macOS only — so a Windows target needs OpenSSH-for-Windows and has no tmux, two separate problems rather than one. |
| ~~Q5~~ | ~~Secrets: reference-only or does Yantra hold them?~~ | — | ✅ **CLOSED: reference-only, always.** Workspaces store a pointer (`op://…`, `pass show …`, a sops path); Yantra resolves it at launch, hands it to the process, and never writes it to SQLite, logs, the API, or a terminal stream. Holding secrets would mean earning the right to — encryption at rest, key management, stream redaction, audit. That is a security product, not a workspace orchestrator. |
| ~~Q6~~ | ~~Open-source-for-others or personal-first?~~ | — | ✅ **CLOSED 2026-07-31: personal-first. Open source for others later.** So no plugin architecture, no multi-user model, no configuration surface added for a hypothetical second user — one fleet, one owner, and the second user is a later problem that a working tool earns the right to have. The repo stays public; that is a licence and a habit, not a promise of extensibility. **Binds M4 directly:** the web UI is a dashboard for its owner, not a product — single-tenant, no auth beyond Tailscale, no theming, no settings screen. |
| ~~Q7~~ | ~~Is the agent control path **TUI-in-tmux** or **headless**?~~ | — | ✅ **CLOSED 2026-07-30: TUI in tmux, one path** — [ADR-0011](docs/adr/0011-claude-code-runs-as-a-tui-in-tmux.md). R3's "all five are safer driven headless" is knowingly overruled on evidence R3 did not have: two of its three hazards belong to agents Yantra does not ship, and the third (#63545) did not reproduce. Headless leaves nothing to attach to, which is the one thing Yantra is for. The transcript JSONL is the log, `claude agents --json` is the status source, and `claude auth status` gates the launch so I-44 cannot produce a healthy-looking useless session. |
| Q8 | Do we adopt **server mode** where it exists (OpenCode `serve` HTTP+SSE, Codex `app-server daemon`)? Strictly better than tmux-wrapping, but adds a second transport. | ADR-0006 | biswa |
| Q11 | **Should session-affinity be a score term at all?** R5 raises it against itself: the live-session short-circuit already delivers idempotent `yantra up X`, so a 20-point affinity weight may be re-solving a solved problem. Prior: **drop it**, and let the short-circuit do the work. | M5 scoring weights | biswa |
| Q10 | **Wake-on-LAN**: R1 says Tailscale never exposes MACs and has no `wake` command — WoL needs the Pi 5 as an always-on **L2 relay** plus a hand-maintained MAC table. Accept that manual table, or drop WoL from the scheduler until the appliance exists (M7)? Prior: **drop until M7**; a scheduler that can't wake a machine simply won't place work there. | M5 scope | biswa |
| ~~Q9~~ | ~~Ship Aider or drop it?~~ | — | ✅ **CLOSED: dropped from v1.** No session id, no resume, no JSON, no MCP, ~1 release in 6 months. Yantra's core promise is "continue where you left off"; Aider has no session to continue, so supporting it would mean faking the product's central feature. Revisit only if it grows a session model. |
| ~~Q13~~ | ~~Does the CLI start talking HTTP to the daemon?~~ | — | ✅ **CLOSED 2026-07-31: (a), two callers of one library** — [ADR-0012](docs/adr/0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md). The CLI keeps calling `yantra_core` in-process and keeps working with no daemon running; `yantrad` becomes a second caller of the same functions. (b) would have made the one working interface — four milestones of verified behaviour — depend on the fifteen-line skeleton, in the milestone that first proves the skeleton can serve a page, and it is the only one of the two that is hard to reverse. The ADR records what would justify revisiting: a client that is not on the operator's machine (M6/M8), state that must not be derived twice, or a placement decision the CLI must also see (M5). |
| Q14 | **What is the web UI built with?** ADR-0004 settled TypeScript and correctly said no more — there was no UI to have an opinion about. **No framework** (TS + Vite + the DOM: smallest thing that works, no treadmill, gets unpleasant when M6 adds a terminal), **Svelte** (least code for this shape, compiles away), or **React** (most likely already familiar, most prior art for M6's terminal, heaviest for four tables). Q6 removes the usual tiebreakers — there is no team to hire for. **No prior.** This is about what will still be worth maintaining in a year, which the plan cannot measure. Should be an ADR, because M6 builds on it. | Y-072 | biswa |
| Q12 | **Is R-1 actually retired, or only retired on Linux?** Issue #63545 is a **macOS + tmux** report; Y-023's spike ran on `cachyos-g14`, which is Linux, because the MacBook was unreachable until Y-049 closed on 2026-07-30. The spike's evidence is real (18,427 bytes written while fully detached on 2.1.220) and also argues against the open Linux issue #70632 — but R-1, Q7 and the Claude Code integration ADR were all retired or unblocked on Linux-only evidence, for a bug filed against macOS. Third-party support exists (open issue #79188, macOS 2.1.215, found plain tmux persists correctly) but that is someone else's machine, which §B3 says not to accept. Prior: **re-run the Y-023 spike against the MacBook before M3 builds on it** — cheap now that the machine is reachable — and make `yantra logs` assert the transcript mtime is *advancing*, not merely that the file exists, because #70632's failure mode looks healthy until you tail it. | M3, the Claude Code integration ADR | claude |
| ↳ | **Re-run on 2026-07-30. It did not get as far as R-1, because a prior problem stops it: on macOS an agent launched over SSH is not authenticated (I-44).** Claude Code 2.1.220 booted in a fully detached tmux session on the MacBook, took a prompt, and answered `Not logged in · Please run /login` — its token is in the login keychain, which the `Background` launchd domain an ssh session gets cannot read. So R-1 stays **untested on macOS**, and the transcript question is now behind Y-059 rather than beside it. Two things were learned anyway: the transcript file **is** created and written while fully detached on macOS (57,841 bytes, `session_attached=0` throughout), so the file-write path is not the problem; and Q12's own suspicion was right in kind — Linux evidence did not transfer — while wrong about which mechanism would break. | | |

---

## 7. Risk register

Risks that can invalidate a design, ordered by damage. A risk is retired only by evidence, not by optimism.

| # | Risk | Impact if real | Status | Retire by |
| --- | --- | --- | --- | --- |
| ~~R-0~~ | ~~Bun on the Pi 5 16 KB-page kernel~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| ~~R-1~~ | ~~Claude Code #63545: detached tmux stops writing transcript JSONL~~ | — | 🟢 **RETIRED by Y-023** — did not reproduce on 2.1.220; transcript written while detached within 5 s | — |
| R-2 | Gemini CLI self-terminates ~5s after TTY loss, **exit code 0**. | Silent, successful-looking death of an automated session. Exit code 0 means naive health checks report success. | 🟡 known, mitigable | Set `SANDBOX` env, or forbid non-tmux launches |
| R-3 | Agent CLIs churn fast — OpenCode ships hourly builds with channel-dependent DB filenames; Codex removed three documented flags this cycle. | Yantra's agent plugins break without any change on our side. | 🟡 accepted | Pin agent versions; treat R3 note as perishable |
| ~~R-4~~ | ~~Bun may not survive the Pi 5~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — moot; the daemon is Rust | — |
| R-5 | Coder/DevPod may already solve this well enough for a personal setup. | Project's justification. | 🟢 **retired by R4** — Coder cannot represent a never-destroy, always-on personal machine. Sign-off still open (Y-021). | — |
| R-6 | **Scope creep into provisioning.** The gravitational pull from "adopt a machine" toward "create a machine" is strong and would make Yantra a worse Coder. | Project loses its only defensible niche. | 🟡 permanent | Written as a non-goal in ADR-0005; re-check at every milestone |
| R-7 | **Windows breaks every standardisation.** No tmux; Windows OpenSSH lacks `ControlMaster`; and per R1, **Tailscale SSH cannot act as a server on Windows** — so one uniform SSH mechanism across the fleet is impossible. | Transport + session design silently assumes POSIX; a second code path appears late in M2. | 🟡 open | Q4 decision — declare Windows = WSL2 for M1–M3 |
| **R-22** | **The bind address is the entire security model.** Q6 removed auth, so a listener on the wrong interface is an unauthenticated read API over the fleet's shape — machine names, workspace names, repo paths. | Everything `yantrad` can read, readable by anything that can reach the port. | 🟢 **mitigated 2026-07-31 by Y-069, and measured** — but **[ADR-0013](docs/adr/0013-the-heartbeat-carries-only-what-placement-scores.md) widens what it covers**: a heartbeat `POST` is the first *write* into the daemon, so "read-only and unauthenticated" becomes "writable and unauthenticated". The retire condition is unchanged; the blast radius is not. Address comes from Tailscale rather than configuration; no flag can override it; the daemon refuses to start without one. Confirmed on the real tailnet: `ss -ltnp` shows the two tailnet addresses and **no `0.0.0.0`**, and `curl 127.0.0.1:7717` is refused. | ~~A test that asserts the daemon refuses~~ — **shipped**: `it_refuses_to_start_when_this_machine_holds_no_address`. Stays amber-to-green rather than retired while the API surface is still growing. |
| **R-23** | **A cached dashboard tells confident lies.** Every failure mode of the read model looks like working software: a stale session list, a machine silently dropped from a snapshot, an empty page that actually means "the first refresh has not run". | Worse than no dashboard — a page that is wrong in a way nobody can see is trusted anyway. | 🟡 **new with M4.** Mitigated by the three rules in [the plan](docs/plans/m4-web-ui.md) §5.2, each a *display* requirement and not merely a data one. I-47 is the same mistake one layer down. | Age shown on every reading; unreachable rendered as unreachable; `Option` never defaulted to empty. |
| **R-24** | **The JS toolchain leaks into the Rust build.** Starts as a convenient `build.rs`, ends with `cargo clippy` and the `aarch64-unknown-linux-musl` cross-build needing npm. | Every CI job and the appliance build grow a dependency on a toolchain none of them need. | 🟡 **new with M4.** Mitigated by embedding behind a cargo feature that is off by default, and by a separate CI job for the UI. | `cargo build` green on a machine with no Node installed. |
| **R-21** | **macOS agents cannot authenticate over SSH.** Claude Code's account token lives in the login keychain; an ssh session runs in launchd's `Background` domain and cannot read it (**I-44**). The failure is silent at the keychain layer and only visible as *not logged in* in the agent's own TUI. | M3's whole demo — `yantra up demo --agent claude` — produces a running, healthy-looking, **useless** session on macOS, which is one of the two online machines in this fleet. Everything downstream (`logs`, status) reports success. | 🔴 **open, new 2026-07-30** — verified end to end, not inferred | **Y-059.** Candidates: launch the agent inside a tmux server started from the GUI session (untested, costs nothing if it works), a launchd LaunchAgent in `gui/<uid>` (what R-12's per-machine agent already has to be), or a credential *reference* resolved at launch per Q5. `security unlock-keychain` is not a candidate — it needs a password. |
| R-8 | **`Online: true` means "the control plane sees it", not "you can reach it".** Also `Expired` nodes need surfacing. | Scheduler happily places work on an unreachable machine; `yantra up` hangs instead of failing fast. | 🟡 known, mitigable | Probe with `tailscale ping` before placement; treat `Online` as a hint only |
| ~~R-16~~ | ~~Bun stable frozen mid Rust-rewrite~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| ~~R-18~~ | ~~Bun "closed" issues are not fixed~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| ~~R-17~~ | ~~Bun/Node test suites not portable~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| ~~R-14~~ | ~~`bun:sqlite` blocks the event loop~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| ~~R-15~~ | ~~macOS Bun bundles no SQLite~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| ~~R-19~~ | ~~**Cross-compiling Rust to macOS from Linux is genuinely hard** (needs the Apple SDK via osxcross), where `bun build --compile` did it in one command. The per-machine push-agent (R-12) must run on macOS and Windows.~~ | Build tooling friction for the agent, not the daemon. Worst case, the appliance cannot build the Mac agent by itself. | 🟢 **RETIRED 2026-07-31 by Y-037**, on its own stated condition. Both Apple triples build on a **macOS runner** with Apple's own toolchain — one runner carries both slices — so nothing is cross-compiled to Apple from Linux and osxcross never enters the picture. Green on the first attempt, 155 KB and 161 KB archives. The risk was real; it is simply not on Yantra's path. | Build on native runners in CI rather than cross-compiling. `aarch64-unknown-linux-musl` for the appliance is unaffected and stays trivial. |
| R-20 | **Rust punishes design churn, and M0–M1 is exactly where the design is still unknown.** | Slower first month; a wrong early abstraction is more expensive to unpick than in TS. | 🟡 accepted knowingly | ADR-0004 records this as the consciously-paid cost. Mitigation: walking skeleton first, narrow traits, resist abstraction until the third use. |
| R-12 | **The push-agent has an install-and-update story on every machine.** Q3's answer converts Yantra from "pure orchestrator, zero footprint" into "ships software to five heterogeneous machines" — including macOS launchd, Windows service, and Linux systemd. | Real, permanent scope increase. Also weakens the "we only orchestrate" identity if it grows. | 🟡 accepted, must stay tiny | Keep the agent to heartbeat-only; no logic, no versioned protocol beyond a JSON blob |
| R-13 | **macOS and Windows telemetry commands are doc-sourced only.** R5 verified the Linux commands locally; the other two OSes were not run on real hardware. | The scheduler mis-scores exactly the machines it was built to choose between. | 🟡 unverified | Verify during Y-022, on the real Mac and Windows box |
| ~~R-11~~ | ~~`Bun.Terminal` documented-only~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| ~~R-9~~ | ~~Tailscale LocalAPI from Bun~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| R-10 | **Hostname collisions are already real** — R1 found HostName colliding **twice in your existing 5-node tailnet**. | Keying anything on hostname corrupts inventory from day one. | 🟢 avoidable by design | Key on `Peer.ID`; treat HostName as a display label only |

---

## 8. Session log

**Moved to [docs/session-log.md](docs/session-log.md)** on 2026-07-31 (Y-068) — append there, not
here. It was 40 KB, a third of this file, and it is read approximately never, while this file is read
first by everyone. M0 and M1's entries are further back, in
[docs/archive/m0-m1.md](docs/archive/m0-m1.md).
