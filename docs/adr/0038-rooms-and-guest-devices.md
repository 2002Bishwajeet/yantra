# ADR-0038 — Rooms, and guest devices

- **Date:** 2026-10-20
- **Status:** Proposed 2026-10-20 ([Y-533](../../tracker.md)). The owner accepts or changes it.
- **Evidence:** [the rooms-and-guests plan](../plans/rooms-and-guests.md), which holds the detail and
  the sources.
- **Would amend, when accepted:** [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)
  decision 1 (reads are no longer open to every peer) and
  [ADR-0033](0033-other-harnesses-speak-acp-and-claude-delegates.md) decision 5 (the MCP tools gain
  an HTTP transport in `yantrad`). Each gets a dated blockquote on acceptance.
- **Reads against:** [ADR-0011](0011-claude-code-runs-as-a-tui-in-tmux.md) (no input into a pane),
  [ADR-0017](0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md),
  [ADR-0023](0023-the-github-grant-lives-beside-the-relay.md) (no third credential),
  [ADR-0026](0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md),
  [ADR-0028](0028-yantra-installs-the-bare-minimum-on-a-machine.md) (no Yantra binary on a machine),
  [ADR-0035](0035-a-chat-turn-outlives-its-ssh-pipe.md) (the keeper),
  [ADR-0036](0036-the-dashboard-layout-syncs-through-the-daemon.md).

## Context

The owner asked on 2026-10-20 for three things. Live Claude sessions on different machines talk to
each other while they are active, and not through GitHub. A friend outside the tailnet joins with
their own Claude, on their own machine, under their own login. And the owner gives each friend's
device a limited set of permissions.

Four facts from the code and the vendors' docs shape the answer.

1. **The MCP server is not where the agents are.** `yantra mcp` is the `yantra` CLI, which only the
   appliance has. A Chat turn's `claude -p` runs on a fleet machine, and ADR-0028 puts no Yantra
   binary there. A friend's machine has none either.
2. **Every read is open to every peer.** ADR-0016 decision 1 left the `GET` routes unchecked, under
   R-22. A Tailscale share makes the friend a peer, and `/api/repos` lists the owner's private
   repositories through the owner's GitHub grant.
3. **Tailscale already proves a sharee.** A shared machine takes connections and cannot open one.
   Serve fills its identity headers for users who accepted a share, and not for tagged devices. So
   ADR-0017's path names the friend's node and user, and `allowed()` refuses the friend today.
4. **Claude Code cannot be woken in a TUI without a dialog.** Channels push a message into an
   interactive session, but they are a research preview, a custom channel needs a flag that opens a
   full-screen confirmation, and `-p` ignores it.

## Decision

1. **A room is a named list of messages in `yantrad`'s memory.** It holds the last 200 messages or
   1 MiB, and a message is at most 16 KiB. The daemon persists nothing about a room. A restart loses
   every room, member, cursor, count and pause.

2. **Agents use two MCP tools, `room_send(room, text)` and `room_read(room, wait)`.** `yantrad`
   serves them at `/api/mcp` over MCP's Streamable HTTP transport, behind `tailscale serve`, with
   POST and a JSON answer only. A Chat turn gets the server through `--mcp-config`, with an
   `X-Yantra-Thread` header that only routes. `yantra mcp` gains the same tools. The tool list and
   the argument checks live in `yantra-core`, so both transports share them.

3. **A Chat thread wakes, and a TUI reads.** A message for a member thread that is idle starts a turn
   in its keeper, with the message as the prompt. A busy thread queues messages and gets them as one
   prompt when its turn ends. A TUI session sees a message only when its agent calls `room_read`.
   Nothing types into a pane.

4. **Each room has a turn budget, 20 by default.** It counts agent messages since a person last
   acted. At the limit the room pauses, sends are refused, nothing wakes, and the owner gets one ntfy
   notification with no message text. The owner resumes it from the dashboard or with
   `yantra room resume`.

5. **The daemon labels every message from identity, and wraps it.** The label comes from `whois`
   and, for a guest, from the name in the grant. It never comes from the message. The receiver gets
   the text inside a `<room …>` element that the sender cannot close. A turn that a message starts
   runs in `acceptEdits` at most. In a room with a guest it runs in `default`, the daemon does not
   answer its requests, and the owner approves each message their agent sends to the guest.

6. **Every route checks its caller.** The owner's own untagged node passes as today. A guest passes
   only the routes its scopes name. Anyone else gets 403. Writes keep ADR-0016's live `whois`. Reads
   may keep an address-to-node answer for 30 seconds. The grant check reads memory on every request.

7. **A guest reaches the appliance by Tailscale machine sharing.** The owner shares the appliance from
   the admin console. Yantra never opens a connection to the friend. The owner limits
   `autogroup:shared` to port 443, and the daemon checks anyway.

8. **A grant is a file per device, and it holds no secret.** It is
   `~/.config/yantra/guests/<name>.toml`, with the owner's name for the device, the node's `StableID`,
   the numeric user, the scopes and the rooms. A request passes when both the node and the user
   match. `yantra guest` writes it first; `PUT` and `DELETE /api/guests/{name}` call `allowed()`. The
   daemon writes it atomically and holds it in memory.

9. **The owner grants a device that knocked.** A refused caller to `/api/mcp` is kept in memory, the
   last ten, and the Add-a-friend screen shows it. The login name is shown and never written.

10. **v1 has two scopes.** `room:<name>` reads and sends in one room. `status:<workspace>` reads one
    workspace's status. Every other route is owner-only, and a new route is owner-only until a scope
    names it. No scope starts a task, because a task spends the owner's login.

11. **A revoke is immediate.** Removing the grant refuses the device's next request and ends its open
    `room_read`. The share itself is removed in the admin console, because Tailscale's API needs a
    key that ADR-0023 keeps out of `daemon.env`.

## Consequences

**Gained.**

- Sessions on two or three machines talk while they run, with no repository in the path.
- A friend's Claude works with the owner's, and each side runs under its own login and pays for its
  own turns.
- No secret exists for a guest. There is no token to leak, to rotate or to store.
- No Yantra binary goes to a fleet machine or to a friend's machine.
- The read gate closes a hole that exists the moment any second user reaches the appliance, whether
  or not rooms ship.

**Costs.**

- `yantrad` speaks a second protocol on a request path: a small MCP subset over HTTP.
- Every read gains an identity check. A cached `whois` bounds its cost.
- The daemon writes a third kind of file, the guest grants. Like a workspace file, it is
  configuration that the owner writes, and it holds no fleet state and no secret. CLAUDE.md §B1 gets
  a dated note on acceptance.
- A woken turn is a full Claude turn. The budget bounds the count, not the size.
- A room message is untrusted text from another model. The wrapper, the mode caps, the owner's
  approval in guest rooms and the budget reduce the risk. They do not remove it.

**Not changed.** ADR-0011 (no input into a pane). §B4 and its two exceptions. `allowed()` for every
existing write. The keeper (ADR-0035). The existing task tools.

**Not verified.**

- The exact `whois` answer for a sharee on the appliance's Tailscale version.
- Whether Claude Code's HTTP MCP client keeps a 50-second `room_read` open without a timeout.
- A real share, with a real friend's device and a real `claude` on each side. That is the owner's
  walk at the end of Y-535.

**Not decided here.** A *propose a task* scope that the owner approves. Channels for the TUI, once
they leave the research preview. A room that survives a restart.
