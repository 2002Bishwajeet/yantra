# ADR-0047 — The dashboard gets Web Push

- **Date:** 2026-11-20
- **Status:** Accepted 2026-11-20 by the owner ([Y-825](../../tracker.md)). The owner's words:
  *"I'm fine with no notification at all. Just make the web push work."*
- **Amends:** [ADR-0021](0021-the-relay-is-written-to-an-environment-file.md) (a third value in the
  environment file). [ADR-0023](0023-the-github-grant-lives-beside-the-relay.md) (a third credential
  beside the two). [ADR-0045](0045-the-hub-keeps-a-thread-store.md) decision 2 (a second table).
  [ADR-0004](0004-rust-for-the-daemon.md)'s 2026-08-22 amendment, a fifth time. Each gets a dated
  note.
- **Unchanged:** the relay of ADR-0021, which stays as the fallback. The rules of the notifier:
  nothing at the first look, no queue, no retry, nothing while a dashboard is watched.
  [ADR-0025](0025-the-daemon-remembers-what-it-pushed.md)'s ring.
  [ADR-0044](0044-a-write-needs-the-owners-passkey.md)'s gate.

## Context

Yantra tells the owner when a session needs them. Today that goes through ntfy
([ADR-0021](0021-the-relay-is-written-to-an-environment-file.md)). ntfy has two costs on the owner's
iPhone:

- It needs a second app, with its own subscription to a topic.
- A tap on its notification opens Safari. Safari is not the installed dashboard, so the owner lands
  in a browser tab with no passkey session.

Web Push belongs to the installed app. The notification comes from Yantra on the Home Screen, and a
tap opens Yantra on the page the push names.

Web Push has three parts, and each one makes the daemon hold something:

- **A signing key (VAPID, RFC 8292).** The browser subscribes with the daemon's public key. Each
  push service accepts a push only when the matching private key signed it. The key must survive a
  restart, because a subscription is bound to it.
- **A subscription for each device.** It is an endpoint URL at the push service of the browser
  (Apple, Google, Mozilla), a public key (`p256dh`) and a 16-byte secret (`auth`).
- **An encrypted payload (RFC 8291, `aes128gcm`).** The daemon encrypts each push for one device,
  so the push service reads no text.

CLAUDE.md §B4 lets the daemon hold two credentials, both in `/etc/yantra/daemon.env`. ADR-0023 says
a third is *a reason to reread this ADR and not a licence it grants*. Decision 2 below is that
reread.

### iOS

iOS gives Web Push only to a web app that the owner added to the Home Screen, from iOS 16.4. A tab
in Safari has no push manager. iOS shows the permission prompt only when a tap starts it. iOS also
takes the permission away from an app whose pushes show no notification.

### The library, read on 2026-11-20

Three crates on crates.io do Web Push. None passes this repository's `cargo deny`:

| Crate | Version | Why it does not pass |
| --- | --- | --- |
| `web-push-native` | 0.5.0 (2026-07-26) | `p256` 0.13 and `jwt-simple` bring `crypto-bigint` 0.5.5, which has RUSTSEC-2026-0387 (timing variability in operations meant to be constant-time). The fix is in 0.7.6 only. It adds 59 crates to the lock. |
| `jmap-web-push` | 0.5.0 | `p256` 0.13, so the same advisory. It also brings `reqwest`, a second HTTP client. |
| `web-push` | 0.11.0 | Its `ece` crate needs OpenSSL, which `deny.toml` bans for the musl appliance build. |

The advisory is about the arithmetic that signs with the private key. An `ignore` line in
`deny.toml` would accept it for the one key this ADR adds.

`webauthn-rs` (ADR-0044) already brings the current RustCrypto crates: `p256` 0.14, `aes-gcm` 0.11,
`hkdf` 0.13 and `sha2` 0.11. They have the fix. The two RFCs are small on top of them: one ECDH,
two HKDF steps, one AES-GCM record and one ES256 signature.

## Decision

1. **The daemon sends Web Push itself, with the RustCrypto crates it already has.**
   `crates/yantrad/src/push.rs` composes RFC 8291 and RFC 8292 from `p256`, `hkdf`, `aes-gcm` and
   `sha2`, and `ureq` sends the request. The lock gets no new crate and `deny.toml` gets no `ignore`
   line. The proof is RFC 8291's own example: the test encrypts the example's text with the
   example's keys and gets the example's bytes. **The cost:** about 150 lines of protocol code are
   ours to keep correct. When a published crate passes `cargo deny`, replace them.

2. **The daemon makes one signing key and keeps it beside the relay.** It is a P-256 key pair. The
   private half is 32 bytes in URL-safe base64, in `/etc/yantra/daemon.env` as `YANTRA_VAPID_KEY`:
   plain text, mode `0600`, owned by the account the daemon runs as. The existing writer writes it
   and takes both locks (`Fleet::env` and the file's `flock`).
   - **When:** the first time a signed-in owner asks for the public key, which is the first *Turn
     on*. A daemon whose owner never turns notifications on never makes a key.
   - **Live at once:** the daemon holds the key in memory from that moment. The line in the file is
     for the next start, as the GitHub token's is (ADR-0023 decision 3).
   - **A key that cannot be written is not used.** The route answers 500 and names the file. A key
     in memory only would die at the next restart and take every device with it.
   - **A new key removes every stored device**, because no stored subscription is bound to it.
   - **No process the daemon starts receives it.** It joins `yantra_core::SECRETS` (Y-647).

   **This is a third credential, and this is the reread of ADR-0023.** ADR-0023's test was what the
   file's reader gains. The first two grant access: the ntfy token publishes to the owner's topic,
   and the GitHub token reads and writes the owner's repositories. The signing key grants access to
   nothing. It does not open the fleet, the dashboard or GitHub. **The cost:** whoever reads the
   file can sign a push as this daemon. To send one they also need a device's subscription, which is
   in the thread store (decision 3), readable by the same account. With both they can show a false
   notification on the owner's devices, and a tap on it opens a page of this dashboard and no other
   site (decision 6). That reader already holds the GitHub token, which is worth more. The file
   still holds only credentials the daemon itself uses, and a machine never receives one. A fourth
   is again a reason to reread ADR-0023.

3. **The devices are rows in the thread store.** `~/.local/state/yantra/threads.sqlite`
   (ADR-0045) gets a second table, `push_devices`: the endpoint, `p256dh`, `auth` and when the row
   was made. At most 16 rows. They are not fleet state.
   - **Why not a file under `~/.config/yantra/`:** the daemon itself changes the list when a push
     service says a device is gone, from a refresh task. The store already has a lock, migrations,
     mode `0600` and a blocking thread for each call (I-12, I-13). A TOML file would need the
     passkey file's atomic writer a second time.
   - **The cost:** ADR-0045 said the store holds no secret. A subscription's endpoint is a
     capability URL and `auth` is a shared secret. Alone they send nothing: the push service
     refuses a push that the signing key did not sign. A reader of the store learns which push
     services the owner's devices use.

4. **Only the owner subscribes.** Four routes sit under the ADR-0044 gate and each calls
   `allowed()`: `GET /api/push/key`, `POST` and `DELETE /api/push/subscriptions`, and
   `POST /api/push/test`. A passkey session passes, and so does the daemon's own account on the
   socket. An agent token gets 403. A guest and a caller with no session get 401. No route reads
   the list back. `GET /api/push/key` may write once (decision 2), as `GET /join` may, so it is
   authorised like a write. An endpoint must be an `https` URL. **The cost:** an owner session can
   make the daemon send a small encrypted `POST` to any `https` host. That session can already open
   a terminal on every machine.

5. **The routes have no CLI verb.** ADR-0012 asks for a verb first. A browser's push manager makes
   a subscription for that browser, and a terminal has none to give. `POST /api/viewing` is the
   precedent.

6. **A push says what the relay is told, and one thing more.** The payload is JSON:
   `{title, body, url}`. The title and the body are the notifier's `Message`, cut at 160 characters
   as before. `url` is a path in the dashboard: `/w/<workspace>` for a session or a PR, the thread's
   page for a chat, `/rooms/<room>` for a room. The service worker opens only a URL on its own
   origin. The four callers of the relay are the four callers of Web Push, and each keeps its
   rules: **nothing is pushed for a look that a dashboard watched** (D3 §13), nothing at the first
   look, no queue and no retry. A daemon with devices and no relay pushes to the devices. A daemon
   with both sends both.

7. **What the push service sees.** The endpoint, the size and time of each push, a 12-hour `TTL`,
   the public half of the signing key, and the hub's public IP address. It reads no text. The
   signature's contact (`sub`) is the project's repository URL, and it names neither the owner nor
   the tailnet. **The cost:** the hub now connects to Apple, Google or Mozilla, which it did not
   before.

8. **A device that its push service forgot is removed.** A 404 or a 410 from the push service
   deletes the row. Any other failure drops that push and keeps the row.

9. **The owner turns it on for each device, in Settings.** *Notifications → This device → Turn on*
   asks the browser's permission from the tap, subscribes with the daemon's key and posts the
   subscription. *Send a test* sends one push to that device. On an iPhone or iPad in a browser tab
   the screen shows one sentence: add Yantra to the Home Screen first. The ntfy relay stays below
   it as the fallback.

**The done test:**

- The encryption gives RFC 8291's example byte for byte.
- A send to a local push service over HTTP carries `TTL`, `Content-Encoding: aes128gcm` and a
  `vapid` `Authorization` that the public key verifies. Only the device's key decrypts the body.
- A 404 and a 410 remove the device. A 503 keeps it.
- The owner's session reaches each route. No session, an agent token and a guest's node do not.
- A watched look pushes nothing.

One check is by hand, because it needs real hardware: the owner's iPhone, from the Home Screen app.

## Consequences

- The owner needs no second app. A tap on a notification opens the installed dashboard on the
  session that needs them.
- `/etc/yantra/daemon.env` holds three credentials. CLAUDE.md §B1 and §B4 say so.
- The thread store holds a second table, and it is the first one that is not about a thread.
- The hub talks to the push services of the owner's browsers.
- The daemon keeps protocol code for two RFCs (decision 1).
- A restart is still a notification hole (I-59). Web Push does not change it.

### Not decided here

- **A lost device.** Its subscription stays until its push service reports it gone, or the owner
  turns notifications off on it. Removing a passkey does not remove the device's subscription. A
  Devices screen row for it, or a removal on revoke, needs its own row.
- **Key rotation.** No route makes a second key. Deleting the line from the file makes the next
  *Turn on* create one, and every device must turn on again.
- **Which events push.** This ADR adds a channel. It adds no event and removes none.

> **ADR-0047, decision 6, 2026-11-24 (Y-829):** the watched-look rule now applies to each device
> for Web Push. One `viewing` timestamp stopped the push to every device, so a laptop tab on
> screen silenced the owner's phone. The owner found it on the first test. The beacon now names
> the device's push endpoint. The daemon skips only the devices that beaconed inside the window
> and pushes to the rest. A beacon with no endpoint, from a browser that is not subscribed, still
> means "someone is watching" for the ntfy relay. The relay keeps the old rule, because the daemon
> cannot tell which device an ntfy message reaches. The done test "a watched look pushes nothing"
> becomes "a watched device gets no push, and an unwatched device gets it".
