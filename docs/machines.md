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

## The MacBook, verified

Reachable from `cachyos-g14` since **2026-07-30**, over its own `sshd` with a dedicated key. Every
assumption ADR-0006 made about the far side has now been tested against real macOS instead of a
container:

| Check | Result |
| --- | --- |
| `ssh -o BatchMode=yes` + key | ✅ exit 0 — macOS 26.5.1, Darwin 25.5.0, arm64 |
| `/bin/sh` + `base64 -d` payload (I-26) | ✅ decodes and runs; `$0` is `/bin/sh` |
| `base64` flavour | FreeBSD — accepts `-d` *and* `-D`; the payload only uses `-d` |
| stderr sentinel trailer (I-25) | ✅ arrives intact |
| `ControlMaster` multiplexing (I-20) | ✅ **20 ms against 150 ms cold** — `ControlPath` 27 bytes, inside I-28 |
| Idempotency (§B4) | ✅ a second `has-session ‖ new-session` attached; `session_created` unchanged |
| `#{pane_current_path}` targets | a *session* target returns empty on **both** OSes; a `%id` pane or `=name:` window target works — I-21 exactly as documented |
| `tmux` | 3.7b — but at `/opt/homebrew/bin/tmux`, invisible to the non-interactive `PATH` (I-34) |

That multiplexing figure is the first measurement of I-20's value on this fleet: 7.5× on a genuine
cross-OS hop, and *through* the DERP relay rather than a direct path.

### Why a key was unavoidable

`cachyos-g14` runs no `sshd` at all. A login's process ancestry is `tailscaled → login → fish`, and
nothing is bound to port 22 — Tailscale SSH serves the box from userspace netstack. That is also why
`ss` shows no listener, and why an empty `authorized_keys` never locked anyone out.

It works because the *server* half of Tailscale SSH runs on Linux. It cannot run on the App Store
build of macOS and cannot run on Windows at all, so `cachyos-g14` → MacBook was never going to use
it, however well the reverse direction already worked. Native `sshd` plus a key is the only transport
that covers the whole fleet — which is what ADR-0006 assumed, for reasons it did not yet have
evidence for.

### Three ways the environment lies

Each of these presents as something other than what it is, which is why they became invariants.

**Homebrew is not on the non-interactive `PATH` (I-34).** `ssh mac 'command -v tmux'` finds nothing
while `tmux 3.7b` sits at `/opt/homebrew/bin/tmux`. Interactively it works, so the failure reads as a
broken install.

**zsh eats `=name` (I-35).** The MacBook's login shell is `/bin/zsh`, where `=word` is filename
expansion. `tmux kill-session -t =yantra-probe` sent through it returns `zsh:1: yantra-probe not
found` — the session survives and the caller believes it was killed. Through ADR-0006's base64 →
`/bin/sh` envelope the identical argument succeeds. I-26 justified that envelope by argument-joining
alone; this is the sharper reason, and the reason never to bypass it for a "quick" command.

**An unknown `TERM` kills tmux (I-36).** `tmux attach` aborts with `missing or unsuitable terminal`
when the outer `TERM` has no terminfo entry on the machine running tmux — true of both boxes here,
since Ghostty's `xterm-ghostty` was in neither terminfo database. Non-interactive `ssh` never
forwards `TERM`, so ADR-0006's command path is immune; `attach` and M6's browser terminal are not.

### Still unknown

- **I-30's three "already absent" spellings are unverified on macOS.** The `kill-session` that would
  have exercised them was swallowed by zsh first (I-35), so only the `/bin/sh` path is proven.
- **The DERP relay is still a latency floor.** 27 ms via Amsterdam is fine for M2's short commands;
  M6 streams an interactive terminal and should measure it before promising responsiveness.

## Sources

- `tailscale status` and `tailscale status --json` on `cachyos-g14`, accessed 2026-07-29.
- [R1 — Tailscale inventory](research/01-tailscale-inventory.md) for the LocalAPI shape and I-5.
