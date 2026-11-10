# ADR-0046 — The owner types sudo in an owner terminal, and a home chat has no workspace

- **Date:** 2026-11-10
- **Status:** Proposed ([Y-698](../../tracker.md)). The owner accepts or changes it.
- **Owner's ask, 2026-11-10:** *"On the Yantra box I also want a feature to spawn a new Claude
  session in the home directory, because sometimes I just want to converse normally. And what are
  the steps so that I can give the agent sudo, or run sudo commands myself, from the chat client or
  the Yantra web UI?"*
- **Widens** [ADR-0030](0030-a-one-off-terminal-runs-only-a-command-an-install-left.md), which lets a
  one-off terminal run only a command an install left. Decision 2 below adds a second one-off route.
- **Proposes dated amendments to** [ADR-0026](0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md)
  decision 3 and [ADR-0045](0045-the-hub-keeps-a-thread-store.md) decision 2. Their text is in
  *Amendments to write on acceptance* below.
- **Keeps** the owner's decisions of 2026-11-04 ([Y-628](../../tracker.md)) and 2026-10-31: every
  agent runs in a non-sudo account, and on the box each agent has its own non-sudo user.
- **Reads against** [ADR-0044](0044-a-write-needs-the-owners-passkey.md) (a write needs the owner's
  passkey), [ADR-0022](0022-a-socket-may-address-a-session-rather-than-a-workspace.md) (a socket
  may address a machine), [ADR-0028](0028-yantra-installs-the-bare-minimum-on-a-machine.md) §5 (no
  password box), [ADR-0021](0021-the-relay-is-written-to-an-environment-file.md) and
  [ADR-0023](0023-the-github-grant-lives-beside-the-relay.md) (the two credentials the daemon holds),
  I-20 (the system `ssh`) and Q5 (no stream content in a log).

## Context

The owner asked for two things. The first is a Chat that is a conversation and not a coding task.
The second is a way to run root commands from the dashboard, for the owner and for the agent.

### A Chat thread is a git worktree today

Read on `main` on 2026-11-10:

- **A thread is a branch and a worktree.** `thread::open_as` makes
  `yantra/chat/<workspace>/<id>` in a worktree of `workspace.repo`
  ([`thread.rs`](../../crates/yantra-core/src/thread.rs)). `thread::list` finds threads with
  `git worktree list`. A thread with no repository cannot exist.
- **What names a thread is in git config.** The harness, the session id, the title and the issue
  live under the thread's branch (`thread::remember`, ADR-0041 decision 8). With no repository there
  is no place to keep them. [ADR-0045](0045-the-hub-keeps-a-thread-store.md)'s store is that place,
  and [Y-688](../../tracker.md) has not built it yet.
- **The chat socket loads a workspace.** `GET /api/workspaces/{name}/chat` calls `Fleet::of`, which
  calls `workspace::load` and reaches `workspace.machine`
  ([`chat.rs`](../../crates/yantrad/src/chat.rs)). ADR-0026 decision 3 already names a second form,
  *"the session-addressed form where a session is reachable without a workspace"*. No one built it.
- **The keeper is keyed on the workspace.** Its tmux session is `yantra-keep-<workspace>-<thread>`
  and its journals are in `~/.yantra/keep/<workspace>/<thread>/`
  ([`keep.rs`](../../crates/yantra-core/src/keep.rs)). A home thread needs a word in the workspace
  slot that no workspace can take. `workspace::validate_name` already refuses the keeper prefix, so
  it can refuse one more word.
- **Each turn ends in a checkpoint.** After a turn, `chat.rs` calls `checkpoint::capture` and
  `checkpoint::diff`, and a failure publishes a `Checkpoint` error to the browser. In `$HOME` there
  is no repository, so a home thread must skip the checkpoint, not fail it.
- **The `Machine` trait in `chat.rs` is the seam.** It opens, finds, starts and checkpoints a
  thread. A home thread is a second implementation of it, not a second bridge.

**So the home chat needs no new decision in ADR-0026.** Its decision 3 already allows a socket with
no workspace. Its decision 8 keeps the Chat and the TUI out of one working tree, and `$HOME` has no
TUI and no tree. What the home chat needs is ADR-0045's store, and one change to the row that
ADR-0045 decision 2 describes.

### Sudo today

- **The agent account cannot use sudo, by the owner's decision.** Y-628 makes Setup join a non-sudo
  account named `karigar`, and the machine card warns when that account can use sudo.
- **The one place the owner types a password is ADR-0030's one-off terminal.** It runs
  `ssh -tt <machine> <command>` under `pty.rs`, as the joined account, for a command that an install
  left. It takes an index, never a command string.
- **That terminal runs as the agent's account.** A shell there cannot use sudo, so it cannot serve
  the owner either.
- **Today an agent reaches every write route.** ADR-0044's Context says it: `karigar` on the Mac
  reaches the hub from the owner's untagged node, so `allowed()` passes it. [Y-687](../../tracker.md)
  builds the passkey check, and it is not built. **An owner terminal built before Y-687 would give a
  prompt-injected agent an admin shell.** That is the attack this ADR exists to stop.

### Two ways the owner terminal could log in, and why one is wrong

1. **As `karigar`, then `su - <admin>`.** This needs no new ssh key. It is unsafe. `ssh` runs the
   command through the far account's login shell, and that shell reads `~/.bashrc`, `~/.zshenv` and
   `PATH` from `karigar`'s home. The agent can write those files. A prompt-injected agent can put a
   false `su` or `sudo` first in `PATH` and record the owner's password.
2. **As the admin account itself, over its own ssh login.** The agent cannot write that account's
   home, so it cannot change what the shell runs. The cost is one line the owner adds by hand: the
   daemon's public key in the admin account's `authorized_keys`.

Option 2 is the one this ADR takes.

### What happens if the agent holds sudo

The agent reads untrusted text all day: issues, pull request comments, web pages and tool output. Any
of them can carry a prompt injection. A `NOPASSWD` rule in sudoers matches a command and its
arguments. A narrow rule such as `apt install *` still runs each package's install scripts as root.
On the hub, root reads `/etc/yantra/daemon.env`, which holds the GitHub grant and the ntfy token
(ADR-0021, ADR-0023). **A prompt-injected agent with any root path owns the machine**, and on the hub
it also owns the daemon's two credentials.

## Decision

### 1. A home chat is a Chat thread on a machine, in the agent account's `$HOME`, with no workspace

1. **New session offers *Chat in home folder* on each machine that runs sessions.** `yantra chat new
   --home <machine>` does the same from the CLI, and it takes no workspace and no `--issue`.
2. **The thread runs `claude` with its working directory at `$HOME`** of the account that joined the
   machine. The far shell expands `$HOME`. The daemon does not guess the path.
3. **It has no workspace, no repository, no branch and no worktree.** The Chat hides Diff, Revert,
   Commit, Push and Open PR for it. The daemon skips the checkpoint after each turn and publishes no
   checkpoint error.
4. **The thread store holds it.** Its row has the machine, the harness, the session id, the title and
   the status. Its workspace, branch and worktree are empty. A new keeper resumes the stored session
   id (ADR-0041 decision 8). Git config holds nothing for it, because there is no repository.
5. **The keeper uses the word `yantra-home` in the workspace slot.** The session is
   `yantra-keep-yantra-home-<id>` and the journals are in `~/.yantra/keep/yantra-home/<id>/`.
   `workspace::validate_name` refuses `yantra-home` as a reserved name, as it refuses the keeper
   prefix.
6. **The socket is `GET /api/machines/{machine}/chat?thread=<id>`**, ADR-0026 decision 3's second
   form. It authorises as the workspace socket does, and after Y-687 it checks ADR-0044's cookie at
   the upgrade. The machine name follows the ssh-destination rule, or the daemon answers `400`
   before the upgrade.
7. **It lists with the machine's other threads.** `GET /api/machines/{machine}/threads` reads the
   store. The sessions rail shows a home thread under its machine, named by its title. Close and
   resume work as they do for any thread. Remove deletes the row and the keeper's journals, and it
   deletes no file in `$HOME`.
8. **Every home thread on a machine shares one directory.** Two home threads can write the same
   files. This ADR accepts that cost, because a home chat is a conversation and there is no tree to
   isolate. Claude files each home thread's transcript in one project directory, and the stored
   session id keeps each thread on its own conversation.
9. **Claude first.** Another harness follows the same rule when its row asks for it.

### 2. The owner terminal: a login shell as the owner's admin account, over the system `ssh`

1. **The owner names the admin account for each machine once, on the machine page.** The browser
   keeps the name per machine, as a per-viewer convenience. The daemon keeps nothing. The name
   holds only letters, digits, `_`, `-` and `.`, and does not start with `-` (I-63). Any other name
   gets a `400` before the upgrade.
2. **The owner authorises the daemon's key by hand.** The machine page shows the exact line to
   append to `~<admin>/.ssh/authorized_keys`: the daemon's public key, with `from=` set to the hub's
   tailnet addresses. Yantra never writes that file. The account keeps its password, and sudo still
   asks for it.
3. **The socket is `GET /api/machines/{machine}/owner/terminal?as=<admin>`.** It opens
   `ssh -tt <admin>@<machine>` with no command, under `pty.rs`. That is the account's own login
   shell. The connection is the system `ssh` (I-20). `%C` in the `ControlPath` includes the user, so
   the owner terminal never shares `karigar`'s master. There is no tmux.
4. **The socket takes no command string.** ADR-0030's rule holds: the daemon runs nothing it was
   sent. What the owner types reaches the pty as binary frames, as every terminal's keystrokes do.
5. **The password is keystrokes and nothing else.** Nothing reads it, stores it or logs it. The
   route logs the lifecycle and never the stream (Q5).
6. **It needs ADR-0044.** The route refuses every caller without the owner's live session cookie.
   The route does not ship before Y-687, because before Y-687 an agent on another machine passes
   `allowed()`.
7. **The terminal ends when the shell does.** The daemon sends `{"exit": n}` and closes, as ADR-0030
   decision 5 does. The browser never reopens it. Closing the sheet hangs up the shell.
8. **No CLI verb.** A person at a CLI runs `ssh <admin>@<machine>` (ADR-0030 decision 6).

### 3. Sudo for the agent: no standing sudo, and a "Run in owner terminal" action

1. **The agent never holds sudo.** Yantra does not add a sudoers rule, does not offer one, and does
   not set one up. Y-628's warning on the machine card stays, and it fires on a `NOPASSWD` rule too.
2. **The Chat offers *Run in owner terminal* on a command tool item that starts with `sudo`.** The
   item shows the whole command, in monospace, before the owner acts.
3. **The action opens decision 2's terminal on the thread's machine and types the command in.** The
   browser sends the command as keystrokes after the prompt shows. It never sends Enter. The owner
   reads the command, presses Enter and types the password.
4. **The browser refuses a command with a control character**, newlines and escape sequences
   included. A newline in typed text runs the command before the owner reads it. The refusal says to
   copy the command by hand.
5. **The output does not go back to the agent.** The owner tells the agent the result in the
   composer. Feeding the output back is not decided here.

### Rejected: a `NOPASSWD` sudoers rule for the agent

The owner can write one by hand on their own machine, and Yantra cannot stop that. Yantra does not
build it, document it as a step, or offer it. The reason is the Context's last section: a
prompt-injected agent with any root path owns the machine, and on the hub it owns the daemon's
credentials. A rule narrow enough to be safe is too narrow to help, and the agent's text is never
trusted.

## Consequences

- **The owner gets a plain conversation on any machine**, and it lists, closes and resumes like a
  coding thread.
- **The home chat waits for Y-688.** With no store, a home thread has no place for its session id
  and no list to appear in.
- **The owner terminal and the Chat action wait for Y-687.** That delay is the price of not giving
  an agent an admin shell.
- **The daemon's key becomes a login to the admin account.** Whoever controls the daemon's account
  can open an admin shell, but sudo still asks for the password. `from=` limits the key to the hub.
  The owner can remove the line at any time.
- **The password crosses one more route as keystrokes**, and never as a value. CLAUDE.md §B4's two
  credentials stay two.
- **The agent still cannot run a root command alone.** Each root command needs the owner to read it,
  press Enter and type a password. That is slower, and it is the point.
- **Not decided here:** feeding the owner terminal's output back to the agent; a home chat for a
  harness other than Claude; the same action for an ACP harness's command items.

## Alternatives

- **The owner terminal as `karigar`, then `su`.** Rejected in Context: the agent controls that
  shell's start files and can record the password.
- **A password box in the dashboard.** Rejected by the owner on 2026-09-12 (ADR-0028 §5).
- **The command string on the owner terminal's socket.** Rejected: the daemon would run text it was
  sent, which ADR-0030 refused. The browser types the command and the owner presses Enter.
- **A home chat as a workspace whose `repo` is `$HOME`.** Rejected: `thread::open_as` would make a
  git worktree of a home folder that is not a repository, and every coding control would show with
  nothing to act on.
- **A separate directory for each home thread**, such as `~/.yantra/home/<id>`. Rejected: the owner
  asked for the home folder, and a conversation does not need a tree of its own.

## Amendments to write on acceptance

> **ADR-0026, decision 3, dated on acceptance (Y-698):** the session-addressed form is built for a
> home chat as `GET /api/machines/{machine}/chat`
> ([ADR-0046](0046-the-owner-types-sudo-in-an-owner-terminal.md) decision 1). A home thread has no
> working tree that a TUI shares, so decision 8's interlock does not apply to it.

> **ADR-0045, decision 2, dated on acceptance (Y-698):** a home thread's row has no workspace, no
> branch and no worktree path. Those three fields may be empty, and the machine names the thread
> ([ADR-0046](0046-the-owner-types-sudo-in-an-owner-terminal.md) decision 1).

> **ADR-0030, Consequences, dated on acceptance (Y-698):** a second one-off route opens a login shell
> as the owner's admin account. It takes no command string, so this ADR's rule holds for it
> ([ADR-0046](0046-the-owner-types-sudo-in-an-owner-terminal.md) decision 2).
