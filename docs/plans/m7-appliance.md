# M7 — Appliance

**Status:** planned 2026-08-05. **The demo is hardware-blocked and the preparation is not**, and
separating those two is most of what this plan is for. No Pi 5 and no N100 exists on this tailnet
(§2), so the milestone cannot be closed tonight — while nearly everything the box will run can be
built and verified against machines that do exist.

## 1. The acceptance test

M6 put a terminal in a browser. Every milestone up to it has run on the developer's own laptop,
started by hand in a terminal the developer was sitting at. M7 removes the developer:

> Power-cycle the appliance. Without anyone logging in, the dashboard answers on its own Tailscale
> address, the fleet's rows are current, and when an agent stops for a reason a person has to answer,
> the phone buzzes.

Concretely: a small always-on Linux box holds `yantrad` and `yantra-agent` under a supervisor, its
workspaces name `bishwajeets-macbook-pro` and `cachyos-g14` as they do today, `tailscale serve` puts
the dashboard on `https://<machine>.<tailnet>.ts.net:8443`, and `journalctl -u yantrad` after a cold
boot shows one start and no restarts that a person had to cause.

**Three of ADR-0004's own numbers are part of that sentence** and the tracker's one-line definition
does not carry them: *"the appliance still reports RSS, idle CPU and CLI cold-start as part of M7's
definition of done"* ([ADR-0004](../adr/0004-rust-for-the-daemon.md)). They are quality targets rather
than gates, and M7 is the milestone that owes them.

## 2. What already exists, measured rather than assumed

**The appliance is not a capability. It is a relocation.** Everything the acceptance test names is
running now, on `cachyos-g14`, in a foreground process someone started. What changes is that nobody
logs in, nobody is watching, and the box reboots — so M7's work is supervision, an install path, a
notifier, and the measurements above. It adds no orchestration.

**And the box does not exist.** Measured 2026-08-05 against the live tailnet: six nodes, one user, no
tags — this Linux laptop, the MacBook, an iPhone, an iPad, and the two `laptop-*` nodes that are one
dual-booted machine (Windows last seen 8 days ago, Linux 30). There is no always-on machine on it
that is not the developer's own workstation. **So the reboot demo cannot be run and cannot be faked**,
and this plan's rows are ordered so that the day a box arrives, what is left is enrolment, a copy and
a power cycle.

**Y-140 already spent the milestone's first task.** `yantrad`'s `embed-dashboard` feature compiles
`web/dist` into the binary, so the appliance is one file rather than a binary, a directory and an
environment variable — [`web/embedded.rs`](../../crates/yantrad/src/web/embedded.rs), behind a
`#[cfg]`, with `include_dir` optional and [`just no-node`](../../justfile) holding R-24's line. The
measured price is **3,137,016 bytes** on `aarch64-unknown-linux-musl` against 2,331,872 without, and
the default build is byte-for-byte unchanged.

**And the daemon persists nothing, which is what makes reboot survival cheap.** Y-044 dropped the
session store after auditing five candidate consumers: declared state is the workspace TOML, live
state is tmux **on the fleet machine**, and history is the agent's own transcript. So a reboot of the
appliance loses the in-memory heartbeat rows and the 30-second snapshot, both of which refill within
one interval, and it loses nothing else. **The durable state on the box is three things and none of
them is Yantra's**: `~/.config/yantra/workspaces/*.toml`, an ssh key, and `tailscaled`'s own node
key. That is the whole backup story, and it is worth writing down before someone reaches for a
database because the word *appliance* suggested one.

## 3. Constraints found before planning around them

### 3.1 The daemon refuses to start without Tailscale, and at boot Tailscale is not up yet

[`main.rs`](../../crates/yantrad/src/main.rs)'s `listen_on` fails closed. It asks the local
`tailscale` for the addresses this machine holds and returns `Error::Tailnet` when it cannot ask,
`Error::NoAddress` when the answer is empty; there is no default, deliberately, because the only
default available is one that listens to the whole world (R-22). Started by hand at a prompt, that
refusal is a good error message. **Started at boot, it is a race**: `tailscaled` reports itself
started when its socket is up, not when the netmap has arrived, so the first `tailscale status --json`
can legitimately name no address at all.

**The refusal is not a problem to work around — it is the retry condition.** `Restart=on-failure`
with a `RestartSec` makes the supervisor the thing that waits, and the daemon keeps its property of
never guessing. Two details are load-bearing rather than boilerplate:

- systemd's default start limit (five starts in ten seconds) will put a fast-exiting unit in `failed`
  **permanently**, which is a headless box that is off until someone notices. `RestartSec` has to be
  long enough, or the limit has to be raised, and whichever is chosen wants a comment saying which
  failure it is written for.
- `After=tailscaled.service` orders the start and does not wait for an address. **Do not add an
  `ExecStartPre` that polls `tailscale status` in a loop** without measuring whether the restart
  alone is sufficient — that is a second retry mechanism in front of one that already exists.

**What no mechanism here covers is the address changing while the daemon is healthy.** `listen_on`
runs once, at start; a node key regenerated or a re-auth that moves this machine's address leaves the
listeners bound to something that is gone, and the process is not failing, so `Restart=on-failure`
never fires. Nobody has seen this happen and nobody has looked for it. Named here rather than fixed:
it is a 24/7 property that has never had a 24/7 deployment to show up in.

### 3.2 A headless box makes R-22 the whole posture, and enrolment can break the authoriser

R-22 says the bind address is the entire security model. On the appliance it is also the entire
*access* model: if `allowed()` refuses you, there is no keyboard to walk over to.

**The hazard is in how headless nodes are normally enrolled.** An untagged node's key expires and a
human has to re-auth it — R1 already found two of five peers holding expired keys while still in the
netmap — and the usual answer for a machine nobody logs into is an auth key that **tags** it. But
[`inventory.rs`](../../crates/yantra-core/src/inventory.rs)'s `owner()` is `Self.UserID` from
`tailscale status --json` **on the machine running the daemon**, and
[ADR-0016](../adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md) authorises a
caller by comparing `whois(caller).user` against it. A tagged node is owned by the tailnet rather
than by a person. **So enrolling the appliance with a tagged auth key may make it refuse every write
from the phone that installed it** — `up`, `down`, `resume`, `new`, `edit` and the terminal, on a box
with no other way in.

**[D], read from the code and not measured**, because this tailnet has no tagged node to measure it
against — and that is a cheap thing to fix without buying anything: one ephemeral tagged node is
enough to see what `owner()` and `whois` then return.

> **2026-08-06: cheap, but two owner actions rather than one.** The tailnet was read rather than
> assumed: **no node carries a `Tags` field**, here or among the peers, and one `UserID` owns every
> machine in the netmap. A key cannot apply a tag the policy file has not defined, so the ACL needs a
> `tagOwners` entry before Settings → Keys can mint against it — and the key wants **ephemeral,
> pre-approved and single-use**, so the node deletes itself on disconnect and the credential cannot
> be replayed. Neither step is code, which is what makes this row wait on the owner rather than on
> the box. The alternative is disabling key expiry for
that one node in the admin console, which is an owner action rather than a code change and belongs in
the install document either way.

### 3.3 The appliance is a new ssh client, and this repo has only ever had one

This is the largest under-priced cost in the milestone. Every machine name in every workspace is an
**ssh destination, resolved by the local `~/.ssh/config`** and never by Yantra
([ADR-0009](../adr/0009-machine-names-are-ssh-destinations.md)). Move the daemon and every one of
those names has to mean the same thing on a machine that has never had a config file. Concretely, on
first boot the appliance has: no `~/.ssh/config`, no key any fleet machine has authorised, and an
empty `known_hosts` — Yantra's own, under its state directory, not the user's
([`ssh.rs`](../../crates/yantra-core/src/ssh.rs)).

- `StrictHostKeyChecking=accept-new` means first contact is trust-on-first-use and is fine, and a
  *changed* host key is a hard refusal with nobody there to answer it. That is the right direction
  and it is a support call.
- `BatchMode=yes` means no prompt and no passphrase: the key is unencrypted on disk, or there is an
  agent, and an agent is a login session the appliance does not have.
- **`ControlPath` is a 90-byte budget (I-28)** and comes from `machine_at`, which prefers
  `runtime_dir()` and falls back to `data_dir()`. Under a systemd **user** unit with lingering that is
  `/run/user/<uid>/yantra/cm/%C` — **27 bytes, 65** once `%C` expands to the 40 I-28 charges for it.
  A **system** unit has no `XDG_RUNTIME_DIR`, and **`RuntimeDirectory=` does not supply one**: it sets
  `$RUNTIME_DIRECTORY`, and `runtime_dir()` does not move. So the path is `data_dir()`'s —
  `/home/yantra/.local/share/yantra/cm/%C` under `User=yantra`, **38 bytes, 76** expanded. Both fit,
  so the budget did not decide the unit kind and the *ordering* did: a `--user` unit cannot express
  `After=tailscaled.service`, the user manager having no such unit. Measured under a real transient
  unit of each kind ([Y-142](../../tracker.md#3-task-board)); eleven bytes is the system unit's whole
  price, and the fourteen left over are a function of the account name rather than of anything Yantra
  picks.
- **`tailscale ssh` would remove the key-distribution problem entirely** and stays inside I-20 —
  it is still the system `ssh` binary, with `tailscaled` intercepting port 22. It is an option to
  weigh, not a decision this plan takes, and it is ACL work on the owner's side.

None of this changes I-44: an agent started over ssh on the Mac still cannot read the login keychain,
and the appliance does not make Y-122 better or worse.

### 3.4 The notification is the first byte Yantra sends off the tailnet

Everything until now stayed inside the mesh. ntfy does not.

**What ntfy is, checked against its own docs on 2026-08-05 rather than recalled.** Publishing is a
`POST` or `PUT` to `https://ntfy.sh/<topic>` with the message as the body and everything else in
headers — `Title`, `Priority`, `Tags`, `Click` (a URL the notification opens), `Actions`. On the
public server **the topic name is the password**: docs.ntfy.sh says so in those words, there is no
sign-up, and anyone who knows a topic can both read and publish to it. Protected topics take an
`Authorization` header — Basic, or an access token beginning `tk_`.

**Which makes the body a disclosure decision, not a formatting one.** R-22 names *machine names,
workspace names, repo paths* as the thing the bind address protects. A notification reading
`claude on bishwajeets-macbook-pro crashed` publishes two of those three to a third-party server, for
the convenience of not opening the dashboard. Three ways out, and the plan deliberately does not pick
— §6 asks it, because it is the owner's:

- accept it, with the body naming the workspace and nothing else;
- self-host `ntfy` on the appliance, which keeps the body on the tailnet — **and does not remove
  ntfy.sh from the path for an iPhone.** The same docs are explicit: iOS cannot have instant push
  without a central server, so a self-hosted instance sets `upstream-base-url: https://ntfy.sh` and
  forwards a *poll request* upstream, which relays through APNs. The message stays on the appliance
  and a content-free trigger leaves it. This fleet's phone is an iPhone, so this is the case, not an
  aside. **[D]** — read, not run; one subscription and one message settles it;
- send nothing but *something needs you*, and let the dashboard say what.

**The token is a reference and never a value** (§B4, Q5). Whatever authenticates comes from the
service unit's environment, exactly as `YANTRA_DAEMON` does for the agent (ADR-0013 §4) — not a
workspace field, not a file Yantra writes, not the API, and never a log line. A workspace TOML that
carried a topic would be Yantra storing a secret, and ADR-0007's `deny_unknown_fields` means it
cannot happen by accident.

### 3.5 Nothing in the daemon can make an outbound HTTPS request, and the cheap trick does not transfer

`axum` is a server. There is no HTTP client anywhere in the workspace, and the one place that needed
one — `yantra-agent` — hand-wrote eleven lines of HTTP/1.1 over `std::net::TcpStream` after measuring
the alternatives: `ureq` +57 % of the binary, `hyper` + `tokio` +87 %, `reqwest` unable to
cross-build to musl at all. **That trick does not transfer**, and the agent's own notes say why: *"if
this ever needs redirects, retries, keep-alive, compression or TLS, the decision is wrong and the
answer is `ureq`."* ntfy is TLS.

So M7 has one real dependency decision, and it is settled by measurement rather than by argument, the
way Y-128 and Y-140 settled theirs:

- **a client crate with rustls**, audited by `just deny` in the same PR and weighed on
  `just appliance-size` either side — against ADR-0004's *~5 MB static musl binary*, of which the
  embedded build already spends 3.1 MB;
- **shell out to `curl`**, which is §B2's own argument (the repo already spawns `ssh`, `tmux` and
  `tailscale`) and which trades a binary-size cost for a runtime dependency on the appliance image —
  a musl `yantrad` with no libc requirement that silently needs `curl` present is a worse promise
  than it looks;
- **do not send from the daemon at all**, and let the notification be `yantra notify` invoked by
  something else. This one is rejected in advance: *something else* is a cron job, and a cron job is
  a second control plane.

### 3.6 The notifier has no memory, and must not pretend otherwise

[`refresh.rs`](../../crates/yantrad/src/refresh.rs) already produces exactly what a notification
needs: four independent 30-second loops writing `Reading`s into one `Snapshot`, with the agents loop
calling `status::fleet`. A notifier is a diff of consecutive snapshots and nothing more — no new
poll, no new ssh, no timer.

`status::Verdict` is the vocabulary and it is already right, which is why this is small:
`AwaitingTrust` is the one that matters most (I-49 — the session is *inert* until a human answers,
and nothing else tells them), then `Running` → `Finished`, `Crashed`, `Killed`, `Unclear` or
`NoSession`. Never `NoAgent`, which is not a failure, and **never a telemetry threshold** —
ADR-0013's non-goals name this exact milestone: *"whatever M7 sends over ntfy is about sessions, not
about a CPU crossing a line."*

Two rules follow from the daemon persisting nothing, and both are the difference between a useful
notifier and one that gets muted in a week:

- **The first snapshot after a start notifies nothing.** There is no previous state to diff against,
  and a `None` treated as *everything just changed* means every reboot mails a report about every
  session on the fleet.
- **A failed send drops that notification.** No queue, no retry, no replay — the agent's `Log` is the
  precedent (first failure said out loud, the rest swallowed until one lands), and a queue is state
  on a box whose whole point is that it holds none.

### 3.7 One file to copy exists, and there is nowhere it is copied from

`just appliance-embedded` builds it. Nothing publishes it. Three facts that only matter together:

- **`just appliance`, `appliance-embedded` and `appliance-size` are `aarch64` only** — and M7's own
  definition says *Pi 5 / N100*, which is two architectures.
  [`release.yml`](../../.github/workflows/release.yml) does carry the other one, calling
  `x86_64-unknown-linux-musl` *"Linux dev boxes and the x86 mini-PC alternative to the Pi"*. So the
  gap is in the recipes, not in the pipeline. **Closed by [Y-145](../../tracker.md#3-task-board)** as
  a parameter rather than as a second set of recipes: every `appliance*` recipe takes a target and
  defaults to `aarch64`, so the mini-PC is one argument and Q15 is untouched.
- **The release build passes no `--features`**, so a published `yantrad` would carry no dashboard.
  The only build that embeds one is [`embed.yml`](../../.github/workflows/embed.yml), which is a
  check and uploads nothing.
- **Nothing has ever been published** (Y-037) and the workspace version is `0.0.0`. Publishing needs
  a tag and a version worth tagging, which is a decision above this milestone.

**So M7 installs by building and copying**, from the machine that already builds everything, and the
plan says so rather than leaving a row to discover it. The one non-obvious mechanic: a running binary
cannot be overwritten in place (`ETXTBSY`) — copy beside it and rename over it, then restart.

> **Measured by [Y-145](../../tracker.md#3-task-board) on 2026-08-06, and that last sentence is
> stronger than the kernel is.** `ETXTBSY` is what `cp` and `scp` get, because they open the
> destination `O_TRUNC`; `install(1)` and a `mv` from another filesystem unlink it first and
> **succeed** against a live process. What they are not is atomic — each leaves a window where the
> path is not a whole binary and `Restart=` can fire inside it — and that, rather than the errno, is
> why the replacement is a `rename(2)` and why the staged name has to be in the destination
> directory. See [`docs/appliance.md`](../appliance.md).

**This is not provisioning.** The permanent non-goal is that Yantra never creates, images or destroys
a machine; copying our own binary onto a box the owner already has is the same act as installing the
agent, which R-12 accepted as real, permanent scope. Worth stating because R-6's gravitational pull
is real and someone will cite it at the wrong target.

### 3.8 R-24 is mitigated, open, and this is the milestone that can retire it

R-24 was re-argued on 2026-08-05 and the amendment is precise about why it stays open: the retire
condition as written — `cargo build` green on a machine with no Node — **was already true before
Y-140**, which makes it the wrong test. *"What retires it is enforcement rather than observation: a CI
job on an image with no Node running `cargo build --workspace` and `cargo clippy --workspace
--all-targets`. GitHub's runner ships Node, so nothing in CI exercises the condition itself today."*

`just no-node` asserts the four ways it was most likely to arrive, structurally, by reading recipes
and workflows. What it cannot catch is a new crate whose `build.rs` shells out to npm, or an
unconditional `include_dir!` in Rust source — both of which are *behaviour*, and behaviour needs the
condition. Two shapes, and the row picks one on cost:

- **a job with node, npm and npx removed from `PATH`** (or shadowed by stubs that exit non-zero)
  before the two cargo commands — one step, minutes cheaper, and it catches anything that shells out
  by name;
- **the two commands inside a container with no Node**, which is the honest version of the sentence
  and pays a cold Rust build per run. The repo already builds a disposable podman image in CI, so the
  pattern is not new.

This row is not on the appliance's critical path and it is the only one in M7 that retires a risk
rather than carrying one.

### 3.9 M6 is still open, and the honest dependency runs the other way

M6 is `🟡 wip`: every layer is proved against something real and **nothing has yet carried a
session's bytes end to end**, which needs the fleet and a real browser and is the owner's to run.
M7's code does not depend on that run. **The order does.** The appliance changes which machine opens
the ssh connection, which `~/.ssh/config` resolves the destination, which `tmux` binary I-34 has to
find, and which architecture `portable-pty` runs on — so a terminal that has never worked end to end,
tried first from a Pi, has two candidate causes for every failure instead of one.

Two smaller consequences of the same move: the phone's installed PWA is bound to an **origin**, and
the appliance is a new one, so it is installed again; and `tailscale serve --bg` has to be set on the
appliance, where `just https` is written for a machine someone is logged into.

## 4. What this milestone does not settle

- **Wake-on-LAN.** Q10 answered *defer* on 2026-08-02 because the always-on L2 relay it needs did not
  exist — and an appliance is exactly that machine, so this is the milestone where the question could
  reopen. It should not: Q10's own note records that the pattern wakes powered-off machines but often
  **not S3 sleep**, which is precisely a closed laptop, so it is unproven rather than merely deferred.
  M10 owns placement and can ask for it then.
- **Persistence.** Y-044 stands. Nothing here asks a question about the past.
- **The hardware panel.** Display, encoder and LEDs are M8, and R6 already found that the kernel does
  the real-time part.
- **The appliance as a workspace target.** It is a control plane. Whether anything *runs* on it is a
  separate question and this milestone assumes not.
- **Publishing releases.** §3.7. Building and copying is what M7 does; a tagged release is Y-037's
  and needs a version worth tagging.
- **Windows.** Q4 is open by choice and the agent still refuses to compile there on purpose.

## 5. The tasks

| # | Task | Why it is where it is |
| --- | --- | --- |
| Y-142 | The service unit, and the boot race it is written for | 3.1 — `listen_on` fails closed, so the supervisor is the retry. Decides system unit against `--user` with lingering, on `XDG_RUNTIME_DIR` and I-28's path budget (3.3). Units for `yantrad` **and** `yantra-agent`, which is R-12's install story finally landing. **Not hardware-blocked**: this machine runs systemd. |
| Y-143 | What a tagged enrolment does to `allowed()` | 3.2 — a measurement, not a feature: one tagged node on this tailnet, and what `owner()` and `whois` then return. If the answer is *refuses everything*, the install document has an owner action in it, and M7 needs to know before the box arrives rather than after. **Not hardware-blocked.** |
| Y-144 | The appliance's ssh identity: a key, a config, and a `known_hosts` nobody typed | 3.3 — the largest under-priced cost. Provable today against the container fixture (§B3) from an identity that is not the developer's, and against a real fleet machine from a second account. `tailscale ssh` is weighed here or nowhere. **Partly hardware-blocked**: the shape is testable, the appliance's own config is not. |
| Y-145 | Install and update: one recipe, one document, and a rename rather than a copy | 3.7 — `ETXTBSY`, where the workspace TOMLs come from, and the x86_64 recipes M7's own definition implies. Depends on **Y-142**, because installing a unit is most of installing. |
| Y-146 | The notifier: a diff of two snapshots, and a send that may not queue | 3.6 — no new poll, no new ssh, `Verdict` as the vocabulary, and the first snapshot after a start says nothing. Carries 3.5's dependency decision with `just deny` and `just appliance-size` either side. **Not hardware-blocked.** |
| Y-147 | The ntfy configuration, and `yantra notify` as the only way to diagnose a headless box | 3.4 — the token arrives from the unit's environment and is never stored, logged or served. The CLI verb is the honesty check ([`yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md)) and, more usefully, the one command that proves topic, token and egress from a box with no screen. Depends on **Y-146**. |
| Y-148 | R-24 retired by enforcement, or written down as unretirable | 3.8 — the risk this milestone owns. **Not hardware-blocked**, and independent of everything else here. |
| Y-149 | RSS, idle CPU and CLI cold-start — the numbers ADR-0004 promised, beside the size `appliance-size` already reports | §1 — that recipe reports size alone while its own comment says M7 reports startup too, and [`docs/development.md`](../development.md) still says *~330 KB per binary* against a `yantrad` Y-140 measured at 2,331,872. x86_64-musl on this machine is a floor and an N100 proxy, not the answer. **Partly hardware-blocked**: the harness and the floor are today's, the target's numbers are the target's. |
| Y-150 | The appliance runs 24/7 and survives a power cycle | The milestone. **Hardware-blocked entirely** — enrol, install, pull the plug, and watch the dashboard come back and the phone buzz. It also executes **I-9**'s desktop half for the first time: every machine this fleet has ever had is a laptop with a battery, which is why the invariant's founding case has been `[D]` since Y-106. Depends on everything above. |

**Y-142, Y-143, Y-146, Y-147 and Y-148 depend on no hardware and are the bulk of the milestone.**
Y-144, Y-145 and Y-149 are each half-buildable now and finish on the box. Y-150 is the demo, and it
is a purchase before it is a task — which is the whole reason the order is this way round, and the
reason none of the others is written as *when the Pi arrives*.

**Nothing here depends on M6 closing.** The order does (3.9): the browser terminal wants its first
end-to-end run from the machine it was built on, not from a new one.

## 6. The open questions this raises

Numbered as [`tracker.md`](../../tracker.md) §6 numbers them, continuing from Q14. **All five are the
owner's**, and the first three gate rows rather than merely inform them.

| # | Question | Blocks |
| --- | --- | --- |
| Q15 | **Which box, and does it change the target?** *Pi 5 / N100* names two architectures and `just appliance*` builds only `aarch64`. An N100 is x86_64, is faster, takes NVMe rather than an SD card (R6: *"SD cards, not SQLite, are the durability risk"*) and costs more idle power; a Pi 5 is the board M8's device-tree overlays are written for, and M8 follows this milestone. **Prior: the Pi 5, because M8 is that board's work and two boxes is one too many.** | Y-145, Y-149, Y-150 |
| Q16 | **How much may a notification say, given that ntfy.sh is a public relay whose topic is its only password?** Naming a workspace and a machine publishes the fleet's shape — R-22's own list — to a third party. Self-hosting keeps the body on the tailnet and still sends a content-free trigger through ntfy.sh for the iPhone (3.4). **Prior: name the workspace and the verdict, never the machine or the repo, and revisit if self-hosting proves cheap.** | Y-146, Y-147 |
| Q17 | **Is the appliance enrolled tagged or untagged?** Tagged is the standard headless answer and may make the daemon refuse every write (3.2); untagged means a key that expires and a human who has to notice. Disabling key expiry for one node is the third answer, and it is an admin-console action rather than a code change. | Y-143, Y-150 |
| Q18 | **Does the appliance keep its own `~/.ssh/config`, or does the fleet move to `tailscale ssh`?** The first is a file to maintain twice; the second removes key distribution, stays inside I-20, and is ACL work — and it cannot cover Windows (R-7), which Q4 has left open anyway. | Y-144 |
| Q19 | **Does the container fixture extend to a systemd unit at all?** §B3 says verification is a real thing in a disposable podman container, and this repo's fixture runs a real sshd and a real tmux. A real `systemd` in a container is a different proposition: it can show that a unit parses, starts, restarts and is enabled, and it cannot show a boot ordering against a real `tailscaled`. **If the answer is no, the honest fallback is a `--user` unit on this machine and a `[D]` that stands until the box exists** — a worse test and a better admission than a passing one that proves nothing. | Y-142 |

## 7. Not in scope

- **A configuration file, a `--bind` flag or a `--port` flag.** The appliance is exactly the machine
  someone would add them for, and [`yantrad/CLAUDE.md`](../../crates/yantrad/CLAUDE.md) refuses in
  advance: a flag that can expose the API is a flag someone eventually passes.
- **Metrics, thresholds, graphs or an alert-rule language.** ADR-0013's non-goals, and 3.6.
- **A second machine's worth of high availability.** One appliance, one owner, one fleet (Q6).
- **Any notification that is not about a session** — including *the appliance rebooted*. The
  supervisor already logs that, and a control plane that reports on itself is the first step toward
  the monitoring product this is not.
- **Provisioning, imaging or remote OS management.** Permanent non-goal, and 3.7 says why installing
  a binary is not it.

---

**These rows are proposed, not opened.** §B0 says work is represented in `tracker.md` before it is
built, and this plan is the representation an owner needs to open Y-142…Y-150 with that satisfied —
the numbering continues from Y-141, and nothing here has been written into §3. The same goes for
Q15…Q19: §6 is the owner's section, and a question this plan asks itself is not one the project has
asked.
