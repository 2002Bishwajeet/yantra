# R19 — Driving every agent harness through ACP

**Asked 2026-10-05 by the owner (Y-427).** The owner wants two things, and wants Yantra to invent no
harness and no protocol of its own.

1. A main agent (Claude Code on Opus) hands work to other harnesses — Codex CLI, Grok's CLI, Gemini
   CLI, opencode and Claude Code itself. Each runs with its own tools and its own login, like a
   subagent.
2. The dashboard's Chat tab is on par with T3 Code's chat, for every harness and not only Claude Code.

The candidate standard is the Agent Client Protocol (ACP, from Zed). This note is **evidence for the
owner's decision in Y-428**. It decides nothing.

- **Read against:** [R15](15-t3code-for-the-chat.md), [ADR-0026](../adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md),
  [ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md),
  [ADR-0015](../adr/0015-resume-forks-the-conversation.md).
- **Where it was run:** this laptop (CachyOS, x86_64, Node 24.0.0, Claude Code 2.1.289 logged in) and
  the Debian 13 QA VM (`~/vms/yantra-qa`, x86_64, 2 GB RAM, Node 24.0.0 unpacked under `~/acp-lab`).
  The appliance target is arm64 with 4 GB. Nothing here ran on arm64.
- **Every claim says one of:** *verified* (a command was run here), *read* (in a repository or a
  package), or *documented* (a vendor page only). Everything is true for the versions in §1 on
  2026-10-05. These tools change weekly.
- **No transcript content is quoted.** Sizes and counts only. The one real model turn used the
  laptop's own Claude login on a throw-away directory.

## Negative findings first

1. **A running turn does not survive the connection.** ACP over stdio ends when stdin closes. I closed
   stdin of `claude-agent-acp` mid-turn, as a dropped `ssh` would. The adapter exited, its `claude`
   child exited, and the tool it was running never finished (verified, §3). The *history* survives and
   `session/load` restores it. The *turn* does not. ADR-0011's promise (the work continues while no one
   watches) is not something ACP over a plain ssh pipe gives.
2. **ACP defines no way to detach and re-attach to a live process.** The spec lists two transports:
   stdio (stable) and Streamable HTTP (draft, "in discussion"). It says nothing about remote agents
   (documented, §3). Yantra would have to put a keeper process on the machine, and no ACP agent
   ships one.
3. **`codex mcp-server` no longer exists.** OpenAI deprecated it on 2026-08-20 and removed it on
   2026-09-05 (PR #42993). Codex 0.159.3 has no such subcommand (verified). Every guide that tells
   Claude Code to call `codex mcp-server` is stale. Codex's own route is `codex app-server`, a
   different JSON-RPC protocol.
4. **Grok's ACP mode is real but undocumented, and its licence is proprietary.** `grok agent stdio`
   answers `initialize` (verified). The page `docs.x.ai/build/overview` mentions ACP in one sentence and
   documents no command. The ACP registry marks Grok Build `proprietary`. Grok says `image: false`
   (verified), so it takes no screenshots.
5. **Anthropic's terms may forbid the Claude adapter's login path for a product like Yantra.**
   The adapter ran on this laptop with the owner's Claude login and needed no `ANTHROPIC_API_KEY`
   (verified: its status message named a Max account). Anthropic's Agent SDK page says: *"Unless
   previously approved, Anthropic does not allow third party developers to offer claude.ai login or
   rate limits for their products, including agents built on the Claude Agent SDK."* The adapter is
   the Agent SDK underneath. The ACP registry also lists it as `proprietary`, although the package
   says Apache-2.0. An owner running their own tool on their own login is a grey case. Y-428 must
   read that page. (Documented, §1.)
6. **`claude-agent-acp` brings its own `claude` binary and pins its version.** The adapter ran
   `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude` 2.1.287 while the laptop's own
   `claude` is 2.1.289 (verified). `codex-acp` does the same with its bundled `codex`. A machine's
   own harness install is not the one ACP drives, unless `CLAUDE_CODE_EXECUTABLE` is set (read).
7. **The Claude adapter loads the owner's personal skills as slash commands.** Its first
   `available_commands_update` listed this laptop's `~/.claude` skills tagged `(user)` (verified).
   Fine for one owner. A leak across users if Yantra ever shares a machine.
8. **First start of an agent touches the network and the home directory.** `codex-acp` ran
   `git fetch --depth 1` into `~/.codex/.tmp/plugins-clone-*` on the VM during `session/new`.
   `opencode acp` wrote `~/.config/opencode/node_modules` (43 MB on this laptop). `grok` created
   `~/.grok` (165 MB, including a downloaded binary). Gemini wrote `~/.gemini`. (All verified.)
9. **ACP v2 is a draft and breaks v1 in the places a chat touches.** `session/load` is removed,
   `session/prompt` stops meaning "turn finished", diffs change shape, session modes go away.
   None of the five agents negotiates v2 today: each answered `protocolVersion: 1` to a request for 2
   (verified). T3 Code already supports v2 as a preview (read).
10. **ACP alone is not what T3 Code uses for its three biggest harnesses.** T3 Code drives Claude
    through the Agent SDK, Codex through its app-server protocol, and opencode through opencode's own
    server. It uses ACP for Grok, Cursor, Antigravity and any registry agent (read, §5). That is
    the strongest evidence in this note that ACP gives parity for a long tail but not always for the
    head.

## 1. ACP support, per harness (verified 2026-10-05)

Every row below was launched here, sent `initialize`, and answered. "Install" is what I ran.

| Harness | Support | Exact launch command | Package and version | Licence |
| --- | --- | --- | --- | --- |
| Claude Code | **Adapter** (Agent SDK) | `claude-agent-acp` | `@agentclientprotocol/claude-agent-acp` 0.86.0 (replaces `@zed-industries/claude-code-acp`, deprecated at 0.16.2); bundles `claude` 2.1.287 | Apache-2.0 in the package; `proprietary` in the ACP registry |
| Codex CLI | **Adapter** (wraps `codex app-server`) | `codex-acp` | `@agentclientprotocol/codex-acp` 2.1.1 (replaces `@zed-industries/codex-acp`, deprecated at 0.16.0); bundles `codex` 0.159.3 | Apache-2.0 |
| Gemini CLI | **Native** | `gemini --acp` (`--experimental-acp` is deprecated) | `@google/gemini-cli` 0.62.0 | Apache-2.0 |
| opencode | **Native** | `opencode acp` | `opencode-ai` 1.18.34 | MIT |
| Grok Build | **Native** | `grok agent stdio` | `@xai-official/grok` 1.0.46 (registry lists 1.0.49); native binary per platform, `linux-arm64` included | Apache-2.0 on the npm wrapper; `proprietary` in the registry |

**Grok.** The current CLI is xAI's "Grok Build", binary `grok`, installed with
`curl -fsSL https://x.ai/cli/install.sh | bash` or `npm i @xai-official/grok` (documented). The older
npm packages `grok-cli` 1.0.5 (2025-07) and `@vibe-kit/grok-cli` 0.0.34 (2025-11) are community tools
and were not tried. `grok agent` also has `serve` (a WebSocket server), `headless` (over xAI's relay)
and `leader` (one shared backend for many clients) (verified in `--help`). I did not test whether
`serve` speaks ACP.

**Registry.** `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` lists 41 agents
(version 1.0.0, fetched today), among them all five above, plus Cursor, Copilot CLI, Goose, Kimi,
Qwen Code, Amp, Junie and Mistral Vibe. Claude and Codex are shipped as `npx` packages, opencode as a
binary.

**Capabilities each agent advertised in `initialize` (verified):**

| | `loadSession` | `session/resume` | `fork` | `list` | image | audio | MCP servers from the client |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude-agent-acp | yes | yes | yes | yes | yes | no | http, sse |
| codex-acp | yes | yes | yes | yes | yes | no | http |
| gemini --acp | yes | not advertised | not advertised | not advertised | yes | **yes** | http, sse |
| opencode acp | yes | yes | yes | yes | yes | no | http, sse |
| grok agent stdio | yes | yes | not advertised | yes | **no** | no | http, sse |

All five answered with `protocolVersion: 1`, and all five accept `clientCapabilities` with
`fs.*: false` and `terminal: false`. That matters: the agent then uses its own file and shell tools on
its own machine, as the owner wants.

**The handshake, as sent and as received** (Claude adapter, this laptop; the account line is
shortened):

```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,
 "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},
 "clientInfo":{"name":"r19-probe","version":"0"}}}
```
```json
{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,
 "agentCapabilities":{"promptCapabilities":{"image":true,"embeddedContext":true},
  "mcpCapabilities":{"http":true,"sse":true},"loadSession":true,
  "sessionCapabilities":{"additionalDirectories":{},"close":{},"delete":{},"fork":{},"list":{},
   "resume":{},"subagents":{}}},
 "agentInfo":{"name":"@agentclientprotocol/claude-agent-acp","title":"Claude Agent","version":"0.86.0"},
 "authMethods":[]}}
{"jsonrpc":"2.0","method":"_auth/status_update","params":{"authStatus":{"kind":"account","label":"Claude Max", ...}}}
```

**Auth is outside the protocol's happy path.** `claude-agent-acp` returned `authMethods: []` and used
the machine's `~/.claude` login. `codex-acp` offered `api-key` and `chat-gpt`; `session/new` failed
on the VM with `{"code":-32000,"message":"Authentication required"}` (verified). Gemini offered four
methods and failed with `Gemini API key is missing or not configured.`. Grok failed with
`Authentication required` and `data: "no auth method id provided"`. opencode offered one method (run
`opencode auth login` in a terminal) and its `session/new` still worked, on a free built-in model
(verified). A Chat tab must show an unauthenticated state per harness and tell the person which
command to run on that machine.

## 2. The protocol surface a chat needs

JSON-RPC 2.0, one message per line, UTF-8, no embedded newlines. Stable version: `protocolVersion: 1`.
The Rust crate `agent-client-protocol` is 2.2.0 and `agent-client-protocol-schema` is 1.10.2
(crates.io, 2026-09-18 and 2026-10-01). Official SDKs also exist for TypeScript
(`@agentclientprotocol/sdk` 1.7.0), Python, Kotlin and Java. The repository is Apache-2.0 with 4.4k
stars. Shapes below were captured from the Claude adapter unless marked *documented*.

**Client to agent**

| Method | Purpose |
| --- | --- |
| `initialize` | version and capability handshake |
| `authenticate` | pick one of `authMethods` |
| `session/new` `{cwd, mcpServers}` | start a conversation. Returns `sessionId`, `modes`, `configOptions` (model, mode) |
| `session/load` `{sessionId, cwd, mcpServers}` | restore a conversation, replaying it as `session/update` |
| `session/resume`, `session/fork`, `session/list`, `session/close` | all advertised above; I ran the first three on Claude and `close` on opencode |
| `session/prompt` `{sessionId, prompt:[ContentBlock]}` | one user turn. Result: `{stopReason, usage}` |
| `session/cancel` `{sessionId}` (notification) | stop the turn |
| `session/set_mode`, `session/set_config_option` | change permission mode or model |

A prompt carries content blocks (*documented*): `text`, `image` `{mimeType, data}` (needs `image`),
`audio` (needs `audio`), `resource` (embedded text or blob, needs `embeddedContext`) and
`resource_link`. A slash command is plain text in a `text` block, such as `/compact`.
I did not send an image: only the capability flag is verified.

**Agent to client**

*Notifications `session/update`*, with `params.update.sessionUpdate` one of:

| Kind | What a chat does with it | Seen here |
| --- | --- | --- |
| `agent_message_chunk` `{messageId, content}` | append text | yes |
| `agent_thought_chunk` | reasoning pane | documented |
| `user_message_chunk` | replay on load | yes (on `session/load`) |
| `tool_call` `{toolCallId, title, kind, status, content, locations, rawInput}` | open a tool card | yes |
| `tool_call_update` | patch status, add diff or output | yes |
| `plan` `{entries:[{content, priority, status}]}` | task list | documented |
| `available_commands_update` `{availableCommands:[{name, description, input}]}` | slash menu | yes |
| `current_mode_update`, `config_option_update` | mode and model change | documented |
| `session_info_update` | title | documented |
| `usage_update` `{used, size, cost?}` | context meter | yes |

Tool `kind` is one of `read edit delete move search execute think fetch switch_mode other`. Tool
`status` is `pending in_progress completed failed`. A card's `content` is `content`, `diff`
`{path, oldText, newText}` or `terminal` `{terminalId}`.

*Request `session/request_permission`* (agent asks, client answers). Captured, with file paths
shortened:

```json
{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"…",
 "toolCall":{"toolCallId":"toolu_…","name":"Write","title":"Write hello.txt","kind":"edit",
  "status":"pending","rawInput":{"file_path":"…/hello.txt","content":"ok"},
  "content":[{"type":"diff","path":"…/hello.txt","oldText":null,"newText":"ok"}],
  "locations":[{"path":"…/hello.txt"}]},
 "options":[{"optionId":"allow-once","name":"Yes","kind":"allow_once"},
  {"optionId":"allow-with-updates","name":"Yes, allow all edits during this session","kind":"allow_always"},
  {"optionId":"reject","name":"No","kind":"reject_once"}]}}
```
Answer: `{"jsonrpc":"2.0","id":0,"result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}`.
On cancel the client answers `{"outcome":{"outcome":"cancelled"}}`. This is the typed permission card
that R15 and ADR-0026 asked for. It replaces the regex in `web/src/screens/session/pane.ts`.

*Turn result.* `session/prompt` returns `{"stopReason":"end_turn","usage":{"inputTokens":4,
"outputTokens":221,"cachedReadTokens":35716,"cachedWriteTokens":20949,"totalTokens":56890}}` from the
Claude adapter. Stop reasons: `end_turn max_tokens max_turn_requests refusal cancelled`.

*Cancel (verified).* I sent `session/cancel` after the first streamed chunk. The pending
`session/prompt` returned `stopReason: "cancelled"` in 3.7 s.

**Agent-private extensions ride in `_meta` and `_`-prefixed methods.** Examples seen: Claude's
`_auth/status_update`, Grok's `x.ai/...` hooks and model list in `initialize._meta`, Codex's
`_meta.steering`. A client may ignore them. The rich parts (Grok's model list with reasoning efforts,
Claude's per-model usage) live there.

**ACP v2 (draft, announced 2026-07-20).** `session/load` is gone; `session/resume` with
`replayFrom:{type:"start"}` replaces it. `session/prompt` returns `{messageId}` at once and the turn
state arrives as `state_update` (`running`, then `idle` with `stopReason`). Updates may arrive when no
turn runs. Tool calls become one patchable `tool_call_update`. Diffs become a `changes` array
(`add delete modify move copy`) with an optional `git_patch`. Permission requests carry `title`,
`description`, `subject`. Client `fs` and `terminal` methods and session modes are removed. No date
for stable is given (documented).

## 3. Session lifetime, and the ssh test

**What a session is.** For the Claude adapter, an ACP session *is* a Claude Code session. The
`sessionId` is the UUID of a transcript under `~/.claude/projects/<cwd>/<id>.jsonl`, the same file
that `claude --resume` reads (verified: the file appeared with the id the adapter returned).

**`session/load` after the process is gone (verified, Claude, this laptop).** I ran one turn that
wrote a file, killed the adapter, started a new adapter, and sent `session/load` with the old id and
cwd. The result: the agent replayed the history as four updates (`user_message_chunk`, `tool_call`,
`tool_call_update`, `agent_message_chunk`), and then answered a follow-up question that needed the
earlier turn. `session/list` returned the session with a title and `updatedAt`. `session/resume`
returned at once with one update and no replay. `session/fork` returned a new id and created a second
transcript file at once. For opencode, `session/new`, a restart, then `session/load` and `session/list`
all worked on an empty session (verified; no model turn). For Codex, Gemini and Grok the capability
is advertised and I could not run it without a login.

**What does not survive: the turn.** Same adapter, a prompt that runs `sleep 25; touch marker`, then
stdin closed after the tool started. Three seconds later the adapter was gone and no `claude` child
remained. The marker never appeared in 30 s. So a drop cancels the work. My first run was
inconclusive: the tool finished before stdin closed. In the second run my watcher did not see the
tool-start event, so I closed stdin at about 30 s and a `sleep` was still alive 3 s later. Treat the
timing as approximate and the conclusion as likely, not proven.

**How this sits with the ADRs.**

- **ADR-0011** keeps the agent in tmux so it outlives every client. ACP over stdio cannot give that.
  Three ways to close the gap, none tested end to end:
  1. Accept it. Chat turns are short, the turn dies with the connection, `session/load` restores the
     history on reconnect. The Terminal tab keeps ADR-0011 for long work.
  2. Run the ACP agent under tmux on the machine and bridge its stdio through a socket or fifo that
     `yantrad` reaches over ssh. This is Yantra writing a small keeper. It needs no ACP change.
  3. Use a harness's own server: `grok agent serve` or `leader`, `opencode serve` plus `attach`, `codex
     app-server daemon bootstrap` ("durable local app-server management for SSH-driven use", from
     `--help`). These outlive a client, but each speaks its own protocol, so they give up the one
     protocol that is the point.
- **ADR-0015** says `resume` forks, because Yantra keeps no session id and Claude refuses `--continue
  --session-id` without `--fork-session`. ACP changes the premise: `session/list` returns ids and
  titles by cwd, and `session/load` takes an id. No fork is forced. `session/fork` exists when a fork is
  wanted. Yantra would still keep no id: it asks the agent.
- **ADR-0026 decision 2** chose one `claude -p` process per turn because the bidirectional control
  channel was not verified. The adapter proves a long-lived session with typed permission answers
  works with the bundled `claude` 2.1.287 (verified). It does so through the Agent SDK, which is
  the policy question in negative finding 5.
- **ADR-0026 decision 8 (two agents, one working tree) is untouched by ACP.** An ACP agent beside the
  TUI is still a second writer. I did not test two live processes on one Claude session id. Do not
  assume it is safe.

**The ssh test on the QA VM (verified).** The VM has no Node and no agent logins. I unpacked
`node-v24.0.0-linux-x64` and installed the adapters under `~/acp-lab` as user `qa`. The client ran on
the laptop. The command, with no tty and no `-t`:

```sh
~/vms/yantra-qa/vm.sh ssh -- 'cd ~/acp-lab && export PATH=$PWD/node-v24.0.0-linux-x64/bin:$PATH \
  && exec node_modules/.bin/claude-agent-acp'
# (vm.sh ssh runs: ssh -i id_qa -p 2222 qa@127.0.0.1 …)
```

Sent `initialize` as in §1. The response, over ssh stdio, from `claude-agent-acp` 0.86.0 on Debian 13:
the same capabilities block as §1, `"loadSession":true`, and `"authMethods":[]`. `session/new` with
`cwd:"/home/qa"` succeeded with no login present; a login is needed only when a prompt runs. The same
test for `codex-acp` 2.1.1 returned `initialize` in full and then
`{"code":-32000,"message":"Authentication required"}` to `session/new`. Gemini, opencode and Grok were
run the same way. When the ssh client closed, every adapter exited with it. `codex-acp` left a stray
`git fetch` for a few seconds.

## 4. One agent calling another

Two jobs are mixed in the owner's request: *calling* another agent from Claude Code, and *showing* it
in a Chat. Existing tools cover the first.

| Tool | What it does | Maturity (2026-10-05) | What it lacks |
| --- | --- | --- | --- |
| **throng-mcp** (`agent-runbooks/throng-mcp`) | MCP server. `run_thronglet`, `send_message`, `wait_thronglet`, `list_thronglets`, `cancel_thronglet`, `list_harnesses`. Drives Claude Code, Codex, opencode, Gemini over ACP. Long-lived sessions, background runs, JSON-schema answers, `steer`. | 0 stars, created 2026-10-02, `0.4.0` on 2026-10-03, MIT, 753 npm downloads last week | Four days old. No Grok. No worktree: *"throng adds no isolation and rolls nothing back"*. Local only. |
| **mcacp** (`Oortonaut/mcacp`) | MCP server that speaks ACP to any registry agent. 22 tools: registry search, install, `initialize`, `new_session`, `prompt`, `load_session`. Sessions persist to disk. | 11 stars, `0.1.3`, last push 2026-02-01, Apache-2.0, 126 downloads last week | Idle eight months. Permission prompts fall back to an "operator mode" in Claude Code. |
| **acpx** (`openclaw/acpx`) | Headless ACP **CLI** client: `acpx codex "prompt"`, per-repo persistent sessions, `--agent '<command>'` for any ACP server. Not MCP, but Claude Code can call it with Bash. | 3.3k stars, `0.19.4` on 2026-10-01, MIT, 898,591 downloads last week, pre-1.0 | Not an MCP tool. No worktree. I did not run it. |
| **PAL MCP** (formerly Zen MCP, `BeehiveInnovations/pal-mcp-server`) | `clink` runs Gemini, Codex or Claude CLIs as subagents in a fresh context with role prompts. Many other tools (consensus, codereview). | 11.8k stars, `v9.8.2` on 2025-12-15, Apache-2.0 (GitHub shows NOASSERTION) | **Not ACP.** It starts each CLI headless with relaxed flags (`--yolo`, `--dangerously-bypass-approvals-and-sandbox`, `--permission-mode acceptEdits`), per its own docs. No live permission prompts. Last push 10 months ago. |
| **`claude mcp serve`** | Claude Code as an MCP server exposing its tools (Edit, Bash, `Agent`, `SendMessage`, and others). | Ships with Claude Code (verified: 23 tools listed) | It exposes Claude's *tools*, not a delegated agent turn. |
| **`codex mcp-server`** | Codex as an MCP server. | **Removed 2026-09-05.** | Gone. |
| **ACP-MCP-Server** (`GongRzhe/ACP-MCP-Server`) | Bridges IBM's *Agent Communication Protocol*. **A different protocol with the same acronym.** | 24 stars, archived | Not for coding agents. Name collision only. |
| **T3 Code's orchestrator MCP** | A provider agent creates a sub-agent on any T3 provider, waits, cancels, steers. Child gets the task prompt only. | Part of T3 Code 0.0.45 (MIT), `docs/orchestration-v2/orchestrator-mcp-server.md` | Lives inside T3's server. Prior art for the shape, not a package. |

None of the MCP tools runs the delegated agent **on another machine** or **in its own git worktree**.
Both are Yantra's own contribution. ssh is a one-word change to an ACP launch command (§3), and
`git worktree add` is one command. Neither tool does the second, which is ADR-0026 decision 8's
"isolate" option.

## 5. T3 Code today, and parity

**What changed since R15** (shallow clone of `main`, `5b613de1`, 2026-10-05; version 0.0.45, released
2026-10-02; R15 read `b248f5a` at 0.0.39). MIT, 25.5k stars.

- **ACP is now a first-class provider.** `packages/effect-acp` is a 7,406-line ACP client written for
  Effect. `apps/server/src/provider/acp/` holds the session runtime, a registry client for
  `cdn.agentclientprotocol.com`, and per-agent support for Grok (`GrokAcpSupport.ts`,
  `XAiAcpExtension.ts`) and Antigravity. `docs/user/providers-acp.md`: add any registry agent or a
  "Local ACP command"; agents "always run on the machine that hosts your T3 Code server". It prefers
  the ACP v2 preview and negotiates v1 as a fallback. It calls `session/load` (`AcpSessionRuntime.ts`).
- **Claude, Codex and opencode are not ACP in T3.** `ClaudeAdapterV2.ts` (7,871 lines) imports
  `@anthropic-ai/claude-agent-sdk`. `CodexAdapterV2.ts` (6,325 lines) uses `effect-codex-app-server`.
  `OpenCode2AdapterV2.ts` uses opencode's own server. Grok has its own adapter (455 lines) on ACP
  plus an `x.ai` extension. `AcpAdapterV2.ts` is 8,010 lines for the generic path.
- **A new orchestration layer (`orchestration-v2`)** with an MCP endpoint so one provider agent can
  create sub-agents on other providers. This is T3's answer to the owner's first want.
- Providers now: Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity, Pi, any ACP registry agent.

**Table: T3 Code chat feature, and does ACP v1 carry what it needs**

| T3 Code chat feature | ACP carries it? | Evidence |
| --- | --- | --- |
| Streaming text | **yes** | `agent_message_chunk` (verified) |
| Reasoning display | **yes** | `agent_thought_chunk` (documented) |
| Tool cards with kind, status, locations | **yes** | `tool_call`, `tool_call_update` (verified). Ten kinds, not T3's seven item types plus review and compaction. Close enough to map. |
| Permission prompts with options | **yes** | `session/request_permission` (verified) |
| Permission modes (default, accept edits, plan, bypass) | **yes in v1, no in v2** | `modes` and `configOptions` in `session/new` (verified). v2 removes session modes. |
| Per-tool diffs | **yes** | `diff` content with `oldText`/`newText` (verified) |
| Turn-level changed-files tree and diff panel | **partly** | No aggregate. The client folds per-tool diffs, or runs `git diff`. v2 adds `changes` and `git_patch`. |
| Question to the user (`user_input.requested`, AskUserQuestion) | **partly** | No standard v1 method. T3 code references an `elicitation` client capability. I did not test how Claude's adapter surfaces it. |
| Plan card and proposed plan | **partly** | `plan` entries are a task list. A "proposed plan to approve" is a permission request in plan mode, not a typed card. |
| Slash commands | **yes** | `available_commands_update` (verified); invoked as text |
| Model picker, reasoning effort | **yes** | `configOptions` for `model` on Claude and opencode (verified); Grok lists models in `_meta` |
| Images in the prompt | **yes, except Grok** | `image` capability: yes for four, **no for Grok** (verified) |
| Files and context in the prompt | **yes** | `resource`, `resource_link` (documented) |
| Cancel | **yes** | `session/cancel` (verified) |
| Many threads, list, archive | **yes for list, no for archive** | `session/list`, `session/close` (verified). Archive and search are Yantra's. |
| Reload history on open | **yes** | `session/load` (verified on Claude) |
| Token use and context meter | **yes** | `usage_update {used,size}` and per-turn `usage` (verified) |
| Spend per model | **partly** | Claude's adapter puts per-model usage in `_meta.quota` (verified); no standard cost field in practice |
| Subagent panel | **partly** | `subagents` session capability on Claude and Codex (verified flag); I did not run one |
| MCP servers per session | **yes** | `mcpServers` in `session/new` (verified flags) |
| Checkpoints and thread revert | **no** | Not in ACP. T3 has its own (`CodexThreadRevert.ts`). |
| Sign-in flow in the UI | **partly** | `authMethods` and `authenticate`; Claude returns none and relies on `claude login` (verified) |
| Live terminal output in a card | **partly** | `terminal` content needs the client to own terminals. v2 makes it display-only. |

**Reading of the table.** Fifteen rows are a yes, seven are partly, and one is a no. What is
missing is what T3 builds itself on top: checkpoints, a turn-level diff, an approval card for a
proposed plan. None of that is a Yantra goal in ADR-0026.

## 6. Fit with Yantra — options and a recommendation (for Y-428; not a decision)

**Cost on the appliance.** Under ADR-0026 the agent runs on the *fleet machine*, not on the 4 GB
appliance. What the appliance holds per open Chat is one `ssh` client (10.8 MB RSS, verified on this
laptop) plus the relay. What a fleet machine pays, measured on the 2 GB x86_64 VM after `initialize`
and `session/new`, idle:

| ACP agent process | RSS (all its processes) | Note |
| --- | --- | --- |
| claude-agent-acp | 327 MB | adapter 122 MB plus bundled `claude` 205 MB |
| codex-acp | 258 MB | adapter 90, a wrapper 54, `codex app-server` 114; before login |
| gemini --acp | 446 MB | two Node processes; before login |
| opencode acp | 384 MB | one process |
| grok agent stdio | 133 MB | one process; before login |

These are idle, x86_64, and for three agents they are before login, so a turn will cost more. A Pi
5 with 4 GB that is *both* appliance and fleet machine has room for about three idle sessions beside
the OS. I did not measure on arm64. Memory grows with the conversation.

**Option A — `yantrad` is an ACP client over ssh, beside the tmux TUI (extends ADR-0026).**
Replace ADR-0026's `claude -p` bridge with `ssh host <acp-agent>` and a Rust ACP client
(`agent-client-protocol` 2.2.0 on crates.io, or a thin hand-written client: the stable surface in
§2 is about ten methods and a dozen update kinds). One relay, one event model, every harness. The Terminal
tab and ADR-0011 stay. A drop cancels the turn (finding 1). Costs: the licence question for Claude
(finding 5), per-harness login states, and the working-tree interlock still owed by Y-359.

**Option B — Option A plus a keeper on the machine.** `tmux new -d` holds the ACP agent with its
stdio on a socket, so a turn outlives the browser. Closest to ADR-0011's promise. Yantra writes the
keeper (small, but it is new transport code under the B2 rule that says orchestrate, not reinvent).
Not tested.

**Option C — keep ADR-0026 for Claude and add ACP only for the others.** Smallest first step.
The Chat then has two relays. T3 Code split the same way: 7,871 lines for its Claude adapter, 6,325
for Codex and 8,010 for generic ACP.

**Option D — a Yantra MCP tool for delegation.** One tool such as `delegate(machine, harness,
prompt)` that makes a git worktree on the machine, starts the harness through ACP over ssh in that
worktree, and returns the result, with the session visible in the Chat. Nothing in §4 does the
machine and worktree parts. It could start from throng-mcp's tool shapes (MIT) or `acpx`. This is
the owner's first want and it is separate from the Chat.

**Recommendation, for the owner to accept or reject.** Take **A** for the Chat, with Claude
included, because one protocol for five harnesses is the point and §1 shows all five answer
`initialize` today. Start with the three that need no policy decision (opencode, Gemini, Codex) and
decide Claude's login path first, from Anthropic's own page. Take **D** as the second step, on top of
A's ssh launcher, and make "own git worktree" its default so ADR-0026 decision 8 is answered by
construction. Treat **B** as an option to price only if short turns prove too weak. Pin ACP v1 and
plan for v2: it changes `session/load`, the prompt result and the diff shape, so isolate those three
behind the client. An ADR is needed because it amends ADR-0026 (decisions 2, 3) and touches ADR-0011.

## Not verified

- A model turn on **Codex, Gemini or Grok**. No harness besides Claude was logged in. `session/load`,
  `session/prompt`, permission shapes and image input are advertised for them, not exercised.
- **opencode `session/load` with real history.** Only an empty session was reloaded. I ran no model turn
  on opencode, although it has a free built-in model.
- **An image prompt**, and `session/set_mode` / `set_config_option` on any agent beyond reading the lists.
- **Two live processes on one Claude session id** (the TUI in tmux and an ACP adapter). The risk is
  named, not measured.
- Whether `grok agent serve` or `leader` speaks ACP over WebSocket, and whether the leader survives
  its clients.
- How the Claude adapter shows `AskUserQuestion` and plan approval.
- Anything on **arm64**, on macOS, or on a real appliance. All RAM figures are x86_64.
- ACP v2 on a real agent. Each agent answered 1 to a version-2 request sent with v1-shaped fields;
  a v2-shaped `initialize` could behave differently.
- `acpx` and `mcacp` were read, not run. Their star counts and dates come from the GitHub API.
- Anthropic's position on subscription login through a self-hosted tool. I have the sentence on the
  Agent SDK page, and I do not have a ruling for this case. Search results quoted a June credit
  scheme for Agent SDK use; I did not find Anthropic's own page for it.
- Grok Build's licence terms for the native binary (the registry says `proprietary`).

**What this run left behind.**

- Laptop, removed: the scratch directory, the test transcripts under `~/.claude/projects`, `~/.grok`
  (created by this run), `~/.config/opencode/node_modules` and `~/.gemini/installation_id`.
- Laptop, **not** removed: `~/.codex`. It existed before, and `codex-acp` opened its SQLite state
  files (`state_5`, `logs_2`, `goals_1`, `memories_1`, `queue_1`) on start. No login or setting changed.
  `~/.gemini` and `~/.local/share/opencode` also existed before and may hold small new files.
- QA VM, removed: `~/acp-lab` (Node 24.0.0, 1.4 GB of packages) and every directory the agents created
  (`~/.claude`, `~/.claude.json`, `~/.codex`, `~/.gemini`, `~/.grok`, `~/.npm`, and the opencode
  config, data and cache). Nothing was installed with `apt`, and the VM was not stopped or reset.

## Sources

All accessed 2026-10-05.

- Agent Client Protocol, overview and agents list — <https://agentclientprotocol.com/overview/agents>
  (41 listed agents and clients).
- ACP, *Session setup* — <https://agentclientprotocol.com/protocol/session-setup> (`session/new`, `load`,
  `resume`, `close`).
- ACP, *Prompt turn* — <https://agentclientprotocol.com/protocol/prompt-turn> (update kinds, stop
  reasons, `session/cancel`).
- ACP, *Tool calls* — <https://agentclientprotocol.com/protocol/tool-calls>.
- ACP, *Content* — <https://agentclientprotocol.com/protocol/content>.
- ACP, *Slash commands* — <https://agentclientprotocol.com/protocol/slash-commands>.
- ACP, *Transports* — <https://agentclientprotocol.com/protocol/transports> (stdio stable; Streamable
  HTTP draft; remote agents not addressed).
- ACP v2 — <https://agentclientprotocol.com/protocol/v2/migration> and
  <https://agentclientprotocol.com/announcements/acp-v2-draft> (announced 2026-07-20, draft).
- ACP registry — <https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json> (fetched; 41
  agents; licences and distribution per agent).
- `agentclientprotocol/agent-client-protocol` — <https://github.com/agentclientprotocol/agent-client-protocol>
  (Apache-2.0, 4.4k stars); crates.io `agent-client-protocol` 2.2.0 and `agent-client-protocol-schema`
  1.10.2; npm `@agentclientprotocol/sdk` 1.7.0.
- `agentclientprotocol/claude-agent-acp` — <https://github.com/agentclientprotocol/claude-agent-acp>
  (2.6k stars; npm 0.86.0, modified 2026-10-05); the old `@zed-industries/claude-code-acp` is deprecated
  by npm.
- `agentclientprotocol/codex-acp` — <https://github.com/agentclientprotocol/codex-acp> (431 stars; npm
  2.1.1); the old `@zed-industries/codex-acp` is deprecated by npm.
- `google-gemini/gemini-cli` — <https://github.com/google-gemini/gemini-cli> (107k stars, Apache-2.0;
  npm 0.62.0, `--acp` in `gemini --help`).
- `anomalyco/opencode` — <https://github.com/anomalyco/opencode> (MIT; npm `opencode-ai` 1.18.34).
- xAI, *Grok Build* — <https://docs.x.ai/build/overview>; npm `@xai-official/grok` 1.0.46; `grok agent
  --help` run here.
- Anthropic, *Agent SDK overview* — <https://code.claude.com/docs/en/agent-sdk/overview> (the
  claude.ai-login sentence quoted in negative finding 5).
- OpenAI Codex PRs #39657 (deprecation warning, merged 2026-08-20) and #42993 (removal, merged
  2026-09-05) — <https://github.com/openai/codex/pull/42993>.
- `agent-runbooks/throng-mcp` — <https://github.com/agent-runbooks/throng-mcp> (README read; npm
  `throng-mcp` 0.4.0, 753 downloads last week).
- `Oortonaut/mcacp` — <https://github.com/Oortonaut/mcacp>; npm `mcacp` 0.1.3.
- `openclaw/acpx` — <https://github.com/openclaw/acpx>; npm `acpx` 0.19.4, 898,591 downloads last week.
- `BeehiveInnovations/pal-mcp-server` — <https://github.com/BeehiveInnovations/pal-mcp-server> and its
  `docs/tools/clink.md`.
- `GongRzhe/ACP-MCP-Server` — <https://github.com/GongRzhe/ACP-MCP-Server> (archived; IBM's other ACP).
- `pingdotgg/t3code` — <https://github.com/pingdotgg/t3code>, shallow clone at `5b613de1`
  (2026-10-05): `packages/effect-acp`, `apps/server/src/provider/acp/`,
  `apps/server/src/orchestration-v2/Adapters/`, `docs/user/providers-acp.md`,
  `docs/orchestration-v2/orchestrator-mcp-server.md`.
- This laptop (CachyOS, Claude Code 2.1.289, Node 24.0.0) and the Debian 13 QA VM (`~/vms/yantra-qa`,
  kernel 6.12.107, 2 GB), 2026-10-05: every command marked verified above.
