# R22. claude-mem as a shared memory across machines

- **Date:** 2026-10-19
- **Question:** Can claude-mem run once on the appliance and serve a Linux laptop and a MacBook? Can it produce and serve the short handoff summaries that the owner now wants?
- **Reads against:** [ADR-0032](../adr/0032-the-appliance-keeps-the-conversation-history-encrypted.md), [R18](18-one-conversation-history.md), Y-426 to Y-432, Y-518.
- **Owner update, 2026-10-19:** At-rest encryption (ADR-0032 decision 4, Y-429) is dropped. Redaction stays. The memory layer now serves handoffs. A session that continues on another machine starts fresh with a short summary, not the full transcript. This note does not weigh encryption.
- **Update, 2026-11-20:** claude-mem 16 has a self-hosted server runtime. It ran on yantra-box with no cmem.ai login. [§10](#10-the-server-runtime-on-yantra-box-2026-11-20) has the test and replaces the "not viable" verdict of §7 option (a).
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
- ~~The code of `services/sync-api`, and whether it self-hosts.~~ Answered in §9.
- ~~No stock worker run against the hub.~~ Done in §9.6.
- Summary quality from a local model through the OpenAI-compatible provider.
- `ctx` today. The R18 figures are from 2026-10-05, on version 2.2.7.
- The date of issue #233's closing: I give the date as the fetched page stated it.

## 9. Self-hosting the sync hub, 2026-10-19

The owner asked for one common memory on every device (Y-527). This section answers the `services/sync-api` item in §8. I cloned `thedotmack/claude-mem` at commit `3fae1eb` (version 14.0.1) and read the hub and the client sync code. I ran the hub's test suite in throwaway podman containers (`postgres:17`, `oven/bun:1`): 52 pass, 0 fail. I did not run a stock worker in this first pass, so §9.2 was from code. §9.6 records the run that checks it.

### 9.1 The hub self-hosts, with two stubs

- **Runtime.** One Bun process, `bun run src/index.ts`, with one dependency, `postgres`. The `Dockerfile` uses `oven/bun:1.4-debian` on port 8080.
- **Storage.** Postgres only. `src/schema.ts` creates `sync_users`, `sync_ops`, `sync_entity_heads`, `sync_devices` and `schema_migrations` at boot. Op bodies are plain text.
- **Protocol.** HTTP and JSON, protocol v2, one append-only log per user id: `POST /v1/sync/ops` (500 ops, 8 MB), `GET /v1/sync/changes?since=N`, `GET /v1/sync/status`, `GET /v1/sync/ws` and `GET /health`. Content kinds are `observation`, `summary`, `prompt` and `work_state` (`src/canonical-content.ts`).
- **Auth.** The client sends `Authorization: Bearer <token>`, `X-User-Id`, `X-Device-Id` and `X-Device-Name`. The hub does not check the token. It calls `TOKEN_VERIFY_URL` (default `https://cmem.ai/api/pro/sync/verify`) and wants a 2xx reply whose `userId` equals the header. This is the only paid-plan check (`src/auth.ts`).
- **Projection.** After each push the hub posts the ops to `INTERNAL_PROJECTOR_URL`, cmem.ai's own store. If that URL or `CMEM_INTERNAL_PROJECTOR_SECRET` is empty, every push returns 503 `projection_not_configured` (`src/projection.ts`), and a client retries forever.
- **Stubs.** `test/helpers.ts` (`startSidecar`) holds both: `/verify` returns `{"userId": <X-User-Id>}`, and `/project` checks the secret and returns `{protocol_version:1, epoch, projected_through_seq}`. The 52 tests pass with this sidecar.
- **Licence.** Apache-2.0. No upstream guide covers self-hosting.

### 9.2 A stock client needs no Pro licence for sync

- `src/services/sync/CloudSync.ts` turns sync on when `CLAUDE_MEM_CLOUD_SYNC_TOKEN`, `CLAUDE_MEM_CLOUD_SYNC_USER_ID` and `CLAUDE_MEM_CLOUD_SYNC_HUB_URL` are all set. I found no plan check in the sync path. The `CLAUDE_MEM_PRO_*` keys control cmem.ai's observer gateway, not sync.
- The client accepts `http://100.x.y.z:8080`. WireGuard encrypts the tailnet hop.
- The client asks for Supabase Realtime at `POST /v1/sync/realtime-token`. The hub answers 404, so the client polls: 30 s in a session, 5 min idle. `CLAUDE_MEM_CLOUD_SYNC_WS=false` skips the probe.
- `npx claude-mem install` signs in at cmem.ai. A self-hosted machine skips it and writes the keys into `~/.claude-mem/settings.json` by hand.

### 9.3 The deployment on the appliance

1. Postgres 16 or 17, in podman with a named volume.
2. The hub, pinned to a commit, with `HOST=<tailnet ip>`, `PORT=8080`, `DATABASE_URL`, `TOKEN_VERIFY_URL=http://127.0.0.1:8081/verify`, `INTERNAL_PROJECTOR_URL=http://127.0.0.1:8081/project` and a random `CMEM_INTERNAL_PROJECTOR_SECRET`.
3. The stub on `127.0.0.1:8081`. It accepts one random token from a `0600` file and answers `{"userId":"yantra"}`.

A machine joins with these keys and a worker restart:

```
CLAUDE_MEM_CLOUD_SYNC_HUB_URL=http://<appliance-tailnet-ip>:8080
CLAUDE_MEM_CLOUD_SYNC_TOKEN=<the stub token>
CLAUDE_MEM_CLOUD_SYNC_USER_ID=yantra
CLAUDE_MEM_CLOUD_SYNC_WS=false
CLAUDE_MEM_REDACT_ENABLED=true
```

- **What flows.** Observations, session summaries, the full text of user prompts, and `work_state`. Each worker pulls the other machines' rows into its own SQLite and Chroma, so each machine holds the whole memory. Raw transcripts and `tool_uses` do not flow.
- **Redaction.** `CLAUDE_MEM_REDACT_ENABLED` is off by default and must be on for every machine. `src/utils/tag-stripping.ts` redacts before text reaches the model, the local DB or the sync outbox. It uses claude-mem's own patterns, not the Y-430 gitleaks rules, and a model-written observation can still carry a secret that the patterns miss. [§9.7](#97-redaction-against-the-y-430-fixtures-2026-10-22) tests this.

### 9.4 Negative findings

- **The hub is not standalone.** Without the stubs it calls cmem.ai, and pushes fail.
- **Upstream does not support self-hosting.** The verify and projection contract can change in any release, and releases come about twice a week.
- **No live channel.** Machines converge at the poll interval, up to a few minutes.

### 9.5 Decision and fallback

Spike the self-hosted hub first (Y-527). It gives the owner claude-mem on every device with nothing leaving the tailnet except the observer's model calls. If the spike fails, or upstream breaks the contract, use §7 option (c): redacted transcripts to the appliance by Syncthing (Y-430, Y-431) and a search server there. Do not merge SQLite files in Yantra (option b). `ctx` and other memory servers were not re-checked today.

### 9.6 The spike, 2026-10-19

**Result: pass.** Two stock workers shared one observation through a self-hosted hub. No Pro licence, no cmem.ai sign-in and no model call was needed.

- **Version.** `thedotmack/claude-mem` tag `v14.0.1`, commit `3fae1eb45`. It was still the newest 14.x tag on 2026-10-19.
- **Setup.** One podman network, `postgres:17` with a throwaway volume, the hub (`services/sync-api` mounted into `oven/bun:1.4-debian`, `bun install --frozen-lockfile --production && bun run src/index.ts`), and the stub on `:8081`. The env was the §9.3 env, with `DATABASE_URL=postgres://postgres:pw@pg:5432/sync`. `GET /health` answered `{"ok":true}`.
- **Workers.** Two containers (`oven/bun:1.4-debian`) held the repo read-only and an empty `~/.claude-mem`. Each ran `cd /cm && bun plugin/scripts/worker-service.cjs start`. The built `plugin/scripts/worker-service.cjs` is in the repo, so no build step ran. Neither container held the owner's `~/.claude-mem` or any model credential.
- **Settings.** `settings.json` held the five §9.3 keys (hub URL `http://hub:8080`, a random token, `USER_ID=yantra`, `WS=false`, `REDACT_ENABLED=true`), plus the worker host and port.
- **Stub.** `/verify` accepts one token and `/project` echoes the epoch. It is the `startSidecar` logic with a fixed token:

```ts
Bun.serve({ hostname: "0.0.0.0", port: 8081, async fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/verify") {
    const t = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    return t === TOKEN ? Response.json({ userId: "yantra" }) : Response.json({ error: "denied" }, { status: 401 });
  }
  if (u.pathname === "/project") {
    if (req.headers.get("Authorization") !== `Bearer ${SECRET}`) return Response.json({ error: "denied" }, { status: 401 });
    const p: any = await req.json();
    return Response.json({ protocol_version: 1, epoch: p.epoch, projected_through_seq: p.through_seq });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}});
```

- **Making an observation on A.** `POST /api/memory/save` on A with `{"text", "title", "project"}` and a unique marker. The route calls `cloudSync.notify()`, so A flushed within 10 s. `GET /api/sync/status` showed `pending` at 0 and `headSeq` 2. `select seq, kind from sync_ops` on the hub held two `observation` rows.
- **Searching on B.** `GET /api/search?query=<marker>` on B returned the observation as `#2 Spike note ...`. B found the second marker too.
- **Time to converge.** B found the first marker 145 s after A saved it, on B's idle poll. This fits the 5 min idle interval at the upper end. I did not test the 30 s in-session interval.
- **The search needs no vector store.** Neither container had `uvx`, and the worker reported `vector_search_unavailable`. Keyword search still worked. Semantic search on the appliance would need `uvx`.

Negative findings:

- **`POST /api/import` does not flush.** It stored the row, and `sync/status` showed it `pending`, but it never called `notify()`. The row left only when the next `save` flushed. A bulk import to the hub would wait for the next write.
- **`/api/import` needs the session row to carry `status`.** The first call was rejected with `NOT NULL constraint failed: sdk_sessions.status`. The error text names the column, but the import schema does not.
- **The worker starts without Claude Code.** `/api/health` showed `degraded` (`claude_cli` setup required, `uvx` missing). Sync did not depend on either. Observations from real sessions still need a model, which this spike did not test.
- **Not tested.** Redaction, the realtime-token 404 (`WS=false` skipped the probe), the 503 `projection_not_configured` path, a hub restart, and two workers writing at once.

Commands, in order: `podman network create`, `podman volume create`, `podman run` for `postgres:17`, the stub and the hub, `podman run ... sleep infinity` twice for the workers, `podman exec -d` to start each worker, the `curl`-equivalent `fetch` calls named above. I removed the containers, the network, the volume and both images afterwards.

The done condition holds: the self-hosted hub works with stock workers on v14.0.1. The §9.4 risk stands, because upstream can change the verify and projection contract in any release. I do not decide Y-531 here.

### 9.7 Redaction against the Y-430 fixtures, 2026-10-22

**Result: the defaults miss 2 of the 3 Y-430 fixtures. One custom pattern catches both. Redaction does not run on four paths, and that includes the sync push.** Y-530 asked for this. I read `src/utils/redaction.ts` and `src/utils/tag-stripping.ts` at commit `3fae1eb` (v14.0.1). I ran the real functions in a throwaway `oven/bun:1.4-debian` container. The container had no network, and the clone was mounted read-only.

**The fixtures.** Y-430 tests redaction with three fake secrets from R18 §11.3 (`crates/yantra/tests/history.rs`). All three sit in one transcript line.

**How claude-mem applies redaction.**

- `loadRedactionConfig` reads five keys from `~/.claude-mem/settings.json`. Only the string `true` turns `CLAUDE_MEM_REDACT_ENABLED` on.
- `CLAUDE_MEM_REDACT_CUSTOM_PATTERNS` is a string that holds a JSON array of `{ "name", "regex" }` objects. Each regex compiles with `new RegExp(regex, 'g')`. There is no flags field, so `(?i)` does not work. A bad entry is skipped with a warning.
- Custom patterns run first, then the 11 built-in patterns. A match becomes `<redacted type='<name>'/>`.
- `stripTags` calls `redactSensitive` for every captured field: tool input and output, prompts, and the last assistant message. The worker scans `JSON.stringify(toolInput)`, so a quote arrives as `\"`.
- `CLAUDE_MEM_REDACT_GENERIC_ENABLED=true` adds three built-in patterns for `password=`, `*_token=` and `Authorization: Bearer`. It is off by default.

**Which fixtures the defaults miss.** I called `stripMemoryTags`, the real choke point, with a real `settings.json`, in four input forms: the Y-430 transcript line, plain text, `JSON.stringify` of a tool input, and a JSON object.

| Fixture | Caught by default? | Caught by `CLAUDE_MEM_REDACT_GENERIC_ENABLED`? | Pattern that catches it |
| --- | --- | --- | --- |
| `ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6` | Yes, `github_pat` | Yes | none needed |
| `API_TOKEN=Zq7Xw2Lp9Rt4Vb8Nm3Kc` | **No**, in all four forms | Yes | `yantra_keyed_secret` |
| `DATABASE_PASSWORD=Hunter2Correct9xQ` | **No**, in all four forms | Yes | `yantra_keyed_secret` |

With redaction off, all three survive. This matches R18: gitleaks catches the token, and no default rule catches the password.

**The custom pattern.** It redacts the value after a key that ends in `password`, `passwd`, `secret`, `token` or `api_key`. It keeps the key, so the observation still says what was set. It follows the Yantra gitleaks rule of Y-430, with three changes. JavaScript has no `(?i)`, so the case variants are spelt out. The value ends before a `(`, so `password = getPassword()` stays. A value needs 8 characters. The lookbehind is bounded to 40 key characters, which avoids the quadratic scan that the source warns about. The settings value, as `settings.json` must hold it:

```json
"CLAUDE_MEM_REDACT_CUSTOM_PATTERNS": "[{\"name\":\"yantra_keyed_secret\",\"regex\":\"(?<=\\\\b[A-Za-z0-9_]{0,40}(?:PASSWORD|[Pp]assword|PASSWD|[Pp]asswd|SECRET|[Ss]ecret|TOKEN|[Tt]oken|API_?KEY|[Aa]pi_?[Kk]ey)(?:\\\\\\\\{0,3}[\\\"'])?\\\\s{0,8}[=:]\\\\s{0,8}(?:\\\\\\\\{0,3}[\\\"'])?)(?![\\\\w$]*\\\\()[A-Za-z0-9_\\\\-+/=~@#$%^*!?]{8,}\"}]"
```

Run with this value, all four forms of both misses were redacted and no fixture survived.

**False positives.** I ran 18 ordinary lines through the same function with the pattern on. These stayed unchanged: `max_tokens=4096`, `const token: string = x;`, `tokenizer = AutoTokenizer.from_pretrained("gpt2")`, `password = getPassword()`, `password: string;`, `PWD=/home/biswa/project`, `TOKEN_TTL=3600`, `password_hash = hash(raw)`, `DATABASE_PASSWORD=${DATABASE_PASSWORD}` and eight more. One line changed: `password = "changeme"`. That is a literal password, so I count it a correct catch. The pattern has no entropy gate, because the fixtures are plain words and digits. Any literal 8-character value after such a key is redacted.

**The generic switch is the other fix.** `CLAUDE_MEM_REDACT_GENERIC_ENABLED=true` also caught both misses. It also redacted `password = getPassword()`, which breaks code text. Y-529 should set the custom pattern. The generic switch is optional and adds no cover the pattern lacks, except `Authorization: Bearer` headers.

**Negative findings. Redaction does not apply on these paths.** I ran the first two in a live worker (`bun plugin/scripts/worker-service.cjs start`, `CLAUDE_MEM_REDACT_ENABLED=true`, no network). I read the other two in the source.

- **`POST /api/memory/save` stores the text raw.** The row in `observations` held the token, the password and the GitHub token. `save-memory.ts` does not call `redactSensitive`. This route is what the MCP `save_memory` tool uses.
- **`POST /api/import` stores the text raw.** Imported `prompts` and `observations` rows held all three secrets. `/api/memory/ingest` has no redaction call either.
- **The sync push does not redact.** `CloudSync.ts` strips only its own token from error text. A row that reaches the outbox leaves as it is stored. The pull side writes rows as they arrive. One machine with redaction off, or one raw save, puts the secret on every machine.
- **The observer's own output is not redacted on the SQLite path.** The model writes the observation text, and `ResponseProcessor.ts` stores it without a redaction call. Redaction cleans only what the model reads. A model that infers a secret can write it. Only the server (Postgres) path scans generated content.
- **Nothing redacts rows stored before redaction was on.** I found no code that rewrites old rows. The first run on a machine must start with redaction on, or the old rows need a manual clean.
- **A broken `settings.json` drops the custom patterns.** With no earlier good config in memory, the worker falls back to the built-in patterns only (`BUILTINS_ONLY`). Y-529 must write the file as valid JSON and check it parses.
- **Server-runtime session metadata is not redacted.** The upstream docs say so.

Y-529 must therefore set `CLAUDE_MEM_REDACT_ENABLED=true` and the pattern on every machine before the first sync. Calls to `save_memory` should not carry secrets. Y-531 should weigh the sync gap: redaction on the source machine does not cover a raw save or import.

**Not tested.** The full observer path with a model, because no model credential was in the container. The server (Postgres) runtime. A pull from a second worker.

Commands, in order: `git clone https://github.com/thedotmack/claude-mem` and `git checkout 3fae1eb` in `~/.cache/yantra-ref/claude-mem`; `podman pull docker.io/oven/bun:1.4-debian`; then for each of `off`, `defaults`, `generic` and `custom`: `podman run --rm -m 1g --network none -v <clone>:/cm:ro -v <harness>:/h:ro -e HOME=/tmp/home oven/bun:1.4-debian bun /h/run.ts <mode>`. The script writes `settings.json`, imports `/cm/src/utils/tag-stripping.ts` and calls `stripMemoryTags`. The live run: `podman run --rm -m 2g --network none ... bash /h/live.sh`, which starts the worker on port 37700 and posts to `/api/memory/save` and `/api/import`. Then it reads `~/.claude-mem/claude-mem.db` with `bun:sqlite`. The worker port is `37700 + uid % 100`, so root uses 37700.

## 10. The server runtime on yantra-box, 2026-11-20

The owner asked for one shared memory for every machine and account (Y-820). §1 and §7 said that claude-mem had no self-hosted route. That is no longer true. Upstream now ships a server runtime with a Docker Compose stack and a guide (`docs/server.md`, `docs/public/hosted-server.mdx`). I ran it on yantra-box and wrote to it from the laptop.

**Result: the server runs on the box with no cmem.ai login, and a laptop session reaches it over the tailnet with a key. No provider key is reachable from the tailnet. Redaction runs on the client before the data leaves, but only when each machine turns it on.** Option (a) of §7 is now viable. Five conditions in §10.7 must be settled in an ADR first.

### 10.1 What I ran

- **Version.** `thedotmack/claude-mem` tag `v16.0.0`, commit `cc0fb9515`. The newest tag on 2026-11-20 was `v16.0.1`. The laptop client was the installed plugin, 16.0.0.
- **Stack on the box.** Four rootless podman containers as `biswa`, on one private podman network: Postgres 17 with pgvector and pg_textsearch (built from `docker/postgres/Dockerfile`), `valkey/valkey:8-alpine`, the HTTP server and the generation worker (both from `docker/claude-mem/Dockerfile`). The environment was the one in upstream's `docker-compose.yml`. I used `podman run`, not `docker compose`.
- **Bind.** Only the HTTP server published a port, on the tailnet address: `-p 100.95.169.83:37977:37877`. `ss -ltn` showed `100.95.169.83:37977` and no other new listener. Postgres, Valkey and the worker had no host port.
- **Model.** I had no provider key and did not use one. The worker ran with `CLAUDE_MEM_SERVER_PROVIDER=custom` and a 20-line stub module that returns one fixed observation or summary. So the queue, the worker and the storage are tested. Observation quality from a real model is not.
- **Client.** A throwaway `oven/bun:1.4-debian` container on the laptop, with the installed plugin mounted read-only and an empty data directory. It ran the real hook entry point: `bun scripts/hook-service.cjs hook claude-code <session-init|observation|summarize|session-end|context>`. The laptop's own `~/.claude-mem` and its worker were not touched.
- **Data.** Test markers and the three fake secrets of Y-430 only. I removed every container, volume, network, image and test directory afterwards. `podman ps -a`, `podman volume ls`, `podman images` and `ss -ltn` on the box matched the state before the test.

### 10.2 Question 1: does the server run without a cmem.ai login? Yes (verified)

- The server started and `GET /healthz` answered `{"status":"ok","runtime":"server-beta"}`. No step asked for an account, a browser or a licence key.
- The first API key comes from a command in the server container. It writes to Postgres and calls no outside service:

```
podman exec <server> bun /opt/claude-mem/scripts/server-service.cjs \
  server api-key create --name <name> --scope memories:read,memories:write
```

- The command creates one team (`local-hook-team`) and one project (`local-hook-project`) and prints the raw `cmem_...` key once. Postgres keeps a SHA-256 hash.
- I did not run `npx claude-mem install --runtime server`. A machine joins with four keys in `~/.claude-mem/settings.json` (§10.3), so the installer and its browser sign-in are not needed. Issue #4131 is closed: the help text now says which providers need a cmem.ai sign-in.
- Idle memory: server 221 MB, worker 229 MB, Postgres 11 MB, Valkey 8 MB. The claude-mem image is 3.13 GB.

### 10.3 Question 2: does a laptop session reach it with a key? Yes (verified)

A machine uses the server when its `settings.json` holds these keys:

```
CLAUDE_MEM_RUNTIME=server
CLAUDE_MEM_SERVER_URL=http://100.95.169.83:<port>
CLAUDE_MEM_SERVER_API_KEY=cmem_...
CLAUDE_MEM_SERVER_PROJECT_ID=<project uuid>
```

- **Hooks.** `session-init` called `POST /v1/sessions/start`. `observation` called `POST /v1/events`. `summarize` and `session-end` closed the session. Postgres then held 2 sessions, 4 events and 6 completed generation jobs. The stub's 4 observations and 2 summaries were stored.
- **A second client.** A container with a new, empty data directory ran the `context` hook. The start context held both summaries from the first client's sessions. This is the handoff that §6 asks for.
- **MCP.** `POST /v1/mcp` with the key listed five read-only tools: `search`, `timeline`, `get_observations`, `context`, `recent`. A `search` call from the laptop returned the hook-made observations.
- **REST.** `POST /v1/memories` stored a note (201) and `POST /v1/search` found it.
- **Auth.** No key: 401. A revoked key: 403 on the next request. A `memories:read` key: search 200, write 403, `POST /v1/keys` 403.
- **Transport.** The client accepted plain `http://` to the tailnet address. WireGuard encrypts that hop. The server has no TLS of its own.

### 10.4 Question 3: is a provider key reachable from the tailnet? No (verified)

- I put a marked fake provider key in the worker's environment and a second one in the server's environment. I then sent 23 requests from the laptop to 19 routes, with no key and with a read and write key. No response body held either marker or the database URL.
- `GET /api/settings` needs a key (401 without one) and returns `{}`. `POST /api/settings` does not exist (404). The server has no settings route that returns or changes a credential.
- `/api/admin/*` answered 403 from the tailnet, with and without a key.
- The design keeps the provider key away from the listener: only the worker container needs it, and the worker opens no port.
- **These routes answer without a key:** `/healthz`, `/v1/info`, `/api/health`, `/api/version`, `/api/readiness`, `/api/instructions` and the viewer's HTML at `/`. `/api/health` shows the version, the Valkey host name and the queue prefix. None of them returns memory content or a credential.
- **The old worker (code, not tested).** In 16.0.0 its `GET /api/settings` masks secret values (`SettingsRoutes.ts`). A worker on a non-loopback host with no `CLAUDE_MEM_LOCAL_API_TOKEN` binds to loopback and logs a `SECURITY` error (release notes for 16.0.0). §3 finding 3 described 13.39.0.

### 10.5 Question 4: does redaction run before data leaves a machine? Only when the machine turns it on (verified)

I pointed the hooks at a capture server inside the client container and read the request bodies. Each body carried the three Y-430 fixtures and one `<private>` section.

| Client setting | `ghp_...` token | `API_TOKEN=...` | `DATABASE_PASSWORD=...` | `<private>` text |
| --- | --- | --- | --- | --- |
| Default (redaction off) | **sent** | **sent** | **sent** | not sent |
| `CLAUDE_MEM_REDACT_ENABLED=true` | redacted | **sent** | **sent** | not sent |
| The same, plus the §9.7 custom pattern | redacted | redacted | redacted | not sent |

- The redaction runs in the hook, in `ServerClient.buildEventPayload` and `buildStartSessionPayload`, before the HTTP request. The table is the wire content, not the stored content.
- It covers the prompt in the session metadata too. Upstream's auto-redaction page still says that it does not. The code and the capture say that it does in 16.0.0.
- **Redaction is still off by default.** With the default, the server stored all three secrets in `server_sessions` and `agent_events`. I read the rows.
- **The built-in patterns grew from 11 to 42 and still miss the two keyed fixtures.** The §9.7 custom pattern is still needed, and it still works unchanged.
- **The server can also redact on ingest (code, not tested).** `agent-events.ts` and `server-sessions.ts` call the same functions with the server's own settings. That is a second net. It does not meet the ADR-0032 rule, because the secret has left the machine by then.
- The stub model does not show what a real model writes. §9.7's point stands: a model can restate a secret that the patterns missed.

### 10.6 Negative findings

- **Upstream's Dockerfile does not build at `v16.0.0`.** `npm install` fails in `@derekstride/tree-sitter-sql`: its `tree-sitter` binary needs `GLIBC_2.39`, and `node:20` is Debian 12 with glibc 2.36. `podman build --from docker.io/library/node:20-trixie` built it. I found no upstream issue for the Docker case (#4758 is the same fault on Ubuntu 22.04).
- **The generation worker needs a metered provider key.** The server's Claude provider sends `x-api-key` to `api.anthropic.com` and reads only `ANTHROPIC_API_KEY` or `CLAUDE_MEM_ANTHROPIC_API_KEY` (code). A comment in `docker-compose.yml` names a subscription mode. I found no code for it in the server providers. The other providers are Gemini, OpenRouter and a custom module. The OpenRouter provider takes `CLAUDE_MEM_OPENROUTER_BASE_URL`, so a local OpenAI-compatible model may work (code, not tested).
- **One project for the whole fleet.** The bootstrap makes one project. `GET /v1/projects` and `POST /v1/projects` are in the guide's endpoint list and answered 404. I found no route and no command that creates a second project (code). A hook sends every repository to the one `CLAUDE_MEM_SERVER_PROJECT_ID` of its machine.
- **A hook drops its event when the server is down.** With the server port closed and `CLAUDE_MEM_WORKER_AUTOSTART=false`, the hook logged `[server-fallback] reason=transport` and `skipped event`, and kept no file to retry. With autostart on (the default), the code falls back to the local worker, so the memory splits between the server and that machine's SQLite (code, not tested).
- **Telemetry is on by default.** The client prints the notice at session start. `CLAUDE_MEM_TELEMETRY=0` or `DO_NOT_TRACK=1` turns it off. My test containers ran with the default, so they may have sent anonymous usage counts to upstream. No test content is in that data, by upstream's description.
- **The viewer does not work in a browser.** Its page sends no key, so every data call gets 401. Upstream's answer is a reverse proxy that adds the header.
- **Upstream calls the server beta.** The guide says that routes, variable names and the first-key flow may change. Releases still come several times a week.
- **Not tested.** A real model in the worker. A Mac client. The plugin's own MCP server in server mode (code: `search`, `timeline`, `get_observations` and `observation_add` use the configured server). A move of each machine's existing SQLite memory into the server. Two machines writing at once. A restart of the stack with data in the queue. The remote-worker route of `docs/remote-worker-capture.md` (`CLAUDE_MEM_WORKER_URL`), which shares the old worker and requires `https` off loopback.

### 10.7 Verdict for Y-821

**Option (a), claude-mem central on the appliance, is viable.** It replaces the §9 hub with stubs: the server needs no stub, no cmem.ai call and no Pro licence. It also keeps one copy of the memory, where the §9 hub copies every row to every machine.

Y-821 is a new service on the box, so an ADR comes first. The ADR must decide these points:

1. **The model credential.** The worker needs an Anthropic, Gemini or OpenRouter API key on the box, or a local model. The owner's Claude login does not work there. A key on the box is a stored credential, so CLAUDE.md §B4 applies.
2. **Redaction on every client.** Each machine and account must set `CLAUDE_MEM_REDACT_ENABLED=true` and the §9.7 pattern before its first session. One machine with the default puts raw secrets in Postgres. Something must check this (Y-819 is the place for a new account).
3. **The project layout.** One project for the fleet, or rows that Yantra adds to Postgres by hand.
4. **Behaviour when the box is off.** Lose the events, or let each machine fall back to its local worker and accept a split memory.
5. **The build and the upgrades.** Pin a tag, carry the base-image override until upstream fixes the Dockerfile, and set telemetry off. The API is beta.

Each account also keeps the server's API key in its own `~/.claude-mem/settings.json`, mode `0600`. That file is claude-mem's. A Yantra workspace must still hold no value (§B4).

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
- Spike, 2026-10-19: clone of `thedotmack/claude-mem` at `v14.0.1` (`3fae1eb45`), and a run of its hub and two stock workers in throwaway podman containers (§9.6).
- OpenAI-compatible provider: https://docs.claude-mem.ai/usage/openai-compatible-provider.md
- Issue 233, multi-device sync: https://github.com/thedotmack/claude-mem/issues/233
- Discussion 488, shared memory between machines: https://github.com/thedotmack/claude-mem/discussions/488
- Issue 4131, `--runtime server` install flow: https://github.com/thedotmack/claude-mem/issues/4131
- DevContainer sharing with socat: https://dev.classmethod.jp/en/articles/share-claude-mem-across-devcontainers/
- Yantra: `docs/adr/0032-the-appliance-keeps-the-conversation-history-encrypted.md`, `docs/research/18-one-conversation-history.md` §8, §11, `tracker.md` rows Y-426 to Y-432 and Y-518.
- claude-mem at commit `3fae1eb`: `services/sync-api/src/{index,auth,env,projection,schema,canonical-content}.ts`, `Dockerfile`, `test/helpers.ts`; client `src/services/sync/CloudSync.ts`, `src/services/worker/DatabaseManager.ts`, `src/shared/SettingsDefaultsManager.ts`, `src/utils/tag-stripping.ts`; `docs/public/cloud-sync.mdx`. Local run: `bun test test` in podman, 52 pass.
- Redaction run, 2026-10-22 (§9.7), accessed 2026-10-22: claude-mem at `3fae1eb` (v14.0.1), `src/utils/redaction.ts`, `src/utils/tag-stripping.ts`, `src/services/memory/save-memory.ts`, `src/services/worker/http/routes/{DataRoutes,MemoryRoutes,MemoryIngestRoutes}.ts`, `src/services/sync/CloudSync.ts`, `src/services/worker/agents/ResponseProcessor.ts`, `docs/public/usage/auto-redaction.mdx`. Yantra: `crates/yantra/tests/history.rs`, `crates/yantra-core/src/history.rs`, `docs/research/18-one-conversation-history.md` §11.3.
- Server re-test, 2026-11-20 (§10), accessed 2026-11-20: claude-mem at `cc0fb9515` (v16.0.0), `docs/server.md`, `docs/public/hosted-server.mdx`, `docs/public/usage/auto-redaction.mdx`, `docs/public/telemetry.mdx`, `docs/remote-worker-capture.md`, `docker-compose.yml`, `docker/claude-mem/Dockerfile`, `docker/postgres/Dockerfile`, `src/services/hooks/{runtime-selector,server-client,server-bootstrap}.ts`, `src/server/runtime/{ServerService,ServerViewerRoutes,create-server-service}.ts`, `src/server/routes/v1/ServerV1PostgresRoutes.ts`, `src/server/generation/providers/ClaudeObservationProvider.ts`, `src/storage/postgres/{agent-events,server-sessions}.ts`, `src/cli/handlers/observation.ts`, `src/services/worker/http/routes/SettingsRoutes.ts`; the installed plugin `~/.claude/plugins/cache/thedotmack/claude-mem/16.0.0/`; a run of the stack in rootless podman on yantra-box and of the hooks in a container on the laptop.
- Hosted server guide, accessed 2026-11-20: https://docs.claude-mem.ai/hosted-server
- Releases `v16.0.0` and `v16.0.1`, and issues 4131 and 4758, accessed 2026-11-20: https://github.com/thedotmack/claude-mem/releases/tag/v16.0.0, https://github.com/thedotmack/claude-mem/issues/4131, https://github.com/thedotmack/claude-mem/issues/4758
