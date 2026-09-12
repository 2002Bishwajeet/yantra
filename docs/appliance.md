# Installing the appliance

How Yantra gets onto the always-on box and how it is updated afterwards. For local setup see
[`development.md`](development.md); for what the appliance milestone is, see
[`plans/m7-appliance.md`](plans/m7-appliance.md).

**[v0.2.0](https://github.com/2002Bishwajeet/yantra/releases/tag/v0.2.0) is the current release**
([Y-364](../tracker.md)), and there are two ways in. [`install.sh`](../install.sh) fetches the
current release onto the box itself, verifies it, and at a terminal takes the box from bare to an
open dashboard ([Y-384](../tracker.md)). `just appliance-install` builds on the machine that
already builds everything and copies over ssh. Both put the same three binaries and the same two
units in the same places. One fact about the artifact matters to the first: **the released
`yantrad` is built with `embed-dashboard`**, so a fetched binary serves the dashboard with no
`YANTRA_WEB` and no `web/dist` beside it.

## Which architecture

**[Q15](../tracker.md#6-open-questions) is answered — the Pi 5, 2 GB** (2026-08-09), which is what
`aarch64-unknown-linux-musl` already was. The recipes still take a target, so an x86_64 box is one
argument rather than a second set of recipes:

```bash
just appliance                                   # arm64: a Pi 5
just appliance x86_64-unknown-linux-musl         # x86_64: an N100 mini-PC
```

`appliance-embedded`, `appliance-size` and `appliance-install` take the same argument. A target other
than the default needs `rustup target add <target>` once.

## Install from a release

One command, on the box, as the account you log in with — **not** as root. The script calls `sudo`
for the steps that need it.

```bash
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | bash
```

Read it first if you would rather — it is one file:

```bash
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh -o install.sh
less install.sh
bash install.sh
```

**Take it from `main`.** A copy from the v0.2.0 tag is the script before Y-384: it asks nothing and
starts nothing. [Y-159](../tracker.md) gives the script a name that resolves off the tailnet; until
then the URL is GitHub's.

**Every device you use with Yantra must be on one tailnet**, logged in with the same Tailscale
account. The script says so first, because the dashboard cannot exist before the box is on it:
`yantrad` refuses to start until it can ask `tailscaled` which addresses this machine holds
([`crates/yantrad/CLAUDE.md`](../crates/yantrad/CLAUDE.md)).

### What it does at a terminal

`curl | bash` makes stdin the script, so the script reads its answers from `/dev/tty`.

1. It says what it will do, and that every device must be on one tailnet.
2. It resolves the current release from
   `api.github.com/repos/2002Bishwajeet/yantra/releases/latest`, fetches the `aarch64` or `x86_64`
   musl archive and `SHA256SUMS`, and checks one against the other. **A mismatch stops the run
   before anything is installed** — Tailscale included.
3. **If Tailscale is not installed**, it asks *"Install Tailscale, log this box in and turn on
   HTTPS? [Y/n]"*. A yes runs Tailscale's own installer,
   `curl -fsSL https://tailscale.com/install.sh | sh`.
4. **If the box is not logged in**, it runs `sudo tailscale up`. That prints a URL: open it on any
   device and log in with the account the other devices use. The box joins **untagged**, which
   superseded [Q17](../tracker.md#6-open-questions). **Turn off key expiry for this box once**, or
   it leaves the tailnet when its key expires: admin console → Machines → the box's menu → *Disable
   key expiry*.
5. It turns on HTTPS: `sudo tailscale serve --bg --https=8443 http://<tailnet address>:7717`, the
   same command as `just https`. **Before it asks, it says that the machine's name goes into a public
   certificate log** that anyone can read ([Tailscale KB 1153](https://tailscale.com/kb/1153/enabling-https)).
   On a tailnet that never had HTTPS, `tailscale serve` prints one link to turn it on; open it.
6. It installs Yantra: the `yantra` account if it is absent, the three binaries renamed into
   `/usr/local/bin` for the reason [below](#why-the-rename), both units from the archive, and a
   `systemctl daemon-reload`.
7. It writes `/etc/yantra/agent.env` **only if it is absent**, with this box's own
   `YANTRA_DAEMON=<tailnet address>:7717`. It writes `/etc/yantra/daemon.env` **only if it is
   absent** — `0600`, owned by `yantra`, and with no relay in it
   ([ADR-0021](adr/0021-the-relay-is-written-to-an-environment-file.md)).
8. It runs `systemctl enable --now` for both units and waits up to 30 s for `yantrad` to answer
   `/healthz`.
9. It ends on one line: the dashboard's URL — `https://<machine>.<tailnet>.ts.net:8443`, or
   `http://<tailnet address>:7717` if HTTPS is not on.

A **no** at step 3 installs Yantra and nothing else, and the run ends the way a run with no terminal
does.

**Everything after that is the dashboard's walkthrough** — the other machines, the appliance's ssh
key, the AI agents and GitHub ([walk-through](plans/m15-qa-walkthrough.md) §1.5). The script does
not install `gh`, and `provision.sh` is gone: its fleet half belongs to the dashboard.

### Run it again to update

**A second run is the updater.** It asks nothing it already has an answer to and touches no
configuration ([D2](design/02-setup.md) §1): an existing `agent.env` or `daemon.env` stays as it
is, and it does not run `tailscale up` or `tailscale serve` again. It replaces the binaries and the
units, and it ends on the same URL.

**It does not restart what is running.** Applying an update is [Y-368](../tracker.md)'s. Until
then the script says so and names the command:

```bash
sudo systemctl restart yantrad.service yantra-agent.service
```

`YANTRA_VERSION=0.2.0 bash install.sh` installs a named release instead of the current one.

### With no terminal

A run with nothing at `/dev/tty` — a container, a CI job, an `ssh host 'curl … | bash'` without
`-t` — asks nothing and starts nothing. It installs the release, writes both environment files if
they are absent (`agent.env` with a placeholder rather than an address), enables neither unit, and
ends with a numbered list of what is left. That is the path
[`crates/yantrad/tests/installer.rs`](../crates/yantrad/tests/installer.rs) runs twice against a
real systemd ([Y-158](../tracker.md#3-task-board)).

### What the tests prove, and what they cannot

`installer.rs` runs the script against a real systemd as PID 1 in a podman container, with a release
served from inside it. **With no terminal**: an edited `agent.env` and an edited `daemon.env`
survive a second run, `daemon.env` is `600 yantra`, the binaries replace while one of them is
executing, and a corrupted archive installs nothing. **At a terminal**, through a pty: a yes logs
in, turns on `serve`, writes the address into an absent `agent.env`, enables both units and ends on
the URL; a second run asks nothing and changes no file; a no installs Yantra and starts nothing.

**The terminal tests talk to a stub `tailscale`** that records its calls. A login, a tailnet address
and a certificate are what no container can hold, so the tests prove which commands the script ran,
not that Tailscale did what they ask. Tailscale's installer, a real `tailscale up` and the HTTPS
link are proved only on real hardware.

### What resolving the version gives up

**It is written in the script.** The version and the commit it replaced were a person's choice in a
reviewed commit; `SHA256SUMS` still proves the archive arrived intact from the release it names, and
nothing proves that release is the one the owner meant
([ADR-0027](adr/0027-the-appliance-pulls-its-own-update.md) §4). `/releases/latest` skips drafts and
pre-releases, so a `v0.3.0-rc.1` tag never installs itself. A call GitHub refuses — `403`, since 60
an hour per IP is what an unauthenticated one gets — stops the run and says so.

### Where the units come from

**From the archive, since [Y-365](../tracker.md).** The Linux archives hold the three binaries, a
README, a LICENSE and both units — [`release.yml`](../.github/workflows/release.yml) stages them
beside the binaries they start, so `SHA256SUMS` covers the two files that decide what runs as root.
The macOS archives carry none: they ship `yantra-agent` alone and no systemd reads a unit there.

Before that the script fetched them from `raw.githubusercontent.com` at a `COMMIT` pinned beside
`VERSION`. It pinned them honestly — a tag is a mutable ref, and v0.1.0's was deleted and re-cut the
day it was published — but **those two files were outside `SHA256SUMS`**, which lists archives and
nothing else, and the pin was a constant somebody had to bump with every release.

The cost is that **an archive published before this carries no units**, which is every release up to
v0.1.0. The script says so and installs nothing rather than failing on a missing file, and
[`installer.rs`](../crates/yantrad/tests/installer.rs) holds it to that.

## Install from a checkout, and update

`just appliance-install` is the path for a box you build for from source. It copies binaries and
units, and it creates no accounts, writes no configuration and enrols nothing — so the box needs
these first:

- **Tailscale**, up and logged in, for the reason above.
- **The `yantra` account** the units name, with a home directory — its `~/.config` is where the
  workspace files go and its `~/.local/share` is where the ssh `ControlPath` lands:

  ```bash
  sudo useradd --system --create-home --home-dir /home/yantra --shell /usr/sbin/nologin yantra
  ```

- **An ssh account for the install itself** that can `sudo`, and a key you hold. The recipe runs
  `ssh <host>` and `scp`, so `<host>` is an `~/.ssh/config` entry like every other machine name
  ([ADR-0009](adr/0009-machine-names-are-ssh-destinations.md)).
- **`/etc/yantra/agent.env`**, the agent's whole configuration — an address, never a MagicDNS name
  ([ADR-0013](adr/0013-the-heartbeat-carries-only-what-placement-scores.md) §4):

  ```bash
  sudo install -d /etc/yantra
  printf 'YANTRA_DAEMON=100.x.x.x:7717\n' | sudo tee /etc/yantra/agent.env
  ```

  **The recipe never touches this file**, for the same reason the updater leaves it alone.

Build, then copy. The order matters: `just appliance` builds a `yantrad` with **no** dashboard in it,
so the embedded one is built last or it is the one that gets overwritten.

```bash
just appliance                     # all three binaries
just appliance-embedded            # yantrad again, with the dashboard inside it
just appliance-install <host>      # copy binaries + units, reload, restart what was running
```

Pass the target to all three if it is not the default. The recipe refuses rather than copying a
stale binary if `target/<target>/release` does not hold all three.

What it does on the far side, all under one `sudo`:

1. stages the three binaries and both units in `/tmp/yantra-install`;
2. for each binary, `install`s it into `/usr/local/bin/<name>.new` and **renames** it over the live
   one;
3. copies both units into `/etc/systemd/system/`, removes the staging directory, and reloads systemd;
4. `systemctl try-restart yantrad.service yantra-agent.service`.

**`try-restart`, not `restart`**: an update restarts what was running, and a first install leaves the
units alone until the box has everything above. Enable them once, by hand, and turn on HTTPS on the
box the way the script does:

```bash
ssh <host> 'sudo systemctl enable --now yantrad.service yantra-agent.service'
ssh <host> 'sudo tailscale serve --bg --https=8443 "http://$(tailscale ip -4):7717"'
ssh <host> 'journalctl -u yantrad -f'
```

## The appliance's ssh identity

The ssh identity the appliance uses to reach the fleet — a key, a config and a `known_hosts` nobody
typed. Without it the daemon starts and every verb that reaches a machine fails. Today one verb
prepares the first two, for the account the units run as
([Y-144](../tracker.md#3-task-board)); [Y-387](../tracker.md#3-task-board) moves this into the
dashboard's join command:

```bash
sudo -u yantra -H yantra ssh-identity
```

It generates `~/.ssh/id_yantra` if that account has no key, adds a `Host` block binding it for every
machine a workspace names, and prints the public key. **`-H` matters**: without it `sudo` may leave
`HOME` as yours and the verb prepares the wrong account's `~/.ssh`. It is idempotent — an existing
key is kept, because regenerating it orphans every `authorized_keys` entry it is in, and a machine
the config already names is left exactly as it is.

**Two halves stay yours.** Placing that public key in each machine's `authorized_keys`, and the
`User`, `HostName`, `Port` or `ProxyJump` that say where a name points — Yantra never resolves a
name ([ADR-0009](adr/0009-machine-names-are-ssh-destinations.md)) and cannot know the account on the
far side.

**The key has no passphrase.** `BatchMode=yes` has nowhere to type one, and the alternative is an
ssh agent — a login session a box nobody logs into does not have. It is readable by the `yantra`
account and that account alone, and anyone who can read it can reach every machine that authorised
it.

**`known_hosts` needs nothing.** Yantra keeps its own beside its control sockets and connects with
`StrictHostKeyChecking=accept-new`, so first contact records the host key with nobody there to
answer a prompt. A machine whose host key later *changes* is then a hard refusal — deliberately, and
it is a support call rather than something to configure away.

### The workspace files

The daemon's durable state is three files and only one of them is Yantra's: the workspace TOMLs, an
ssh key, and `tailscaled`'s node key. Workspaces live in the **`yantra` account's** config directory.
Create them from the dashboard; to copy ones declared elsewhere:

```bash
scp ~/.config/yantra/workspaces/*.toml <host>:/tmp/
ssh <host> 'sudo install -d -o yantra -g yantra /home/yantra/.config/yantra/workspaces \
    && sudo install -o yantra -g yantra -m 644 /tmp/*.toml /home/yantra/.config/yantra/workspaces/'
```

They name machines as **ssh destinations**, resolved by the appliance's own `~/.ssh/config` and never
by Yantra, so a name that works on your laptop means nothing on the box until `yantra ssh-identity`
has written its half of that file and you have finished it. `yantra new` on the appliance writes into
the same directory — under whichever account runs it, which is why the daemon's account is the one
that matters.

## Why the rename

**A binary that is currently being executed cannot be opened for writing** — the kernel answers
`ETXTBSY`, *Text file busy*. That is exactly what `scp` onto `/usr/local/bin/yantrad` does, and
measured against a running `yantra-agent` in a container so does `cp`:

```
cp: cannot create regular file '/usr/local/bin/yantra-agent': Text file busy
```

So the new binary is written under a different name and `mv`'d over the old one. `rename(2)` replaces
the directory entry and leaves the old inode alone, so the running process keeps executing the file
it started with — `/proc/<pid>/exe` reads `… (deleted)` — until the supervisor restarts it onto the
new one.

Two things about that are easy to get wrong:

- **The staging name must be in the destination directory.** `rename(2)` cannot cross a filesystem,
  and `mv` from `/tmp` — commonly a tmpfs — silently falls back to copying instead. Measured by
  inode: within one directory the staged inode is the one that lands; across filesystems it is not.
- **`install(1)` and a cross-filesystem `mv` do not fail here**, which is why "a running binary
  cannot be overwritten" is too strong a sentence to plan from. Both unlink the destination first, so
  neither hits `ETXTBSY` — and neither is atomic. There is a window in which the path holds no whole
  binary, and `Restart=on-failure` can fire inside it. `rename(2)` has no such window.

## What this is not

Not provisioning. Yantra never creates, images or destroys a machine — copying our own binary onto a
box the owner already has is the same act as installing the agent, which R-12 accepted as permanent
scope.

The ntfy relay is written by `/settings` or by `sudo yantra relay <url> [--token T]` into
`/etc/yantra/daemon.env`, which the unit reads with `EnvironmentFile=`
([ADR-0021](adr/0021-the-relay-is-written-to-an-environment-file.md)). The installer creates that
file empty, `0600` and owned by `yantra`; **leave the owner alone** — the daemon rewrites the file
in place, so one created by hand as root leaves `/settings` refusing with a 500. `yantrad` reads it
when systemd starts the unit, so a relay set from the browser needs
`sudo systemctl restart yantrad` ([`development.md`](development.md)).
