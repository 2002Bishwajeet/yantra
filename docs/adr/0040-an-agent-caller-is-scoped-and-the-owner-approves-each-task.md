# ADR-0040 — An agent caller is scoped, and the owner approves each task

- **Date:** 2026-11-05. Rewritten 2026-11-13.
- **Status:** Accepted 2026-11-13 by the owner ([Y-693](../../tracker.md)). The 2026-11-13
  rewrite replaces the first text after a security audit of it. Until that day the title was *An
  agent caller is tagged and scoped*, and ADR-0042 and ADR-0044 name it by that title.
- **Evidence:** the marketing agent Bilbo, on the appliance since 2026-11-05. The audit of
  2026-11-13, which read `main` at `a83190e0`. Its findings are in the Context.
- **Extends:** [ADR-0033](0033-other-harnesses-speak-acp-and-claude-delegates.md) decisions 4 and 5
  (a delegated task), [ADR-0042](0042-the-proxy-hop-is-proved-by-the-kernel.md) decision 3 (the
  kernel names the account on a socket) and
  [ADR-0044](0044-a-write-needs-the-owners-passkey.md) decision 12 (the session token), which the
  owner accepts with this ADR.
- **Changes, for an agent's task only:**
  [ADR-0034](0034-the-coding-loop-writes-to-github.md) decision 2 and
  [ADR-0023](0023-the-github-grant-lives-beside-the-relay.md) decision 4. The push runs on the hub
  with the daemon's grant. Each gets a dated note when the owner accepts this ADR.
- **Reads against:** [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md),
  [ADR-0038](0038-rooms-and-guest-devices.md) decision 10 and
  [ADR-0039](0039-a-room-is-a-shared-project.md) (the `gitleaks` scan).
- **Needs first:** [Y-814](../../tracker.md), [Y-781](../../tracker.md), [Y-782](../../tracker.md)
  and [Y-783](../../tracker.md).

## Context

The owner wants an autonomous agent to delegate code work through Yantra. The first one is Bilbo,
a chat agent on the appliance. It runs in a rootless podman container under its own Unix user,
`marketing`. Its egress rules drop the LAN, the tailnet, the host and all IPv6. It keeps the
internet, and it reads untrusted web pages. So a prompt injection must be expected.

### What changed since the first text

The first text said that Bilbo would pass as the owner. That is no longer true. ADR-0042 refuses
any other account on the hub's socket, on every route but the join. ADR-0044 asks for a passkey
session on the network. Today Bilbo is refused on every route that acts.

ADR-0044 decision 12 also added a session token. The daemon makes one for each session or Chat turn
that it starts. The token is bound to one workspace. It is built, and it waits for this ADR.

### What the audit found

Each finding is a class of weakness. The fixes are in the Decision.

1. **A grant limits the caller, not the task.** A delegated task answers each of its permission
   requests with "allow once"
   ([`delegate.rs`](../../crates/yantra-core/src/delegate.rs)). Its worktree is a directory, not a
   sandbox. So the task is a shell under the account that the machine joined with. It has that
   account's files, logins, credentials and network. Bilbo's container cannot reach the tailnet. A
   task can. A check in the daemon limits what Bilbo may ask. Only the account, and what the
   account holds, limits what the task does.
2. **A push publishes.** The owner's review of a pull request protects the default branch. It does
   not protect a secret, because the branch is on GitHub before the owner reads it. A pushed branch
   can also change a workflow file, and some workflows read repository secrets.
3. **A credential that can push can merge.** For a fine-grained token, GitHub lists the merge
   endpoint under the *Contents* write permission. The owner decided on 2026-11-13 that agent work
   uses the owner's own GitHub account. So the owner is the author of each pull request, and no
   ruleset can ask for an approval from another person. "Never a merge" then holds only if the task
   holds no GitHub credential.
4. **A task is bound to a machine, not to a repository.** For a session token, the start of a task
   checks the machine only ([`tasks.rs`](../../crates/yantrad/src/tasks.rs)). The caller names the
   repository path and the harness. Y-814 fixes this.
5. **Nothing limits the count or the length of tasks.** Each task costs memory on the machine, a
   worktree and the owner's model login. ADR-0038 decision 10 gave guests no task scope for that
   reason.
6. **A task's last message returns to the caller as free text.** Bilbo has the internet, so that
   text is a way out for a secret.
7. **The owner cannot see what an agent asked.** The log names the caller's node, not the agent.
   It does not record the brief. No screen lists the tasks.
8. **A Tailscale tag names a node, not an account on it.** ADR-0044 learned the same thing about an
   address. No agent runs on another machine today, so that path cannot be tested.

## Decision

1. **An agent is a third kind of caller, with a grant.** The grant is
   `~/.config/yantra/agents/<name>.toml`. It holds the agent's name, how the daemon identifies it,
   the workspaces, one harness, the task's account (decision 6), one level and the held paths
   (decision 7), and an end date. The budget of decision 9 is the same for every grant. The grant
   holds no secret. The daemon writes it atomically and holds it in memory.

   ```toml
   name = "bilbo"
   expires = "2027-02-11"
   harness = "codex"
   level = "propose"
   account = "bilbo-work"
   hold = ["install.sh"]

   [identity]
   kind = "unix-user"
   user = "marketing"

   [[workspace]]
   name = "landing"
   machine = "yantra-box-bilbo"
   repo = "~/src/landing"
   ```

2. **On the appliance, the agent is a Unix user on its own socket.** For each grant the daemon
   listens on `/run/yantra/agents/<name>.sock`. It reads the peer's uid with `SO_PEERCRED`. A
   request passes only when that uid is the grant's `user`. The agent's container mounts that one
   socket, and its egress rules stay closed.
   - **The uid check is the control.** The file mode is not, for the reason ADR-0042 gives.
   - **The socket has its own router.** It serves the tools of decision 3 and nothing else. An
     owner route does not exist there. Its fallback answers 403.
   - **The daemon refuses a grant for root, for its own account, for the proxy account, and for a
     member of the `yantra` group.** A rootful container shows as root, so it is refused too.
   - ADR-0042 suggested one more class on the shared socket. This ADR does not do that. The shared
     socket carries the owner class, the proxy class and the right to join. An agent's container
     must not hold a door with those behind it.

3. **An agent names a workspace and writes a brief. The daemon supplies the rest.** The machine and
   the repository come from the workspace file, and they must match the grant (decision 12). The
   harness comes from the grant. The worktree starts from the fetched default branch (Y-814). The
   tools are `start_task`, `task_status`, `list_tasks`, `wait_task` and `cancel_task`. An agent
   sees only its own tasks. It gets no steer, because a steer is a second brief. It gets no room,
   no terminal and no other route.

4. **A session token is the second identifier.** It names a session that the owner started, in one
   workspace. It keeps the room and task tools that ADR-0044 decision 12 gives it. Y-814's rule
   in decision 3 and the log of decision 11 bind it. Decisions 5, 6, 7, 9 and 10 are for a grant
   and not for a session token, because a person started that session and reads it. Y-783 removes
   its right to resume a room.

5. **The owner approves each brief before anything runs.** `start_task` from a grant records the
   brief and answers `waiting`. The daemon sends one ntfy push with the agent's name and no brief
   text. The dashboard shows the agent, the workspace, the harness and the whole brief, as plain
   text. The owner taps *Approve* or *Refuse*. Until the tap, the daemon opens no ssh connection
   and makes no worktree. A brief that waits for 24 hours ends as `expired`. *Approve*, *Refuse*
   and *Push* are owner routes under ADR-0044, and each has a `yantra agent` verb first (ADR-0012).

6. **The task runs in an account that holds no GitHub credential.** Each agent has its own account
   on the machine, which the grant names as `account`. The workspace's ssh destination logs in as
   that account. The account has no sudo. It holds a clone of the listed repositories and the
   harness's login. **It holds no git credential, no `gh` login and no ssh key that opens another
   host.** So the task cannot push, cannot open a pull request and cannot merge. This is what makes
   "never a merge" hold. A check in the daemon cannot give it, because the task is a shell. Before
   each task the daemon asks the machine three things: the account that ssh logs in as, whether it
   can use sudo, and whether `gh`, git or `~/.ssh` holds a credential. A wrong answer refuses the
   start and tells the owner.

7. **The daemon pushes, and the grant's level says when.** When the turn ends, the daemon commits
   what the worktree holds, with the agent's name as the author. It copies the commits to the hub
   over ssh. It pushes from the hub with its own grant (ADR-0023) and opens the pull request. The
   token does not cross ssh and is in no argument. The daemon takes `owner/repo` from the hub's
   record of the workspace, never from git config on the machine (Y-782). It scans and shows the
   copy on the hub, so the task cannot change the commits after the check.
   - **`propose`.** The task ends with the copy on the hub. The owner reads the diff and taps
     *Push*. The tap carries the head that the owner saw, and the daemon pushes that head only.
   - **`push`.** The daemon pushes with no tap when two checks pass. The `gitleaks` scan finds
     nothing. The diff touches no held path. The held paths are `.github/`, the files that instruct
     an agent (`CLAUDE.md`, `AGENTS.md`, `.claude/`), and the grant's `hold` list. If a check fails,
     or `gitleaks` is missing, the task waits for the owner as in `propose`.
   - **A public repository is always `propose`.** The daemon asks GitHub whether the repository is
     public before each push. A push to a public repository cannot be taken back, because anyone
     can copy the branch at once. A scan finds the shape of a token. It does not find private text
     that a task encoded. On a private repository only the owner sees a bad branch, and the owner
     can delete it.
   - The daemon writes the body of the pull request: the agent's name and the brief. The task
     writes none of it.

8. **Only the owner merges.** The merge route stays an owner route with a passkey session, and it
   merges only the head that the owner saw (Y-781). No agent route merges. The task holds no
   credential (decision 6). The owner also keeps a ruleset on the default branch that refuses a
   direct push. That ruleset is defence in depth. It cannot ask for a second person's approval,
   because the owner's account is the author.

9. **Each grant has a budget.** One task waits or runs at a time. An agent sends five briefs in any
   24 hours, approved or not, so the phone gets at most five pushes a day from one agent. A task
   runs for 60 minutes after the tap, and then the daemon stops it. A brief is at most 16 KiB. A
   request past a count gets 429 with the name of the limit, and a brief past the size gets 413.
   The counts are in memory.

10. **An agent reads four things about its task.** They are the state, the branch, the short
    statistic of the diff and the URL of the pull request. It gets no last message, no file names
    and no error text.

11. **The daemon logs each agent call, and the dashboard shows it.** One journal line holds the
    agent's name, the tool, the workspace, the task id, and the length and SHA-256 of the brief. It
    never holds the brief's text (Q5). An Agents screen lists each grant, its tasks, their briefs
    while the daemon remembers them, and the last ten refused callers.

12. **The owner writes the grant, and a grant ends.** `yantra agent add <name>` writes it first.
    `PUT` and `DELETE /api/agents/{name}` are owner routes. `expires` is required and is at most 90
    days away. The daemon sends a push on every change to a grant. The grant records each
    workspace's machine and repository. A workspace that no longer matches is refused until the
    owner writes the grant again. **A revoke is immediate:** the daemon closes the socket, ends the
    open waits and cancels the tasks that wait or run. The worktrees stay for the owner.

13. **An agent on another machine is not decided here.** `allowed()` still refuses every tagged
    node. The grant's `[identity]` table has a `kind`, so a later ADR adds a kind and changes
    nothing else.

**The done test** is these cases. Each is a test in a podman container (§B3), with a rootless
container inside for the agent.

- The grant's user starts a brief on its socket. The answer is `waiting`, and the machine has no
  worktree.
- Another uid on that socket gets 403. The grant's user on the shared socket is refused as today. A
  grant for root, the daemon's account, the proxy account or a `yantra` group member is refused.
- One table in the code lists every route, and the routers are built from it. A test walks the
  table. The agent's socket answers its five tools and 403 for every other route. A session token
  gets 403 on every owner route.
- After *Approve*, the task runs as the grant's account. A start is refused when that account has
  sudo, a `gh` login, a git credential or an ssh key.
- `propose`: the task ends with local commits, the owner's *Push* sends the head that was shown,
  and a pull request exists. A head that moved is refused. The test's token is in no command that
  ssh carries and in no argument on the hub.
- `push`, private repository: a clean diff ends in a pull request. A diff that touches `.github/`,
  or that the scan matches, waits for the owner.
- `push`, public repository: the task waits for the owner.
- A second live task and a sixth brief in 24 hours each get 429. A brief over 16 KiB gets 413. A
  task past its time is stopped.
- A revoke cancels a running task and ends an open wait.
- The answer to the agent holds the four fields of decision 10 and no other.

One check is by hand: Bilbo's real container on the box starts a brief, and the owner approves it
from the phone.

## Consequences

**Gained.** An agent can ask for code work without owner rights. The owner sees each brief before
it costs anything. A task that follows an injection cannot push, merge or publish, because its
account holds nothing to do it with. The agent on the appliance needs no Tailscale node and no
hole in its egress rules.

**Cost: Bilbo is not autonomous.** Each task needs one tap to start. A `propose` task needs a second
tap to push.

**Cost: one account for each agent on each machine it works on.** The owner makes it, joins it and
logs the harness in. The daemon checks it and does not make it.

**Cost: a listener for each grant.** The daemon serves each agent socket beside its TCP port and
its shared socket.

**Cost: the hub handles commits.** The hub needs git and scratch space, and a large repository
takes time to copy. For a private repository the account cannot fetch, so the daemon also brings
the default branch to the machine the same way. ADR-0034 decision 2 and ADR-0023 decision 4 change
for an agent's task: the push runs on the hub, and the token still never crosses ssh.

**Cost: one more file that the daemon writes.** CLAUDE.md §B1's list of what the daemon writes
gains one line.

**Cost: a restart forgets.** Waiting briefs, running tasks and the budget counts are in memory. A
restart loses them, and the agent sends its brief again.

**Risk that stays.**

- The task can read and spend the harness's login in its account.
- The task has the machine's network. A service on the tailnet or the LAN that trusts a peer also
  trusts the task.
- A brief is untrusted text that the owner reads. An owner who approves without reading it removes
  the gate.
- With `push` on a private repository, CI runs a branch that a task wrote, with the secrets that
  the workflows read.
- The state and the short statistic are a narrow way to pass a few numbers back. The budget bounds
  it at five tasks a day.

**Not verified.**

- The uid that `SO_PEERCRED` reports for a process in a rootless podman container. An id from the
  container's subordinate range has no account, so the daemon would refuse it.
- That a second account on one machine can join under its own ssh destination. A join keeps one
  block for each machine today.
- How the daemon copies the commits and pushes them. One way is `git fetch` over ssh into a scratch
  repository and `git push` with the token in the environment of the hub's git. The other is
  GitHub's Git Data API from the daemon. Both keep decision 7. The build row measures them.
- What each harness's login lets its holder reach.

**Not decided here.**

- A grant field that returns the task's last message, with a size limit and a scan.
- Whether a task from a session token takes the permission mode of its session. Today it answers
  its own requests.
- An agent on another machine (decision 13).

## Alternatives

**The shared socket, with one more class.** ADR-0042 suggested it. It needs no second listener. It
puts a door with the owner class behind it into the agent's container, and it leaves the route
list as the only wall.

**Give the task the token for one push.** The task's account could read it, because both run under
one uid. Then the task holds the owner's GitHub rights.

**A separate GitHub identity for agent work.** A ruleset could then ask for the owner's approval.
The owner declined it on 2026-11-13. Decision 6 gives the same result with no second account on
GitHub.

**A ruleset alone.** It cannot ask for an approval from a person other than the author, and the
owner is the author.

**The agent files an issue, and the owner starts a thread from it.** It needs no new caller. Bilbo
would need a GitHub credential in its container. The brief would also be on GitHub before the owner
reads it, in public for a public repository.

**A Tailscale tag for an agent on another machine.** Deferred, for finding 8.

## Sources

Accessed 2026-11-13.

- GitHub Docs, *Permissions required for fine-grained personal access tokens* (the merge endpoint
  is under *Contents*):
  <https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens>.
- Tailscale Docs, *Tags* (who applies a tag, and that a tag removes the user from a device):
  <https://tailscale.com/kb/1068/tags>.
- Yantra code read on `main` at `00229de8`: `crates/yantrad/src/write.rs` (`hop`, `presented`,
  `judge`, `gate`, `agent_may`), `crates/yantrad/src/tasks.rs` (`start`),
  `crates/yantrad/src/passkey.rs` (`mint_agent`), `crates/yantra-core/src/delegate.rs` (`choose`,
  `prepare`) and `crates/yantrad/src/main.rs` (`app`).
