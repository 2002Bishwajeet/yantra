# M5 — Control from the phone

**Status:** planned 2026-08-02. Supersedes the `Placement` scope for M5; automatic placement moves to
M10.

## 1. The acceptance test

The owner set it in one sentence, and it is the only thing this milestone has to deliver:

> *"I want to open my personal website development page in Claude on the Mac and start building —
> from my phone or iPad."*

Concretely: pick up a phone, open Yantra, tap the workspace, choose `bishwajeets-macbook-pro`, tap
start, and Claude Code is running in a tmux session on the Mac in the right repo. No terminal, no
laptop, no SSH.

## 2. Why the scope changed

M5 was `Placement` — scoring, `preferred`/`automatic` modes, and `yantra why`. The owner deferred it
on 2026-08-02, and the reasoning is worth keeping: **automatic placement is the largest unbuilt thing
in the project and it solves a problem the owner does not have yet.** Two machines, one of which is
usually the right answer, does not need a scheduler; it needs a list to tap.

The deferral costs nothing already built. [ADR-0013](../adr/0013-the-heartbeat-carries-only-what-placement-scores.md)'s
heartbeat was justified by *"what placement scores"*, and every one of the seven fields is equally
what a **person** reads when choosing a machine by hand — free RAM, free disk, CPU busy, on battery
or not. **The consumer changed; the payload did not.** M5's agent work feeds a human picker instead
of a scorer, and Y-109 renders it either way.

## 3. What is actually missing, measured rather than assumed

The dashboard is **read-only by construction**, not by omission. The API is five `GET` routes plus
`POST /heartbeat`, the web UI issues no write of any kind, and
[`web/src/components/Command.tsx`](../../web/src/components/Command.tsx) says so in a comment:

> *"The API answers 405 to every write, so the row hands over the command instead."*

Y-097 chose that deliberately — a row hands over a command to paste into a terminal. **From an iPad
that is worth nothing.** The gap between here and the acceptance test is write routes and buttons,
and it appears in no milestone: M4 was scoped read-only on purpose and M6 is the browser terminal.

## 4. Three constraints found before planning around them

### 4.1 The PWA needs a secure context, and we serve plain HTTP

`yantrad` serves HTTP on a `100.64.0.0/10` address. Service workers do not register outside a secure
context, so **the PWA is blocked on TLS** — and this is already costing us: `Command.tsx` cannot use
`navigator.clipboard` for exactly the same reason and falls back to selecting the text.

**Verified 2026-08-02:** the tailnet has HTTPS certificates enabled — `tailscale status --json`
reports a non-empty `CertDomains`, and `tailscale cert` exists in 1.98.9. So a real, publicly-trusted
cert for `cachyos-g14.<tailnet>.ts.net` is available today with no admin-console change.

**Closed by Y-111 on 2026-08-03**, and it held: `tailscale serve` issued a Let's Encrypt certificate
(`issuer: C=US; O=Let's Encrypt; CN=YE1`) with no admin-console change, and the dashboard, the app
bundle, the SPA fallback and `/api/machines` all answer over HTTP/2 TLS. `just https` is the whole of
it; no TLS code entered `axum`.

### 4.2 Waking a sleeping machine is not possible from the phone, and will not be this milestone

[Research note 01 §6](../research/01-tailscale-inventory.md): Tailscale is L3, magic packets are L2
broadcast, there is **no `tailscale wake`** subcommand, and a sleeping machine's NIC has no IP stack.
Waking requires an always-on peer on the same L2 segment emitting the packet, plus a hand-maintained
MAC table, because Tailscale never exposes a MAC.

**The owner confirmed on 2026-08-02 that no such always-on machine exists yet.** So Q10's prior
stands: WoL waits for the appliance (M7). The research also warns the pattern reliably wakes
*powered-off* machines but often **not S3 sleep**, which is precisely a closed MacBook — so this is
not merely deferred work, it is unproven work.

What M5 owes instead is honesty (R-23): a machine we have not heard from is shown as exactly that,
with **no wake button that would not work**.

### 4.3 A writable API is a different object from a readable one

`R-22` already says the bind address is the entire security model, because Q6 removed authentication.
That is defensible for reads. It is not defensible for *start a process on my Mac*: anything reaching
the tailnet could launch sessions anywhere in the fleet.

**Owner's decision, 2026-08-02: writes are authorised by Tailscale identity.** The mechanism already
exists — [Y-105](../../tracker.md) put each peer's tailnet addresses on `MachineInfo` and
[Y-108](../../tracker.md) attributes a heartbeat by source address. Writes reuse that lookup: the
daemon resolves the caller to a peer and refuses anyone it cannot name. This wants an ADR (§B5),
because it is a decision and not an implementation detail.

### 4.4 There is nothing to open yet

Checked against [`docs/brainstorm.md`](../brainstorm.md) rather than assumed, and it is the one place
this plan was out of sync with the vision. UI Philosophy:

> *"Everything should be configurable from the interface. No YAML editing. No configuration files.
> Configuration files are implementation details. The interface should generate them automatically."*

**The fleet has zero workspaces.** `yantra ls workspaces` answers *"no workspaces yet — make one at
`~/.config/yantra/workspaces/<name>.toml`"*, so the acceptance test in §1 cannot begin: creating the
`personal-website` workspace means finding a terminal, which is the thing this milestone exists to
stop.

The TOML file **stays** the source of truth — Y-044 established it is one of three stores Yantra did
not invent and should not replace. The UI generates it; it does not supersede it.

**The rest of `brainstorm.md` is in sync, and the re-scope moved toward it, not away.** Its
Scheduling Philosophy names three modes with **Manual first** (*"scheduling should assist, not
dictate"*), its MVP list puts **Scheduling at Phase 6** — after the web UI and AI orchestration,
which is *later* than the tracker's old M5 — and **Wake-on-LAN sits under Future Possibilities**, never
core.

### 4.5 Nothing serves the dashboard

`yantrad` mounts `/api` and `/healthz` and **nothing else**. The web UI is served by Vite's dev
server, which proxies `/api` across to the daemon:

```
"dev": "YANTRA_API=http://$(tailscale ip -4):7717 vite"
```

So looking at the dashboard today means running a development server on a laptop, which is not a
thing to do from a phone. **Y-073 is therefore a prerequisite of this milestone rather than an M4
leftover** — without it, TLS has nothing to put behind it.

It also settles the origin question in the PWA's favour: one process serving both the app and the
API means same-origin, no CORS, and a service-worker scope of `/`.

### 4.6 The tailnet root is taken

`tailscale serve` on `cachyos-g14` already proxies `/` to `http://127.0.0.1:8080`, which is
**code-server**. That is deliberate and stays. Yantra takes its own HTTPS port rather than a subpath:
a port is uglier in a URL, and a subpath costs the service worker its `/` scope and makes every asset
path relative for the rest of the project's life.

`tailscale serve` must also proxy to the **tailnet address**, not `127.0.0.1` — Y-069 has `yantrad`
bind only the addresses Tailscale says this machine holds, and loopback is deliberately not among
them.

**Y-111 chose 8443** — the conventional alternate-HTTPS port, and the one Tailscale's own `serve` and
`funnel` help pages use as their example. Two things this section did not know, both measured on
2026-08-03. `tailscale serve` accepts **any** HTTPS port, not only 443/8443/10000 — 9443 configured
without complaint — so the choice was free rather than forced. And it accepts a port another process
already holds, reporting success while `ss -lntp` still shows the socket belonging to that process:
`--https=7717` looked fine and gave nothing, which is the argument for one meaning per port rather
than any conflict the CLI would have caught.

**And §4.3's mechanism does not survive this section.** A proxy terminates the caller's connection
and opens its own, so `yantrad` sees the proxy's address; measured from `bishwajeets-macbook-pro`,
the backend saw *this* node with the real caller only in `X-Forwarded-For`. Writes from the phone
still work — the proxy runs on the owner's own untagged node — but ADR-0016's check no longer
distinguishes callers behind 8443, which is the one thing it was bought for. Recorded as a dated
amendment on ADR-0016 and carried by **Y-118**; it does not block Y-113 or Y-114.

## 5. The tasks

| # | Task | Why it is where it is |
| --- | --- | --- |
| Y-073 | `yantrad` serves the built dashboard | 4.5 — first, because TLS needs something behind it. Embedding stays behind a cargo feature that is off by default (R-24: no Rust build should need npm). |
| Y-111 | `yantrad` behind `tailscale serve`, so the UI is HTTPS | Unblocks 4.1. §B2 says orchestrate rather than reinvent: `tailscale serve https / proxy 7717` is a config line against terminating TLS in `axum` and renewing certs ourselves. **Done 2026-08-03**, and it cost ADR-0016 its failure mode — see 4.6. |
| Y-118 | The proxy hides the caller, so identity must come from the forwarded address | Falls out of Y-111 and belongs to 4.3 rather than 4.1. Not a blocker for anything in this milestone. |
| Y-112 | ADR-0016 + write routes authorised by peer identity | The decision recorded, then `POST /api/workspaces/{name}/{up,down,resume}`. Reuses Y-108's source-address lookup. |
| Y-113 | The dashboard acts: a machine picker and real buttons | Replaces the copy-a-command affordance where a write now exists. `Command` stays for `attach`, which is still a paste. |
| Y-114 | PWA shell — installable on iOS | Needs Y-111. Manifest, icons, `apple-touch-icon`, `display: standalone`, an offline shell that never caches a reading (R-23: a cached dashboard tells confident lies). **Done 2026-08-03**, hand-written rather than `vite-plugin-pwa`, and the readings are never intercepted at all rather than cached carefully. The install to a home screen is the one part no test here reached — it wants a device. |
| Y-115 | Unreachable machines read honestly, and offer no wake | Closes the loop on 4.2 rather than leaving a gap the UI has to invent. |
| Y-116 | Create and edit a workspace from the dashboard | 4.4 — without it the acceptance test has nothing to open. |

Y-109 (beat age on the dashboard) is not part of this milestone but is its natural companion: the
picker in Y-113 is far more useful when each machine shows its own free RAM and power state.

## 6. Not in scope

- **Automatic placement, scoring, and `yantra why`** — M10.
- **Wake-on-LAN** — M7, and unproven for S3 sleep even then.
- **The browser terminal** — M6, unchanged. M5 starts and stops sessions; it does not attach to them.
- **Anything that stores a secret on the phone.** §B4 holds: the PWA gets no token to keep.
