# ADR-0022 — A socket may address a session rather than a workspace

- **Date:** 2026-09-03
- **Status:** accepted (2026-09-03, by the owner — Y-318)
- **Amends:** nothing. It widens what a terminal socket may reach and leaves
  [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)'s predicate and
  [ADR-0017](0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md)'s address rule exactly
  as they are written.
- **Unblocks:** [Y-179](../../tracker.md#3-task-board). The work behind it is **Y-319**
  and **Y-320**.
- **Design:** [D6](../design/06-sessions-attention-spend.md) §6, which settles the page and hands this
  document the direction.

## Context

`GET /api/workspaces/{name}/terminal` bridges one tmux session to a browser. It reaches a session a
workspace names, and nothing else. `/machines` already lists the sessions no workspace names — D6 §4
calls them **unclaimed** — and a person can read that list and cannot open anything on it.

This is [R13](../research/13-dashboard-revamp-and-github.md) §6's decision **D**, and Y-179 has been
blocked on it since the row was opened. R13 states the objection in one line: it *"widens
ADR-0016's blast radius and should say so"*. That sentence is the reason this ADR exists, and its Consequences answer
it rather than avoid it.

> **Owner, 2026-09-03:** any session on your own fleet is reachable. Yantra does not decide a session
> is off-limits.

### What is already true, read on `main` on 2026-09-03

**The browser can already destroy any session on any machine.**
`DELETE /api/machines/{machine}/sessions/{session}` is in
[`write.rs`](../../crates/yantrad/src/write.rs), it takes the machine and the session from the path,
and it asks no question about a workspace. It sits on the same `allowed()` this ADR would use.
**So the fleet already has a machine-plus-session address for the destructive verb, and refuses it
for the one that only looks.** That pair is the wrong way round.

**A workspace's pane is a shell too.** `up` with no `startup` opens a plain shell, and
[`attach.rs`](../../crates/yantra-core/src/attach.rs)'s `remote_command` renders
`TERM=… tmux attach -t '=name'` whichever session it is handed. Treating one as safe and the other
as dangerous is a distinction with nothing behind it.

**The workspace is used for two facts.** `plan(name, term)` loads a workspace, then reads
`workspace.machine` for the ssh destination and `workspace.name` for the tmux session.
`remote_command(tmux, session, term)` and `Tmux::pane(exec, name)` below it take a session name and
know nothing about workspaces.

**The address is not free text.** `tmux::validate_name` refuses anything but
`[A-Za-z0-9_-]+`, I-21 addresses the session as `=name` for an exact match, and I-35 quotes it so a
login `zsh` cannot glob it. The machine half is an ssh destination
([ADR-0009](0009-machine-names-are-ssh-destinations.md)), which is what the kill route and the probe
route already put in a path segment.

**The authoriser is called by name on this route.** An upgrade is a `GET`, so
[`terminal.rs`](../../crates/yantrad/src/terminal.rs) calls `allowed()` itself before it upgrades,
with the reason written beside it: *"a terminal runs whatever the person on the other end types."*

## Decision

**1. A terminal socket may address a machine and a session directly.** Any tmux session on any
machine the fleet asks is reachable. Yantra does not ask whether a workspace claims it, and has no
category of session it refuses.

**2. The boundary is the tailnet plus Tailscale identity, and it does not move.** The socket goes
through the same `allowed()` as the workspace socket: ADR-0016's predicate — live `whois`, this
owner's node, no tags, everything else refused — on the address ADR-0017 §1 picks. A socket that
reaches an unclaimed session crosses no boundary a workspace's socket does not.

**3. It attaches, and it never creates.** `attach.rs` already refuses to open a session, and this
route inherits that. Nothing here decides whether Yantra may start a *new* shell on a machine.

**4. The route names both halves**, in the shape the kill route already uses:
`GET /api/machines/{machine}/sessions/{session}/terminal`.

**5. A session that is not there is refused by name.** The error names the machine and the session,
never a workspace. A session that vanished between the list and the tap is the ordinary case rather
than a fault.

## Consequences

**The socket's address becomes machine-plus-session, so a typo can land in a live shell.** This is
the price, and it must be said plainly. The workspace socket carries a second check that nobody
designed as one: `workspace::load` refuses a name the owner never wrote, so a mistyped workspace name
reaches a refusal. Session-addressed, there is no file to miss. A mistyped session name that matches
nothing is still refused by name — decision 5 — but **one that matches another live session opens
that session**, and the person is given no way to tell the two apart. What is lost is the curated
list of names, not a status code: the workspace socket never answered 404 either. It upgrades, then
closes with a reason.

**D6 §6.3 is what pays for it, and it pays before the socket opens rather than after.** The link
names what it is about to open — the machine, the session name and its age — so the wrong session is
visible while it is still a link. There is no confirm dialog, because D3 §4.7 keeps those for what
cannot be undone and attaching undoes itself by closing. The pane is not cleared, not resized beyond
the browser's own window, and nothing is typed into it. **Attaching is a read until the person
types**, so the damage a wrong address can do is bounded by the first keystroke, and the label above
the link is what stands in front of it.

**It widens ADR-0016's blast radius, and that is the strongest argument against this decision.**
ADR-0016 authorises **who calls**. It says nothing about **what the call reaches**, and this ADR
makes what the call reaches every shell on the fleet. The day ADR-0016 was bought for — a node shared
in from another tailnet, a tag granted in an admin console, a second user invited — now costs every
session on every machine rather than the sessions Yantra composed. ADR-0017's history is why that is
not theoretical: this repository holed that authoriser once, with a change made for another reason,
and nothing in the daemon noticed. **Accepting this means accepting that one authoriser is the whole of
the protection.** The honest defence is not that the risk is small; it is that a workspace check was
never load-bearing, so removing it takes away a reassurance rather than a control.

**It closes a gap rather than opening one.** Today the browser can kill a session it cannot look at.
After this, the two verbs address the same thing.

**The work is small, and two functions do not move.** `remote_command` and `Tmux::pane` are already
session-addressed and are unchanged. `Plan`, `ensure_session` and `pty::on` carry the `Workspace` and
are what Y-319 changes.

**Nothing new is logged.** Q5's rule holds unchanged: `terminal.rs` logs the lifecycle and never a
byte of the stream. A session name now stands where a workspace name stood in that one line.

### Not decided here

- **Whether Yantra may open a new shell on a machine.** R13 §6's decision **D** also covers
  `GET /api/machines/{name}/shell`, and spawning is a different act from attaching to what is already
  running. That half stays open.
- **Adoption.** D6 §4.4 refuses turning a session into a workspace, because the repo is not on the
  wire and would have to be guessed. A reachable session is still not a workspace.
- **Per-user authorisation.** ADR-0016 parks it on reasons this ADR does not change.

## Alternatives

**Allow only the sessions Yantra could have started.** The obvious safeguard, and it is refused.
There are two ways to build it and both fail. Guessing from the name means asking whether a workspace
file carries that name — which is the workspace socket again under a second spelling. Writing a
marker into the session means only sessions started after the marker shipped are reachable, and
anyone on the machine can unset it. Worse, it refuses exactly the sessions a person most wants:
the one started by hand on the Mac, the one that predates Yantra, and the one `up` can no longer
reach at all — Y-081 made `up` refuse a workspace whose `repo` has been deleted, and `attach.rs` says
in its own header that it reaches that session where `up` cannot.

**Ask before attaching.** A confirm dialog would catch the mistyped address. D3 §4.7 refuses it:
confirmation is for what cannot be undone. It would also teach the person to dismiss dialogs, which
is what makes the kill route's dialog worth having.

**Do nothing, and keep the workspace socket alone.** The status quo, and it is defensible — the
person can reach any session with `ssh` and `tmux attach`. It loses on ADR-0016's own founding
sentence: *from a phone that is worth nothing*. It also leaves the browser holding the verb that
destroys a session and not the verb that shows it.
