# R12 — A custom domain over the tailnet, and the certificate that has to come from somewhere else

**Question.** Can the dashboard answer on `yantra.cloudx.run` over real HTTPS, reachable from a
browser on the tailnet and nowhere else?

**Short answer.** Yes, and it needs **no Rust**. What it needs is a certificate Tailscale will not
issue, obtained by a challenge the usual method cannot run, from a DNS API that this registrar gates
behind three conditions. Every one of those is verified below rather than assumed.

Accessed 2026-08-06. Re-verify before relying on any of it — §B6.

---

## 1. The finding everything else follows from

**Tailscale issues certificates for the tailnet's own namespace and nothing else.** Its HTTPS
documentation puts it plainly: *"TLS certificates are issued based in your tailnet name"*, and the
only shape discussed is `*.ts.net` — `tailnet-NNNN.ts.net`, or a word-pair like `yak-bebop.ts.net`.
`tailscale cert` requests *"a certificate for this machine on this domain"*, where the domain is the
tailnet's. There is no vanity-domain or bring-your-own-certificate path.

So [`justfile`](../../justfile)'s `tailscale serve --bg --https=8443` — which is what serves the
dashboard over TLS today, terminating it in `tailscaled` and proxying to `http://<tailnet-ip>:7717` —
**cannot present a certificate for `yantra.cloudx.run`.** Something else has to terminate TLS.

## 2. The daemon already permits this, and by more than the tool that motivated the rule

This is the part that makes the change cheap. [ADR-0017](../adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md)
is written about `tailscale serve`, but the condition it encodes is general.
[`write.rs`](../../crates/yantrad/src/write.rs) `caller_address`:

```rust
if !self.bound.contains(&peer) {
    return Ok(peer);
}
```

The reasoning is in the doc comment above it: nothing off this machine can open a connection that
appears to come from one of our own bind addresses, **so a request that does was opened here by a
proxy that terminated the caller's connection and wrote its address down.** That is a statement about
*locality*, not about which binary is doing the proxying. **A reverse proxy on the same node inherits
the trust `tailscale serve` has**, and no Rust changes.

**One rule the replacement must respect.** §3 of that ADR is *one address or refuse*:

```rust
if forwarded.next().is_some() {
    return Err(Refused::Forwarded(
        "a proxy on this machine forwarded more than one address, and `tailscale serve` writes exactly one",
    ));
}
```

Caddy and nginx both **append** to `X-Forwarded-For` by default. A client that sends its own header
therefore produces two addresses and the daemon refuses. It fails closed, which is right, but it
fails. **The proxy must overwrite the header, not add to it.** This is the single most likely way to
get a working setup that mysteriously refuses.

## 3. DNS — a public record that only works privately

`yantra.cloudx.run` gets an ordinary public `A` record pointing at the node's `100.x.x.x` Tailscale
address. It resolves for the whole internet and **functions only from inside the tailnet**, because
`100.64.0.0/10` is CGNAT space that routes nowhere else. No split-horizon DNS needed.

**This is the property being asked for, and it is free.** Publishing the record exposes nothing:
there is no listener on a public interface, no port forward, and the address is unroutable from
outside. Every device on the tailnet reaches the name; everything else resolves it and then has
nowhere to send a packet. Note the address is **per-tailnet** — a second tailnet is a second address
and a second record, not something this one covers.

**Nothing about the topology is hard.** The whole cost of this note is in §4–§6, and every bit of it
is about obtaining and *renewing* a certificate browsers already trust — never about reachability.

### The record does not have to be public — the challenge does

**"Public DNS record" and "publicly reachable service" are different claims, and only the second one
matters for safety.** Still, if the record itself is unwanted in public DNS, it need not be there:

| | Where the name resolves | Cost |
| --- | --- | --- |
| **Public `A` record** | Everywhere; routes only on the tailnet | Nothing. Works on every device, iPhone included |
| **Tailscale split DNS** | Tailnet members only; **absent from public DNS** | A nameserver on the tailnet — which the appliance is the natural host for |
| `/etc/hosts` per device | Wherever it is written | Does not work on iOS, and scales by hand |

**But a publicly-trusted certificate cannot be obtained privately.** DNS-01 asks the CA to read
`_acme-challenge.<name>` **TXT from public DNS**, at issuance and at every renewal. The `A` record is
never queried by the CA and can stay private; the challenge record cannot. So:

- **trusted certificate with no public `A` record** — split DNS plus a public `_acme-challenge`. Fine;
- **nothing public at all** — then the certificate must come from a private CA whose root is
  installed on **every** device that opens the page, a phone included. That is a real chore and a
  browser warning on any device that was missed.

**Who can use it is settled by tailnet membership, not by DNS.** Another person reaches this by being
on the tailnet; both rows above then behave identically for them. Someone not on the tailnet is given
nothing by either.

**It is a disclosure, and a small one, but name it.** [R-22](../../tracker.md#7-risk-register) says
the bind address is the entire security model and lists *machine names, workspace names, repo paths*
as what that protects. A tailnet IP in public DNS is less than any of those — it is unroutable and
useless without WireGuard keys — but this repo redacts `100.x` on purpose, and this would publish one
deliberately. The alternative is Tailscale split DNS, which costs a nameserver the fleet does not
have. **Recorded as a consequence, not argued either way.**

## 4. The certificate — and the trap worth avoiding

**HTTP-01 validation cannot work here.** It requires the CA to reach the host over the public
internet on port 80. Nothing about this fleet is publicly reachable, and making it so would
contradict the whole of §3 of [`architecture.md`](../architecture.md). **So the challenge must be
DNS-01.**

**A Cloudflare Origin Certificate will not work, and it looks like it should.** Those are trusted
only by Cloudflare's own edge. In this topology the browser connects *straight to the tailnet node*
with no Cloudflare in the path, so the browser sees a certificate from an issuer it does not trust
and refuses. Anything self-signed or from a private CA has the same problem unless the CA is
installed on every device that will open the page — a phone included.

**What is needed is an ordinary publicly-trusted certificate** (Let's Encrypt, ZeroSSL) obtained by
DNS-01. The name never has to be publicly reachable for this to work; only the DNS zone does.

## 5. Namecheap, specifically — three gates, and one of them is a time bomb

`caddy-dns/namecheap` exists and takes an API key, an API user, and a client IP (deduced if omitted).
It must be compiled in with `xcaddy build --with github.com/caddy-dns/namecheap` — DNS providers are
not in a stock Caddy binary.

But Namecheap's API has conditions, and they are the reason this section exists. From their own FAQ:

| Gate | What it says |
| --- | --- |
| **Eligibility** | API access needs **one of**: *"at least 20 domains under your account"*, *"at least $50 on your account balance"*, or *"at least $50 spent within the last 2 years"* |
| **IP allow-list** | *"whitelist at least one IP before your API access begin to work"* — and **only IPv4** addresses can be whitelisted |
| **DNS service** | *"API can be used for the domains that are registered with us only. If the domain is using our PremiumDNS/FreeDNS, you will not be able to manage it via API"* |

**The allow-list is the one that hurts, and it hurts exactly where M7 is weakest.** The appliance is
a headless box on a home connection with nobody watching it. A residential IPv4 address changes.
When it does, nothing breaks — until the certificate comes up for renewal up to ninety days later,
the API call fails against a stale allow-list, and the dashboard goes untrusted on a machine that
exists precisely so that nobody has to tend it. That is a silent failure with a three-month fuse.

The eligibility gate may also simply not be met; that is an account fact, not a technical one.

## 6. Two ways around all of it, and the cheap one needs nothing set up

### By hand, today, with no API at all

`certbot certonly --manual --preferred-challenges dns -d yantra.cloudx.run` prints a TXT record,
waits, and issues once the record resolves. The record is pasted into Namecheap's web UI like any
other. **None of §5 applies** — no API means no eligibility gate, no allow-list, no plugin, no
`xcaddy` build. This is the fastest route to a working page and it is a perfectly good starting
point.

Its whole cost is the renewal. Let's Encrypt certificates last **90 days**, `--manual` cannot renew
unattended by design, and the failure is the dashboard going untrusted on a day nobody was thinking
about it. **Certificate lifetimes are also being shortened industry-wide**, so do not assume a
purchased certificate buys a comfortable year — check the current maximum when this is actually done
rather than taking a number from this note.

### Delegate only the challenge



**`_acme-challenge` can be delegated with a CNAME, and it is the standard escape hatch.** Namecheap
keeps the domain and keeps serving the `A` record. A single static CNAME is added once:

```
_acme-challenge.yantra.cloudx.run.  CNAME  yantra.<some-zone-with-a-good-api>.
```

The ACME client then satisfies the challenge in the delegated zone, using **that** provider's API.
Consequences: **no Namecheap API, no eligibility gate, no IP allow-list, nothing to re-whitelist when
the home address changes** — and the delegated credential can only ever touch a zone that holds
challenge records, so its blast radius is one TXT record rather than the domain.

**This is the recommendation.** It removes the failure mode in §5 entirely and costs one CNAME
created once by hand.

## 7. What we would actually run

Static certificate, if the files are simply uploaded:

```caddyfile
yantra.cloudx.run {
    bind 100.x.x.x
    tls /etc/ssl/yantra/fullchain.pem /etc/ssl/yantra/privkey.pem
    reverse_proxy 100.x.x.x:7717 {
        header_up X-Forwarded-For {remote_host}
    }
}
```

`bind` keeps the listener off every other interface, which is what preserves the property
[`architecture.md`](../architecture.md) §3 claims. `header_up` is §2's overwrite. WebSocket upgrade —
which the M6 terminal needs — is proxied by `reverse_proxy` without configuration.

Renewing automatically instead, once `_acme-challenge` is delegated, replaces the `tls` line with the
provider's DNS block and Caddy handles issuance and renewal itself.

**The API token is a secret and follows §B4**: it reaches Caddy from the unit's environment, exactly
as `YANTRA_NTFY_URL`/`YANTRA_NTFY_TOKEN` reach the daemon ([Y-147](../../tracker.md#3-task-board)).
It is never a file Yantra writes, never a workspace field, and **the key and certificate never enter
this repository** — it is public.

## 8. What it costs M7

A second long-running process on the appliance, with its own unit, its own failure mode and its own
place in the boot ordering that [Y-142](../../tracker.md#3-task-board) had to work out for the
daemon. Whether the appliance should carry a reverse proxy at all — or whether the custom domain is a
convenience for the laptop and the appliance keeps `tailscale serve` — is a real question and **this
note does not answer it** ([§B0](../../CLAUDE.md)).

Also worth weighing against all of the above: `<host>.<tailnet>.ts.net` already works, is already
trusted by every browser, and renews itself with nobody watching. **The custom domain buys a nicer
name and costs a proxy, a DNS delegation and a renewal path.** That trade is the owner's.

---

## Sources

All accessed **2026-08-06**.

- [Enabling HTTPS — Tailscale](https://tailscale.com/kb/1153/enabling-https) — certificates are
  issued from the tailnet name; `*.ts.net` only; no custom-domain path.
- [Namecheap API — FAQ](https://www.namecheap.com/support/knowledgebase/article.aspx/9739/63/api--faq/)
  — the 20-domains / $50-balance / $50-spent eligibility rule, mandatory IPv4-only allow-listing, and
  the PremiumDNS/FreeDNS exclusion.
- [`caddy-dns/namecheap`](https://github.com/caddy-dns/namecheap) — API key, API user and client IP;
  built with `xcaddy build --with …`; the README recommends the Namecheap sandbox first.

**Yantra internal** — [`CLAUDE.md`](../../CLAUDE.md) §B0, §B2 and §B4;
[`justfile`](../../justfile) the `tailscale serve` recipes;
[`crates/yantrad/src/write.rs`](../../crates/yantrad/src/write.rs) `caller_address` and `Refused::Forwarded`;
[ADR-0017](../adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md);
[`docs/architecture.md`](../architecture.md) §3;
[`tracker.md`](../../tracker.md) risk R-22 and rows Y-142 and Y-147.
