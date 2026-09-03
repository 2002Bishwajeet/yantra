# ADR-0021 — The relay is written to an environment file the unit reads

- **Date:** 2026-08-22
- **Status:** accepted (2026-08-22, by the owner — Y-199)
- **Closes:** [D3](../design/03-dashboard-surface.md) §12.2, which named three answers and decided
  none.
- **Bends two of this repo's own rules**, both named in the Consequences: §B4's *never store
  secrets*, and Y-044's *the daemon persists nothing* ([ADR-0004](0004-rust-for-the-daemon.md)'s
  2026-08-02 amendment).

## Context

`YANTRA_NTFY_URL` and `YANTRA_NTFY_TOKEN` are the two values the notifier does not work without.
Y-147 reads them **from the environment and from nowhere else** — not a workspace field, not a file
Yantra writes, not the API — and that rule was §B4 applied to the first byte Yantra sends off the
tailnet.

**Nothing in the product writes them.** On the appliance that means a keyboard, an ssh session and
`systemctl edit yantrad`, which is the box the dashboard exists so nobody has to open. D1 §6 asked
for the UI two milestones ago; [D3](../design/03-dashboard-surface.md) §0 records the owner amending
Q6 to allow `/settings` for exactly this — *what Q6 refused is preferences, not configuration*.

D3 §12.2 stopped there, and said why:

> This is the one part of §0's Q6 amendment that is not yet designed, and it is not a UI question: it
> is where a daemon that persists nothing keeps a value that must survive a restart.

It named three answers with three different §B4 consequences — an environment file the unit reads, a
config file beside `~/.config/yantra/workspaces/`, or a token the browser holds and sends per
notification — and decided none of them.

**The owner decided on 2026-08-22, with both costs stated.** This ADR records that decision; it does
not explore it.

## Decision

**`/settings` and `yantra relay` write `/etc/yantra/daemon.env`, and `yantrad.service` reads it with
`EnvironmentFile=`.**

**1. The file is `/etc/yantra/daemon.env`, mode `0600`, owned by `yantra`.** That is part of the
decision rather than an afterthought, because it is the only mitigation this shape has. `systemd`
reads the file **as root**, before it drops to the unit's `User=yantra`, so the mode costs the daemon
nothing at read time. The owner is what lets `/settings` — which runs as that account — rewrite it.
It sits beside `/etc/yantra/agent.env`, which is the same idea for the agent's own configuration
([ADR-0013](0013-the-heartbeat-carries-only-what-placement-scores.md) §4) and is `0644` root because
an address is not a secret.

**2. `EnvironmentFile=` is optional (`-`), and the installer creates the file empty.** A box with no
relay is every deployment but the appliance, and a daemon that refused to start without one would
make a notification setting into a boot dependency. `install.sh` writes the file when it is absent
and never a value into it, the way it already treats `agent.env`.

**3. The daemon's read path does not change at all.** `yantra_core::notify::from_env` still runs once
in `main.rs`. So a relay written now reaches the daemon **at its next start** — `systemctl restart
yantrad` — and both surfaces say so rather than implying the change is live.

**4. The write sends a test message to what it just wrote, and reports both.** A relay written down
and never reached is the failure a headless box has no screen to show. The file is written first, so
a send that fails answers `502` and says the relay *is* on disk; it does not un-write it.

**5. Nothing reads it back.** No route serves the URL or the token, and `/settings` shows no current
value — a field is empty on every visit and what you type replaces what is there. Serving it would
put the token on the wire and in a browser's memory, and §B4 holds everywhere this decision did not
carve.

**6. The CLI has the verb first**, which is [`crates/yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md)'s
standing rule: `yantra relay <url> [--token <token>]` writes the same file and sends the same test
message. The route is that verb on the wire, on
[ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)'s gate like every other
write.

## Consequences

**This bends §B4, and the sentence it bends is *never store secrets. Workspaces hold references,
never values.*** The ntfy token is a value and this writes it to disk in plain text. **The exposure
is exact: on the appliance, whoever can read `/etc/yantra/daemon.env` has the token** — root, and the
`yantra` account. Nobody else, which is what `0600` buys and why the mode is in the decision above.
A person who reads it can publish to that topic; on the public server they can also *read* it, since
there the topic in the URL is the only password there is.

**The rule is not withdrawn, because it is about workspaces and they are untouched.** A workspace
still has nowhere to put a secret — ADR-0007's schema has no field for one — and a reference is still
resolved at launch, on the machine that runs the agent, and never on the way to a relay. This is one
file, holding one credential, that the operator typed into a form that says what it does with it.

**It bends Y-044's *the daemon persists nothing*, which is ADR-0004's amendment and §B1's summary of
it.** `yantrad` now writes a file it reads back after a restart. The bound is worth saying plainly:
**it is configuration, not state.** Nothing about the fleet is written — no session, no verdict, no
beat, no history — and the daemon still starts with no memory of what it saw. The no-history non-goal
is intact; what changed is that one of the daemon's own inputs is now settable from the surfaces that
already act.

**The CLI puts both values on `argv`**, where `ps` and the shell's history can see them. That is the
cost of a verb rather than a prompt, and the browser's form is the way around it. It is not a new
disclosure — the topic was already on `argv` for every `yantra notify`.

**A relay set from the browser does nothing until the daemon restarts.** The test message proves the
values now; the daemon uses them at its next start. Making it live would mean the running notifier
holding a relay something else can swap, which is a change to the read path decision 3 keeps.

**A file the installer did not create is a file the daemon may not be able to write.** `write_to`
truncates in place rather than renaming a temporary over, because `/etc/yantra` belongs to root and
the `yantra` account cannot create a sibling there. So a `daemon.env` created by hand as root leaves
`/settings` answering `500` with the path, and the fix is `chown yantra`.

### What was rejected, and why

**A reference to a vault entry resolved at send time** — `op://…`, `pass show …` — was the shape §B4
would have preferred, and the owner refused it. It moves the secret rather than removing it: the
appliance would need `op` or `pass` installed, unlocked and authenticated on a headless box that
reboots unattended, and *that* credential would have to live somewhere with no vault in front of it.
It also buys nothing here that the mode does not: anything that can read the file could equally run
the resolver.

**A `/settings` that shows the command and writes nothing** was rejected as the thing this row
exists to stop. It is where the dashboard already was before Y-112 —
`web/src/components/Command.tsx` handed the operator a command to paste into a terminal — and from a
phone it is worth nothing, which is ADR-0016's own opening argument.

**The two other answers D3 §12.2 named** were not taken. A config file beside the workspaces has the
same §B4 cost with none of the unit's support, so it would need the daemon to grow a config reader
`crates/yantrad/CLAUDE.md` refuses on the bind address for the same reason. A token the browser holds
and sends per notification keeps the disk clean and makes the phone the only place the relay exists —
so a notification that fires while no tab is open cannot be sent, which is the case the notifier is
for.

### Not decided here

- **Where a second secret would go.** There is one, and this ADR is about that one. A second is a
  reason to reread this decision, not a licence granted by it.
- **Whether the relay should be live without a restart.** Decision 3 says it is not. If that becomes
  worth the plumbing, it is a change to how the daemon holds the relay and gets its own row.
