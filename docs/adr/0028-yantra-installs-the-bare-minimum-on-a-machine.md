# ADR-0028 — Yantra installs the bare minimum on a machine, when a person asks

- **Date:** 2026-09-11
- **Status:** Accepted 2026-09-12. The owner ruled the direction, the three scope answers and the
  two questions left open ([Y-385](../../tracker.md)). [Y-386](../../tracker.md) builds it.
- **Amends** the fleet clause of
  [ADR-0013](0013-the-heartbeat-carries-only-what-placement-scores.md) and §7 of
  [ADR-0027](0027-the-appliance-pulls-its-own-update.md), each by a dated blockquote.
- **Reads against** [ADR-0006](0006-ssh-exec-transport.md) for how a command reaches a machine,
  [ADR-0016](0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md) for who may ask,
  [ADR-0019](0019-a-probe-that-asks-a-machine-is-a-post.md) for the test a person-initiated call
  must pass, and [ADR-0025](0025-the-daemon-remembers-what-it-pushed.md) for where a result is kept.

## Context

The owner, 2026-09-11, during the QA walk-through
([stage 1](../plans/m15-qa-walkthrough.md)): *"i think we need yantra to install agents on other
machines. otherwise its too tiresome."* Then the scope: *"whatever bare minimum stuff is needed for
yantra to work, we install that"*, *"install only, updates can happen in future"*, and *"run in
background"*.

Two accepted ADRs say the opposite. ADR-0027 §7:

> **Yantra still ships no software to the fleet.** No binary, no unit, no script and no update
> instruction crosses ssh to any machine.

ADR-0013's non-goals: *"a control plane that can push a binary to five machines is the
fleet-management product this project exists not to be (R-12)."*

**What changed is upstream of that reasoning.** When those were written, no person had taken a bare
machine to a working one. The manual path was a design, and its cost was a guess. The walk-through
counted it: for each machine, a separate command for every missing piece, typed on that machine. The
owner judged that cost too high. R-12's worry is still right — a Yantra that manages software across
a fleet is a different product — and that is why the scope below is narrow and has no update in it.

## Decision

**When a person asks, Yantra installs the bare minimum a machine needs to run a session. It installs
nothing else, it never updates, and it runs in the background.**

### 1. What is installed

**`tmux`, `git` and one agent CLI (`claude`).** Without `tmux` or `claude` no session can start on
that machine, and without `git` no repository can be cloned there. **`doctor` gains a `git` check**,
so the dashboard can say it is missing before anyone presses Install. The
list is a constant in `yantra-core`, and adding an entry is a reviewed code change.

**Not installed:**

- **`yantra-agent`.** A machine runs sessions without it, so it is not the minimum. It is also
  Yantra's own binary, which is exactly what R-12 is about. It stays a manual install.
- **`gh`.** The dashboard's GitHub is its own grant
  ([ADR-0023](0023-the-github-grant-lives-beside-the-relay.md)).
- **Anything that is a login.** `claude` sign-in, `gh auth login` and the macOS login session stay
  the person's. §B4 is unchanged.

### 2. Install only

No update, no *upgrade* button, and no record of which version a machine runs. A later ADR can add
updates. This one does not.

### 3. A person asks, one machine at a time

**One press on one machine installs whatever of §1 is missing there.** There is no button for the
whole fleet, and nothing installs from a sweep, a schedule or a heartbeat. That is ADR-0019's test:
a person initiated it, and nothing polls it.

**Optional tools come later, chosen by checkbox** (owner, 2026-09-12). This ADR installs the minimum
and offers no choice. A list of optional items is a later decision that extends §1.

**The CLI verb comes first:** `yantra install <machine>`. The daemon's route is a copy of the verb,
as every write in `yantrad` is. `yantra doctor` stays a read (D2 §3.2).

### 4. It runs in the background

`POST /api/machines/{machine}/install` answers `202`. The daemon runs the installer in a task it
owns, the same shape as the GitHub device flow. The result is an event in the notifications ring
(ADR-0025), followed by a readiness re-check. **It is not a tmux session**, because `tmux` can be the
thing being installed. The command goes over ADR-0006's exec path, inside the base64 envelope, like
every other command.

### 5. The vendor's command, and root only without a password

- **`claude`:** `curl -fsSL https://claude.ai/install.sh | bash`. It writes to `~/.local/bin` and
  needs no root. That directory is already the first entry in `agent::CANDIDATES` (I-34).
- **`tmux` and `git`:** the machine's own package manager, which the far side detects (`apt-get`, `dnf`,
  `pacman`, `apk`, `zypper`, `brew`).
- **Root is `sudo -n` and nothing more.** If sudo needs a password, the install stops. The dashboard
  then says so and gives the one command to run on that machine. **No password is ever asked for,
  passed or stored.**
- **macOS with no Homebrew** gets neither `tmux` nor `git`. Apple's `git` comes with the Command
  Line Tools, whose installer is a dialog on the Mac's own screen, so the dashboard names that step
  rather than starting it.

### 6. What stays closed

- No Yantra binary crosses ssh, and that includes `yantra-agent`.
- No update, and no inventory of versions.
- The heartbeat's reply is still `204` and carries no instruction.
- `yantra-agent` stays heartbeat-only (R-12's mitigation).

## Consequences

- **The daemon runs code it did not write on the owner's machines**: a vendor's install script,
  fetched when it runs. The trust is the same one the owner gives it when they run it by hand. The
  difference is that nobody watches it run.
- **A failure is only as visible as its event.** The output is capped and kept in the in-memory ring,
  so a restart forgets it.
- **An install can take minutes.** The task has a timeout, and one install per machine may run at a
  time.
- **Many Linux machines will stop at `tmux` or `git`,** because their sudo needs a password. That is still one
  shell drop per machine. The QA pass §12 counts it.
- **A machine Yantra cannot reach over ssh gets nothing.** Placing the key is still the person's
  first step on each machine ([stage 3](../plans/m15-qa-walkthrough.md)).
- **R-12 is weaker as an identity and unchanged as an agent.** Yantra now installs software on the
  fleet. It stays small because the list has three entries and there is no update.

## Answered at acceptance

- **`git` is part of the minimum** (owner, 2026-09-12). §1 and §5 carry it.
- **One press installs every missing basic on that machine** (owner, 2026-09-12). §3 carries it.
