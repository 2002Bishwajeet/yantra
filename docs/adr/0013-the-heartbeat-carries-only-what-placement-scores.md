# ADR-0013 — The heartbeat carries only what placement scores, and absent power data means AC

- **Date:** 2026-07-31
- **Status:** accepted (2026-08-03, by the owner — Y-103)
- **Closes:** Y-020
- **Builds on:** Q3, which settled the *shape* — push heartbeat, 10 s, stale at 30 s — and nothing else.

## Context

[Q3](../../tracker.md) is closed and is not re-opened here. [R1](../research/01-tailscale-inventory.md)
found that Tailscale exposes **no** host telemetry, verified against three separate surfaces
(`ipnstate.PeerStatus`, the full 235 KB API v2 OpenAPI spec, and `tailscale metrics print`), so the
data has to come from a process on each machine. [R5](../research/05-scheduling.md) then killed the
SSH-polling alternative: 3–8 handshakes per placement, and **blind to a sleeping laptop** — precisely
the case a scheduler exists to answer.

Everything else is unwritten, and three things now depend on it.
[`yantra-agent`](../../crates/yantra-agent/CLAUDE.md) is a nineteen-line stub whose README says the
payload is undecided; M5's scheduler cannot be built against an unspecified fact set; and M4's read
model (Y-070) is about to define where fleet state lives, which is where a heartbeat lands.

**The discipline applied here is I-10**, from [`crates/yantrad/tracker.md`](../../crates/yantrad/tracker.md):
*if a signal is not in the decision record, it must not influence the decision.* Read forwards it
stops the score function growing hidden inputs. Read backwards it is a collection rule — **a signal
that cannot change a placement decision has no reason to be collected**, because every field the
agent gathers is a field someone eventually scores on, unrecorded. R5's own fact table fails that
test: it collects GPU memory used, GPU utilisation and Wake-on-LAN readiness, none of which appear in
any of R5's six filters or six score terms.

The second pressure is **R-12**. This agent is the only software Yantra installs *on* a machine
rather than talking *to*, which makes it the place where a workspace orchestrator turns into a
fleet-management product. R-12's mitigation is "heartbeat-only; no logic, no versioned protocol
beyond a JSON blob". A payload is the first chance to break that.

## Decision

### 1. Seven fields, each with a named consumer

```json
{ "sent_at": "2026-07-31T18:30:00Z", "arch": "x86_64", "labels": ["gpu", "cuda", "docker"],
  "free_ram_mb": 19942, "free_disk_mb": 214003, "cpu_busy_pct": 15, "power": "ac" }
```

| field | feeds | why it earns its place |
| --- | --- | --- |
| `sent_at` | **nothing** | The one deliberate exception, and the rule that contains it: it is *never* the freshness source. R5 asks for both timestamps because clock skew corrupts heartbeat-age checks; this is the only way to tell "measured 9 s ago, delivered slowly" from "this machine's clock is wrong" — the failure that would make all six real fields quietly false. Diagnostic, and outside the decision record's signal set. |
| `arch` | hard filter 3 (`requires.arch`) | **Nothing else knows it.** Tailscale reports `os` on every peer and architecture on none — absent from `PeerStatus` and from the API v2 `Device` schema alike (R1 §1, §3). |
| `labels` | hard filter 4 (set containment) · score *capability match* (5) | Capability labels **derived from probes at agent start** — `nvidia-smi` exits 0 ⇒ `gpu` — which is R5's own answer to label drift: a machine tagged `gpu` whose driver broke otherwise passes the filter forever. |
| `free_ram_mb` | hard filter 5 · score *RAM headroom* (20) | **Free, never total.** R5 is explicit that `requires.ram_gb` is measured free memory, and total RAM appears in no formula. Integer megabytes, so no float and no locale crosses the wire. |
| `free_disk_mb` | hard filter 5 (`requires.disk_gb`) | The only filter that rejects a machine for a reason a human would call "full". Root filesystem only — see the cost below. |
| `cpu_busy_pct` | score *CPU idle* (15) | The **common currency**: Windows has no load average, so the agent normalises rather than the daemon, deriving `min(load1/ncpu, 1) × 100` on Linux and macOS. R5 admits this is not strictly comparable across operating systems and accepts the imprecision; so does this. |
| `power` | score *power state* (10) | The I-9 field. See §2. |

One message shape, every 10 s, carrying the fast-moving and the fixed facts together. This departs
from R5, which put static facts on a separate 15-minute cadence: two cadences mean the daemon holds a
partial record, merges it, and acquires a "the static block never arrived" state. One message means
it overwrites a whole row and has no merge logic to get wrong. The probes stay cheap because
*measuring* the fixed facts still happens once, at agent start; only their transmission repeats, at
well under a kilobyte a beat.

**Unknown fields are rejected.** `inventory.rs` parses Tailscale leniently because that is someone
else's unstable format; this is Yantra's format on both ends, so an unknown key is a version
mismatch, and `workspace`'s reasoning applies. There is no version field and no negotiation (R-12).
The cost is stated plainly — **upgrade the daemon before the agents**, or the fleet goes dark until
you do. That failure is loud and logged, which is the direction to fail; silently ignoring a field
the daemon does not understand produces a signal that looks collected and influences nothing.

### 2. Power is a two-variant enum, so "unknown" is unrepresentable

```rust
enum Power { Ac, Battery { percent: u8 } }
```

**I-9** says absence of power-supply data means AC, never "unknown", and it is not a hardware detail
— it is a scoring bug in disguise. Desktops have *no* `/sys/class/power_supply/AC*` entry at all;
`BAT0/status` reads `Not charging` while plugged in; `Win32_Battery` returns **no instances** on
Windows desktops; `pmset -g batt` on a desktop Mac prints only the AC line. Read naively, every
always-on desktop — the most placeable machines in the fleet — lands in an unknown bucket and is
scored down for it.

A convention would not survive the third contributor. The schema enforces it instead:

- No `Option<bool>`, no `ac: bool`, no third variant, so no code path can *express* unknown power.
  Adding one would mean changing the wire format and R5's score table in the same commit — and that
  table has no row for it (AC 1.0; battery >60 % 0.5; 20–60 % 0.2; ≤20 % 0.0).
- **`Battery` requires two positive readings**: a battery device reporting mains offline, *and* a
  charge percentage from that same device. Anything less — no device, no mains entry, an unreadable
  file, a platform the reader does not recognise — is `Ac`.
- **AC is never inferred from a battery's `status` string.** That is the trap I-9 was measured on.

The residual risk is chosen deliberately: a laptop whose battery reader breaks looks like a desktop
and can be placed on while unplugged. The trade is asymmetric twice over. The error this prevents is
*certain and fleet-wide*; the error it permits is *contingent on a broken reader*. And power is a
**score** term, never a filter, so the worst outcome is a reordering among machines that were all
feasible anyway, bounded at 10 points of 100.

### 3. What is deliberately not collected

Each of these sits in R5's fact table, in R1's build-it-yourself list, or in the obvious shape of a
metrics agent — and each fails I-10 read backwards.

- **Total RAM, core count, uptime, load averages, network counters, temperatures.** No filter and no
  score reads any of them. `cpus` exists only to derive `cpu_busy_pct`, which the agent does itself.
- **GPU model, VRAM total, VRAM used, GPU utilisation.** Placement asks *is there a working GPU*,
  which is a capability label. R5's table collects four numbers its own scorer never reads.
- **MAC address and Wake-on-LAN readiness.** [Q10](../../tracker.md)'s prior is to drop WoL until the
  appliance exists, and a scheduler that cannot wake a machine does not place work there — so neither
  field can change an outcome today. When WoL becomes real the payload grows by exactly these two.
- **`os`.** Tailscale already reports it and `MachineInfo.os` already carries it. A second source for
  one fact is a disagreement waiting to happen, and those are the bugs that look like something else.
- **Any name at all.** See §5.
- **tmux sessions and agent process state**, which R1's list does name. M3 settled that session state
  is derived from tmux and `claude agents --json` over SSH
  ([ADR-0011](0011-claude-code-runs-as-a-tui-in-tmux.md)); an agent reporting sessions would be the
  second derivation Y-044 has spent three milestones avoiding.
- **Anything the agent would have to be *told*.** Hand-written labels, taints, `drain`, `priority`
  and `prefer` are daemon-side configuration. The agent reports what it can *measure*; a fact it has
  to be told is a fact it can be wrong about — wrong locally, five machines from the file that is right.

### 4. Transport: `POST /heartbeat`, on the listener that already refuses to go off-tailnet

JSON body, port **7717**, the listener Y-069 built. No new port, no new protocol, no new dependency,
no TLS — WireGuard already authenticates and encrypts the path, and a second encryption layer inside
the tunnel buys nothing the tailnet does not provide.

**The response is `204 No Content` and will never carry instructions.** A reply the agent acts on is
a control channel, and a control channel is how this crate stops being a reporter — R-12's drift, one
response body away.

The agent's **only** configuration is which machine runs the daemon: no flags, no config file, no
state. That value belongs in the service unit, which the install story (R-12, M7) has to produce anyway.

**The local agent is the hard case, and I-38 is why.** The machine running the daemon needs telemetry
like any other ("localhost is not a special case"), but its own MagicDNS short name resolves to
`127.0.1.1` through `/etc/hosts`, and the daemon does not listen there — only on the addresses
Tailscale says it holds.

**Measured 2026-07-31 against the running daemon, and it splits I-38 in two — see I-50.** From
`cachyos-g14`, with `yantrad` bound to that machine's own tailnet addresses:

| Dialled | Result |
| --- | --- |
| its own tailnet address | **`ok`** |
| its own MagicDNS short name | fails — `getent hosts` returns `127.0.1.1` |

So a host **can** reach a normally-bound listener on its own tailnet address. I-38's "self-directed
traffic never traverses the WireGuard path" is about `tailscaled` **intercepting** port 22, which
needs that path; a real listener bound to the address needs no interception, because the address is
on a local interface. The local agent therefore works like every other one — **as long as it dials
the address and never the name.** That is the whole of the special case, and it is a configuration
detail rather than a second code path.

### 5. Identity is the source address, not a field in the body

The heartbeat names no machine. The daemon attributes it to the peer that owns the source address,
resolved against the Tailscale inventory it already parses, and **drops a heartbeat from an address
that is not a known peer**. R1 named this mechanism for exactly this purpose — attributing an inbound
connection with zero credentials.

It honours **I-5** and **I-33** for free: the key is `Peer.ID` and the display name is `DNSName`'s
first label, neither of which the agent could supply without speaking the LocalAPI on three operating
systems (R1 §2: a unix socket on Linux, a token file on GUI macOS, a named pipe on Windows).

And it is **address → identity, not name → address**.
[ADR-0009](0009-machine-names-are-ssh-destinations.md) declined the latter because `~/.ssh/config`
owns it; this direction dials nothing and decides nothing about where a connection goes — it says
what an arrived connection *is*. It does require `MachineInfo` to carry each peer's addresses, one
more observed field on a struct that already exists. Attribution reads the **background-refreshed**
inventory rather than calling the LocalAPI per request, because Y-070's rule is that nothing
expensive happens on the request path.

### 6. The write path, honestly

This is the first write into `yantrad`. Until now the daemon has been read-only and unauthenticated,
protected by *where it binds* and nothing else — R-22, and Q6 is why there is no auth to add. A POST
changes what R-22 covers, and that should be written down rather than happen quietly.

What is exposed: anything that can reach the tailnet can write a heartbeat, and the tailnet is not a
set of trusted servers — it includes a phone and a tablet ([`docs/machines.md`](../machines.md)), and
R1 found two of five peers holding expired keys while still in the netmap. A forged heartbeat can
make a machine look free when it is not, or overwrite the real agent's row by racing it. What it
cannot do is escalate: the heartbeat is **data for a score**, never a path, name, command or
filename, so nothing in it reaches the layer where ADR-0006 turns a string into a remote shell
command. Its worst outcome is a session placed somewhere that then fails to start — a
denial-of-usefulness, not an execution primitive.

The mitigations, in order of what they cost:

1. **Identity comes from the source address** (§5), so a body cannot claim to be another machine. The
   problem shrinks from *anyone can impersonate anyone* to *anyone can impersonate itself*.
2. **Bounded, typed input**: an explicit body limit measured in kilobytes rather than `axum`'s 2 MB
   default, strict types, unknown keys rejected.
3. **It writes to memory, not to disk** — one row per machine in the snapshot Y-070 already builds,
   overwritten every beat. That falls out of the no-history non-goal, and it means a flood costs CPU
   and cannot fill a disk. Y-044 recedes a fourth time.

Not done: no shared secret, no per-agent token, no mTLS, no request signing. A pre-shared key across
five machines is a secret Yantra would have to store, and §B4 says it never stores secrets. What
would change that is below.

### 7. Late, asleep, and a daemon that is not there

**When the daemon is down** the POST fails and the agent **drops that beat**. It does not queue,
buffer or replay: a heartbeat describes *now*, and one delivered 40 s later is a false statement with
a timestamp attached. The interval never changes — 10 s is slow enough that backoff is ceremony — and
the agent logs the first failure then stays quiet until the next success, so a daemon down for a day
does not produce 8,640 identical lines. **The agent never exits on a failed POST**; a restarted
daemon must not require reinstalling five agents.

**Late and asleep are different, and the heartbeat alone cannot tell them apart.** Nothing arriving
looks identical whether the machine is asleep, powered off, partitioned, or running fine with a
crashed agent. For *placement* that does not matter and R5 is right to collapse it: no beat within
30 s ⇒ infeasible, because it is better to under-place than to place onto a dead box. 30 s is three
intervals, so a single lost POST — expected occasionally over a DERP-relayed path — never marks a
machine stale.

For *display* it matters completely, and R-23 is the risk: a dashboard that says **asleep** when it
means **we have not heard from it** is exactly the confident lie M4 is trying not to tell. So the
daemon reports the age, and uses Tailscale's independent view only to explain it:

| beat within 30 s | `Online` | what the daemon says |
| --- | --- | --- |
| yes | — | **ready**, with facts and their age |
| no | `true` | **up, but not reporting** — an agent or install problem (R-12's own failure mode), a different thing to go and fix |
| no | `false` | **asleep or off** — the closest thing to a sleep signal that exists, since a sleeping host loses its control session |
| never | — | **never heard from**, and that is `None`, not an empty row (I-47's lesson, Y-070's third rule) |

`Online` sharpens the *explanation* and never the *feasibility*, because R-8 says `Online: true`
means the control plane sees the machine, not that anything can reach it. The filter stays "a beat
within 30 s"; Tailscale's view appears only in the rejection's `detail`, which keeps it inside the
decision record and therefore inside I-10.

There is **no flap damping and no hysteresis** — a late beat that arrives simply makes the machine
fresh again. R5's sleep/wake flapping risk (feasible at filter time, asleep five seconds later) is
answered in the scheduler by re-verifying freshness immediately before starting a session and
treating a vanished machine as a one-shot retry. That is M5's, not this schema's.

## Non-goals

- **No metrics history and no time series.** The daemon keeps the latest row per machine. A reading's
  *age* is not a trend, and the moment "was this machine busy an hour ago" becomes a requirement, the
  price is a store, a retention policy and a schema.
- **No Prometheus, OpenMetrics, node_exporter or Glances.** R5 rejected the first as a TSDB and a
  scrape config in exchange for six numbers, and the second as a Python runtime on a Pi.
- **No alerting, thresholds or notifications** — whatever M7 sends over ntfy is about sessions, not
  about a CPU crossing a line — and **no graphs**: M4 is four tables (Y-072).
- **No remote execution, configuration management, log shipping, software inventory or process
  list** — each is something this agent is well placed to do and must not. Likewise **no self-update
  and no daemon-initiated update**: a control plane that can push a binary to five machines is the
  fleet-management product this project exists not to be (R-12).
- **The heartbeat is not a reachability probe.** `tailscale ping` is that, and it reports the path
  taken (R1).

## What would justify revisiting this

Recorded so the trade does not quietly expire, per §B0.2. Any of:

- **A node on the tailnet that is not the owner's** — a shared device, someone else's machine.
  Source-address identity stops being sufficient the moment the tailnet stops being one trust domain,
  and authentication stops being avoidable. This is §6's trigger, and it is a Q6 change before it is
  a technical one.
- **The first hard *filter* that depends on something the agent cannot measure.** `drain` and taints
  are the ones to watch: if those start arriving in a heartbeat, the measure-versus-be-told split has
  broken and this ADR is what broke it.
- **R5's own falsification test.** After roughly fifty real placements, check whether any
  non-preference signal ever changed a winner; if one never did, R5 says delete the signal rather
  than tune it — and deleting a signal means deleting the field that feeds it. **This schema should
  be shrunk by that finding, not grown.**
- **WSL2, if [Q4](../../tracker.md) lands that way.** Tailscale would report the node as `windows`
  while the agent runs on Linux — the one case where cutting `os` from the payload is wrong.
- **Wake-on-LAN becoming real at M7**, which adds a MAC and `wol_ready` and nothing else.
- **A repository on a filesystem that is not `/`**, which turns a single `free_disk_mb` from
  imprecise into wrong.

## Consequences

**Gained**

- Every field has a named consumer in R5's filter or score table, so the audit is mechanical: for
  each field, name the row of the decision record it feeds. Three of R5's own facts fail that audit
  and are cut here.
- **I-9 is a type rather than a convention.** Unknown power is unrepresentable, and making it
  representable again would require touching the score table in the same change.
- No new listener, no new port, no new dependency, no storage. The daemon that already refuses to
  start when it cannot prove where it may listen is the one that receives.
- The agent stays stateless — no queue, no buffer, no history, no reply to act on. R-12's mitigation
  expressed as a design rather than a promise.

**Cost**

- **`yantrad` is now writable**, and the tailnet is the only thing between an arbitrary node and that
  write. R-22's retire condition is unchanged; its blast radius is not, and the register should say so.
- **The macOS and Windows halves of this schema are `[D]`, not `[V]`.** R-13 is explicit that only
  R5's Linux column was executed. The first real heartbeat from `bishwajeets-macbook-pro` is the
  measurement; until then `cpu_busy_pct` and `power` on those platforms are documentation.
- **Two fields are knowingly imprecise.** Free disk is the root filesystem only, so a repository on a
  separate mount gets a confidently wrong answer rather than an approximate one; and `cpu_busy_pct`
  is not strictly comparable across operating systems (load-average-derived on Linux and macOS,
  `LoadPercentage` on Windows). Accepted, not fixed.
- A broken battery reader makes a laptop look like a desktop; the direction of that error is chosen
  deliberately (§2).
- Losing the daemon loses all telemetry instantly, with no backfill. Deliberate — a backfilled
  heartbeat is a false statement about the present.
- Strict field parsing means a staggered upgrade can dark the fleet. **Daemon first.**

**Not decided here**

- **Install and update** — systemd unit, launchd LaunchAgent, Windows service (R-12). This says what
  the agent sends, not how it reaches a machine or stays current. One thing is worth recording: the
  telemetry agent needs no keychain access, so **R-21/I-44 does not bind it** — that problem belongs
  to the Claude Code session, not to this process.
- **Enrolment.** R5's first hard filter is `enrolled && !drain` and neither field has a source. Today
  a heartbeat from any known peer is accepted; making that a list is M5's, and it is also the
  smallest version of the authentication question above.
- **Whether the daemon persists anything at all** (Y-044). The in-memory row is enough for M4 and M5;
  it is not enough to answer a question about yesterday, and nobody has asked one.
