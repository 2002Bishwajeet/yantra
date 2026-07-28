# Yantra — Tracker

**This file is the single source of truth for project state.**
Read it first. Update it last. If it disagrees with your memory, the file wins.

| | |
| --- | --- |
| **Project** | Yantra (यन्त्र) — personal developer control plane |
| **Current milestone** | `M0 — Foundations` |
| **Status** | 🟡 In progress — research complete (9 notes); **workspace skeleton builds and cross-compiles to arm64** |
| **Runtime** | **Rust** (daemon, CLI, per-machine agent) + **TypeScript** (web UI) — see [ADR-0004](docs/adr/0004-rust-for-the-daemon.md), which supersedes ADR-0003 |
| **Top risk** | **R-7** — Windows breaks tmux, `ControlMaster` *and* Tailscale SSH-server. *R-0 retired with Bun; R-1 refuted by Y-023.* |
| **Last updated** | 2026-07-28 |
| **Updated by** | Claude (session: base setup) |

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
- **No UI until the CLI is good.** The CLI is the API's first client and its honesty check.
- **No hardware until the software is boring.** Phases 7–9 are a reward, not a shortcut.
- **Test hard.** Every orchestration primitive gets an integration test against a real sshd + real tmux. Mocks lie about SSH. **The fixture is a disposable podman container**, not the host — a separate filesystem, user and network hop make it a more honest stand-in for a remote machine than `ssh localhost`, and it changes nothing about the host's security posture.
- **Rust for the daemon, TypeScript for the web UI** — [ADR-0004](docs/adr/0004-rust-for-the-daemon.md). Chosen for quality and appliance fit over iteration speed, with that trade made explicitly. Rust punishes design churn, so **think before writing**: this is the milestone where the shape is still unknown.
- **Keep SSH, tmux, telemetry and hardware behind narrow traits.** Not to enable a runtime swap any more — to keep the four seams that touch an unreliable outside world fakeable in tests.

---

## 1b. Invariants discovered by research

Non-obvious rules that research proved the hard way. Violating one of these produces a bug that looks
like something else entirely. **[V]** = verified by execution, **[D]** = documented only.

| # | Invariant | Why | Src |
| --- | --- | --- | --- |
| I-1 **[V]** | Idempotent open is plain `new-session -d` + **treat `duplicate session:` as success**. Do **not** use `new-session -A -d` (broken from a non-TTY daemon) and do **not** use `has-session \|\| create` (TOCTOU race). | The obvious two ways to do this are both wrong. | R2 |
| I-2 **[V]** | Session names restricted to `[A-Za-z0-9_-]`, always addressed as `-t "=name"`. | `:` or `.` in a name makes the session **permanently unaddressable**, and `=` does not rescue it. Targets are otherwise prefix-matched, so `demo` can hit `demo2`. | R2 |
| I-3 **[V]** | Transcripts come from `pipe-pane`, never `capture-pane` polling. Gate arming on `#{pane_pipe}`; cap log size from day one. | `-S -N` is **not** "last N lines", scrollback is unreachable while an agent TUI holds the alternate screen, and passing `-o` twice silently *disables* logging. | R2 |
| I-4 **[V]** | Set `remain-on-exit on` on every agent session. | Without it exit codes are unrecoverable, and **"crashed" is indistinguishable from "finished"**. | R2 |
| I-5 **[V]** | Key machine inventory on `Peer.ID`. HostName is a display label only. | HostName already collides twice in the existing 5-node tailnet. | R1 |
| I-6 **[V]** | LocalAPI requests must send `Host: local-tailscaled.sock` or return 403. | Silent, misleading failure mode. | R1 |
| I-7 **[D]** | Own reboot recovery in Yantra's own store. Do **not** adopt tmux-resurrect/continuum. | They re-run whitelisted commands rather than restore processes, on a 15-minute lossy timer — worse than nothing for an agent session. | R2 |
| I-8 **[D]** | Define the `Multiplexer` interface with **JSON-shaped return types** now, even though only tmux is implemented. | zellij's `subscribe --format json` / `list-panes --json` are genuinely better than tmux's format DSL; a format-string-shaped interface would have to be rewritten. | R2 |
| I-9 **[V]** | **Absence of power-supply data must mean AC, never "unknown".** Desktops have *no* `/sys/class/power_supply/AC*` entry at all; `BAT0/status` reads `Not charging` while on AC; `Win32_Battery` returns **no instances** on Windows desktops. | The naive reading marks every desktop "unknown power" and the battery signal silently mis-scores the most placeable machines in the fleet. | R5 |
| I-10 **[D]** | **If a signal is not in the decision record, it must not influence the decision.** | The explainability contract. `yantra why` is worthless the moment a hidden term can move the outcome. | R5 |
| I-11 **[D]** | Tie-breaks are deterministic: score → static `priority` → name. Explicitly **reject** kube-scheduler's random tie-break. | Reproducibility is the whole point of an explainable placement. | R5 |
| I-12 **[V]** | **Set `busy_timeout` and `journal_mode = WAL` explicitly on every connection open.** Never rely on the binding's default. | Verified across **two independent bindings** — `bun:sqlite` defaults to 0, and `node:sqlite`'s `timeout` also defaults to 0. This is a SQLite-binding trap, not a runtime quirk, so confirm it for `rusqlite` too. Five machines heartbeating every 10 s will otherwise produce intermittent `SQLITE_BUSY` that presents as a network or agent fault. | R6a, R6b |
| I-13 **[D]** | **SQLite calls go through `spawn_blocking`. Keep queries O(small) regardless.** | `rusqlite` wraps a synchronous C API. Called directly from an async task it stalls the tokio worker serving WebSocket terminal streams — the same failure Bun had (a 400 ms query served **0 of 100** concurrent pings), for the same reason, but with a proper fix available. | R6a + ADR-0004 |
| I-14 **[D]** | **No ORM in v1** — `rusqlite` with hand-written SQL. Back up with `VACUUM INTO`. | Yantra's schema is four small tables. Diesel/SeaORM buy migrations and compile-time type-safety we do not yet need, at the cost of build time and indirection. Revisit when the schema stops being trivial. | R6a + ADR-0004 |
| I-18 **[V]** | **The PTY must give the child a controlling terminal**, or `^C` will not work. Verify this explicitly in the `portable-pty` integration test. | Found the hard way in Bun (`new Bun.Terminal()` had exactly this defect). The bug is language-independent and easy to ship unnoticed — an interactive terminal that cannot be interrupted. | R6 |
| I-19 **[V]** | **Never hardcode a `gpiochip` number.** Discover it at runtime. | The Pi 5's RP1 southbridge moved the chip numbering; hardcoded values silently address the wrong chip. | R6 |
| I-20 **[V]** | **Transport is the system `ssh` binary with `ControlMaster` multiplexing** — not a library. **Windows OpenSSH does not support `ControlMaster`** (verified, open since 2019). | Zero library surface to maintain, free `~/.ssh/config` fidelity, and it is what VS Code Remote and JetBrains Gateway both do. Keeps `russh` out of the dependency tree entirely. The Windows gap is another entry on the R-7 pile. | R6, R4 |
| I-21 **[V]** | **`=name` is not a valid *pane* target.** It resolves for session-level commands (`list-panes`, `set-option`) but **fails** for `capture-pane`/`send-keys`/`pipe-pane`. Capture the `pane_id` (`%N`) at creation and address panes by that. | Verified in Y-023: `capture-pane -t "=tc3"` -> *can't find pane*, while `list-panes -t "=tc3"` succeeded on the same live session. `=name:` (trailing colon) also works. `pane_id` is stable and unambiguous. | Y-023 |
| I-22 **[V]** | **Never pipe an agent's stdout** (`claude ... \| tee`). It destroys TTY detection - Claude Code silently falls into `--print` mode and dies with *"Input must be provided..."*. Log via `pipe-pane`. | Verified in Y-023 by doing exactly this wrong. Reinforces I-3 from a second direction. | Y-023 |
| I-23 **[V]** | **Pre-seed `hasTrustDialogAccepted` before launching Claude Code in a new directory** - `~/.claude.json` -> `projects.<abs-path>`. | On first run in an unseen directory the TUI opens a *trust this folder* dialog that **silently swallows keystrokes**: an automated `send-keys` prompt is typed into the dialog and Enter answers it. Presents as the agent ignoring you. | Y-023 |
| ~~I-15~~ | ~~tsconfig `erasableSyntaxOnly`~~ — **retired by ADR-0004.** Applies only to the web UI now, where it carries no benefit. | | R6b |
| ~~I-16~~ | ~~Zero native addons~~ — **retired by ADR-0004.** Meaningless in Rust, where everything is native. The Bun N-API minefield no longer applies. | | R6c |
| ~~I-17~~ | ~~`trustedDependencies` replaces Bun's allow-list~~ — **retired by ADR-0004.** | | R6c |

---

## 2. Milestones

Renumbered from the original 9-phase roadmap in [docs/vision.md](docs/vision.md) to front-load a working
end-to-end path. The original phases still map: M1 covers old Phases 1–3, M2 = Phase 5, M3 = Phase 4, etc.

| ID | Milestone | Definition of done (the demo that proves it) | Status |
| --- | --- | --- | --- |
| **M0** | Foundations | Research notes landed, ADRs written, repo skeleton + test harness runs green in CI-less local run. | 🟡 doing — **all 9 research notes landed**; ADRs 0004–0008 and the skeleton remain |
| **M1** | Walking skeleton | `yantra up demo` on my Linux box: reads one workspace file → opens tmux session → cd's to repo → runs startup cmd → prints attach hint. Idempotent (running twice attaches, doesn't duplicate). Integration-tested against `ssh localhost`. | ⬜ todo |
| **M2** | Real machines | Same command targets a *remote* tailnet machine chosen by name. Machine inventory from Tailscale. `yantra ls machines` / `yantra ls sessions` work. | ⬜ todo |
| **M3** | Agent orchestration | `yantra up demo --agent claude` launches the agent in the session; `yantra logs demo` tails it; `yantra down demo` stops cleanly. One agent plugin, done properly. | ⬜ todo |
| **M4** | Web UI | Read-only dashboard over the same HTTP API the CLI uses: machines, workspaces, sessions, live status. Served over Tailscale. | ⬜ todo |
| **M5** | Placement | `preferred` and `automatic` modes with an explainable decision record (`yantra why demo`). | ⬜ todo |
| **M6** | Terminal in browser | Live interactive terminal attached to a session from the web UI. | ⬜ todo |
| **M7** | Appliance | Runs 24/7 on the Pi 5 / N100. Survives reboot. Notifications via ntfy. | ⬜ todo |
| **M8** | Hardware prototype | Display + rotary encoder + LEDs driving real workspace actions. **Simpler than planned:** R6 found `dtoverlay=rotary-encoder` (evdev, IRQ-decoded in kernel) and `dtoverlay=ws2812-pio` (`/dev/leds0`, RP1 PIO) — **no Rust, no microcontroller**. Panel stays a second **Rust** process for lifecycle isolation only. | ⬜ todo |
| **M9** | Enclosure & PCB | University workshop build. | ⬜ todo |

---

## 3. Task board

### M0 — Foundations

| ID | Task | Status | Owner | Depends | Notes |
| --- | --- | --- | --- | --- | --- |
| Y-001 | Decide project name | ✅ done | biswa | — | **Yantra (यन्त्र)** → [ADR-0002](docs/adr/0002-project-name.md) |
| Y-002 | Decide runtime & language | ✅ done | biswa | — | **Rust** (daemon/CLI/agent) + TypeScript (web UI) → [ADR-0004](docs/adr/0004-rust-for-the-daemon.md). Supersedes the same-day Bun decision in ADR-0003. |
| Y-003 | Archive brainstorm + vision docs | ✅ done | claude | — | `docs/brainstorm.md`, `docs/vision.md` |
| Y-004 | Create this tracker | ✅ done | claude | — | `tracker.md` |
| Y-010 | R1: Tailscale/Headscale machine inventory | ✅ done | agent | — | → [01-tailscale-inventory.md](docs/research/01-tailscale-inventory.md). Answers Q3, reinforces Q4 |
| Y-011 | R2: tmux session control & streaming | ✅ done | agent | — | → [02-tmux-sessions.md](docs/research/02-tmux-sessions.md). Findings marked **[V]** were executed against tmux 3.7b; **[D]** are docs-only |
| Y-012 | R3: AI agent CLIs — launch/resume/logs | ✅ done | agent | — | → [03-ai-agent-clis.md](docs/research/03-ai-agent-clis.md). ⚠️ Surfaced R-1 (below) |
| Y-013 | R4: Workspace prior art (incl. "why not Coder?") | ✅ done | agent | — | → [04-workspace-prior-art.md](docs/research/04-workspace-prior-art.md). Answers Q1 & Q4 |
| Y-014 | R5: Scheduling & placement | ✅ done | agent | — | → [05-scheduling.md](docs/research/05-scheduling.md). **Settles the push-vs-poll half of Q3** |
| Y-015 | R6: Bun-on-Pi5 / SSH / PTY / GPIO feasibility | ✅ done | agent | — | → [06](docs/research/06-runtime-feasibility.md) + sub-notes [06a](docs/research/06a-bun-sqlite.md) / [06b](docs/research/06b-node-fallback.md) / [06c](docs/research/06c-bun-native-modules.md). **Verdict: GO-WITH-CAVEATS** |
| Y-020 | Synthesise research → architecture decisions | 🔵 doing | claude | Y-010..Y-015 | ADR-0004 (runtime) ✅ written. Remaining: ADR-0005 (transport), ADR-0006 (workspace schema), ADR-0007 (telemetry). ADR-0008 blocked on Y-023. |
| Y-021 | Answer "why not just use Coder?" in writing | ⬜ todo | biswa | Y-013 | Kill criterion. If the answer is weak, we rescope. |
| Y-022 | Inventory my actual machines | ⬜ todo | biswa | — | Real hostnames/OS/specs → `docs/machines.md`. Grounds M2 in reality. **R1 found a live 5-node tailnet with 2 HostName collisions** — resolve those names here. |
| ~~Y-025~~ | ~~Spike: Tailscale LocalAPI from Bun~~ | ⬛ dropped | — | — | Superseded by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md). Reading the unix socket from Rust (`hyper` + `hyperlocal`) is unremarkable; I-6's `Host:` header rule still applies. |
| ~~Y-026~~ | ~~Install and pin Bun~~ | ⬛ dropped | — | — | Superseded by ADR-0004. |
| ~~Y-028~~ | ~~Verify Bun on Pi 5 page size~~ | ⬛ dropped | — | — | **Retired with R-0** — the page-size defect was JSC/Bun-specific, not arm64. A static musl Rust binary is unaffected. |
| ~~Y-027~~ | ~~Spike: verify `Bun.Terminal`~~ | ⬛ dropped | — | — | Superseded by ADR-0004. Replaced by the `portable-pty` controlling-terminal check in I-18. |
| Y-023 | **Spike: reproduce Claude Code issue #63545** | ✅ done | claude | — | **R-1 REFUTED.** Interactive `claude` 2.1.220 in a fully detached tmux session writes its transcript normally — 18,427 bytes / 10 entries incl. `user`+`assistant`, on disk within 5 s. Tail-the-transcript is viable. Yielded I-21, I-22, I-23. |
| Y-024 | Decide TUI-in-tmux vs headless as Yantra's control path for agents | ⬜ **unblocked** | biswa | Y-023 ✅ | → ADR-0008. Y-023 removed the argument against TUI-in-tmux. See Q7. |
| Y-029 | Install the Rust toolchain | ✅ done | biswa+claude | — | rustc/cargo 1.97.1, just 1.57.0, zig 0.16.0, mold 2.41.0, cargo-zigbuild, cargo-deny, cargo-nextest. Targets: `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-musl`. |
| Y-030 | **Rust workspace skeleton** | ✅ done | claude | Y-029 | 3 crates + `justfile`, `deny.toml`, pinned `rust-toolchain.toml`, mold linker, workspace clippy lints (`unwrap_used`/`expect_used`/`panic` = warn, `unsafe_code` = forbid). `cargo build`, `fmt --check`, `clippy -D warnings` all green. |
| Y-033 | CI workflow — fmt, clippy, test, deny, arm64 cross-build | 🔵 review | agent | Y-030 | [PR #2](https://github.com/2002Bishwajeet/yantra/pull/2), branch `ci/github-actions`. Must mirror `just check` exactly. |
| Y-034 | Release workflow — tag-triggered cross-platform matrix | 🔵 review | agent | Y-030 | [PR #3](https://github.com/2002Bishwajeet/yantra/pull/3), branch `ci/release`. arm64-musl verified locally (330 KB static); macOS/Windows jobs unverified — needs a `workflow_dispatch` rehearsal after merge. |
| Y-035 | Repo scaffolding — PR/issue templates, CONTRIBUTING, SECURITY, dependabot | 🔵 review | agent | — | [PR #1](https://github.com/2002Bishwajeet/yantra/pull/1), branch `chore/repo-scaffolding`. Branch-protection ruleset proposed in the PR body, **not applied** — owner's call. |
| Y-036 | Apply branch protection to `main` | ⬜ todo | biswa | Y-033 | Needs CI merged first so the required status checks exist to select. |
| Y-037 | Release rehearsal via `workflow_dispatch` | ⬜ todo | claude | Y-034 | Builds every target, publishes nothing. The only way to verify the macOS/Windows matrix. |
| Y-031 | Test harness: **podman** sshd + real tmux fixture | ⬜ todo | claude | Y-030, Y-011 | Disposable container, not host sshd — no port opened, nothing to undo, and a truer remote-machine analogue. Non-negotiable per §1. |

| Y-032 | Verify `aarch64-unknown-linux-musl` cross-build | ✅ done | claude | Y-030 | **`cargo zigbuild` works from this x86_64 box.** Output: *ELF 64-bit, ARM aarch64, statically linked, stripped* — **330 KB** per binary, 51 s cold. ADR-0004's appliance argument is now measured, not assumed. |
### M1 — Walking skeleton *(not started; tasks drafted after Y-020)*

| ID | Task | Status | Owner | Depends | Notes |
| --- | --- | --- | --- | --- | --- |
| Y-040 | Workspace schema v1 + loader | ⬜ todo | — | Y-020 | Smallest useful field set. |
| Y-041 | SSH exec primitive | ⬜ todo | — | Y-030, Y-031 | **Decided (I-20):** wrap the system `ssh` binary with `ControlMaster` multiplexing via `tokio::process`. No SSH library. |
| Y-042 | tmux session primitive (ensure/attach/kill) | ⬜ todo | — | Y-041 | Idempotent by construction. |
| Y-043 | `yantra up` wiring it together | ⬜ todo | — | Y-040..Y-042 | The M1 demo. |
| Y-044 | Session state store (`rusqlite`) | ⬜ todo | — | Y-043 | Only if state genuinely can't be derived from tmux. Prefer deriving. |

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

---

## 5. Decisions

Architecture decisions live in [`docs/adr/`](docs/adr/). Index:

| ADR | Decision | Date | Status |
| --- | --- | --- | --- |
| [0001](docs/adr/0001-record-architecture-decisions.md) | Record architecture decisions | 2026-07-28 | accepted |
| [0002](docs/adr/0002-project-name.md) | Project is named **Yantra (यन्त्र)** | 2026-07-28 | accepted |
| [0003](docs/adr/0003-runtime-and-language.md) | ~~TypeScript on **Bun**; Rust escape hatch with trigger criteria~~ | 2026-07-28 | **superseded by [0004](docs/adr/0004-rust-for-the-daemon.md)** |
| [0004](docs/adr/0004-rust-for-the-daemon.md) | **Rust for the daemon, CLI and agent; TypeScript for the web UI** | 2026-07-28 | accepted |
| 0005 | Execution transport: **system `ssh` + `ControlMaster`** | — | ready to write (R6+R4 agree) |
| 0006 | Workspace schema v1, **with provisioning as an explicit non-goal** | — | ready to write (R4) |
| 0007 | Machine telemetry: **push-heartbeat agent, 10s/30s** | — | ready to write (R1+R5) |
| 0008 | Agent plugin interface | — | blocked on Y-023 (R-1 spike) |

---

## 6. Open questions

| # | Question | Blocks | Owner |
| --- | --- | --- | --- |
| Q1 | Why not just run Coder / DevPod? What is Yantra uniquely responsible for? | Whole project's justification | ~~biswa~~ → **answered by R4, needs sign-off (Y-021)** |
| ↳ | **R4's answer:** Coder models a workspace as a *Terraform build artefact* — `start`/`stop`/`delete` are `terraform apply` transitions. A machine that already exists, is always on, and must **never be destroyed** (my MacBook) is unrepresentable in that model. Its floor is coderd + Postgres 13+ + provisioners, with the smallest validated architecture sized for 1,000 users. Yantra's niche: **pre-existing, personally-owned, heterogeneous machines**. | | |
| Q2 | Which machines actually exist today, with what specs and OS? | M2 | biswa |
| Q3 | Is a per-machine Yantra agent required, or can we get by with SSH polling? | ADR-0007 | ✅ **CLOSED. Push-heartbeat agent, 10s interval, stale at 30s.** R1: Tailscale exposes zero telemetry, so an agent is required. R5 then killed my SSH-poll preference outright — **SSH cannot see a sleeping laptop**, and a scheduler whose main job is "is this machine usable right now" cannot be blind to sleep. node_exporter/Glances also rejected. |
| Q4 | Windows: first-class, or WSL-only for v1? | M2 scope | **R4 recommends: declare Windows = WSL2 for M1–M3, explicitly.** There is no tmux on native Windows, and Windows OpenSSH lacks `ControlMaster`. Leaving this implied guarantees a nasty surprise. Needs biswa's yes/no. |
| Q5 | Secrets: reference-only (1Password/pass/sops) or does Yantra ever hold them? Strong prior: **never hold them**. | M1 workspace schema | biswa |
| Q6 | Is this open-source-for-others or personal-first? Changes how much plugin architecture is justified early. | Effort allocation | biswa |
| Q7 | *(unblocked by Y-023 — transcripts work detached, so TUI-in-tmux is viable)* Is the agent control path **TUI-in-tmux** or **headless**? R3 says every agent is safer driven headless. Proposed answer: tmux is the *human attach view*, headless is what Yantra automates — but that is two paths, not one. | ADR-0006, M3 | biswa (Y-024) |
| Q8 | Do we adopt **server mode** where it exists (OpenCode `serve` HTTP+SSE, Codex `app-server daemon`)? Strictly better than tmux-wrapping, but adds a second transport. | ADR-0006 | biswa |
| Q11 | **Should session-affinity be a score term at all?** R5 raises it against itself: the live-session short-circuit already delivers idempotent `yantra up X`, so a 20-point affinity weight may be re-solving a solved problem. Prior: **drop it**, and let the short-circuit do the work. | M5 scoring weights | biswa |
| Q10 | **Wake-on-LAN**: R1 says Tailscale never exposes MACs and has no `wake` command — WoL needs the Pi 5 as an always-on **L2 relay** plus a hand-maintained MAC table. Accept that manual table, or drop WoL from the scheduler until the appliance exists (M7)? Prior: **drop until M7**; a scheduler that can't wake a machine simply won't place work there. | M5 scope | biswa |
| Q9 | **Ship Aider or drop it?** No session id, no resume, no JSON output, no MCP, ~1 release in 6 months. Supporting it means inventing synthetic sessions via sharded `--chat-history-file`, lossy by construction. Prior: **drop from v1.** | M3 scope | biswa |

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
| R-8 | **`Online: true` means "the control plane sees it", not "you can reach it".** Also `Expired` nodes need surfacing. | Scheduler happily places work on an unreachable machine; `yantra up` hangs instead of failing fast. | 🟡 known, mitigable | Probe with `tailscale ping` before placement; treat `Online` as a hint only |
| ~~R-16~~ | ~~Bun stable frozen mid Rust-rewrite~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| ~~R-18~~ | ~~Bun "closed" issues are not fixed~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| ~~R-17~~ | ~~Bun/Node test suites not portable~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| ~~R-14~~ | ~~`bun:sqlite` blocks the event loop~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| ~~R-15~~ | ~~macOS Bun bundles no SQLite~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| **R-19** | **Cross-compiling Rust to macOS from Linux is genuinely hard** (needs the Apple SDK via osxcross), where `bun build --compile` did it in one command. The per-machine push-agent (R-12) must run on macOS and Windows. | Build tooling friction for the agent, not the daemon. Worst case, the appliance cannot build the Mac agent by itself. | 🟡 **new, from ADR-0004** | Build on native runners in CI rather than cross-compiling. `aarch64-unknown-linux-musl` for the appliance is unaffected and stays trivial. |
| R-20 | **Rust punishes design churn, and M0–M1 is exactly where the design is still unknown.** | Slower first month; a wrong early abstraction is more expensive to unpick than in TS. | 🟡 accepted knowingly | ADR-0004 records this as the consciously-paid cost. Mitigation: walking skeleton first, narrow traits, resist abstraction until the third use. |
| R-12 | **The push-agent has an install-and-update story on every machine.** Q3's answer converts Yantra from "pure orchestrator, zero footprint" into "ships software to five heterogeneous machines" — including macOS launchd, Windows service, and Linux systemd. | Real, permanent scope increase. Also weakens the "we only orchestrate" identity if it grows. | 🟡 accepted, must stay tiny | Keep the agent to heartbeat-only; no logic, no versioned protocol beyond a JSON blob |
| R-13 | **macOS and Windows telemetry commands are doc-sourced only.** R5 verified the Linux commands locally; the other two OSes were not run on real hardware. | The scheduler mis-scores exactly the machines it was built to choose between. | 🟡 unverified | Verify during Y-022, on the real Mac and Windows box |
| ~~R-11~~ | ~~`Bun.Terminal` documented-only~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| ~~R-9~~ | ~~Tailscale LocalAPI from Bun~~ | — | 🟢 **retired by [ADR-0004](docs/adr/0004-rust-for-the-daemon.md)** — the risk left with the runtime | — |
| R-10 | **Hostname collisions are already real** — R1 found HostName colliding **twice in your existing 5-node tailnet**. | Keying anything on hostname corrupts inventory from day one. | 🟢 avoidable by design | Key on `Peer.ID`; treat HostName as a display label only |

---

## 8. Session log

Append-only. Newest last. One line per working session.

- **2026-07-28 (cont. 4)** — **Y-023 run: R-1 refuted.** Interactive `claude` 2.1.220 in a fully detached tmux session writes its transcript JSONL normally (18 KB, 10 entries, within 5 s). `--session-id <uuid>` lets us preset the UUID and therefore predict the transcript path. Three new verified invariants fell out of getting it wrong first: I-21 (`=name` is not a pane target), I-22 (never pipe agent stdout), I-23 (pre-seed the trust dialog). Caveat recorded: `pipe-pane` on a TUI captures the raw redraw stream (ANSI escapes), so it is a liveness/forensics channel, **not** a readable log — the transcript JSONL is the real log source, which is exactly why refuting R-1 matters.
- **2026-07-28 (cont. 3)** — Toolchain installed (rustc 1.97.1, zig, mold, cargo-zigbuild/deny/nextest). **Y-030 + Y-032 done**: cargo workspace with `yantrad`/`yantra`/`yantra-agent` builds clean under `clippy -D warnings`, and `cargo zigbuild` produces **330 KB statically-linked aarch64** binaries from this x86_64 box in 51 s. Guardrail added after biswa challenged the sshd requirement: **localhost is not a special case** (uniform SSH transport, one code path), and the test fixture is a **disposable podman container** rather than host sshd — no port opened, nothing to undo.
- **2026-07-28 (cont. 2)** — **Runtime changed to Rust** ([ADR-0004](docs/adr/0004-rust-for-the-daemon.md), supersedes ADR-0003). Not because the Bun evidence was bad — R6 said GO-WITH-CAVEATS — but because the *decision criteria* changed from "iterate fast" to "ship quality, no time pressure", and because research had already removed the reasons Rust was being deferred (transport is the `ssh` binary; zero native addons; T4/T5 never fired). Retired 8 Bun-specific risks (R-0, R-9, R-11, R-14…R-18) and 3 invariants (I-15…I-17); added R-19 (macOS cross-compile is hard in Rust) and R-20 (Rust punishes design churn). Research notes kept unedited as dated evidence.
- **2026-07-28 (cont.)** — All six research agents returned; R6 spawned three sub-agents of its own (06a/06b/06c), whose relays failed and were recovered by hand. Nine notes, ~2,400 lines. **Bun confirmed GO-WITH-CAVEATS.** Twenty invariants (I-1…I-20) and nineteen risks (R-0…R-18) extracted. ADRs 0004, 0005, 0007, 0008 are ready to write; 0006 is blocked on the R-1 spike. Two of my own priors were overturned by evidence: SSH-polling for telemetry (R5) and "WS2812 needs Rust or a microcontroller" (R6).
- **2026-07-28** — Project kickoff. Named Yantra. Runtime decided (Bun/TS, Rust escape hatch). Brainstorm + vision archived. Tracker created. Six research agents dispatched (R1–R6). Local env probed: Linux, node v24, tailscale 1.98.9, tmux present, claude 2.1.220 present; **bun not installed**, docker not installed, codex/gemini/aider not installed.

---

## 9. Conventions

- **Task IDs** — `Y-NNN`, never reused. 000–039 = M0, 040–079 = M1, then +40 per milestone.
- **ADRs** — `docs/adr/NNNN-kebab-title.md`, Nygard format (Context / Decision / Consequences). Never edit an accepted ADR; supersede it.
- **Research notes** — `docs/research/NN-topic.md`. Must end with Sources + access dates. Research is dated evidence, not eternal truth.
- **Commits** — conventional prefix (`feat:`/`fix:`/`docs:`/`chore:`/`ci:`), imperative mood, and the
  task ID in parentheses when one exists: `feat: add cargo workspace skeleton (Y-030)`. Not every commit
  maps to a tracker task; those just take the prefix.
- **No attribution trailers.** No `Co-Authored-By`, no "Generated with", no AI attribution. Owner's rule.
- **Branches** — `y-030-cargo-skeleton`.
