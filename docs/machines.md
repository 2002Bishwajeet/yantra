# Machines

The fleet Yantra actually has to work against, as of **2026-07-29**. This is planning
documentation, not a runtime input — M2 reads the live inventory from Tailscale (R1), so nothing
here is a source of truth for code.

**Tailscale IPs and node IDs are deliberately omitted**; this repo is public. Node IDs are stable
per-device identifiers and the addresses describe a private topology, neither of which the planning
notes need. The names below are the MagicDNS labels, which are what a workspace file would carry.

## The fleet

| Name | OS | Role | Availability | Yantra target? |
| --- | --- | --- | --- | --- |
| `cachyos-g14` | Linux | Primary dev box, where the daemon runs | online | **yes** — M1's machine |
| `bishwajeets-macbook-pro` | macOS | Second workstation | online | **yes** — the first genuinely remote target |
| `laptop-9ml3d644` | Linux | Secondary laptop, Linux side of a dual boot | last seen 23d ago | yes, when it is up |
| `laptop-9ml3d644-1` | Windows | Windows side of the same laptop | last seen 2d ago | **blocked on Q4** |
| `ipad153` | iOS | Tablet | last seen 14d ago | no — no shell |
| `iphone-15` | iOS | Phone | last seen 22h ago | no — no shell |

Six nodes, two online, **two viable targets today**. That is enough for M2: `cachyos-g14` →
`bishwajeets-macbook-pro` is a real network hop between two different operating systems, which is a
stronger test than the container fixture and the next honest step after M1.

## What this changes

**The dual boot is one box, two nodes.** `laptop-9ml3d644` and `laptop-9ml3d644-1` are the same
physical laptop, and Tailscale treats each OS install as its own node with its own ID. Two
consequences:

- Placement (M5) must know they are **mutually exclusive** — they can never both be online, so
  "two available machines" would be a miscount.
- **Q4 (Windows support) buys no additional hardware.** The only Windows node in the fleet is a
  second boot of a laptop that already runs Linux. Supporting only the Linux side costs zero
  machines. That does not settle Q4, but it removes the argument that deferring Windows shrinks the
  fleet.

**macOS is now a first-class target, not a hypothetical.** It is one of only two machines online.
ADR-0006's payload assumes `/bin/sh` and `base64` on the far side; both exist on macOS, but this is
unverified against the real host and should be the first thing M2 checks.

**MagicDNS works here despite a health warning.** `tailscale status` reports systemd-resolved and
NetworkManager are wired together incorrectly and warns that MagicDNS "will probably not work" — but
short names do resolve on this box. The warning is not a false alarm to dismiss: it means name
resolution depends on host DNS configuration that Yantra does not control, on a machine where it is
already known to be fragile. `machine` reaching `ssh` verbatim (Y-043) is what makes this
survivable — `~/.ssh/config` can pin an address if MagicDNS fails.

## HostName is not an identifier

R1 established I-5: key the inventory on `Peer.ID`, treat HostName as a display label. The live
tailnet is worse than that phrasing suggests.

| Field | Example from this tailnet | Safe to use? |
| --- | --- | --- |
| `Peer.ID` | opaque, unique per node | **yes** — the only stable key |
| `DNSName` first label | `bishwajeets-macbook-pro` | **yes** — `[a-z0-9-]`, satisfies I-2, resolves via MagicDNS |
| `HostName` | `Bishwajeet’s MacBook Pro` | **no** |

HostName collides twice over — `localhost` for both iOS devices, `LAPTOP-9ML3D644` for both sides of
the dual boot — and the MacBook's contains spaces *and* U+2019, a Unicode right single quotation
mark. Interpolated into a tmux session name it violates I-2; interpolated into a remote command it is
a quoting problem in a non-ASCII disguise. Recorded as **I-33**.

## Not yet known

Answering these is M2's first task, and needs a connection to each host rather than a guess:

- Is `tmux` installed on the MacBook, and at what version? I-21 and I-29 were verified on 3.5a/3.7b.
- Does `sshd` accept connections, and via Tailscale SSH or a normal daemon with keys?
- Do `/bin/sh` and `base64` behave as ADR-0006 assumes? macOS ships BSD `base64`, whose flags differ
  from GNU's — the payload only uses `-d`, which both accept, but that is worth confirming rather
  than assuming.

## Sources

- `tailscale status` and `tailscale status --json` on `cachyos-g14`, accessed 2026-07-29.
- [R1 — Tailscale inventory](research/01-tailscale-inventory.md) for the LocalAPI shape and I-5.
