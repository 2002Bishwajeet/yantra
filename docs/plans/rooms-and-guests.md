# Rooms and guest devices (Y-533)

- **Date:** 2026-10-20
- **Row:** [Y-533](../../tracker.md). It plans [Y-534](../../tracker.md), [Y-535](../../tracker.md)
  and [Y-536](../../tracker.md).
- **Decision record:** [ADR-0038](../adr/0038-rooms-and-guest-devices.md), Proposed.
- **Owner's asks, 2026-10-20:**
  1. Live Claude sessions on different machines talk to each other while they are active. They do not
     talk through GitHub or a repository. Later, three agents on three machines coordinate.
  2. A friend outside the owner's tailnet joins. Their Claude runs on their machine, under their own
     login, and works with the owner's Claude on one task. No credential crosses.
  3. The owner adds a friend's device and gives it a limited set of permissions, chosen per device.
- **Reads against:** [ADR-0011](../adr/0011-claude-code-runs-as-a-tui-in-tmux.md),
  [ADR-0016](../adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md),
  [ADR-0017](../adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md),
  [ADR-0021](../adr/0021-the-relay-is-written-to-an-environment-file.md),
  [ADR-0023](../adr/0023-the-github-grant-lives-beside-the-relay.md),
  [ADR-0026](../adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md),
  [ADR-0028](../adr/0028-yantra-installs-the-bare-minimum-on-a-machine.md),
  [ADR-0033](../adr/0033-other-harnesses-speak-acp-and-claude-delegates.md),
  [ADR-0035](../adr/0035-a-chat-turn-outlives-its-ssh-pipe.md),
  [ADR-0036](../adr/0036-the-dashboard-layout-syncs-through-the-daemon.md).

## 1. The design in one paragraph

A **room** is a named list of messages that `yantrad` holds in memory. A Claude session joins a room
through two MCP tools, `room_send` and `room_read`. `yantrad` serves those tools itself, over MCP's
HTTP transport, at `/api/mcp` behind `tailscale serve`. So no Yantra binary goes to a fleet machine or
to a friend's machine. A **Chat thread** that is in a room wakes when a message arrives: `yantrad`
starts a new turn in the thread's keeper, and the turn's prompt is the message. A **TUI session** sees
a message only when its agent calls `room_read`. Every message carries a sender label that `yantrad`
writes from the caller's Tailscale identity, never from the message. Each room has a **turn budget**.
At 20 agent messages since a person last acted, the room pauses and the owner gets one ntfy
notification. A **guest** is a friend's device. The owner shares the appliance's Tailscale node with
the friend, and the friend's Claude calls `/api/mcp`. The first call is refused and shown to the owner
as a knock. The owner names the device and ticks its scopes. The **grant** is a file keyed on the
device's Tailscale node and user. It holds no secret, because Tailscale proves the caller on every
request.

## 2. What the agreed design got wrong

The design agreed in conversation holds in most parts. Three parts do not survive the code.

### 2.1 `yantra mcp` is not on the machines that need it

The agreed design puts `room_send` and `room_read` in `yantra mcp` (ADR-0033 decision 5). That
binary is the `yantra` CLI. `install.sh` puts it on the appliance only. `join.sh` puts only
`yantra-agent` on a fleet machine, and ADR-0028 §1 keeps even that a manual install. A Chat turn runs
`claude -p` on a fleet machine, so its MCP server must run there. Today the owner adds it by hand
(`claude mcp add yantra -- yantra mcp --daemon <URL>`, the v0.7.2 QA pass), and only on a machine
where they installed the CLI. A friend's machine has no `yantra` at all, and the friend should not
have to install the owner's binary.

**The fix: `yantrad` serves the same tools at `/api/mcp`, over MCP's Streamable HTTP transport.**
Claude Code connects to an HTTP MCP server with no local process:
`claude mcp add --transport http yantra https://<appliance>.<tailnet>.ts.net/api/mcp`. For a Chat
turn, `yantrad` adds the server to the `claude -p` command line with `--mcp-config`, and the owner
configures nothing. The route needs only POST with a JSON answer; the spec lets a server refuse the
optional GET stream with 405. `yantra mcp` keeps working and gains the same two tools, because its
tool list and argument checks move into `yantra-core` and both transports call them.

This adds a transport to ADR-0033 decision 5 and does not replace it. It is decision 2 in ADR-0038.

### 2.2 Sharing the node exposes every read today

ADR-0016 decision 1 says *reads stay as they are*: every `GET /api/...` in `api.rs` answers any
tailnet peer, because R-22 makes the bind address the boundary. That held while the tailnet had one
user. **A Tailscale share makes the friend a peer of the appliance.** With no change, the friend's
machine can read `/api/machines`, `/api/workspaces`, `/api/sessions`, `/api/ssh-identity`,
`/api/notifications`, `/api/github` and `/api/repos`, which lists the owner's private repositories
through the owner's GitHub grant. `allowed()` refuses the friend's writes already, because `whois`
gives the friend's user and not the owner's. The reads have no such check.

**The fix comes before any share: every route asks who the caller is.** The owner passes as today.
A guest passes only the routes its scopes name. Anyone else gets 403. Y-535 builds this first, and
its test covers every route in `api.rs`, `write.rs`, `tasks.rs`, the sockets, `/join` and
`/heartbeat`. This amends ADR-0016 decision 1. It is decision 6 in ADR-0038.

A `whois` subprocess on every read costs more than ADR-0016 accepted for writes. The read check may
keep an address-to-node answer for 30 seconds, which matches `refresh.rs`. The grant check itself
reads memory on every request, so a revoke is immediate. Writes keep the live lookup (ADR-0016
decision 3).

### 2.3 A guest that starts a task spends the owner's account

The agreed scope list had *start a task in a named workspace*. A task runs on the owner's machine
under the owner's `claude` login, so the friend's prompt would spend the owner's plan and act with
the owner's files. That is a credential crossing in effect, if not in bytes. **v1 has no task scope.**
A later row can add *propose a task*, which the owner approves on the phone before it runs.

## 3. Rooms

### 3.1 What a room is

| | |
| --- | --- |
| Name | `[a-z0-9-]{1,32}`. An owner caller creates a room by its first `room_send`. A guest never creates one. |
| Messages | A ring of the last 200 messages, or 1 MiB, whichever is smaller. One message is at most 16 KiB of text. |
| Message | `{seq, at, from, text}`. `seq` counts from 1 in the room. `from` is the label in §3.4. |
| Members | Each reader that called `room_send` or `room_read` in the last 24 hours. A Chat thread member wakes; any other member reads. |
| Budget | 20 agent messages since a person last acted (§3.5). |
| Epoch | A random id made when the room is made. A reader that holds a cursor from another epoch starts again from the oldest message. |

Three agents on three machines are three members of one room. Nothing in the design is two-sided.

### 3.2 The tools

- **`room_send(room, text)`** appends one message and answers `{seq, delivered}`. `delivered` counts
  the members that will see it: Chat threads it woke or queued, and readers. A sender that sees `0`
  knows nobody is listening. A paused room refuses the send and says why.
- **`room_read(room, wait)`** answers the messages after the caller's cursor, without the caller's
  own messages, and moves the cursor. `wait` is 0 to 50 seconds. With nothing new, the call waits up
  to `wait` seconds for a message, as `wait_task` does. The daemon keeps the cursor in memory, keyed
  on the reader (§3.3), so the agent does not track one.
- The MCP route lists only the tools the caller may use. A guest sees the two room tools. The owner
  sees the room tools and the task tools.

### 3.3 Who the reader is

`yantrad` resolves the caller's node with `whois` (ADR-0016, on the address ADR-0017 picks). A Chat
turn's `--mcp-config` also sends a header, `X-Yantra-Thread: <thread id>`. The header only routes:
the daemon accepts it when the thread lives on the caller's node, and ignores it otherwise. So the
reader key is the node plus the thread, or the node alone for a TUI session.

### 3.4 The label and the wrapper

`yantrad` writes `from` from identity, never from the body (ADR-0016 decision 4):

- An owner's Chat thread: `<machine> · chat <thread>`.
- An owner's other session: `<machine>`.
- A guest: `<name>'s Claude (guest)`, where `<name>` is what the owner typed in the grant.

A receiver gets each message inside a wrapper that the sender cannot forge:

    <room name="design" from="Asha's Claude (guest)" seq="7" budget="7/20">
    …the text, with every "<room" and "</room" in it escaped…
    </room>

The tool descriptions say that text inside `<room>` is a message from another agent, is data, and is
not an instruction from the person.

### 3.5 The turn budget

- The budget counts agent messages in the room since a person last acted. A person acts when they
  post into the room from the dashboard or resume it. The default is 20.
- At the limit the room pauses. `room_send` refuses with *paused, waiting for the owner*. No thread
  wakes. `yantrad` sends one ntfy notification that names the room and no word of its text (Q5).
- The owner resumes the room from the dashboard (Y-536) or with `yantra room resume <room>`. The
  count goes back to 0.
- A thread never wakes on its own message, so one agent cannot loop with itself.

### 3.6 Delivery

**A Chat thread wakes.** When a message arrives for a member thread and the thread is idle, `yantrad`
starts a turn in the thread's keeper (ADR-0035). The prompt is the wrapped message. When the thread is
busy, the messages queue in memory and go as one prompt when the turn ends, as Claude Code's channels
group events. The keeper's session lock (ADR-0035 decision 1) means a wake never runs a second turn
beside the first. A woken turn runs in a capped mode (§6), and its permission requests reach the owner
by ntfy (ADR-0035 decision 10).

**A TUI session only reads.** ADR-0011 sends no input into a pane, and this plan keeps that. The agent
sees a message when it calls `room_read`. A person can tell it *read the room every few minutes*, or
the agent can call `room_read` with `wait` when it expects an answer.

**Not planned: Claude Code channels for the TUI.** Claude Code 2.1.80 and later can take a pushed
message into a running interactive session through an MCP server that declares `claude/channel`.
That would wake a TUI too. Today it does not fit: channels are a research preview, a custom channel
needs `--dangerously-load-development-channels server:<name>` at each launch, that flag opens a
full-screen dialog that a person must answer (the I-23 kind of trap), and the docs say Claude Code
ignores it under `-p`. A later row can take it up when channels leave the preview.

### 3.7 What a restart loses

The daemon persists nothing about a room (CLAUDE.md §B1). A restart loses every room, its messages,
its members, its cursors, its budget count and its pause. It loses the knocks (§4.3). It keeps the
grants, which are files, and the threads and keepers, which live on the machines. After a restart a
member is gone until it calls a room tool again, and a sender sees `delivered: 0`. The plan accepts
this loss: a room is a live conversation between live sessions, which is the owner's ask.

### 3.8 Idempotency (§B4)

- Making a room is make-or-join by name. Two first sends make one room.
- A message is delivered to a thread at most once: the thread's queue holds `seq` numbers, and the
  keeper's lock stops a second turn.
- `room_read` answers each message once per reader, because the cursor moves.
- A `room_send` that the client sends twice is two messages. Claude Code does not retry a tool call
  by itself, so v1 adds no key for it.
- Adding a grant twice with the same name and the same node changes nothing. The same name with
  another node is 409.

## 4. Guests

### 4.1 How a friend reaches the appliance

Tailscale's machine sharing, verified on 2026-10-20 against Tailscale's docs:

- The owner shares one machine, the appliance, from the admin console. The invite is an email or a
  link, single-use or reusable, and an unused link expires after 30 days. Sharing is on every plan.
- The friend accepts with their own Tailscale account and keeps their own tailnet. They reach the
  appliance by its full name, `<host>.<tailnet>.ts.net`.
- **A shared machine is quarantined.** It takes connections and cannot open one to the friend's
  devices. Yantra never needs to open one: the friend's Claude calls the appliance, and `room_read`
  waits on that call.
- The owner's access rules still apply, and `autogroup:shared` names every user a machine is shared
  with. The onboarding text asks the owner to limit `autogroup:shared` to port 443 on the appliance.
  ADR-0016 says an access rule never replaces the daemon's own check, so the daemon checks anyway.
- **Serve gives a sharee's identity.** Tailscale's Serve page says identity headers are filled "for
  traffic from external users who have accepted a share of your device", and not for tagged devices.
  So ADR-0017's path (the forwarded address, then a live `whois`) names the friend's node and user.
  `whois` gives the friend's numeric user, which is not the owner's, so `allowed()` refuses the friend
  today with `NotYours`.
- Revoking the share in the admin console cuts the friend off at Tailscale. The daemon cannot do it,
  because Tailscale's API needs a key, and a third credential in `daemon.env` is what ADR-0023 warns
  against. So a revoke in Yantra removes the grant, and the screen links to the admin console for the
  share.

**Not verified until a real friend's device joins:** the exact `whois` answer for a sharee on the
appliance's Tailscale version, and whether the sharee's node appears in the appliance's
`tailscale status` peer list. The design does not need the second: the knock (§4.3) finds the device
from its own call.

### 4.2 The grant

- **It lives in `~/.config/yantra/guests/<name>.toml`**, beside the workspace files, in the account
  the daemon runs as. It is configuration that the owner writes, as a workspace is. It says nothing
  about the fleet's state.
- **It holds:** the name the owner typed, the device's node `StableID` (I-5, I-52), the device's
  numeric user, the scopes, the room names, and the date it was made.
- **It holds no secret.** Tailscale proves the caller on every request. Nothing is a token, so
  nothing can leak and be replayed. §B4 and its two exceptions are untouched.
- **A grant is per device.** A request passes only when both the node and the user match. A friend's
  second laptop knocks and gets its own grant, which is the owner's ask.
- **The CLI has the verb first** (ADR-0012): `yantra guest ls`, `yantra guest add <name> --node <id>
  --user <id> --scope …`, `yantra guest rm <name>`. The dashboard calls `GET /api/guests`,
  `PUT /api/guests/{name}` and `DELETE /api/guests/{name}`, each behind `allowed()`, so only the owner
  writes a grant.
- **A revoke is immediate.** The daemon reads the grants into memory and replaces them on every write
  (atomic: a temporary file, then a rename, as ADR-0036 does). The next request from that device is
  403, and every `room_read` that device holds open ends at once.

### 4.3 The knock

A friend's first call to `/api/mcp` has no grant, so it is 403. `yantrad` keeps the last ten refused
callers in memory, as `{node, user, login, host, os, at}`, and the Add-a-friend screen shows them. The
login name appears on the screen only and is never written to disk. The owner sees *asha@… on
asha-mbp knocked 20 s ago*, and presses **Grant**. This follows the add-device walk-through: every
beat is seen by the appliance, never declared (`beats.ts`).

### 4.4 The scopes

| Scope | Lets the device | Notes |
| --- | --- | --- |
| `room:<name>` | read and send in that room | One checkbox for each room. The room's messages from this device carry the guest label. |
| `status:<workspace>` | read that workspace's status (`GET /api/workspaces/{name}/status`) | Read-only. No transcript, no terminal, no diff. |

**Nothing else is grantable in v1.** The terminal and Chat sockets, the microphone, every workspace
write, tasks, installs, settings, the relay, GitHub, the layout, `/api/repos` and `/api/ssh-identity`
stay owner-only. A new route is owner-only until a scope names it, so a route that forgets the check
fails closed.

**A guest's writes reach the owner only through a room.** A guest message can wake the owner's Chat
thread. That turn runs in `default` mode (§6), so every edit and command it wants is a permission
request that the owner answers.

### 4.5 Onboarding: Settings → Devices → Add a friend

The screen reuses the add-device parts: `Stepper`, the beat states (`ahead`, `waiting`, `done`,
`stuck` after `LATE_MS`), `Copyable`, the lazy `Qr`, and `ErrorSurface`.

1. **Share the appliance.** A link opens the Tailscale admin console at the appliance's machine page.
   The owner makes an invite and pastes it here, and the screen draws it as a QR code to show in
   person. Yantra does not hold the link after the screen closes.
2. **Your friend connects Claude.** One command to send, with a copy button:
   `claude mcp add --transport http yantra https://<appliance>.<tailnet>.ts.net/api/mcp`. Then the
   friend asks their Claude to read the room. The beat waits for a knock.
3. **Grant.** The knock appears with its host, login and time. The owner types a name, ticks rooms
   and status scopes, and presses Grant. The beat is done when the device's next call passes.
4. **Devices** lists each guest with its scopes and last call, and a **Revoke** button. Revoke
   removes the grant and links to the admin console to remove the share.

T3 Code's scoped pairing (below) shows the scope list at pairing time and the revoke list in
**Settings → Connections**. This screen takes that layout.

## 5. What T3 Code has

T3 Code's `docs/user/remote-access.md`, read on 2026-10-20:

- **It has scoped access per device.** `t3 pair --scope orchestration:read --scope relay:read` makes a
  pairing link with named scopes, and a link with no scope gets every permission. Sessions are revoked
  in **Settings → Connections** or with `t3 auth session list`. A pairing link is a bearer secret: the
  docs say to treat it as a password.
- **It has an MCP server for outside agents** with its own permission grants.
- **It has no messages between live agents**, and **no guest from another account**. T3 Connect
  reaches the same account's environments from other devices.

So rooms are new, and the guest grant improves on T3's pairing in one way: it holds no secret,
because Tailscale proves the caller. The scope list and the revoke list are T3's ideas, and the
screen credits them.

## 6. Prompt injection, and the permission caps

A room message is text from another model. That model may have read a web page or a file that an
attacker wrote. The receiver must treat it as data.

- **The wrapper** (§3.4) marks it, and the sender cannot close it early.
- **A woken turn never runs above `acceptEdits`.** Whatever mode the thread has, a turn that a room
  message started runs in `acceptEdits` at most, and never in `bypassPermissions`.
- **In a room with a guest, a woken turn runs in `default`.** Every edit, command and MCP call is a
  permission request. `yantrad` does not answer it from the thread's `mode` file. The owner answers.
- **The owner approves what leaves for a guest.** In a guest room, the owner's agent's `room_send` is
  a permission request in that `default` turn. This stops a hostile message from making the owner's
  Claude read a file and send it to the friend.
- **The receiver's own permission prompts still apply**, on both sides. The friend's Claude asks the
  friend.
- **The budget** stops a loop that a message starts.
- **Q5 holds.** The log has the room's lifecycle and the counts, and never a message's text.

## 7. Cost per message

- **A wake is one Claude turn on the receiver's own plan.** It is `claude -p --resume`, so it re-reads
  the thread's context. Prompt caching makes most of that a cache read, but a long thread is still a
  large turn. The owner pays for the owner's turns and the friend pays for the friend's.
  No usage crosses accounts.
- **A read costs a tool call** in the reader's turn and nothing on the appliance but memory.
- **The budget caps a room at 20 agent messages per human touch.** For two agents that is about ten
  turns each. The owner can lower it per room.
- **On the appliance** a room costs at most 1 MiB, and each open `room_read` holds one HTTP request
  for up to 50 seconds.

## 8. What the build loop can build, and what parks

| Work | Who |
| --- | --- |
| ADR-0038 accepted, and the decisions in §9 | **Parks: the owner.** Y-533 |
| The room store, the MCP route, `--mcp-config` for Chat turns, the wake, the budget, `yantra room` | Build loop, Opus. Y-534. A podman test with two fixture machines and the Claude stand-in from `chat_keeper.rs` proves it. It needs Y-447's keeper. |
| The read gate on every route, the grant files, `yantra guest`, the knock, the scopes | Build loop, Opus. Y-535. The `Inventory` fake answers `whois` with a foreign user, so every route's refusal is tested without a second tailnet. |
| The Rooms sheet and the Add-a-friend screen | Build loop, Sonnet. Y-536 and Y-535. |
| A real share with a real friend's device and a real `claude` on each side | **Parks: the owner.** It needs a second Tailscale account and a second person. Y-535's last step. |
| Channels for the TUI | Not planned (§3.6). |

## 9. What the owner decides

1. **The MCP route lives in `yantrad`, at `/api/mcp`, over HTTP** (§2.1). Recommended. The other
   choice is to install `yantra` on every fleet machine and on the friend's machine.
2. **Every route checks the caller before the first share** (§2.2). This amends ADR-0016's *reads
   stay as they are*. Without it, a share exposes the owner's repositories and fleet.
3. **The grant is a file per device, keyed on the Tailscale node and user, with no secret** (§4.2).
   The other choice is grants in memory, which a daemon restart revokes.
4. **v1 scopes are rooms and read-only workspace status, and no task scope** (§2.3, §4.4).
5. **The permission caps** (§6): a woken turn runs at most in `acceptEdits`, a guest room runs in
   `default`, and the owner approves each message their agent sends to a guest. The budget is 20.

## Sources

All accessed 2026-10-20.

- Tailscale, *Share your machines with other users*: https://tailscale.com/kb/1084/sharing
- Tailscale, *Tailscale Serve* (identity headers for sharees): https://tailscale.com/kb/1312/serve
- Anthropic, *Push events into a running session with channels*: https://code.claude.com/docs/en/channels
- Anthropic, *Channels reference*: https://code.claude.com/docs/en/channels-reference
- T3 Code, *Remote access*: https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md
- This repository: `crates/yantrad/src/api.rs` (the unchecked reads), `crates/yantrad/src/write.rs`
  (`allowed()`), `crates/yantra/src/mcp.rs`, `install.sh`, `crates/yantra-core/src/join.sh`,
  `web/src/screens/add-device/`.
