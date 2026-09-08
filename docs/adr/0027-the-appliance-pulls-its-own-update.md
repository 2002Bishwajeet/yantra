# ADR-0027 — The appliance pulls its own update, and a person asks for it

- **Date:** 2026-09-08
- **Status:** Accepted 2026-09-08 — the owner picked the operator-initiated shape.
- **Closes:** Y-366. Gates Y-367 and Y-368.
- **Amends** [ADR-0013](0013-the-heartbeat-carries-only-what-placement-scores.md) by the dated
  blockquote appended there on 2026-09-08. Its fleet prohibition holds as written; what narrows is
  the phrase *no self-update*, and only for the box the daemon runs on.
- **Reads against** [ADR-0021](0021-the-relay-is-written-to-an-environment-file.md) and
  [ADR-0023](0023-the-github-grant-lives-beside-the-relay.md) for what the daemon already holds, and
  [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md) for what authorises a
  write.
- **Depends on** [Y-365](../plans/m15-the-first-release.md) §3: `install.sh` pins `VERSION=0.1.0`
  today, and the release is v0.2.0. **How the installer resolves the current version is Y-365's, not
  this ADR's.**

## Context

The owner asked for auto-update. **An accepted ADR already forbids part of it.** ADR-0013's
non-goals say:

> No remote execution, configuration management, log shipping, software inventory or process list —
> each is something this agent is well placed to do and must not. Likewise **no self-update and no
> daemon-initiated update**: a control plane that can push a binary to five machines is the
> fleet-management product this project exists not to be (R-12).

The same ADR's *Not decided here* says:

> **Install and update** — systemd unit, launchd LaunchAgent, Windows service (R-12). This says what
> the agent sends, not how it reaches a machine or stays current.

So one half is closed and the other half is open, and they are different questions. *Pushing a
binary to the fleet* is closed. *How the one box the owner runs `yantrad` on stays current* was left
open on purpose, and M15 is where it comes due: v0.1.0 shipped on 2026-08-09, four milestones sit on
`main`, and the only way onto the appliance today is `just appliance-install` — a developer copying
binaries from their own box over ssh.

**What exists already decides most of the mechanics.** [`install.sh`](../../install.sh) fetches a
release archive and `SHA256SUMS`, verifies with `sha256sum -c`, and installs each binary as
`<name>.new` before renaming it over the live one, which is how it survives `ETXTBSY` on a running
binary ([`docs/appliance.md`](../appliance.md)).
[`release.yml`](../../.github/workflows/release.yml) publishes four `tar.gz` archives, one
aggregated `SHA256SUMS`, and release notes — **no `latest.json` and no version manifest**.
`GET /api/about` already answers with `version`, `target` and `built` from
[`about.rs`](../../crates/yantra-core/src/about.rs).

### The three shapes, and what each costs

| Shape | What it costs |
| --- | --- |
| **A systemd timer runs the installer on a schedule.** Nothing in the daemon fetches anything, so ADR-0013's *no daemon-initiated update* survives word for word. | The box can restart itself while the owner is working in it. A chat turn in flight dies (§5) and nobody asked for it to. |
| **The operator presses the button.** The daemon *reads* the published version, About says a newer one exists, and `yantra update` applies it. | The box can sit a week behind. The daemon reads GitHub for a reason that is not a session, which is new. |
| **The daemon polls and applies.** | Cheapest to use, and it contradicts ADR-0013 head-on. It is *daemon-initiated update* in that ADR's own words, with no reading of them that saves it. |

**The owner picked the second on 2026-09-08.** The reason is asymmetric: an appliance that restarts
a live session unattended destroys work a person is doing, and a box a week behind destroys nothing.
This ADR records that pick; it does not re-explore it.

## Decision

**The daemon says a newer release exists. A person says apply it. A root unit does the work, and it
installs the current release or nothing.**

### 1. Scope is the appliance, and nothing else

**The only box that stays current is the one that runs `yantrad`.** A machine Yantra reaches over
ssh never receives a binary, a unit, a script or an update instruction from Yantra. That is the half
ADR-0013 closed and this ADR keeps closed.

**`yantra-agent` on the MacBook is installed and updated by hand**, as it is today: macOS has no
installer and no unit here, a person copies the binary from the release page, and ADR-0018 §7's
launchd job is what starts it. The appliance's *own* `yantra-agent` is updated, because
`install.sh` installs all three binaries and the update is that script.

**That costs something, and the Consequences say what.** ADR-0013 rejects unknown fields, so a
daemon that moves while a far agent stands still is the staggered upgrade ADR-0013 warns about — in
the safe direction, but darkness all the same.

### 2. The daemon reads, and never applies

**Nothing is fetched or applied unattended.** The daemon's whole part is a version number it read
and a request it forwards:

- It reads the published version hourly, on the background refresh that already exists, **never on
  the request path** (Y-070's rule). About names the running version and the published one, and a
  read that failed says it failed rather than saying *you are current* — that is Y-367's typed
  error.
- When a person acts, the daemon **asks** for an update. It does not perform one. It holds no
  archive, verifies no checksum and writes nothing into `/usr/local/bin`.

**The CLI has the verb first**, which is
[`crates/yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md)'s standing rule: `yantra update`
applies, `yantra update --check` prints what About shows. The dashboard action is that verb on the
wire, on ADR-0016's gate like every other write.

### 3. One unit installs, and the daemon may only ask for it

**`yantra-update.service` is the only thing that installs anything.** It is `Type=oneshot`, it runs
as root, and its `ExecStart` is `/usr/local/bin/yantra-update` — the copy of the installer that
`install.sh` leaves behind, so no executable is fetched from the network at apply time by anything
but the installer itself.

`yantrad` runs as `yantra`: a `nologin` account, no sudo, and no way to write `/usr/local/bin`. It
starts that unit through **`yantra-update.path`**, watching a file in the daemon's home that the
daemon `touch`es. The service removes the file first, so the path unit re-arms. `yantra update` run
with privilege starts the same unit directly, and prints what to run when it has none.

**The trigger carries nothing — no version, no argument, no environment.** That is the property
worth having: the daemon's account can ask for *the current release* and cannot ask for a
*particular* one. A sudoers `NOPASSWD` line for the same script is one file simpler and was
refused for exactly this: it would let the caller name the version, and naming an old version is an
attack.

### 4. What is read, what is fetched, and what verifies it

**The check is one read:**
`GET https://api.github.com/repos/2002Bishwajeet/yantra/releases/latest`, for `tag_name` and nothing
else. It uses the grant ADR-0023 gives the daemon when one is present —
[`github.rs`](../../crates/yantra-core/src/github.rs) already has the client, the `Bearer` header
and the blocking-off-the-worker pattern — and falls back to an unauthenticated call when there is
none.

**The failure modes, named.** Unauthenticated GitHub allows 60 requests an hour **per IP**, shared
with everything else behind it, so an unlucky box gets a `403`; with the grant the limit is 5,000 an
hour and one call an hour is free. Either way a failed check is reported as a failed check.

**No `latest.json` and no manifest.** Three reasons. `/releases/latest` already excludes drafts and
pre-releases, so a `v0.3.0-rc.1` tag — which `release.yml` marks `--prerelease` for any hyphenated
version — never reaches the appliance, and a manifest would have to re-implement that rule. A
manifest is a second source for one fact, which is the disagreement ADR-0013 §3 refuses for `os`.
And it is one more thing to keep true in a workflow nobody runs between releases.

**What is fetched is what `install.sh` already fetches**, at the version it resolves for itself:
`yantra-<version>-<target>.tar.gz` and `SHA256SUMS` from
`https://github.com/2002Bishwajeet/yantra/releases/download/v<version>/`, checked with
`sha256sum -c --ignore-missing`, and a mismatch installs nothing. **The daemon fetches no
executable.** It reads a version number; the root unit fetches the bytes.

**The honest limit of that verification.** `SHA256SUMS` proves the archive arrived intact from the
release it names. It does not prove the release is the one the owner meant. `install.sh`'s pinned
`VERSION` and `COMMIT` are stronger than that today — a human bumped both in a reviewed commit, and
the comment beside `COMMIT` records that v0.1.0's tag was moved once already. **Resolving a version
gives that guarantee up by construction**, which is Y-365's trade rather than this ADR's, and what
is left is trust in the repository and in whoever can publish to it. Nobody should read this ADR as
saying the update path is verified end to end.

### 5. What restarts, and what must survive it

The unit ends in `systemctl try-restart yantrad.service yantra-agent.service`, which is what
`just appliance-install` already does and what leaves a first install's units stopped.

**A running tmux session survives, and the reason is structural rather than lucky.** Sessions are
created with `tmux new-session -d` (I-1) on the *far* machine, in a tmux server the login user there
owns. `yantrad` is not that server's parent and is not on that machine. An update on the appliance
touches no far machine at all.

**The dashboard's WebSocket does not survive.** `terminal.rs` owns a local `ssh` in a pty for as
long as someone is looking, and that process is `yantrad`'s child. A restart closes the socket; the
browser reconnects and re-attaches to the same pane, so the operator sees a blip and the same
screen. Y-368 does not close until a podman test proves both halves of this paragraph.

**One case kills work in progress, and it is named rather than hidden.** Under
[ADR-0026](0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md) the chat is a `stream-json`
bridge `yantrad` owns. A chat turn in flight is a process the daemon spawned, and a restart kills it
mid-turn. This is survivable because a person pressed the button and knows what they were running;
it is the single strongest argument against anything unattended.

**Three smaller things go, and the surfaces already say so.** ADR-0025's ring buffer of the last 50
events is emptied, and the first look after a start shows nothing. Every telemetry row is emptied,
so machines read *never heard from* until the next beat, at most ten seconds later, and beats that
land during the restart are dropped by ADR-0013 §7. An open dashboard is the old build talking to a
new daemon — `GET /api/about` carries `version`, so the page can compare what it loaded against what
answers and ask for a reload.

### 6. Rollback keeps one generation

**The installer copies each live binary to `/usr/local/bin/<name>.prev` before the rename.** The
M15 plan §6 asks this ADR whether the previous binary is kept, and the answer is yes. It costs one
`cp` and a few tens of megabytes on the Pi, and it buys the one case that matters: the moment right
after an update is when the release page's answer is least trustworthy, and it may also be the
moment the box has no working network.

Rolling back is three renames and a `try-restart`:

```sh
for b in yantrad yantra yantra-agent; do sudo mv -f /usr/local/bin/$b.prev /usr/local/bin/$b; done
sudo systemctl try-restart yantrad.service yantra-agent.service
```

**The bounds are exact.** One generation is kept, not a history. The units are not kept, so a
release that changed a unit is rolled back by re-installing the older release rather than by this. A
box whose network works has the better answer anyway — install the older version by number — because
a published release is immutable in practice and a `.prev` file is not a record of what it was.
Nothing here is automatic: a bad release is noticed by a person and reversed by a person.

### 7. What stays closed

**Yantra still ships no software to the fleet.** No binary, no unit, no script and no update
instruction crosses ssh to any machine. The daemon holds no inventory of what version a machine
runs, offers no way to make five machines current, and gains no capability from this ADR that points
at another machine. The agent stays what R-12's mitigation says: heartbeat-only, no logic, no
versioned protocol beyond a JSON blob, and its response is still `204` and still carries no
instruction.

The appliance is not an exception carved into that rule. It is the box the daemon *runs on*, not a
machine the daemon *manages*, and the difference is the whole of what this ADR relies on. If Yantra
ever updates a second machine it is a fleet-management product, and that is a new decision rather
than an extension of this one.

## Consequences

**A newer daemon can outrun the agents, and ADR-0013 says what happens then.** Unknown fields are
rejected and there is no version negotiation, so a payload change plus an updated appliance equals a
Mac whose beats stop parsing. The direction is the safe one — ADR-0013 asks for the daemon first —
and the update is a person's act, so *daemon first* stays something the owner does in an order they
chose. The release that changes the payload is the release whose notes must say the Mac's agent goes
next.

**The daemon reads GitHub for a reason that is not a session.** ADR-0023's grant was for
repositories, reviews, issues and notifications. This adds the release list. The scope is
unchanged — a public repository's releases need no scope at all — but the sentence *what the daemon
reads GitHub for* now has one more entry.

**`yantrad`'s account can cause a restart of `yantrad`.** That is new and it is small: the trigger
is a file with no content, the unit installs the current release and nothing else, and the worst a
compromised daemon account gets is a loop of restarts — a denial of usefulness rather than an
execution primitive. It is the same shape of judgement R-22 already carries.

**Two install paths exist and only one of them is this.** `just appliance-install` stays what it is:
a developer pushing an unreleased build over ssh. It writes no `.prev`, resolves no version and
starts no unit. Nothing here changes it, and a box installed only that way has no `yantra-update` on
it.

**The appliance now fetches executable code on a person's word rather than only on a person's
command line.** That is a real widening, and the mitigations are the ones above, in the order they
cost nothing: the trigger carries no version, the unit resolves the current release itself,
`SHA256SUMS` gates the bytes, and no schedule exists to fire when nobody is watching.

### What was rejected, and why

**The daemon polling and applying.** It is *daemon-initiated update* in ADR-0013's own words. No
reading of that non-goal survives it, and the gain over a button is a week of currency.

**A systemd timer.** It keeps ADR-0013's words intact and breaks the thing the words protect: a box
that restarts itself at 03:00 does not know a chat turn is running. §5 is why.

**A sudoers `NOPASSWD` line for the daemon's account.** Simpler than a path unit by one file, and it
hands the choice of version to the caller. See §3.

**A `latest.json` published by `release.yml`.** See §4. It would buy one thing this design lacks —
a version and its commit recorded together, immutably, at build time — and that is worth having only
once the moved-tag problem bites.

**A dashboard that shows the command and applies nothing.** ADR-0021 already rejected that shape for
`/settings`: from a phone it is worth nothing, which is ADR-0016's opening argument.

### What would justify revisiting this

- **A tag that moves, or a release asset that is replaced.** §4 says this design defends against
  neither. The first time it happens, the manifest above stops being one more thing to keep true and
  starts being the fix.
- **A second box running `yantrad`.** The scope argument in §7 is written for one, and a second is a
  reason to reread this rather than a licence it grants.
- **A heartbeat payload change**, which is the first real test of the staggered-upgrade cost above.
- **An owner who stops pressing the button.** A box months behind because nobody clicked is the
  failure this shape can have, and the answer would be the opt-in timer below rather than a daemon
  that applies.

### Not decided here

- **An opt-in timer.** If unattended updating is ever wanted, it is one more unit starting the same
  `yantra-update.service`, off until the operator enables it — and it is future work with its own
  row, not designed here.
- **Whether the appliance's `yantra-agent` should update separately from `yantrad`.** Today the
  installer moves all three binaries together, and that is what this uses.
- **How the installer resolves the current version**, which is Y-365's.
- **Where `install.sh` is served from.** Y-159 asks for a name that resolves off the tailnet, and
  the answer changes what `/usr/local/bin/yantra-update` was fetched from, not what it does.
- **A release cadence.** A tag is cut when there is something worth installing
  ([the M15 plan](../plans/m15-the-first-release.md) §7).
