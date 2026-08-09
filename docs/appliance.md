# Installing the appliance

How Yantra gets onto the always-on box and how it is updated afterwards. For local setup see
[`development.md`](development.md); for what the appliance milestone is, see
[`plans/m7-appliance.md`](plans/m7-appliance.md).

**v0.1.0 is published** ([Y-156](../tracker.md), 2026-08-09) and there are two ways in.
[`install.sh`](../install.sh) fetches that release onto the box itself and verifies it before it
installs anything ([Y-157](../tracker.md)); `just appliance-install` builds on the machine that
already builds everything and copies over ssh, and is also the update. Both put the same three
binaries and the same two units in the same places. One fact about the artifact matters to the
first: **the released `yantrad` is built with `embed-dashboard`**, so a fetched binary serves the
dashboard with no `YANTRA_WEB` and no `web/dist` beside it.

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

## What the box needs before the first install

The recipe copies binaries and units. It creates no accounts, writes no configuration and enrols
nothing — everything below is a one-time action on the box itself. [`install.sh`](../install.sh)
creates the account and scaffolds an addressless `agent.env`; it enrols nothing either.

- **Tailscale**, up and logged in. `yantrad` refuses to start until it can ask `tailscaled` which
  addresses this machine holds, deliberately ([`crates/yantrad/CLAUDE.md`](../crates/yantrad/CLAUDE.md)).
  Whether the node is enrolled tagged or untagged is **[Q17](../tracker.md#6-open-questions)**, and a
  tagged one may refuse every write from the dashboard ([the M7 plan](plans/m7-appliance.md) §3.2).
- **The `yantra` account** the units name, with a home directory — its `~/.config` is where the
  workspace files go and its `~/.local/share` is where the ssh `ControlPath` lands:

  ```bash
  sudo useradd --system --create-home --home-dir /home/yantra --shell /usr/sbin/nologin yantra
  ```

- **An ssh account for the install itself** that can `sudo`, and a key you hold. The recipe runs
  `ssh <host>` and `scp`, so `<host>` is an `~/.ssh/config` entry like every other machine name
  ([ADR-0009](adr/0009-machine-names-are-ssh-destinations.md)).
- **`/etc/yantra/agent.env`**, which is the agent's whole configuration and is not this repo's to
  write — an address, never a MagicDNS name
  ([ADR-0013](adr/0013-the-heartbeat-carries-only-what-placement-scores.md) §4):

  ```bash
  sudo install -d /etc/yantra
  printf 'YANTRA_DAEMON=100.x.x.x:7717\n' | sudo tee /etc/yantra/agent.env
  ```

  **The install deliberately never touches this file.** It holds the address of the daemon *this*
  box reports to, and an install that rewrote it would be a newer unit overwriting a machine's
  configuration, which is the thing ADR-0013 §4 keeps out of the unit in the first place.

- **The ssh identity the appliance itself uses** to reach the fleet — a key, a config and a
  `known_hosts` nobody typed. That is **[Y-144](../tracker.md#3-task-board)**'s and is not covered
  here; without it the daemon starts and every verb that reaches a machine fails.

### The workspace files

The daemon's durable state is three files and only one of them is Yantra's: the workspace TOMLs, an
ssh key, and `tailscaled`'s node key. Workspaces live in the **`yantra` account's** config directory,
so they are copied from wherever they are declared today:

```bash
scp ~/.config/yantra/workspaces/*.toml <host>:/tmp/
ssh <host> 'sudo install -d -o yantra -g yantra /home/yantra/.config/yantra/workspaces \
    && sudo install -o yantra -g yantra -m 644 /tmp/*.toml /home/yantra/.config/yantra/workspaces/'
```

They name machines as **ssh destinations**, resolved by the appliance's own `~/.ssh/config` and never
by Yantra, so a name that works on your laptop means nothing on the box until Y-144's config is
there. `yantra new` on the appliance writes into the same directory — under whichever account runs
it, which is why the daemon's account is the one that matters.

## Install from a release

[`install.sh`](../install.sh) is this same install done on the box itself, from a published release
rather than from a checkout — no toolchain, no zig, no cross build, and nothing that needs the
developer's machine. It is **pinned to a version**: a release is a fixed set of checksummed archives,
and a `latest` that moved would make one command install different bytes on different days.

Until [Y-159](../tracker.md) serves it from a name that resolves off the tailnet, it is fetched from
the tag it installs:

```bash
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/v0.1.0/install.sh | bash
```

Read it before running it if you would rather — it is one file, and it is the same file:

```bash
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/v0.1.0/install.sh -o install.sh
less install.sh
bash install.sh
```

Run it as the account you ssh in as, **not** as root: it calls `sudo` for the steps that need one,
exactly as `just appliance-install` does. It asks nothing — piping a script to a shell makes stdin
the script, so a prompt would have nowhere to read from. `YANTRA_VERSION=0.2.0 bash install.sh`
installs a different release.

What it does:

1. reads `uname -m` and picks the `aarch64` or `x86_64` musl archive — there is no other Linux build;
2. fetches that archive and `SHA256SUMS`, and checks one against the other. **A mismatch stops the
   run before anything is installed**: what produces one is a corrupted download or a substituted
   archive, and neither is repaired by fetching again;
3. fetches both units from the same tag — see below;
4. creates the `yantra` account if it is absent;
5. renames each binary into `/usr/local/bin`, for the reason [below](#why-the-rename);
6. installs both units and reloads systemd, **enabling neither**;
7. writes `/etc/yantra/agent.env` **only if it is absent**, and with no address in it;
8. reports whether Tailscale is installed and up, and **never enrols it** — the auth key is the
   owner's ([`CLAUDE.md`](../CLAUDE.md) §B4) and [Q17](../tracker.md#6-open-questions) is not a
   script's to answer.

**Steps 2 and 5–7 are the ones a second run has to get right, and
[`crates/yantrad/tests/installer.rs`](../crates/yantrad/tests/installer.rs) runs it twice against a
real systemd to say that it does** ([Y-158](../tracker.md#3-task-board)): an edited `agent.env`
survives, the binaries replace while one of them is executing, and a corrupted archive installs
nothing.

It ends by printing what is left, which is each thing above it deliberately did not do, plus
[Y-144](../tracker.md#3-task-board): the box has no ssh identity any fleet machine authorises, so the
daemon starts and every verb that reaches another machine fails.

### Then provision it

[`provision.sh`](../provision.sh) is the other half ([Y-160](../tracker.md#3-task-board),
[D2](design/02-setup.md) §4): it does what it can of that list and turns everything else into a
numbered step with the command that ends it. Run it the same way, after `install.sh`:

```bash
bash provision.sh
```

It is **beside** `install.sh` rather than inside it because [Y-158](../tracker.md#3-task-board)
proves that script against a real systemd in a container, and enrolling a tailnet, logging into `gh`
and generating a keypair are not things a container can prove.

What it does for you, and nothing else: **enables and starts each unit** whose precondition holds —
`yantrad` once Tailscale is up, `yantra-agent` once `/etc/yantra/agent.env` names an address — and
**runs `yantra fix-terminfo <machine>`** for a machine that does not know this terminal, which writes
to a `~/.terminfo` and wants no root.

Everything else it names rather than does, each with its command: enrolling Tailscale (the auth key
is the owner's, and [Q17](../tracker.md#6-open-questions)'s answer is conditional on
[Y-143](../tracker.md#3-task-board)), the daemon's address
([ADR-0013](adr/0013-the-heartbeat-carries-only-what-placement-scores.md) §4), generating the ssh
identity ([Y-144](../tracker.md#3-task-board)), `gh auth login`, installing tmux or `claude` on a
fleet machine, and creating the first workspace. **No credential is read, echoed or stored** — §B4
is why the Tailscale line is `sudo tailscale up` and not an `--authkey` to paste.

It reads the fleet through `yantra doctor --json`, asked **as the `yantra` account** the units run
as, since that account's workspaces and ssh identity are the ones the daemon has. A check that
answered `unknown` gets its reason and no instruction rather than being folded into the numbered
list — the two send a reader to different places (R-23). `heartbeat` is the one check that is always
unknown from here: the beats live in the running daemon's memory, and the dashboard's readiness card
is what answers it. It exits 0 only when nothing is left, so an installer or an agent can loop on it.

### Where the units come from

The archives hold the three binaries, a README and a LICENSE, and **no units** — so the script
fetches `yantrad.service` and `yantra-agent.service` from `raw.githubusercontent.com`. A unit taken
from `main` beside a binary built at a tag is drift in the one file that decides how the binary
starts, so both come from the release's own commit.

**From the commit, not from `refs/tags/v$VERSION`.** A tag is a mutable ref — v0.1.0's was deleted
and re-cut the day it was published — so a tag pins nothing, and these two files decide what runs as
root. `COMMIT` sits beside `VERSION` in the script and is bumped with it. That is
[`just pinned`](../justfile)'s own rule, which fails CI for a GitHub action naming a tag, applied to
the one other place this repo fetches executable configuration over the network.

The cost, stated because it is real: two more fetches, a second host, a second constant to bump, and
**those two files are not covered by `SHA256SUMS`**, which lists archives and nothing else — the
commit is the whole of what pins them. The alternative is adding the units to the archives in
[`release.yml`](../.github/workflows/release.yml), which is self-contained and checksummed — and
could not install v0.1.0, whose archives are published and do not contain them.

## Install, and update

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
units alone until the box has everything above. Enable them once, by hand:

```bash
ssh <host> 'sudo systemctl enable --now yantrad.service yantra-agent.service'
ssh <host> 'journalctl -u yantrad -f'
```

### Why the rename

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
scope. Not a release either: when there is a version worth tagging, Y-037 is where publishing gets
decided, and this document gets shorter.

`tailscale serve` still has to be set on the appliance for the dashboard to have an HTTPS door
(`just https` is written for a machine someone is logged into — [the M7 plan](plans/m7-appliance.md)
§3.9), and `YANTRA_NTFY_TOKEN` belongs in a `systemctl edit yantrad` drop-in rather than in the unit
this repo ships ([`development.md`](development.md)).
