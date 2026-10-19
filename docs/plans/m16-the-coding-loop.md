# M16 — The owner's coding loop: from an issue to a merged PR

- **Asked 2026-10-19 by the owner.** Owner's correction the same day: Yantra does not compete with T3 Code and does not aim for parity. It takes what the owner uses every day, and it does better where Yantra's design allows.
- **The user:** one person, one tailnet, GitHub only, several machines, a phone, and an appliance that is always on.
- **T3 Code read at:** `pingdotgg/t3code` commit [`1451e7cb23034d29774338608368a15d8845df36`](https://github.com/pingdotgg/t3code/tree/1451e7cb23034d29774338608368a15d8845df36) (2026-10-18 23:03 −0700, "feat(web): choose the in-app browser's search engine (#17688)"). This was a shallow clone, and nothing in it was run. R21 read `72d5c32`. Every T3 path below is relative to the T3 repository at `1451e7c`.
- **Yantra read at:** `main` on 2026-10-19. Yantra paths are relative to the repository root.
- **Read against:** [R21](../research/21-t3code-and-yantra.md), [ADR-0023](../adr/0023-the-github-grant-lives-beside-the-relay.md), [ADR-0026](../adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md), [ADR-0033](../adr/0033-other-harnesses-speak-acp-and-claude-delegates.md), [ADR-0024](../adr/0024-the-dashboard-is-material-3-built-by-hand.md), and the open rows in `tracker.md` §3 (Y-446, Y-447, Y-449, Y-355).

## 1. The demo that closes the milestone

The owner sees an issue assigned to them in the work inbox. The owner taps **Start session** on the phone. Yantra suggests a machine that holds the repository, and a Chat thread opens in a fresh worktree there, with the issue in the composer. The agent works. The owner reads the branch diff file by file and comments on two lines, and those comments go back to the agent. The owner commits with a generated message, pushes, and opens a PR that says `Closes #n`. The laptop then sleeps. The appliance watches the PR. When a check fails, ntfy tells the phone. The owner taps **Fix with agent**, the checks pass, and the owner merges from the phone. The issue closes, and the worktree goes when the owner says so.

**Done when** that walk runs end to end on the fixture in Playwright at three sizes, runs against a bare remote and a GitHub stub in podman, and the owner walks it once on the real fleet.

## 2. Findings that change the plan

1. **T3 Code ships no CodeMirror and no Monaco.** It views and edits files with `@pierre/diffs` (its `Editor` from `@pierre/diffs/edit`, in `apps/web/src/components/files/FilePreviewPanel.tsx:17-33`, `:573`). Its file tree is `@pierre/trees`. Both are **Apache-2.0**, not MIT, so the NOTICE duty differs from ADR-0026 decision 5. `@pierre/diffs@1.5.2` unpacks to 7.4 MB, and T3 patches it (`patches/@pierre%2Fdiffs@1.5.2.patch`).
2. **T3 Code has no issue → thread flow.** No route, component or user doc starts work from an issue. Issue numbers appear only in the branch-naming prompt (`docs/user/project-settings.md:56`). Yantra already reads assigned issues (M11), so this is where Yantra does more, not less.
3. **ADR-0023 understates what the token can already do.** It grants `repo read:org notifications` (`crates/yantra-core/src/github.rs:31`). GitHub documents `repo` as "full access to public and private repositories including read and write access to code". So opening, commenting on and merging a PR needs **no new scope**. ADR-0023's exposure paragraph says a reader of `daemon.env` "can read the owner's private repositories". A reader can in fact write them too, today. This needs an owner ruling, not a new consent.
4. **T3 Code writes commit messages with `claude -p --output-format json`** (`apps/server/src/textGeneration/ClaudeTextGeneration.ts:199-201`). Yantra can run the same command over ssh in the thread's worktree, with the machine's own login (ADR-0026 decision 7). No code crosses the boundary.
5. **T3's "open in editor" for a remote host is a URL:** `vscode://vscode-remote/ssh-remote+<host><path>` (`packages/contracts/src/editor.ts:213`). Yantra's machine names are ssh destinations (ADR-0009), so the link works with no setup on any machine the laptop can ssh to. **Editing stays in the owner's editor.** Yantra does not ship one.
6. **No Yantra surface lists a workspace's Chat threads.** `thread::list` exists (`crates/yantra-core/src/thread.rs:51`), and `crates/yantrad/src/chat.rs:380` calls it, but no route serves the list and no screen draws it. A thread is reachable only by its URL. A notification on the phone therefore cannot lead back to a thread.

## 3. Capabilities: what the owner needs

Key: **Need** = does the owner need it (yes, later, or out). **Copy** = the T3 web files to copy and adapt. **Rust** = the server part, re-expressed in Rust. Sizes are S, M and L.

### 3.1 Issue → session (in scope)

- **T3:** none (finding 2).
- **Yantra today:** `crates/yantra-core/src/attention.rs`, `github.rs::attention` (reads issues assigned to the owner), `web/src/screens/fleet/Github.tsx`, `crates/yantra-core/src/thread.rs::open`, `crates/yantra-core/src/placement.rs` (Y-452).
- **Need:** yes. This is the start of the loop.
- **Gap:** the inbox only links out to GitHub. No action opens a thread, and no route reads an issue's body.
- **Rust:** `yantra-core` grows `github::issue(repo, n)` (title and body; never logged, Q5). It also grows a thread opened with an issue, whose upstream branch name carries the issue number. `yantrad` gets `POST /api/workspaces/{name}/threads`. The CLI gets `yantra chat new <workspace> --issue owner/repo#n` (ADR-0012).
- **Web:** Yantra's own code, with no T3 equivalent. The picker lists the workspaces whose repository matches the issue, ranked by the Y-452 score.
- **Improve on T3:** the owner picks the **machine per issue** from a ranked list. The thread runs from the appliance, so it **continues while the laptop sleeps**.
- **Size:** M (rust) + M (web). **Depends:** ADR-0034.

### 3.2 Thread sidebar (in scope, reduced)

- **T3:** `apps/web/src/components/Sidebar.tsx` (5,084 lines), `Sidebar.logic.ts`, `ThreadStatusIndicators.tsx`, `docs/user/thread-sidebar.md`.
- **Yantra today:** `web/src/shell/SessionsRail.tsx` lists workspaces. Threads are not listed (finding 6).
- **Need:** yes, a list of threads per workspace with status, issue and PR. Pinning, snoozing, drag reordering and settling are out: one person with a few threads does not need them.
- **Copy:** the grouping and status logic only, from `Sidebar.logic.ts` and `ThreadStatusIndicators.tsx`.
- **Rust:** `GET /api/workspaces/{name}/threads` over `thread::list`. The branch, upstream, issue and PR are derived from git and GitHub, and nothing is stored.
- **Improve on T3:** a thread listed here is a git worktree on the machine, so it survives a `yantrad` restart with no database.
- **Size:** folded into the 3.1 rows.

### 3.3 Diff viewer and per-file review (in scope)

- **T3:** `apps/web/src/components/DiffPanel.tsx`, `DiffPanelShell.tsx`, `DiffWorkerPoolProvider.tsx`, `DiffFilePathCopyButton.tsx`; `components/diffs/` `DiffFileTree.tsx`, `diffFileTree.logic.ts`, `StyledDiffCodeView.tsx`, `AnnotatableCodeView.tsx`, `DiffCommentAnnotation.tsx`, `DiffFileStatus.tsx`, `commentSubmitShortcut.ts`, `useCodeViewFileReveal.ts`; `src/diffPanelStore.ts`, `src/reviewCommentContext.ts`, `src/pierre-tree-theme.ts`, `src/lib/diffRendering.ts`, `src/lib/turnDiffTree.ts`; viewed marks in `components/pullRequest/pullRequestFilesViewed.logic.ts`. A turn diff and a branch comparison (`docs/user/source-control.md` § Review turn changes).
- **Yantra today:** per-turn checkpoints and diffs (`crates/yantra-core/src/checkpoint.rs`, Y-448), drawn as plain unified text in `web/src/screens/session/TurnDiff.tsx`. There is no branch diff, no file tree, no syntax colour and no line comments.
- **Need:** yes. Review is the step the owner does most.
- **Copy:** the files above, on `@pierre/diffs` and `@pierre/trees`, in a lazy chunk.
- **Rust:** `checkpoint.rs` (or a sibling module) gains the branch diff against the merge-base with the base branch, plus `--numstat`, over the existing `Exec`.
- **Improve on T3:** line comments become a quoted block in the composer. The next turn runs in tmux-free `claude -p` from the appliance, so a review sent from the phone gets worked on with the laptop shut.
- **Size:** S (rust) + L (web). **Depends:** the ADR-0026 amendment in ADR-0034.

### 3.4 File tree, file viewer and editor (mostly out)

- **T3:** `components/files/FileBrowserPanel.tsx`, `FilePreviewPanel.tsx` (1,474 lines, with an editor), `fileSaveCoordinator.ts`, `ProjectFilePicker.tsx`; server `apps/server/src/workspace/WorkspaceFileSystem.ts`, `WorkspaceSearchIndex.ts`.
- **Yantra today:** `crates/yantra-core/src/dirs.rs` lists one level for the New session picker.
- **Need:** **open in editor: yes. Browsing and editing the whole tree: out.** The owner edits in their own editor. The diff covers the changed files.
- **Copy:** the link builder at `packages/contracts/src/editor.ts:205-215` and `components/chat/OpenInPicker.tsx` with `OpenInPicker.logic.ts`, cut to VS Code, Cursor and Zed.
- **Improve on T3:** Yantra needs no "local-exec" mode. Every machine name is already an ssh destination.
- **Size:** S, folded into the diff panel row.

### 3.5 Git panel: stage, commit with a generated message, push, branch (in scope, reduced)

- **T3:** `components/GitActionsControl.tsx` (2,089 lines), `GitActionsControl.logic.ts` (actions `commit`, `push`, `create_pr`, `commit_push`, `commit_push_pr`); server `apps/server/src/git/GitWorkflowService.ts`, `GitManager.ts`, `vcs/GitVcsDriverCore.ts`, `textGeneration/ClaudeTextGeneration.ts`, `TextGenerationPresets.ts`.
- **Yantra today:** a thread is already a branch `yantra/chat/<workspace>/<id>` in its own worktree (`thread.rs`). Nothing commits or pushes it.
- **Need:** commit everything, push, and generate the message: yes. Partial staging and branch switching: out. A thread is one branch by construction.
- **Copy:** `GitActionsControl.tsx` and `.logic.ts`, cut to commit, push and PR.
- **Rust:** `yantra-core` gains `commit` (message from `claude -p --output-format json` in the worktree, editable before use) and `push -u origin <local>:<remote name>`. Both run over `Exec`, with the machine's git identity and credential (ADR-0023 decision 4). Git's own `branch.<b>.merge` holds the upstream name, so Yantra stores nothing. The CLI gets `yantra commit` and `yantra push`.
- **Improve on T3:** none in kind. The work runs on the machine that holds the credential, so the token never crosses ssh.
- **Size:** M (rust-transport) + M (web).

### 3.6 PR create, link and watch (in scope)

- **T3:** web `components/pullRequest/PullRequestThreadLinks.tsx`, `useThreadLinkedPullRequest.ts`, `PullRequestChecksPopover.tsx`, `ThreadPullRequestsPanel.tsx`, `pullRequestPresentation.tsx`; server `apps/server/src/git/linkCreatedPullRequest.ts`, `pullRequest/PullRequestService.ts`, `orchestration-v2/pullRequestWatch.ts`, `PullRequestWatchReactor.ts`; GitHub `packages/source-control-github/src/server/GitHubPullRequestApi.ts`, `GitHubRest.ts`, `gitHubConditionalChecks.ts`, `gitHubChangeRequestTemplate.ts`. The watch checks every two minutes, uses conditional reads, and stops on merge or close or after 8 failed reads (`docs/user/source-control.md` § Linked pull requests).
- **Yantra today:** Y-449 is open. `github.rs` reads with the token and has no write.
- **Need:** create, link and watch checks and reviews: yes. Several PRs per thread, cross-repository links and stacks: out.
- **Copy:** the four web files above, cut to one PR per thread.
- **Rust:** `github.rs` gains `create_pull`, `pull_for_head` (the link is derived from the upstream branch, not stored), `checks` and `reviews` with ETag reads. `yantrad` adds a watcher task beside `refresh.rs`, with in-memory state that is rebuilt from the open PRs of the thread branches at start. It sends notifications through `notify.rs` and the Y-451 phases.
- **Improve on T3:** the **appliance is always on**. T3's watch stops when its server's laptop sleeps, and a T3 push needs T3 Connect. Yantra's watch runs on the appliance and pushes to the owner's own ntfy.
- **Size:** M (rust, create) + M (rust, watch) + S (web).

### 3.7 PR merge, auto-merge, review and comment (merge in scope; the rest out)

- **T3:** `components/pullRequest/usePullRequestActions.ts`, `useInlineActionConfirm.ts`, `PullRequestDetailPanel.tsx` (2,910 lines), `PullRequestReviewForm.tsx`, `PullRequestCommentForm.tsx`; GraphQL merge in `GitHubPullRequestApi.ts:860`.
- **Need:**
  - **Merge (squash) with confirmation, then delete the branch and offer to remove the worktree: yes.**
  - **Auto-merge: out.** A green-check notification plus one tap on the phone does the same job for one person.
  - **Reviewing other people's PRs and writing comments: out.** The inbox links to github.com, and review requests are rare on solo repositories.
  - **Reading review comments on the owner's own PR, to feed the agent: yes**, through the watch.
- **Rust:** `github.rs::merge` and `yantra pr merge`. `thread::remove` already exists.
- **Size:** S.

### 3.8 Terminal integration (in scope, polish)

- **T3:** `components/ThreadTerminalDrawer.tsx` (1,950 lines), `src/terminal-links.ts`; server `apps/server/src/terminal/Manager.ts`, `NodePtyAdapter.ts`. The PTY belongs to the T3 server, so a restart ends the shell (R21 §1).
- **Yantra today:** the Terminal tab attaches to the workspace's tmux session in the main tree (`crates/yantrad/src/terminal.rs`, ADR-0022), not to the thread's worktree.
- **Need:** yes, a shell in the thread's worktree, to run the tests by hand.
- **Copy:** the drawer layout of `ThreadTerminalDrawer.tsx` only. Yantra keeps xterm, and tmux keeps the scrollback (Y-132).
- **Rust:** one tmux session per thread, opened in the worktree on first use and killed by `thread::remove`, attached through the existing session-addressed socket.
- **Improve on T3:** the shell **survives a `yantrad` restart and update**, and the owner can attach to it from any terminal with `tmux attach`.
- **Size:** M.

### 3.9 Keyboard shortcuts and command palette (in scope, polish)

- **T3:** `apps/web/src/keybindings.ts`, `apps/server/src/keybindings.ts` (default table), `components/CommandPalette.tsx`, `CommandPalette.logic.ts`, `docs/user/keybindings.md`.
- **Yantra today:** ⌘K palette in `web/src/shell/Palette.tsx` and `PalettePopup.tsx`.
- **Need:** a fixed set of loop shortcuts, palette commands and a help sheet: yes. User-editable bindings and their settings page: out.
- **Copy:** the defaults for the actions Yantra has, from the default table in `apps/server/src/keybindings.ts` and `apps/web/src/keybindings.ts`.
- **Size:** S.

### 3.10 Settings (out)

- **T3:** `components/settings/SourceControlSettings.tsx`, `SourceControlWritingSettings.tsx`, `BranchNamingSettings.tsx`, `KeybindingsSettings.tsx`.
- **Need:** out. One owner and one writing style. The commit-message prompt is a constant in `yantra-core`. Settings → Providers already shows the GitHub grant.

### 3.11 Out of scope, one line each

| T3 capability | Why it is out |
| --- | --- |
| GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, GitCafe (`packages/source-control-*`) | The owner uses GitHub only. Y-355 stays open and gets no ADR in M16. |
| PR stacks, merge stack, rebase stack (`githubStackActions.ts`, `PullRequestStack*.tsx`) | One thread makes one PR. |
| Review guides (`PullRequestReviewGuideService.ts`, `PullRequestGuideTab.tsx`) | A beta tour for other people's large PRs. The owner reviews their own agent's diff. |
| Auto-merge | A notification plus one tap replaces it for one person. |
| Labels, reviewer picker, reactions, bulk close | Solo repositories. |
| GitHub sharing between environments | One daemon holds the one grant. |
| Full file browser, editor and project search | The owner's editor does this, and open-in-editor reaches it. |
| Editable keybindings and their settings page | A fixed set is enough for one person. |
| Commit messages from six providers | `claude` on the machine is enough, and ADR-0033 keeps Claude as the main agent. |
| Offline cache of PR pages on mobile | A PWA on a tailnet. GitHub's own app covers offline reading. |

## 4. What not to copy, and why

- **T3 Connect, the relay and Clerk** (`infra/relay/`, `apps/server/src/relay/`, `apps/server/src/cloud/`, `apps/web/src/clerk/`, `apps/web/src/cloud/`). The owner decided on 2026-10-07 that Tailscale is the only route (R21 §6.1), and ADR-0016 stands. Connect puts Clerk, Cloudflare and PlanetScale in the path.
- **PostHog telemetry** (`apps/server/src/telemetry/`, `docs/user/telemetry.md`). Yantra sends no telemetry (architecture.md §3). T3 turns it on by default.
- **Auth scopes, pairing, DPoP and bearer sessions** (`apps/server/src/auth/`, `docs/internals/environment-auth.md`). ADR-0016 authorises every write by the caller's tailnet identity. There is one owner and no third party to scope.
- **Effect, `@t3tools/contracts` and the event-sourced SQLite store.** ADR-0004 keeps one runtime, Rust. ADR-0026 re-expresses the vocabulary, not the code. Yantra's daemon persists nothing (CLAUDE.md §B1).
- **`node-pty` terminals with server-side history.** tmux keeps the shell and the scrollback (Y-132, R21 §6).
- **The Tiptap composer.** Yantra's composer works, and Tiptap is a budget cost with no loop gain.

## 5. ADRs: what needs one, and what conflicts

**One new ADR, ADR-0034 "The coding loop writes to GitHub" (Y-487, needs the owner).** It decides:

1. The daemon's existing `repo` grant opens, reads and merges PRs. No scope changes, and the ADR states finding 3 outright.
2. Pushes and commits run on the machine, with the machine's git identity and credential. The token never crosses ssh (ADR-0023 decision 4 holds).
3. A thread's PR is derived from its upstream branch through GitHub's `pulls?head=`. Yantra stores nothing. The watch keeps state in memory only.
4. The daemon reads an issue's title and body to seed a thread, and never logs them (Q5).
5. Commit messages come from `claude -p` on the machine (ADR-0026 decision 7).

It amends ADR-0023 and ADR-0026 by dated blockquote, as §B5 requires:

- **ADR-0023:** the exposure paragraph gains "and write them". "Not decided: whether the scope ever widens to write" is answered: it needs no widening, and the owner rules that writes are used.
- **ADR-0026:** "What it does not do: … no `@pierre/diffs`, … no diff panel" and "Not decided: the diff surface" are answered. The diff panel ships on `@pierre/diffs` and `@pierre/trees`, Apache-2.0, credited in `THIRD_PARTY_NOTICES.md` with the Apache NOTICE text, and loaded in a lazy chunk.

**No ADR for "Yantra as the editor".** The owner dropped that framing. Editing goes to the owner's editor through a link.

**No GitLab ADR in M16.** Y-355 stays open, unscheduled.

**Conflicts and invariants that the rows must respect:**

| Rule | Where M16 touches it | What the rows do |
| --- | --- | --- |
| ADR-0012 and `crates/yantrad/CLAUDE.md` § The routes that act (verb first) | Every new write route | Each write row adds the `yantra` verb in the same PR. The chat route's missing verb stays the open gap it is now, not a precedent. |
| ADR-0016, `allowed()` | Every new route | Every write and every upgrade calls `allowed()`, and each has its own refusal test. |
| Daemon persists nothing (§B1) | PR link, watch state, viewed marks | Git config, GitHub, memory and the browser's `localStorage`. No file on the appliance. |
| Q5 | Diffs, issue bodies, messages, check output | Nothing logged. Tests assert that the log has none of it. |
| ADR-0024 §7 and `npm run budget` | `@pierre/diffs` with Shiki | `/` stays under 200 KiB. The diff chunk gets its own measured line in `budget.mjs`. |
| ADR-0026 decision 6 and 8 (one writer per tree) | The terminal in the worktree (3.8) | The owner's own shell can write the thread's tree during a turn. The Y-498 row says so in the UI and does not lock. |
| I-20 (ControlMaster), I-24 and I-26 (generated names) | Push and remote branch names | Remote names come from the issue number plus a slug that Yantra sanitises, never raw title text. |
| ADR-0033 decision 7 | A long turn during a daemon update | Y-446 and Y-447 (open) fix it. They are not M16 rows. M16 recommends them before the owner relies on unattended fixes. |

## 6. Rows

Numbers continue from Y-486. Y-449 keeps its number and is re-scoped to PR creation only. Each web row ships its own Playwright spec at three sizes with axe, as M14 does. Each transport row ships a podman test (§B3).

**The loop first**

| ID | Title | Done when … | Kind | Paths | Depends | needsOwner |
| --- | --- | --- | --- | --- | --- | --- |
| Y-487 | ADR-0034: the coding loop writes to GitHub | The owner accepts ADR-0034. ADR-0023 and ADR-0026 carry dated amendments for writes and the diff panel. | docs | `docs/adr/0034-*.md`, `docs/adr/0023-*.md`, `docs/adr/0026-*.md`, `THIRD_PARTY_NOTICES.md`, `tracker.md` | — | yes |
| Y-488 | A workspace lists its threads, and a thread opens from an issue | `GET …/threads` lists each thread's branch, issue and PR. `yantra chat new --issue` opens a worktree and returns the issue as a draft prompt. | rust | `crates/yantra-core/src/{thread,github}.rs`, `crates/yantrad/src/chat.rs`, `crates/yantrad/src/contract.rs`, `crates/yantra/src/main.rs`, `crates/yantra-core/tests/thread.rs` | Y-487 | no |
| Y-489 | Start a session from an issue, and see a workspace's threads | An inbox issue opens a picker of matching workspaces, ranked by placement score, and lands in a Chat with the draft. The session lists its threads with status. | web | `web/src/screens/fleet/Github.tsx`, `web/src/screens/session/{Session,Chat,ThreadList}.tsx`, `web/src/shell/SessionsRail.tsx`, `web/e2e/loop.spec.ts` | Y-488 | no |
| Y-490 | A thread's whole-branch diff | The daemon serves the thread's diff and per-file counts against the merge-base. A podman test checks a rename, a binary file and the size cap. | rust | `crates/yantra-core/src/checkpoint.rs`, `crates/yantrad/src/chat.rs`, `crates/yantra-core/tests/checkpoint.rs` | — | no |
| Y-491 | A diff panel with a file tree, line comments and open-in-editor | The panel draws turn and branch diffs on `@pierre/diffs` with a file tree. Line comments fill the composer, and each file opens in VS Code, Cursor or Zed over ssh. | web | `web/src/screens/session/diff/*`, `web/src/screens/session/TurnDiff.tsx`, `web/scripts/budget.mjs`, `web/package.json`, `web/e2e/diff.spec.ts` | Y-487, Y-490 | no |
| Y-492 | Commit and push a thread's branch | `yantra commit` commits with a message that `claude -p` writes on the machine, and `yantra push` sets the upstream. Podman tests cover a refused push and a machine with no git identity. | rust-transport | `crates/yantra-core/src/{commit,thread}.rs`, `crates/yantrad/src/write.rs`, `crates/yantra/src/main.rs`, `crates/yantra-core/tests/commit.rs` | Y-487 | no |
| Y-449 | Open a PR from a Chat (re-scoped) | `yantra pr open` opens a PR for the pushed branch with the token, saying `Closes #n` for an issue thread. The threads list shows the PR, and a stub test covers a refusal. | rust | `crates/yantra-core/src/github.rs`, `crates/yantrad/src/write.rs`, `crates/yantra/src/main.rs`, `crates/yantra-core/tests/github_api.rs` | Y-492 | no |
| Y-493 | Git actions in the Chat | Commit, push and open-PR controls sit in the Chat header with an editable generated message. The PR link shows once it exists, and every failure is drawn. | web | `web/src/screens/session/{GitActions,Header}.tsx`, `web/e2e/loop.spec.ts` | Y-449 | no |
| Y-494 | The appliance watches each thread's PR | The daemon polls open PRs with conditional reads and stops on merge or close. ntfy says when a check fails, all checks pass, or someone else reviews. | rust | `crates/yantrad/src/{watch,notify,refresh}.rs`, `crates/yantra-core/src/github.rs`, `crates/yantrad/src/contract.rs` | Y-449 | no |
| Y-495 | Checks in the Chat, and Fix with agent | The Chat shows each check and review comment. **Fix with agent** fills the composer with the failed checks' summaries and the comments. | web | `web/src/screens/session/{Checks,Chat}.tsx`, `web/e2e/loop.spec.ts` | Y-494, Y-493 | no |
| Y-496 | Merge a PR and remove its thread | `yantra pr merge` squash-merges after the owner confirms and deletes the remote branch. The Chat then offers to remove the worktree. | rust | `crates/yantra-core/src/{github,thread}.rs`, `crates/yantrad/src/write.rs`, `crates/yantra/src/main.rs`, `web/src/screens/session/GitActions.tsx` | Y-494 | no |
| Y-497 | The whole loop, end to end | One Playwright spec walks issue to merge on the fixture at three sizes. One podman test runs commit, push, PR and merge against a bare remote and a GitHub stub. | web | `web/e2e/loop.spec.ts`, `web/e2e/fixture/scenarios/*`, `crates/yantra-core/tests/loop.rs` | Y-489, Y-491, Y-495, Y-496 | no |

**Polish after**

| ID | Title | Done when … | Kind | Paths | Depends | needsOwner |
| --- | --- | --- | --- | --- | --- | --- |
| Y-498 | A terminal in the thread's worktree | A drawer in the Chat attaches to a tmux session opened in the worktree, and `thread::remove` kills it. A podman test shows it survives a `yantrad` restart. | rust-transport | `crates/yantra-core/src/{thread,tmux}.rs`, `crates/yantrad/src/terminal.rs`, `web/src/screens/session/TerminalDrawer.tsx` | — | no |
| Y-499 | Shortcuts and palette commands for the loop | The palette runs Start from issue, Diff, Commit, Push, Open PR and Merge. Each has a shortcut, and `?` shows them all. | web | `web/src/shell/{Palette,PalettePopup}.tsx`, `web/src/screens/session/keys.ts`, `web/e2e/shell.spec.ts` | Y-491, Y-493 | no |

**Order the build loop should take:** Y-487 (owner) → Y-488, Y-490, Y-492 together (different paths) → Y-449, Y-489, Y-491 → Y-493, Y-494 → Y-495, Y-496 → Y-497 → Y-498, Y-499. Y-498 has no dependency and can fill any batch. Y-447 should land before the owner relies on Fix with agent during a daemon update.

**Milestone row for `tracker.md` §2:** M16, *The coding loop*. Definition of done is §1 above. Status ⬜ todo, planned 2026-10-19, this plan, Y-487…Y-499 and Y-449.

## 7. Risks and unknowns

- **The GitHub write path has no live test without a scratch repository.** Y-449 and Y-496 test against a stub. An `#[ignore]`d live test needs a repository the owner names, and the owner runs it.
- **`@pierre/diffs` is a 1.x package that T3 patches.** Read T3's patch before Y-491 and decide whether Yantra needs it. If the chunk is too heavy on a phone, the fallback is Yantra's own `TurnDiff.tsx` with a file list added.
- **Generated messages cost a `claude -p` turn on the owner's plan.** It is small, and the owner can type a message instead.
- **Fix with agent is one tap, not automatic.** T3 wakes the agent on its own. Yantra does not, because a Full-access turn that starts with nobody watching is a decision the owner has not made.

## Sources

All accessed 2026-10-19.

- `pingdotgg/t3code` at commit `1451e7cb23034d29774338608368a15d8845df36`, <https://github.com/pingdotgg/t3code/tree/1451e7cb23034d29774338608368a15d8845df36>, MIT, `Copyright (c) 2026 T3 Tools Inc.`. Shallow clone. Files read: `apps/web/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` (the `@pierre/*` entries); `docs/user/source-control.md`, `thread-sidebar.md`, `keybindings.md`, `terminal.md`; `docs/internals/composer-editors.md`, `pull-request-file-revisions.md`, `web-ui.md`; `apps/web/src/components/files/FilePreviewPanel.tsx`, `GitActionsControl.logic.ts`, `chat/OpenInPicker.logic.ts`, `src/remoteOpen.ts`; `packages/contracts/src/editor.ts`; `apps/server/src/textGeneration/ClaudeTextGeneration.ts`; `packages/source-control-github/src/server/GitHubPullRequestApi.ts`, `GitHubSourceControlProvider.ts`. Listings: `apps/web/src/components/` (including `diffs/`, `files/`, `pullRequest/`, `sidebar/`, `settings/`), `apps/server/src/` (including `git/`, `vcs/`, `sourceControl/`, `pullRequest/`, `terminal/`, `workspace/`, `textGeneration/`), `apps/web/src/routes/`. Grep for `codemirror|monaco` (none found) and for issue flows (none found).
- npm registry, `@pierre/diffs@1.5.2` (Apache-2.0, 7,473,395 bytes unpacked) and `@pierre/trees@1.0.0-beta.6` (Apache-2.0, 1,456,269 bytes unpacked), read with `npm view`.
- GitHub Docs, *Scopes for OAuth apps*, <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps>. The `repo` scope grants "full access to public and private repositories including read and write access to code".
- Yantra on `main`: `CLAUDE.md`, `tracker.md` (§2, §3, Y-355, Y-446…Y-449), `docs/archive/m11-m13.md`, `docs/research/21-t3code-and-yantra.md`, ADR-0023, ADR-0024, ADR-0026, ADR-0033, `crates/yantrad/CLAUDE.md`, `crates/yantra-core/src/{thread,checkpoint,github,attention,dirs}.rs`, `crates/yantrad/src/chat.rs` and the route tables in `crates/yantrad/src/*.rs`, `web/package.json`, `web/scripts/budget.mjs`, `web/src/screens/session/`, `web/src/shell/{Palette,SessionsRail}.tsx`.
