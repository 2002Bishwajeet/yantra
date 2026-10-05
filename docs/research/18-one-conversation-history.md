# R18 — One conversation history on every device

**Asked 2026-10-05 by the owner (Y-425, issue #374, parent #373).** A Claude Code conversation that
starts on one machine must be readable from every device (laptop, phone and iPad through the
dashboard) and must resume on another machine. This note compares three ways to get there. It does
not pick one. The owner picks in Y-426.

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

## 6. What this means for the decision (Y-426)

This is the evidence, not the pick.

- **C costs the least and breaks no rule.** Its price is one gap: a machine that is off.
- **B closes the gap and adds Syncthing everywhere.** It also copies every secret to every machine
  and gives a conflict file when two machines write at once.
- **A has no case that B or C lacks.** It adds a plaintext store to the appliance, amends Y-044 and
  reinvents sync.
- **A mix is possible.** C first, and B later for the owner who wants offline history. They do not
  conflict: B puts files where C already puts them.
- **Fork on every resume, whichever option wins.** It is what stops two machines writing one file,
  and ADR-0015 already does it.
- **Fix `slug()` for paths over 200 characters** before any option computes a slug for a machine.

## Not verified

- A resume that completes on the QA VM (no Claude login there).
- macOS or Windows paths and the Mac's `/Users/...` slug.
- Whether a resume needs `subagents/` or `file-history/`.
- Whether the picker lists a Syncthing conflict file, and what a deletion sweep does across peers.
- A `SessionEnd` hook as a trigger.
- The hash Claude Code appends to a slug over 200 characters.

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
