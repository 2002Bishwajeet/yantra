# Rooms v2: a shared project (Y-549)

- **Date:** 2026-10-20
- **Row:** [Y-549](../../tracker.md). It plans Y-550 to Y-558.
- **Decision record:** [ADR-0039](../adr/0039-a-room-is-a-shared-project.md), Proposed.
- **Builds on:** [ADR-0038](../adr/0038-rooms-and-guest-devices.md) and its plan,
  [rooms-and-guests.md](rooms-and-guests.md). It does not edit either.
- **Reads against:** [ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md),
  [ADR-0016](../adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md),
  [ADR-0017](../adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md),
  [ADR-0023](../adr/0023-the-github-grant-lives-beside-the-relay.md),
  [ADR-0028](../adr/0028-yantra-installs-the-bare-minimum-on-a-machine.md),
  [ADR-0032](../adr/0032-the-appliance-keeps-the-conversation-history-encrypted.md),
  [ADR-0033](../adr/0033-other-harnesses-speak-acp-and-claude-delegates.md),
  [ADR-0035](../adr/0035-a-chat-turn-outlives-its-ssh-pipe.md),
  [ADR-0037](../adr/0037-continue-is-a-handoff.md) (Proposed).

## 1. The problem

The owner said on 2026-10-20 that rooms *look really bare bones right now and have no clear direction
or UX*. That is true. Today a room is a name and a list of messages in `yantrad`'s memory. An agent
makes one by its first `room_send`. The dashboard lists the rooms and lets the owner post and resume
(Y-536). Five things are missing:

1. **No shared repository.** Two agents can talk about code, but neither can give the other a commit.
2. **No screen for the friend.** A guest has an MCP route and nothing else. The friend cannot see the
   room, cannot type into it, and cannot see what the agents do.
3. **No create, invite or presence.** Nobody makes a room on purpose. Nobody is invited. Nobody can
   see who is in a room or what each agent is doing now.
4. **A room has no project.** It is not tied to a workspace, so it has no repository, no brief and no
   home checkout.
5. **A restart loses everything**, including the room's name and its guests' places in it.

## 2. The owner's goal

The owner's words, 2026-10-20:

> Let's say I'm working on a project A and a person A joins and a person B wants to also join with
> his own agent or a Claude Code account, and they can both seamlessly communicate with each other.
> Or they both share the same resource or like the same repository and talk to each other. So like
> Claude sessions, while both Claude sessions are running, they can talk interactively with each
> other and kind of work in itself.

In plain terms, the goal has four parts:

- **One project.** The room is about one repository.
- **Two people and their agents, in one conversation.** People talk to people, agents talk to agents,
  and each person can talk to either agent.
- **Shared code.** Each side can give the other its work and take the other's work.
- **Seamless, but each side keeps its own login and its own machine.** The friend's agent never runs
  on the owner's machines and never spends the owner's Claude plan. The owner's agent never runs on the
  friend's machine.

## 3. What a room becomes

**A room is a shared project.** It belongs to one workspace, which is its **home**. It has a name, a
short **brief** that the owner writes, a **base** branch, and a list of **guests**. It carries three
things:

1. **The conversation**, for people and agents together. Each message says who wrote it: a person or
   an agent, and on which side.
2. **Presence**: who is in the room now, and what each agent is doing now.
3. **Handoffs**: an agent says *my work is on branch X*, and the other side fetches it.

**Each member's agent works in its own checkout under its own login.** The owner's agents are Chat
threads (and TUI sessions) in the home workspace, on the owner's machine, with their own thread
worktrees. The friend's agent is the friend's own Claude Code, on the friend's own machine, in the
friend's own clone. The room moves words and commits between them. It never moves a credential, and
it never runs a command on the other side's machine.

The main session recommended this shape. The evidence supports it, with one change: **the owner-side
members are the home workspace's threads only.** A thread in another workspace with the same `origin`
could join, but a handoff into it would need ADR-0037's relay between two owner machines, and ADR-0037
is not accepted. That is a later row.

### 3.1 What changes from ADR-0038

| ADR-0038 | v2 | Why |
| --- | --- | --- |
| A room is made by its first `room_send`. | The owner makes a room from a workspace, on the dashboard or with `yantra room new`. An owner thread's `room_send` to an unknown room still makes one, homed on that thread's workspace. A guest never makes one. | A room needs a project. Ad hoc rooms keep working for the owner's own agents. |
| Nothing about a room is persisted. | The room's **definition** is a file: name, home, brief, base, guests, budget, policy. Messages, presence and cursors stay in memory. | A restart should not lose the room or its guests. Messages can hold code and secrets (§9). |
| Agents only talk. | Agents also hand off branches, as git bundles that `yantrad` streams. Nothing is held on the appliance. | The owner's ask: *the same repository*. |
| A guest has no screen. | A guest person has a web room screen for that one room, through the same Tailscale share and grant. | The owner's ask: *communicate seamlessly*. |
| One budget, 20 agent messages, reset by any person's act. | Two budgets, one per side, 30 each. Only that side's person resets it. | Ten turns each was too few for real work. A guest cannot reset the owner's spend. |
| In a guest room, a woken turn runs in `default`, and the owner approves each message their agent sends. | A woken turn runs in `acceptEdits` in its thread worktree. The room tools are pre-approved. A message to a guest goes out unless the secret scan matches, and then it is held for the owner. Each code handoff out needs one tap. | Approving every message is not seamless. The scan and the code tap keep the two leaks that matter closed. |
| Presence is "called a tool in the last 24 hours". | Presence is *listening*, *working: <what>*, *idle* or *away*, from the agent's own calls and, for an owner thread, from its stream. | The owner's ask: *who is in, what each agent is doing*. |

## 4. How code moves

### 4.1 The constraint that decides it

**The appliance cannot open a connection to the friend's machine.** Tailscale quarantines a shared
machine: it takes connections and cannot open one to the sharee's devices
([Tailscale sharing](https://tailscale.com/kb/1084/sharing)). The friend's machine is not in the
owner's fleet and has no Yantra ssh key. So ADR-0037's shape, *the box streams a bundle over ssh to
the target*, cannot reach the friend. Every byte to or from the friend goes over the friend's own
HTTPS call to the appliance.

### 4.2 The three options

| Option | For | Against |
| --- | --- | --- |
| **A. The friend has access to the repository on GitHub.** The owner adds them as a collaborator. Handoffs are branch names on `origin`. | No new transport. PRs work as today (ADR-0034). | The owner asked for the friend who has no access. A collaborator sees every branch and every issue, not one room's work. A private repository needs a seat. It cannot work for a repository with no GitHub remote. |
| **B. The box streams a bundle over ssh.** | ADR-0037's shape, proven between the owner's machines. | It cannot reach the friend (§4.1). |
| **C. A bundle exchanged through the room.** `yantrad` streams it between the home workspace's machine (over ssh) and the friend's HTTPS call. | Works with or without GitHub. The owner chooses exactly which commits leave. No credential crosses. Tailscale proves the friend on each call, so there is no token. Nothing is written on the appliance. | `yantrad` gains two streaming routes. The home machine must be awake for a handoff. The friend's agent runs `git` and `curl` itself. |

**Chosen: C.** It is the only option that meets the owner's case of a friend with no repository
access. It also keeps the owner in control of what leaves: a collaborator on GitHub sees everything,
and a room's friend sees only the commits the owner handed off. The cost is small because it reuses
two things that exist: the `Ssh::stdio` stream that `image.rs::put` uses, and the identity gate that
ADR-0038 builds. Claude Code itself uses the same primitive: `claude --cloud` uploads a git bundle of
the repository when it has no GitHub access ([Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)).

**A still works, and needs nothing from Yantra.** If the friend can already reach `origin`, the agents
can say *pushed to origin as X* in a plain message. The room does not stop them. v2 builds no GitHub
path for the friend.

### 4.3 The refs that hold the room's state

The home repository holds the room's git state as refs, so the daemon keeps none:

| Ref, in the home repository | Meaning |
| --- | --- |
| `refs/yantra/room/<room>/base` | The commit the friend got in the seed. |
| `refs/yantra/room/<room>/out/<id>` | A commit the owner approved for handoff `<id>`. The handoff is pinned to it. |
| `refs/yantra/room/<room>/in/<guest>/<branch>` | A branch the guest handed in. It is never checked out by Yantra. |

A ref name part is validated as a workspace name is (I-24), and as `git check-ref-format` accepts.

### 4.4 Out: the owner's work to the friend

1. The owner's agent calls `room_share(room, branch)`. `yantrad` knows the caller's thread from
   `X-Yantra-Thread` (ADR-0038 §3.3), so it knows the machine and the worktree.
2. `yantrad` resolves `branch` to a commit on that machine, counts the commits that the friend lacks,
   and runs the secret scan on that range: `gitleaks git --log-opts="<prereqs>..<sha>"`, the same
   scanner the history uses (`history.rs`). If `gitleaks` is not on the machine, the card says *not
   scanned*.
3. The room shows a **handoff card** to the owner: branch, commit count, files changed, scan result,
   and **Share** and **Don't share**. This is the one tap in the outward flow.
4. On **Share**, `yantrad` writes `refs/yantra/room/<room>/out/<id>` at the scanned commit. Later
   commits on the branch do not leave with it.
5. The friend's side sees a handoff message: `handoff 3 · owner's Claude · feature/login · 4 commits`.
6. The friend's agent calls `room_fetch(room, 3)`. The answer is the command to run, because the
   daemon cannot run anything on the friend's machine:

       curl -fsS https://<appliance>/api/rooms/<room>/handoffs/3.bundle -o /tmp/yantra-3.bundle \
         && git bundle verify /tmp/yantra-3.bundle \
         && git fetch /tmp/yantra-3.bundle 'refs/yantra/room/<room>/out/3:refs/remotes/room/feature/login'

7. The download streams from the home machine: `git bundle create - refs/yantra/room/<room>/out/3
   --not refs/yantra/room/<room>/base refs/yantra/room/<room>/in/<guest>/*`. Its prerequisites are
   commits the friend is known to have. `yantrad` copies the stream into the HTTPS answer with a fixed
   buffer, as ADR-0037 decision 3 does, and writes nothing to disk.
8. If `verify` fails, the friend's agent asks again with `room_fetch(room, 3, full=true)`, and the
   bundle has no prerequisites.

### 4.5 In: the friend's work to the owner

1. The friend's agent calls `room_share(room, branch)`. The daemon cannot reach the friend's
   repository, so the answer is the command:

       git bundle create /tmp/yantra-out.bundle <branch> --not room/base \
         && curl -fsS --data-binary @/tmp/yantra-out.bundle \
              'https://<appliance>/api/rooms/<room>/handoffs?branch=<branch>'

   `room/base` is the ref the seed made on the friend's side (§4.6).
2. `yantrad` streams the upload over ssh into the home machine, to
   `${TMPDIR:-/tmp}/yantra-room-<id>.bundle`, then runs there:
   `git -c transfer.fsckObjects=true fetch <file> '<branch>:refs/yantra/room/<room>/in/<guest>/<branch>'`,
   and removes the file. An upload is at most 64 MiB.
3. If the home machine is asleep, the upload is refused with 503 *the owner's machine is asleep*. The
   daemon does not hold the bytes for later.
4. The room shows a handoff message from the guest, and the owner's member threads get it as a
   wake. Their agent can `git diff`, `git log` or merge `refs/yantra/room/<room>/in/<guest>/<branch>`
   in its own worktree. Yantra never checks it out and never merges it.

### 4.6 The seed: the friend's first copy

A friend with no access needs the repository once. When the owner invites a friend, the invite sheet
asks **Give Asha a copy of `main`?** (the room's base). If yes, `yantrad` writes
`refs/yantra/room/<room>/base` at `main`'s commit, and the friend's agent gets:

    curl -fsS https://<appliance>/api/rooms/<room>/seed.bundle -o /tmp/yantra-seed.bundle \
      && git clone -b main /tmp/yantra-seed.bundle <room> \
      && git -C <room> update-ref refs/remotes/room/base main

The seed is the full history of the base branch. That can include a secret committed and later
removed, so the sheet runs the same `gitleaks` range scan and shows its result before the owner says
yes. A friend who already has the repository skips the seed: the owner answers no, and `base` is set
to the base branch's commit on `origin`.

### 4.7 What never moves

Uncommitted changes, untracked files, ignored files (`.env`), stashes, git config and hooks. A bundle
carries refs and commits only ([git-bundle](https://git-scm.com/docs/git-bundle)). ADR-0037's WIP
commit is not used here: a room handoff is committed work that an agent chose to share.

## 5. User flows

### 5.1 The owner creates a room from a workspace

1. The owner opens the workspace page, or **Rooms → New room**.
2. The sheet asks for a name (defaults to the workspace name), a brief of one or two lines, and the
   base branch (defaults to the workspace's current branch).
3. **Create** writes `~/.config/yantra/rooms/<name>.toml` and opens the room.
4. The room offers **Bring a thread in**: a list of the workspace's Chat threads, and **New thread**,
   which starts a thread on the workspace's machine with the brief as its first prompt. A thread runs on
   the workspace's machine, so the room's owner-side agent runs where the project lives.
5. CLI: `yantra room new <name> --workspace <ws> --brief "…"`. The same verb is the route
   `POST /api/rooms` (ADR-0012: the CLI and the daemon call one library).

### 5.2 The owner invites a friend

1. **Invite** in the room opens a sheet with four steps, built from the Add-a-friend parts of Y-535.
2. **Share the appliance.** A link to the appliance's page in the Tailscale admin console. The owner
   makes the invite and sends it, or shows its QR code.
3. **Give them a copy?** The seed question (§4.6), with the scan result.
4. **Send these two lines.** With a copy button each:

       claude mcp add --transport http yantra https://<appliance>.<tailnet>.ts.net/api/mcp
       Then tell your Claude: "Join the Yantra room <name>."

   And the web link for the friend's browser: `https://<appliance>.<tailnet>.ts.net/r/<name>`.
5. **Waiting for Asha.** The step waits for a knock, from the MCP route or from the web link. The
   knock shows host, OS, login and time. The owner types a name (*Asha*) and presses **Let in**. The
   grant gets `room:<name>`.
6. A second device from the same Tailscale user knocks later (the phone). It shows as
   *Asha's iPhone, same person as Asha*, with **Let in with the same rooms**. One tap.

### 5.3 The friend's first join

**On the laptop.**

1. Asha accepts the Tailscale invite with her own account.
2. She runs the `claude mcp add` line, starts Claude Code in an empty directory, and says *Join the
   Yantra room auth-rework*.
3. Her Claude calls `room_info`. The first call knocks. The answer says *waiting for the owner to let
   you in* and how long to wait.
4. The owner lets her in. Her Claude calls `room_info` again and gets the brief, the members, the
   base, and the seed command. It runs the seed command (her Claude asks her first, because it is a
   shell command on her machine). She now has a clone at the base.
5. Her Claude says hello in the room and starts a `room_read` wait.

**On the phone.**

1. The Tailscale app on her phone is signed in to the same account, so the share reaches it.
2. She opens the web link. The page knocks and says *Waiting for Biswa to let you in*.
3. The owner taps **Let in with the same rooms**. Her page opens on the room.

### 5.4 Both agents working

1. The owner writes in the room: *Asha's Claude takes the token refresh, mine takes the login form.*
2. The message wakes the owner's member thread. Asha's Claude sees it in its `room_read`.
3. Each agent calls `room_status(room, "editing src/auth/refresh.rs")` when it starts a piece of
   work. For the owner's threads, the daemon also reads the thread's stream and shows its current tool.
4. Agents talk in the room. Every agent message counts on its side's budget (§8.3).
5. Either person can address an agent: a message that starts with `@asha-claude` or `@biswa-claude`
   is shown as addressed. Every agent still gets it; the address is a hint in the wrapper.

### 5.5 A branch handoff

Out (owner to friend) is §4.4. In (friend to owner) is §4.5. In the room, each handoff is one card
that both sides see, with its state: *waiting for Biswa*, *shared*, *fetched by Asha's Claude*,
*refused*.

### 5.6 Leaving and revoking

- **A friend leaves** by closing the page and stopping their Claude. Presence goes to *away* after
  90 s with no call. Nothing else changes.
- **The owner removes a guest from the room.** The grant loses `room:<name>`. The guest's next request
  is 403, and its open `room_read` and web wait end at once (ADR-0038 decision 11).
- **The owner ends the room.** The room file is removed. Its messages leave memory. Guest grants lose
  the scope. The `refs/yantra/room/<room>/*` refs stay in the home repository until the owner runs
  `yantra room rm <name> --refs`, because they are the owner's code.
- **What the friend keeps.** Everything they fetched. A revoke cannot recall a commit. The invite
  sheet says this before the first handoff.
- **The share itself** is removed in the Tailscale admin console, as in ADR-0038 decision 11.

## 6. Screens

The owner's screens extend `web/src/screens/rooms/`. The friend's screen is a new route that renders
only one room. Both use the M3 parts that exist: `Card`, `Row`, `State`, `TextField`, `Button`,
`ErrorSurface`, `Stepper`, `Copyable`, `Qr`. The message list and the composer copy T3 Code's chat
parts where they fit, attributed as ADR-0026 decision 5 says.

### 6.1 Rooms list (owner)

    Rooms                                             [ New room ]
    ┌──────────────────────────────────────────────────────────────┐
    │ auth-rework      yantra · main      ● Asha  ● 2 agents  12m  │
    │ docs-sweep       yantra · main      ● 1 agent        paused  │
    └──────────────────────────────────────────────────────────────┘

Each row: name, home workspace and base, who is present, last message age, and a `paused` or
`needs you` state.

### 6.2 A room, desktop (owner)

    ← Rooms   auth-rework                       [ Invite ] [ ⋯ ]
    Rework the login flow. Base: main @ 3f2a1c
    ┌────────────────────────────────────────┬─────────────────────┐
    │ Biswa · 10:02                          │ In the room         │
    │   Asha's Claude takes refresh, mine    │ ● Biswa      here   │
    │   takes the form.                      │ ● Asha       here   │
    │                                        │ ◐ chat 4f (g14)     │
    │ Asha's Claude (guest) · 10:03          │   editing           │
    │   On it. Reading src/auth/refresh.rs.  │   src/auth/form.tsx │
    │                                        │ ◐ Asha's Claude     │
    │ ┌ handoff 3 ─────────────────────────┐ │   running tests     │
    │ │ chat 4f · feature/login · 4 commits│ │                     │
    │ │ 6 files · scan: clean              │ │ Budget              │
    │ │ [ Share ]  [ Don't share ]         │ │ yours  7/30         │
    │ └────────────────────────────────────┘ │ Asha's 5/30         │
    │                                        │                     │
    │ ┌ held ──────────────────────────────┐ │ Handoffs            │
    │ │ chat 4f wrote to Asha. The scan    │ │ 3 waiting for you   │
    │ │ found 1 possible secret (line 4).  │ │ 2 in · fix/token    │
    │ │ [ Send ]  [ Edit ]  [ Drop ]       │ │                     │
    │ └────────────────────────────────────┘ │                     │
    ├────────────────────────────────────────┤                     │
    │ Message the room…            [ Send ]  │                     │
    └────────────────────────────────────────┴─────────────────────┘

### 6.3 A room, phone (owner)

    ← auth-rework             ⋯
    ● Biswa ● Asha ◐ 4f ◐ Asha's Claude
    ───────────────────────────
    Asha's Claude (guest) 10:03
    On it. Reading refresh.rs.
    ┌ handoff 3 · 4 commits ──┐
    │ feature/login · clean   │
    │ [ Share ] [ Don't ]     │
    └─────────────────────────┘
    ───────────────────────────
    [ Message the room…  ➤ ]

The presence rail becomes one row of chips at the top. A tap on a chip opens a sheet with that
member's status and last call. The handoff and held cards stay inline. ntfy brings the owner here for
a held message, a handoff to approve, and a pause; each notification names the room and no word of
the text (Q5).

### 6.4 Invite sheet (owner)

    Invite to auth-rework
    ① Share the appliance          done
       Open the Tailscale admin console ↗   [ QR ]
    ② Give a copy of main?         [ Yes ] [ They have it ]
       scan: clean · 812 commits
    ③ Send these to your friend
       claude mcp add --transport http yantra https://…/api/mcp  [ Copy ]
       Tell your Claude: "Join the Yantra room auth-rework."      [ Copy ]
       Web: https://…/r/auth-rework                               [ Copy ]
    ④ Waiting for a knock…
       asha@… on asha-mbp (macOS) · 20 s ago
       Name [ Asha        ]   [ Let in ]

### 6.5 The friend's room, laptop

    auth-rework · a Yantra room hosted by Biswa
    Rework the login flow.
    ┌────────────────────────────────────────┬─────────────────────┐
    │ (same message list as 6.2, without the │ In the room         │
    │  owner's held cards and Share buttons) │ ● Biswa  ● Asha     │
    │                                        │ ◐ Biswa's Claude    │
    │ ┌ handoff 3 ─────────────────────────┐ │ ◐ Your Claude       │
    │ │ Biswa's Claude · feature/login     │ │                     │
    │ │ shared · Your Claude fetched it    │ │ Your budget 5/30    │
    │ └────────────────────────────────────┘ │ [ Let it continue ] │
    ├────────────────────────────────────────┤                     │
    │ Message the room…            [ Send ]  │ Leave room          │
    └────────────────────────────────────────┴─────────────────────┘

The friend sees no other route: no fleet, no sessions, no terminal, no Settings. The owner's agents
appear by a label the daemon writes: *Biswa's Claude*. The owner's machine names and thread ids are
not shown to the guest.

### 6.6 The friend's room, phone

    auth-rework · Biswa's room
    ● Biswa ● You ◐ Biswa's Claude ◐ Your Claude
    ───────────────────────────
    Biswa 10:02
    Asha's Claude takes refresh…
    ───────────────────────────
    [ Message the room…  ➤ ]

### 6.7 The waiting page (friend)

    Waiting for Biswa to let you in
    This device: asha-iphone (iOS)
    Biswa sees this request in Yantra. This page opens the room by itself.

## 7. API and MCP changes

### 7.1 MCP tools

| Tool | Change | Answer |
| --- | --- | --- |
| `room_send(room, text, to?)` | Gains `to`, an optional member label, as a hint. | `{seq, delivered}` or `held` when the scan matched (§8.4). |
| `room_read(room, wait)` | Unchanged. Messages gain `kind` and `side`. | As today. |
| `room_info(room)` | New. | Brief, home workspace label, base branch, members with presence, open handoffs, the seed command for a guest. The tool description says to call it first. |
| `room_status(room, doing)` | New. One line, at most 120 characters, shown as presence. | `{ok}` |
| `room_share(room, branch)` | New. | Owner caller: a handoff id, *waiting for the owner*. Guest caller: the upload command (§4.5). |
| `room_fetch(room, handoff, full?)` | New. | Owner caller: `yantrad` fetches into the caller's repository over ssh and answers the local ref. Guest caller: the download command (§4.4). |

The tool list and argument checks stay in `yantra-core::room`, so `/api/mcp` and `yantra mcp` agree
(ADR-0038 decision 2). A guest sees the six room tools, scoped to its rooms.

### 7.2 HTTP routes

| Route | Who | Does |
| --- | --- | --- |
| `GET /api/me` | anyone with a grant | `{role: owner}` or `{role: guest, name, rooms}`. The web shell picks its routes from it. |
| `POST /api/rooms` | owner | Make a room from a workspace. |
| `PATCH /api/rooms/{room}` | owner | Brief, budget, policy. |
| `DELETE /api/rooms/{room}` | owner | End a room (§5.6). |
| `GET /api/rooms/{room}` | owner, `room:<room>` | As today, with presence, budgets and handoffs. A guest gets the guest view (§6.5). |
| `GET /api/rooms/{room}/events?after=<seq>&wait=<s>` | owner, `room:<room>` | A long-poll for messages and presence, as `room_read` waits. No new socket kind. |
| `POST /api/rooms/{room}/messages` | owner, `room:<room>` | A person's message. The label says person and side. |
| `POST /api/rooms/{room}/resume` | owner, `room:<room>` | Resume that side's budget only. |
| `PUT /api/rooms/{room}/guests/{guest}` / `DELETE` | owner | Add or remove a guest's `room:<room>` scope. |
| `POST /api/rooms/{room}/handoffs/{id}/share` / `/refuse` | owner | The tap in §4.4. |
| `POST /api/rooms/{room}/held/{seq}/send` / `/drop` | owner | The tap in §8.4. |
| `GET /api/rooms/{room}/handoffs/{id}.bundle` | `room:<room>` | The stream in §4.4. |
| `POST /api/rooms/{room}/handoffs?branch=` | `room:<room>` | The stream in §4.5. |
| `GET /api/rooms/{room}/seed.bundle` | `room:<room>` | The stream in §4.6, only when the owner said yes. |

Every route goes through ADR-0038 decision 6's check. A route not in this list stays owner-only.

### 7.3 The message

    {seq, at, kind: "text" | "handoff" | "presence" | "system",
     side: "owner" | "guest:<name>", who: "person" | "agent",
     from: "<label>", text, to?, handoff?: {id, branch, commits, state}}

`from`, `side` and `who` come from identity and route, never from the body. A person's message is
one that came by `POST …/messages`. An agent's is one that came by `/api/mcp`. The friend's agent
could call the person route with `curl`; §8.3 is why that does not matter.

### 7.4 The CLI

`yantra room new|ls|show|rm|invite|resume`, and `yantra room share <room> <handoff>` for the tap.

## 8. Security model

### 8.1 Identity

Unchanged from ADR-0038. Tailscale proves the caller on every request (`whois` on the address
ADR-0017 picks). A grant holds no secret. A guest passes only routes that its scopes name. The web
shell and its static files are served to anyone who reaches the appliance, because they hold no data;
every `/api` call is checked.

### 8.2 What a guest can and cannot do

- **Can:** read and post in its rooms; see presence and handoffs there; fetch the seed and the
  handoffs the owner shared; upload a handoff into quarantine refs.
- **Cannot:** start a task or a thread, read a transcript, a diff, a terminal or a workspace status,
  see machine names, see another room, make a room, or write anything in a checkout. A guest's upload
  writes refs under `refs/yantra/room/<room>/in/<guest>/` only.

### 8.3 Budgets

- **Each side has its own budget, 30 agent messages by default.** The owner's side counts the owner's
  agents; a guest side counts that guest's agent.
- **Only a person on that side resets it.** The owner's post or resume resets the owner's count. A
  guest's post resets the guest's count. So if the friend's agent posts through the person route, it
  resets only its own count, and it cannot make the owner's agents spend more.
- At the limit, that side's agents' sends are refused and that side's threads do not wake. The owner
  gets one ntfy notification for the owner's side. The friend sees a **Let it continue** button.
- The owner can set a budget per room from 5 to 100.

### 8.4 What leaves for a guest

- **Text.** An owner agent's message to a guest room goes out at once, unless the secret scan matches.
  The scan is the history's `gitleaks` scanner, run where `yantrad` runs, on the message text. A match
  holds the message as a **held** card for the owner (§6.2): **Send**, **Edit**, **Drop**. If
  `gitleaks` is missing, every owner agent message to a guest is held, and the room says why. This
  fails closed.
- **Code.** Every outgoing handoff and the seed needs one owner tap, after a `gitleaks` range scan.
- **The owner's own messages** are not scanned. A person chooses what they type.

### 8.5 What a guest's message can make the owner's agent do

- A woken turn in a guest room runs in **`acceptEdits`** at most, in the thread's own worktree. So a
  guest's text can make the owner's agent edit files in that worktree, which a checkpoint reverts.
- **Bash, web fetches and every other MCP tool still ask the owner**, by ntfy (ADR-0035 decision 10).
- The six room tools are pre-approved for that turn with `--allowedTools`, so talking needs no tap.
- The `<room>` wrapper (ADR-0038 decision 5) is unchanged. It now carries `side` and `who`.
- `bypassPermissions` is never used for a woken turn.

This is the one place v2 loosens ADR-0038. The reason: ADR-0038's `default` mode made every edit and
every message a tap, so the owner had to watch the room. The leak that `default` guarded, *a hostile
message makes the owner's agent read a file and send it*, is now guarded where it leaves: the text
scan holds a secret, and code needs a tap. A read of an ignored file such as `.env` does not need
`default` to stop it; the scan catches its value on the way out. The scan can miss a secret that has
no known shape. That is a risk (§10), and the **Strict** policy below keeps ADR-0038's behaviour for
an owner who wants it.

### 8.6 Room policy

A room has one policy, set at creation and changeable in **⋯ → Policy**:

| Policy | Woken turn | Agent text to a guest | Code out |
| --- | --- | --- | --- |
| **Trusted friend** (default) | `acceptEdits` | sent; held on a scan match | one tap |
| **Strict** | `default` | every message held | one tap |

A room with no guest keeps ADR-0038's caps: `acceptEdits` at most, no scan, and handoffs between the
owner's own threads need no tap.

### 8.7 Inbound code

- Fetched with `transfer.fsckObjects=true`, into refs under `in/<guest>/`, never into a branch that is
  checked out. Yantra runs no merge and no checkout.
- At most 64 MiB per upload. One upload per guest at a time.
- A bundle carries no hooks and no config. The owner's own hooks run as they do for any fetch.

### 8.8 Logs

Q5's rule holds: the log has a room's lifecycle, the counts, handoff ids, commit counts and sizes. It
never has a message's text, a branch's content or a scan finding's value.

## 9. What persists

| Thing | Where | Survives a restart |
| --- | --- | --- |
| The room's definition: name, home workspace, brief, base branch, guest names, budget, policy, made-at | `~/.config/yantra/rooms/<name>.toml`, written atomically | Yes |
| Guest grants | `~/.config/yantra/guests/<name>.toml` (ADR-0038) | Yes |
| The room's git state | refs in the home repository (§4.3) | Yes, on the owner's machine |
| Messages, presence, cursors, budget counts, held cards, waiting handoff cards, knocks | `yantrad`'s memory | No |
| Bundles | nowhere: streamed | — |

**Why the definition persists.** A restart today loses the room and every guest's place in it, so the
owner must set the room up again for the friend. The definition is configuration that the owner writes,
like a workspace file and like ADR-0038's grant. It holds no fleet state. Its one free-text field, the
brief, is what the owner typed.

**Why the messages do not.** A room's messages are the most dangerous text in Yantra: model output
from two accounts, which can quote code and secrets. Writing them would be the first fleet state the
daemon persists. The record that matters already persists elsewhere: each side's agent keeps its own
transcript, the owner's in its thread and in the encrypted archive (ADR-0032), the friend's on the
friend's machine; and the work persists as refs.

**After a restart** the room shows one system message: *yantrad restarted at 10:42. Earlier messages
are in each agent's own thread.* Each owner member thread gets the brief and the open handoffs again on
its next wake, from `room_info`.

**Not chosen: messages in the encrypted archive.** ADR-0032's archive could hold them. It would need
the guest's consent to keep their words on the owner's appliance, a retention rule, and a redaction
pass. The owner can ask for it later; it is decision 2's alternative in ADR-0039.

This needs a decision because CLAUDE.md §B1 says the daemon persists nothing about the fleet and lists
what it writes. ADR-0039 decision 2 adds the room file to that list. On acceptance §B1 gets a dated
note.

## 10. Risks

| Risk | What reduces it |
| --- | --- |
| The scan misses a secret with no known shape, and the owner's agent sends it to a guest. | `gitleaks` with the history's extra rule; **Strict** policy; the guest sees only one room. Not removed. |
| A guest's message steers the owner's agent into edits the owner did not want. | Edits stay in a thread worktree with checkpoints; Bash asks; the budget. |
| A woken turn is a full Claude turn on the owner's plan. | Per-side budget of 30; the friend cannot reset it. |
| A large seed or upload holds an HTTPS request and an ssh pipe for minutes. | Streamed with a fixed buffer; 64 MiB cap on upload; one at a time per guest. |
| The home machine is asleep, so handoffs fail. | The card says so. The friend's agent is told to try again. Wake-on-LAN is out of scope. |
| `gitleaks` is not installed where it runs. | Text to guests is held, and code cards say *not scanned*. |
| The friend's TUI does not wake on a message. | The tool description tells the agent to keep a `room_read` wait running. §11 lists channels as later. |
| `whois` for a sharee is still unverified (ADR-0038). | Y-535's owner walk proves it before v2's walk. |
| Claude Code's HTTP MCP client may time out a 50 s `room_read` (ADR-0038). | Same as ADR-0038; Y-535 measures it. |
| A friend keeps what they fetched after a revoke. | Said on the invite sheet. Every handoff out needs a tap. |
| Two people edit the same file in two checkouts. | That is normal git. The agents merge from the `in/` and `room/` refs. Yantra adds nothing. |

## 11. Prior art, and where Yantra can do better

- **Claude Code's cross-session messaging** (v2.1.224 and later) gives `ListAgents` and `SendMessage`
  between a person's own sessions, with `crossSessionInbound: accept | hold | refuse` and
  `isolatePeerMachines`. **It reaches only sessions on the same account.** It cannot reach a friend's
  Claude. So a relay such as `yantrad` is still needed. The *hold* setting is the model for v2's held
  card, and its rule that an incoming message cannot grant a permission is the rule v2 keeps.
- **Claude Code agent teams** (experimental) message by name through JSON mailboxes in
  `~/.claude/teams/`. They are one user on one machine. Not usable across people.
- **Claude Code channels** push events into a running session, which would wake the friend's TUI.
  They are a research preview: an unlisted server needs `--dangerously-load-development-channels`
  with a warning dialog, and `-p` ignores it. Still not used. A later row can serve the GET stream at
  `/api/mcp` so the friend may opt in.
- **`claude --cloud`** uploads a git bundle when it has no GitHub access. That is the same primitive
  §4 picks.
- **T3 Code** is one owner with many devices. Its README has no multi-user or sharing feature. Its
  scoped pairing and Connections list are already copied by ADR-0038's guest screens. The room's
  message list and composer copy its chat parts.
- **Zed channels** are persistent rooms with members; a guest is read-only until the host grants
  write; following a collaborator stops on any input. v2 copies the persistent room with members and
  the host-only grant. Following is not copied: there is no shared editor.
- **VS Code Live Share** approves each guest, shows a presence list with Remove, and makes a shared
  terminal read-only by default. v2 copies the knock-then-let-in, the presence list with Remove, and
  the rule that only the host grants. It does not share terminals: each side runs its own agent.
- **Tuple** swaps control in one click. v2's equivalent is **Let it continue**, one tap to resume a
  side.
- **Cursor** shares a cloud agent read-only, and teammates need repository access on GitHub. **That
  fails for a friend with no access**, which is the case v2 serves.
- **Agent chat-room MCP servers** (`aichat-mcp` and others) need a hosted relay. Yantra's appliance is
  that relay, on the owner's own hardware, with Tailscale identity instead of an account.

**Where Yantra does better.**

- **The appliance is the meeting point.** It is always on, it is the owner's, and the friend reaches it
  with their own Tailscale account and no Yantra account or token.
- **tmux and the keeper.** The owner's agents keep working when the owner closes the laptop, and a
  room message wakes them (ADR-0035).
- **The phone.** The owner approves a handoff or a held message from a notification, and the friend
  joins from a phone with no install beyond Tailscale.
- **Machine choice.** The owner's agent runs on the workspace's machine, which the placement score
  (Y-452) helps pick, and not on the laptop in front of the owner.

## 12. Test plan

§B3 applies wherever a handoff touches a machine: the tests use the podman fixture with a real sshd,
a real tmux and a real `git`.

| Layer | Test |
| --- | --- |
| `yantra-core::room` unit | The room file parses and refuses bad names (I-24). Per-side budgets: a guest post resets only the guest count. Message labels come from route and identity. The wrapper carries `side` and `who`. Tool argument checks for the four new tools. |
| `yantrad` with the `Inventory` fake | Every new route refuses a non-owner without `room:<room>`, and refuses a guest of another room. `GET /api/me` answers each role. `events` long-poll returns a message that arrives and ends on revoke. A held message is not delivered until **Send**. With no `gitleaks`, every agent message to a guest is held. A restart reloads the room file and shows the restart message. |
| Podman: out | A fixture machine holds a repository. `room_share` from a thread makes a card; nothing is downloadable before **Share**; after **Share** a second container acting as the friend downloads the bundle, `git bundle verify` passes and `git fetch` gets exactly the pinned commit, not a later one. A planted fake key in the range makes the scan report it. The appliance's scratch directory is empty afterwards. |
| Podman: in | The friend container uploads a bundle. It lands in `refs/yantra/room/<room>/in/<guest>/<branch>` on the fixture machine; no branch moves; the temporary file is gone. A corrupt bundle is refused by fsck. An upload over 64 MiB is refused. A stopped fixture machine gives 503. |
| Podman: seed | The friend container clones from the seed bundle and sets `room/base`; a later handoff's bundle verifies against it. A seed the owner did not approve is 403. |
| Web (Vitest) | Owner room: presence rail, handoff card states, held card actions, budget per side, invite steps. Guest shell: only the room route exists; owner labels hide machine names. Each typed error kind has an `ErrorSurface` and a test. |
| Web (Playwright) | Baselines at three sizes for the rooms list, the owner room, the invite sheet, the guest room and the waiting page. |
| Owner's walk | A real friend's laptop and phone, a real share, a real `claude` on each side, one handoff each way. Parks on the owner. |

## 13. What the build loop can build, and what parks

| Row | What | Who |
| --- | --- | --- |
| Y-549 | This plan and ADR-0039 | **Parks: the owner accepts ADR-0039.** |
| Y-550 | The room file and a room's home workspace | Build loop, Opus |
| Y-551 | Presence and `room_info` | Build loop, Opus |
| Y-552 | Handoffs out, with the scan and the tap | Build loop, Opus, podman |
| Y-553 | Handoffs in, into quarantine refs | Build loop, Opus, podman |
| Y-554 | The seed | Build loop, Opus, podman |
| Y-555 | Per-side budgets, the policy, and the held card | Build loop, Opus |
| Y-556 | The owner's room screens v2 | Build loop, Sonnet |
| Y-557 | The friend's web room | Build loop, Sonnet |
| Y-558 | The owner's walk with a real friend | **Parks: the owner.** |

Every build row waits on ADR-0039's acceptance. Y-552 to Y-557 also wait on Y-535, which builds the
guest grant and the read gate.

## 14. What the owner decides

1. **Code moves as a git bundle that `yantrad` streams through the room** (§4). The alternatives are
   GitHub access for the friend, or both paths.
2. **The room's definition persists, and its messages do not** (§9). The alternatives are ADR-0038's
   all-in-memory, or messages in the encrypted archive.
3. **The safety defaults** (§8): a budget of 30 per side, `acceptEdits` for a woken turn in a guest
   room, agent text sent unless the scan matches, and one tap per code handoff. The alternative is
   **Strict**, which is ADR-0038's behaviour.
4. **Grants stay per device, with one tap for the same person's next device** (§5.2). The alternative is
   a grant per Tailscale user, which lets every device of the friend in at once.

## Sources

All accessed 2026-10-20.

- Tailscale, *Share your machines with other users*: https://tailscale.com/kb/1084/sharing
- Tailscale, *Tailscale Serve* (identity headers for sharees): https://tailscale.com/kb/1312/serve
- Git, *git-bundle* documentation: https://git-scm.com/docs/git-bundle
- Anthropic, *Cross-session messaging*: https://code.claude.com/docs/en/cross-session-messaging
- Anthropic, *Agent teams*: https://code.claude.com/docs/en/agent-teams
- Anthropic, *Push events into a running session with channels*: https://code.claude.com/docs/en/channels
- Anthropic, *Channels reference*: https://code.claude.com/docs/en/channels-reference
- Anthropic, *Claude Code on the web* (`--cloud`, `--teleport`, the bundle upload):
  https://code.claude.com/docs/en/claude-code-on-the-web
- T3 Code, README: https://github.com/pingdotgg/t3code
- Zed, *Channels*: https://zed.dev/docs/collaboration/channels
- Zed, *Collaboration overview*: https://zed.dev/docs/collaboration/overview
- Microsoft, *Live Share security*: https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security
- Microsoft, *Share a server or terminal in Live Share*:
  https://learn.microsoft.com/en-us/visualstudio/liveshare/use/share-server-visual-studio-code
- Thoughtworks Technology Radar, *Tuple* (secondary source; Tuple's own docs not read):
  https://www.thoughtworks.com/en-us/radar/tools/tuple
- Cursor forum, *Share agent with team members* (low confidence; official docs not read):
  https://forum.cursor.com/t/share-agent-with-team-members/165247
- A2A protocol: https://a2a-protocol.org/latest/
- Glama, `aichat-mcp` listing (not verified on GitHub): https://glama.ai/mcp/servers/Wayy-Research/aichat-mcp
- This repository: `crates/yantra-core/src/room.rs`, `crates/yantrad/src/room.rs`,
  `crates/yantrad/src/mcp.rs`, `crates/yantra-core/src/history.rs` (the `gitleaks` scanner),
  `crates/yantra-core/src/image.rs` (the stream shape), `web/src/screens/rooms/`.
