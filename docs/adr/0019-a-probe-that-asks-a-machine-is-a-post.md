# ADR-0019 — A probe that asks a machine on demand is a `POST`

- **Date:** 2026-08-11
- **Status:** accepted
- **Amends:** nothing. It classifies a case
  [`crates/yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md)'s ssh rule did not name, and leaves
  that rule's text unchanged.

## Context

The owner asked, on 2026-08-11, for workspace creation to be **less filling and more selecting**:
choose the machine, choose the directory, and have Yantra confirm the directory is there before the
workspace file is written. Today `NewWorkspace.tsx` is three free-text fields that check nothing, and
`up` is what discovers the path was wrong — after the workspace exists.

Confirming a path means asking a machine while a person waits. That runs into the daemon's sharpest
rule, stated with its reasoning attached:

> **Never `await` ssh inside a handler.** … A browser polls whether or not anyone is looking, so a
> handler that calls `sessions::list` per request turns one open tab into a permanent ssh storm.

The rule also refuses, in advance, to be softened:

> Do not generalise the exception — a *read* that awaits ssh is still the bug that rule exists to
> prevent.

[D1 §3.3](../design/01-dashboard.md) offered two ways out and asked for one to be picked. **One of
them is not available, and that is the finding that settles this.** Folding the probe into
`refresh.rs`'s snapshot cannot work: the snapshot is per-machine and computed on a timer, while a
probe is per *(machine, path)* — an unbounded space. Nothing can pre-compute an answer for a
directory nobody has typed yet. The cache can answer *which machines exist*; it is structurally
silent on the only question the form is asking.

That leaves shaping it as a write, which reads at first like mislabelling a verb to slip past a rule.
It is not, and the reason is HTTP's own definition rather than convenience.

## Decision

**A probe that must ask a machine on demand is a `POST`, and it lands inside the write exception that
already exists.**

Three things hold this up.

1. **`POST` does not mean *mutate*.** It means *process this payload according to the resource's own
   semantics*. Search endpoints and GraphQL have been `POST` since long before this repo existed,
   for exactly this reason: the request carries input the server must act on, and it does not fit a
   URL. A probe carries a machine and a path. It fits that shape precisely.

2. **The risk profile is the write's, exactly.** The rule exists to stop a *polling* client, and it
   says so in its own rationale. A probe is typed by a person, runs once, and nothing polls it —
   which is word for word the justification already written for `write.rs`: *"a person tapped a
   button once."* This decision does not weaken the rule; it says which side of it an on-demand
   probe was always on.

3. **The alternative is worse in the way that matters.** A `GET` here would be a read that awaits
   ssh, which is the bug named above. Faking a cache would answer a different question from the one
   asked. Refusing entirely leaves the form checking nothing, which is where it is today.

**The rule's text does not change**, and neither does its meaning for reads. `GET /api/machines`,
`/api/workspaces`, `/api/sessions` and the rest still serve the snapshot and still must never reach a
machine.

**The test to apply to the next candidate**, so this does not become an escape hatch: a route may
await ssh only when **a person initiated it** and **nothing polls it**. Both halves, not either. A
route that a page calls on a timer fails the second half however it is spelled, and the verb it uses
does not rescue it.

**The CLI comes first**, unchanged from the existing rule: anything the web UI can do must be
expressible in `yantra` first.

## Consequences

**A probe result cannot be linked to.** No URL names it, so the dashboard cannot deep-link "this
directory exists on that machine" and a reload asks again. Accepted without regret: nobody bookmarks
an existence check, and the answer is stale the moment it is given.

**Nothing in the daemon stops a client polling the `POST`.** The guarantee is a convention, not a
mechanism — the same standing as the rule it sits beside. A page that probed on every keystroke would
reproduce the ssh storm through a verb that is allowed. Debounce belongs in the client, and this is
the sentence to point at when it is missing.

**The write path's authoriser now covers a read-shaped act.** [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)
gates writes on Tailscale identity resolved live and failing closed. A probe inherits that, which is
strictly more protection than a read gets today — the right direction, and worth stating because it
is not obvious that classifying something as a write makes it *safer* here.

**It costs one round trip per probe, paid while someone waits.** `ControlPersist=300` keeps the socket
warm, so the second probe against the same machine is cheap and the first is not. A machine that is
asleep costs the full `ConnectTimeout` before the form can say anything, and the form must therefore
say *asking* rather than appearing to have answered *no*.

**This does not decide what a free shell may reach.** That is a separate and larger question — it
widens what a terminal touches rather than what a form asks — and it still has no ADR.
