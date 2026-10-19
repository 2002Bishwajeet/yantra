# R22. claude-mem as a shared memory across machines

- **Date:** 2026-10-19
- **Question:** Can claude-mem run once on the appliance and serve a Linux laptop and a MacBook? Can it produce and serve the short handoff summaries that the owner now wants?
- **Reads against:** [ADR-0032](../adr/0032-the-appliance-keeps-the-conversation-history-encrypted.md), [R18](18-one-conversation-history.md), Y-426 to Y-432, Y-518.
- **Owner update, 2026-10-19:** At-rest encryption (ADR-0032 decision 4, Y-429) is dropped. Redaction stays. The memory layer now serves handoffs. A session that continues on another machine starts fresh with a short summary, not the full transcript. This note does not weigh encryption.
- **How I checked:** I read the plugin installed on the owner's machine (`~/.claude/plugins/cache/thedotmack/claude-mem/13.39.0`) and its live data under `~/.claude-mem`, read-only. I read the upstream docs and GitHub. I did not run a worker on a second host, so every claim about a remote worker is from code and docs, and I label it.

## 1. Answer first

1. **claude-mem cannot be self-hosted as one shared worker today.** Its worker is built to run on the same machine as the hooks. Its settings validator accepts only a loopback address or a bind-all address for the worker host. The one upstream design for sharing is a hosted server (Postgres, Redis, a queue worker) that is beta. Its install flow needed a cmem.ai login in the one report I found. The documented sync is a paid cloud service.
2. **For handoffs, claude-mem makes the right object.** It writes a structured summary of each session: request, investigated, learned, completed, next steps. `ctx` writes no summaries. It searches raw text and calls no model.
3. **Sharing claude-mem's summaries between machines is the part that does not exist for a self-hoster.**
4. My judgement is in section 7.

## 2. Architecture (installed version 13.39.0)

| Item | Finding | Source |
|---|---|---|
| Version | Installed 13.39.0. Upstream is 14.0.1 (2026-10-17). | `installed_plugins.json`, GitHub releases |
| Process | A Bun worker with an HTTP API. It is the only writer to the DB. | worker-service.cjs, `~/.claude-mem/supervisor.json` |
| Port | `37700 + (uid % 100)`, so 37700 here. `CLAUDE_MEM_WORKER_PORT` overrides it. The old default 37777 is gone. | `ss -ltn` showed `127.0.0.1:37700`; docs |
| Bind | `CLAUDE_MEM_WORKER_HOST`, default `127.0.0.1`. | settings defaults in the bundle |
| SQLite | `~/.claude-mem/claude-mem.db`, WAL mode, FTS5. Here: 188 MB, 11,905 observations, 1,287 session summaries. | `sqlite3` on the live file |
| Vector DB | Chroma, started as a child process (`chroma-mcp`) from the worker. Data in `~/.claude-mem/chroma`, 462 MB here. | `supervisor.json`, `du` |
| Data dir | `CLAUDE_MEM_DATA_DIR` moves the whole folder. | bundle |
| Hooks | `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`. Each runs the `claude-mem` launcher. `SessionStart` starts the worker if `CLAUDE_MEM_WORKER_AUTOSTART` is `true`. | `hooks/hooks.json`, `cloud-sync/SKILL.md` |
| MCP | An MCP search server in the plugin. Tools include `search`, `timeline`, `get_observations`, `session_start_context`, `work_state_read`, `work_state_write`. | tool list in this session |

**What it stores.** It stores compressed observations (one per tool use, written by a model), session summaries, and the user's prompts. It also keeps a `tool_uses` table with a retention setting (`CLAUDE_MEM_TOOL_USES_RETENTION_DAYS`, default 0). It does not keep the Claude Code transcript file. The summary table has these columns: `request`, `investigated`, `learned`, `completed`, `next_steps`, `files_read`, `files_edited`, `notes` (read from the live schema).

**It already carries sync columns.** The tables hold `origin_device_id`, `origin_local_id`, `sync_rev`, `sync_outbox` and `sync_entity_heads`. The local DB is built to feed a hub, not to be shared as a file.

## 3. Remote and multi-host

**Finding 1: no documented remote worker.** The worker docs describe localhost only and mention no auth. The cloud-sync page and the hosted-server page do not describe a self-hosted worker for several machines.

**Finding 2 (code, not tested): the host setting rejects a Tailscale address.** The validator error reads: "CLAUDE_MEM_WORKER_HOST must be a loopback address ... or a bind-all address (0.0.0.0, ::) for Observation TV / Docker". So a laptop cannot point its hook at `100.x.y.z` through this key. I did not run it to confirm.

**Finding 3: binding the worker to the network is unsafe.** The worker logs this warning when bound off loopback without `CLAUDE_MEM_TV_TOKEN`: "the full worker API, including provider API keys via GET /api/settings, is reachable from the network". A tailnet bind would expose the provider keys to every device on the tailnet.

**Finding 4: a local worker still starts.** `SessionStart` runs `claude-mem start`, and `CLAUDE_MEM_WORKER_AUTOSTART=true` is the default. I did not test whether turning it off lets hooks use a remote worker.

**Finding 5: the only shared-worker recipe is a hack.** A Japanese write-up shares one host worker with devcontainers through a `socat` relay on 37777 plus a bind mount of `~/.claude-mem`. It works on one host. The hooks write SQLite through the mount. That setup cannot work across a network, because SQLite WAL needs shared memory on one host. I did not test concurrent writers from two hosts and do not recommend it.

**Finding 6: copying the DB is a known dead end.** Issue #233 (multi-device sync) was closed on 2026-12-13 (as the page states) after the maintainer said export/import would be a "pro" feature. Discussion #488 says the export/import scripts fail with foreign-key errors and are "outdated". The maintainer said the project "moves faster than the utility scripts".

**Finding 7: the supported multi-machine paths are all cmem.ai products.**
- **Cloud Sync (cmem.ai Pro)** replicates observations, session summaries and prompts through `https://sync.cmem.ai` (setting `CLAUDE_MEM_CLOUD_SYNC_HUB_URL`). The docs warn that it uploads "your observation narratives and your full prompt text" and say not to enable it if that content must stay on your machine. Raw transcripts are not mentioned as syncing. The repo has `services/sync-api/`, which suggests a self-host is possible, but no guide exists. I did not read that code.
- **TeamBrain** is cloud-only and shares tasks and next steps between people.
- **Hosted server runtime** (`CLAUDE_MEM_RUNTIME=server`, `CLAUDE_MEM_SERVER_URL`, `CLAUDE_MEM_SERVER_API_KEY`, `CLAUDE_MEM_AUTH_MODE=api-key`) is Postgres plus Redis plus a BullMQ worker. The docs call it beta and say nothing about self-hosting. Issue #4131 reports that `install --runtime server` printed a `docker compose up` line with no compose file on disk and required browser login to cmem.ai. Upstream's fix on 2026-10-12 changed the help text (PR #4567), not the flow. This is the one real route to a central server. **I would not call it self-hostable yet.**

## 4. Privacy

- **It sends session content to a model.** The observer reads tool inputs and outputs and writes the observations. The default provider is `claude`, default model `claude-haiku-4-5-20251001`, and the default auth method is `subscription` (`CLAUDE_MEM_CLAUDE_AUTH_METHOD`: `subscription`, `api-key`, `gateway`, `cli`). So by default it uses the user's Claude login, through the Claude Code CLI.
- **Other providers:** Gemini, OpenRouter, Codex, and an OpenAI-compatible provider. The last one takes `CLAUDE_MEM_OPENAI_COMPAT_BASE_URL` and has presets for Ollama, LM Studio and vLLM. So the compression can run on a local model on the appliance (docs: openai-compatible-provider). Summary quality on a small local model is unmeasured.
- **Redaction is off by default.** `CLAUDE_MEM_REDACT_ENABLED` defaults to `"false"`. When on, 11 built-in regex patterns plus 3 optional generic ones replace matches with `<redacted type='...'/>`. It runs at the point where `<private>` tags are stripped, before the data goes on. Custom patterns go in `CLAUDE_MEM_REDACT_CUSTOM_PATTERNS`.
- **Interaction with ADR-0032.** The rule is "redact on each machine before anything leaves it". claude-mem on each machine can meet it only if the owner turns redaction on, and it uses its own pattern set, not the gitleaks rules from Y-430. The tool-use content reaches the observer model, which is a hop the Syncthing flow does not have. A central worker would receive the raw tool output unless every machine redacted first.
- **Fast-moving privacy fixes.** Release 13.36.1 (2026-10-12) says private content is now removed before server transmission, and 13.37.0 fixed a 13.36.1 update that stopped capture.

## 5. Licence and maintenance

- Licence Apache-2.0. About 101,700 stars, 90 open issues, last push 2026-10-19 (GitHub API, today). Created 2025-08-31.
- Cadence: 15 releases between 2026-10-06 and 2026-10-17, from 13.32.0 to 14.0.1, plus a major 14.0.0. Several are product launches (My Work dashboard, TeamBrain, "30 Day Free Trial"). Expect the schema and settings to change monthly. The maintainer says as much about the export tools.
- The company sells the sync. The upstream direction is a paid cloud, which is a reason to doubt a free self-host path will be kept current.

## 6. claude-mem and ctx for handoffs

| Need | claude-mem | `ctx` 2.2.7 (R18 §11, 2026-10-05; not re-verified today) |
|---|---|---|
| Makes a summary of a session | Yes. A row per session on `Stop`, with next steps and files. Written by a model. | No. It indexes raw transcripts and returns snippets. No model call. |
| Serves it to a new session | Yes. `SessionStart` injects recent observations. The MCP tools `search`, `get_observations`, `session_start_context`. A `handoff` skill writes a `HANDOFF.md` by hand. | MCP and skill search over text. The agent must read hits and summarise. |
| Harnesses | Claude Code mainly. Codex hooks exist. Others by integrations. | Claude Code, Codex, Gemini, OpenCode, more (R18). |
| Across machines | Not for a self-hoster (section 3). | Beta history server: 24 MB idle, invitation file, needs an HTTPS front. The upload did not finish in R18. |
| Redaction | Optional, 11 patterns, in its own capture path. | None. Yantra's Y-430 staging copy supplies it. |
| Cost per session | A model call per tool use, on the user's subscription by default. | None. |
| Failure mode | The summary can be wrong or stale. It captures only sessions where the plugin ran. A machine without the plugin leaves no summary. | Search quality. R18 scored 2 yes, 2 partly, 1 weak on five queries. |

The two tools do different jobs. The handoff needs a summary, and only claude-mem writes one. The handoff also needs to reach a machine that was not there, and only `ctx` plus the Syncthing archive reach every machine today.

## 7. Options

**(a) claude-mem central on the appliance.**
- *Works today:* nothing documented. The worker host key probably rejects a tailnet address, and a network bind leaks provider keys.
- *To build:* a hub. Either the hosted server runtime (Postgres, Redis, key issue, with the install blocker above) or a self-hosted `services/sync-api`, which has no guide. Plus a per-machine redaction step that claude-mem's pattern set does not match.
- *Conflicts:* observer model sees raw tool output before gitleaks; the plugin must be on every machine.
- *Verdict:* not viable this month. Revisit if upstream documents self-hosting.

**(b) claude-mem on each machine, plus Yantra syncs its DB.**
- *Works today:* each machine's memory works alone. Copying the SQLite file is unsupported. Two live writers cannot share a file, and the export/import scripts are stale.
- *To build:* a merge of rows by `origin_device_id`/`origin_local_id` (the columns exist) and a Chroma rebuild. That is a fork of upstream's sync, against a schema that changes in each release. This breaks the "orchestrate, don't reinvent" rule.
- *Variant (b2):* leave each DB where it is. At continue time, Yantra reads the one `session_summaries` row for the session over `ssh` with read-only `sqlite3`. This builds only a reader, and no sync. It works only while the source machine is on, and it depends on the 13.x schema.
- *Conflicts:* none with ADR-0032 for the reader; the observer model still sees raw tool output.

**(c) `ctx` over the archive, skip claude-mem, and Yantra writes the handoff.**
- *Works today:* Y-430 redaction, Syncthing, the archive, `ctx` search (Y-431).
- *To build:* a handoff step in Y-518. When the owner says "continue on the MacBook", Yantra takes the redacted transcript of that session from the archive or the source machine and has one model call write a short summary (goal, state, files, failed attempts, next steps, like claude-mem's `handoff` skill). It starts the new session with that text. The call can run on the user's Claude login, so no new credential. This needs no new store and no new service.
- *Conflicts:* none. The summary is made from already-redacted text. It is created on demand, so it is never stale, and it works when the source machine is off if the archive has the session.

**(d) Other.** claude-mem on each machine for local recall only, with redaction on, and no sharing. This is compatible with (c) and costs the owner one model call per tool use on the subscription. A different shared store (for example a Postgres memory MCP) is a new service with the same redaction questions, and I did not evaluate one.

### My judgement (labelled as such)

I would pick **(c)**, with **(d)** as an optional extra the owner can run by hand.

1. The owner's real need is one summary at the moment of handoff. (c) makes it at that moment from text that is already redacted. claude-mem makes it on every `Stop`, on every machine, forever.
2. claude-mem has no self-hosted way to share. Every route (a), (b) means building against a fast-moving, commercially driven schema, which is the failure mode CLAUDE.md §B1 warns about.
3. (c) reuses the rows already planned (Y-430, Y-431, Y-432) and adds one step to Y-518. It keeps yantrad out of the data path (ADR-0032 decision 6).
4. The cost of (c): the summary comes from one model call over the whole transcript, so a very long session needs the call to read a long input. A summary made from the live session's last turn ("write a handoff") would avoid that, but needs the session to be alive.

If the owner wants the (b2) reader later, it is small and safe, but it should be a fallback, not the design.

## 8. What I could not verify

- Whether hooks work against a remote worker with `CLAUDE_MEM_WORKER_AUTOSTART=false`. No test host.
- Whether a 100.x address is rejected at runtime. I read the validator text only.
- The code of `services/sync-api`, and whether it self-hosts.
- Summary quality from a local model through the OpenAI-compatible provider.
- `ctx` today. The R18 figures are from 2026-10-05, on version 2.2.7.
- The date of issue #233's closing: I give the date as the fetched page stated it.

## Sources

All accessed 2026-10-19.

- Installed plugin: `~/.claude/plugins/installed_plugins.json`, `~/.claude/plugins/cache/thedotmack/claude-mem/13.39.0/` (`scripts/worker-service.cjs`, `hooks/hooks.json`, `skills/cloud-sync/SKILL.md`, `skills/handoff/SKILL.md`), `~/.claude-mem/` (`settings.json`, `supervisor.json`, `claude-mem.db` schema and counts).
- claude-mem repository, README and licence: https://github.com/thedotmack/claude-mem
- GitHub API, repo and releases: https://api.github.com/repos/thedotmack/claude-mem and https://api.github.com/repos/thedotmack/claude-mem/releases
- Docs index: https://docs.claude-mem.ai/llms.txt
- Architecture overview: https://docs.claude-mem.ai/architecture/overview.md
- Worker service: https://docs.claude-mem.ai/architecture/worker-service.md
- Hosted server (beta): https://docs.claude-mem.ai/hosted-server.md
- Cloud sync: https://docs.claude-mem.ai/cloud-sync.md
- TeamBrain: https://docs.claude-mem.ai/usage/teambrain.md
- Auto-redaction: https://docs.claude-mem.ai/usage/auto-redaction.md
- OpenAI-compatible provider: https://docs.claude-mem.ai/usage/openai-compatible-provider.md
- Issue 233, multi-device sync: https://github.com/thedotmack/claude-mem/issues/233
- Discussion 488, shared memory between machines: https://github.com/thedotmack/claude-mem/discussions/488
- Issue 4131, `--runtime server` install flow: https://github.com/thedotmack/claude-mem/issues/4131
- DevContainer sharing with socat: https://dev.classmethod.jp/en/articles/share-claude-mem-across-devcontainers/
- Yantra: `docs/adr/0032-the-appliance-keeps-the-conversation-history-encrypted.md`, `docs/research/18-one-conversation-history.md` §8, §11, `tracker.md` rows Y-426 to Y-432 and Y-518.
