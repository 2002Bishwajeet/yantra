# R15 — T3 Code, and what the Chat tab can take from it

- **Asked:** 2026-09-07, by the owner: "for the chat implementation, yoink out the t3code github,
  attribute them and lets use what they have since they are more feature ready than us".
- **For:** Y-356 (streaming chat), and the ADR that row demands against
  [ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md).
- **Read against:** [ADR-0004](../adr/0004-rust-for-the-daemon.md) (Rust is the whole control plane),
  [ADR-0024](../adr/0024-the-dashboard-is-material-3-built-by-hand.md) (hand-built M3, 145 KiB for `/`).
- All findings below come from a shallow clone of `main` at commit `b248f5a`, 2026-09-07 09:14 UTC.

## What it is

T3 Code is Theo Browne's company's ("T3 Tools Inc.") control surface for coding agents:
`https://github.com/pingdotgg/t3code`, default branch `main`, MIT, 21,893 stars, 5,385 forks,
created 2026-02-08, last push 2026-09-07 09:14 UTC, latest release `v0.0.39` on 2026-09-07 06:52 UTC.
Its own README calls it an "agent harness control surface": a Node server on your machine drives the
agent CLIs you already pay for, and web, Electron desktop and Expo mobile clients control it.

It supports six agents — Claude, Codex, Cursor, Grok Build, OpenCode and Antigravity — and it does not
supply the model. You install and authenticate each CLI yourself.

The overlap with Yantra is real and it is narrow. T3 Code owns the machine the agent runs on;
Yantra owns a fleet and reaches each machine over ssh. T3 Code's remote story is a client reaching a
server that is already on the far machine ([`docs/internals/remote.md`](https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md):
"Direct access, Tailscale, SSH, and T3 Connect change how the client reaches that server; they do not
introduce another execution model"). Yantra's daemon is the far machine's only visitor.

## Licence

`LICENSE` is the MIT licence, verbatim, `Copyright (c) 2026 T3 Tools Inc.`. The operative sentence:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software …
> to deal in the Software without restriction … subject to the following conditions:
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.

So "yoink and attribute" is permitted, and the attribution the licence demands is exactly one thing:
carry the copyright line and the permission text with any substantial portion you copy. There are no
per-file copyright headers in their source to retain — I checked; only `apps/web/src/vendor/` and a
font directory carry any. T3 Code's own precedent for borrowed code is a file-top block comment
naming the upstream project, its URL and its full MIT text
(`apps/web/src/vendor/mdast-find-and-replace.ts`). That is the pattern Yantra should copy along with
any code.

**Not covered by the licence:** the T3 name, wordmark and icons. `apps/web/src/components/T3Wordmark.tsx`
and `assets/` are brand, not a grant. Copy no icon, no wordmark, no product name.

## Architecture

**Shape.** A pnpm monorepo, Node 24, `vite-plus` as the build tool, Effect as the backbone on both
sides. `apps/server` is the Node process (`npx t3@latest`), `apps/web` the browser client,
`apps/desktop` Electron 43, `apps/mobile` Expo 57 / React Native 0.86, `apps/marketing` the site.
`packages/contracts` is the wire schema, `packages/client-runtime` the shared non-UI client logic,
plus `packages/ssh` and `packages/tailscale`.

**Transport.** One authenticated WebSocket per client, carrying Effect RPC
(`packages/client-runtime/src/rpc/session.ts:191` — `Socket.layerWebSocket(connection.socketUrl…)`),
with the method list and payloads in `packages/contracts/src/rpc.ts` (1,306 lines) and
`packages/contracts/src/orchestration.ts` (1,956 lines). Not SSE, not plain JSON-RPC over HTTP.

**Server state.** SQLite with 64 migrations under `apps/server/src/persistence/Migrations/`, and an
event-sourced orchestration engine: a decider produces events, events and projections commit in one
transaction, reactors do the side effects afterwards
([`docs/internals/overview.md`](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md)).

**How it drives Claude.** Through `@anthropic-ai/claude-agent-sdk` ^0.3.260, in the Node server:
`apps/server/src/provider/Layers/ClaudeAdapter.ts` (5,143 lines) imports `query`, `CanUseTool`,
`PermissionMode`, `SDKMessage` and drives one SDK session per thread. Every provider is normalised
behind one adapter contract, and each provider's native events are translated into one canonical
event union in `packages/contracts/src/providerRuntime.ts`. The raw-event tags name the protocols:
`"claude.sdk.message"`, `"codex.app-server.notification"`, `"opencode.sdk.event"`, `"acp.jsonrpc"`.
Cursor, Grok and Antigravity go through ACP (`apps/server/src/provider/acp/`, JSON-RPC).

**The finding that matters most.** The TypeScript Agent SDK is a wrapper that spawns the `claude`
binary as a subprocess. T3 Code has a whole file for finding it
(`apps/server/src/provider/Drivers/ClaudeExecutable.ts`, whose comments name
`pathToClaudeCodeExecutable` and the `@anthropic-ai/claude-code` npm layout), and Anthropic's own
TypeScript reference confirms the option and the bundled native binary. The SDK is therefore not a
different agent; it is a typed Node client for a subprocess protocol.

**Front end.** React 19.2.6 with `babel-plugin-react-compiler` 1.0.0, TanStack Router 1.160,
Tailwind v4, `class-variance-authority`, `tailwind-merge`, **`@base-ui/react` ^1.4.1**, `lucide-react`,
`zustand` 5 plus `@effect/atom-react` for server state, `lexical` + `@lexical/react` for the composer,
`react-markdown` + `remark-gfm` + `rehype-raw` + `rehype-sanitize` for message bodies,
`@legendapp/list` for the virtualised timeline, `@pierre/diffs` + `@pierre/trees` for the diff view,
`@dnd-kit/*` for reordering, `heic-to`/`jszip`/`culori`/`jsonc-parser` around the edges. There is no
TanStack Query. Ghostty compiled to WASM renders the terminal (`apps/web/src/terminal/ghostty/`).

Yantra's stack is React 19, TanStack Router **and Query, Form, Table, Virtual**, Base UI ^1.6.0,
Tailwind v4, `cva`, `tailwind-merge`, `lucide-react`, xterm. The two agree on React, Base UI, Tailwind
and the compiler; they disagree on state (Effect atoms vs TanStack Query) and on every chat-specific
dependency.

**Where the chat lives.**

| Piece | Path | Lines |
| --- | --- | --- |
| Container / thread screen | `apps/web/src/components/ChatView.tsx` | 8,403 |
| Message + tool-call timeline | `apps/web/src/components/chat/MessagesTimeline.tsx` | 3,364 |
| Composer | `apps/web/src/components/chat/ChatComposer.tsx` | 5,602 |
| Markdown renderer | `apps/web/src/components/ChatMarkdown.tsx` | 3,155 |
| Diff view | `apps/web/src/components/DiffPanel.tsx`, `apps/web/src/components/diffs/` | 1,063 + 6 files |
| Tool-call presentation, provider-neutral | `packages/client-runtime/src/work-log/presentation.ts`, `toolPresentation.ts`, `commandLabel.ts` | 621 + 123 + 1,369 |
| Canonical event model | `packages/contracts/src/providerRuntime.ts` | 1,286 |
| Streaming client | `packages/client-runtime/src/rpc/session.ts`, `client.ts` | — |
| Thread/session model | `packages/contracts/src/orchestration.ts`, `apps/server/src/orchestration/` | 1,956 + a directory |
| Claude driver | `apps/server/src/provider/Layers/ClaudeAdapter.ts` | 5,143 |

`apps/web/src/components/chat/` alone is 21,815 lines across 114 files.

**What "more feature ready" covers**, each with its evidence:

- **Streaming** — `content.delta` events with `streamKind`, `delta`, `contentIndex`
  (`providerRuntime.ts:503`).
- **Tool-call cards** — sixteen tool item types plus `user_message`, `assistant_message`, `reasoning`,
  `plan`, `context_compaction` (`providerRuntime.ts:110–134`), with icons, titles and a per-tool
  presentation layer in `client-runtime/work-log/`.
- **Permission prompts** — `request.opened` / `request.resolved` carrying a `CanonicalRequestType`
  (`command_execution_approval`, `file_change_approval`, `apply_patch_approval`,
  `mcp_elicitation_approval`, …) and an options array; the UI is
  `ComposerPendingApprovalPanel.tsx` and `ComposerPendingApprovalActions.tsx`. Fed by the SDK's
  `canUseTool` callback, not by screen scraping.
- **Permission modes** — `acceptEdits` / `bypassPermissions` mapped from their own names at
  `ClaudeAdapter.ts:4643`; `docs/user/permission-modes.md`.
- **Diffs** — `turn.diff.updated`, `DiffPanel`, `ChangedFilesTree`, per-line comment annotations.
- **Multi-thread** — threads are first-class in orchestration, with archive, search, sort, and a
  sidebar (`threadRoutes.ts`, `state/threads.ts`, migrations 017/018).
- **Model picker** — `ProviderModelPicker.tsx`, `ModelPickerSidebar.tsx`, a bundled
  `model-manifest.json` and `ClaudeModelCatalog.ts`.
- **MCP** — `apps/server/src/mcp/` with an HTTP server, a session registry and toolkits.
- **Images and files** — `image_view` item type, `ExpandedImageDialog.tsx`, `heic-to`, an attachment
  store on the server.
- **Plan mode** — `ProposedPlanCard.tsx`, `turn.plan.updated` / `turn.proposed.delta`, migrations
  013–015.
- **Cost** — `thread.token-usage.updated`, `ContextWindowMeter.tsx`, `apps/server/src/usage/` with
  pricing and transcript scanning.
- **Subagents** — items carry `agentId` / `parentToolUseId` resolved from the SDK's
  `parent_tool_use_id`, and get their own panel.

Yantra's Chat today has none of these except a hand-parsed approximation of the permission prompt:
`web/src/screens/session/pane.ts` strips ANSI from the live terminal socket and regexes a question
mark followed by numbered options; `Chat.tsx` draws them and types the number back into the pane. The
transcript is polled 50 lines at a time through `POST /workspaces/{name}/logs`.

## What is reusable

| Piece | Path (in t3code) | Verdict | Why |
| --- | --- | --- | --- |
| Canonical runtime event union | `packages/contracts/src/providerRuntime.ts` | **redesign** | The single best thing in the repo for us. Copy the vocabulary — item types, `content.delta`, `request.opened/resolved`, `user_input.requested` — and re-express it as Rust types in `yantra-core`. The file itself is Effect `Schema` and cannot cross into Rust. |
| Approval request shape | `RequestOpenedPayload`, `CanonicalRequestType` | **redesign** | Tells us what a permission card must carry (`requestType`, `detail`, `options`, `args`) without inventing it. Yantra's `Prompt` type is a subset arrived at by regex. |
| Tool-call presentation rules | `client-runtime/src/work-log/presentation.ts`, `commandLabel.ts` | **redesign** | Provider-neutral, dependency-light logic for "what do you call this tool call". 2,100 lines of accumulated judgement; the rules transfer, the Effect types do not. |
| `MessagesTimeline.tsx` | `apps/web/src/components/chat/` | **no** | 3,364 lines, `@legendapp/list`, `@t3tools/contracts` types throughout, and Tailwind classes against shadcn tokens (`text-muted-foreground`) that ADR-0024 deleted. Rewriting the M3 version is cheaper than untangling it. |
| `ChatComposer.tsx` | same | **no** | 5,602 lines on Lexical (3.5 MB + 1.4 MB unpacked). Yantra's composer is a `TextField` and a send button. |
| `ChatView.tsx` | `apps/web/src/components/` | **no** | 158 imports, `@effect/atom-react` and `zustand` containers. It is their app. |
| `ChatMarkdown.tsx` | same | **partial lift** | The *dependency choice* is worth copying — `react-markdown` 10 + `remark-gfm` + `rehype-sanitize` is ~95 KB unpacked total and is what an assistant message needs. Their 3,155-line file is not. |
| Diff view | `DiffPanel.tsx`, `components/diffs/` | **no** | `@pierre/diffs` is 7.4 MB unpacked and the panel is wired to their event log. Yantra has no diff surface and no row asking for one. |
| Effect RPC client | `client-runtime/src/rpc/` | **no** | Pulls in `effect` (27 MB unpacked) and replaces TanStack Query. ADR-0024 §3 says full TanStack. |
| `ClaudeAdapter.ts` | `apps/server/src/provider/Layers/` | **no (but read it)** | Node + Effect + the SDK. It cannot run in `yantrad` under ADR-0004. It is the best available reference for *what* the SDK emits and how to normalise it. |
| Anything under `apps/desktop`, `apps/mobile`, `packages/ssh`, `packages/tailscale` | — | **no** | Yantra already has these in Rust, and ADR-0006's system-`ssh` transport is a decided question. |

The blunt summary: **almost nothing lifts as code, and the protocol design lifts completely.** Every
UI file that looks liftable is 3,000–8,000 lines coupled to Effect, to `@t3tools/contracts`, or to
Tailwind tokens ADR-0024 deleted, and each one carries a dependency the 145 KiB budget cannot pay for
(Lexical, LegendList, `@pierre/diffs`, `effect`). The event vocabulary costs nothing to adopt and is
the part that took them months.

## What Y-356's ADR must decide

The row says "an ADR decides the SDK against the TUI in tmux". T3 Code makes that a false choice,
because the SDK is a subprocess wrapper. The real options, each with today's evidence:

1. **Claude Agent SDK in the browser.** Impossible. The SDK is Node and spawns a binary; there is no
   browser build, and ADR-0023 keeps every grant on the appliance. No key ever reaches the browser.
2. **Agent SDK on the machine, driven by `yantra-agent`.** Possible and expensive: it puts Node and
   `@anthropic-ai/claude-agent-sdk` on every fleet machine, and ADR-0004 says "do not introduce a
   second runtime into the daemon, the CLI or the agent". `yantra-agent` is Rust and ships as a musl
   binary. Anthropic also states the SDK is Python and TypeScript only, and that other languages
   should "run the CLI as a subprocess".
3. **`claude -p --output-format stream-json --verbose --include-partial-messages`, spawned over ssh
   and streamed through `yantrad`.** This is what the SDK does under the hood, minus Node. Yantra
   already spawns processes over ssh through `Exec`, already has a WebSocket surface
   (`crates/yantrad/src/terminal.rs`), and already parses the agent's JSONL
   (`crates/yantra-core/src/logs.rs` projects 13 record types down to `user`/`assistant`). The cost
   is that headless `-p` produces no session a person can attach to, which is the exact objection
   ADR-0011 raised and has not withdrawn — so this option must say what happens to the Terminal tab.
   `--resume <id>` and `--input-format stream-json` are what would make it a conversation rather than
   a one-shot.
4. **Keep the TUI, keep parsing.** What ships today. It streams nothing: the transcript is polled and
   the prompt is regexed off a redraw stream. ADR-0011 already listed "no structured events" as the
   cost it accepted, and I-22 forbids the obvious shortcut of piping the agent's stdout.

The ADR must also decide the thing ADR-0011 explicitly left open — "whether Yantra ever *sends input*
to the agent programmatically" — because a streaming Chat tab that can answer a permission prompt is
sending input by definition. Today's answer is `send-keys` into a TUI, which ADR-0011 calls "the
brittle part of this design".

## Recommendation

Take the vocabulary, not the code. Write the Y-356 ADR around a Yantra event union modelled on
`providerRuntime.ts` — `item.started/updated/completed`, `content.delta`, `request.opened/resolved`,
`turn.started/completed`, with a canonical item-type list — defined in `yantra-core` as Rust enums and
served over the existing WebSocket, and pick option 3 or 4 for where those events come from. Copy at
most three things as code, each with a T3 Code attribution block at the file top: the tool-label rules
in `commandLabel.ts`, the tool-presentation table in `work-log/`, and the markdown dependency choice.
The honest cost of doing it this way is that Yantra gets none of the fourteen features listed above
for free — we still write the timeline, the composer, the cards and the tests in M3 by hand, and the
"more feature ready" gap closes at Yantra's pace, not T3 Code's. The honest cost of the alternative
is worse: lifting their chat means importing Effect, Lexical, LegendList and their contracts package,
which is a second state library, a 145 KiB budget blown several times over, and ADR-0024 reopened
three weeks after it was accepted. If the owner wants their features rather than their vocabulary,
the shortest path is not a fork of their UI — it is running their server, which is a different
product decision and belongs in its own ADR.

Attribution, if any code is copied: add `THIRD_PARTY_NOTICES.md` at the repo root with the full T3
Code MIT text and copyright line, put a block comment naming
`https://github.com/pingdotgg/t3code/blob/main/<path>` and the MIT text at the top of each copied
file (their own `apps/web/src/vendor/` precedent), and record it in `docs/session-log.md`. Take no
name, wordmark or icon.

## Sources

All accessed 2026-09-07.

- `https://github.com/pingdotgg/t3code` — repo metadata via `gh api repos/pingdotgg/t3code`:
  MIT, default branch `main`, 21,893 stars, 5,385 forks, created 2026-02-08, pushed 2026-09-07 09:14 UTC.
- `https://github.com/pingdotgg/t3code/releases/tag/v0.0.39` — latest release, published 2026-09-07 06:52 UTC.
- Shallow clone of `main` at `b248f5ad566a8cd3ea2d7d678c1e8aa49c748879` (2026-09-07 02:14 -0700):
  `LICENSE`, `README.md`, `package.json`, `pnpm-workspace.yaml`, `apps/web/package.json`,
  `apps/server/package.json`, `packages/client-runtime/package.json`,
  `packages/contracts/src/providerRuntime.ts`, `apps/server/src/provider/Layers/ClaudeAdapter.ts`,
  `apps/server/src/provider/Drivers/ClaudeExecutable.ts`,
  `packages/client-runtime/src/rpc/session.ts`, `docs/internals/overview.md`,
  `docs/internals/remote.md`, `docs/internals/providers.md`.
- `https://code.claude.com/docs/en/agent-sdk/overview` — "The SDK is available as a library for Python
  and TypeScript only. To drive the same agent loop from another language, run the CLI as a subprocess
  with the `-p` flag and `--output-format json`."
- `https://code.claude.com/docs/en/headless` — `--output-format text|json|stream-json`,
  `--include-partial-messages`, `--verbose`, `--resume <id>`, `--permission-mode`,
  `--permission-prompts none`, the `system/init` and `system/api_retry` event shapes.
- `https://code.claude.com/docs/en/agent-sdk/typescript` — `pathToClaudeCodeExecutable`,
  `executable`, `executableArgs`; the SDK spawns the Claude Code binary and bundles it as an optional
  dependency.
- npm registry, `npm view <pkg> dist.unpackedSize`: `effect` 27.2 MB, `@pierre/diffs` 7.4 MB,
  `lexical` 3.5 MB, `@legendapp/list` 2.3 MB, `@lexical/react` 1.4 MB, `zustand` 95 KB,
  `react-markdown` 53 KB, `remark-gfm` 22 KB, `rehype-sanitize` 21 KB.
