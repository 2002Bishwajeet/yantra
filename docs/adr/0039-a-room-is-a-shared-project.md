# ADR-0039 — A room is a shared project

- **Date:** 2026-10-20
- **Status:** Proposed 2026-10-20 ([Y-549](../../tracker.md)). The owner accepts or changes it.
- **Evidence:** [the rooms v2 plan](../plans/rooms-v2.md), which holds the flows, the screens, the
  test plan and the sources.
- **Changes, on acceptance:** [ADR-0038](0038-rooms-and-guest-devices.md) decisions 1, 4 and 5, and
  the list of what the daemon writes in CLAUDE.md §B1. Each gets a dated note then, and not before.
- **Reads against:** [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md),
  [ADR-0017](0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md),
  [ADR-0023](0023-the-github-grant-lives-beside-the-relay.md) (no third credential),
  [ADR-0028](0028-yantra-installs-the-bare-minimum-on-a-machine.md) (no Yantra binary on a machine),
  [ADR-0032](0032-the-appliance-keeps-the-conversation-history-encrypted.md),
  [ADR-0035](0035-a-chat-turn-outlives-its-ssh-pipe.md) (the keeper),
  [ADR-0037](0037-continue-is-a-handoff.md) (Proposed; the bundle stream).

## Context

On 2026-10-20 the owner asked for a project that two people share. Each person brings their own
agent and their own Claude account. The two people and the two agents talk while they work, and
they work on the same repository. The owner also said that rooms look bare bones and have no clear
direction.

ADR-0038 made a room a list of messages in memory, with two MCP tools and a guest grant. Five facts
shape what comes next.

1. **The appliance cannot connect to the friend's machine.** Tailscale quarantines a shared machine:
   it takes connections and cannot open one. So every byte to or from the friend travels on the
   friend's own HTTPS call. ADR-0037's ssh stream reaches only the owner's machines.
2. **A friend may have no access to the owner's repository.** GitHub access would give them every
   branch and issue, and Cursor's shared agents fail in this case for that reason.
3. **Claude Code's own cross-session messaging reaches only one account's sessions.** It cannot
   reach a friend's Claude, so a relay is still needed.
4. **A restart loses the room and every guest's place in it**, so the owner sets the room up again.
5. **ADR-0038's guest safety makes each message a tap.** A woken turn runs in `default` and the owner
   approves each message to a guest. That is safe, but it is not the seamless work the owner asked for.

## Decision

1. **A room belongs to one workspace, its home.** It has a name, a brief, a base branch, guests, a
   budget and a policy. The owner makes it from the dashboard or with `yantra room new`. An owner
   thread's first `room_send` still makes a room, homed on that thread's workspace. The owner-side
   members are the home workspace's threads and sessions. Each member's agent works in its own
   checkout under its own login.

2. **The room's definition persists; its conversation does not.** The definition is
   `~/.config/yantra/rooms/<name>.toml`, written atomically. It is configuration that the owner
   writes, like a workspace file, and holds no fleet state and no secret. Messages, presence,
   cursors, budget counts, held messages and knocks stay in memory. A restart shows one system
   message in each room.

3. **Code moves as git bundles that `yantrad` streams, and nothing is held on the appliance.** An
   outgoing handoff streams from the home machine over ssh into the friend's HTTPS download. An
   incoming handoff streams from the friend's HTTPS upload over ssh to the home machine. The home
   repository holds the room's git state as refs under `refs/yantra/room/<room>/`. Incoming work is
   fetched with `transfer.fsckObjects=true` into `in/<guest>/` refs, and Yantra never checks it out or
   merges it. A friend with no copy gets a seed bundle of the base branch once. The home machine must
   be awake for any handoff.

4. **A person and an agent are different members, and the route says which.** A post to
   `POST /api/rooms/{room}/messages` is a person; a call to `/api/mcp` is an agent. The daemon writes
   the side and the kind from identity and route, never from the body.

5. **A guest person gets a web room for that room only**, through the same share and the same grant.
   `GET /api/me` tells the web shell which routes to draw. The scope `room:<name>` now covers that
   room's messages, presence, handoffs and seed. It still covers nothing else.

6. **Each side has its own budget, 30 agent messages by default.** Only a person on that side resets
   it. A guest cannot make the owner's agents spend more.

7. **In a guest room, the default policy is *Trusted friend*.** A woken turn runs in `acceptEdits` at
   most, in its thread worktree, with the room tools pre-approved. Bash and every other tool still ask
   the owner. An owner agent's message to a guest goes out unless the `gitleaks` scan matches; then it
   is held for the owner. With no `gitleaks`, every such message is held. Every code handoff out and
   the seed need one owner tap after a `gitleaks` range scan. The *Strict* policy keeps ADR-0038's
   behaviour: `default` mode and every message held.

8. **Grants stay per device.** A new device from a Tailscale user that already has a grant shows as
   the same person, and one tap gives it the same rooms.

## Consequences

**Gained.**

- Two people with two accounts work on one repository, with or without GitHub access, and see each
  other and each other's agents in one place.
- The owner chooses each commit that leaves. A friend sees one room's handoffs, not the repository's
  branches.
- A restart keeps the room and its guests.
- Talking in a guest room needs no tap. Code and a suspected secret still do.

**Costs.**

- `yantrad` gains two streaming routes and a third configuration file kind, beside workspaces and
  guest grants. CLAUDE.md §B1 gets a dated note on acceptance.
- A guest's message can now make the owner's agent edit files in a thread worktree without a tap.
  Checkpoints revert it, and Bash still asks.
- The text scan can miss a secret with no known shape. *Strict* exists for that.
- The friend's agent runs `git` and `curl` on the friend's machine, and the friend's Claude asks the
  friend first. That is the friend's own permission, as it should be.
- A friend keeps every commit they fetched after a revoke.

**Not changed.** ADR-0038's identity check, its grant file, its knock, its wrapper, its rule that no
scope starts a task, and its immediate revoke. ADR-0011: nothing types into a pane. §B4: no secret is
stored, and no credential crosses. ADR-0023: no third credential. ADR-0028: nothing is installed on
the friend's machine but the `claude mcp add` line.

**Not verified.**

- A real share, with a real friend, a real `whois` for the sharee, and a handoff each way. That is
  Y-558's walk, after Y-535's.
- That `gitleaks git --log-opts` with a `--not` range behaves as the plan says. Y-552's podman test
  proves it.

**Not decided here.** Messages in the encrypted archive (ADR-0032). Owner threads from other
workspaces taking handoffs, which needs ADR-0037. Channels to wake the friend's TUI. A GitHub path for
the friend.
