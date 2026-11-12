# ADR-0045 — The hub keeps a thread store

- **Date:** 2026-11-09
- **Status:** Accepted 2026-11-09 by the owner ([Y-666](../../tracker.md), issue #655).
  [Y-688](../../tracker.md) builds it.
- **Evidence:** R24 change 5 (`docs/research/24-decision-and-practice-audit.md`). T3 Code at commit
  `67eebaca`, read at `~/Github/t3code-ref`.
- **Supersedes** [ADR-0015](0015-resume-forks-the-conversation.md) for Chat threads only. ADR-0015
  still decides `yantra resume` for a workspace's TUI session.
- **Amends** [ADR-0004](0004-rust-for-the-daemon.md)'s 2026-08-02 amendment (Y-044),
  [ADR-0041](0041-a-claude-keeper-holds-the-thread.md) decision 8, and
  [ADR-0032](0032-the-appliance-keeps-the-conversation-history-encrypted.md) decision 6. Each gets
  a dated note.
- **Unchanged:** ADR-0032's history archive, and the rule that the daemon keeps no message text and
  no secret.

## Context

A Chat thread is a git worktree on a machine (Y-359). Today the machine holds everything that names
the thread. ADR-0041 decision 8 keeps the session id and the harness in the repository's git
config, under `branch.yantra/chat/<workspace>/<id>.yantraSession` and `.yantraHarness`
(`crates/yantra-core/src/thread.rs`, `remember`). `thread::threads` lists threads by ssh to each
machine. The daemon keeps nothing.

The owner gave three reasons to change this on 2026-11-09:

1. **The thread list and the titles must work when a machine is offline.** Today an offline Mac
   shows no threads. The owner cannot see what was running there, or which thread to pick up on
   another machine.
2. **Git config lives on the machine and dies with the worktree.** `git branch -D` or a removed
   clone forgets the session id. Then Claude's transcript is still on disk, but nothing names it.
3. **Search across all threads needs one index.** The ⌘K palette searches workspaces, machines and
   pages. To search threads it needs one place that knows every thread on every machine.

Y-044 dropped a store on 2026-08-02 because no consumer needed one. ADR-0004's amendment named what
would bring it back: the first question about the past. *Which threads were on the Mac, and what
were they called?* is that question.

### What T3 Code keeps, read on 2026-11-09

T3 Code keeps one SQLite file, `<stateDir>/statev2.sqlite` (`apps/server/src/config.ts`,
`deriveServerPaths`). Its thread row is `projection_threads`: `thread_id`, `project_id`, `title`,
`model`, `branch`, `worktree_path`, `latest_turn_id`, `created_at`, `updated_at`, `deleted_at`
(`apps/server/src/persistence/Migrations/005_Projections.ts`). Later migrations add `archived_at`,
`pinned` and the pull request (`017_ProjectionThreadsArchivedAt.ts`, `036_ProjectionThreadsPinned.ts`,
`048_ProjectionThreadBranchPullRequest.ts`). The resume cursor is a separate table,
`provider_session_runtime` (`004_ProviderSessionRuntime.ts`). Every connection sets
`busy_timeout = 5000`, `journal_mode = WAL` and `synchronous = NORMAL`
(`apps/server/src/persistence/Sqlite.ts`). Migrations are numbered files run in order
(`Migrations.ts`).

T3 also keeps every message in `projection_thread_messages.text` and every event in an event store.
Yantra does not copy those tables. They hold the conversation, and Yantra keeps the conversation in
the harness's own transcript and, when the owner turns it on, in ADR-0032's archive.

## Decision

1. **yantrad keeps one SQLite file on the hub:** `$XDG_STATE_HOME/yantra/threads.sqlite`, which is
   `~/.local/state/yantra/threads.sqlite` for the account the daemon runs as. Mode `0600`, directory
   `0700`. The file is state, not configuration, so it does not go in `~/.config/yantra/`. A copy
   of the config directory to another machine, or a dotfile sync, must not carry a live database
   and its `-wal` and `-shm` files. The runtime directory, which `ssh::state_dir` uses for sockets
   when it exists, is a tmpfs, and a reboot empties it.
2. **One row per thread, and nothing else.** The row holds:
   - the thread id and the workspace;
   - the machine, as the workspace names it (ADR-0009);
   - the branch and the worktree path;
   - the harness and the session id;
   - the title, at most 80 characters;
   - the status: `running`, `waiting`, `idle`, `ended` or `gone`;
   - when the thread was made, and its last activity;
   - the background tasks: for each one its id, its short description and its state, as the
     *Waiting* list shows them. Never its output.

   The file holds **no message text and no secret**. A title made from the first prompt holds the
   first words of it. That is the only text from a conversation in the file, and the owner can
   rename it.
3. **The daemon writes the store first, then git config.** When a keeper reads Claude's `session_id`
   from the `init` line, `yantrad` writes the row, then runs ADR-0041 decision 8's `git config`
   write. A failed git config write leaves the row, and the daemon logs it.
4. **On a conflict, the store wins for the session id and the machine wins for live state.**
   - **Session id and harness: the store wins.** An agent in the worktree can run `git config`. The
     store is in the daemon's own account, where no agent writes. When the two differ, the keeper
     resumes the store's id and the daemon writes it back to git config.
   - **Status, branch and worktree path: the machine wins when it answers.** The store keeps the
     last answer for when the machine is offline. A machine that answers without the worktree makes
     the row `gone`. The daemon does not delete a `gone` row; the owner removes it.
5. **Git config stays as the copy on the machine.** ADR-0041 decision 8 still writes it. A thread
   whose row is missing, for example one made before this store, is read from git config.
6. **Migration reads git config once per machine.** When a machine first answers after the upgrade,
   the daemon lists its thread worktrees and reads each `yantraSession`, `yantraHarness` and
   `yantraIssue`. It inserts a row for each thread that has none. It never overwrites a row. A
   machine that never answers keeps no rows until it does.
7. **The thread list reads the store.** `thread::threads` answers from the store at once. The daemon
   then asks each machine that answers and updates the rows. An offline machine's threads show with
   their titles and *offline*, and they open read-only until the machine answers.
8. **Search reads the store.** Titles are searched with a `LIKE` query. The store has no full-text
   index, because it holds no text to index beyond titles.
9. **Message-text search comes later, from ADR-0032's history.** `ctx` indexes the archive on the
   appliance. A search of message text across threads asks it, not this file. That is a later row.
10. **I-12, I-13 and I-14 come back into force.** `rusqlite` with the bundled SQLite feature, hand
    written SQL and no ORM. Every connection sets `busy_timeout` and `journal_mode = WAL`. Calls go
    through `spawn_blocking`. Migrations are numbered and run in order at start, as T3's are.

## Consequences

**Gained.** The thread list works with a machine off, and names each thread. A session id outlives
its branch. The palette can search every thread from one place. An agent in a worktree cannot change
which conversation a keeper resumes, which ADR-0041 decision 8 wanted and git config alone did not
give.

**Cost: the daemon persists state about the fleet.** CLAUDE.md §B1 said it does not. That sentence
changes in this ADR's PR. The first look after a start now shows the last known threads, and that
view can be stale. The status *offline* and the time of the last answer say so on screen.

**Cost: two copies of the session id.** Decision 4 says which one wins. A test must show that a
second `claude` run in the worktree does not change which conversation resumes.

**Cost: a database to keep.** Migrations, `busy_timeout`, `spawn_blocking`, and a backup with
`VACUUM INTO`. The file is small: one row per thread, a few hundred bytes each.

**Cost: `rusqlite` enters the build.** The bundled feature compiles SQLite's C source, which
`cargo-zigbuild` must build for `aarch64-unknown-linux-musl`. The build row proves it.

**Not changed.** The daemon keeps no message, no prompt, no reply and no secret. ADR-0032's archive
stays outside yantrad. The workspace TOML stays the declared state.

## Alternatives

**Keep git config only.** It costs nothing to build. It fails all three of the owner's reasons: an
offline machine shows nothing, `branch -D` forgets the id, and search must ssh to every machine.

**A TOML file, as the rooms and the layout use.** It works for the list. It must be read whole and
written whole on each change, and a thread changes status often. SQLite writes one row and answers
a `LIKE` query.

**Store messages too, as T3 Code does.** It gives message search at once. It puts the conversation
in the daemon, which ADR-0032 decision 6 and the owner's rule forbid, and it duplicates the
transcript that `--resume` already needs.

**Put the file in `~/.config/yantra/`.** It keeps one directory for everything. Decision 1 gives
the reason against it.

## Sources

Accessed 2026-11-09.

- T3 Code, commit `67eebaca` (2026-11-05), MIT, at `~/Github/t3code-ref`:
  `apps/server/src/config.ts` (`deriveServerPaths`, `statev2.sqlite`),
  `apps/server/src/persistence/Sqlite.ts` (pragmas),
  `apps/server/src/persistence/Migrations.ts`,
  `apps/server/src/persistence/Migrations/004_ProviderSessionRuntime.ts`,
  `005_Projections.ts`, `017_ProjectionThreadsArchivedAt.ts`, `036_ProjectionThreadsPinned.ts`,
  `048_ProjectionThreadBranchPullRequest.ts`.
- Yantra code read on `main`: `crates/yantra-core/src/thread.rs` (`remember`, `recall`, `threads`),
  `crates/yantra-core/src/ssh.rs` (`state_dir`), `crates/yantrad/src/write.rs` (`threads`),
  `crates/yantrad/yantrad.service`.
- XDG Base Directory Specification, `$XDG_STATE_HOME`:
  <https://specifications.freedesktop.org/basedir-spec/latest/>.

> **ADR-0045, decision 2, 2026-11-10 (Y-698):** a home thread's row has no workspace, no
> branch and no worktree path. Those three fields may be empty, and the machine names the thread
> ([ADR-0046](0046-the-owner-types-sudo-in-an-owner-terminal.md) decision 1).

> **ADR-0045, decisions 2 and 4, 2026-11-12 ([Y-782](../../tracker.md), owner):** a thread's row
> also holds the GitHub repository, `owner/repo`. The security audit (F-06) found that the PR verbs
> act on the repository named in git config, which an agent in the worktree can rewrite. The owner
> decided:
>
> 1. **A new thread takes its repository from where the workspace was cloned from**, as Yantra
>    recorded it at clone time. An agent cannot change that record. A folder that Yantra did not
>    clone falls back to the remote at creation.
> 2. **A row with no repository binds on first use.** The first PR verb on a thread made before
>    this note stores the repository it reads then. The owner accepted the small window this leaves.
> 3. **The store wins for the repository** (decision 4). `open_pr`, `pending_pr` and `merge_pr`
>    refuse a remote that names another repository, and the dialog names both.
> 4. **The `yantra pr` CLI stays unbound** (ADR-0012). A person types it in the folder they see.
>
> **What changed upstream of the reasoning:** the build loop runs agents in the owner's worktrees,
> and the 2026-11-12 audit showed one could redirect a merge.
