# M14 — the Rust inventory: what the boards need from the daemon

- **Date:** 2026-09-06
- **Status:** evidence for [m14-the-material-dashboard.md](m14-the-material-dashboard.md)
- **Sources:** `crates/yantrad/src/{main,api,write,terminal,heartbeat,contract}.rs`,
  `crates/yantra-core/src/{doctor,attention,notify,identity,logs,tokens}.rs`,
  `crates/yantra/src/main.rs`, the crate `CLAUDE.md` and `tracker.md` files, R13, ADR-0023.

## 1. Routes today

Composed in `app()` at `crates/yantrad/src/main.rs:132`: `/healthz`, `/api` (reads, writes,
terminal), `/heartbeat` at the root, SPA fallback.

**Reads** (`api.rs:41`, no gate, every one an `Answer<T>` envelope `looked: ok|failed|never`):
`GET /api/machines` → `Vec<Machine>` (embeds `Beat`) · `GET /api/workspaces` → `Vec<Listed>` ·
`GET /api/sessions` → `Vec<MachineSessions>` · `GET /api/workspaces/{name}/status` →
`WorkspaceStatus` (404 `Missing`) · `GET /api/readiness` → `Vec<doctor::Report>` ·
`GET /api/machines/{name}/readiness` · `GET /api/attention` → `Attention{reviews, issues,
notifications: u32}` · `GET /api/readiness/github` → `doctor::Check`.

**Writes** (`write.rs:101`, gate `allowed()` at `write.rs:148`, ADR-0016 on the ADR-0017 caller;
refusals are bare strings, 403 or 503): `POST /api/workspaces` → 201 `Made` · `PATCH
/api/workspaces/{name}` · `DELETE /api/workspaces/{name}?force` → `Removed` · `POST …/up` →
`Opened` · `POST …/down` → `Stopped{ending: Option<String>}` · `POST …/resume` → `Resumed` ·
`POST …/tokens` → `Spend` · `POST …/logs` (`Window{lines, before}`) → `Transcript` · `GET|POST
…/repair` → `Broken` / `Made` · `DELETE /api/machines/{m}/sessions/{s}` → `Ended` · `POST
/api/machines/{m}/probe` → `Found` · `POST /api/machines/{m}/dirs` → `Listing` · `POST
/api/machines/{name}/readiness` · `POST /api/relay` → 204 · `POST /api/viewing` → 204.

**Sockets** (`terminal.rs:78`, `allowed()` by hand before the upgrade): `GET
/api/workspaces/{name}/terminal` and `GET /api/machines/{m}/sessions/{s}/terminal` (ADR-0022).
Binary frames are bytes both ways; the first text frame from the browser is `Size{rows, cols,
term}`; a text frame from the daemon is the reason a terminal could not open.

**The ADR-0021 write path** (`notify.rs:251`, `RELAY_FILE = /etc/yantra/daemon.env`, `0600`,
single-quoted `KEY='value'`, `holdable()` refuses whitespace, quotes, backslash, control)
**truncates the whole file**. Adding `YANTRA_GITHUB_TOKEN` beside the relay means the writer
must compose both, or each write erases the other. This is the sharpest hazard in the build.

**The contract seam**: `contract.rs` drives the real routers into `web/src/contract.gen.ts`
(`just fixtures`). A new DTO lands with its `web/src/api.ts` type in the same commit (Y-322).

## 2. Verdicts

| Need | Verdict | Smallest Rust change |
| --- | --- | --- |
| a. GitHub login, logout, status (ADR-0023) | **MISSING** | `yantra-core/src/github.rs`: `begin()` → `DeviceCode{device_code, user_code, verification_uri, expires_in, interval}`, `poll()` handling `authorization_pending`, `slow_down` (+5 s), `expired_token`, `access_denied`; `login_name()` from `GET /user`; `TOKEN = "YANTRA_GITHUB_TOKEN"`. `notify::write_env` composing both variables. CLI `yantra github login|logout|status` first. Routes on `allowed()`: `POST /api/github/login` → `Device` DTO (no token), `POST /api/github/login/poll`, `DELETE /api/github`. A read `GET /api/github` → `Connection{connected, login, scopes}` as a sibling of `/readiness/github`, because `doctor::Check`'s three fields are a settled contract. The grant is live in memory the moment the flow completes (ADR-0023 §3), so it is new state in `Fleet` beside `Beats`. Binds I-58, I-59, I-60, I-64. |
| b. Repository list and search | **MISSING** | `github::repos(token)` over `GET /user/repos?visibility=all&affiliation=owner,collaborator,organization_member&per_page=100` with `Link` pagination; `Repo{full_name, private, language, pushed_at, clone_url, default_branch}`. CLI `yantra ls repos`. Served as a `refresh.rs` class on its own clock (like `ATTENTION`, 300 s) at `GET /api/repos` → `Answer<Vec<Repo>>`; **the search box filters the swept list in the browser**, because a read handler never awaits the network and a typed box polls. "Already on the machine" is `POST …/dirs` + `Dir.origin`, joined in the browser. |
| c. Work inbox | PARTIAL | Keep `attention::Forge` (the fake seam, `attention.rs:82`); swap `Gh`'s three `gh` spawns for API reads with the grant. `api.rs:1273`'s "nobody logged in is a failed look, never an empty inbox" keeps passing with "no grant". |
| d. Notifications list | **MISSING** | `Attention.notifications` is a count by design; `notify::Watch` pushes and drops. A list needs a ring buffer of the last N events in `Fleet` and `GET /api/notifications`. In-memory only, so a restart empties it (I-59). Needs its own short ADR because it reverses a stated privacy property. Read state is browser-local. |
| e. Ended, Kill, Stop, Delete | **EXISTS** | `AgentState` names all nine verdicts; `finished` carries no exit code and `Stopped.ending` is a `Debug` string. Optional: type `ending`. |
| f. Unclaimed sessions Attach/Kill | **EXISTS** | None. No Adopt verb exists and none should (ADR-0022). |
| g. Doctor nine checks | **EXISTS** | `doctor::of()` order is exactly the boards' nine. `provider-auth` never carries the login name (`doctor.rs:463`); `sshd` never carries a version; `reachable` never carries a latency. **The boards relax.** `github` becomes "is a grant present and accepted". |
| h. Spend and Usage | PARTIAL | Per session exists (`Spend`, `Counts`, `ModelSpend{model, responses, cost}`; unpriced is `null`; `fast` withholds dollars). Aggregates are a browser fan-out of `POST …/tokens` on request, never polled. **Time windows need timestamps in `tokens.rs`** and collide with I-61/I-62: a later row. |
| i. Appearance | **MISSING** | None in Rust: browser-local. The board's "on every device you sign in from" becomes "on this device". |
| j. Settings General, Access, About | PARTIAL | `GET /api/about` → `About{version, target, built, uptime_seconds, listening_on, tailnet}` (no ssh, no network, so on `api::router()`; `Authoriser.bound` already holds the addresses; version from `env!`, target from a three-line `build.rs`). `GET /api/ssh-identity` → `{path, kind, public_key, fingerprint}` from `identity::prepare_in`. General's four values are browser-local preferences. Known hosts count and secret backends: drop from the boards. |
| k. Local directories and cloning | PARTIAL | `dirs` and `probe` exist and match `NewSessionLocal` exactly. Missing: mkdir and clone. A clone must not be awaited in a handler (R13 §4.2): `yantra clone <url> --machine <m> --into <path>` runs `git clone` **inside a tmux session on the machine**; `POST /api/machines/{m}/clone` returns 202 with the session name; progress is that session's terminal socket; completion is `probe`. The token never goes with it (ADR-0023 §4). Binds I-24, I-26, I-35, I-63. |
| l. Chat and transcript | PARTIAL | Read half exists (`Transcript`, `Turn`, `ToolCall`; tool results never cross, I-46). The composer and the trust option rows **write to the terminal socket**, opened invisibly. No `send-keys` route (I-21, I-22). Streaming is ADR-0011-sized and out of scope. `logs` is never polled on a timer (ADR-0019). |
| m. Command palette | **EXISTS** | Client-only. Never runs a verb. |
| n. Setup and relay | PARTIAL | Relay complete (`POST /api/relay` writes and sends a test; 502 does not un-write). `GET /api/ssh-identity` unblocks two steps; `doctor::diagnose()` already separates refused, denied, host-key and no-answer. |

## 3. CLI verbs today, and the rule

Nineteen top-level verbs (`up`, `new`, `edit`, `repair`, `attach`, `resume`, `logs`, `status`,
`tokens`, `down`, `probe`, `kill`, `rm`, `ls`, `notify`, `relay`, `doctor`, `fix-terminfo`,
`ssh-identity`) and five `ls` subcommands (`machines`, `dirs`, `sessions`, `workspaces`,
`attention`) in `crates/yantra/src/main.rs:45`. `crates/yantrad/CLAUDE.md`: **a new verb starts
in the CLI**. Two recorded exceptions: `POST /api/viewing` and `GET …/repair`. So the build owes
`yantra github login|logout|status`, `yantra ls repos`, `yantra clone`, `yantra about`,
`yantra ls notifications`.

## 4. Test conventions

- **yantrad**: in-file `#[cfg(test)] #[allow(clippy::expect_used)] mod tests`. Reads go through
  `tower::ServiceExt::oneshot` against `router().with_state(holding(snapshot))` and **assert on
  the JSON `Value`**. Writes use `inventory::Fake` (`inventory.rs:354`) wrapped by `tailnet()` and
  `direct()`; they assert the refusal and the mapper, since the success path awaits ssh. Sockets
  use a real `TcpListener` (`terminal.rs:355`), never `oneshot`. Container tests in
  `crates/yantrad/tests/` over a systemd podman image.
- **yantra-core**: `tests/common/mod.rs` `SshFixture` (sshd + tmux podman container, per-run
  keypair, teardown in `Drop`); `Ok(None)` skips without podman and `YANTRA_REQUIRE_PODMAN`
  makes the skip a failure in CI. Seams no container holds (Tailscale, GitHub, macOS) are
  `#[ignore = "…"]` tests against the real thing, plus unit tests over captured JSON. The
  device flow copies `attention_gh.rs` and the `Forge` trait pattern.
- **Contract**: add the DTO to `answers()` in `contract.rs` (or `write::answers()`,
  `terminal::answers()`), run `just fixtures`, land `web/src/api.ts` in the same commit.
