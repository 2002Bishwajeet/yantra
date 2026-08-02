# 03 — AI coding agent CLIs: launch, resume, observe, stop

Research date **2026-07-28**. Versions: Claude Code **2.1.220** (executed locally on this machine), Codex **rust-v0.145.0** (2026-07-21), Gemini CLI **v0.52.0** (2026-07-22, source at `main`), Aider **0.86.2** (PyPI 2026-02-12), OpenCode **v1.18.9** (2026-07-28). Only Claude Code was installed here; its flags, paths, JSON shapes and headless resume were run and confirmed. The other four are doc- and source-verified, not executed.

## Summary

- **Resume-by-id headlessly works on four of five.** Claude Code, Codex, Gemini and OpenCode persist sessions and accept `resume <id>` plus a non-interactive prompt. **Aider has no session id at all** — it needs a Yantra-side shim.
- **Three storage models, not one.** JSONL-per-session (Claude Code, Codex, Gemini), **SQLite** (OpenCode), **flat append-only markdown** (Aider). "Tail the transcript" cannot be generic.
- **The tmux TUI path is the hazard, not the headless path.** Gemini exits ~5s after TTY loss; OpenCode's TUI has open tmux 3.7 corruption bugs; Claude Code has an open bug where a *detached* tmux session stops writing the transcript. All five are safer driven headless.
- **Two agents ship a daemon that beats tmux**: OpenCode `serve` (HTTP + SSE + OpenAPI) and Codex `app-server daemon`, the latter explicitly documented for SSH-driven use.
- **Auth is two camps**: forwardable API-key env vars (all five) vs. on-disk OAuth credential files (all but Aider). Provision the credential file once per host; forward the minimal env set.

## Comparison table

| Capability | Claude Code | Codex | Gemini CLI | Aider | OpenCode |
|---|---|---|---|---|---|
| cwd flag | ✗ (`cd` first) | ✓ `-C/--cd` | ✗ | ✗ | ✓ positional / `--dir` |
| Headless entry | `-p/--print` | `codex exec` | `-p/--prompt` | `-m/--message` | `opencode run` |
| Structured JSON | ✓ `json`, `stream-json` | ✓ `--json` (JSONL) | ✓ `json`, `stream-json` | ✗ **none** | ✓ `--format json` |
| Session persisted | ✓ JSONL | ✓ JSONL(+`.zst`)+SQLite | ✓ JSONL | ~ flat markdown | ✓ SQLite |
| Session **id** | ✓ UUID | ✓ thread_id | ✓ UUID | ✗ **none** | ✓ id |
| **Headless resume by id** | ✓ *(executed)* | ✓ `exec resume <id>` | ✓ `-r <id> -p` | ✗ | ✓ `run -s <id>` |
| Preset session id | ✓ `--session-id` | ✗ | ✓ `--session-id` | ✗ | ✗ |
| Fork | ✓ `--fork-session` | ✓ `codex fork` | ✗ | ✗ | ✓ `--fork` |
| List sessions (machine) | ✓ `agents --json` (live) | ~ scan dir | ✓ `--list-sessions` | ✗ | ✓ `session list --format json` |
| Tailable transcript | ✓ JSONL | ✓ JSONL | ✓ JSONL | ~ markdown | ✗ SQLite → use SSE |
| MCP | ✓ | ✓ | ✓ | ✗ **none** | ✓ |
| Server/daemon | ~ `--bg` | ✓ `app-server daemon` | ✗ | ✗ | ✓ `serve` + SSE |
| Alt screen | ✓ | ✓, `--no-alt-screen` opt-out | ✓ | ✗ **none** | ✓ (opentui) |
| Survives TTY loss | ~ transcript bug | unknown | ✗ **exits in ~5s** | ✓ | ~ buggy |
| SIGTERM handled | ✓ exit 143 | unverified | ✓ exit **0** | ~ | ✗ **no handler** |
| Unattended flag | `--permission-mode bypassPermissions` | `--sandbox`/`--yolo` | `--approval-mode yolo` | `--yes-always` | `--auto` |

## Per-agent findings

### Claude Code — `claude` 2.1.220 (verified by execution)

**Install/launch.** `curl -fsSL https://claude.ai/install.sh | bash`; `claude --version` → `2.1.220 (Claude Code)`; `claude doctor` reports install method/path/channel. Launch is `cd <dir> && claude` — no cwd flag, `--add-dir` only widens tool access.

**Headless.** `-p/--print`; `--output-format text|json|stream-json`; `--input-format stream-json`; `--include-partial-messages`; `--json-schema`; `--max-budget-usd`. Observed `stream-json` event types: `system/init`, `assistant`, `rate_limit_event`, `result/success`.

**Sessions.** `~/.claude/projects/<cwd, non-alphanumerics → ->/<uuid>.jsonl` — `/home/<user>/Github/homelab` → `-home-<user>-Github-homelab`. Written **append-per-message**, so a SIGKILL still leaves a resumable session. Retention `cleanupPeriodDays`, default 30. Resume via `-r/--resume <uuid>`, `-c/--continue`, `--session-id <uuid>` to *choose* the id up front, `--fork-session`, `--from-pr`. **Executed and confirmed**: `claude -p --session-id <uuid> …` then `claude -p --resume <uuid> --output-format json` returned the prior turn's content and the same `session_id`. Strongest resume story of the five.

**Live registry — the standout find.** `~/.claude/sessions/<pid>.json` holds `{pid, sessionId, cwd, startedAt, version, kind, name, status, updatedAt}`, and **`claude agents --json`** prints the same as an array with no TTY required. Free process↔session correlation.

**Config/auth.** `~/.claude/settings.json` < `.claude/settings.json` < `.claude/settings.local.json` < managed policy. `~/.claude.json` is auto-managed (project state + user/local MCP); MCP project scope is `.mcp.json` at repo root; `CLAUDE_CONFIG_DIR` relocates `~/.claude`. OAuth → `~/.claude/.credentials.json`; `claude auth status` emits JSON (`loggedIn`, `authMethod`, `subscriptionType`) — ideal healthCheck. `claude setup-token` mints a ~1-year `CLAUDE_CODE_OAUTH_TOKEN` usable remotely. Forward `ANTHROPIC_API_KEY` **or** `CLAUDE_CODE_OAUTH_TOKEN`; optional `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `CLAUDE_CONFIG_DIR`, `DISABLE_AUTOUPDATER=1`.

**tmux/stop.** Binary contains `?1049h` and 10 `SIGWINCH` references — alt screen is used and resize *is* handled; `"tui": "fullscreen"` controls the mode. Docs recommend `set -g allow-passthrough on` and `set -s extended-keys on`. **Open issue #63545: in a detached tmux session the transcript is not written.** #35936: Claude eats `Ctrl+B` before tmux sees it. SIGTERM aborts the turn, kills the Bash process tree, runs `SessionEnd` hooks, exits 143.

### Codex — `codex` rust-v0.145.0

**Install/launch.** `curl -fsSL https://chatgpt.com/codex/install.sh | sh`, `npm i -g @openai/codex`, or `brew install --cask codex` (cask, not formula). `codex --version`; `codex doctor`. Launch `codex -C /path/to/repo ["prompt"]` — a real cwd flag; plus `--add-dir`.

**Headless.** `codex exec "prompt"` (`codex exec -` reads stdin). `--json` (alias `--experimental-json`), `-o/--output-last-message <file>`, `--output-schema`, `--ephemeral`, `--skip-git-repo-check`. JSONL events: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, **`item.updated`**, `item.completed`, `error`. Published docs claim an `item.failed`; **the source has no such event** — do not key on it.

**Sessions.** `$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<thread_id>.jsonl` (default `~/.codex`). **Rollouts older than 7 days are zstd-compressed to `.jsonl.zst`** — readers must handle both. Archived → `$CODEX_HOME/archived_sessions/`. A SQLite state DB now indexes sessions. Resume: `codex resume [--last|<SESSION_ID>|--all]` interactive; **`codex exec resume <SESSION_ID> "next task"`** / `--last` headless; also `codex fork|archive|unarchive|delete`. Capture the id from `thread_id` on `thread.started`. The old `experimental_resume` config key is gone.

**Logs/config.** `$CODEX_HOME/history.jsonl` (global append-only message history, `[history]` config with `max_bytes`). `codex-tui.log` is now **opt-in** — written only when `log_dir` is explicitly set in `config.toml`. `RUST_LOG` works (default `codex_core=info,codex_tui=info,codex_rmcp_client=info`). Config at `$CODEX_HOME/config.toml`; profiles are separate files `$CODEX_HOME/<name>.config.toml` via `-p`; `-c key=value` overrides; `requirements.toml` is the admin layer; `AGENTS.md` per project. MCP via `codex mcp`, stored in `config.toml` (exact key syntax unverified).

**Auth.** `codex login`; **`codex login --device-auth` for headless/SSH**; `printenv OPENAI_API_KEY | codex login --with-api-key`. Creds in `~/.codex/auth.json` or OS keyring. **`codex login --api-key <key>` was removed.** Forward `CODEX_API_KEY` (or `OPENAI_API_KEY`) and `CODEX_HOME`. Set `cli_auth_credentials_store = "file"` on headless hosts — `"keyring"` breaks with no keyring daemon.

**tmux/unattended.** **`codex --no-alt-screen`** ("inline mode, preserving terminal scrollback") is the single most tmux-friendly flag in this survey. Open: #35723 (TUI glitch in minimized tmux pane), #31420 (Device Attributes response parsed as input in split panes), #12862 (no built-in tmux integration). SIGWINCH unverified. Unattended: `codex exec --sandbox workspace-write --skip-git-repo-check --json -C <dir> "…"`. Sandbox: `read-only` (default) / `workspace-write` / `danger-full-access`. Approval: `untrusted` / `on-request` / `never`. **Removed: `--full-auto`, `-a on-failure`.** `--yolo` conflicts with `-a`.

**Bonus.** `codex app-server daemon bootstrap|start|restart|stop` — JSON-RPC over stdio/unix/ws, documented as "durable local app-server management for SSH-driven use". Likely a better Yantra backend than tmux. Signal/exit-code semantics **unresearched**.

### Gemini CLI — `gemini` v0.52.0

**Install/launch.** `npm i -g @google/gemini-cli` / `brew install gemini-cli` / `npx`. `gemini --version`. Launch `cd <dir> && gemini`; no cwd flag; `--include-directories a,b` widens the workspace.

**Headless.** `-p/--prompt`, `-i/--prompt-interactive` (fails if stdin is piped), `-o/--output-format text|json|stream-json`. `json` → `{response, stats, error?}`; `stream-json` → JSONL of `init`, `message`, `tool_use`, `tool_result`, `error`, `result`. Exit codes 0 / 1 / 42 (input) / 53 (turn limit). Headless is **auto-forced** by `CI=true`, `GITHUB_ACTIONS=true`, `-p`, **or stdin/stdout not being a TTY** — redirecting output alone flips the mode.

**Sessions.** Auto-saved, no flag: `~/.gemini/tmp/<project_id>/chats/<sessionId>.jsonl`, siblings `checkpoints/`, `logs/`, `shell_history`, `memory/`. **`<project_id>` is a slug from the registry at `~/.gemini/projects.json`, not a sha256 of the path** — older docs are wrong; there is an auto-migration. Retention default **30 days / 50 sessions**, and deletion also removes plans, trackers and tool outputs. Resume: `--resume/-r [latest|<index>|<uuid>]`, `--list-sessions`, `--delete-session`, `--session-id <uuid>` (new session, chosen id), `--session-file <path>`; the last three are mutually exclusive. **Headless resume by id works** — `gemini -r <id> -p "…" --output-format json`; no validation forbids `--resume` with `--prompt`, and `nonInteractiveCli.ts` calls `geminiClient.resumeChat(...)`. Use `-p`, never a bare positional (a TTY would drop into the TUI). **`--continue`, `--session-summary` and `--checkpointing` do not exist** (the last removed in 0.11.0).

**Config/auth.** `~/.gemini/settings.json` < `.gemini/settings.json` < `/etc/gemini-cli/settings.json`. **`GEMINI_CLI_HOME` relocates the whole root** — the clean isolation lever. `GEMINI.md` context files. MCP under `mcpServers` in `settings.json`; `gemini mcp add|list|remove`. Auth: `GEMINI_API_KEY`; OAuth cached at `~/.gemini/oauth_creds.json`; Vertex via `GOOGLE_GENAI_USE_VERTEXAI=true` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`; ADC via `GOOGLE_APPLICATION_CREDENTIALS`. Also forward `GEMINI_CLI_TRUST_WORKSPACE=true` (or `--skip-trust`) to suppress the folder-trust prompt.

**tmux — the critical hazard.** `setupTtyCheck()` polls **every 5 seconds** and, if neither stdin nor stdout is a TTY, calls `gracefulShutdown('TTY loss')` → `process.exit(0)`. Bypassed only when `SANDBOX` is set. tmux keeps the pty alive across detach so ordinary detach is fine, but `nohup`, `disown`, or a dying ssh session without a multiplexer **kills it silently with exit code 0**. Also #22004 (severe spinner flicker in tmux), #21073 (shell subcommands SIGHUP-killed when `TERM=tmux-256color` and `$TMUX` are both set), #27764/#21924 (resize). Alt buffer via `ui.useAlternateBuffer`.

**Stop.** SIGHUP/SIGTERM/SIGINT all route to `gracefulShutdown()`, cleanup runs once, **exit 0 (not 143)**. Ctrl+C needs two presses. `--approval-mode default|auto_edit|yolo|plan`.

### Aider — `aider` 0.86.2

**Upstream has visibly slowed**: 0.86.1 shipped 2025-08-13, 0.86.2 not until 2026-02-12, and the newest tagged GitHub release is still v0.86.0.

**Install/launch.** `python -m pip install aider-install && aider-install`, or `uv tool install --force --python python3.12 --with pip aider-chat@latest`. `aider --version`. Python >=3.10,<3.13. Launch `cd <repo> && aider [files…]`. Git optional but assumed; outside a repo it *interactively prompts* "No git repo found, create one to track aider's changes (recommended)?" — must be pre-empted (`--no-git` or `--yes-always`) for unattended use.

**Headless.** `-m/--message "…"` or `-f/--message-file`. **No stdin piping. No JSON output of any kind.** Exit code is 0 even when the edit fails — do not trust it.

**Session persistence — blunt answer: there is none.** Zero matches for `session_id`, `resume` or `--continue` across `args.py`, `main.py`, `commands.py`, `base_coder.py`, `io.py`. What exists: `.aider.chat.history.md` and `.aider.input.history` **in the git root**. `--restore-chat-history` (default **False**) reads the *entire* markdown file and rebuilds messages by prefix-scraping (`#### ` user, `> ` tool, else assistant) — and lines starting with `# ` are **skipped**, which is exactly the `# aider chat started at <time>` session delimiter. Every past session in that repo is therefore flattened into one undifferentiated conversation, then lossily LLM-summarized. No file context is restored. **The only way to scope a session is to point `--chat-history-file` at a per-session path yourself.** `/save`, `/load` and `--load <file>` persist **which files are in context**, not the conversation — `/save` literally writes `/drop`, `/add <f>`, `/read-only <f>` lines.

**Logs.** `.aider.chat.history.md` is append-only markdown (tailable, but prefix parsing is ambiguous inside code blocks). `--llm-history-file` is plain text. **`--analytics-log <file>` is genuine JSONL** — `{event, properties, user_id, time}`, emitting `"cli session"` and `"exit"` (with `reason` ∈ `/exit`, `Control-C`, `Completed --message`, …). **That is Yantra's best machine-readable lifecycle signal for Aider**, and it works without enabling telemetry upload.

**Config/auth.** `.aider.conf.yml` from home → git root → cwd, **later wins**; `-c/--config` overrides the search. `.env` uses the same order. Env convention `AIDER_<FLAG_UPPERCASED>`. **MCP: not supported upstream** — zero `mcp` paths in the 780-file tree; issues #2525/#3314/#4506 open since 2024; contrary claims online describe the third-party *AiderDesk* fork. Auth uses unprefixed native keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`. `--api-key provider=key` sets `<PROVIDER>_API_KEY` but exposes it in the remote process list — prefer a `.env` at the git root. OAuth exists **only for OpenRouter** and only fires when no keys are found; always set a key so that prompt can't block.

**tmux — the one bright spot.** prompt_toolkit + rich `Live`, never `Application(full_screen=…)`; zero `alternate_screen` hits. **It does not use the alternate screen buffer**, scrollback is preserved, and `tmux capture-pane -p -S -` sees the whole conversation. No aider-specific tmux issues found. `--no-pretty --no-stream` for dumb terminals; `--no-fancy-input` drops prompt_toolkit.

**Stop.** `/exit`. **Ctrl-C must be pressed twice within 2 seconds** — a single SIGINT only cancels the current reply and injects synthetic "I see that you interrupted my previous reply" turns into context. **Ctrl-D exits immediately** and is the cleaner scripted teardown. No commit on exit; `--auto-commits` (default True) commits per successful edit. `--yes-always` is correct (`--yes` is stale docs).

### OpenCode — `opencode` v1.18.9

**Repo moved: `sst/opencode` 302-redirects to `anomalyco/opencode`** (org renamed SST → Anomaly Co). The unrelated `opencode-ai/opencode` is archived (it became Crush). Cadence is extreme — 11,580 npm versions, multiple builds per hour on `dev`/`beta`. **Yantra must pin a version.**

**Install/launch.** `curl -fsSL https://opencode.ai/install | bash` (`-s -- --version 1.18.9` to pin), `npm i -g opencode-ai`, `brew install anomalyco/tap/opencode` (the tap — the Homebrew-team formula lags). `opencode --version`. Launch `opencode /path/to/project` — the path is a **positional**; `--dir` on `run`/`attach`. **Careful: `-c` is `--continue`, not cwd.**

**Headless.** `opencode run [message..]` with `--format default|json`, `-c/--continue`, `-s/--session <id>`, `--fork`, `--attach <url>`, `--dir`, `-m/--model`, `--agent`, `--auto`, `-f/--file`. Globals `--print-logs`, `--log-level`, `--pure`. **Architecture note that changes Yantra's design**: `opencode run` **always** talks to a server; without `--attach` it spawns its own on a random port. The documented pattern is one long-lived `opencode serve` plus many cheap `opencode run --attach`, explicitly to avoid MCP cold-boot cost.

**Server.** `opencode serve --port 4096 --hostname 127.0.0.1 [--cors <origin>]`; basic auth via `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`; OpenAPI 3.1 at `/doc`. Key endpoints: `GET/POST /session`, `GET|DELETE|PATCH /session/:id`, `POST /session/:id/message`, `POST /session/:id/prompt_async` (→204), **`POST /session/:id/abort`**, `POST /session/:id/fork`, **`GET /event` SSE** (first frame `server.connected`), `GET /global/health` → `{healthy, version}`, `POST /mcp`, `POST /instance/dispose`. SDK `@opencode-ai/sdk`.

**Sessions — SQLite, not files.** `~/.local/share/opencode/opencode.db`. **The filename depends on the install channel**: `latest`/`beta`/`prod` (or `OPENCODE_DISABLE_CHANNEL_DB=1`) → `opencode.db`; otherwise `opencode-<channel>.db`. Mixing channels makes sessions appear to vanish. Resolve with **`opencode db path`**; query with `opencode db "SELECT …" --format json`. Sessions are project-scoped via `session.project_id` → `project.worktree`. The `~/.local/share/opencode/project/<slug>/storage/` JSON layout still in the troubleshooting docs is **stale** — now a one-way migration into SQLite. Resume: `opencode run -s <sessionID> "msg"` (headless, by id), `opencode run -c`, `--fork`, `opencode --session <id>` (TUI), `opencode attach <url> -s <id>`. **`opencode session list --format json`** (singular `session`), `opencode session delete <id>`. TUI picker on `<leader>l`. `opencode export`/`import` for JSON round-trip.

**Logs/config/auth.** `~/.local/share/opencode/log/*.log`; `--print-logs` → **stderr**; `--log-level DEBUG|INFO|WARN|ERROR`. Exact filename pattern unverified (docs say timestamped, source default says `opencode.log`) — glob it, or prefer the deterministic `--print-logs` stderr or the SSE stream. Config `opencode.json`/`.jsonc`, **merged** across: remote `.well-known/opencode` → `~/.config/opencode/` → `OPENCODE_CONFIG` → project file → `.opencode/` → **`OPENCODE_CONFIG_CONTENT` (inline JSON in an env var — very handy for Yantra)** → managed `/etc/opencode/`. Substitutions `{env:VAR}`, `{file:path}`. `AGENTS.md` for instructions. MCP under the `mcp` key (`type: local|remote`, `timeout` default 5000ms); OAuth tokens at `~/.local/share/opencode/mcp-auth.json`. Auth via `opencode auth login`; creds at `~/.local/share/opencode/auth.json`; providers from models.dev. Forward `ANTHROPIC_API_KEY` (grep-confirmed) / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` (convention, not string-confirmed), plus `OPENCODE_SERVER_PASSWORD`, `OPENCODE_CONFIG*`, `OPENCODE_DB`. Shipping `auth.json` is simpler. OpenCode injects `AGENT=1`, `OPENCODE=1`, `OPENCODE_PID=<pid>` into child envs.

**tmux — actively buggy, and the TUI is no longer Go/Bubbletea.** v1.18.9 has zero `.go` files; `packages/tui` is TypeScript on `@opentui/core` + `solid-js`. Open: **#34782** TUI layout corrupted (overlapping text, missing borders) **inside tmux 3.7** — the exact version on this machine; **#19651** `[server exited unexpectedly]` under tmux; **#24475** TUI hangs in tmux after an opentui upgrade; **#37971** `--mini` wipes scrollback and replays the whole session on every resize.

**Stop.** `SIGINT` in `run` clears a live prompt draft first, so the first Ctrl-C may be swallowed. **No `SIGTERM`/`SIGHUP` handler is registered in the CLI** — assume it may orphan child MCP processes; reap the process group yourself. Clean stops: `POST /session/:id/abort`, `POST /instance/dispose`, SDK `server.close()`. `opencode serve` is independent of `run --attach`.

## Proposed plugin interface

```ts
export interface AgentContext {
  host: string;                    // ssh target, or "local"
  cwd: string;                     // absolute path on the remote
  homeDir: string;                 // remote $HOME — needed to expand ~/.claude, ~/.codex, ...
  model?: string;
  env: Record<string, string>;     // resolved from requiredEnv() + host secrets
  unattended: boolean;             // → bypassPermissions / --yolo / --auto / --yes-always
}

/** argv, never a shell string — Yantra quotes for ssh/tmux itself. */
export interface Command { argv: string[]; env?: Record<string, string>; cwd: string; }

export interface SessionRef {
  id: string; cwd: string;
  startedAt?: number; updatedAt?: number; title?: string;
  status?: 'idle' | 'busy' | 'exited' | 'unknown';
  pid?: number;                    // only when exposed (Claude Code)
  native: boolean;                 // false ⇒ Yantra-synthesized id; resume is approximate
}

export type LogSource =
  | { kind: 'file'; path: string; format: 'jsonl' | 'markdown' | 'text' }
  | { kind: 'glob'; pattern: string; format: 'jsonl' | 'text' }
  | { kind: 'sse';  url: string }                // OpenCode
  | { kind: 'capture-pane' };                    // last-resort tmux scrape

export interface AgentPlugin {
  readonly id: 'claude' | 'codex' | 'gemini' | 'aider' | 'opencode';
  readonly binary: string;
  readonly verifiedAgainst: string;              // version pin, for drift warnings

  launchCommand(ctx: AgentContext, prompt?: string): Command;
  execCommand(ctx: AgentContext, prompt: string): Command;
  /** Throws UnsupportedError when the agent has no session ids. */
  resumeCommand(ctx: AgentContext, sessionId: string, prompt?: string): Command;

  detectSessions(ctx: AgentContext): Promise<SessionRef[]>;
  logSource(ctx: AgentContext, sessionId?: string): LogSource;
  parseLogLine?(line: string): AgentEvent | null;

  healthCheck(ctx: AgentContext): Promise<{ ok: boolean; version?: string; detail?: string }>;
  requiredEnv(): { required: string[]; optional: string[] };

  stopStrategy(): Array<
    | { via: 'signal'; signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'; repeat?: number; withinMs?: number }
    | { via: 'keys'; keys: string[] }            // tmux send-keys: ['C-d'] or ['/exit','Enter']
    | { via: 'http'; method: string; path: string }
  >;
}
```

**Who cannot satisfy what:**

| Method | Fails for | Fallback |
|---|---|---|
| `resumeCommand` | **Aider** (no session id) | Yantra mints an id and launches with `--chat-history-file <dir>/<id>.md --load <dir>/<id>.ctx`, resuming via `--restore-chat-history`. Approximate: lossy, LLM-summarized, file context only if `/save` ran. |
| `detectSessions` | **Aider** | List Yantra's own per-session history files; optionally parse `--analytics-log` JSONL for start/exit. |
| `parseLogLine` | **Aider** (markdown), **OpenCode** (SQLite) | Aider: prefix-scrape, accepting code-block ambiguity. OpenCode: consume `GET /event` SSE or poll `opencode db … --format json`. |
| `logSource` file-tail | **OpenCode** | SSE, or `--print-logs` stderr redirected to a Yantra-owned file. |
| `stopStrategy` SIGTERM | **OpenCode** (no handler), **Aider** (SIGINT cancels, not quits) | OpenCode: `POST /session/:id/abort`, then kill the process *group*. Aider: send `C-d`, not `C-c`. |
| MCP config | **Aider** (none upstream) | Feature-flag MCP off for Aider in the UI. |
| `-C/--cd` | Claude Code, Gemini, Aider | Always emit `cd <cwd> && <binary> …`; never rely on the flag. |

## What Yantra reuses

- **Session persistence itself.** Four of five write durable, resumable state. Yantra should be a *pointer store* (session id, cwd, host, tmux window) — never a transcript store.
- **Claude Code's live registry** (`claude agents --json`, `~/.claude/sessions/<pid>.json`) gives pid↔sessionId↔cwd↔status with zero bookkeeping. Model the generic `SessionRef` on it.
- **Structured event streams** for four of five — normalize them, don't screen-scrape.
- **OpenCode `serve` and Codex `app-server daemon`** for real supervision, abort endpoints, health.
- **Native health probes**: `claude auth status` (JSON), `claude doctor`, `codex doctor`, `GET /global/health`.
- **Native unattended modes** — do not reimplement approval bypass.

## What Yantra must build itself

1. **A synthetic session layer for Aider** — per-session `--chat-history-file`, an id registry, and an honest UI label that Aider's resume is lossy.
2. **A per-agent log reader** — four formats (JSONL, compressed JSONL, markdown, SQLite/SSE), one of which changes format on a 7-day timer.
3. **Remote path resolution**, not local guessing: `~/.claude/projects/<mangled-cwd>`, `~/.gemini/projects.json` slug lookup, `opencode db path`, `$CODEX_HOME`.
4. **Process supervision and reaping.** OpenCode registers no SIGTERM handler; Aider needs double-SIGINT or Ctrl-D; Gemini exits 0 on TTY loss. Track the process *group* and distinguish "finished" from "died quietly".
5. **A TTY guard for Gemini** — never launch it where the TTY can vanish, or set `SANDBOX` to disable the 5-second shutdown poll.
6. **Version pinning and drift detection.** OpenCode ships hourly; Codex removed three documented flags; Gemini removed `--checkpointing`. `verifiedAgainst` plus a startup `--version` check.
7. **Per-host credential provisioning** — install the OAuth credential file once instead of forwarding secrets on every invocation.

## Risks & unknowns

- **Claude Code #63545: a *detached* tmux session does not write the transcript.** If it reproduces, the tail-the-JSONL design fails in exactly the scenario Yantra exists for. **Test this first, before writing code.**
- **Gemini's TTY-loss shutdown exits 0**, so a killed agent is indistinguishable from a finished one.
- **OpenCode TUI corruption under tmux 3.7** (#34782) — the tmux version on this machine.
- **Codex signal handling and exit codes are unresearched**; SIGKILL can lose buffered log lines (non-blocking tracing appender flushes on drop).
- **Codex `.jsonl.zst` after 7 days** silently breaks naive readers; **OpenCode's channel-dependent DB filename** silently hides sessions.
- Unverified: Codex MCP `config.toml` syntax and default `log_dir`; OpenCode log filename pattern and whether its SIGTERM orphans MCP children; Aider's exit code on API failure; alt-screen/SIGWINCH internals for Codex and OpenCode.
- **Aider is drifting toward unmaintained** (one release in ~6 months). Weigh before investing.

## Verdict — is "resume exactly where it left off" achievable?

**For four of five, yes, and genuinely so.** Claude Code, Codex, Gemini and OpenCode each persist full conversation state keyed by a stable session id, and each accepts that id in a non-interactive invocation. Claude Code's round-trip was executed here and returned prior-turn content verbatim. For these four, Yantra needs to store only `(host, cwd, agent, sessionId)`.

**For Aider, no — and it is not close.** There is no session id, no session registry, and no resume command. `--restore-chat-history` replays *every* past conversation in the repo as one flattened, boundary-less blob, then summarizes it lossily, and restores no file context. Yantra can fake per-session isolation by sharding `--chat-history-file`, but the result is "re-read an approximate transcript", not "resume". Label it differently in the UI, and do not design Yantra's resume semantics around Aider.

**The bigger caveat applies to all five**: "resume" restores the *conversation*, never the process. No agent restores in-flight tool calls, pending approvals, or a partially applied edit. A stopped agent resumes at a turn boundary, not at the instruction it was executing. Promise turn-boundary resume in the UX, and nothing finer.

## Sources

All accessed **2026-07-28**.

- **Claude Code**: local execution of `claude --help/--version/auth status/doctor/agents --json` and a `-p --session-id` → `-p --resume` round-trip on 2.1.220 · https://code.claude.com/docs/en/headless.md · .../sessions.md · .../settings.md · .../env-vars.md · .../authentication.md · .../terminal-config.md · .../mcp-quickstart.md · https://github.com/anthropics/claude-code/issues/63545, /35936, /49790
- **Codex**: https://github.com/openai/codex (`main`, commit 9ea975a) — `codex-rs/{cli,tui,exec}/src/*.rs`, `codex-rs/rollout/src/{recorder,compression}.rs`, `codex-rs/message-history/src/lib.rs` · https://api.github.com/repos/openai/codex/releases/latest · https://learn.chatgpt.com/docs/non-interactive-mode · .../docs/codex/cli · .../docs/auth · .../docs/config-file/config-reference · issues #35723, #31420, #12862, #34943
- **Gemini CLI**: https://github.com/google-gemini/gemini-cli (`main` @ e07280eb; v0.52.0) — `packages/cli/src/{gemini.tsx,nonInteractiveCli.ts,config/config.ts,utils/cleanup.ts}`, `packages/core/src/config/{storage.ts,projectRegistry.ts}`, `packages/core/src/utils/headless.ts` · docs/cli/{session-management,cli-reference,headless,checkpointing}.md · issues #22004, #21073, #27764, #21924, #25369, #26113, #27373
- **Aider**: https://aider.chat/docs/{config/options,install,scripting,config/aider_conf,usage/commands,git,llms}.html · https://github.com/Aider-AI/aider — `aider/{args,main,io,commands,analytics,onboarding}.py`, `aider/coders/base_coder.py` · https://pypi.org/pypi/aider-chat/json · issues #2525, #3314, #4506
- **OpenCode**: https://opencode.ai/docs/{,cli,config,server,mcp-servers,sdk,troubleshooting} · https://github.com/anomalyco/opencode (formerly sst/opencode), v1.18.9 source tarball — `packages/core/src/{global.ts,database/database.ts,session/sql.ts,observability/logging.ts}`, `packages/opencode/src/{index.ts,cli/cmd/*,auth/index.ts,storage/storage.ts}` · https://registry.npmjs.org/opencode-ai · issues #34782, #19651, #24475, #37971, #37969, #29099
