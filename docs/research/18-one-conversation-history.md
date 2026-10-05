# R18 — One conversation history on every device, for every agent

**Asked 2026-10-05 by the owner (Y-425, issue #374, parent #373).** A conversation that starts on one
machine must be readable from every device (laptop, phone and iPad through the dashboard) and must
resume on another machine. This note compares ways to get there. It does not pick one. The owner
picks in Y-426.

**Widened the same day.** The owner added three points. (1) History must be common to every agent
harness Yantra runs: Claude Code, Codex CLI, Gemini CLI, opencode, Grok Build and others. (2) The
aim is that agents use each other's history well, not only that a person can read it. The owner
suggested an Obsidian graph and left the design open. (3) Self-hosting on the owner's Pi or mini-PC
over Tailscale is welcome. **Budget for the history layer: up to 4 GB RAM in total on the box**, with
`yantrad` already running there. A candidate that needs more fails.

The first pass (sections 1 to 5, Claude Code only) is kept as written. Sections 6 to 10 are the
second pass.

Every claim says whether it was **verified** here, **read in code**, or only **documented**.
Claude Code changes weekly. Treat the findings as true for 2.1.289 and re-check them.

## Negative findings first

1. **Claude Code has no built-in sync of local conversations.** Nothing in the CLI copies a local
   transcript to another machine. `--teleport` pulls a *cloud* session into a terminal and is
   one-way: *"you can't push an existing terminal session to the cloud"*. `--resume` *"reopens a
   conversation from this machine's local history and doesn't list cloud sessions"*. `/export` writes
   plain text for a person to read, not a file `--resume` accepts. (Documented, §2.)
2. **Remote Control is not a history store, and it needs a login Yantra does not hold.** It keeps the
   session on the machine that runs it, needs a claude.ai subscription login (*"API keys are not
   supported"*), and goes offline when that process stops. While it runs, Anthropic stores the
   transcript. A conversation on a powered-off machine is not reachable through it. (Documented, §2.)
3. **A transcript copied into a second project directory on the same machine breaks `--resume <id>`.**
   With copies in two other projects the command printed `No conversation found with session ID`.
   The docs say so: a hand-copied duplicate *"makes Claude Code report not-found rather than resume
   an arbitrary copy"*. Any sync tool that puts one file in two slug directories on one machine
   breaks resume by id. (Verified, §3.)
4. **The transcript is not the whole conversation directory, and 64 % of the bytes are the part a
   resume does not need.** On this machine subagent transcripts take 399 MB against 242 MB for the
   main transcripts. A resume of a copied `<id>.jsonl` worked with no `tool-results/` file and no
   `file-history/`. (Verified for the main file; subagent files were not tested, §3.)
5. **Transcripts hold secrets, and the docs say so.** *"If a tool reads a `.env` file or a command
   prints a credential, that value is written to `projects/<project>/<session>.jsonl`"*, and the
   files are not encrypted. On this machine 17 of 1,309 transcript files hold a string shaped like a
   GitHub token. (Documented; the count is a pattern match, not a check that the tokens are live; §4.)
6. **Yantra's own `slug()` is wrong for a path over 200 characters.** Claude Code *"truncates the name
   to 200 characters and appends a hash of the full path"*. `crates/yantra-core/src/logs.rs` replaces
   non-alphanumerics and stops there. Nobody has hit it yet. Any option that computes a slug for the
   target machine must fix it first. (Read in code and documented; the hash was not reverse-engineered.)
7. **Syncthing does not merge two writers. It renames one.** Two machines that add a turn to one
   transcript while apart leave `<id>.sync-conflict-<date>-<time>-<device>.jsonl` beside `<id>.jsonl`.
   Each file lacks the other's turn, and the conflict name is not a session id. (Verified, §5.)
8. **Syncthing's encrypted mode would blind the appliance.** An *untrusted* peer stores encrypted
   data and never sees plaintext. A dashboard that reads transcripts on the appliance needs the
   appliance to be a trusted peer. (Documented, §5.)

9. **There is no shared transcript format today.** Every harness writes its
   own layout (section 6). OpenTelemetry GenAI conventions describe traces for dashboards, with
   message content opt-in and agent spans still evolving. Agent Trace (Cursor, Cognition, others)
   links code ranges to conversations and holds no transcript. Agent Client Protocol connects an
   editor to an agent. None of the three is a store of sessions. (Documented, section 7.)
10. **A harness resumes only its own format, and opencode has no session file to copy.**
    opencode keeps sessions as rows in SQLite, so a move needs `opencode export` and `opencode import`.
    Gemini, Grok and Claude Code key a session by the project directory, so a copy goes under the
    target's key. (Documented, read in code, and verified for Gemini listing, section 6.)
11. **`claude-sync` loses a turn when two machines write one conversation.** On a conflict it keeps the
    local file and saves the remote one as `.conflict.<time>`. The next push uploads the local file
    over the remote one. Machine A, which wrote first, then pulls it with no warning, over its own newer file.
    The turn survives only in a `.conflict` file on the second machine. (Verified, section 8.)
12. **`claude-code-sync` merges two writers, but a project map turned on late leaves two copies.**
    Both turns survived (smart merge). After the owner turns on `--map-project`, the old slug
    directory keeps its copy and the new one gets another. The same id then sits in two projects,
    which is the T5 failure. (Verified, section 8.)
13. **Both sync tools put plaintext secrets somewhere.** `claude-code-sync` writes plain JSONL into a
    git repository and has no redaction (a file-name denylist only). `claude-sync` encrypts on the
    client with age, so the server holds ciphertext, and every other machine holds plaintext.
    Neither redacts the transcript text. (Verified with a fake token, section 8.)
14. **The best cross-agent search tools read local files. Only some ship a server.** `ctx` and `cass`
    index many harnesses, and `cass` pulls other machines over ssh and rsync. `ctx` has a beta
    history server. I could not finish an upload to it in the time I had (section 8). (Verified in part.)
15. **No memory layer ingests coding-agent transcripts without an LLM call or an agent that
    writes.** Basic Memory is plain markdown that agents write. mem0, Graphiti and `claude-mem`
    extract with a model. Cognee can run with a local model. (Documented, section 8.)
16. **One licence needs reading before use.** `cass` is "MIT with an OpenAI/Anthropic rider": the
    rider withdraws the rights of OpenAI, Anthropic and their affiliates and agents. The owner is
    neither, but a tool that runs inside Claude Code may raise the question. GitHub reports the
    licence as NOASSERTION. (Read in the LICENSE file.)
17. **`cass` cannot index 650 MB of history in 4 GB.** Peak RSS was 5.86 GB, a 2 GB cap killed it,
    it has no MCP server, and its rider limits who may receive it. `ctx` fits. See section 11.

## 1. Where Claude Code keeps a conversation (2.1.289)

**Documented** ([sessions](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)):
`~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is the working directory with
every non-alphanumeric character replaced by `-`. Over 200 characters it is cut to 200 and a hash of
the full path is appended. `CLAUDE_CONFIG_DIR` moves the whole tree. `CLAUDE_CODE_PROJECT_DIR_NAME`
(2.1.234 and later, needs `CLAUDE_CONFIG_DIR`) fixes `<project>` to a name you choose. Retention is
`cleanupPeriodDays`, default 30.

**Verified.** `/tmp/r18-repo` became `-tmp-r18-repo`. The file holds one JSON object per line. The
field names seen in one trivial `claude -p` conversation are `type`, `uuid`, `parentUuid`,
`sessionId`, `cwd`, `timestamp`, `version`, `gitBranch`, `isSidechain`, `message` and `attachment`,
plus bookkeeping types (`queue-operation`, `last-prompt`, `cost-state`, `atis-latch`, `system`).
`cwd` is on every message record: 31 of 40 lines.

**One trivial conversation was 231 KB.** 91 % of it was `attachment` records. Context that Claude
Code injects (instruction files, the skill listing, hook output) goes into the transcript. So the
transcript also holds the owner's `CLAUDE.md` text and memory files. (Verified; sizes only.)

What lives beside the transcript, **documented** in
[the `.claude` directory](https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically):

| Path under `~/.claude` | Holds | A resume needs it? |
| --- | --- | --- |
| `projects/<project>/<session>.jsonl` | the conversation | **yes** (verified) |
| `projects/<project>/<session>/subagents/` | subagent transcripts | not tested |
| `projects/<project>/<session>/tool-results/` | large tool outputs spilled to files | **no** (verified: a copy without it resumed and answered from the transcript) |
| `projects/<project>/memory/` | auto memory, **per project directory** | no, but it does not follow a conversation to a different path |
| `file-history/<session>/` | pre-edit snapshots for rewind | no (rewind only; not tested) |
| `history.jsonl` | prompt recall, with the project path | no |
| `shell-snapshots/`, `session-env/` | per-process shell state | no (removed on clean exit) |
| `todos/` | legacy, not written | no |
| `~/.claude.json` | OAuth, trust per directory, MCP servers | no. It is per machine. A new directory asks for trust again (ADR-0011, I-49). |

Resume also restores the model, permission mode and an active goal from the transcript. It does
**not** restore `--mcp-config`, `--settings`, `--plugin-dir`, `--add-dir` (documented).

## 2. Does Claude Code already solve this?

**No.** Four features look close. None fits.

| Feature | What it does | Why it is not the answer |
| --- | --- | --- |
| `claude --cloud` / `--teleport` | runs a session on Anthropic's VM; pulls one into a terminal | one-way, GitHub-based, claude.ai login, not for ZDR orgs. A local conversation cannot go up. (Documented.) |
| Remote Control (`claude remote-control`, `--remote-control`) | a phone or browser steers a session that runs on your machine | the process must stay running; subscription login only; Anthropic stores the transcript while connected; ZDR orgs cannot use it. (Documented.) |
| `/export` | plain-text file for a person | `--resume` cannot read it. (Documented.) |
| `SessionEnd` hook with `transcript_path` | hands a script the path of the finished transcript | a trigger, not a store. It is the cheapest way to start a copy. (Documented; not built.) |

`claude --help` on 2.1.289 lists `--cloud`, `--teleport`, `--remote-control`, `--resume`,
`--fork-session`, `--session-id` and no export or sync flag. (Verified.)

## 3. What a resume on another machine needs

All tests ran on this machine with a throwaway repo and `--model haiku`. The throwaway conversation
holds the word PINEAPPLE. Each test asked Claude to repeat it.

| # | Setup | Result |
| --- | --- | --- |
| T1 | `claude -p --resume <id>` from a different directory, no copy | **resumed**. New records carry the new `cwd`. Claude Code appended to the file in the original project directory. |
| T2 | only a copy, placed under the **new** directory's slug, `cwd` fields untouched | **resumed**. Nothing was rewritten. |
| T3 | the original directory deleted, so the recorded `cwd` does not exist; copy under the new slug; `claude --continue -p` | **resumed**. A stale `cwd` is harmless. |
| T4 | one copy under an unrelated slug, resume by id from a third directory | **resumed**. Claude Code found it by id across projects. |
| T5 | copies under **two** unrelated slugs, resume by id from a third directory | **`No conversation found with session ID`**. |
| T6 | `--resume <absolute path to the .jsonl>` | **resumed**. |
| T7 | `--resume <id> --fork-session` | new `<new-id>.jsonl` in the current directory's slug. The original is unchanged. The fork repeats every message `uuid` of the original (57 of 57 shared) and rewrites `sessionId`. |
| T8 | a conversation with a spilled `tool-results/` file; copy only the `.jsonl` | **resumed**. Claude read the earlier tool output from the transcript. |

What follows:

- **The `cwd` fields and the slug directory need no rewrite for resume to work.** Claude Code finds
  an id in any project (since 2.1.223, documented; T1, T4). Put the file under the *target*
  repo's slug anyway. Then `--continue` and the picker see it (T3), and `logs`
  (`crates/yantra-core/src/logs.rs`, which opens `$HOME/.claude/projects/<slug>/<id>.jsonl` by name) finds it.
- **The id must exist in exactly one other project, or in the current one.** T5 is the failure.
- **`--fork-session` matters for sync, not for resume.** Without it Claude Code appends to the copy
  and the two files drift. With it the original stays a prefix of the fork (ADR-0015 already
  chooses this). Shared `uuid` values let a history view group a conversation's forks.
- **`claude -p` conversations, which the Chat tab creates (ADR-0026), are not in the picker.** The
  docs hide `-p` and SDK sessions from `/resume` and `--continue`. Only `--resume <id>` reaches
  them, and `--continue` does with `-p`. (Documented.)
- **The QA VM stopped at the login.** I installed Claude Code 2.1.289 in `~/r18/home` on the Debian
  VM and put a stripped copy of the transcript under the slug of `/home/qa/...`. With a real id,
  `claude -p --resume` printed `Not logged in · Please run /login`. With an id that does not exist
  it printed `No conversation found`. So the lookup runs first and the login stops the real
  resume. **A full resume on the VM is not verified.** Resume with the model call was verified on
  this machine only.
- **Auto memory does not follow.** It lives at `projects/<slug>/memory/`. A different path starts
  with an empty memory. (Verified: each throwaway directory got its own `memory/`.)

## 4. What lands in a transcript

**Documented**: tool results, file contents Claude read, command output, and the text of every
injected instruction file. **Verified on the owner's laptop, as counts only**: of 1,309 `.jsonl`
files under `~/.claude/projects`, 17 match `gh[pousr]_[A-Za-z0-9]{30,}` and 15 match
`(API_KEY|TOKEN|SECRET|PASSWORD)=<8+ characters>`. None matched an Anthropic key, a private-key
header, a Tailscale auth key, an AWS key or a bearer header. Many of these files come from work on
Yantra itself, which writes about tokens, so some hits may be fixtures. Nobody checked them by eye,
on purpose.

The consequence is the same either way: **a transcript store is a store of whatever the agent saw.**
CLAUDE.md §B4 allows exactly two credentials in one file (ADR-0021, ADR-0023). A store of
transcripts is a third place, and a bigger one. A machine that receives a copy also receives the
secrets that were in it. The owner owns every machine, so that exposure is the owner's to accept.

## 5. The three options

### Size, measured on this laptop (30 days of use, 1,015 top-level transcripts)

| What | Count | Bytes |
| --- | --- | --- |
| main transcripts, all projects | 1,015 | 242 MB |
| median / p90 / p99 / largest transcript | | 58 KB / 245 KB / 2.5 MB / 29.6 MB |
| transcripts over 1 MB | 19 | 142 MB (59 % of the bytes) |
| subagent transcripts | | 399 MB |
| spilled tool results | 29 files | 11 MB |
| the 17 transcripts of the Yantra repo | 17 | 96 MB |
| `file-history/` | | 5.8 MB |

981 of the 1,015 belong to an observer tool, not to a person's conversations. The 30-day retention
holds the total near 650 MB per heavy machine. A Pi's SD card carries that, but five machines
together reach 3 GB. Syncthing or a store would carry the 399 MB of subagent files unless told to
skip them (`.stignore`). Nothing here needs them.

### Reading cost over ssh, measured on the QA VM through a `ControlMaster` connection

A round trip with the connection open: 18 ms. A 340 KB file: 0.10 s each way. A 28 MB file: 1.0 s
up, 2.2 s down. This is the VM's user-mode network on the same host, not a WAN. It shows the
bound from the ssh side: the cost grows with the file, not with the number of messages. `logs`
already reads this way (`grep` over ssh, `crates/yantra-core/src/logs.rs`).

### A. A store on the appliance

Each machine sends its transcripts to the appliance. A `SessionEnd` hook, or the daemon over ssh,
would do the sending. The dashboard reads the store. Resume copies a file from the store to the
target machine.

- **Secrets.** The appliance holds every transcript in plain text. §4 says what that is.
  ADR-0021 and ADR-0023 paid for one file with two credentials. This is a directory with
  everything. Encrypting at rest does not help, because the daemon must read it.
- **Offline machine.** The store keeps what arrived before the machine went away. It misses the
  turns since the last send. A hook that fires at session end misses a crashed or running session.
- **Slugs.** Key the store by machine and slug. Compute the target slug at resume. Fix the
  200-character case first.
- **Two writers.** Safe if every resume forks (ADR-0015) and the store keeps one file per id.
- **Disk.** The appliance carries every machine's total, 3 GB on five heavy machines, on an SD
  card (R6 calls that card the durability risk).
- **Rules.** It **breaks Y-044's "the daemon persists nothing"** and needs an ADR that amends it
  (that is Y-426). It builds a sync service, which §B2 says to orchestrate and not to reinvent.

### B. Peer-to-peer sync with Syncthing

Syncthing runs on each machine and syncs `~/.claude/projects`. I ran it between this laptop and
the QA VM, with a scratch folder and synthetic JSONL files. Nothing touched `~/.claude`.

- **Verified.** A file written on the laptop reached the VM within about 16 s on the first scan.
  Two writers apart from each other produced a `.sync-conflict-` file on both sides (Negative
  finding 7). The turn from the VM sits in the conflict file. The main file holds the laptop's turn.
- **Secrets.** Every peer holds every transcript, plain text. Traffic is encrypted and peers are
  paired by device id. The *untrusted device* mode encrypts file names and contents for a peer that
  must not read them (documented, beta). That peer cannot serve the dashboard (Negative finding 8).
- **Offline machine.** Best of the three: the file arrives when the peer returns. The dashboard
  sees a machine's history only if the appliance is a peer that has it.
- **Slugs.** The folder syncs slug directories by name. A repo at `/home/x/repo` on Linux and
  `/Users/x/repo` on a Mac gives two slugs. The copy sits under the *wrong* slug on the other
  machine and `--continue` does not see it, but `--resume <id>` does (T4). A conflict arises
  only when one slug exists on both machines. Auto memory syncs and collides the same way.
- **Two writers.** The conflict file is the cost. A conflict file is a session-shaped file with no
  valid id. The picker may list it; I did not test that.
- **Deletion.** Syncthing syncs deletions (documented). When one machine's 30-day sweep removes a
  transcript, the removal reaches the others. Not tested.
- **Disk.** Every machine carries the whole set, unless `.stignore` drops `subagents/`.
- **Rules.** It adds a second daemon to every machine, including a Mac. ADR-0028 limits what Yantra
  installs to the bare minimum. A person installs Syncthing and pairs the devices. Yantra writes
  nothing. Y-044 stays true: the daemon reads files on its own disk. §B2 is met, because Syncthing
  is an existing tool. Other tools fit the same shape and add nothing new here: `unison` and `rsync`
  on a timer (one-way, no conflict handling), a git repository (a commit per turn, wrong tool),
  `rclone` or `restic` to a cloud bucket (a store again, with a third party holding the secrets).
  I did not test them.

### C. Read on demand over ssh, and copy at resume time

Nothing is stored. The dashboard asks each online machine for its conversation list and reads one
transcript when a person opens it. Resume streams `<id>.jsonl` from the source machine to the
target machine's slug directory over the multiplexed connection (I-20), then runs
`claude --resume <id> --fork-session`.

- **Verified.** The copy-and-resume half works with the file alone (T2 to T8). The read half is what
  `logs` does today. Cost: 18 ms a round trip and 2.2 s for 28 MB (above).
- **Secrets.** No new place at rest. The target machine gains a copy of the one conversation it
  resumes. Same owner, same tailnet.
- **Offline machine.** The weak point. A machine that is off has no readable history, and you
  cannot resume *from* it. That is the case "I left the laptop at home" produces. A conversation is
  readable only while its machine is up. Option B has no such gap.
- **Slugs.** Computed at copy time from the target repo path, so no mismatch. Needs the 200-character fix.
- **Two writers.** None by construction: the fork is a new id on the target machine.
- **Disk.** One extra copy per resumed conversation. The fork copies the earlier turns (ADR-0015).
- **Rules.** It meets §B2 (ssh and files), §B4 and Y-044 with no amendment. The code is small: a
  list verb, a read verb, a copy verb.
- **Cost.** A list over many machines is a fan-out of ssh calls. One slow or dead machine must time
  out without stalling the rest.

### Side by side

| | A. appliance store | B. Syncthing | C. read on demand + copy |
| --- | --- | --- | --- |
| New place holding plaintext secrets | the appliance, all transcripts | every machine, all transcripts | none at rest |
| Machine offline | history up to the last send | history up to the last sync, once synced | **not readable, not resumable from** |
| Path slugs | key by machine; fix the 200-char slug | wrong slug on a different path; `--resume <id>` still works | computed at copy time |
| Two machines write one conversation | safe if every resume forks | **conflict file** (verified) | cannot happen (fork = new id) |
| Disk | all machines, on an SD card | all machines, each | one copy per resume |
| Y-044 (daemon persists nothing) | **amended** | stays true | stays true |
| §B2 orchestrate, do not reinvent | builds a sync service | uses one | uses ssh and files |
| New thing to install | hook or daemon code | Syncthing on every machine | none |
| Verified here | no | yes, laptop and VM | yes for copy and resume; read is shipping |

## 6. The other harnesses

Versions: Codex CLI 0.160.0, Gemini CLI 0.62.0, opencode 1.18.34 (installed with `npm i` in a scratch
directory; nobody logged in). Grok Build is read from its docs, because I did not install it.
"Verified" below means I ran the command on a synthetic session.

| | Claude Code 2.1.289 | Codex CLI 0.160.0 | Gemini CLI 0.62.0 | opencode 1.18.34 | Grok Build |
| --- | --- | --- | --- | --- | --- |
| Where | `~/.claude/projects/<slug>/<id>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl` | `~/.gemini/tmp/<slug>/chats/session-<time>-<short>.jsonl` | `~/.local/share/opencode/opencode.db` (SQLite) | `~/.grok/sessions/<encoded-cwd>/<uuidv7>/` |
| Format | JSONL, one record a line | JSONL, plus an SQLite index rebuilt from the files | JSONL: a header line (`sessionId`, `projectHash`, `startTime`), then messages | tables `session`, `message`, `part` (JSON columns) | `summary.json`, `updates.jsonl` (the authoritative log), `chat_history.jsonl`, more |
| Keyed by | project path, slug of non-alphanumerics | date; the `cwd` is inside the file | project path, through a registry `~/.gemini/projects.json` (path to short slug) | project id in the database | working directory, percent-encoded in the directory name (over 255 bytes: hash slug and a `.cwd` file) |
| Resume | `--resume <id>`, `--continue`, `--fork-session` | `codex resume [ID or name] [--last] [--all]` | `--resume latest\|<index>`, `--list-sessions`, `--session-file <json>`, `--session-id` | `--session/-s <id>`, `--continue/-c`, `--fork` | `grok --resume <id or title>`, `-c`, `/fork` |
| Portable copy | a copy resumes (R18 §3) | files copy; a default list filters by `cwd`, and `--all` lifts it (read in code; not run) | **a copy listed** under the target's slug (verified) | **no file.** `opencode export [id]` writes JSON, `opencode import <file or URL>` reads it | not tested; the key is the cwd, so a copy needs the target's encoded path |
| Built-in sync | none (R18 §2) | none found in the resume help | none found in `--help` | `--share` to a hosted URL, and `import` from it | none found in the docs |
| Subagents | `subagents/` files | child rollouts, linked in SQLite | `chats/<parent-id>/` directory | rows | `subagents/` directory |

What I verified for Gemini: a synthetic `session-*.jsonl` under `~/.gemini/tmp/proj/chats/` appeared in
`gemini --list-sessions` for that project. In a second directory the same command printed
`No previous sessions found`, and Gemini added `other` to `projects.json`. After I copied the file
into `tmp/other/chats/`, it listed with the **old** `projectHash` in its header and again after I
rewrote the hash. So the header hash does not gate the list, and the slug comes from the target's
registry. I did not run a model turn, so a full resume is not verified. The command needs
`GEMINI_API_KEY` set to any value even for `--list-sessions`; it makes no call.

What the source says (read in code):

- **Codex.** `codex-rs/rollout/src/recorder.rs` lists by walking the files and then repairs its
  SQLite index from them (`reconcile_rollout`). A copied rollout is found without a database edit.
  A revert writes `rollout-<time>-<id>_<rollout_id>.jsonl`, so a thread can have several files.
- **Gemini.** `Storage.getProjectIdentifier()` asks a `ProjectRegistry` for a short slug; the old
  `sha256(projectRoot)` directories migrate to it. `chatRecordingService.ts` appends one JSON line
  a turn with `appendFileSync`, and a legacy `.json` file converts to `.jsonl`. Retention is not documented in the page I read.
- **opencode.** `import` accepts `{ info, messages: [{ info, parts }] }`. `export --sanitize`
  redacts "sensitive transcript/file data". Another tool's issue
  (compoundingtech/smalltalk #894) reports that a path remap (`/Users/…` to `/home/…`) is not
  defined when moving a session between hosts; that is about that tool, not opencode's own import.
  I did not run an import.

**Common shape.** Four of the five write append-only JSONL (opencode uses SQLite). Claude Code,
Gemini, Grok and opencode key a session by the project in some form, and Codex records the `cwd` inside
the file. Every harness has a resume flag that takes an id. That is enough for a Yantra seam:
*list sessions*, *read one*, *place one under the target's key*. It is a per-harness adapter, not
one format. Do not plan on one raw format.

## 7. Existing projects, and the standards that are not there

Stars and last push come from `gh` on 2026-10-05.

### Layer 1 tools: sync raw sessions for resume

| Project | Stars | Last push | Licence | Harnesses | Backend |
| --- | --- | --- | --- | --- | --- |
| tawanorg/claude-sync | 288 | 2026-07-26 | none stated | Claude Code only | R2, S3, GCS, S3-compatible (MinIO), WebDAV; age encryption on the client |
| perfectra1n/claude-code-sync | 99 | 2026-09-24 | MIT | Claude Code only | a git repository (any remote, optional LFS), Rust |
| osen77/cc-session | 0 | 2026-09-19 | MIT | search over Claude Code, Codex, OMP; **sync only Claude Code** (its README) | not checked |
| ConfabulousDev/confab (+ confab-web) | 8 (web: 15) | 2026-09-12 | MIT | Claude Code, Codex, OpenCode, Cursor | its own backend, self-hosted; **redacts secrets before upload** |
| Syncthing, rclone, restic, unison | | | | any | the first pass (R18 §5) |

### Layer 2 tools: search or read history across agents

| Project | Stars | Last push | Licence | Harnesses | Notes |
| --- | --- | --- | --- | --- | --- |
| ctxrs/ctx | 1,149 | 2026-10-02 | Apache-2.0 | Claude Code, Codex, Cursor, Pi, Gemini CLI, OpenCode, more (provider list in its docs) | Rust, Tantivy index, no hooks, MCP and skill, **beta history server** (SQLite and files, loopback or HTTPS, invitations), linux aarch64 build. No redaction: its README says transcript text is kept as it is. |
| Dicklesworthstone/coding_agent_session_search (`cass`) | 1,159 | 2026-10-05 | MIT + a rider (finding 16) | 30 or more, incl. Codex, Claude Code, Gemini, OpenCode, Grok Build | Rust, SQLite, Tantivy; **`cass sources setup` pulls other machines over ssh and rsync, with Tailscale discovery**; semantic model opt-in (about 90 MB) |
| nicknisi/sessions | 37 | 2026-09-15 | MIT | Claude Code, Codex, Pi, OpenCode | MCP, optional Ollama embeddings; local |
| Pratiyush/llm-wiki | 394 | 2026-06-18 | MIT | Claude Code, Codex, Copilot, Cursor, Gemini CLI | Karpathy's LLM-wiki pattern: a markdown and HTML wiki with `llms.txt`, JSON-LD graph and an Obsidian mode; LLM summaries need Ollama or an API |
| es617/claude-replay | 840 | 2026-09-18 | MIT | Claude Code, Cursor, Codex, Gemini, OpenCode, Kimi, Hermes | converts a session to a shareable HTML replay, with secret redaction |
| jazzyalex/agent-sessions | 890 | 2026-10-02 | MIT | several | macOS app |
| jhlee0409/claude-code-history-viewer | 2,222 | 2026-10-05 | MIT | Claude Code first | desktop viewer |
| raine/claude-history, nilbuild/claude-run, kunwar-shah/claudex | 498, 672, 95 | 2026-09-20, 2026-02-23, 2026-06-20 | MIT | Claude Code only | viewers; `claudex` adds MCP and FTS5 |
| MikeK184/Recollect | 40 | 2026-10-02 | Apache-2.0 | Claude Code, Codex (MCP) | Postgres, Neo4j, UI and worker in Compose: too heavy for the budget |

### Shared memory layers (MCP)

| Project | Stars | Last push | Licence | Multi-agent | Storage | LLM call to write? | Fits 4 GB on a Pi 5? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| basicmachines-co/basic-memory | 4,100 | 2026-10-02 | AGPL-3.0 | any MCP client (Claude, Codex, Cursor, others) | **plain markdown files**, Obsidian-compatible, with an index database; HTTP transport and Docker for self-hosting | no; the agent writes the notes | Probably (Python, SQLite). I did not measure it. |
| thedotmack/claude-mem | 96,487 | 2026-10-05 | Apache-2.0 | installers for Claude Code, Codex, OpenCode, Cursor and others; a setting shares observations across harnesses | SQLite and Chroma, one worker per machine, Bun | **yes**, an observer model per session (the owner already runs it) | per machine; not a shared server |
| mem0ai/mem0 (OpenMemory) | 66,598 | 2026-10-05 | Apache-2.0 | MCP | Qdrant and Postgres or SQLite | yes (OpenAI by default; Ollama possible) | stack is heavy; the vendor lists 1 GB RAM as the recommended floor for the app |
| getzep/graphiti | 31,450 | 2026-10-05 | Apache-2.0 | a framework | Neo4j, FalkorDB or Neptune (Kuzu is deprecated) | yes, on every episode | **No.** Neo4j lists 2 GB as the personal minimum and wants more; FalkorDB lists 4 GB |
| topoteretes/cognee | 31,385 | 2026-10-05 | Apache-2.0 | MCP and plugins | local SQLite, vector and graph stores | no with the local GLiNER model; yes with a hosted one | possible, models download on first use; not measured |
| letta-ai/letta | 25,027 | 2026-09-10 | Apache-2.0 | an agent platform, not a store for other agents | Postgres | yes | not a fit for this job |

The "LLM call" column matters for cost. The owner pays per call, so a layer that summarises every
turn adds a bill that grows with use. `ctx`, `cass` and `nicknisi/sessions` search the raw record and
need no model call to index.

### Standards

- **OpenTelemetry GenAI semantic conventions** name spans and attributes (`gen_ai.*`) for model
  calls, tool calls and agent invocations. Content is opt-in. Agent conventions are still in
  development. They fit a dashboard of cost and latency, not a store of readable sessions.
- **Agent Trace** (Cursor, with Cognition, Cloudflare, Vercel, Amp, OpenCode and others) is a draft
  that maps code ranges to the conversation that made them. It holds no transcript.
- **Agent Client Protocol** (`agentclientprotocol/agent-client-protocol`, 4,373 stars) connects an
  editor to an agent. It is not a history format.
- **AGENTS.md** is an instruction file. It holds no history.

I found no shared transcript format. The tools above each write their own adapter per harness, which
is the same approach section 6 ends on.

## 8. Options D and E, and what I tested

### What I ran, on the laptop and the QA VM

Synthetic JSONL only: a three-line session with a fake `ghp_` token, one per test. Two "machines"
were two `HOME` directories, one on the laptop and one on the VM, with a different absolute project
path on each (`.../work/app` against `.../projects/app`). The server ran on the VM, and an ssh
tunnel carried the port. Everything was removed afterwards. The only change left on the VM is that I
installed `git` with `apt` (the VM had none, and a bare repository over ssh needs it).

| Test | `claude-sync` 1.17.1 (WebDAV by `rclone serve webdav`) | `claude-code-sync` 0.4.0 (bare git repository over ssh) |
| --- | --- | --- |
| Push from A, pull on B | worked; B's slug used B's home | worked, but the file landed under **A's** slug (`-home-biswa-…`) |
| Different path, no map | the remote key is `${HOME}-work-app`, so B got `-home-qa-…-work-app`, and `cwd` fields were **rewritten** to B's home | same as above: a wrong slug, `cwd` not rewritten |
| Different path, with a map | `path_map: {~/work: WORK}` on A and `{~/projects: WORK}` on B put new sessions at `${WORK}-app` and in B's `projects/app` slug | `config --map-project app=<abs path>` on each side put new sessions under the project id `app`, and B's slug was right. `cwd` stayed A's (harmless, R18 T2). **The earlier copy stayed in the old slug**, so the id sat in two projects (finding 12) |
| Two writers | B pull: conflict. Local kept, remote saved as `s-0002.jsonl.conflict.<time>`. **B's push then replaced the remote. A's next pull replaced A's file.** One turn survives only in a `.conflict` file (finding 11) | `Smart merged … (3 local + 3 remote = 4 total, 1 branches)`. Both turns were in the file. The two user turns share a `parentUuid`, so they form two branches in one file; I did not run a resume on it |
| Server holds | `.jsonl.age` files and an encrypted manifest. `grep` for the fake token found none. | plain JSONL in git; `git grep` found the token in every file |
| Redaction | none | none |
| Server memory | `rclone serve webdav`: **72 to 74 MB RSS** with three objects | `git` over ssh: no daemon |
| Client | a 42 MB Go binary; setup is an interactive wizard (it needs a terminal; I drove it with a pty) | a 7 MB Rust binary; `init -l <dir> -r <url>`, then `push --push-remote`, `pull`; non-interactive |

`claude-sync` also claims a `migrate` for legacy keys and a `--scope sessions` mode (used here) that skips plugin caches.
`claude-code-sync` also syncs settings, skills and `history.jsonl` when enabled, and has a hard-coded never-sync list.

`ctx` 2.2.7: `ctx server init` and `ctx server run` ran on the VM and idled at **24 MB RSS**. A
laptop client connected through the tunnel with an invitation file (`ctx remote connect <url>
--enrollment-file <file>`), and local search found the synthetic Claude session. **I did not finish
an upload**: `ctx remote share` needs a registered provider profile root and a source digest, and
my second attempt still printed `no indexed source matches this selection`. Its docs say the
server needs an HTTPS reverse proxy for other machines. On a tailnet, `tailscale serve` can give
that. The Gemini file I made did not index, so I cannot say whether my synthetic header was short
of a field or ctx does not read this version.

### Option D. An existing sync tool with a self-hosted backend on the appliance

Run `claude-sync` against WebDAV or MinIO on the appliance (or `claude-code-sync` against a bare git
repository there), reached over Tailscale. It is option A built from a maintained part. The
appliance never reads plaintext with `claude-sync`, so the daemon cannot serve a history view from
it. With `claude-code-sync` the appliance holds plain JSONL, and a daemon could read it.

- **Resume.** Any machine pulls and resumes, as in R18 §3. Fork on resume (ADR-0015), because
  `claude-sync` can lose a turn and `claude-code-sync` merges into branches of one file.
- **Harnesses.** **Claude Code only.** Neither tool syncs Codex, Gemini, opencode or Grok. A second
  tool, or a generic one (Syncthing, restic, rclone, with each harness's directory), covers the rest.
  opencode needs an export step first.
- **RAM.** 72 MB for the WebDAV server, none for git. Well inside 4 GB.
- **Rules.** The daemon stays out of it, so Y-044 holds, provided Yantra does not write the
  store. A person installs the tool on each machine. ADR-0028 limits what Yantra installs.
- **Secrets.** See section 9.

### Option E. A shared, agent-neutral layer

Two kinds of thing could fill it. They answer different questions, and the owner may want both.

1. **A searchable record of the raw sessions of every harness** (`ctx` or `cass`). Agents ask it
   (MCP or a skill) "what did we decide about X", and get cited events from any harness. It needs
   no model call. `cass` can pull other machines over ssh and rsync, which is option C plus an
   index. `ctx` has a server for a shared index, still beta. RAM is small: 24 MB measured for the
   `ctx` server idle. An index over 650 MB of transcripts is larger; I did not build one on the VM.
2. **A curated knowledge vault** in markdown (Basic Memory, or the Karpathy pattern in `llm-wiki`).
   A person opens it in Obsidian and sees the graph. Agents read the files or call MCP tools. It
   holds *conclusions* (decisions, facts, links) and not transcripts. Something has to write
   it: the agent during the work, or an LLM pass over the raw record. That pass is the cost.
   The Obsidian graph view needs only `[[wikilinks]]` between notes, and Obsidian is a viewer for
   the same files. The agents do not need Obsidian running.

Raw search (1) is the cheaper and the more honest record. A vault (2) is smaller and easier to read,
and it can be wrong, stale or invented by the model. `ctx`'s own README makes that point against
summary memory.

### The two-layer split

It holds, with one change. **Layer 1 is per harness and stays raw**, because a harness resumes only
its own format (finding 10). **Layer 2 is built from layer 1, not instead of it.** The change: layer
2 has two parts (search over raw, and a curated vault), and only the first has a ready tool for
every harness. Nothing ready makes layer 1 span harnesses; the closest is a file sync (Syncthing)
of each harness directory, and opencode needs `export`.

## 9. Secrets, by option

CLAUDE.md §B4 says never store secrets, with two named exceptions. It speaks of credentials the
daemon holds. A transcript store is a different thing: it holds what an agent *saw*. Section 4
counted 17 of 1,309 files with a token-shaped string.

| Option | Where plaintext sits | Encrypted at rest | Redaction | What §B4 would need |
| --- | --- | --- | --- | --- |
| A. a store the daemon writes | the appliance | no (the daemon must read it) | none unless built | an ADR beside 0021 and 0023, and amend Y-044 |
| B. Syncthing | every machine | no (untrusted mode hides content from the appliance, which then cannot read it) | none | a statement that peers hold plaintext |
| C. read over ssh, copy at resume | none at rest | n/a | n/a | nothing |
| D1. `claude-sync` | every machine; **not** the server | yes, age, key from a passphrase on each machine | none | the key is a new secret on every machine; a passphrase is a human secret, and §B4 says references only |
| D2. `claude-code-sync` | every machine **and** the server (plain git) | no | none | as option A, for the appliance |
| E1. `ctx`, `cass` | the index on each machine, and on the `ctx` server | no (`ctx` says to use encrypted storage) | none (`ctx` keeps text as is) | as option A if the server holds it |
| E2. a vault | the vault; model-written notes can copy a secret out of a transcript | no | none, but `<private>` tags exist in `claude-mem` | as option A |
| `confab` | its backend | not stated | **yes, before upload**, built-in patterns | the best fit of the sync tools on this point; it needs its own backend, which I did not size |
| `opencode export --sanitize`, `claude-replay` | the output | no | **yes**, on export | n/a |

Two further facts. First, only `confab`, `claude-replay` and `opencode export --sanitize` redact.
Second, a redacting step belongs *before* the copy, and a pattern list will miss some secrets.
The owner owns every machine and the tailnet; whether a plaintext copy on the appliance is
acceptable is the owner's call, as with ADR-0021.

## 10. What this means for the decision (Y-426)

This is the evidence and a lean. It is not the pick.

### Comparison

| | A. store written by yantrad | B. Syncthing | C. read on demand + copy | D. `claude-sync` or `claude-code-sync` on the appliance | E. shared layer (search, vault) |
| --- | --- | --- | --- | --- | --- |
| Job it does | raw sessions, resume | raw sessions, resume | raw sessions, read, resume | raw sessions, resume | **agents read each other's history** |
| Harnesses | built per harness | all (it copies files; opencode needs export) | built per harness | **Claude Code only** | `ctx`, `cass`: 5 or more ready |
| Machine off | up to last send | up to last sync | **gap** | up to last push | up to last index or push |
| Plaintext secrets | appliance | every machine | none at rest | server (git) or none (`claude-sync`) | the index host |
| Two writers | safe if every resume forks | conflict file | cannot happen | **turn lost** (`claude-sync`) or merged branches (`claude-code-sync`) | read only |
| RAM on the box | disk only | none on the box if it is a peer | none | 72 MB or none | 24 MB idle (`ctx` server); index not measured |
| Y-044 | amended | holds | holds | holds if people run it | holds if the tool runs the index |
| §B2 | builds sync | uses a tool | ssh and files | uses a tool | uses a tool |
| New thing to install | code | Syncthing everywhere | none | tool everywhere | tool, plus MCP config per harness |
| Verified here | no | yes | yes | yes, both tools | partly (`ctx` server up; upload not finished) |

### Evidence in short

- **Raw resume and a shared reading layer are two jobs.** Option C, B or D does the first. Option E
  does the second. They do not compete, and E1 can sit on top of any of them.
- **No tool syncs the raw sessions of every harness.** The Claude-only sync tools are good for Claude
  Code. For the others, Syncthing or per-harness adapters are the options. Plan on per-harness.
- **E1 is the best match for "agents use each other's history".** `ctx` and `cass` together already
  read Claude Code, Codex, Gemini, OpenCode and Grok Build (`ctx` lists Cursor and Pi too; `cass` lists Grok Build), with no model call, over MCP or a skill.
  `cass` already reaches other machines over ssh on a tailnet. Both cost little RAM.
- **E2 (an Obsidian-style vault) is for people, and a curated layer.** It costs an LLM pass. It
  adds value only if somebody keeps it correct.
- **Redaction is rare.** Plan it as its own step, not as a feature to expect.
- **The first-pass facts still hold.** Fork on every resume. Fix `slug()` for paths over 200
  characters before any option computes a slug for a machine.

### A lean for the owner to accept or reject

1. **Raw layer: start with C** (it costs the least and breaks no rule), **and let the owner add
   Syncthing later** for the machines that must be readable while off. This is the first pass's lean, and the new
   evidence leaves it standing. D adds a tool that covers one harness and, for `claude-sync`, can lose a turn.
2. **Shared layer: try `ctx` or `cass` as the search layer, local on each machine first**, and
   connect the appliance second (`cass sources` over ssh needs no server; the `ctx` server is beta). Read the `cass`
   licence rider before you adopt it. Add a vault (Basic Memory) only if the owner wants a
   readable graph and accepts the model cost.
3. **Do not build a store in `yantrad`** (option A) while `ctx` or `cass` does the job.

### Open points the owner must decide

- Is a plaintext index of every transcript on the appliance acceptable (Q22 and an ADR beside 0021)?
- Is the history for people, for agents, or for both? E1 serves agents. E2 serves people.
- Does the owner accept an LLM bill for a vault?

## 11. Trial of `cass` and `ctx`, and the hub decision

**Added 2026-10-05 (Y-425, second request from the owner).** The owner asked for a short trial of
`cass`, and for a weighed choice between three whole designs. The owner also likes the idea of
keeping every conversation on the appliance and continuing it on any machine. All trials ran on this
laptop (CachyOS, x86-64, 12 cores, 15 GB RAM) and the QA VM, with the release binaries `cass` 0.10.0
and `ctx` 2.2.7, `gitleaks` 8.30.1. **Nothing ran on arm64.** The note holds no transcript text:
only counts, timings and yes/no judgements.

### 11.1 The `cass` licence

The file says "MIT License (with OpenAI/Anthropic Rider)". The rider reads, in the parts that bind:

> "Restricted Parties" means OpenAI, L.L.C.; Anthropic, PBC; any of their respective Affiliates; and
> any person or entity acting directly or indirectly on behalf of, for the benefit of, or under the
> direction of any of the foregoing (including any officer, director, employee, contractor, agent,
> consultant, service provider, or representative). Notwithstanding any other provision of this
> License, no rights are granted to any Restricted Party. [...] You may not provide, disclose,
> distribute, sublicense, sell, lease, lend, host, make available, or otherwise permit access to the
> Software or any derivative work [...] to or for any Restricted Party.

It lists "executing, benchmarking, testing, analyzing, indexing" as uses. A breach ends the licence
at once. Anyone who distributes the software must keep the rider unmodified. This is my reading and
not legal advice.

| Use | Permitted? |
| --- | --- |
| (a) The owner's personal use | **Yes**, as long as the owner is not an Anthropic or OpenAI employee, contractor or agent, and does not work for the benefit of one. Using Claude Code as a customer does not make the owner a Restricted Party. The trial went ahead on this reading. |
| (b) Yantra installs or recommends it | **Unclear for installing.** A recommendation that links to the upstream release is not a distribution. If Yantra downloads or bundles the binary, Yantra distributes it and must pass the rider on. Every Yantra user must then also be outside the Restricted Parties, and Yantra cannot check that. |
| (c) A commercial product built around it | **Only with a carve-out.** Selling is allowed in the MIT text. The rider bars any sale or access "to or for" Anthropic, OpenAI, their affiliates and their contractors. A product for the general public would have to exclude these customers. The wording "acting indirectly [...] for the benefit of" is broad and untested. Ask a lawyer before building on it. |

GitHub reports the licence as NOASSERTION, so licence scanners and many companies will block it.
`ctx` is Apache-2.0 and has no such term.

### 11.2 Measured results

Real history: 1,391 `.jsonl` files and 649 MB under `~/.claude/projects` (main and subagent files),
Claude Code only. This laptop has no Codex, Gemini or opencode history, so the harness count is **one
for both tools**. Both tools read the files in place and wrote nothing under `~/.claude`.

| | `cass` 0.10.0 | `ctx` 2.2.7 |
| --- | --- | --- |
| Install | one 94 MB binary from the release, checksum verified | one 198 MB binary, checksum verified |
| Index from scratch | **136 s** wall (`index --full`) | **103 s** (`import --provider claude`) |
| Sessions / events | 1,381 conversations, 51,431 messages | 1,398 sessions, 112,059 events |
| Peak RSS while indexing | **5.86 GB** | main process 47 MB; its **daemon peaked at 985 MB** |
| Index on disk | **1.69 GB**: database 632 MB, lexical index 465 MB, a raw mirror of the sources 637 MB | **2.1 GB** |
| Run again with no new files | 75 s, peak 1.43 GB (my own live session kept changing) | not measured |
| Resident when idle | `index --watch`: 708 MB after 45 s (peak 874 MB). **There is no server mode.** | daemon 216 MB; `ctx mcp serve` (stdio): 20 MB at start, 36 MB after queries, 82 MB peak |
| Search latency, 5 queries | 0.8 to 1.5 s a CLI call, 280 MB RSS a call | 1.0 to 1.3 s a CLI call, 90 MB RSS; MCP call 0.4 s |
| Result size, 5 hits | 1.4 KB (minimal), 2 KB (summary), 6 KB (full) | 12.6 KB from the CLI, 14 KB from MCP |
| Agent interface | CLI with `--robot-format`; **no MCP** (zero mentions in `capabilities`) | MCP over stdio, 16 tools; a skill |
| Cap test | killed under a 2 GB memory cap (no completion record, 1.1 GB left behind) | not run |

**Do not read the cass and ctx RSS figures as equal.** `cass` does the work in one process. `ctx`
hands it to a daemon that stays resident, so add the daemon.

**A 4 GB Pi cannot index 650 MB of history with `cass`.** The peak was 5.9 GB on a laptop, and a run
under `MemoryMax=2G` was killed. Incremental runs need 1.4 GB. These are x86-64 numbers and the
mirror and database may behave differently on arm64. **`ctx` fits**: 985 MB at its peak, about 250 MB
at rest with MCP. Neither number was measured on a Pi.

**Result quality, five queries over this repo's own history** (ControlMaster, build loop, virtual
microphone, podman OOM, Tailscale serve). I judged each by counting how often the query terms occur
in the session a result points to, not by reading the sessions.

| Query | `cass` top 5 | `ctx` top 5 |
| --- | --- | --- |
| ControlMaster | yes, 5 of 5 sessions use the word | yes, 5 of 5 |
| build loop | yes, 5 of 5 | partly: 2 of 5 use it often, 2 do not use the phrase |
| virtual microphone | yes, all 5 hits sit in one session that uses it | partly: 1 of 5 uses it often |
| podman OOM | partly: 1 of 5 holds the phrase | weak: 1 of 5 |
| Tailscale serve | yes, 5 of 5 | yes, 5 of 5 |

`cass` scored 4 yes and 1 partly. `ctx` scored 2 yes, 2 partly and 1 weak. `ctx` ranks by a session
importance score, which can favour a long session over a precise one. Both search subagent files as
well as main files, so most top hits are subagent transcripts. `ctx` returns snippets that a person
can read at once, and that costs about six times the bytes of the `cass` minimal form. I did not
compare answer quality when an agent reads them.

**Other findings.**
- **`ctx` sends usage analytics by default** to `https://cli.ctx.rs/functions/v1/analytics`. The
  queued payload holds the version, OS, CPU tier and memory bucket and no history. Turn it off with
  `CTX_ANALYTICS_ENABLED=false`. It also writes `~/.local/state/ctx` outside its data root, starts a
  daemon on first use (`CTX_DAEMON_OFF` stops it) and has an auto-upgrade (`CTX_UPGRADE_OFF`). Because
  I did not set the opt-out, some queued events may have gone out.
- **`cass` keeps a byte copy of every source file** (the raw mirror, 637 MB). So `cass` is also a
  store: a transcript that Claude Code deletes after 30 days stays in `cass`. This helps retention and
  adds a second plaintext copy of every secret.
- **`cass sources` works over ssh and rsync** (verified on the QA VM). It pulled a synthetic session
  with `rsync`, indexed it, and `cass search` returned it with `origin_host: qa@<host>`. It copies
  files to the machine that runs `cass`, so it is a pull-and-mirror and not a read on demand. It
  needs `rsync` on the remote (the VM had none; I installed it with `apt`). A remote that is off is
  skipped and the earlier copy stays. The host must be in `~/.ssh/config`: the `user@host` form accepts
  no port or key flag. I used a wrapper `ssh` earlier on `PATH` so that I did not touch the owner's
  file. The first sync took 7.5 s, most of it probing paths that do not exist, so list only the paths
  you need.
- The `ctx` server upload still did not finish in this pass (section 8 reports the earlier attempt).

### 11.3 Redaction

Test data: a synthetic Claude Code session with a fake `ghp_` token (`ghp_` plus 36 letters and
digits), a fake `API_TOKEN=<20 characters>` line and a fake `DATABASE_PASSWORD=<17 characters>` line.

| Check | `cass` | `ctx` |
| --- | --- | --- |
| Strips secrets while indexing | **No.** The byte mirror holds the token (1 of 29 files). | **No.** Search returned the token and the password text. |
| Serves the secret in a result | Yes for the `.env` password, with the default fields. The token body did not match as a search term. | Yes, token and password. |
| Redaction option | none found (`redact` appears only for support bundles) | none; the README says text is kept as it is |

**Scanners.** `gitleaks` 8.30.1 reads a file and writes a **report**. It does not rewrite the file.
`--redact` hides the value in its own log only. A redactor is a second step: take each `Secret` from
the JSON report and replace it in the file. I wrote that in 8 lines of Python.

| Step on a 31 MB synthetic JSONL (29,362 lines, 15 fake tokens) | Time on this laptop | Result |
| --- | --- | --- |
| `gitleaks detect --no-git` | 2.8 s, 70 MB RSS | 15 of 15 tokens found (`github-pat`) |
| rewrite with the findings | 0.2 s | no token left; the file still parses as JSON on every line |
| the same job with one `sed` line (`ghp_` shape and `KEY=value` shape) | 0.1 s | no token left |
| On the 3-line session | 0.6 s | found the token and the `API_TOKEN` line; **missed `DATABASE_PASSWORD=...`** |

So a scanner pass is cheap, and it **will miss secrets** that carry no known shape or entropy. A
Pi 5 will be slower than this laptop by an amount I did not measure. `trufflehog` was not tested; it
also reports and does not rewrite. Redaction fits "strip before it reaches the hub" only when it runs on
the source machine, and only on a staging copy: the live transcript must stay whole, or `--resume`
would resume a transcript with holes. It cannot make the hub safe. It makes a leak smaller.

### 11.4 The three designs

Design **H**: every machine pushes raw sessions to the appliance, redacted first, and the appliance
runs the search index and serves it over MCP. Design **M**: Syncthing among all machines, each
machine indexes locally. Design **C+S**: no store. Yantra copies a session over ssh at resume, and an
index tool reads other machines on demand.

For H the transport that fits best is **Syncthing**, with each machine's folder set to *send only*, the
appliance's folder set to *receive only*, and `ignoreDelete` on the appliance. Reasons, with the
evidence: Syncthing ran here at 16 s latency (section 5); `rclone` and `claude-code-sync` need a
trigger or a timer; `claude-sync` can lose a turn (finding 11) and covers one harness; a send-only
folder cannot take changes back from the appliance, so two writers cannot make a conflict file
(documented). `ignoreDelete` keeps a transcript on the appliance after Claude Code's 30-day sweep
removes it elsewhere. The docs call it an advanced setting that "should normally be set to `false`".
I did not test it, and it grows the appliance's disk without bound unless a person prunes.
For redaction the folder that Syncthing watches must be a **redacted staging copy** (11.3), so each
machine also keeps a second copy and runs one more job. Resume on machine X pulls from the hub: that
is a copy in the other direction, so the hub's folder must also reach X, and a send-only folder does
not do this. The plain fix is Yantra's own resume copy over ssh from the appliance (the C half). That
copy is of the *redacted* file.

| Criterion | **H. Pi as hub** (Syncthing send-only, redact, `ctx` on the Pi) | **M. Peer mesh** (Syncthing, local index each) | **C+S. No store** (copy at resume, index reads on demand) |
| --- | --- | --- | --- |
| Efficiency on the Pi | Disk: all machines' redacted history (about 650 MB a heavy machine, 30 days; more with `ignoreDelete`) plus a `ctx` index of about 2 GB per 650 MB. RAM: `ctx` daemon 216 MB at rest, 985 MB while indexing, MCP 36 MB. `cass` is out (5.9 GB peak). Network: each changed file once. | The Pi is one more peer or not involved. Every machine holds all history and its own index (2 GB each for 650 MB). Network: each file to every peer. | Nothing stored on the Pi. Each search by `cass sources` pulls the remote files by rsync, then indexes locally. Network spent at query time (1.0 s up and 2.2 s down for 28 MB, section 5). |
| Context handling | Best: one index of all machines and harnesses behind one MCP server. `ctx` gave 2 yes, 2 partly and 1 weak on five queries here; results are about 14 KB for five hits (about 3,500 tokens, my estimate). | Same tools, but each agent sees only what has synced to its machine, and each machine pays for an index. | Weakest: an index exists only where a tool pulled the files. Agents on a machine see the other machines only after a pull. |
| Memory and retention | A machine that is off still has its history on the Pi as of the last sync. `ignoreDelete` outlasts the 30-day cleanup. A crash before sync loses the tail. | A peer that returns catches up. Deletions sync, so the 30-day sweep spreads (documented, not tested) unless `ignoreDelete` is set on every peer. | A machine that is off is **not readable and not resumable from**. After `cass` has pulled once, its mirror keeps a copy beyond the 30 days. |
| Private data | The appliance holds every conversation, redacted by a pattern list that misses some secrets (11.3). The raw copy stays on the source machine. A stolen Pi leaks what the scanner missed. The index also holds it. | Every machine holds every unredacted transcript. | No new place at rest, except `cass`'s mirror on the machine that runs it. |
| Sync across devices | Latency about 16 s (section 5). **One writer per path, so no conflicts.** Needs a resume-pull path of its own (above). | Latency about 16 s. Two writers give a conflict file (verified). | None: a fork on resume is a new id (ADR-0015). |
| Budget and speed on a 4 GB Pi | Fits with `ctx`, with two caveats: peak 985 MB while indexing, and nothing was run on arm64. Needs `ctx` daemon and Syncthing on the Pi, and a job per machine for redaction. | Pi unaffected. | Pi unaffected. A search costs 0.8 to 1.5 s plus the pull. |
| Productisable | Weakest: every user must install Syncthing on every machine, pair devices, and run a redaction job. A user's Pi must have 4 GB free. A plaintext archive of other people's conversations sits on a box that Yantra owns, so §B4 and an ADR beside 0021 and 0023 are needed. | Medium: one tool, but a person pairs every device. | Strongest: no new daemon. Needs ssh and `rsync` (the second is new on many machines). Y-044 holds. |
| Licence | `ctx` Apache-2.0, Syncthing MPL-2.0, `gitleaks` MIT. | same | `cass` rider (11.1); `ctx` has no pull mode and no equal of `cass sources`. |
| Rules | Y-044 holds only if Syncthing and `ctx` do the storing and yantrad stays out. §B4 needs a statement about the plaintext archive. | Y-044 holds. | Holds, with no amendment. |

### 11.5 A lean

This is evidence, and Q22 (Y-426) is the owner's call.

1. **Keep C for resume.** It breaks no rule, works for any person's fleet and needs nothing new.
2. **For search, try `ctx` and not `cass` on the appliance.** `ctx` fits 4 GB, speaks MCP, and has a
   plain licence. `cass`'s indexing peak and its rider rule it out for the Pi and for a product. Turn
   off `ctx` analytics and auto-upgrade first.
3. **Treat H as the owner's personal setup, not as the product default.** H gives the best context
   handling and the best memory for a machine that is off. It costs the most to set up, keeps a
   plaintext archive on the Pi and needs a redaction job whose misses nobody sees. If the owner wants
   it, build it from Syncthing (send-only, `ignoreDelete`), a redacted staging folder and `ctx`, and
   keep yantrad out of the data path. Write the ADR for the archive first.
4. **M adds no benefit over H for one owner and costs more disk.** Drop it unless the owner has no
   always-on box.

The question the owner must answer is the one in section 10: is a redacted, plaintext history of
every machine on the appliance acceptable? If yes, H with `ctx` is the strongest design and fits the
budget on paper. If no, choose C+S with `ctx` on each machine that needs search.

### 11.6 Cleanup and what remains

I removed `~/r18e` on the laptop and on the VM, the `cass` and `ctx` indexes and binaries, and the
`ctx` state directory `~/.local/state/ctx`. I stopped every process that I started. **Left behind
on the VM:** `rsync` (installed with `apt` for the trial; the earlier pass left `git`) and a
`known_hosts` entry only on the laptop's removed scratch file. Left on the laptop: nothing known.

### 11.7 Not verified in this pass

- Any figure on arm64 or on a Pi.
- `ctx` and `cass` over real Codex, Gemini, opencode or Grok history. This laptop has only Claude Code.
- `ctx`'s history server upload and `ctx --server` reads; Syncthing's `ignoreDelete`; the receive-only
  folder with a resume path.
- `trufflehog`. Whether a redacted transcript still resumes under `claude --resume` (the JSON stays
  valid; I did not run a model turn).
- Whether the `ctx` analytics events left this laptop.

## Not verified

- A resume that completes on the QA VM (no Claude login there).
- macOS or Windows paths and the Mac's `/Users/...` slug.
- Whether a resume needs `subagents/` or `file-history/`.
- Whether the picker lists a Syncthing conflict file, and what a deletion sweep does across peers.
- A `SessionEnd` hook as a trigger.
- The hash Claude Code appends to a slug over 200 characters.
- A full resume (with a model call) for Codex, Gemini, opencode and Grok. Gemini was verified to list a copied file only.
- Grok Build and Codex were not run. Codex's rollout layout and `resume` flags come from `--help`, the source and docs.
- `opencode import` of a session on a second machine.
- An upload to the `ctx` history server, `cass sources` over ssh, Basic Memory, and RAM of any index built over real transcripts.
- A resume of a conversation file that `claude-code-sync` merged into two branches.
- Resident memory of Basic Memory, Cognee and `cass`. Only `rclone serve webdav` (72 to 74 MB) and `ctx server run` (24 MB, idle) were measured, both on the x86-64 VM; a Pi 5 is arm64 and I did not run there.

## Sources

Accessed 2026-10-05 unless noted.

- Claude Code, *Manage sessions* — <https://code.claude.com/docs/en/sessions>
- Claude Code, *Explore the .claude directory* — <https://code.claude.com/docs/en/claude-directory>
- Claude Code, *Use Claude Code in the cloud* — <https://code.claude.com/docs/en/claude-code-on-the-web>
- Claude Code, *Continue local sessions from any device with Remote Control* — <https://code.claude.com/docs/en/remote-control>
- Claude Code, *How Claude Code works* — <https://code.claude.com/docs/en/how-claude-code-works>
- Syncthing, *Understanding Synchronization* (conflicts) — <https://docs.syncthing.net/users/syncing.html>
- Syncthing, *Untrusted Devices* — <https://docs.syncthing.net/users/untrusted.html>
- Syncthing v2.1.5 release binary, GitHub releases — <https://github.com/syncthing/syncthing/releases>
- Local: Claude Code 2.1.289 on CachyOS and on the QA VM; `crates/yantra-core/src/logs.rs`;
  [ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md),
  [ADR-0015](../adr/0015-resume-forks-the-conversation.md),
  [ADR-0021](../adr/0021-the-relay-is-written-to-an-environment-file.md),
  [ADR-0023](../adr/0023-the-github-grant-lives-beside-the-relay.md),
  [ADR-0026](../adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md),
  [ADR-0028](../adr/0028-yantra-installs-the-bare-minimum-on-a-machine.md).
- Second pass, 2026-10-05: Codex CLI source, `codex-rs/rollout/src/recorder.rs` — <https://github.com/openai/codex>; `codex resume --help` on 0.160.0.
- Gemini CLI source, `packages/core/src/services/chatRecordingService.ts`, `config/storage.ts`, `utils/paths.ts`; *Session management* — <https://github.com/google-gemini/gemini-cli>; `gemini --help` on 0.62.0.
- opencode CLI docs — <https://opencode.ai/docs/cli/>; `packages/opencode/src/cli/cmd/import.ts` — <https://github.com/anomalyco/opencode>; `opencode export --help` on 1.18.34.
- Grok Build, *Sessions* user guide — <https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md>; <https://docs.x.ai/build/features/sessions>
- compoundingtech/smalltalk issue 894 (moving opencode sessions between hosts) — <https://github.com/compoundingtech/smalltalk/issues/894>
- tawanorg/claude-sync 1.17.1 README and release — <https://github.com/tawanorg/claude-sync>
- perfectra1n/claude-code-sync 0.4.0 — <https://github.com/perfectra1n/claude-code-sync>
- ConfabulousDev/confab — <https://github.com/ConfabulousDev/confab>; osen77/cc-session — <https://github.com/osen77/cc-session>
- ctxrs/ctx 2.2.7, `docs/hosted-history.md`, `docs/provider-support.md` — <https://github.com/ctxrs/ctx>
- Dicklesworthstone/coding_agent_session_search 0.10.0 README and LICENSE — <https://github.com/Dicklesworthstone/coding_agent_session_search>
- nicknisi/sessions, Pratiyush/llm-wiki, es617/claude-replay, MikeK184/Recollect, jazzyalex/agent-sessions READMEs on GitHub.
- Basic Memory — <https://github.com/basicmachines-co/basic-memory>, <https://docs.basicmemory.com/>
- claude-mem — <https://github.com/thedotmack/claude-mem>; mem0 self-hosting — <https://mem0.ai/blog/self-host-mem0-docker>; Graphiti — <https://github.com/getzep/graphiti>; Cognee — <https://github.com/topoteretes/cognee>; Letta — <https://github.com/letta-ai/letta>
- Neo4j, *System requirements* — <https://neo4j.com/docs/operations-manual/current/installation/requirements/>; FalkorDB configuration — <https://docs.falkordb.com/getting-started/configuration.html>
- Agent Trace — <https://agent-trace.dev/>, <https://www.infoq.com/news/2026/02/agent-trace-cursor/>; OpenTelemetry GenAI semantic conventions guides (Dash0, Uptrace); Agent Client Protocol — <https://github.com/agentclientprotocol/agent-client-protocol>
- Repository metadata (stars, last push, licence) by `gh repo view` and `gh api repos/<owner>/<name>` on 2026-10-05.
- Third pass, 2026-10-05: `cass` 0.10.0 LICENSE and release binary, `ctx` 2.2.7 release binary, `gitleaks` 8.30.1 release binary (GitHub releases); Syncthing folder types <https://docs.syncthing.net/users/foldertypes.html> and ignoreDelete <https://docs.syncthing.net/advanced/folder-ignoredelete.html>. Local trials only.
- Local tests, 2026-10-05: `rclone` 1.75.1 (`serve webdav`), `git` 2.47.3 on the QA VM; synthetic JSONL only.
