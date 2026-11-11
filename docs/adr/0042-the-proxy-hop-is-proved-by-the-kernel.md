# ADR-0042 — The proxy hop is proved by the kernel, not by the address

- **Date:** 2026-11-08
- **Status:** Accepted 2026-11-08 by the owner ([Y-665](../../tracker.md), issue #654).
  [Y-680](../../tracker.md) builds it.
- **Evidence:** research note 24, `docs/research/24-decision-and-practice-audit.md` , which
  found the hole. The measurements below were made on 2026-11-08 on `cachyos-g14` and read on
  `yantra-box`, both on Tailscale 1.104.4.
- **Amends:** [ADR-0017](0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md)
  decisions 1 and 2, and its consequence *"this machine becomes trusted for writes"*.
  [ADR-0029](0029-a-machine-joins-itself.md) decision 3, for a join on the hub. Each carries a dated
  note.
- **Unchanged:** [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)'s
  predicate (`whois`, live, same user, no tags, failure closed), and ADR-0017 decisions 3 to 5.
- **Comes before:** ADR-0040, *An agent caller is tagged and scoped* (Proposed, open in PR #643).

## Context

ADR-0017 takes the caller's address from `X-Forwarded-For` when the TCP peer is one of the
daemon's own bound addresses (`crates/yantrad/src/write.rs:82-101`). It accepted one cost in
writing: any process on the hub can name any caller. It said this grants nothing, because "a local
process can already call the library" (ADR-0012).

That premise is false since agents run on the hub as `karigar`, a separate non-sudo account
(Y-627, Y-628). The library acts with the rights of the account that runs it. The daemon acts with
the rights of the `yantra` account: the ssh key to every joined machine, the GitHub grant and the
relay. A `karigar` process that reaches the daemon as the owner gets all three.

### What is open, read from the code

`allowed()` (`write.rs:226`) is the only check on these routes. All of them are open to any local
account:

- every route in `write.rs`: workspaces (make, change, delete, up, down, resume, repair), sessions,
  probe, dirs, clone, install, join, update, relay, GitHub login and logout and client id, and the
  thread routes that commit, push and open a pull request with the daemon's grant;
- `tasks.rs` and `placement.rs`: start, steer, stop and remove a task;
- `chat.rs`, `terminal.rs` and `mic.rs`: a chat turn, a terminal on any machine, the one-off install
  terminal, and the microphone;
- `mcp.rs` and `layout.rs`: the rooms and the layout.

The reads in `api.rs` call no authoriser today, so this ADR does not change them. I found no route
that merges a pull request, so research note 24's "including merges" does not hold for the daemon's
routes. Pushing to a branch and opening a pull request do hold.

### A forged header is not needed

**The audit names the header. The header is the smaller half of the hole.** A local process that
sends no header at all is also the owner:

- `caller_address` returns the peer when the header is absent (ADR-0017 decision 3).
- The peer is the hub's own tailnet address.
- `tailscale whois 100.108.185.80` on `cachyos-g14` returns this node and the owner's user, with no
  tags. So `allowed()` passes it.

So a fix that only stops reading the header leaves the hole open. I did not send a request to a
live daemon to show this. It follows from the code and the `whois` answer above.

### What the kernel and Tailscale can tell, measured

- **A local process reaches both doors.** On both machines, `curl` to the node's own `:8443` and to
  its own `:7717` answers `200` on `/healthz`.
- **`tailscale serve` names this node for a local caller.** Its local listener takes the source
  address from the accepted connection (`ipn/ipnlocal/serve.go`, `newServeListener`, v1.104.4). For
  a local caller that is the node's own address. `X-Forwarded-For` then names this node, and the
  identity headers come from the same `WhoIs`. So `serve` cannot tell `karigar` from the owner. I
  read this in the source. I did not capture the headers, because that needs a change to the live
  `serve` config.
- **The TCP hop has no peer credentials.** `SO_PEERCRED` on a loopback TCP socket returns
  `(pid 0, uid -1, gid -1)`. On a Unix socket it returns the real pid, uid and gid.
- **The kernel does know the owner of a local TCP socket.** `ss -tnei` shows `uid:1000` for my own
  connection to `:7717`. It shows no uid (that is, uid 0) and the cgroup `tailscaled.service` for
  `tailscaled`'s pooled connection.
- **`tailscaled` runs as root** on both machines, and `yantrad` runs as `yantra`.
- **`tailscale serve` can proxy to a Unix socket.** The 1.104.4 help says so
  (`unix:/var/run/myservice.sock`, Linux, macOS and BSD). The source dials it with
  `dialServeUnixSocket` and sets `X-Forwarded-For` with `Set`, as for a TCP backend. 1.104.4 also
  holds the fixes for TS-2026-016 and TS-2026-017, which were in this code.

## Decision

1. **The daemon listens on a Unix socket, `/run/yantra/yantrad.sock`, beside its TCP port.** The
   unit makes `/run/yantra` with `RuntimeDirectory=yantra`. For each connection the daemon reads the
   peer's uid with `SO_PEERCRED` (`getpeereid` on macOS).
2. **`tailscale serve` proxies `:8443` to that socket**, not to the tailnet address. The command is
   `tailscale serve --bg --https=8443 unix:/run/yantra/yantrad.sock`. `install.sh` and `just https`
   write it. The phone's URL does not change.
3. **On the socket, the uid decides who the caller is.**
   - **uid 0 is the `serve` hop.** The caller's address is `X-Forwarded-For`, with ADR-0017
     decision 3 unchanged: one address or refuse. An absent header is refused here. **An address
     that is one of this node's own is refused**, because the account that opened the first
     connection is unknown. Any other address goes through ADR-0016's predicate.
   - **The daemon's own uid, or an account in the `yantra` group, is the owner of this machine.**
     The daemon reads `X-Forwarded-For` from neither. The `yantra` group is how the owner names an
     account on a development machine. The box has no such account.
   - **Any other uid may only join itself.** It may call `GET /join` and `POST /api/join`, and the
     body's `user` must be the account name of that uid. Every other route refuses it with 403.
4. **On TCP, `X-Forwarded-For` is never read.** The TCP peer is the caller, as ADR-0016 wrote it.
5. **On TCP, a peer that is one of the daemon's own bound addresses is refused** on every route
   that calls `allowed()`, with 403. The refusal names the socket. `POST /heartbeat` does not call
   `allowed()`, so the hub's own `yantra-agent` still reports.

**The done test** is five cases, and each is a test:

- A request to `:7717` from the hub's own address is refused, with a forged `X-Forwarded-For` and
  without one.
- A request on the socket from an account that is not root, not `yantra` and not in the group is
  refused.
- A request through `tailscale serve` from a local process is refused, because its forwarded address
  is this node.
- A local account can join itself through the socket, and cannot join another name.
- The phone writes through `tailscale serve`. This one is checked by hand on the box, because a real
  `serve` in a container needs an auth key, which is an owner action.

The first four run in a podman container with two accounts (§B3). The container's own `serve` is
replaced there by a root process that writes the header, which is the hop's shape and nothing more.

## Consequences

**Gained.** An agent account on the hub cannot act as the owner. Before this ADR it could, with a
header and without one. The kernel proves the hop, and no address is trusted because of where it
points.

**The hole is closed on the hub only. The same hole stays open on every other machine.** `karigar`
on the Mac reaches the hub's `:7717` or `:8443` from the Mac's address. That address is the owner's
untagged node, so `allowed()` passes it, for every route above. Tailscale names a node, not an
account on it, and no change at the hub can tell two accounts on the Mac apart. This ADR does not
close that. It needs its own decision: a credential that only a person can present, such as a
passkey, or a rule on each joined machine that keeps the agent account off the tailnet. Until then,
an agent on any joined machine has the owner's rights. **This is the larger risk, and it exists
today on every machine where an agent runs.**

**Cost: the hub's join changes.** `karigar` on the hub can no longer use the `curl …:8443/join | sh`
command, because its request through `serve` names this node. Setup gives the hub a second
command: `curl --unix-socket /run/yantra/yantrad.sock http://yantra/join | sh`. `join.sh` posts on
the socket when it runs on the daemon's own machine. Y-627 and Y-628 say this. ADR-0029 decision 3,
*the account is whoever ran the command*, is then proved by the kernel on the hub.

**Cost: a session on the hub loses `yantra mcp` until ADR-0040.** A Chat turn or a session on the
hub reaches `/api/mcp` and `/api/tasks` as `karigar`, and decision 3 refuses it. Sessions on the hub
do not start today (Y-627), so nothing that works now breaks.

**Cost: the box's `serve` config moves once.** The box runs `serve` to
`http://100.95.169.83:7717`. The root updater runs `install.sh` (ADR-0027), so `install.sh` replaces
a `:8443` entry that points at the old TCP target in the same update that ships this change. A
machine that does not update that way needs the command in decision 2 once. Until then, the phone
gets 403 on every write, and the refusal names the command.

**Cost: a group member lends its trust.** On a development machine where the owner adds an account
to `yantra`, every server that account runs can carry another account's request. The Vite proxy is
one. This is the owner's choice for that machine. The box has no group member.

**Cost: a forged heartbeat stays possible.** A local account can post `/heartbeat` as the hub. A
heartbeat is telemetry and runs nothing, so this ADR leaves it.

**What it means for ADR-0040.** ADR-0040 decision 2 plans a second socket, `/run/yantra/agent.sock`,
read with `SO_PEERCRED`. It should use this socket and add one class to decision 3 here: a uid that
an agent grant names. Its Context says an agent on the appliance "would pass as the owner". After
this ADR it is refused. Its tagged-node path does not cover an agent account on the owner's own
untagged machines, which is the open hole above.

## Alternatives

**Keep the TCP hop and ask the kernel who owns the client socket.** `NETLINK_SOCK_DIAG` returns the
uid of a local client socket, as `ss` showed. It needs no `serve` change and no client change. It
loses on three points. It is Linux only. It is an `identd` pattern that few systems use for
authorisation. And ADR-0040 already plans a Unix socket with `SO_PEERCRED`, so this gives one
mechanism and not two. It is the fallback if `serve` to a Unix socket fails on the box.

**Authorise on `Tailscale-User-Login`.** `serve` deletes an incoming value and sets its own. But for
a local caller `WhoIs` resolves this node, so the header names the owner. It is also absent for a
tagged node, as ADR-0017 found. It closes nothing here.

**Stop reading the header on TCP, and nothing else.** A local process sends no header and is still
the owner, as the Context shows. And on TCP the `serve` hop and a `karigar` hop come from the same
address, so no rule on the address can tell them apart.

**A socket that only `yantra` and root can open, with no uid check.** This closes the hop with file
modes alone. It loses the hub's own join, which must come from `karigar`. A wrong mode on the
directory would also open it with no sign. One `SO_PEERCRED` call costs less than that risk.

**A firewall rule per account.** An `nftables` rule with `meta skuid` could drop `karigar`'s traffic
to the hub's own address. It needs root on each machine. The daemon cannot see it, so it fails open
when the rule is missing. That is ADR-0016's reason for not relying on ACLs.

**A credential in the browser, such as a passkey.** It would close the hole on every machine, which
this ADR does not. It is a larger decision, with its own enrolment and recovery, and ADR-0016 chose
Tailscale identity over a shared token. It is the first candidate for the open hole above.

## Not decided here

- How to stop an agent account on another joined machine from acting as the owner.
- Whether reads should check the caller. ADR-0038's 2026-10-20 note says they do, and the code in
  `api.rs` does not.
- What a tagged enrolment does to `allowed()` (Y-143). The box joins untagged.

## Sources

Accessed 2026-11-08.

- Tailscale source, tag `v1.104.4`: `ipn/ipnlocal/serve.go` (`newServeListener`,
  `dialServeUnixSocket`, `addProxyForwardedHeaders`, `addTailscaleIdentityHeaders`) and
  `ipn/ipnlocal/local.go` (`WhoIs`),
  <https://github.com/tailscale/tailscale/tree/v1.104.4/ipn/ipnlocal>.
- `tailscale serve --help`, Tailscale 1.104.4 on `cachyos-g14`.
- TS-2026-016 and TS-2026-017, summarised at
  <https://corgea.com/research/ts-2026-014-015-016-017-tailscale-tailworm-ssh-unix-socket-root-escalation/>.
- `socket(7)` and `unix(7)` on `SO_PEERCRED`; `sock_diag(7)` on `NETLINK_SOCK_DIAG`.
- Commands run on `cachyos-g14`: `tailscale version`, `tailscale serve status`,
  `tailscale whois 100.108.185.80`, `ss -tnei`, `ps -C tailscaled`, `ps -C yantrad`, and a Python
  check of `SO_PEERCRED` on a loopback TCP pair and a Unix pair. On `yantra-box`, over ssh and read
  only: `tailscale version`, `tailscale serve status`, `ps`, and `curl` to `/healthz` on `:8443`
  and `:7717`.

> **2026-11-09 ([Y-681](../../tracker.md)): the hole on other machines is closed by a passkey.**
> [ADR-0044](0044-a-write-needs-the-owners-passkey.md) closes the open hole in the Consequences and
> the first *Not decided here* item. It changes one case in decision 3: a `serve` hop whose forwarded
> address is this node's own passes when it carries a live session cookie.

> **2026-11-11 ([Y-727](../../tracker.md)): one named proxy account is treated as the `serve` hop.**
> The owner's box serves the dashboard at a custom name through Caddy, which runs as the `caddy`
> account and forwards over TCP to `:7717`. Decision 5 refuses that hop, so Home chats, Usage and
> every write stopped on the nightly that carried Y-680. The owner chose, on 2026-11-11, to keep the
> custom name. Decision 3 gains one case: **an account that the daemon's configuration names as its
> proxy is treated as uid 0 on the socket.** Its `X-Forwarded-For` names the caller, an absent
> header or an address of this node is refused, and every other address goes through ADR-0016's
> predicate. No account is named by default. The cost is the one decision 3 already accepts for
> root: any process that runs as that account can name a caller. Caddy then proxies to
> `unix//run/yantra/yantrad.sock`.
