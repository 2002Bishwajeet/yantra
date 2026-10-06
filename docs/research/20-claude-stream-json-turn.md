# R20 — One chat turn with `claude -p` over stream-json

**Asked 2026-10-06 for Y-356.** [ADR-0026](../adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md)
decision 2 left one question open: can a running `claude -p` take a permission answer on stdin? If it
cannot, the fallback is a `--permission-mode` per turn. This note answers it, and records what the
bridge in [`claude.rs`](../../crates/yantra-core/src/claude.rs) was built against.

- **Read against:** [R15](15-t3code-for-the-chat.md), [R19](19-acp-for-every-harness.md),
  [ADR-0026](../adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md) and its 2026-10-06
  amendment (isolate).
- **Where it was run:** this laptop (CachyOS, x86_64, Claude Code 2.1.291, logged in with the
  owner's account, model `haiku` to keep the cost down), and the podman fixture (Alpine 3.22,
  x86_64, the vendor's `linux-x64-musl` build of 2.1.291).
- **Every claim says one of:** *verified* (a command was run here) or *read* (in the vendor's
  documentation or installer).

## The answer: yes, on stdin

**Verified.** Run with these flags, a turn takes its prompt and every permission answer on stdin:

```sh
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --permission-prompt-tool stdio [--resume <session-id>]
```

The prompt is one line:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
```

A permission arrives on stdout as a control request. The recording is in
[`tests/recordings/claude-2.1.291-accept.jsonl`](../../crates/yantra-core/tests/recordings/claude-2.1.291-accept.jsonl):

```json
{"type":"control_request","request_id":"753d160f-…","request":{"subtype":"can_use_tool",
 "tool_name":"Bash","display_name":"Bash","input":{"command":"touch made.txt","description":"…"},
 "description":"Create a file named made.txt","permission_suggestions":[…],
 "blocked_path":"…/made.txt","tool_use_id":"toolu_01Q6…"}}
```

This answer on stdin ran the tool, and `made.txt` appeared:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"753d160f-…",
 "response":{"behavior":"allow","updatedInput":<the request's input>}}}
```

`{"behavior":"deny","message":"…"}` refused it. The tool result then came back with
`"is_error": true` and the message as its content, and the turn still ended `success`. The process
exits 0 once stdin closes after `result`. **So decision 2 holds as written**: one `claude -p` per
turn, `--resume` between turns, and the answer on the same process's stdin.

**`--permission-prompts host` without `--permission-prompt-tool stdio` denied every tool** in the
row's first probe the same day. Do not use it.

## What a turn prints

**Verified**, in order, for one Bash call and a one-word reply:

| Line | What the bridge does with it |
| --- | --- |
| `system` / `hook_*` | ignored. These carry the host's own hook output, so they are dropped from the recordings |
| `system` / `init` | `turn.started` |
| `stream_event` / `message_start` | keeps the message id, so deltas group as `<id>:<index>` |
| `stream_event` / `content_block_delta` / `text_delta` | `content.delta`, `assistant_text` |
| `stream_event` / `content_block_delta` / `thinking_delta` | `content.delta`, `reasoning_text`. On `haiku` every thinking delta was empty, so an empty one is dropped |
| `assistant` with a `tool_use` block | `item.started`, typed from the tool name, titled from its input |
| `control_request` / `can_use_tool` | `request.opened` |
| `user` with a `tool_result` block | `item.completed`, `failed` when `is_error` |
| `result` | `thread.token-usage.updated`, then `turn.completed`, then stdin closes |

The `assistant` lines repeat the text the deltas already carried, so their text blocks are ignored.
The context figure is the last `assistant` message's `usage` (input, both cache counts and output),
and the window is `modelUsage.<model>.contextWindow` in `result` (200,000 on `haiku`).

## Stopping a turn

**Verified.** This line on stdin, followed by closing stdin, stopped a turn that was counting to 200:

```json
{"type":"control_request","request_id":"yantra-interrupt","request":{"subtype":"interrupt"}}
```

`claude` answered `{"type":"control_response","response":{"subtype":"success","request_id":"yantra-interrupt",…}}`,
then a `result` with `"subtype":"error_during_execution"`, `"is_error":true` and
`"terminal_reason":"aborted_streaming"`, and exited 1. In the podman fixture no `claude` process
was left after it. Killing only the local `ssh` would not have done that (I-27).

## Two failures, and where their words are

**Verified.** With an empty `CLAUDE_CONFIG_DIR` there is no login. The turn prints a synthetic
`assistant` message and a `result` with `"is_error":true` and
`"result":"Not logged in · Please run /login"`, and exits 1. The bridge reports that sentence as the
failed turn's `message`. A turn that ends with no `result` at all, such as a `claude` that is not
installed, is reported with the end of its stderr and `ssh`'s own log.

**Verified, and a negative finding:** **claude's Bash tool refuses busybox `sh`.** In the Alpine
fixture, where the account's shell is `/bin/sh`, every Bash call failed with *"No suitable shell
found. Claude CLI requires a Posix shell environment."* Installing `bash` fixed it with the login
shell unchanged. A machine whose only shell is busybox will run chat turns but no Bash tool.

## Where the transcript lands, and `--resume`

**Verified.** A `-p` turn writes `~/.claude/projects/<cwd with every non-alphanumeric as ->/<session>.jsonl`,
the same place the TUI writes. In the fixture a second process started with `--resume <that stem>`
in the same worktree recalled a word the first turn was told. So the daemon keeps no session id: the
newest transcript under the thread's worktree is the conversation, and the bridge passes its stem.

## The fixture's claude

**Read.** The vendor's installer (`https://claude.ai/install.sh`) downloads
`https://downloads.claude.ai/claude-code-releases/<version>/<platform>/claude` and checks it against
`manifest.json` beside it. On a musl machine the platform is `linux-<arch>-musl`. For 2.1.291 the
manifest names these checksums, which the Containerfile pins:

| Platform | SHA-256 |
| --- | --- |
| `linux-x64-musl` | `e4b1fb39b56a6798063fa04912e838c01dd58dffeb238d6dcd31ad2d172e82c5` |
| `linux-arm64-musl` | `582811002a94033fb27f1a307ab893a32ebac827b4ea1b20f72eb778ccf834ab` |

The musl build also wants `ripgrep` installed and `USE_BUILTIN_RIPGREP=0`, as ADR-0028 §5's note
says for the TUI.

## Not answered here

- **macOS.** A turn over ssh on a Mac meets I-44: the login keychain is not readable from ssh's
  session, so the turn will fail *Not logged in*. Nothing here ran on a Mac.
- **A long-lived process for the whole thread.** `--input-format stream-json` would allow it. A
  turn per process was enough, so that upgrade is still not taken.

## Sources

All accessed 2026-10-06.

- Claude Code 2.1.291, run on this laptop and in the podman fixture, as described above. The
  scrubbed recordings are in [`crates/yantra-core/tests/recordings/`](../../crates/yantra-core/tests/recordings/).
- Anthropic, Claude Code installer — <https://claude.ai/install.sh> (download base, musl detection,
  manifest checksum check).
- Anthropic, release manifest for 2.1.291 —
  <https://downloads.claude.ai/claude-code-releases/2.1.291/manifest.json>.

The flags' documentation is R15's source, not re-read here.
