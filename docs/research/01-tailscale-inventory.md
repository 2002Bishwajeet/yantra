# 01 — Machine discovery & inventory via Tailscale / Headscale

Research note for YANTRA. Verified 2026-07-28 against a live tailnet (`tailscale 1.98.9`, Linux, 5 peers), upstream source at tag `v1.98.9`, and current docs.

## Summary

- **Tailscale gives identity + reachability, never telemetry.** Zero CPU/RAM/GPU/battery/load in `status --json`, in the API v2 `Device` schema, or in `tailscale metrics`. Yantra **must** ship its own per-machine agent. Confirmed against three surfaces, not assumed.
- **LocalAPI is the right inventory source and plain Node/Bun can speak it.** Verified 200 from `node:http` `socketPath` as uid 1000. Wrong or missing `Host` header → **403**.
- **Reads unprivileged, writes not.** Same uid: `GET /prefs` 200, `PATCH /prefs` 403, `GET /metrics` 403.
- **`tsnet` has no real JS binding.** `tailscale-js` is Bun-only FFI over experimental `libtailscale`; 6 commits, no releases. Be a normal host with `tailscaled` + `tailscale serve`.
- **Tailscale SSH ends key management but breaks SSH libraries and cannot serve Windows.**

## Findings

### 1. `tailscale status --json` shape

A JSON marshal of Go `ipnstate.Status`. **Keys are Go field names in PascalCase** — pkg.go.dev renders a lowercase `json:"…"` column that does **not** match reality; the only real rename is `SSH_HostKeys` → `sshHostKeys`. CLI help says `--json … (WARNING: format subject to change)`.

| Need | Field | Gotcha |
|---|---|---|
| hostname | `Peer[k].HostName` | Not unique, often useless — iOS peers report `localhost` (×2 in my 5-node tailnet), and two other peers shared one Windows hostname. |
| display name | `Peer[k].DNSName` | MagicDNS FQDN, trailing dot. |
| stable id | `Peer[k].ID` | Opaque `n…CNTRL` string; same value as API v2 `id`. **Primary key.** |
| OS | `Peer[k].OS` | `linux`, `macOS`, `windows`, `iOS`, `android` — inconsistent casing. |
| online | `Peer[k].Online` | Control plane's view (has a session to control), **not** "I can reach it". |
| IPs | `Peer[k].TailscaleIPs` | `[v4, v6]`. |
| last seen | `Peer[k].LastSeen` | Zero value `0001-01-01T00:00:00Z` while currently online. |
| tags | `Peer[k].Tags` | `omitempty` — **key absent entirely** on untagged nodes. |
| user | `Peer[k].UserID` → `Status.User[id]` | Two-step; `User` map has `LoginName`, `DisplayName`. |
| expiry | `KeyExpiry`, `Expired` | `Expired` is `omitempty`. 2 of my 5 peers were expired and still in the netmap. |
| path | `CurAddr` / `Relay` | `CurAddr:""` + `Relay:"fra"` ⇒ relayed via DERP, not direct. |

Top level: `Version`, `TUN`, `BackendState` (`Running`/`Stopped`/`NeedsLogin`), `HaveNodeKey`, `AuthURL`, `TailscaleIPs`, `Self`, `ExitNodeStatus` (omitted when unset), `Health []string`, `MagicDNSSuffix` (deprecated), `CurrentTailnet`, `CertDomains`, `ExtraRecords`, `Peer`, `User`, `ClientVersion`. `Peer` is keyed by `"nodekey:<hex>"` — iterate values, index by `ID`.

### 2. Tailscale LocalAPI

Per-OS endpoint (`paths.DefaultTailscaledSocket`, v1.98.9):

| OS | Path |
|---|---|
| Linux | `/var/run/tailscale/tailscaled.sock` (`/run/…` same inode) |
| macOS (open-source `tailscaled`) | `/var/run/tailscaled.socket` |
| macOS (App Store / GUI) | **no socket** — localhost TCP + token via `/Library/Tailscale/ipnport` symlink and `/Library/Tailscale/sameuserproof-$port` |
| Windows | named pipe `\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled` |
| Synology | `/var/packages/Tailscale/etc/tailscaled.sock` |

Gotchas, all verified locally:

- **`Host: local-tailscaled.sock` is mandatory.** Anything else, or omitted → `403 invalid localapi request`. CSRF defence, not DNS.
- Unix auth is **peer credentials**, no token. Socket is mode `0666`; the daemon derives `PermitRead`/`PermitWrite`/`PermitCert` from the connecting uid (root or `--operator` gets write). macOS-GUI and Windows instead need an **`Authorization` token**, so a cross-platform collector cannot assume "just open the socket".
- Bun's `fetch(url, { unix })` works. **Node's global `fetch` does not support unix sockets** — use `node:http` `socketPath`.

Endpoints under `/localapi/v0/` (from `ipn/localapi/localapi.go` @ v1.98.9 plus binary strings): `status`, `whois?addr=`, `prefs`, `check-prefs`, `ping` (**POST**, `?ip=&type=disco|TSMP|ICMP|peerapi`), `peer-by-id`, `derpmap`, `dns-config`, `cert-domains`, `cert/<domain>`, `metrics`, `watch-ipn-bus` (stream), `files/`, `file-put/`, `profiles/`, `profiles/current`, `login-interactive`, `logout`, `start`, `shutdown`, `set-expiry-sooner`, `reload-config`, `reset-auth`, `services`, `goroutines`, `upload-client-metrics`, `update/check`, `debug-packet-filter-rules`, `disconnect-control`, `clear-netmap-cache`, `notify-last-netmap`, `peer-relay-servers`. `watch-ipn-bus` streams `ipn.Notify` JSON — push netmap changes instead of polling.

### 3. Control-plane API v2

`GET https://api.tailscale.com/api/v2/tailnet/-/devices` (`-` = the token's default tailnet). Auth: `Authorization: Bearer <tskey-api-…>` (personal key, ≤90 d) **or** an OAuth client-credentials token (`devices:core:read`, **expires in 1 hour**).

Default fields: `addresses, id, nodeId, user, name, hostname, clientVersion, updateAvailable, os, created, connectedToControl, lastSeen, keyExpiryDisabled, expires, authorized, isExternal, machineKey, nodeKey, blocksIncomingConnections, tailnetLockKey, tailnetLockError, tags, isEphemeral`. `?fields=all` adds `multipleConnections, enabledRoutes, advertisedRoutes, clientConnectivity` {`endpoints`, `mappingVariesByDestIP`, `latency` (per-DERP `latencyMs`/`preferred`), `clientSupports` {`hairPinning` (always null now), `ipv6`, `pcp`, `pmp`, `udp`, `upnp`}}.

Under-advertised: **server-side filtering** `?<field>=<value>` on top-level scalars/lists, AND-ed (`?isEphemeral=true&tags=tag:prod`); complex objects like `clientConnectivity` are not filterable.

**Rate limits: not documented.** The spec defines a `429` response but publishes no numbers; tailscale#14328 asked and got nothing. Implement backoff; do not cite a number. The spec itself warns it "is unstable. It may change or break without notice" — endpoints are stable, the schema doc is not.

### 4. Live CPU / RAM / GPU / battery / load — **NO**

Stated plainly: **Tailscale exposes none of it.** Three surfaces checked:

1. `ipnstate.PeerStatus` — no such fields. Closest: `RxBytes`/`TxBytes` (WireGuard counters).
2. API v2 `Device` — grepped the full 235 KB OpenAPI spec; no cpu/ram/gpu/battery/load anywhere.
3. `tailscale metrics print` — Prometheus, but **tailscaled's own** metrics only (`tailscaled_inbound_bytes_total{path="derp"}`, `tailscaled_health_messages`, `tailscaled_home_derp_region_id`, route counts). Nothing about the host.

The only writable per-device slot is **posture attributes** (`POST /api/v2/device/{id}/attributes/custom:key`): string ≤50 chars matching `[A-Za-z0-9_.]`, or integer, or boolean, with optional `expiry`. Built for ACL checks — no history, undocumented limits, paid feature. **Not a metrics bus.** Yantra ships its own agent.

### 5. `tsnet` in JS/TS

Go-only; embeds a userspace node (gVisor netstack), no daemon, no root. **No official JS/TS binding.** Only candidate is [`mastermakrela/tailscale-js`](https://github.com/mastermakrela/tailscale-js): Bun-only FFI over `libtailscale` (C wrapper on `tsnet`). Reality — 6 commits, 4 stars, no releases, prebuilt binaries macOS/Linux only, no WebSocket support, broken Ctrl-C, FFI type drift across Bun versions; `libtailscale` upstream is itself experimental. **Not a day-1 dependency.**

Options for Yantra to be reachable, in order of sanity:

1. **Normal host + system `tailscaled`** (recommended). Bind `127.0.0.1:PORT`, then `tailscale serve --bg PORT` → `https://<node>.<tailnet>.ts.net/`, automatic LE cert, tailnet-only, ACL-gated. Serve also targets unix sockets: `tailscale serve unix:/run/yantra.sock`.
2. **`tailscale funnel --bg PORT`** only if the public internet is required. Hard limits: **ports 443, 8443, 10000 only**; **TLS/TCP only, no UDP**; needs MagicDNS plus tailnet-wide HTTPS certs and the `funnel` nodeAttr in policy; non-configurable bandwidth caps. Yantra almost certainly doesn't want this.
3. Go sidecar with real `tsnet` only if per-service identity is ever needed.

### 6. Wake-on-LAN

Tailscale is L3, magic packets are L2 broadcast. **Tailscale cannot wake a powered-off machine, and there is no `tailscale wake` subcommand** (confirmed absent from the 1.98.9 subcommand list). Subnet routing does not fix this — the target's NIC has no IP stack while off.

Workable pattern: an **always-on LAN peer** (the Pi 5) on the same L2 segment runs Tailscale; Yantra calls it over the tailnet and it emits the magic packet to LAN broadcast (`255.255.255.255:9` or subnet-directed `192.0.2.255:9`). Yantra must store the target **MAC** — Tailscale never exposes a MAC, so that is manual config or ARP scraping on the Pi. Caveat: reports say broadcast-route setups wake fully-powered-off machines but **not** S3 sleep/hibernate; verify per machine and BIOS.

`tailscale ping` is the reachability probe and reports the path taken — `pong from <peer> (100.x.y.z) via DERP(fra) in 15ms` / `direct connection not established`. **DERP = relayed** (works, higher latency, consumes Tailscale relay capacity — my MacBook sat at ~15 ms via DERP-fra and never went direct). **Direct** = NAT traversal won. Record `CurAddr != "" ⇒ direct` per peer: it decides whether to push heavy traffic (file sync, tmux streams) or stay light. `tailscale ping` stops after 10 pings *or* the first direct path, so one invocation is a fine probe. And `Online: true` does **not** imply reachable — only a ping/handshake proves that.

### 7. Headscale

Protocol-compatible with official clients, so **§1, §2, §5 and §6 are unchanged** — they are all client-side. Only the admin API differs.

- Headscale's API is `/api/v1/…`, `Authorization: Bearer <key>` from `headscale apikeys create` (default 90 d). **Different paths and different JSON shapes** from `/api/v2` — a real adapter, not a base-URL swap.
- **0.30.0** (latest; changelog still dated `202x-xx-xx`, i.e. in flight) is a big break: gRPC and grpc-gateway **removed entirely**, v1 REST rebuilt on Huma v2 with OpenAPI 3.1 at `/api/v1/openapi.yaml`, docs at `/api/v1/docs`, errors now RFC 7807 `application/problem+json`. It also adds a **v2 API porting selected Tailscale endpoints with OAuth 2.0 client credentials**, explicitly so the Tailscale Terraform provider and k8s operator work unchanged — if that lands, the adapter nearly vanishes.
- Supported: Tailscale SSH, Serve, Funnel, Taildrop, MagicDNS, exit nodes, subnet routers, policy v2 (grants, `nodeAttrs`, SSH check-action as of 0.29). Absent: **device posture, app connectors**; OIDC groups cannot be used in ACLs.

**Day 1: no.** Put control-plane calls behind an interface and keep them minimal (LocalAPI does the real work and is control-server-agnostic); waiting for 0.30's v2 API is far cheaper than writing a v1 adapter now.

### 8. Tailscale SSH

Claims port 22 **on the tailnet IP only** and runs its own SSH server there. The server already knows the peer from WireGuard node keys, so it uses SSH auth method **`none`**. Authorization is an `ssh` block in policy: `{"action":"accept"|"check","src":[…],"dst":[…],"users":[…],"checkPeriod":"12h"}`.

Can Yantra skip SSH key management? **Yes for interactive use, with real caveats:**

- **Server side is Linux and macOS only. Windows cannot be a Tailscale SSH server** (nor Synology/QNAP), so the Windows laptop still needs OpenSSH — you cannot standardise on one mechanism. Server needs v1.24+; env-var forwarding v1.76+. Port hardcoded to 22. SFTP is implemented, so `scp`/`sftp`/`rsync` work with modern clients.
- **Restarting `tailscaled` — including an auto-update — kills every live Tailscale SSH session.** For a daemon holding long-running agent sessions this matters: attach to **tmux on the remote** so a dropped SSH session never kills the work.
- **Programmatic clients are the sharp edge.** OpenSSH CLI is fine (host keys are distributed by control, so no unknown-host prompt). But paramiko fails with `SSHException: No authentication methods available` (paramiko#2370, open since Mar 2024), and Node `ssh2` only attempts `none` if you pass `authHandler: ['none']`. On Bun, set that explicitly or shell out to the `ssh` binary.
- **Unverified:** OpenSSH-client → Tailscale-SSH could not be tested locally — `ssh <own-100.x>` from the same host gives `Connection refused` (interception only applies to traffic arriving from peers). Test from a second machine before committing.

## What Yantra reuses

- `GET /localapi/v0/status` as primary inventory: free, no API key, no rate limit, no network hop, identical under Headscale.
- `/localapi/v0/watch-ipn-bus` for push netmap changes instead of polling.
- `/localapi/v0/whois?addr=` to attribute an inbound connection to a tailnet user — this is how Yantra's own HTTP API authenticates with zero credentials.
- MagicDNS names as addresses; `Peer.ID` (`n…CNTRL`) as stable primary key.
- `tailscale serve --bg` for Yantra's HTTP/WS endpoint including auto-TLS.
- `tailscale ping` / LocalAPI `POST /ping` as the direct-vs-DERP reachability probe.
- Tailscale SSH for Linux/macOS targets, to skip key distribution.

## What Yantra must build itself

- **A per-machine agent.** CPU, RAM, GPU, battery, load, disk, temps, tmux sessions, agent process state. Nothing in Tailscale supplies any of it; it can bind the tailnet IP and let ACLs be its authn.
- **MAC inventory plus a WoL relay** on the always-on Pi 5.
- **A control-plane adapter interface** so `/api/v2` and Headscale `/api/v1` are swappable, plus a `status --json` parser tolerant of the documented instability.
- **Identity/merge logic keyed on `ID`** (HostName already collides in a 5-node tailnet).
- **A Windows SSH path on OpenSSH**, since Tailscale SSH cannot serve it.
- **A cross-platform LocalAPI client** handling unix socket / named pipe / macOS token file.

## Risks & unknowns

- `status --json` is "subject to change": pin a client version, snapshot-test the parser, don't spread raw field access through the codebase.
- API v2 rate limits undocumented — backoff, cache, prefer LocalAPI.
- OAuth tokens expire hourly (need unattended refresh); API keys at 90 days (need a rotation alarm); OAuth tokens can't see shared devices (tailscale#16911).
- Headscale 0.30 is mid-flight; its v1 shape is changing right now. OpenSSH-client → Tailscale-SSH not verified here.
- `Online` ≠ reachable, and expired peers stay in the netmap — surface `Expired` or Yantra will keep dialling dead nodes.

## Concrete reference

```bash
tailscale version                 # 1.98.9, verified 2026-07-28
tailscale status --json           # full netmap; --peers=false / --self=false to trim
tailscale ping --c 3 <host>       # → "via DERP(fra)" or "via 192.0.2.150:41641"
tailscale metrics print           # tailscaled's OWN metrics; no host telemetry
tailscale serve --bg 7777         # https://<node>.<tailnet>.ts.net → 127.0.0.1:7777
tailscale serve unix:/run/yantra.sock ; tailscale serve status --json
tailscale funnel --bg 443         # public; ONLY 443/8443/10000, TLS only
```

LocalAPI via curl (works unprivileged for reads):

```bash
S=/var/run/tailscale/tailscaled.sock
curl -s --unix-socket $S http://local-tailscaled.sock/localapi/v0/status
curl -s --unix-socket $S "http://local-tailscaled.sock/localapi/v0/whois?addr=100.x.y.z:80"
curl -s -X POST --unix-socket $S "http://local-tailscaled.sock/localapi/v0/ping?ip=100.x.y.z&type=disco"
```

Verified matrix on this host (uid 1000, not root, not operator):

| Call | Result |
|---|---|
| `GET /localapi/v0/status`, Host `local-tailscaled.sock` | **200** |
| same, Host `localhost` | **403** `invalid localapi request` |
| same, no Host header | **403** `invalid localapi request` |
| `GET /localapi/v0/prefs` | **200** |
| `PATCH /localapi/v0/prefs` | **403** (needs root/operator) |
| `GET /localapi/v0/metrics` | **403** `metric access denied` |

Node/Bun client (verified: 200, 8718 bytes):

```js
import http from "node:http";
http.request({
  socketPath: "/var/run/tailscale/tailscaled.sock",
  path: "/localapi/v0/status",
  headers: { Host: "local-tailscaled.sock" },   // MANDATORY
}, r => { /* r.statusCode === 200 */ }).end();
// Bun: fetch("http://local-tailscaled.sock/localapi/v0/status", { unix: "/var/run/tailscale/tailscaled.sock" })
// Node's global fetch() does NOT support unix sockets.
```

Redacted live `status --json` excerpt (IPs / keys / IDs / emails / tailnet scrubbed):

```jsonc
{
  "Version": "1.98.9", "TUN": true, "BackendState": "Running", "HaveNodeKey": true, "AuthURL": "",
  "TailscaleIPs": ["100.x.x.x", "fd7a:115c:a1e0::REDACTED"],
  "Self": {
    "ID": "nREDACTED1CNTRL", "PublicKey": "nodekey:REDACTED", "HostName": "<linux-box>",
    "DNSName": "<linux-box>.<tailnet>.ts.net.", "OS": "linux", "UserID": 3424900000000000,
    "Addrs": ["<public-ip>:41641", "192.0.2.150:41641"], "CurAddr": "", "Relay": "fra",
    "RxBytes": 0, "TxBytes": 0, "Created": "2026-07-12T12:08:26.026157918Z",
    "LastWrite": "0001-01-01T00:00:00Z", "LastSeen": "0001-01-01T00:00:00Z",
    "Online": true, "ExitNode": false, "ExitNodeOption": false, "Active": false,
    "PeerAPIURL": ["http://100.x.x.x:44883"], "Capabilities": ["https", "…/cap/ssh", "…"],
    "CapMap": { "https://tailscale.com/cap/ssh": null },
    "InNetworkMap": true, "InMagicSock": false, "InEngine": false, "KeyExpiry": "2027-01-18T12:00:00Z"
    // NOTE: no "Tags" key at all — omitempty, this node is untagged.
  },
  "Health": ["systemd-resolved and NetworkManager are wired together incorrectly; …"],
  "CurrentTailnet": { "Name": "<redacted>", "MagicDNSSuffix": "<tailnet>.ts.net", "MagicDNSEnabled": true },
  "CertDomains": ["<linux-box>.<tailnet>.ts.net"],
  "Peer": {
    "nodekey:REDACTED_A": {                       // online and active, but relayed via DERP
      "ID": "nREDACTEDA1CNTRL", "HostName": "<mac-hostname>", "OS": "macOS", "UserID": 3424900000000000,
      "DNSName": "<mac>.<tailnet>.ts.net.", "TailscaleIPs": ["100.x.x.x", "fd7a:…"],
      "Addrs": null, "CurAddr": "", "Relay": "fra", "RxBytes": 88980, "TxBytes": 248308,
      "LastSeen": "2026-07-28T13:20:00.1Z", "LastHandshake": "2026-07-28T20:24:28.28+02:00",
      "Online": true, "Active": true, "TaildropTarget": 1,
      "InNetworkMap": true, "InMagicSock": true, "InEngine": true, "KeyExpiry": "2027-01-18T10:11:44Z"
    },
    "nodekey:REDACTED_B": {                       // dead + expired, still present in the netmap
      "ID": "nREDACTEDB1CNTRL", "HostName": "localhost", "OS": "iOS", "DNSName": "<ipad>.<tailnet>.ts.net.",
      "Online": false, "LastSeen": "2026-07-14T22:25:55.1Z", "Expired": true, "KeyExpiry": "2026-07-18T17:12:12Z"
    }
  },
  "User": { "3424900000000000": { "ID": 3424900000000000, "LoginName": "<user>@github", "DisplayName": "<redacted>" } },
  "ClientVersion": null
}
```

Control-plane API v2:

```bash
curl -H "Authorization: Bearer $TS_API_KEY" "https://api.tailscale.com/api/v2/tailnet/-/devices?fields=all"
curl -H "Authorization: Bearer $TS_API_KEY" "https://api.tailscale.com/api/v2/tailnet/-/devices?tags=tag:dev&isEphemeral=false"
# OAuth: POST https://api.tailscale.com/api/v2/oauth/token
#   grant_type=client_credentials&client_id=…&client_secret=…   → 1h token
# → { "devices": [ { id, nodeId, name, hostname, os, addresses[], user, tags[],
#                    lastSeen, connectedToControl, expires, authorized, … } ] }
```

WoL relay on the always-on Pi (called over the tailnet; MAC comes from Yantra's own inventory):

```bash
wakeonlan -i 192.0.2.255 AA:BB:CC:DD:EE:FF     # or: etherwake -i eth0 AA:BB:CC:DD:EE:FF
```

## Sources

All accessed 2026-07-28. Live system: `tailscale 1.98.9` (commit `4fb758c3…`, go1.26.5), Linux, 5 peers.

- pkg.go.dev/tailscale.com/ipn/ipnstate — `Status`/`PeerStatus` fields
- github.com/tailscale/tailscale @ `v1.98.9`: `ipn/localapi/localapi.go` (routes, `PermitRead`/`PermitWrite`), `paths/paths.go` (per-OS sockets), `safesocket/safesocket_darwin.go` (macOS `sameuserproof`)
- https://api.tailscale.com/api/v2?outputOpenapiSchema=true — OpenAPI 3.1 spec, 235 KB, fetched raw
- tailscale.com/docs/features/oauth-clients (scopes, 1 h token) · /kb/1223/funnel (ports 443/8443/10000, TLS-only, nodeAttr) · /kb/1193/tailscale-ssh (ACL `ssh` rules, platform limits, SFTP, port 22) · /kb/1244/tsnet
- github.com/mastermakrela/tailscale-js — Bun FFI binding · github.com/mscdex/ssh2 — `authHandler` accepts `'none'`
- github.com/paramiko/paramiko/issues/2370 (`none`-auth failure vs Tailscale SSH, open) · tailscale/tailscale#14328 (rate limits undocumented) · #16911 (OAuth can't see shared devices)
- https://tailscale.com/blog/wake-on-lan-tailscale-upsnap — Pi + UpSnap WoL pattern
- headscale.net/stable/ref/api/ · /about/features/ · raw CHANGELOG.md on `main` — `/api/v1`, `headscale apikeys create`, feature matrix, 0.30.0 gRPC removal + OpenAPI 3.1 + v2/OAuth
