# Installing the appliance

How Yantra gets onto the always-on box and how it is updated afterwards. For local setup see
[`development.md`](development.md); for what the appliance milestone is, see
[`plans/m7-appliance.md`](plans/m7-appliance.md).

**[v0.12.0](https://github.com/2002Bishwajeet/yantra/releases/tag/v0.12.0) is the current release**
([Y-405](../tracker.md)), and there are two ways in. [`install.sh`](../install.sh) fetches the
current release onto the box itself, verifies it, and at a terminal takes the box from bare to an
open dashboard ([Y-384](../tracker.md)). `just appliance-install` builds on the machine that
already builds everything and copies over ssh. Both put the same three binaries and the same two
units in the same places. `install.sh` also leaves its updater and two more units, and
`just appliance-install` leaves neither (see *Update from the dashboard* below). One fact about the artifact matters to the first: **the released
`yantrad` is built with `embed-dashboard`**, so a fetched binary serves the dashboard with no
`YANTRA_WEB` and no `web/dist` beside it.

## Which architecture

**[Q15](../tracker.md#6-open-questions) is answered — an HP EliteDesk 800 G5 Mini** (2026-10-12),
so the default is `x86_64-unknown-linux-musl`. It replaces the 2026-08-09 answer, the Pi 5. The recipes
still take a target, so an arm64 box is one argument rather than a second set of recipes:

```bash
just appliance                                   # x86_64: the EliteDesk mini PC
just appliance aarch64-unknown-linux-musl        # arm64: a Pi 5
```

`appliance-embedded`, `appliance-size` and `appliance-install` take the same argument. A target other
than the default needs `rustup target add <target>` once.

## Install from a release

One command, on the box, as the account you log in with — **not** as root. The script calls `sudo`
for the steps that need it.

```bash
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | bash
```

Debian 13 ships `wget` and no `curl`. Use this form there; the script installs `curl` with `apt-get`
before it goes on:

```bash
wget -qO- https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | bash
```

Read it first if you would rather — it is one file:

```bash
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh -o install.sh
less install.sh
bash install.sh
```

**Take it from `main` or from the v0.12.0 tag.** A copy from v0.2.0 or earlier is the script before
Y-384: it asks nothing and starts nothing. [Y-159](../tracker.md) gives the script a name that resolves off the tailnet; until
then the URL is GitHub's.

**Every device you use with Yantra must be on one tailnet**, logged in with the same Tailscale
account. The script says so first, because the dashboard cannot exist before the box is on it:
`yantrad` refuses to start until it can ask `tailscaled` which addresses this machine holds
([`crates/yantrad/CLAUDE.md`](../crates/yantrad/CLAUDE.md)).

### What it does at a terminal

`curl | bash` makes stdin the script, so the script reads its answers from `/dev/tty`.

1. It draws the Yantra mark, then says what it will do, and that every device must be on one tailnet.
   With no terminal it draws nothing, so piped output is unchanged.
2. It resolves the current release from
   `api.github.com/repos/2002Bishwajeet/yantra/releases/latest`, and fetches the `aarch64` or
   `x86_64` musl archive, `SHA256SUMS` and `SHA256SUMS.sig`. It checks the owner's signature on
   `SHA256SUMS` ([Sign a release](#sign-a-release)), and then the archive against `SHA256SUMS`.
   **A missing or wrong signature, or a mismatch, stops the run before anything is installed** —
   Tailscale included.
3. **If Tailscale is not installed**, it asks *"Install Tailscale, log this box in and turn on
   HTTPS? [Y/n]"*. A yes runs Tailscale's own installer,
   `curl -fsSL https://tailscale.com/install.sh | sh`.
4. **If the box is not logged in**, it runs `sudo tailscale up`. That prints a URL: open it on any
   device and log in with the account the other devices use. The box joins **untagged**, which
   superseded [Q17](../tracker.md#6-open-questions). **Turn off key expiry for this box once**, or
   it leaves the tailnet when its key expires: admin console → Machines → the box's menu → *Disable
   key expiry*.
5. It turns on HTTPS: `sudo tailscale serve --bg --https=8443 unix:/run/yantra/yantrad.sock`, the
   same command as `just https`. The proxy reaches `yantrad` on its socket, where the kernel names
   the account that connected ([ADR-0042](adr/0042-the-proxy-hop-is-proved-by-the-kernel.md)). **Before it asks, it says that the machine's name goes into a public
   certificate log** that anyone can read ([Tailscale KB 1153](https://tailscale.com/kb/1153/enabling-https)).
   On a tailnet that never had HTTPS, `tailscale serve` prints one link to turn it on and waits;
   open it. Ctrl-C there skips HTTPS, and the install goes on to finish on plain HTTP.
6. It installs Yantra: the `yantra` account if it is absent, the three binaries renamed into
   `/usr/local/bin` for the reason [below](#why-the-rename), the units from the archive, and a
   `systemctl daemon-reload`.
7. It writes `/etc/yantra/agent.env` **only if it is absent**, with this box's own
   `YANTRA_DAEMON=<tailnet address>:7717`. It writes `/etc/yantra/daemon.env` **only if it is
   absent** — `0600`, owned by `yantra`, and with no relay in it
   ([ADR-0021](adr/0021-the-relay-is-written-to-an-environment-file.md)). The GitHub OAuth App's
   client id needs no line there: the release build already carries one
   ([ADR-0023](adr/0023-the-github-grant-lives-beside-the-relay.md), Y-389), so `yantra github login`
   works on a fresh box. A self-hoster who wants their own app instead runs `yantra github
   client-id <id>`, or sets it from Settings → Providers, and restarts `yantrad` (Y-393).
8. It runs `systemctl enable --now` for both units and for `yantra-update.path`, and waits up to 30 s for `yantrad` to answer
   `/healthz`.
9. **It lets `yantrad` log in to this box** ([Y-598](../tracker.md)). `yantrad` reaches this box over
   ssh, as it reaches any machine ([ADR-0009](adr/0009-machine-names-are-ssh-destinations.md)). The
   script makes the `yantra` account's key and a `Host` block for this box, and places the public key
   in the `authorized_keys` of the account that ran the script. It then tries one real login and says
   how that went. It asks nothing, and a failure here does not stop the install.
   [The ssh identity section](#the-appliances-ssh-identity) says more. Agents run as that account,
   so [join an account without sudo](#join-an-account-without-sudo) to keep them off root.
10. It ends on one line: the dashboard's URL — `https://<machine>.<tailnet>.ts.net:8443`, or
   `http://<tailnet address>:7717` if HTTPS is not on. A browser that opens `:7717` while HTTPS is
   on moves to `:8443`, where the microphone works. If `qrencode` is installed, the URL also
   prints above that line as a QR code, so a phone can open it.

**What a no does depends on the question.** A no to installing Tailscale or to logging in installs
Yantra and nothing else, and the run ends the way a run with no terminal does. On a box that is
already logged in, the only question is HTTPS. A no there still starts both units and ends on
`http://<tailnet address>:7717`. A `^D` at any question counts as a no.

**Everything after that is the dashboard's walkthrough** — the other machines, the appliance's ssh
key, the AI agents and GitHub ([walk-through](plans/m15-qa-walkthrough.md) §1.5). The script does
not install `gh`, and `provision.sh` is gone: its fleet half belongs to the dashboard.

### Behind Caddy on a name you own

`tailscale serve` gives the box a `*.ts.net` name. To serve Yantra on a name you own, put Caddy in
front of the same socket. On the socket the kernel names the account that connected, and `yantrad`
trusts only root as a proxy until you name one more account
([ADR-0042](adr/0042-the-proxy-hop-is-proved-by-the-kernel.md), amended 2026-11-11). The Debian
package runs Caddy as `caddy`. On the box,
[`box/domain-setup.sh`](../box/domain-setup.sh) does all four steps.

1. Add two lines to `/etc/yantra/daemon.env` with `sudoedit`. The file stays `0600` and owned by
   `yantra`, and `yantra relay` and `yantra github` keep lines that they do not own:

   ```bash
   YANTRA_PROXY_ACCOUNT=caddy
   YANTRA_ORIGIN=https://yantra.example.com
   ```

   `YANTRA_ORIGIN` is the name the passkey belongs to, and the only `Origin` a write may send
   ([ADR-0044](adr/0044-a-write-needs-the-owners-passkey.md), amended 2026-11-12). It holds one
   https origin with no path. Without it, a page at your own name cannot sign in. The sign-in screen
   says so and shows this line. **Changing it costs every passkey**: each device enrols again.

2. Restart the daemon: `sudo systemctl restart yantrad`. The journal names the account and its uid,
   or says that no proxy account is set. A name that does not resolve is a warning, and the daemon
   then trusts no account but root. A bad `YANTRA_ORIGIN` stops the daemon, and the journal names
   the variable.
3. Turn Caddy's admin API off in the global block. Point the site block at the socket, and keep
   `bind` on the box's tailnet address:

   ```caddyfile
   {
       admin off
   }

   yantra.example.com {
       bind 100.x.x.x
       reverse_proxy unix//run/yantra/yantrad.sock {
           header_up X-Forwarded-For {remote_host}
       }
   }
   ```

4. Restart Caddy: `sudo systemctl restart caddy`. A reload goes through the admin API, so it fails
   once `admin off` is set.

**A box that `domain-setup.sh` named before the passkey gets its origin on its next update.** When
`/etc/caddy/Caddyfile` proxies to the socket and `daemon.env` names no `YANTRA_ORIGIN`, `install.sh`
adds `YANTRA_ORIGIN=https://<the Caddyfile's name>` and says so. The update then restarts the
daemon, and the owner enrols the phone with `yantra passkey code`.

**An update turns the admin API off in a Caddyfile that has it on.** When `/etc/caddy/Caddyfile`
proxies to the socket and has no `admin` line, `install.sh` adds `admin off` to the global block,
restarts Caddy once and says so. It does not change a file that has its own `admin` line, and it
prints that the API can still be open.

**Caddy checks the new file before the update writes it.** `install.sh` adds the line to a copy and
runs `caddy adapt` on that copy. It writes the Caddyfile only when the result has the admin API
off. A file that Caddy refuses stops the proxy at the restart. Otherwise the Caddyfile stays as it
was and Caddy is not restarted. Each update then prints that the API can still be open, and you
add the line as step 3 shows. This also happens when `caddy` is not on root's `PATH`.

**The cost: any process that runs as `caddy` can name a caller.** It writes the one address that the
daemon judges. A local process that reaches Caddy is still refused, because Caddy then forwards
this box's own address. Caddy's `X-Forwarded-For` must hold one address, as the line in step 3
makes it.

**The admin API must be off, or every account on the box has that power.** By default Caddy
listens on `127.0.0.1:2019` and asks for no credential. An account that reaches that port can
change Caddy's config, and Caddy then sends what that account chooses to the socket as the proxy
that the daemon trusts. `yantrad` looks at that port every 30 seconds while it trusts a proxy
account. When the port answers, `GET /api/readiness/proxy` says *absent* and the journal has a
warning with the fix.

### Run it again to update

**A second run is the updater.** It asks nothing it already has an answer to, except whether to
restart. It touches no configuration ([D2](design/02-setup.md) §1): an existing `agent.env` or `daemon.env` stays as it
is, and it does not run `tailscale up` or `tailscale serve` again. **One exception**: a serve on
port 8443 that still proxies to `http://<address>:7717` is pointed at the socket in the same run,
because `yantrad` now refuses this box's own address over TCP (ADR-0042). On a box with a custom
name, the run also names the origin and turns Caddy's admin API off
([behind Caddy](#behind-caddy-on-a-name-you-own)). It replaces the binaries
and the units, and it ends on the same URL. **A run at a terminal or with `--yes` also repeats step 9**, which
adds a key or a `Host` block only if it is missing. `yantra-update` runs with neither, so an update
never runs step 9.

**A run at a terminal asks before it restarts what is running.** If either unit runs, it asks
*"Restart yantrad and yantra-agent now? [Y/n]"*. A yes runs this command, and `--yes` answers yes:

```bash
sudo systemctl try-restart yantrad.service yantra-agent.service
```

A no or a `^D` restarts nothing, and the run prints that command for later.

`YANTRA_VERSION=0.2.0 bash install.sh` installs a named release instead of the current one.

### Update from the dashboard

**[ADR-0027](adr/0027-the-appliance-pulls-its-own-update.md) §3, [Y-368](../tracker.md).** Settings
→ About shows *Update to vX* when a newer release is published. `yantra update` on the box does the
same thing, and `yantra update --check` only says whether one exists.

- `install.sh` copies itself out of the archive to `/usr/local/bin/yantra-update`, so `SHA256SUMS`
  covers it. It installs two more units: `yantra-update.path` and `yantra-update.service`.
- `yantrad` runs as `yantra` and cannot write `/usr/local/bin`. To ask, it creates the empty file
  `/home/yantra/yantra-update.requested`. `yantra-update.path` sees the file and starts the service.
- `yantra-update.service` runs as root. It removes the file, runs `yantra-update` with no terminal,
  and then runs `systemctl try-restart yantrad.service yantra-agent.service`.
- **The request carries no version.** The unit installs the current release or nothing.
- **The unit installs no nightly.** It passes no flag, and only a run that names
  `--channel nightly` installs one ([Stable and nightly](#stable-and-nightly)).
- **A second request changes nothing.** One made while the unit runs is removed before the restart.
  A run that installs the release already on disk keeps `.prev` as it was.
- **A failed install restarts nothing.** The restart is `ExecStartPost=`, and a missing or wrong
  signature, a checksum mismatch or an unreachable GitHub stops the unit before it. Read why with
  `journalctl -u yantra-update`.
- `yantra update` needs root. Without it, it prints `sudo systemctl start yantra-update.service`.

### Stable and nightly

**[Y-662](../tracker.md) and [Y-780](../tracker.md), ADR-0027's 2026-11-10 and 2026-11-12
amendments.** There are two channels:

- **stable**, the default: each `v*` tag, read through `/releases/latest`. The owner signs it
  ([Sign a release](#sign-a-release)).
- **nightly**: the build of the latest merge to `main`. It is one rolling pre-release, tagged
  `nightly`, with the two Linux archives only. Its version reads like
  `0.10.4-nightly.20261110143205.abc1234`. **Nobody signs it**, and the build loop merges to `main`
  with no owner review.

**Only a person at a terminal installs a nightly, and names it each time:**

```bash
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | bash -s -- --channel nightly
sudo yantra-update --channel nightly      # on a box that has Yantra
yantra update --check --channel nightly   # says what is published, and installs nothing
```

- The choice is one word in `/etc/yantra/channel`, mode `0644` and owned by `yantra`, so Settings
  can rewrite it. A box with no file is on stable. Later updates follow a kept `stable`.
- **A kept `nightly` installs nothing by itself.** `yantrad`'s account can write that file, so a
  run that does not name `--channel nightly` refuses it and prints the command above. The root
  unit passes no flag, so Settings → About and `yantra update` install no nightly. This includes
  `sudo yantra update --channel nightly`, which writes the file and then starts the unit. About
  and the CLI show the unit's refusal.
- **The unit never goes back a version.** `install.sh` records what it installed in
  `/var/lib/yantra/installed`. A switch from nightly to stable therefore waits for a newer stable
  release. To go back now, run the script by hand: `sudo yantra-update --channel stable`.
- The first update of a box from before Y-662 runs the old updater, which knows no channel and
  installs stable. It also creates `/etc/yantra/channel`, so the next switch works.

**How far an update got** ([Y-612](../tracker.md)). `yantrad` runs as `yantra`, which cannot read
the root unit's journal. So the unit gives `install.sh` a `RuntimeDirectory`, `/run/yantra-update`,
mode `0755`, and keeps it after the run:

- `status` holds `key=value` lines: `step` (`resolving`, `downloading`, `verifying`, `installing`,
  `failed` or `done`), `version`, `archive`, and `total` when the release host sent a length.
- `said` holds the run's stderr. The journal still gets every line.
- While the run downloads, the archive is in this directory, so its size is the bytes received.

Settings → About draws the step, a progress bar while the archive arrives, and on a failure the
last 20 lines of `said`. `yantra update` prints the same to stderr. A run starts by clearing the
directory. A run of `install.sh` at a terminal removes `status` and `said` once it has installed
the binaries, so a failure the unit left does not outlive that recovery. To read it by hand:
`cat /run/yantra-update/status /run/yantra-update/said`. **The first update of a box installed
before Y-612 shows no progress**: the unit runs the updater already on the box, and that one
writes none.

**What the restart ends.** Sessions on the machines keep running: their tmux servers belong to the
login user there, not to `yantrad`. An open terminal in the dashboard loses its socket and
reconnects to the same pane. **A chat turn in flight dies**, because the daemon owns that process
(ADR-0026). The event list and the telemetry start empty. The page compares the version it loaded
with the one `/api/about` now reports, and offers a reload.

**Releases up to v0.3.3 carry no updater.** Installed from one of those, a box has no
`yantra-update`, and the dashboard's action answers `409` naming `install.sh`. A box installed by
`just appliance-install` answers the same.

[`crates/yantrad/tests/update.rs`](../crates/yantrad/tests/update.rs) proves this against a real
systemd, a real sshd and a real tmux: the session's processes survive, the socket reopens within the
browser's reconnect budget, and a corrupted archive restarts nothing. The unit refuses a nightly and
a release with no signature, and it replaces and restarts nothing. [`release.yml`](../.github/workflows/release.yml)
runs the same test against the x86_64 archive it built, and a failure there publishes nothing (Y-483).

### Roll back

Each install copies every live binary to `/usr/local/bin/<name>.prev` before it replaces it. One
generation is kept, not a history. Rolling back is three renames and a restart
([ADR-0027](adr/0027-the-appliance-pulls-its-own-update.md) §6):

```sh
for b in yantrad yantra yantra-agent; do sudo mv -f /usr/local/bin/$b.prev /usr/local/bin/$b; done
sudo systemctl try-restart yantrad.service yantra-agent.service
```

The units are not kept. A release that changed a unit is rolled back by installing the older release
by number, which is also the better answer when the network works.

### With no terminal

A run with nothing at `/dev/tty` — a container, a CI job, an `ssh host 'curl … | bash'` without
`-t` — without `--yes` asks nothing and starts nothing. It installs the release, writes both environment files if
they are absent (`agent.env` with a placeholder rather than an address), enables no unit, and
ends with a numbered list of what is left. When `yantrad.service` is already enabled — which is
how `yantra-update.service` runs it — it says that instead, and restarts nothing itself. That is the path
[`crates/yantrad/tests/installer.rs`](../crates/yantrad/tests/installer.rs) runs twice against a
real systemd ([Y-158](../tracker.md#3-task-board)).

### Unattended install

**[Y-474](../tracker.md):** `--yes` answers every question yes, with or without a terminal.
`YANTRA_YES=1` does the same:

```bash
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | bash -s -- --yes
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | YANTRA_YES=1 bash
```

The run then does what a yes at a terminal does: it installs Tailscale, logs the box in, turns on
HTTPS, starts the units and ends on the dashboard's URL. Without a key, `tailscale up` prints its
login URL and waits for someone to open it. To log in with no one there, give it an auth key:

```bash
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | TS_AUTHKEY=tskey-auth-… bash -s -- --yes
```

- **The key is never written to disk.** The script pipes it to
  `tailscale up --auth-key=file:/dev/stdin`, so it is in no command line, no file and no journal
  line. `sudo` logs a command line to the journal, which is why the key does not go in one.
- **A key made with a tag joins the box tagged**, which is what [Q17](../tracker.md#6-open-questions)
  warned about: a tagged box may refuse every write from your phone, which
  [Y-143](../tracker.md) has not measured, and it reads every peer as shared. Make the key without
  a tag. The box's key still expires, so turn off key expiry as step 4
  above says.
- **With no terminal, `tailscale serve` gets 120 seconds.** On a tailnet that never had HTTPS it
  waits on its link, and no one is there to press Ctrl-C. The install then ends on plain HTTP.
- **A run as root names the account.** Root is not an account to log in to, so step 9 reads
  `YANTRA_ACCOUNT`. Without it, the account is `SUDO_USER`, then the account that runs the script.
  If that is `root`, or if `yantra` or an unknown account is named, the run places no key and prints
  the join command. The box's `firstboot.sh` sets it to `karigar`, an account with no sudo that it
  makes first:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | YANTRA_ACCOUNT=<account> bash -s -- --yes
  ```

- **`--uninstall` ignores `--yes`.** Its questions are default no, and `--yes` never deletes
  `/etc/yantra` or the account.

The updater runs `yantra-update` with no option, so a background update asks nothing and starts
nothing new.

### What the tests prove, and what they cannot

`installer.rs` runs the script against a real systemd as PID 1 in a podman container, with a release
served from inside it. **With no terminal**: an edited `agent.env` and an edited `daemon.env`
survive a second run, `daemon.env` is `600 yantra`, the binaries replace while one of them is
executing, each replaced binary is kept as `.prev`, the updater is the archive's own `install.sh`, and
a corrupted archive installs nothing. A release with no `SHA256SUMS.sig`, with another key's
signature, or with a `SHA256SUMS` that changed after the signature installs nothing. The fixture
signs with its own key and writes that key into its copy of the script, so the tests do not prove
the owner's key. **At a terminal**, through a pty: a yes logs
in, turns on `serve`, writes the address into an absent `agent.env`, enables both units and ends on
the URL; a second run asks nothing but the restart and changes no file; a rerun with both units
running leaves them on a no and restarts both on a yes; with a `qrencode` stub installed, the URL
also goes to a QR code; a no installs Yantra and starts nothing. On
a box that is already logged in, a no to HTTPS still starts both units. A `serve` that refuses, and
a Ctrl-C while `serve` waits on its link, both end on the `http://` URL. **With `--yes` and no
terminal**: the run asks nothing, hands `TS_AUTHKEY` to `tailscale up`, turns on `serve`, writes the
address, enables both units and ends on the `https://` URL; the key is in no file and no journal
line afterwards, and `YANTRA_YES=1` ends on the same URL. An unknown option installs nothing.

[`own_box.rs`](../crates/yantrad/tests/own_box.rs) proves step 9 with a real `sshd`, `tmux`, `yantrad`
and `yantra`: a session on the person's account appears in `GET /api/sessions` under the box's name,
with `--yes` as that account. A second run adds no key line and no
`Host` block. Root with no account, and a kept block for another account, place no key and still
finish. The real update unit writes no file under either `.ssh`. It also runs the box's real
`firstboot.sh` under its own unit (Y-786): `ssh -G` then names `karigar`, `karigar` is in no sudo
group and `sudo -n` refuses it, and a `karigar` session appears in the listing. The test skips both
Claude Code installs. The fixture's PAM permits every account, so the test does not prove a key
login with a `*` password under Debian's PAM. `tailscaled` is a stub and
`/etc/hosts` stands in for MagicDNS, so the test does not prove that the name resolves on a tailnet.

**The terminal tests talk to a stub `tailscale`** that records its calls. A login, a tailnet address
and a certificate are what no container can hold, so the tests prove which commands the script ran,
not that Tailscale did what they ask. Tailscale's installer, a real `tailscale up` and the HTTPS
link are proved only on real hardware.

### What resolving the version gives up

**It is written in the script.** The version and the commit it replaced were a person's choice in a
reviewed commit; `SHA256SUMS` still proves the archive arrived intact from the release it names
([ADR-0027](adr/0027-the-appliance-pulls-its-own-update.md) §4). For a stable release, the owner's
signature on `SHA256SUMS` proves that the owner approved it ([Sign a release](#sign-a-release)).
For the nightly, nothing proves that. `/releases/latest` skips drafts and
pre-releases, so a `v0.3.0-rc.1` tag never installs itself. A call GitHub refuses — `403`, since 60
an hour per IP is what an unauthenticated one gets — stops the run and says so.

### Sign a release

**[ADR-0027](adr/0027-the-appliance-pulls-its-own-update.md) decision 4, amended 2026-11-12
([Y-780](../tracker.md)).** A checksum proves that an archive is whole. It does not prove who made
it. So the owner signs `SHA256SUMS` with an ssh key that stays offline. The release job holds no
key and signs nothing.

When the release job has published `v<V>` and the owner approves it, the owner runs this on the
machine that holds the key:

```bash
gh release download v<V> --repo 2002Bishwajeet/yantra --pattern SHA256SUMS
ssh-keygen -Y sign -f <the offline key> -n file SHA256SUMS
gh release upload v<V> --repo 2002Bishwajeet/yantra SHA256SUMS.sig
```

- `install.sh` carries the public key in `RELEASE_KEY`. It runs `ssh-keygen -Y verify` on
  `SHA256SUMS` before `sha256sum -c`, and it refuses to install on a machine with no `ssh-keygen`.
  `SHA256SUMS` covers the archive, and the archive holds the updater and the units.
- **A script that carries a key installs a release only after `SHA256SUMS.sig` is uploaded.** With
  no signature, or with another key's signature, it installs nothing. The root unit runs the same
  script, so the dashboard's update waits for the signature too.
- **A script that carries no key says so.** `RELEASE_KEY` is empty until [Y-798](../tracker.md)
  puts the owner's public key on `main`. The script then prints
  `this installer carries no release key, so no signature was checked` and checks the checksum
  alone.
- The nightly has no signature ([Stable and nightly](#stable-and-nightly)).

### Where the units come from

**From the archive, since [Y-365](../tracker.md).** The Linux archives hold the three binaries, a
README, a LICENSE, `install.sh` and the four units — [`release.yml`](../.github/workflows/release.yml) stages them
beside the binaries they start, so `SHA256SUMS` covers the files that decide what runs as root.
The macOS archives carry none: they ship `yantra-agent` alone and no systemd reads a unit there.

### On a Mac

**[Y-502](../tracker.md): on a Mac, `install.sh` installs `yantra-agent` alone.** Run it as the
account logged in at the Mac, and name the daemon's tailnet address:

```bash
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | YANTRA_DAEMON=<address>:7717 bash
```

It needs no root, and it refuses to run as root. It writes the binary to `~/.local/bin/yantra-agent`
and a LaunchAgent to `~/Library/LaunchAgents/io.github.2002bishwajeet.yantra-agent.plist`. launchd
has no `EnvironmentFile=`, so the LaunchAgent starts the agent through `sh`, which reads
`~/.config/yantra/agent.env` first. The script writes that file only when it is missing, as on Linux.
With no `YANTRA_DAEMON` set, it takes the address from the LaunchAgent the join command wrote.
It loads the LaunchAgent only when the file names a daemon. A second run rewrites the LaunchAgent and
restarts the agent; it does not add a second one. It checks the signature on `SHA256SUMS` as on
Linux ([Sign a release](#sign-a-release)). Nightly builds carry no macOS archive, so
`--channel nightly` is refused. `--uninstall` is refused too, and it prints the two commands that
remove the agent by hand. [`macos.rs`](../crates/yantra-core/tests/macos.rs) runs the script on CI's
Mac runner.

Before that the script fetched them from `raw.githubusercontent.com` at a `COMMIT` pinned beside
`VERSION`. It pinned them honestly — a tag is a mutable ref, and v0.1.0's was deleted and re-cut the
day it was published — but **those two files were outside `SHA256SUMS`**, which lists archives and
nothing else, and the pin was a constant somebody had to bump with every release.

The cost is that **an archive published before this carries no units**, which is every release up to
v0.1.0. The script says so and installs nothing rather than failing on a missing file, and
[`installer.rs`](../crates/yantrad/tests/installer.rs) holds it to that.

### Update an agent

**[Y-713](../tracker.md): the dashboard says when a machine's `yantra-agent` is older than
`yantrad`.** The machine's readiness gives the command that updates it. The box updates its own
agent, but a joined machine does not. The command pins the daemon's own version, as the join command
does, so an agent never passes the daemon (ADR-0013: the daemon goes first). On a joined Linux
machine, run it as an account with sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | YANTRA_VERSION=<daemon version> bash -s -- --agent
```

A nightly has no tag to pin, so under a nightly daemon the command names `--channel nightly` instead.
A Mac drops `-s -- --agent`. A nightly has no macOS archive, so under a nightly daemon a Mac is held
to the stable release that nightly builds on, one patch below it.

`--agent` verifies the archive as a full install does. Then it replaces `/usr/local/bin/yantra-agent`
and `yantra-agent.service`, keeps `/etc/yantra/agent.env` and restarts the agent. It installs no
`yantrad`, because a second `yantrad` would make the machine a second appliance. With no
`agent.env` there is no agent to update, so it refuses and names the join command.
`yantra-agent --version` prints what a machine runs.

## Uninstall

**[Y-407](../tracker.md):** `install.sh --uninstall`, or piped the same way the install itself is:

```bash
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | bash -s -- --uninstall
```

**It always** stops and disables `yantrad.service`, `yantra-agent.service` and the two update units,
removes the four unit files, reloads systemd, and removes the three binaries, `yantra-update` and the
three `.prev` files from `/usr/local/bin`. Every step tolerates
an item that is already gone, so a second run succeeds.

**It asks, one at a time, default keep, and only at a terminal:**

- Remove `/etc/yantra`? It holds the ntfy token and the GitHub token.
- Remove the `yantra` account and `/home/yantra`? It holds the SSH key, the SSH config and the
  workspaces.
- Turn off the Tailscale serve on the dashboard's HTTPS port? Only that port comes off —
  `tailscale serve --https=8443 off` — never `tailscale serve reset`, which would drop every other
  serve on the tailnet too.

**It leaves the public key in `authorized_keys`**, on this box and on every machine that joined. A
script run on this box cannot know which lines a person wants to keep, so remove that line by hand.

With no terminal it keeps all three and says so. **Tailscale itself, tmux, git and claude are never
touched, and nothing on any other machine changes.** The closing message names what was removed and
what was kept, and a reinstall with the same script picks up where it left off for whatever it kept.

**This is not how you switch versions.** Install over the current release and restart:

```bash
curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh | YANTRA_VERSION=0.3.0 bash
sudo systemctl restart yantrad yantra-agent
```

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
ssh <host> 'sudo tailscale serve --bg --https=8443 unix:/run/yantra/yantrad.sock'
ssh <host> 'journalctl -u yantrad -f'
```

## The appliance's ssh identity

The ssh identity the appliance uses to reach the fleet — a key, a config and a `known_hosts` nobody
typed. Without it the daemon starts and every verb that reaches a machine fails.

**The join command prepares it, one machine at a time** (Y-387,
[ADR-0029](adr/0029-a-machine-joins-itself.md)). In a terminal on the new machine, as `karigar`,
the account without sudo that Yantra is to log in as ([below](#join-an-account-without-sudo)):

```bash
curl -fsSL https://<appliance>.<tailnet>.ts.net:8443/join | sh
```

Where HTTPS is not on, `http://<appliance's tailnet address>:7717/join` serves the same script.
**On the appliance itself, fetch it on the daemon's socket**, because `yantrad` refuses the
appliance's own address ([ADR-0042](adr/0042-the-proxy-hop-is-proved-by-the-kernel.md)):

```bash
curl -fsSL --unix-socket /run/yantra/yantrad.sock http://yantra/join | sh
```

There an account that is not `yantra` and not in the `yantra` group may join itself and nothing more.
So the script cannot ask `yantrad` to test its login, and it says so: the dashboard's Check on the
appliance shows whether `yantrad` can log in.

The daemon makes its key the first time this is fetched. The script asks before each step that
needs root: it turns on `sshd`, places the key in that account's `authorized_keys`, offers `tmux`,
`git` and `yantra-agent`, and tells the daemon which account it ran as. The daemon names the machine
from the caller's tailnet address and appends its `Host` block, with `User`, to the `yantra`
account's config. **If a block already names the machine, it is kept**, and the script warns when
that block logs in as a different account. The agent's unit is `DynamicUser=yes`, so a joined
machine gains no account for it. On a Mac, the join command still writes the address into the
LaunchAgent itself, and writes no `agent.env`. A run of `install.sh` there
([On a Mac](#on-a-mac)) moves that address into a new `agent.env` and replaces the LaunchAgent with
the one that reads it.

**The box itself needs no join command** (Y-598). `yantrad` lists this box's sessions over ssh, so
[step 9](#what-it-does-at-a-terminal) of the install does here what the join command does elsewhere,
for the account that ran the install. To run agents as `karigar` there instead, see
[Join an account without sudo](#join-an-account-without-sudo). A box built from the
[stick](../box/README.md) already joins as `karigar`. `yantra` itself has the shell
`/usr/sbin/nologin` and stays that way: it holds the key to the whole fleet, and the sessions are
not on that account.

- **A run with no answers skips it.** With no terminal and no `--yes`, and in an update, nothing
  writes under either `.ssh`.
- **A box installed before this step does not get it from an update.** Run `install.sh` again at a
  terminal on that box, or run the join command there.
- **A kept block for another account places no key.** The run prints why and the join command, and
  the install still finishes.
- **A failed login does not stop the install.** `sshd` must run on the box, and the dashboard's Check
  says why a login failed. This step does not turn `sshd` on; the join command offers that.

**By hand**, for the account the units run as ([Y-144](../tracker.md#3-task-board)):

```bash
sudo -u yantra -H yantra ssh-identity
sudo -u yantra -H yantra ssh-identity --machine <m> --user <u>
sudo -u yantra -H yantra join-script
sudo -u yantra -H yantra forget-host-key <m>
```

The first generates `~/.ssh/id_yantra` if that account has no key, adds a `Host` block binding it for
every machine a workspace names, and prints the public key. The second writes one block, with its
`User`. The third prints the join script. The fourth removes the host key that account recorded for `<m>`, so the next check records the new one; the dashboard names it when a key changed ([Y-621](../tracker.md#3-task-board)). **`-H` matters**: without it `sudo` may leave `HOME` as
yours and the verb prepares the wrong account's `~/.ssh`. Each is idempotent — an existing key is
kept, because regenerating it orphans every `authorized_keys` entry it is in, and a machine the
config already names is left exactly as it is. A block the first verb wrote has no `User`, so it
logs in as `yantra` until you edit it.

**What stays yours:** a `HostName`, `Port` or `ProxyJump` for a name the tailnet does not resolve —
Yantra never resolves a name ([ADR-0009](adr/0009-machine-names-are-ssh-destinations.md)). On a Mac,
Remote Login is a switch in System Settings → General → Sharing, which no script can flip.

**The key has no passphrase.** `BatchMode=yes` has nowhere to type one, and the alternative is an
ssh agent — a login session a box nobody logs into does not have. It is readable by the `yantra`
account and that account alone, and anyone who can read it can reach every machine that authorised
it.

**`known_hosts` needs nothing.** Yantra keeps its own beside its control sockets and connects with
`StrictHostKeyChecking=accept-new`, so first contact records the host key with nobody there to
answer a prompt. A machine whose host key later *changes* is then a hard refusal — deliberately, and
it is a support call rather than something to configure away.

### Join an account without sudo

**Agents run as the account that joins, so that account must not use sudo** (owner, 2026-11-04,
[Y-628](../tracker.md#3-task-board)). An agent reads issues, pull requests, web pages and tool
output all day, and any of them can carry a prompt injection. A prompt-injected agent with any root
path owns the machine ([ADR-0046](adr/0046-the-owner-types-sudo-in-an-owner-terminal.md)). Make a
separate account named `karigar` with no sudo, and run the join command as that account.

The join command skips each step that needs root when the account cannot use sudo, and still places
the key and reports. So install `tmux`, `git` and `sshd` from your own admin account first, and
start `sshd`. On Linux, `yantra-agent` needs root, so it stays off, and the dashboard has no
heartbeat for that machine.

**On Linux**, as your own admin account, with `tmux`, `git` and `sshd` installed. Arch, Fedora and
openSUSE do not start `sshd` when they install it, and `karigar` cannot start it, so start it first:

```bash
sudo systemctl enable --now sshd
```

Debian and Ubuntu start it on install, and name the unit `ssh`. If the machine runs Tailscale SSH and
the tailnet's policy asks for a browser check, `karigar` cannot turn Tailscale SSH off either. Turn
it off before the join:

```bash
sudo tailscale set --ssh=false
```

Then make `karigar` and switch to it:

```bash
sudo useradd --create-home --shell /bin/bash karigar
sudo usermod -p '*' karigar
sudo -iu karigar
```

`usermod -p '*'` gives `karigar` no password and does not lock it, so `sshd` takes its key. Run the
join command in the shell that `sudo -iu` opens.

**On a Mac**, as your admin account:

```bash
brew install tmux git
sudo sysadminctl -addUser karigar -fullName Karigar -password -
```

`sysadminctl` asks for a password and makes a Standard account. Then:

1. Allow `karigar` in System Settings → General → Sharing → Remote Login.
2. Log in as `karigar` at the Mac's screen once. The tmux server and the keychain need its login
   session ([ADR-0018](adr/0018-the-tmux-server-carries-the-macos-login-session.md)).
3. In Terminal there, give its shell Homebrew's `PATH`, then open a new window:

   ```bash
   echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
   ```

4. Run `claude` and sign in, then run the join command.

**The machine card warns when the joined account can use sudo.** The `no-sudo` check in
`yantra doctor` is *absent* for root, for a member of the `sudo`, `wheel` or `admin` group, and for
an account whose `sudo -n true` runs, which is a `NOPASSWD` rule. Yantra asks the groups on each
sweep. It asks `sudo -n` at most once an hour per machine, because each refusal writes a line to
the auth log. The warning does not stop a session.

**On the hub, edit the `Host` block first.** [Step 9](#what-it-does-at-a-terminal) of the install
writes a block for the account that ran the install. The join command keeps a block that exists,
so a `karigar` join there warns that the kept block logs in as another account, and stops. Change
that block's `User` to `karigar` in `~yantra/.ssh/config`, then run the join command as `karigar`.

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

The ntfy relay is written by the push setup in the browser or by
`sudo yantra relay <url> [--token T]` into `/etc/yantra/daemon.env`, which the unit reads with
`EnvironmentFile=` ([ADR-0021](adr/0021-the-relay-is-written-to-an-environment-file.md)). Two
places open the push setup: **Set up** on "Push to your phone" in the setup walkthrough, and the
relay row in Settings > Notifications. It walks four steps in one sheet. First, it links the ntfy
app in the App Store and in Google Play. Second, it makes a topic and shows it as a QR code, a link
and a URL to copy; a self-hosted topic gets no QR. Third, **Save and send a test** writes the file
and sends one test message. Fourth, it asks "Did it arrive?". **No** lists what to check on the
phone and offers **Send another test**, which posts the same topic and token again. A 502 means the
file is written and the test did not arrive, so the sheet shows the daemon's words and does not ask.

The installer creates that file empty, `0600` and owned by `yantra`; **leave the owner alone** — the
daemon rewrites the file in place, so one created by hand as root leaves `/settings` refusing with a
500. `yantrad` reads it when systemd starts the unit, so a relay set from the browser needs a
restart. The sheet offers "Restart now" beside the save, which asks for the update trigger
([ADR-0027](adr/0027-the-appliance-pulls-its-own-update.md)) and so also installs a newer release if
one is published. Without the updater, run `sudo systemctl restart yantrad`
([`development.md`](development.md)).
