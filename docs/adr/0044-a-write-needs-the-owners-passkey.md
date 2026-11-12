# ADR-0044 — A write needs the owner's passkey

- **Date:** 2026-11-09
- **Status:** Accepted 2026-11-09 ([Y-681](../../tracker.md), issue #672). The owner chose a
  passkey on 2026-11-09 ("Option A") and accepted this text the same day.
- **Closes:** the open hole in
  [ADR-0042](0042-the-proxy-hop-is-proved-by-the-kernel.md)'s Consequences and its first
  *Not decided here* item.
- **Amends:** [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)
  decision 1 (reads stay open) and the premise it builds on, Q6 (*no authentication*).
  [ADR-0029](0029-a-machine-joins-itself.md) decision 3, for a join from another machine.
  [ADR-0004](0004-rust-for-the-daemon.md)'s 2026-08-22 amendment, a fourth time. Each gets a dated
  note.
- **Unchanged:** ADR-0016's predicate (`whois`, live, same user, no tags, failure closed). ADR-0042
  decisions 1 to 5. [ADR-0038](0038-rooms-and-guest-devices.md)'s guest grants.
- **Comes before:** ADR-0040, *An agent caller is tagged and scoped* (Proposed, PR #643).

## Context

Tailscale names a node, not an account on it. ADR-0016 authorises a write when the caller's address
is the owner's untagged node. That was enough while every account on the owner's machines was the
owner.

It is not enough now. Agents run in their own non-sudo account, `karigar`, on every machine
(Y-627, Y-628). ADR-0042 closed the hole on the hub: the kernel tells the daemon the uid on its
Unix socket. On every other machine the hole stays open. `karigar` on the Mac reaches the hub's
`:7717` or `:8443` from the Mac's address. That address is the owner's untagged node, so
`allowed()` passes it on every write route. An agent with a prompt injection can then start a
terminal on any machine, push with the daemon's GitHub grant, or change the relay.

No rule at the hub can tell two accounts on the Mac apart. So the owner must present something that
only a person holds. The owner chose a passkey.

### What the reads give away

`api.rs` calls no authoriser today. The reads include `/api/repos` (private repository names through
the daemon's GitHub grant), `/api/rooms`, `/api/notifications`, `/api/sessions`, `/api/tasks/{id}`
and each workspace's status. For an injected agent these are what it exfiltrates. ADR-0038's
2026-10-20 note says every route checks its caller, and the code does not.

### What T3 Code does, read on 2026-11-09

T3 Code (`~/Github/t3code-ref`, commit `67eebaca`) has **no passkey sign-in for its server**. Its
passkey code (`apps/desktop/src/preview/Passkeys.ts`, `PasskeyBridge.ts`) serves sites shown in the
desktop app's preview pane, not T3's own login. Its server auth has these parts:

- **A one-time pairing token** with a 5-minute life (`apps/server/src/auth/PairingGrantStore.ts`,
  `DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES`). The token is consumed once.
- **A session cookie** with `httpOnly: true` and `sameSite: "lax"`, 30 days by default
  (`apps/server/src/auth/http.ts`, `appendSessionCookie`; `SessionStore.ts`,
  `DEFAULT_SESSION_TTL`). Sessions are rows in its database, with `listActive`, `revoke` and
  `revokeAllExcept`.
- **A secret store**: random bytes in `<stateDir>/secrets/<name>.bin`, directory `0700`, file `0600`,
  written to a temporary file and renamed (`apps/server/src/auth/ServerSecretStore.ts`,
  `getOrCreateRandom`). `PayloadSigner.ts` keys an HMAC-SHA-256 with it.

This ADR copies the pairing code and the cookie and the revoke list. It adds the passkey, which T3
does not have. It does not copy the signing secret (decision 6 says why).

### The library

`webauthn-rs` 0.6.2, released 2026-10-31, MPL-2.0. It has `start_passkey_registration`,
`finish_passkey_registration`, `start_passkey_authentication` and `finish_passkey_authentication`.
Its docs say the ceremony state *must* stay on the server, and they forbid serialising it unless the
`danger-allow-state-serialisation` feature is on. `Passkey` is `Serialize` and `Deserialize` and
"can be safely serialised and deserialised from a database". Its accessors expose a credential id,
an algorithm and a public key. `webauthn-rs-core` 0.6.2 lists no `openssl` dependency; it uses
`crypto-glue`, "a facade over the RustCrypto ecosystem". I did not build it for
`aarch64-unknown-linux-musl`.

### What a browser needs

WebAuthn runs only in a secure context, and the relying party id must be a domain, not an IP
address. The dashboard at `https://<hub>.<tailnet>.ts.net:8443` meets both. The plain `:7717` port
meets neither.

## Decision

1. **A browser signs in with a passkey.** The relying party id is the hub's MagicDNS name, the origin
   is `https://<hub>.<tailnet>.ts.net:8443`. The daemon uses `webauthn-rs` 0.6.2 with its default
   features: user verification is required, attestation is not asked for, and the ceremony state
   stays in the daemon's memory for 5 minutes. The `danger-*` features stay off.

2. **The first passkey needs a code from the hub.** The owner runs `yantra passkey code` on the hub.
   The CLI posts on `/run/yantra/yantrad.sock`. ADR-0042 decision 3 decides the caller: only the
   daemon's own uid or a member of the `yantra` group gets a code. On the box that means
   `sudo -u yantra yantra passkey code`, because root on the socket is the `serve` hop. The code is
   eight characters from an unambiguous alphabet. It lives 10 minutes, in memory, and is used once.
   The owner opens the dashboard, types the code and a device name, and the device makes the passkey.
   Five wrong codes in a row void every open code.

3. **A later device gets a code from a device that is signed in.** The Devices screen shows
   *Add a device*, which makes a code with the same rules. `yantra passkey code` also works. A
   passkey that syncs (iCloud Keychain, Google Password Manager) signs in on the owner's other
   devices with no new code. A laptop with no passkey store of its own can sign in with the phone
   over the browser's QR code flow.

4. **After sign-in the daemon sets one cookie**:
   `__Host-yantra_session=<token>; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`.
   The token is 32 random bytes. A session lives 30 days from sign-in, then the device signs in
   again. The daemon does not extend it on use, so it writes no file on each request.

5. **The owner on the network needs both the node and the cookie.** On TCP, and on the socket's
   `serve` hop, a caller is the owner only when ADR-0016's predicate passes **and** the request
   carries a live session cookie. Every write route also refuses a request whose `Origin` is not the
   dashboard's origin. A WebSocket upgrade (terminal, chat, microphone) checks both at the upgrade.
   One case changes in ADR-0042 decision 3: a `serve` hop whose forwarded address is this node's own
   passes when it carries a live cookie, because the cookie names the person. That lets the owner use
   the dashboard on the hub itself.

6. **The daemon keeps the hash of each token, not a key to sign them.** It stores
   `SHA-256(token)` with the session. A copy of the file does not let anyone sign in. So the daemon
   holds no new secret value, and CLAUDE.md §B4's two credentials stay two.

7. **One new file holds passkeys and sessions:** `~/.config/yantra/passkeys.toml`, mode `0600`, owned
   by the `yantra` account. Each passkey row holds its name, the `webauthn-rs` `Passkey`, and when it
   was made. Each session row holds an id, the passkey that made it, the device name, the token
   hash, when it was made and when it ends. The daemon writes it atomically on enrolment, sign-in,
   revoke and expiry, and holds it in memory. It holds nothing about the fleet.

8. **Reads need the cookie too, on the network.** Every `/api` route checks its caller. Five routes
   stay open: `/healthz`, `/about`, `GET /join`, `POST /heartbeat` (ADR-0013 §5) and the static web
   files, so the sign-in page can load. The reason is the Context: the reads are what an injected
   agent exfiltrates, and the cookie already exists, so checking it costs one lookup. Guests keep
   their ADR-0038 scopes with no cookie, because a guest is another Tailscale user, and an account
   on the owner's node cannot match a guest grant.

9. **The owner lists and revokes from the Devices screen and from the hub.** The screen lists each
   passkey and each session, with the device name, when it was made, when it ends, and *this
   device*. Revoking a session refuses its next request and closes its open WebSockets. Removing a
   passkey revokes every session it made. *Sign out everywhere else* revokes every session but this
   one. On the hub, `yantra passkey list`, `yantra passkey remove <name>` and
   `yantra session revoke <id>` do the same over the socket. Recovery is decision 2: a person who can
   reach the hub's `yantra` account can always enrol again.

10. **The CLI on the hub needs no passkey.** It uses the socket, and ADR-0042's uid check is the
    proof. Nothing changes for it.

11. **The CLI on another machine gets no owner rights.** Its requests carry no cookie, so owner
    routes answer 401 and say *"sign in from the dashboard, or run this on the hub"*. The owner runs
    a command on the hub with `ssh <hub> yantra …`. The agent commands `yantra mcp` and
    `yantra room` work there only as an agent caller (decision 12).

12. **An agent account has no owner right on any route.** Under this ADR alone, `karigar` on any
    machine gets 401 on every `/api` route. What it may do comes only from ADR-0040's agent grant.
    ADR-0040 identifies an agent by a socket uid on the hub or a tag on another node. Neither covers a
    session that the daemon starts as `karigar` on the owner's untagged Mac. **So ADR-0040 needs a
    third identifier, and this ADR proposes it:** when the daemon starts a session or a Chat turn, it
    makes a token for it, with the same hash-only store as decision 6. The token goes in the
    session's environment, never in its arguments, where other accounts could read it in `ps`. The
    daemon maps the token to an agent grant: the room and task tools for that workspace, and nothing
    else. The token ends when the session ends. The owner accepts this part with ADR-0040.

13. **A join from another machine carries a code.** The *Add a machine* screen, signed in, shows
    `curl -fsSL 'https://<hub>:8443/join?code=<code>' | sh`. The code has decision 2's rules. The
    script posts it with `{ "user" }`. ADR-0029 decisions 3 and 4 stay: the account is whoever ran
    the command, and the machine is named from its address. A join with no code, or a used code,
    gets 401. The hub's own join keeps ADR-0042's socket path, with no code.

**The done test** is these cases, each a test in a podman container with a virtual authenticator
(§B3):

- A request with no cookie from the owner's node gets 401 on a write and on a read; `/healthz`,
  `/about` and `GET /join` answer.
- Enrolment with a code from the `yantra` uid works. A code from another uid is refused. A used code
  and an expired code are refused.
- A sign-in sets the cookie with all five attributes, and a write with it passes.
- A write with a good cookie and a foreign `Origin` is refused.
- A revoked session is refused on its next request, and its open WebSocket closes.
- A forged cookie, and a cookie copied from the hash in the file, are refused.
- A session token from decision 12 starts a task on its own workspace and gets 403 on every owner
  route.

Two checks are by hand, because they need real hardware: sign-in on the owner's iPhone in Safari and
from the Home Screen app, and sign-in on `cachyos-g14` with the phone's QR code.

## Consequences

**Gained.** An agent account on any machine cannot act as the owner. It cannot read the owner's
fleet either. The proof is a person's passkey with user verification, not a network address. The
hole that ADR-0042 left open is closed.

**Cost: a new file, and CLAUDE.md must say so.** On acceptance, the change edits these lines:

- **CLAUDE.md §B1**, the paragraph that lists what the daemon writes (*"It writes exactly one
  file…"*). It gains one sentence: since this ADR it also writes `~/.config/yantra/passkeys.toml`,
  with public keys and token hashes, no fleet state and no secret value.
- **CLAUDE.md §B4**, *Never store secrets*. The two exceptions stay two. It gains one clause: the
  passkey file holds no value that grants access, because it keeps public keys and hashes. That
  clause stops a reader from counting it as the third credential.
- **ADR-0004**, a dated note after the 2026-08-22 amendment and its 2026-09-06 note. It is the same
  bound: the file is an input the owner gives, not a store of what the daemon observed. The first
  look after a start still knows nothing about the fleet.

**Cost: a stolen file still matters.** Whoever can **write** the file can add a passkey and become
the owner. Only the `yantra` account and root can write it. Whoever can read `daemon.env` can do
worse already, so this adds no new class of attacker.

**Cost: one sign-in per device, and one more every 30 days.** On the phone that is one Face ID tap
when the session ends. An iPhone Home Screen app keeps its own cookies apart from Safari, so it needs
its own sign-in. I did not verify this on iOS 26; the hand check above does. A report on Apple's
forums (iOS 18.6.2) says passkey prompts from Home Screen shortcuts can show twice or stall. The
sign-in button starts the ceremony on a tap and never on page load, which is how that report's
failure is least likely. A sign-in that fails shows the error and a *Try again* button.

**Cost: the plain port loses the browser.** `:7717` is not a secure context, so a browser there
cannot sign in. Since decision 8 it reads nothing either. `:7717` keeps the heartbeat, `/healthz`,
`GET /join` and agent tokens. The browser uses `:8443`, as it does today.

**Cost: the relying party id is a name.** If the owner renames the hub or the tailnet, every passkey
stops working. Recovery is decision 2. The Devices screen names the relying party id, so the cause is
visible.

**Cost: sessions on other machines lose room and task tools until decision 12 ships.** A Chat turn
on the Mac calls `/api/mcp` as `karigar`. Without the session token it gets 401. So decision 12 ships
in the same change as decisions 5 and 8, or that change waits.

**Cost: a new dependency and a licence.** `webauthn-rs` and `crypto-glue` are MPL-2.0, which
`deny.toml` does not allow today. The change adds `MPL-2.0` to its `allow` list. MPL is copyleft per
file, and Yantra does not change those files, so it binds nothing in Yantra's own code. The build
must also show that no `openssl` enters the musl build.

**Cost: Q6 ends.** Yantra was personal-first with no authentication. It now has a sign-in. That is
the price of agents in their own accounts on the owner's machines.

**What ADR-0040 reuses.** Its grant file, its task-only tools, its socket path on the hub and its
refusal ring stay as written. It gains decision 12's session token as a third way to identify an
agent, and it reuses decision 6's hash-only store for it. Its Context sentence *"Bilbo would pass as
the owner"* is false after ADR-0042 on the hub and after this ADR everywhere.

## Alternatives

**A signed cookie with a key in a secret file**, as T3 Code does. It needs no session rows, but it
needs a revoke list anyway, and the key is a third credential that CLAUDE.md §B4 forbids without a
reread of ADR-0023. Hashes give the same check with no secret.

**A session key in memory only.** It also holds no secret, but each restart signs out every device.
A nightly channel (Y-662) would restart the daemon every day, so the owner would sign in daily on each
device.

**A bearer token typed into the browser.** It is a shared secret that the owner copies by hand, and
any agent that reads the browser's storage takes it. A passkey cannot be copied out.

**Keep agent accounts off the tailnet.** A firewall rule on each machine drops `karigar`'s traffic to
the hub. It needs root on every machine, macOS has no `meta skuid`, and the daemon cannot see whether
the rule exists, so it fails open. ADR-0042 rejected the same rule on the hub.

**A device login for the CLI on another machine.** The CLI prints a code, the owner approves it in a
signed-in browser, and the CLI keeps a token in the owner's own `0600` file. Account separation then
keeps `karigar` out. It is a real option, but no current task needs it: the owner reaches the hub
over ssh. It waits for a use.

**Reads stay open on the tailnet.** It costs nothing to build. It leaves the private repository
names, the room messages and every task's output open to any agent on any machine.

## Not decided here

- Whether a write that spends money or pushes to GitHub asks for a fresh passkey tap, as a step-up.
- The device login for the CLI, above.
- Whether a guest also signs in with a passkey (ADR-0038).

## Sources

Accessed 2026-11-09.

- `webauthn-rs` 0.6.2 docs: <https://docs.rs/webauthn-rs/0.6.2/webauthn_rs/> and
  <https://docs.rs/webauthn-rs/0.6.2/webauthn_rs/prelude/struct.Passkey.html>.
- crates.io API: <https://crates.io/api/v1/crates/webauthn-rs> (versions, licence),
  <https://crates.io/api/v1/crates/webauthn-rs-core/0.6.2/dependencies>,
  <https://crates.io/api/v1/crates/crypto-glue>.
- W3C, *Web Authentication Level 3*, §5.1.4 (relying party id) and the secure context rule:
  <https://www.w3.org/TR/webauthn-3/>.
- Apple Developer Forums, *Passkey authentication issues on iPhone when launching login pages via
  Home Screen shortcuts*, iOS 18.6.2: <https://developer.apple.com/forums/thread/815784>.
- T3 Code, commit `67eebaca` (2026-11-05), MIT: `apps/server/src/auth/ServerSecretStore.ts`,
  `PayloadSigner.ts`, `PairingGrantStore.ts`, `SessionStore.ts`, `http.ts`,
  `EnvironmentAuthPolicy.ts`; `apps/desktop/src/preview/Passkeys.ts`.
- Yantra code read on `main` at `9ddd342a`: `crates/yantrad/src/write.rs` (`allowed`, `Join`),
  the route table across `crates/yantrad/src/`, `crates/yantra-core/src/claude.rs`
  (`--mcp-config`, `X-Yantra-Thread`), `deny.toml`.

> **2026-11-12 ([Y-687](../../tracker.md)): the dashboard's name can be the owner's own.** On
> 2026-11-11 the owner kept the box's custom name, `yantra.cloudx.run`, served by Caddy
> ([ADR-0042](0042-the-proxy-hop-is-proved-by-the-kernel.md), amended the same day). On 2026-11-12
> the owner asked for that name everywhere. Decisions 1 and 5 change in one way: **the daemon's
> configuration can name the dashboard's origin**, for example `https://yantra.cloudx.run`. When it
> does, the relying party id is that origin's host, and a write whose `Origin` is not that origin is
> refused. When it does not, both stay the MagicDNS name and `:8443`, as decision 1 wrote them. One
> origin is allowed, never a list. A passkey belongs to its relying party id, so a passkey made on one
> name does not work on the other, and changing the name later costs every passkey, as the
> *Cost: the relying party id is a name* consequence already says.

> **Decision 8 amended 2026-11-12 ([Y-789](../../tracker.md), owner): only the owner's own devices
> start a passkey ceremony.** The 2026-11-12 security audit (F-15) found that the four ceremony
> routes answer any caller and have no limit. That allows a denial of service against enrolment and
> unbounded memory. A guess still cannot succeed. The owner decided on 2026-11-12: **the four routes
> run [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)'s predicate**
> (the owner's own untagged node, live `whois`, failure closed), with no cookie needed. Any other
> caller gets 403. Wrong codes are counted for each caller node, so one node's wrong codes void no
> other node's code. The number of open ceremonies is capped.
>
> **What changed upstream of the reasoning:** decision 8 left these routes open because a browser
> with no cookie must reach them. Only the owner's own devices sign in, and ADR-0016's predicate
> needs no cookie, so the routes can ask it.
>
> **Decision 12's room rule holds, 2026-11-12 ([Y-784](../../tracker.md), owner).** *The room tools
> for that workspace* means the rooms whose definition names that workspace, and a room whose file
> the owner lists that workspace in. A room that no workspace defines is out of reach.
> [ADR-0038](0038-rooms-and-guest-devices.md) decision 2's dated note records the change there.
