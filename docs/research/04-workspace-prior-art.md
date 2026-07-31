# R4 — Workspace prior art, and "why not just use Coder?"

- **Date:** 2026-07-28 · **Task:** Y-013 · answers **Q1** · feeds **ADR-0005 (workspace schema v1)**
- **Status:** complete

## Summary

- **Every prior system models workspace *creation*; none models workspace *continuation*.** Coder, DevPod, Codespaces
  and Gitpod all answer "build me a fresh environment from a declarative spec", and treat the tmux session, the dirty
  worktree and the running agent as disposable. Yantra inverts this: the session is the asset, creation is a detail.
- **Coder is excellent and mostly wrong for this problem.** Its workspace is a Terraform build artefact —
  `start`/`stop`/`delete` are `terraform apply` with a transition. A laptop that already exists, stays on, and must
  never be destroyed does not fit. Full verdict below.
- **Steal Coder's sub-models wholesale**: `coder_agent` (os/arch/env/dir), `coder_script`
  (`run_on_start`/`run_on_stop`/`start_blocks_login`/`cron`/`timeout`), and the spec-vs-status split. Equally:
  **delegate environments entirely** — `mise` already does tools + env + dependency-ordered tasks, `devenv`/`devbox`
  already do startup commands and long-running processes. Shell out; never re-implement.
- **Do not adopt `devcontainer.json` as the root schema.** It describes a *container*: no identity, no machine, no
  session, no lifecycle above the container. Note the industry converged here — Gitpod's successor **Ona** pairs
  `devcontainer.json` (environment) with a *separate* `.ona/automations.yaml` (processes). Yantra's spec is the second
  file, not the first.
- **Nothing is AI-agent-aware in the way Yantra needs.** Coder is the only one that tried, and Coder Tasks is being
  deprecated (ESR 2026-06-02, removed in v2.37 on 2026-09-01) for "Coder Agents" — a control-plane agent loop that
  deliberately keeps API keys *out* of the workspace. The opposite of "resume my Claude Code session in my tmux".

## Comparison table

| System | Workspace unit | Where it runs | Transport | Persistence | Plugin model | Multi-OS *host* | AI-agent aware |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Coder** | Terraform build artefact (template version + params) | Infra `coderd` provisions: K8s, VM, Docker | Own tailnet — WireGuard via Tailscale + embedded DERP | Postgres (control plane) + whatever the template mounts | Terraform providers + `registry.coder.com` modules | Agent: linux/darwin/windows × amd64/arm64/armv7 — but *provisioning* assumes cloud | Yes, but **being replaced** |
| **DevPod** | devcontainer + source + provider options | Anywhere a provider reaches | SSH; provider `exec.command` is a stdio pipe it injects through | Local JSON in `~/.devpod`; machine state owned by provider | `provider.yaml` + binaries — **cleanest plugin shape in the field** | Client: mac/win/linux. Target: a Linux container | No |
| **devcontainer.json** | A container definition | A container | n/a (spec only) | Container + named volumes | Features (OCI artefacts) | Needs a container runtime | No |
| **Codespaces** | repo + **branch** (devcontainer path & machine type are settings) | GitHub-hosted Linux VM | HTTPS/WSS; SSH via `gh` | `/workspaces` + `/tmp` survive stop *and* rebuild; 30-day retention | devcontainer Features | **Linux only** | Only via Copilot |
| **Gitpod Classic** *(sunset 2025-10-15)* | repo + `.gitpod.yml` | Gitpod-hosted | HTTPS + SSH | Only `/workspace`; 30-min default timeout, 8–36 h max life | none | **Linux only** | No |
| **Ona** *(successor)* | devcontainer + `.ona/automations.yaml` | Ona-hosted or your infra | HTTPS + SSH | devcontainer-defined | devcontainer Features | **Linux only** | Separate product surface |
| **VS Code Remote-SSH** | *No workspace object* — a folder on a host | The remote host | SSH; server bootstrapped by a script **piped into ssh** | `~/.vscode-server/` keyed by commit hash; server outlives client | VS Code extensions | Remote: **Linux (glibc), macOS, Windows** | Via extensions |
| **JetBrains Gateway** | A project dir on a remote host | The remote host | SSH + **sftp** (backend deployed over SFTP) | Backend + `~/.cache/JetBrains` survive disconnect | JetBrains plugins | Remote: **Linux AMD64 only** | Via plugins |
| **mise** | A directory's tools + env + tasks | Your shell | none | `mise.toml` in-repo | mise backends | Yes | No |
| **direnv** | A directory's exported env vars | Your shell | none | `.envrc` in-repo | direnv stdlib | Yes | No |
| **devenv / nix / devbox** | A reproducible shell closure + processes | Local or any Nix host | none | Nix store | Nix modules | Linux + macOS | No |
| **Yantra (proposed)** | **Continuation context**: repo + branch + machine + tmux session + agent | Machines you already own and never destroy | **SSH over Tailscale** (borrowed, not built) | tmux on the host + `bun:sqlite` on the daemon | copy DevPod's `provider.yaml` shape (ADR-0006) | **Yes — the entire point** | **First-class** |

## Per-system findings

### 1. Coder (`coder/coder`, v2.35.x as of 2026-07)

**Data model — three strict layers.** *Template*: Terraform (HCL) defining the compute, with **template versions** (a workspace pins one) and user-supplied **rich parameters**. *Workspace*: an instance of a template version — `codersdk.Workspace` carries `id`, `owner_id`, `organization_id`, `template_id`, `template_active_version_id`, `latest_build`, `outdated`, `name`, `autostart_schedule`, `ttl_ms`, `last_used_at`, `deleting_at`, `dormant_at`, `health`, `automatic_updates`, `is_prebuild`, `task_id`. *WorkspaceBuild*: **every lifecycle action is a build** with `transition` of `start`|`stop`|`delete` — literally a `terraform apply` run by `provisionerd`. Lifecycle: create → start/stop (autostart cron + `ttl_ms` autostop) → update (rebuild against a newer template version) → dormancy → `deleting_at` → delete.

Two sub-resources matter enormously to Yantra:

- **`coder_agent`** — required `os` (linux/darwin/windows) + `arch` (amd64/arm64/armv7); optional `env`, `dir`, `startup_script`, `startup_script_behavior` (blocking/non-blocking), `shutdown_script`, `connection_timeout` (default 120s), `motd_file`, `metadata`, `display_apps`, `resources_monitoring`.
- **`coder_script`** — the closest existing thing to Yantra's startup commands: `script`, `display_name`, `run_on_start`, `run_on_stop`, `start_blocks_login`, `cron` (6-field), `timeout`, `log_path`. **Steal this field set almost verbatim.**

**Transport:** agents dial *out* into a WireGuard tailnet built on Tailscale — STUN for direct paths, DERP relays embedded in `coderd` as fallback. Serious engineering; Yantra will not beat it. **Operational weight:** `coderd` + **PostgreSQL 13+** + provisioner workers + a reachable URL. The *smallest* published validated architecture targets **up to 1,000 users** (2 vCPU × 8 GB × 512 GB Postgres). There is no n=1 shape.

### 2. DevPod (`loft-sh/devpod`, v0.7.0-alpha.34, 2026-06-23)

Client-only — no server, no database; state is JSON under `~/.devpod`. Its `provider.Workspace` struct is usefully **decomposed into sub-objects**: `Provider`, `Machine`, `IDE`, `Source`, plus `DevContainer{Image,Path,Config}`, timestamps, `Context`, `SSHConfigPath`; `WorkspaceSource` = `{GitRepository, GitBranch, GitCommit, GitPRReference, GitSubPath, LocalFolder, Image, Container}`.

**A "provider"** is a `provider.yaml` declaring `name`, `version`, `options` (surfaced as env vars), `binaries`, `agent` (`path`, `driver`, `inactivityTimeout`, `injectGitCredentials`, `exec.shutdown`) and `exec`. The `exec` block is the entire contract: **`command`** is the *only* required verb — "run this command in the environment" — and DevPod injects its own agent binary through that pipe, routing everything over its stdio. Optional `init`, plus `create`/`delete`/`start`/`stop`/`status` for **machine providers** (status returns Running|Busy|Stopped|NotFound). Providers with only `command` are **non-machine providers** that attach to something that already exists.

**Can Yantra copy this? Yes.** The `command`-only non-machine provider *is* Yantra's situation: the machines exist and must never be created or destroyed. The lesson to steal is the **capability split** — a provider declares which verbs it supports and the core degrades gracefully. v1 needs exactly one provider (`ssh`), so define the interface now and write the second implementation later. Caveat: DevPod has sat in `v0.x-alpha` for three years — design reference, not dependency.

### 3. devcontainer.json (containers.dev)

Fields worth knowing: `image`/`build`/`dockerComposeFile`, `features`, `customizations`, `containerEnv` (baked in) vs `remoteEnv` (per-process), `forwardPorts`, `mounts`, `workspaceFolder`, `remoteUser`, `hostRequirements` (cpus/memory/storage/gpu). Lifecycle hooks, in order: `initializeCommand` (on the **host**, before the container exists) → `onCreateCommand` (once) → `updateContentCommand` (once; the prebuild boundary) → `postCreateCommand` (once) → `postStartCommand` (**every** start) → `postAttachCommand` (**every** attach), with `waitFor` selecting the blocking hook.

**Should Yantra adopt it? No — not as the root schema.** Three fatal gaps: no *identity* (it is a file in a repo, not an addressable object, so it cannot express "my yantra workspace on the Mac"); no *machine* concept beyond `hostRequirements`; and its lifecycle bottoms out at the container, whereas Yantra's unit is a **session on a host** that may involve no container at all. **Steal two things**: the once-vs-every-start distinction, and a reserved `devcontainer` field so a workspace can delegate later without a schema break.

### 4. GitHub Codespaces

**Identity:** repo + **a specific branch**; devcontainer path and machine type are creation-time *settings*, not identity, and multiple codespaces per branch are explicitly allowed. **Lifecycle:** create → start/stop → rebuild → delete. The distinction worth copying is **restart vs rebuild** — restart resumes the same container and disk (needed for a machine-type change or newly-added secrets); rebuild re-runs the container build and is only for config changes, with `--full` also purging cached images and volumes.

**Timeouts:** idle default **30 min** (configurable 5–240); stopped-codespace retention default **30 days** (settable 0–30); org policy overrides a more generous personal setting. `/workspaces` and `/tmp` persist across stop/start and rebuild — **everything outside `/workspaces`, including `$HOME`, is lost on a full rebuild**. **Prebuilds** are keyed on (repo, branch, devcontainer.json, region), triggered on push/config-change/schedule, and bake `onCreateCommand` + `updateContentCommand` but deliberately *not* `postCreateCommand`. **Secrets:** account-level, granted per-repo, max 100 × 48 KB, injected as **env vars into the terminal session** — not available at build time, requiring stop+restart to appear; plus a dotfiles repo cloned at creation.

**Lesson:** the secrets model is the right one — reference-only, injected at session start, never at build. And "restart ≠ rebuild" is a distinction Yantra needs on day one.

### 5. Gitpod → Ona (⚠ the format R4 was asked to study is dead)

**Status first. Gitpod Classic is sunset** — PAYG users lost the ability to start environments after **2025-10-15**; `gitpod.io` now 308-redirects to `ona.com`; Classic docs are archived under `ona.com/docs/classic/`. **`.gitpod.yml` is deprecated**, replaced by `.devcontainer/devcontainer.json` (environment) + `.ona/automations.yaml` (tasks) — strong external validation of Yantra's split.

**The Classic tasks model** is still the clearest articulation of once-vs-always anywhere. Each task entry gets its own terminal and entries run in parallel; within an entry the order is always `before` → `init` → `command`. A prebuild runs `before`+`init`; a first start with no prebuild runs all three; a first start from an exact-commit prebuild runs `before`+`command`; a first start from an older/incremental prebuild re-runs `init`; a restart runs `before`+`command`. **Invariant: `before` and `command` run on every start; `init` runs only when the persistent filesystem has not already been initialised.** **Ona's successor model** replaces the linear triple with **tasks** (run to completion) vs **services** (`start` must block and stay running), each with an explicit `triggeredBy`: `manual`, `postDevcontainerStart`, `postEnvironmentStart`, `prebuild`, `beforeSnapshot`.

**Lessons:** (a) Gitpod's three named phases were ambiguous enough that its successor replaced them with **explicit triggers** — Yantra should go straight to a `when:` trigger rather than invent phase names. (b) The **task vs service** distinction is real: `npm install` terminates, `npm run dev` must not, and conflating them makes "is the workspace ready?" unanswerable. A v1.1 addition, not v1.

### 6. VS Code Remote-SSH & JetBrains Gateway — bootstrapping a remote machine

The most immediately reusable engineering here, since Yantra's transport is already SSH.

**VS Code Remote-SSH.** Install root `~/.vscode-server/`, everything **pinned to the client's commit hash** (`bin/<commit>/`, or current `cli/servers/Stable-<commit>/server/`) with sibling `extensions/`, `data/`, and a lockfile. Sequence: (1) resolve the host with the **user's real `ssh` binary and `~/.ssh/config`**, so ProxyJump/ProxyCommand work for free, probing remote OS/arch over SSH; (2) **pipe a bootstrap shell script into `ssh`** which takes a lock, checks whether `<commit>` exists, else `curl`s the tarball **from the remote host directly**, untars it, starts the server and echoes back a port + connection token; (3) remote-download-first with **client-upload as fallback** — there is no supported air-gapped path; (4) the server listens on `127.0.0.1:<random>` behind `--connection-token`, and the client multiplexes **one ssh process per host** across all windows, with port-forwarding riding the same channel; (5) **reconnect is re-attach, not restart** — the script is idempotent, finds the live pid, reads back the still-valid port and token, and terminal buffers survive a dropped link. Requires kernel ≥ 4.18, **glibc ≥ 2.28** (musl/Alpine unsupported over SSH), `bash`, `tar`, `curl`-or-`wget`. **Linux, macOS 10.14+, and Windows 10/Server 2016+ (OpenSSH Server) are all supported remotes.** Old commit dirs are never garbage-collected.

**JetBrains Gateway.** A full headless **IDE backend** runs remotely in `~/.cache/JetBrains/RemoteDev/dist` with a version-pinned thin client locally; the backend is deployed over the **sftp subsystem** (not a piped script) and **survives disconnect** with its indexes. But the remote **must be Linux AMD64** — macOS and Windows unsupported, single-board computers explicitly excluded. That rules it out as a model.

**Four concrete lessons:** (a) **use the system `ssh` binary and the user's `~/.ssh/config`, not a library** — both tools do, and it buys ProxyJump, agent forwarding, and keys the user already trusts (feeds ADR-0004 and R6's `ssh2` question); (b) **multiplex one connection per host** (`ControlMaster`) — this is why reconnect feels instant; (c) **make bootstrap idempotent and version-pinned** — "check if it exists, else install, then read back the live endpoint" is the whole pattern, and Yantra's equivalent is `tmux has-session || tmux new-session`, precisely M1's idempotency requirement; (d) **the `.bashrc` hazard will bite** — stray stdout from a login shell (banners, MOTD, prompts) corrupts a piped-script handshake and is VS Code's single most common bootstrap failure, so Yantra must never parse a plain interactive shell.

### 7. mise / direnv / devenv / nix — should Yantra own env at all?

**`mise`** (`mise.toml`) is already the union of what Yantra was going to build: `[tools]` (version pinning, asdf-compatible), `[env]` (vars, `_.file`/`_.path`), and **`[tasks.*]` with `run` and `depends`** — a real dependency-ordered task runner. **`direnv`** (`.envrc`, explicit `direnv allow`) captures only **exported env vars** — no shell functions, no persistent processes, no tool versions; it covers env, not startup commands. **`devenv` / nix flakes / `devbox`** add hermetic reproducibility and already cover both halves: `enterShell`/`shellHook`/`init_hook` for startup, `env` for variables, `processes` + `devenv up` for anything long-running.

**Verdict: delegate all of it, explicitly, in the ADR.** This is §B2 "orchestrate, don't reinvent". Yantra's `env` stays a small escape hatch; `startup` should be free to be one line — `mise run dev`, `devenv up`, `direnv exec . ./start.sh`. The moment Yantra grows tool-version resolution or task graphs it is rebuilding mise badly. The one thing none of them do is choose *which machine* and keep the session alive afterwards — which is the whole of Yantra's job.

## Why not just use Coder?

**The honest case for Coder.** AGPL, self-hostable, mature, and it has already solved what Yantra has not started:
NAT-traversing agent networking, a per-machine agent that genuinely builds for macOS/Windows/Linux on amd64/arm64,
template versioning, parameters, prebuilds, dormancy, autostop, IDE integrations for both VS Code and Gateway, and a
web UI. `coder_script` and `coder_agent.env` already express "startup commands + env vars". Yantra will not
out-engineer any of it. **If the goal were "cloud dev environments on infrastructure I provision", the correct answer
is: use Coder and stop writing Yantra.** That is a real possible outcome and should be stated plainly.

**Where it genuinely does not fit.** The mismatch is ontological, not cosmetic:

1. **Coder's workspace is compute the control plane owns, creates and destroys.** Yantra's is a *context* over
   machines that already exist, are not owned by the control plane, and must survive it. `stop` in Coder is `terraform
   apply` with `transition = stop`; on a MacBook that is already on and staying on, `stop` is either meaningless or
   actively destructive.
2. **The Terraform tax is absurd at n=1.** Every create/start/stop/delete is a provisioner job running `terraform
   apply`. Writing HCL and cutting a template version to say "run these three commands in tmux on my Linux box" is
   preposterous machinery for the payload.
3. **It inverts the client/host relationship.** Coder assumes the workspace is server-side and your laptop is a thin
   client. Yantra's premise is that **the laptop is a peer host** — one candidate among several alongside the homelab
   box. Coder cannot express "this workspace is on my Mac; move it to the Linux box", because a workspace *is* its
   provisioned resource.
4. **Session continuity is not a Coder concept.** It gives you SSH and a web terminal. tmux, the dirty worktree, the
   running dev server and the agent conversation are your problem — which is exactly Yantra's entire problem
   statement.
5. **Its AI story is a moving, enterprise-shaped target.** Coder Tasks (GA in v2.29, Dec 2025) enters Extended Support
   on 2026-06-02 and is removed at v2.37 (2026-09-01). The successor, Coder Agents, runs the agent loop *in the
   control plane* with "no API keys in workspaces" and centralised audit. Correct for a regulated enterprise; wrong
   for one person who wants their own `claude` process in their own tmux.
6. **The operational floor is wrong.** Postgres + `coderd` + provisioners, always-on and reachable, with the smallest
   validated architecture sized for 1,000 users. And if `coderd` is down, `coder ssh` is down — whereas plain `ssh` to
   a tailnet machine keeps working.

**Verdict.** Coder is the right answer to a question Yantra is not asking. Yantra is only justified if its centre of
gravity stays on **continuation across pre-existing heterogeneous machines** and it refuses to grow a provisioning
layer. The moment Yantra starts creating VMs it becomes a worse Coder and should be deleted. Write that into ADR-0005
as an explicit non-goal.

## Proposed Yantra workspace schema (v1)

Two borrowed rules: **spec is separate from status** (Coder/Kubernetes), and **v1 is exactly what M1 needs** — read a
file, open tmux, `cd`, run a startup command, print an attach hint.

```ts
/** The user-authored spec. Hand-editable YAML. Nothing here is mutable state. */
export interface WorkspaceSpec {
  // ─── v1 ──────────────────────────────────────────────────────────────────
  name: string;               // Stable identity: CLI handle, tmux session name, file name. Immutable.
  machine: string;            // Tailscale hostname of the target. v1 pins ONE machine — no placement (R5).
  path: string;               // Absolute dir on that machine to cd into. v1 assumes the repo is ALREADY cloned.
  repo?: string;              // Git remote URL. v1 = identity/documentation only; nothing clones it yet.
  startup?: StartupCommand[]; // Commands run in the session after cd. The payload of the whole system.
  env?: Record<string,string>;// Literal, NON-SECRET vars. Deliberately a small escape hatch — real env
                              // belongs to mise/direnv/devenv, invoked via `startup`.

  // ─── v1.1 (M2–M3) ────────────────────────────────────────────────────────
  branch?: string;            // Branch/worktree to ensure checked out. Needs clone logic — deferred.
  agent?: AgentSpec;          // Which AI CLI to launch/resume. Blocked on R3's "can it resume?" verdict.
  envFrom?: string[];         // Secret REFERENCES ("op://vault/item", "sops:f.yaml#key"), resolved ON THE
                              // TARGET at launch. Yantra never stores or relays the value (Q5).

  // ─── Later (explicitly out of scope for M1–M3) ───────────────────────────
  candidates?: string[];      // Ranked machines for the scheduler to choose from. Deferred to R5.
  ports?: number[];           // Ports to advertise/forward. Tailscale may make this a no-op.
  devcontainer?: string;      // Delegate the environment to a devcontainer.json. Reserved field.
  idleTimeout?: string;       // Needs a defensible meaning for a machine Yantra does not own.
}

export interface StartupCommand {
  run: string;                // The shell command.
  when?: 'once' | 'always';   // 'once' = first create only (npm install); 'always' = every start (dev server).
                              // devcontainer's onCreate-vs-postStart and Gitpod's init-vs-command in one field.
                              // An explicit trigger, not a named phase — Ona replaced named phases for a reason.
  name?: string;              // Display name for logs/UI (coder_script.display_name).
  blocking?: boolean;         // Must finish before the session is "ready" (coder_script.start_blocks_login).
  // v1.1: kind?: 'task' | 'service' — does it terminate, or must it keep running? (Ona's distinction.)
  //       Without it, "is the workspace ready?" is unanswerable for `npm run dev`.
}

export interface AgentSpec {
  kind: 'claude' | 'codex' | 'gemini' | 'aider'; // Closed union until R3 defines the plugin interface.
  resume?: boolean;           // Attempt to resume the prior conversation rather than start fresh.
}

/** Daemon-owned, observed state. NEVER written back to the YAML. */
export interface WorkspaceStatus {
  name: string;               // FK to the spec.
  phase: 'unknown' | 'stopped' | 'starting' | 'ready' | 'failed'; // Observed, not declared.
  machine?: string;           // Where it ACTUALLY is (may differ from spec once placement exists).
  tmuxSession?: string;       // The live session name, if any.
  lastSeenAt?: string;        // ISO timestamp — drives "is this still alive?".
  lastError?: string;         // Last failure, for the CLI to surface.
}
```

**Serialisation and storage.**

- **Spec: YAML, one file per workspace**, at `~/.config/yantra/workspaces/<name>.yaml` (XDG). A directory of small
  files is hand-editable, greppable, diffable, committable to a dotfiles repo, and trivially reloadable. YAML over
  JSON because a human authors it and comments matter.
- **Not in the project repo.** Machine preference is a personal fact, not a property of the code. A repo-level
  `.yantra/workspace.yaml` overlay can be merged later; it is not v1.
- **Status never goes in YAML.** It lives in `bun:sqlite` at `~/.local/state/yantra/yantra.db` alongside machine
  inventory and session history. Writing observed state into a user's config file makes it un-diffable and races with
  their editor.
- Validate on load against a schema derived from the TS types; fail loudly with file path and line, and **warn on
  unknown keys** rather than ignoring them, so typos surface.

## What Yantra is uniquely responsible for

Every system surveyed here owns the *creation* of a development environment from a declarative spec, and treats what
happens next — the tmux session, the dirty worktree, the half-finished agent conversation, the dev server on port 3000
— as ephemeral exhaust to be rebuilt from scratch. Yantra owns the opposite half: the **continuity of an in-progress
development context as a first-class, addressable, movable object across heterogeneous machines the user already owns
and that Yantra must never create or destroy.** Nothing else answers "where was I, and put me back there": Coder can
rebuild your environment but not your session; Codespaces and Gitpod can only continue on infrastructure they own, on
Linux only; Remote-SSH and Gateway preserve a *server process* but have no concept of a workspace, a machine choice,
or an agent; devcontainer.json has no identity at all. Yantra's uniqueness is not provisioning, not networking, not
containers — it is being the only thing that treats a *session in progress, including a running AI agent*, as the
durable unit, and a machine as a replaceable place to put it.

## Risks & unknowns

- **The "worse Coder" failure mode is the main project risk.** Every feature request will pull toward provisioning.
  ADR-0005 should name non-provisioning as an explicit non-goal.
- **`when: 'once'` needs somewhere to record that it ran** — a status write per workspace per machine. Confirm it
  belongs in SQLite, and decide what happens when the machine is reimaged.
- **Agent resume may simply not exist** for some CLIs. `AgentSpec.resume` assumes R3 says yes; if it says no, the
  field degrades to "launch fresh" and the vision weakens materially.
- **Secret references imply a resolver on the target machine**, not the daemon — otherwise the secret crosses the
  wire. Not yet designed; Q5's "never hold them" forces target-side resolution.
- **One machine per workspace in v1 means migration is unimplemented**, and migration is arguably the most compelling
  demo. Accepted for M1; revisit after R5.
- **Windows as a target host is unvalidated** — tmux does not exist there. Coder solved this by not using tmux;
  Gateway solved it by refusing non-Linux remotes. Yantra should probably declare Windows = WSL2 for M1–M3 and say so,
  rather than leave it implied.
- **Shell rc noise will corrupt anything Yantra parses over SSH** (VS Code's most common failure mode).
  Non-interactive invocation plus a delimited envelope is cheap now, painful to retrofit.
- **Stale-server garbage is a real cost** — VS Code never GCs old commit dirs. If Yantra ever installs anything on a
  target machine it owns removal from day one, or "machines we don't own" dies by accretion.

## Sources

All accessed **2026-07-28**. Versions noted inline where the docs stated them.

- **Coder docs** — [workspace management](https://coder.com/docs/user-guides/workspace-management), [templates](https://coder.com/docs/admin/templates), [networking](https://coder.com/docs/admin/networking), [architecture](https://coder.com/docs/admin/infrastructure/architecture), [validated architectures](https://coder.com/docs/admin/infrastructure/validated-architectures), [Tasks + deprecation notice](https://coder.com/docs/ai-coder/tasks), [Agents](https://coder.com/docs/ai-coder/agents), [repo](https://github.com/coder/coder)
- **Coder source** — [`codersdk/workspaces.go`](https://github.com/coder/coder/blob/main/codersdk/workspaces.go), [`provider/agent.go`](https://github.com/coder/terraform-provider-coder/blob/main/provider/agent.go), [`provider/script.go`](https://github.com/coder/terraform-provider-coder/blob/main/provider/script.go)
- **DevPod** — [`pkg/provider/workspace.go`](https://github.com/loft-sh/devpod/blob/main/pkg/provider/workspace.go), [provider quickstart](https://devpod.sh/docs/developing-providers/quickstart), [provider agent](https://devpod.sh/docs/developing-providers/agent), [deploying workspaces](https://devpod.sh/docs/how-it-works/deploying-workspaces), [releases](https://github.com/loft-sh/devpod/releases)
- **devcontainer.json** — [JSON reference](https://containers.dev/implementors/json_reference/)
- **Codespaces** — [lifecycle](https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle), [timeout](https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces), [rebuild](https://docs.github.com/en/codespaces/developing-in-a-codespace/rebuilding-the-container-in-a-codespace), [prebuilds](https://docs.github.com/en/codespaces/prebuilding-your-codespaces/about-github-codespaces-prebuilds), [secrets](https://docs.github.com/en/codespaces/managing-your-codespaces/managing-your-account-specific-secrets-for-github-codespaces), [dotfiles](https://docs.github.com/en/codespaces/setting-your-user-preferences/personalizing-github-codespaces-for-your-account)
- **Gitpod / Ona** — [`.gitpod.yml` reference](https://ona.com/docs/classic/user/references/gitpod-yml), [tasks & prebuild ordering](https://ona.com/docs/configure/workspaces/tasks), [Classic lifecycle](https://ona.com/docs/classic/user/configure/workspaces/workspace-lifecycle), [Classic PAYG sunset](https://ona.com/stories/gitpod-classic-payg-sunset), [Ona automations](https://ona.com/docs/ona/configuration/automations), [migrate from Classic](https://ona.com/docs/ona/configuration/migrate-from-classic)
- **Remote bootstrap** — [VS Code Remote-SSH](https://code.visualstudio.com/docs/remote/ssh), [remote Linux requirements](https://code.visualstudio.com/docs/remote/linux), [Remote FAQ](https://code.visualstudio.com/docs/remote/faq), [Remote-SSH troubleshooting wiki](https://github.com/microsoft/vscode-remote-release/wiki/Remote-SSH-troubleshooting), [JetBrains remote dev](https://www.jetbrains.com/help/idea/remote-development-overview.html), [JetBrains prerequisites](https://www.jetbrains.com/help/idea/prerequisites.html)
- **Env tools** — [mise configuration](https://mise.jdx.dev/configuration.html), [direnv](https://direnv.net/), [devenv](https://devenv.sh/), [Nix flakes](https://wiki.nixos.org/wiki/Flakes)

**Source-quality caveat.** The `~/.vscode-server` layout and the piped-bootstrap / port-token handshake are **not** documented by Microsoft — reconstructed from the troubleshooting wiki, `nixos-vscode-server`, and `vscode-remote-oss`; treat as observed behaviour, not contract. Coder's Tasks deprecation dates carry real weight in the AI-agent argument above and should be re-verified before ADR-0005 lands.
