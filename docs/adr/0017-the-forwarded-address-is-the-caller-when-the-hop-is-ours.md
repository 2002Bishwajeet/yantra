# ADR-0017 — The forwarded address is the caller, when the hop is ours

- **Date:** 2026-08-03
- **Status:** proposed
- **Amends:** [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md) — **how the
  caller's address is obtained**, which decisions 2 and 4 assumed rather than stated. The predicate
  itself is untouched: same user, no tags, resolved by `whois`. Decisions 1, 3 and 5 — writes are the
  only authorised routes, the lookup is live, failure is closed — stand unchanged and are not
  restated here.
- **Closes:** Y-118

## Context

ADR-0016 authorises a write by resolving *the caller's source address* through `tailscale whois`.
Its 2026-08-03 amendment (Y-111) records what went wrong: `tailscale serve` terminates the caller's
connection and opens its own, so the address the daemon sees is the proxy's. Every write through
`:8443` is attributed to the machine running the proxy, and `allowed()` cannot refuse anything that
reaches it.

**Nothing is broken today and that is the whole difficulty.** The proxy is this owner's own untagged
node, so the phone's writes are authorised, which is what M5 needed; `serve` is tailnet-only, so
`R-22`'s outer boundary holds. What is gone is the *failure mode ADR-0016 was bought for*. A tagged
CI runner or a node shared in from another tailnet would be authorised on 8443 and refused on 7717 —
the worse of the two answers being the one a browser can reach. An authoriser that rejects nothing
while reading like protection is `R-23` one layer down: the confident lie is worse than the absence.

### What is actually in the request, measured rather than assumed

Read on 2026-08-03 in `ipn/ipnlocal/serve.go` of **`tailscale` 1.98.9** — the version installed on
`cachyos-g14`, checked with `tailscale version`, and the tag the source was read at rather than
`main`. Two functions decide everything here.

**The forwarded address is written by `tailscaled`, from the connection it terminated:**

```go
func addProxyForwardedHeaders(r *httputil.ProxyRequest) {
	r.Out.Header.Set("X-Forwarded-Host", r.In.Host)
	if r.In.TLS != nil {
		r.Out.Header.Set("X-Forwarded-Proto", "https")
	}
	if c, ok := serveHTTPContextKey.ValueOk(r.Out.Context()); ok {
		r.Out.Header.Set("X-Forwarded-For", c.SrcAddr.Addr().String())
	}
}
```

`Set`, not `Add`, and `c.SrcAddr` rather than anything the caller sent. So an inbound
`X-Forwarded-For` is **replaced**, the header carries exactly one address, and there is no comma list
and no leftmost-or-rightmost convention to get wrong.

**The identity headers are deleted on the way in, and are not set at all for a tagged node:**

```go
	// Clear any incoming values squatting in the headers.
	r.Out.Header.Del("Tailscale-User-Login")
	…
	if node.IsTagged() {
		// 2023-06-14: Not setting identity headers for tagged nodes.
		// Only currently set for nodes with user identities.
		return
	}
```

That second block settles a question this ADR would otherwise have to argue. `Tailscale-User-Login`
is not merely *less* than `whois` — for the exact node ADR-0016 exists to refuse it is **absent**,
and absent is indistinguishable from a Funnel request, from a proxy that never ran, and from the
context lookup above failing. The forwarded *address* is the only channel through which a tagged
caller announces itself to the backend at all, because `whois` on that address reports `Node.Tags`.

### Why a header may be trusted here, when ADR-0016 §4 says it may not

§4's reason is precise and it is not "headers are dirty": *a body that names its sender can name
someone else*. What makes a claim worthless is that **the caller** can write it. Behind the proxy the
caller cannot: `tailscaled` overwrites the header with the address of a connection it terminated
itself, and it does so on this machine, over a connection whose peer is one of the daemon's own bind
addresses. Reaching 7717 directly, a caller *can* write the header — and there the peer is that
caller's own address, not ours, so the header is ignored. The distinguishing fact is the TCP peer,
which no caller can choose, and that is what the rule below turns on.

## Decision

**1. The caller's address is the TCP peer — unless the TCP peer is one of this daemon's own bind
addresses, in which case it is the address in `X-Forwarded-For`.** Whichever address that yields goes
through ADR-0016 §2's predicate unchanged: `whois`, live, same user as this node, no tags, everything
else refused.

**2. "Our own bind addresses" is exactly the set `listen_on` bound** — the addresses Tailscale
reports for this node (`Self.TailscaleIPs`), the same set Y-069 already refuses to start without. Not
"a private address", not "any local interface", and **not loopback**, which the daemon deliberately
never binds, so nothing can arrive from it.

**3. One address, or refuse.** A forwarded header that is present but empty, unparseable, or carries
more than one address is refused rather than repaired. `tailscaled` writes exactly one; anything else
means something is in the path that this ADR did not measure, and the fail-closed answer is the only
honest one. **An absent header is not a refusal** — it means the request was not proxied, and the
peer stands as it does on 7717 today.

**4. Identity still comes from `whois` on an address, never from a name in a header.** The
`Tailscale-User-*` headers are not read. ADR-0016 authorises on the numeric `Node.User` and on
`Node.Tags`, and the measurement above shows a tagged node carries neither.

**5. Failure stays closed**, unchanged from ADR-0016 §5, and this ADR adds three ways to fail:
an untrusted peer with a forwarded header ignores it, a malformed header refuses, and an address that
resolves to nothing refuses as it already did.

## Consequences

**The direct path is untouched, which is the test that this is a widening and not a rewrite.** A
request straight to 7717 has a peer that is not ours, so decision 1 takes the peer exactly as
ADR-0016 wrote it, and a forged `X-Forwarded-For` on that path changes nothing. `POST /heartbeat` is
outside this ADR as it was outside ADR-0016: agents post to 7717 across the tailnet and never through
the proxy, so ADR-0013 §5 keeps the source address with no exception.

**The acceptance criterion is a refusal, not a success.** A forwarded address that resolves to a
**tagged** node must be refused *even though the TCP peer is ours* — that is the case the proxy
silently authorises today, and it is the one that proves the rule does something. A test that only
shows the phone still working would pass just as well against the code as it stands.

**This machine becomes trusted for writes, and that is the genuinely new sentence.** Any process on
this machine can connect to the daemon's bind address and put whatever it likes in the header. That
grants no escalation — [ADR-0012](0012-the-cli-and-the-daemon-are-two-callers-of-one-library.md) has
the CLI calling the library in-process, so a local process can already do everything a write route
can, without asking the daemon — but the trust was implicit before and is now written down, because
a rule that rests on it should say so.

**The trust is in the local hop, not in `tailscale serve`.** A second reverse proxy on this machine
would inherit it, and one that appends to `X-Forwarded-For` rather than replacing it is precisely
what decision 3 refuses. The condition to revisit this ADR is another local process being put in
front of 7717.

**It rests on a measured `tailscaled` behaviour, so it is version-sensitive** (§B0.5). If a future
release appended instead of replacing, decision 3 turns that into a **visible refusal** rather than
into silent trust of a caller-supplied entry — the failure is loud by construction, which is the
reason decision 3 is worth its two lines.

**Funnel stays refused without a special case.** `serve` is tailnet-only here, and a Funnel request
would carry a public source address that `whois` cannot resolve, which ADR-0016 already refuses.
`R-22` is unchanged: this sits inside the bind-address boundary and does not widen it.

**One plumbing consequence, named rather than designed.** The bound addresses exist today only as a
local `Vec<SocketAddr>` inside `serve()`; the write router would need them. That is implementation,
and it is small.

**If this is declined, the status quo is not a crash — it is an authoriser that rejects nothing on
the port a browser can reach.** Nothing in M5 breaks and no work is blocked; what persists is that
`crates/yantrad/CLAUDE.md`, `crates/yantrad/README.md` and `docs/development.md` must keep telling
readers not to read `allowed()` as protection, and the tag check that forecloses "CI starts a
workspace" stays theoretical on 8443. Declining is a defensible choice — it is small, personal, and
one user — but it should be made rather than drifted into.

### Not decided here

- **Whether `/heartbeat` should ever learn this rule.** No agent goes through a proxy today, and
  giving a machine-to-machine route a header-derived identity needs its own reason.
- **Per-user authorisation, and Tailscale ACLs.** ADR-0016 already parks both, on reasons this ADR
  does not change.

## Alternatives

**Supersede ADR-0016 rather than amend it.** The available reading, and the closest call in this
ADR: the rule above is not only a corrected premise, it adds a sentence to the security model that
ADR-0016 never contained — *a connection from one of our own bind addresses is a trusted hop*. That
is decision content. **It loses on three counts.** ADR-0016's decision — Tailscale identity
authorises writes — is *right*, and superseding marks it as wrong to every future reader; §B5 spends
a paragraph on exactly that distinction. Four of its five decisions are untouched and implemented, so
a superseding ADR would have to restate them to keep them in force, which is the restatement §B5
tells us to prefer a link over. And the owner accepted ADR-0016 on 2026-08-03 (Y-103) **knowing this
hole**, which is an acceptance of the decision rather than of the premise; retiring the document now
would misdescribe what was agreed. Amending is also the shape this repo already uses for an ADR that
corrects another — [ADR-0008](0008-withdraw-the-stdin-watchdog.md) amends
[ADR-0006](0006-ssh-exec-transport.md) and [ADR-0010](0010-drop-branch-from-the-workspace-schema.md)
amends [ADR-0007](0007-workspace-schema-v1.md), each naming what stands unchanged.

**Authorise on `Tailscale-User-Login` instead.** It reads like the intended mechanism and it is the
one Tailscale's own documentation demonstrates. It loses on the measurement above: it names a login
where ADR-0016 authorises on `Node.User` and `Node.Tags`, and a **tagged node carries no identity
header at all**, so the check would have to treat *absent* as *refuse* — and absent is also what a
Funnel request, an unproxied request and an internal lookup failure look like. The one node the ADR
was bought to refuse would be refused by accident, in the same branch as three benign cases, with
nothing distinguishing them. Its address, by contrast, resolves.

**Bind the daemon to loopback and make the proxy the only door.** This is Tailscale's documented
advice for identity headers, and it would make the whole question disappear. It loses on this
fleet: `yantra-agent` posts heartbeats to 7717 **across the tailnet**, so a loopback-only daemon has
no fleet, and Y-069 refuses a loopback bind by design because the bind address is the security model
(R-22). It trades one lost failure mode for a broken one.

**Terminate TLS in the daemon and drop the proxy.** §B2 — orchestrate, don't reinvent — and Y-111's
own reasoning: Tailscale already holds and renews a publicly-trusted certificate for this machine's
`<tailnet>.ts.net` name, and owning certificate renewal in `axum` is the kind of thing this project
declines on purpose.

**Do nothing, and leave the warning in the documentation.** This is what exists today: three files
tell the reader that `allowed()` is not protection behind the proxy. It is honest, it costs nothing,
and it is a real option for a one-user tailnet. It loses because the documentation is not in the
request path — the daemon still answers *authorised* to a caller it cannot name, and the day the
tailnet changes shape is a day nobody re-reads `docs/development.md`.
