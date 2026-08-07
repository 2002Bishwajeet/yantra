# Installing the appliance

How Yantra gets onto the always-on box and how it is updated afterwards. For local setup see
[`development.md`](development.md); for what the appliance milestone is, see
[`plans/m7-appliance.md`](plans/m7-appliance.md).

**Nothing has ever been published** (Y-037): there is no release, no tag and no package. So the
install is a build on the machine that already builds everything, and a copy — one recipe,
`just appliance-install`, which is also the update.

## Which architecture

**[Q15](../tracker.md#6-open-questions) is open** — *Pi 5 / N100* names two — so the recipes take a
target and default to `aarch64-unknown-linux-musl`, which is what they have always built:

```bash
just appliance                                   # arm64: a Pi 5
just appliance x86_64-unknown-linux-musl         # x86_64: an N100 mini-PC
```

`appliance-embedded`, `appliance-size` and `appliance-install` take the same argument. A target other
than the default needs `rustup target add <target>` once.

## What the box needs before the first install

The recipe copies binaries and units. It creates no accounts, writes no configuration and enrols
nothing — everything below is a one-time action on the box itself.

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
