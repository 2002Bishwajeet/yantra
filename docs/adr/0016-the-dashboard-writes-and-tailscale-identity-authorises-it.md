# ADR-0016 — The dashboard writes, and Tailscale identity authorises it

- **Date:** 2026-08-02
- **Status:** proposed
- **Closes:** the write half of Y-112
- **Builds on:** Q6, which settled that Yantra is personal-first and has no authentication, and
  [ADR-0013](0013-the-heartbeat-carries-only-what-placement-scores.md) §5, which established that a
  caller is identified by its source address.

## Context

M5 makes the dashboard act. Until now the API was five `GET` routes plus `POST /heartbeat`, and
`web/src/components/Command.tsx` handed the operator a command to paste into a terminal because *the
API answers 405 to every write*. From a phone that is worth nothing, so the routes have to exist.

**A readable API and a writable one are different objects.** `R-22` already states that the bind
address is the entire security model, and that is defensible while every route is a read of facts the
operator could get by running `tailscale status` themselves. It is not defensible for *start a
process on my Mac*: a write route reaches [ADR-0006](0006-ssh-exec-transport.md)'s transport and runs
a command on another machine.

The owner chose Tailscale identity on 2026-08-02, over "nothing, the tailnet is the boundary" and
over a shared token.

### What was measured first, and it constrains the honest claim

`tailscale status --json` on 2026-08-02, this tailnet:

| | |
| --- | --- |
| Nodes | **6** — this machine, the MacBook, an iPhone, an iPad, and two offline `laptop-*` |
| Distinct users | **1** |
| Tagged nodes | **none** |

So **every mechanism under consideration authorises exactly the same set today**: the bind address
admits any tailnet peer, an inventory lookup admits any tailnet peer, and a user check admits any
node owned by the one user — which is all of them. **Identity checking rejects nothing on this
tailnet, and this ADR does not pretend otherwise.**

An inventory lookup in particular is close to theatre: the inventory *is* the peer list, so
"resolve the source address against the inventory" asks only *is this a tailnet peer*, which binding
to a tailnet address already guaranteed.

What a user check buys is a **failure mode**, not a rejection. Three things are one admin-console
click away, none announces itself to the daemon, and each would silently grant write access to the
fleet:

- a node **shared into** the tailnet from someone else's tailnet,
- a **tagged** node — a CI runner is the obvious one, and tags are how a machine gets an identity no
  person is accountable for,
- a **second user** invited to the tailnet.

`tailscale whois` reports both, verified on 2026-08-02: `Node.User` (a stable numeric id),
`Node.Tags`, and a `UserProfile` carrying the login name.

## Decision

**1. The daemon accepts writes at `/api`, and they are the only routes that require authorisation.**
Reads stay as they are. `POST /heartbeat` keeps ADR-0013 §5's rule and is untouched by this ADR — it
is machine-to-machine, ten seconds apart, and has its own reason to be cheap.

**2. A write is authorised if and only if the caller's source address resolves to a node that is
owned by the same user as this daemon's own node, and carries no tags.** Everything else is refused,
including an address that resolves to nothing.

**3. The lookup is live, not the background snapshot.** `refresh.rs` is up to 30 s stale, and an
authorisation decision made on stale data means a node removed twenty seconds ago can still act.
Writes are rare and human-driven, so a subprocess per write costs nothing worth protecting.

This does **not** contradict `crates/yantrad/CLAUDE.md`'s *do not call the LocalAPI per request*.
That rule is about `POST /heartbeat` — five machines every ten seconds, forever. A write happens when
a person taps a button.

**4. Identity is taken from the source address and never from the body.** ADR-0013 §5's reasoning
carries over unchanged: a body that names its sender can name someone else.

**5. Failure is closed.** If `tailscale` cannot be reached or answers something unparseable, writes
are refused. A control plane that falls back to *allow* when its authoriser breaks has no authoriser.

## Consequences

**It rejects nothing today, and that is the point.** The value is entirely in what happens the day
the tailnet changes shape, because that day arrives through an admin console rather than through this
repository, and nothing else in Yantra would notice.

**Writes gain a dependency on `tailscale` being healthy.** The daemon already cannot start without it
(`listen_on` resolves its own addresses that way), so this widens an existing dependency rather than
adding one — but it now sits on a request path, which `refresh.rs` was built to keep clear. It is
bounded to writes for exactly that reason.

**The CLI is unaffected.** [ADR-0012](0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md)
has `yantra` calling the library in-process, so it neither gains nor needs this check. The person
holding the shell already has the machine.

**`R-22` is not retired.** The bind address remains the outer boundary and this sits inside it. What
changes is that the daemon now has a second, independent reason to refuse, so a mistake in one is no
longer the whole of the security model.

**A tagged node cannot drive Yantra**, which forecloses "CI starts a workspace" without discussion.
If that is ever wanted, it is a superseding ADR and not a quiet exception — the point of naming tags
here is that granting them later has to be deliberate.

### Not decided here

- **The routes' shape** — paths, bodies and status codes are implementation, and the CLI's existing
  verbs already fix the semantics (`crates/yantrad/CLAUDE.md`: anything the web UI can do must be
  expressible in `yantra` first).
- **Per-user authorisation.** With one user there is nothing to distinguish. Multi-user is in
  `brainstorm.md`'s Future Possibilities and would need its own decision about *whose* workspaces are
  whose.
- **Tailscale ACLs.** They would enforce this a layer lower and are worth having, but they are
  configuration the daemon cannot read, and a daemon that assumes an ACL it cannot see fails open the
  moment someone edits it. Complementary, never a substitute.
