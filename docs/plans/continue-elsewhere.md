# Continue a session on another machine (Y-518)

- **Date:** 2026-10-19
- **Row:** [Y-518](../../tracker.md). Owner, 2026-10-19: *continue on the MacBook* or *continue on Linux*.
- **Scope changes, 2026-10-19, from the owner:**
  1. Continuing must **not** replay or resume the full transcript, because the old turns fill the new session's context. Continuing is a **handoff**: a short summary, plus the branch and the uncommitted work. The target machine starts a **fresh** session, and the summary is its first prompt.
  2. The raw transcript stays where it is, and in the appliance archive when the archive exists. This feature does not need it.
  3. The owner dropped at-rest encryption for the archive (ADR-0032 decision 4, Y-429). This plan does not use the archive, so that change does not touch it. Redaction stays.
- **Reads against:** [ADR-0015](../adr/0015-resume-forks-the-conversation.md), [ADR-0032](../adr/0032-the-appliance-keeps-the-conversation-history-encrypted.md), [ADR-0026](../adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md), [ADR-0033](../adr/0033-other-harnesses-speak-acp-and-claude-delegates.md), [ADR-0035](../adr/0035-a-chat-turn-outlives-its-ssh-pipe.md), [ADR-0009](../adr/0009-machine-names-are-ssh-destinations.md), [ADR-0023](../adr/0023-the-github-grant-lives-beside-the-relay.md), [R18](../research/18-one-conversation-history.md), [R20](../research/20-claude-stream-json-turn.md), [R21](../research/21-t3code-and-yantra.md), [the M16 plan](m16-the-coding-loop.md).

## 1. The design in one paragraph

The owner taps **Continue on MacBook** on a session page. On the source machine, `claude -p` reads the session's own conversation and writes a handoff of five headings: goal, decisions made, files touched, what is next, and open questions. The source machine then makes a WIP commit of the uncommitted work under a hidden ref and writes a `git bundle` of everything origin does not hold. `yantrad` streams that bundle from the source to the target over the two ssh connections it already has. It writes nothing to the appliance's disk. The target machine fetches the bundle, puts the branch and the uncommitted work into a fresh worktree or checkout, and starts a **new** session with the handoff as its first prompt. On the source machine nothing is deleted.

## 2. What must move, and how

| Thing | Moves? | How |
| --- | --- | --- |
| Conversation transcript (Claude JSONL under `~/.claude/projects/<slug>/`, other harnesses' files) | **No** | It stays on the source and goes to the archive when Y-431 exists. A summary of it moves instead (§3). |
| The handoff summary | Yes | `claude -p` makes it on the source. It reaches the target as text: a Chat composer draft, or the TUI's launch prompt. |
| Committed but unpushed work on the branch | Yes | In the bundle. |
| Uncommitted changes and untracked files | Yes | A WIP commit through a private index. Its parent is `HEAD`, and `refs/yantra/handoff/<id>` holds it. It goes in the bundle. On the target it is restored as uncommitted changes. |
| Ignored files (`.env`, `node_modules`, build output) | **No, on purpose** | `git add -A` respects `.gitignore`. A secret in `.env` stays on its machine. |
| The branch name | Yes, under the target's name | A Chat thread on the target gets the branch `yantra/chat/<target workspace>/<new id>`. A TUI session keeps the source branch name. |
| Chat checkpoints (`refs/yantra/checkpoints/…`) | No | Checkpoint 0 on the target is the tree as it arrived. The source keeps its own checkpoints. |
| The staged and unstaged split | No | Everything arrives unstaged. |
| Claude's auto memory (`projects/<slug>/memory/`), tmux scrollback, running dev servers | No | Out of scope (R18 §3). |

### 2.1 Three ways to move the work, and the one picked

- **A. A WIP commit on a hidden ref, pushed to origin.** Rejected. It puts uncommitted work on GitHub, and that work can include an untracked file that is not ignored and holds a secret. It also leaves refs on the remote that collaborators can fetch. It is a GitHub write outside ADR-0034's scope. It needs the source to push and the target to fetch, so it is two credentials and two network trips where one relay does the job.
- **B. A bundle relayed by `yantrad`.** **Picked.** `git bundle create - <wip> --not --remotes=origin` writes to stdout ("If *file* is `-`, the bundle is written to stdout", git-bundle docs). `yantrad` copies that stream into an `Ssh::stdio` on the target, in the same shape as `image.rs::put`. It uses a fixed buffer, keeps nothing on disk and logs no content (Q5). The target writes the stream to `${TMPDIR:-/tmp}/yantra-handoff-<id>.bundle`, runs `git fetch origin` with its own credential (ADR-0023 decision 4; a failure here is tolerated), then runs `git bundle verify`, and then fetches from the bundle. Verify "prints a list of missing commits, if any". If commits are missing, `yantrad` sends one full bundle of `<wip>` up to a cap of 256 MiB, and above the cap it refuses and gives the size.
- **C. The archive (Y-432).** Not used. The archive holds transcripts. It holds no worktrees, and under the owner's change it is not needed.

**Whether B breaks a rule.** It does not.

- §B1: the daemon persists nothing. The bytes pass through memory.
- §B4: nothing is stored, so there is no secret at rest.
- ADR-0032 decision 2 ("the appliance never receives the unredacted text") is about the archive's transcripts. No transcript moves here.

The handoff text does pass through the daemon. The daemon already relays every Chat turn's text and every `logs` read, so this is no new kind of exposure.

**What the docs do not show.** They do not show `--not --remotes` as a bundle argument. They only say the arguments are anything `git rev-list` accepts. Y-520's podman test proves it works.

## 3. The summary, and the slug problem

**Where it runs.** On the source machine, with that machine's own login (ADR-0026 decision 7). It uses the same pattern M16 uses for commit messages (`claude -p --output-format json`). The command is:

```
cd "${TMPDIR:-/tmp}/yantra-handoff-<id>" &&
claude -p --resume <session id> --fork-session --no-session-persistence \
  --output-format json --tools "" "<the handoff prompt>"
```

- **The session id.** A Chat thread uses the stem of the newest transcript in the worktree's slug (`logs::newest`, which `claude.rs` already uses). A TUI session uses the id from the pane's start command (`logs::session_of`), or else the newest transcript in the repo's slug.
- **Why it runs from a scratch directory, and why it forks.** Without `--fork-session`, `--resume` appends to the original transcript (R18 T1). With it, the fork lands in the *current* directory's slug (R18 T7). A fork in the worktree's own slug would become the "newest" file there, and the next Chat turn on the source would resume the summary request. A scratch directory keeps the source's conversation exactly as it was.
- **`--no-session-persistence`** stops the fork being written at all, if the installed version has the flag. If it does not, Yantra deletes the scratch slug directory. Y-521 checks the flag on the installed version.
- **`--tools ""` (no tools).** Claude only writes text. It reads nothing new and runs nothing. Y-521 checks the exact spelling of this flag.
- **The prompt** asks for the five headings and a cap of about 300 words. It tells Claude to write no secret values. This is a request and not a guarantee, so the owner sees the handoff before it is sent (§5).

**The slug problem goes away.** The target starts a fresh session, so no transcript has to sit under the target's slug. The resume by id from a scratch directory works across slugs, because Claude Code finds an id in any one project (R18 T1, T4). It fails only when the id is in two other projects on one machine (R18 T5), and a handoff never copies a transcript, so that cannot happen. `logs::slug` already adds the 200-character hash that R18 finding 6 asked for. Yantra still needs the scratch directory's slug, so that it can delete it.

**Other harnesses.** v1 covers Claude threads and Claude TUI sessions. An ACP thread (Codex, Gemini, Grok) is refused with the harness named. A later row can ask the ACP agent itself for the handoff, with `session/load` and then one prompt.

**Where the shared memory layer plugs in.** Another agent is checking claude-mem on the appliance. If that layer exists, it gives a second source for the same five headings. That matters most when the source machine is asleep and cannot run `claude -p`. The handoff function takes the summary as a value, so a second source is a new caller and the rest of the design does not change. This plan does not design that layer.

## 4. The smallest end-to-end version, and the ADR

**Smallest version:** a Chat thread, a Claude source, a source machine that is online, and a target workspace whose repository has the same `origin` URL.

1. `yantra continue <workspace> --thread <id> --to <target workspace>` refuses when:
   - a turn is running. The ADR-0035 keeper session is the lock.
   - the source is not reachable.
   - the target has no workspace for that repository. It says so and names New session.
   - the thread is an ACP thread.
2. The source writes the handoff (§3), then the WIP commit and the bundle (§2.1).
3. The target makes a new thread worktree at the source's `HEAD` from the bundle. It restores the WIP tree as uncommitted changes with `checkpoint::revert`'s recipe, and records `branch.<b>.yantraFrom = <machine>/<thread>/<wip sha>` in git config.
4. The source records `branch.<b>.yantraMovedTo = <machine>/<workspace>/<new id>`. Its page shows "Continued on MacBook", with a link.
5. The target's composer opens with the handoff as a draft. The owner taps Send, and that first turn is a new Claude session, because the new worktree has no transcript.

**Idempotency (§B4).** A second run with the same WIP sha finds the target thread by `yantraFrom` and returns it. It does not make a second thread. If the work changed in between, the WIP sha is new, and so is the thread. That is correct, because it is different work. The daemon keeps nothing; git config holds both marks, as `thread::remember` already does.

**ADR: a new ADR-0037 is needed.** It is small, and it amends nothing else in substance.

- **Decision 1.** *Continue* is a handoff and not a resume. ADR-0015 and ADR-0032 decision 7 (Y-432) stay as they are for *resume*. A handoff starts a fresh session and moves no transcript.
- **Decision 2.** `yantrad` relays a git bundle between two machines, in memory, and never pushes uncommitted work to origin.
- **Decision 3.** A TUI started by a handoff gets its first prompt as a launch argument. ADR-0015 says *"Yantra still sends the agent no input"* about a running agent. This is a launch argument and not keystrokes into a pane. It still changes ADR-0011's launch bullet, so ADR-0037 says so, and ADR-0011 gets a dated blockquote pointing to it.

The build loop parks ADRs, so the owner accepts this one (Y-519).

## 5. The suggestion half

**Where it lives.** The rule is a pure Rust function, `handoff::suggest(source, ranking, on_phone) -> Option<Suggestion>`. It follows I-10: every term that moves the result is named, and the result says which term fired. The daemon serves it on the session's read. The browser sends `on_phone` from `(pointer: coarse)`. It is not saved anywhere.

**When "Continue on X" is offered.** All of these must hold:

- the source's heartbeat is fresh (ADR-0013 §7, 30 s). The source writes the summary and holds the work, so it must be awake.
- no turn is running, and no TUI agent is running.
- X is in the Y-452 ranking with a fresh beat, and X has the repository (the Y-517 term).

**And one of these triggers fires:**

| Trigger | Reason line (example) |
| --- | --- |
| The source is on battery at 20 % or less | *MacBook is on battery at 18 %. cachyos-g14 has the repo and is on AC.* |
| The source is overloaded: CPU busy 90 % or more, or free RAM under 1 GB | *MacBook is busy (CPU 94 %). cachyos-g14 is idle.* |
| X scores 15 points or more above the source in Y-452 | *cachyos-g14 scores 41 against 22: more free RAM.* |
| The owner is on a phone, the source is on battery, and X is on AC | *You are on the phone. Unattended turns keep running on cachyos-g14 if the MacBook sleeps.* |

**A source that is asleep** gets no offer. The menu item is drawn disabled, with the reason: *MacBook is asleep. It must be awake to write the handoff and send its uncommitted work.* Once the archive and the memory layer exist, a later row can take the summary from the appliance and the branch from origin, but only if the branch was pushed.

**The UI on the session page:**

- **Header:** a **Continue on…** menu. It is always there, and it lists the ranked targets with Y-517's reason line for each.
- **Chip:** when the rule fires, a one-line chip sits under the header. It shows the reason and two buttons, **Continue** and **Not now**. **Not now** hides that trigger for that session, in `localStorage`.
- **Sheet:** choosing a target opens a sheet. It shows the generated handoff in an editable text box, the counts of files and commits that will move, and what does not move ("ignored files such as `.env` stay"). The confirm button reads **Start on MacBook**. Progress has three steps: *Handoff*, *Move work*, *Open*. Each failure is drawn with its refusal.
- **After:** the source page shows *Continued on MacBook →*, and the target page shows *Continued from cachyos-g14 ←*.

**T3 Code has nothing like this.** Its remote-access guide says *"Existing threads stay where they started."* Its "Auto balance" only places a *new* thread (R21 §1). Yantra can do it because every machine is an ssh destination and the appliance can reach both ends.

## 6. Rows

Numbers continue from Y-518. Each transport row ships a podman test (§B3) on **two** containers from the fixture image, and the second container's user has the home `/Users/mac`, so the paths differ as they do on a real Mac. Each web row ships a Playwright spec at three sizes with axe.

| ID | Title | Done when … | Kind | Paths | Depends | needsOwner |
| --- | --- | --- | --- | --- | --- | --- |
| Y-519 | ADR-0037: continue is a handoff | The owner accepts ADR-0037. ADR-0011 carries a dated blockquote for the launch prompt. | docs | `docs/adr/0037-*.md`, `docs/adr/0011-*.md`, `tracker.md`, `llms.txt` | — | yes |
| Y-520 | Move a branch and its uncommitted work | `handoff::pack` and `unpack` move unpushed commits, changes and untracked files between two containers, and leave ignored files behind. The test covers missing prerequisites, the size cap and a second run. | rust-transport | `crates/yantra-core/src/{handoff,delegate,lib}.rs`, `crates/yantra-core/tests/handoff.rs`, `crates/yantra-core/tests/common/mod.rs`, `crates/yantra-core/CLAUDE.md` | Y-519 | no |
| Y-521 | Write the handoff on the source | `handoff::summarise` runs `claude -p` from a scratch directory and returns the five headings. A fake `claude` in podman shows the arguments, and shows that the source slug has no new file. | rust-transport | `crates/yantra-core/src/{handoff,claude,logs}.rs`, `crates/yantra-core/tests/handoff.rs` | Y-519 | no |
| Y-522 | `yantra continue` for a Chat thread | The verb and `POST …/threads/{id}/continue` open a target thread with the work and a draft, and mark both threads. Podman tests cover each refusal and a second run that returns the same thread. | rust-transport | `crates/yantra-core/src/{handoff,thread}.rs`, `crates/yantrad/src/{write,contract,chat}.rs`, `crates/yantra/src/main.rs`, `crates/yantra-core/tests/handoff.rs` | Y-520, Y-521 | no |
| Y-523 | Continue on… on the session page | The menu lists ranked targets with reasons, and the sheet shows an editable handoff and the three progress steps. Both pages link to each other. | web | `web/src/screens/session/{Header,Session,Continue}.tsx`, `web/e2e/continue.spec.ts`, `web/e2e/fixture/scenarios/*` | Y-522, Y-517 | no |
| Y-524 | Suggest where to continue | `handoff::suggest` fires each trigger with its reason line, and unit tests cover each trigger, an asleep source and a tie. The chip shows it, and Not now hides it. | rust | `crates/yantra-core/src/handoff.rs`, `crates/yantrad/src/api.rs`, `web/src/screens/session/ContinueChip.tsx`, `web/e2e/continue.spec.ts` | Y-523 | no |
| Y-525 | Continue a TUI session | `yantra continue <workspace> --to <target>` refuses a dirty target checkout. It switches the branch, restores the work and launches a fresh agent with the handoff as its prompt. A podman test covers each step. | rust-transport | `crates/yantra-core/src/{handoff,up,agent}.rs`, `crates/yantra/src/main.rs`, `crates/yantra-core/tests/handoff.rs` | Y-522 | no |
| Y-526 | The owner's walk, Mac and Linux | The owner continues a Chat thread and a TUI session from Linux to the MacBook and back, from the phone. | qa | `docs/plans/continue-elsewhere.md` | Y-524, Y-525 | yes |

**Order:** Y-519 (owner), then Y-520 and Y-521 together (their paths differ only in `handoff.rs`, so build them one after the other if the build loop counts that as a clash), then Y-522, then Y-523 and Y-525 together, then Y-524, then Y-526. Y-523 also waits on Y-517.

## 7. Risks and unknowns

- **`--no-session-persistence` and `--tools ""`** must be checked on the installed Claude Code. The scratch-directory cleanup is the fallback for the first flag.
- **A Chat turn over ssh on a Mac** depends on the login keychain (I-44, R20 *Not answered here*). The ADR-0035 keeper runs in the login server, which should cover it. Y-526 proves it.
- **The handoff can carry a secret** that the model chose to repeat. The prompt forbids it, and the owner reads the draft. No gitleaks pass is promised, because a machine may not have gitleaks installed.
- **The summary turn costs tokens.** A cache that is still warm (within five minutes of the last turn) makes it cheap. A cold one rereads the whole context once.
- **No real summary runs in CI.** The podman fixture has no login. A fake `claude` covers the arguments, and Y-526 covers the real output.

## Sources

All accessed 2026-10-19.

- Yantra ADRs: [0009](../adr/0009-machine-names-are-ssh-destinations.md), [0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md), [0015](../adr/0015-resume-forks-the-conversation.md), [0023](../adr/0023-the-github-grant-lives-beside-the-relay.md), [0026](../adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md), [0032](../adr/0032-the-appliance-keeps-the-conversation-history-encrypted.md), [0033](../adr/0033-other-harnesses-speak-acp-and-claude-delegates.md), [0035](../adr/0035-a-chat-turn-outlives-its-ssh-pipe.md).
- [R18](../research/18-one-conversation-history.md) §3, tests T1 to T8 and finding 6. [R20](../research/20-claude-stream-json-turn.md), *Where the transcript lands*. [R21](../research/21-t3code-and-yantra.md) §1.
- [The M16 plan](m16-the-coding-loop.md) §3.5 and §6.
- Code: `crates/yantra-core/src/{logs,thread,checkpoint,placement,delegate,claude,resume,history,image,heartbeat,workspace,edit}.rs`.
- Git, `git-bundle` documentation: <https://git-scm.com/docs/git-bundle>.
- T3 Code, `docs/user/remote-access.md`: <https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/user/remote-access.md> ("Existing threads stay where they started.").
