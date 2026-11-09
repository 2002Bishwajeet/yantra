# ADR-0040 — An agent caller is tagged and scoped

- **Date:** 2026-11-05
- **Status:** Proposed 2026-11-05 ([Y-693](../../tracker.md)). The owner accepts or changes it.
- **Evidence:** the marketing agent Bilbo, on the appliance since 2026-11-05. It runs in a
  rootless podman container under its own Unix user, `marketing`. Its egress rules drop the LAN,
  the tailnet, the host and all IPv6.
- **Extends:** [ADR-0033](0033-other-harnesses-speak-acp-and-claude-delegates.md) decision 5 (the
  main agent delegates through `yantra mcp`) and
  [ADR-0038](0038-rooms-and-guest-devices.md) decisions 6 and 8 (every route checks its caller; a
  grant is a file per device).
- **Reads against:** [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md),
  [ADR-0017](0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md),
  [ADR-0023](0023-the-github-grant-lives-beside-the-relay.md) (no third credential),
  [ADR-0034](0034-the-coding-loop-writes-to-github.md).

## Context

The owner wants an autonomous agent to delegate code work through Yantra. The first one is Bilbo,
a chat agent on the appliance. It reads untrusted web pages, so a prompt injection must be
expected.

`allowed()` knows two callers today. The owner's untagged node gets everything. A guest gets the
scopes in its grant. An agent fits neither.

- **The owner's grant is too wide.** A request from the appliance comes from the appliance's own
  untagged node. If Bilbo's egress rules let it reach `yantrad`, Bilbo would pass as the owner. It
  could then start a task on any machine and any workspace.
- **A guest grant names a person's device.** It needs a Tailscale share, a login name and the
  owner's approval of each message. An agent has no person behind the device.

The agent may run on the appliance or on another machine. The owner wants one rule for both.

## Decision

1. **An agent is a third kind of caller, with its own grant.** The grant is
   `~/.config/yantra/agents/<name>.toml`. It holds the owner's name for the agent, how the agent
   is identified (decision 2), the tools it may call and the workspaces it may touch. It holds no
   secret, like a guest grant.
2. **The daemon identifies the agent by where it connects. The grant is the same either way.**
   - **On the appliance: a local socket.** `yantrad` listens on a second Unix socket,
     `/run/yantra/agent.sock`. The grant names the peer's Unix user, which the daemon reads with
     `SO_PEERCRED`. The agent's container mounts the socket. Its egress rules stay closed.
   - **On another machine: a Tailscale tag.** The agent runs on a node tagged `tag:agent-<name>`.
     The grant names the node's `StableID` and the tag. `allowed()` refuses tagged nodes today;
     it now passes a tagged node only when an agent grant matches it.
3. **An agent gets task tools only.** At most `start_task`, `task_status`, `list_tasks`,
   `wait_task` and `cancel_task`, and only on the workspaces its grant lists. It gets no terminal,
   no install, no room, no GitHub grant read and no other route. Every other request gets 403.
4. **An agent's task ends in a pull request, never a merge.** The coding loop of ADR-0034 pushes
   the branch and opens the pull request. The owner merges.
5. **The owner writes the grant.** `yantra agent add <name>` writes it first. `PUT` and
   `DELETE /api/agents/{name}` call `allowed()` and pass only for the owner. A refused agent
   caller is kept in memory, the last ten, as ADR-0038 decision 9 keeps a refused guest.

## Consequences

**Gained.** An agent can delegate code work without owner rights. An agent on the appliance needs
no Tailscale node and no hole in its egress rules. Moving the agent to another machine changes
how it is identified, not what it may do.

**Cost: a second listener.** The daemon serves the agent socket beside its TCP port. The socket
must be readable only by the users that grants name.

**Cost: a third grant file.** The daemon now writes agent grants as well as guest grants and room
definitions. CLAUDE.md §B1's list of what the daemon writes gains one line.

**Cost: tag ownership in the tailnet policy.** The owner adds `tag:agent-<name>` to `tagOwners` in
the tailnet policy before an off-box agent can join.

**Risk that stays.** A granted agent can still open pull requests with whatever the injection
wrote. The owner's review of each pull request is the last gate.

## Not decided here

- Whether a task's brief from an agent is shown to the owner before it starts.
- A budget for an agent's tasks per day.
