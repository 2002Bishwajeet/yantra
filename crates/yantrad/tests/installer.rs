//! [`install.sh`](../../../install.sh) run twice against a real `systemd` as
//! PID 1, in a disposable podman container (§B3, Y-158).
//!
//! **The second run is where the value is.** The first only has to work; the
//! second has to leave an edited `/etc/yantra/agent.env` alone (ADR-0013 §4)
//! and replace three binaries while one of them is executing, which is the
//! hazard Y-145's rename exists for and which `cp` below is measured refusing.
//!
//! **The release is served from inside the container**, by
//! [`tests/fixture/release.sh`](fixture/release.sh): `/etc/hosts` points
//! `github.com` and `api.github.com` at a local HTTPS server whose certificate
//! is in the container's trust store, so `curl`, TLS, the URLs the script
//! builds, the release list it resolves a version from and the checksums are
//! all real — and so is a corrupted archive, which the published host cannot
//! serve. The cost is that the archive is this fixture's rather than a
//! published one, so the shape of it is asserted against `release.yml`, which
//! is what produces the real one.
//!
//! **No version appears in both this file and `install.sh`** (Y-365). The two
//! the fixture publishes are its own, so a run that installed one of them
//! resolved it from the release list.
//!
//! It runs as an unprivileged account through `sudo`, the way
//! `docs/appliance.md` says to run it: as root every missing `as_root` passes.
//!
//! Nothing here holds a `tailscaled`, so the Tailscale step is proved by its
//! report — twice, because a report that never changes is a constant.
//!
//! **The questions need a terminal, and `podman exec` without `-t` gives none**,
//! which is how the runs above stay non-interactive (Y-384). The runs that
//! answer are driven through a pty, and the `tailscale` they talk to is a stub
//! that records its calls: a login, a tailnet address and a certificate are
//! what no container can hold, so this proves which commands the script ran
//! and never that Tailscale did what they ask.

mod common;

use std::process::Output;

use anyhow::{Context, Result, bail};

use common::{Systemd, UNPRIVILEGED, fixture_dir, repo_root};

const BINARIES: [&str; 3] = ["yantrad", "yantra", "yantra-agent"];

const UNITS: [&str; 2] = ["yantrad.service", "yantra-agent.service"];

/// What the fixture publishes first, and what it publishes over it. `install.sh`
/// names neither, so a second run that installs the second one followed the
/// release with nothing edited — which is the whole of Y-365.
const VERSION: &str = "0.2.0";
const NEXT_VERSION: &str = "0.3.0";

/// The synthetic address of the test convention, so what the second run must
/// not touch is a line only a person could have put there.
const EDITED_ENV: &str = "YANTRA_DAEMON=100.64.0.5:7717";

/// The same, for the file ADR-0021 added: a line only a person could have put
/// there, so an update that rewrote it would be caught.
const EDITED_RELAY: &str = "YANTRA_NTFY_URL=https://ntfy.example/a-topic";

/// The agent has to be *executing* for a replacement to mean anything, and the
/// real one exits without a daemon it can reach, so a long-running process runs
/// the installed file instead. Its own unit takes no arguments and cannot.
const AGENT_UNIT: &str = "agent-under-install";

/// A pty for the script's `/dev/tty`. The answers are typed ahead and end in
/// ^D, so a question nobody expected is a no rather than a hang — and still
/// prints the `[Y/n]` a test asserts on. A second argument types ^C once the
/// screen shows it, which the line discipline turns into a real SIGINT.
const AT_A_TERMINAL: &str = r#"
import os, pty, sys
interrupt = sys.argv[2].encode()
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", "-c", "cat /fixture/install.sh | bash"])
os.write(fd, sys.argv[1].encode() + b"\x04")
out = b""
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    if interrupt and interrupt in out:
        os.write(fd, b"\x03")
        interrupt = b""
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(status))
"#;

/// In `/usr/bin` because `sudo`'s `secure_path` omits `/usr/local/bin`, and
/// that is where Tailscale's own packages put it. Every call is logged, and the
/// address is loopback so a stand-in `yantrad` can answer on it.
const TAILSCALE_STUB: &str = r#"#!/bin/sh
umask 000
state=/var/tmp/tailscale-stub
echo "$*" >> $state/calls
case "$1" in
status)
    [ -e $state/up ] || exit 1
    [ "$2" = --json ] && printf '{"Self": {"DNSName": "yantra-box.tail0000.ts.net."}, "Peer": {"p": {"DNSName": "peer.tail0000.ts.net."}}}\n'
    ;;
up) touch $state/up ;;
ip)
    [ -e $state/up ] || exit 1
    echo 127.0.0.1
    ;;
serve)
    if [ "$2" = status ]; then
        [ -e $state/serving ] && printf '{"TCP": {"8443": {"HTTPS": true}}}\n'
    else
        [ -e $state/serve-fails ] && exit 1
        # What tailscale does on a tailnet that never had HTTPS: a link, then a wait.
        if [ -e $state/serve-waits ]; then
            echo "Serve is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/serve"
            exec sleep 60
        fi
        touch $state/serving
    fi
    ;;
esac
exit 0
"#;

/// The container, and the one constant `install.sh` still carries.
struct Installer {
    systemd: Systemd,
    repo: String,
}

impl Installer {
    fn start() -> Result<Option<Self>> {
        let script = std::fs::read_to_string(repo_root().join("install.sh"))?;
        let Some(systemd) = Systemd::start()? else {
            return Ok(None);
        };
        let installer = Self {
            repo: repo_constant(&script)?,
            systemd,
        };

        installer
            .systemd
            .run(&["mkdir", "-p", "/fixture", "/srv/units"])?;
        for (from, to) in [
            (repo_root().join("install.sh"), "/fixture/install.sh"),
            (fixture_dir().join("release.sh"), "/fixture/release.sh"),
            (fixture_dir().join("server.py"), "/fixture/server.py"),
            (
                repo_root().join("crates/yantrad/yantrad.service"),
                "/srv/units/yantrad.service",
            ),
            (
                repo_root().join("crates/yantra-agent/yantra-agent.service"),
                "/srv/units/yantra-agent.service",
            ),
        ] {
            installer.systemd.copy_in(&from, to)?;
        }
        // A sudo that cannot elevate makes install.sh look broken when it is the
        // container that is, which is how this arrived (GitHub's runner, PAM).
        let sudo = installer
            .systemd
            .exec_as(UNPRIVILEGED, &["sudo", "-n", "true"])?;
        if !sudo.status.success() {
            bail!(
                "the fixture's own sudo does not work, so nothing below is about install.sh: {}",
                String::from_utf8_lossy(&sudo.stderr).trim()
            );
        }

        installer.release(&["serve"])?;
        Ok(Some(installer))
    }

    fn release(&self, args: &[&str]) -> Result<String> {
        let mut argv = vec!["bash", "/fixture/release.sh"];
        argv.extend_from_slice(args);
        self.systemd.run(&argv)
    }

    /// `marker` goes into every file of the archive, units included, so a run
    /// that installed the other publication is a different checksum rather than
    /// a guess.
    fn publish(&self, version: &str, marker: &str) -> Result<()> {
        self.release(&["publish", &self.repo, version, marker])?;
        Ok(())
    }

    /// Piped through `bash`, which is the command `docs/appliance.md` gives and
    /// the one that makes the script its own stdin.
    fn install(&self) -> Result<Output> {
        self.systemd.exec_as(
            UNPRIVILEGED,
            &["bash", "-c", "cat /fixture/install.sh | bash"],
        )
    }

    /// The same run with a version named, which is the override
    /// `docs/appliance.md` documents and the one path that reads no release
    /// list.
    fn install_version(&self, version: &str) -> Result<Output> {
        let piped = format!("cat /fixture/install.sh | YANTRA_VERSION={version} bash");
        self.systemd.exec_as(UNPRIVILEGED, &["bash", "-c", &piped])
    }

    /// The same pipe, with a terminal behind it. stdout and stderr arrive
    /// merged, as they do on a screen.
    fn install_at_terminal(&self, answers: &str) -> Result<String> {
        self.at_terminal(UNPRIVILEGED, answers, "")
    }

    /// The same, as root, with a Ctrl-C typed once `after` is on the screen.
    /// Root because `sudo` puts the terminal in raw mode and relays ^C to its
    /// own pty, so through it only `tailscale` would see the SIGINT; as root it
    /// reaches the script too, which is the case the script's trap is for.
    fn install_interrupted(&self, answers: &str, after: &str) -> Result<String> {
        self.at_terminal("root", answers, after)
    }

    fn at_terminal(&self, user: &str, answers: &str, after: &str) -> Result<String> {
        let out = self
            .systemd
            .exec_as(user, &["python3", "-c", AT_A_TERMINAL, answers, after])?;
        let screen = String::from_utf8(out.stdout)?;
        if !out.status.success() {
            bail!(
                "install.sh failed at a terminal ({}):\n{screen}",
                out.status
            );
        }
        Ok(screen)
    }

    /// A `tailscale` that is installed and logged out, and a `yantrad` stand-in
    /// answering `/healthz` where the stub's address points — the fixture's
    /// own binaries are `sleep` and answer nothing.
    fn arrange_tailnet(&self) -> Result<()> {
        // Not sticky: `protected_regular` refuses root an append to a file
        // another account created in a sticky directory, and the log would
        // silently lose every call made through sudo.
        self.sh("install -d -m 0777 /var/tmp/tailscale-stub")?;
        self.sh(&format!(
            "cat > /usr/bin/tailscale <<'STUB'\n{TAILSCALE_STUB}STUB\nchmod 755 /usr/bin/tailscale"
        ))?;
        self.sh("mkdir -p /srv/health && echo ok > /srv/health/healthz")?;
        self.sh("systemd-run --unit=yantrad-stand-in --collect \
             python3 -m http.server 7717 --bind 127.0.0.1 --directory /srv/health")?;
        Ok(())
    }

    fn tailscale_calls(&self) -> Result<Vec<String>> {
        Ok(self
            .sh("cat /var/tmp/tailscale-stub/calls 2>/dev/null || true")?
            .lines()
            .map(str::to_owned)
            .collect())
    }

    fn install_ok(&self) -> Result<String> {
        let out = self.install()?;
        if !out.status.success() {
            bail!(
                "install.sh failed ({}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(String::from_utf8(out.stdout)?)
    }

    fn sh(&self, script: &str) -> Result<String> {
        self.systemd.run(&["bash", "-c", script])
    }

    fn sha(&self, path: &str) -> Result<String> {
        Ok(self
            .sh(&format!("sha256sum {path}"))?
            .split_whitespace()
            .next()
            .context("sha256sum printed nothing")?
            .to_owned())
    }

    /// `mktemp -d` is the script's only scratch space and its `trap` is the
    /// only thing that removes it.
    fn scratch_dirs(&self) -> Result<String> {
        self.sh("ls -d /tmp/tmp.* 2>/dev/null | wc -l")
    }

    /// Every refusal is ahead of every privileged step, so a box that refused
    /// is the box the run found: no binaries, no units, no `/etc/yantra` and no
    /// account.
    fn nothing_is_installed(&self, because: &str) -> Result<()> {
        for binary in BINARIES {
            assert!(
                !self
                    .systemd
                    .exec(&["test", "-e", &format!("/usr/local/bin/{binary}")])?
                    .status
                    .success(),
                "{binary} is installed although {because}"
            );
        }
        for path in ["/etc/yantra", "/etc/systemd/system/yantrad.service"] {
            assert!(
                !self.systemd.exec(&["test", "-e", path])?.status.success(),
                "{path} was written although {because}"
            );
        }
        assert!(
            !self.systemd.exec(&["id", "yantra"])?.status.success(),
            "the account outlived a run that installed nothing"
        );
        assert_eq!(
            self.scratch_dirs()?.trim(),
            "0",
            "the download outlived the run"
        );
        Ok(())
    }
}

/// The repository `install.sh` fetches from, so the fixture serves the URLs the
/// script builds rather than a second copy of them.
fn repo_constant(script: &str) -> Result<String> {
    Ok(script
        .lines()
        .find_map(|line| line.strip_prefix("REPO="))
        .context("install.sh assigns no REPO")?
        .trim_matches('"')
        .to_owned())
}

/// What the fixture cannot show, asserted where it can be: the archive it
/// builds is laid out the way the workflow that publishes the real one lays it
/// out. A release staged under another name would install nothing.
#[test]
fn the_fixtures_archive_is_shaped_the_way_release_yml_stages_one() -> Result<()> {
    let workflow = std::fs::read_to_string(repo_root().join(".github/workflows/release.yml"))?;
    assert!(
        workflow.contains(r#"stage="yantra-${VERSION}-${TARGET}""#),
        "release.yml no longer stages the directory install.sh looks for inside the archive"
    );
    // The security half of Y-365: a unit outside the archive is outside
    // SHA256SUMS, and install.sh writes both of them into /etc/systemd/system
    // as root.
    for unit in [
        "crates/yantrad/yantrad.service",
        "crates/yantra-agent/yantra-agent.service",
    ] {
        assert!(
            workflow.contains(unit),
            "release.yml no longer stages {unit}, so the archive install.sh verifies would not carry it"
        );
    }
    Ok(())
}

/// The row's evidence, and all of it is about the second run: an `agent.env`
/// somebody edited is still theirs afterwards, three binaries are replaced
/// under an executing one, and the release the second run installs is a newer
/// one that nobody wrote into the script (Y-365).
#[test]
fn a_second_run_replaces_a_running_binary_and_leaves_an_edited_agent_env_alone() -> Result<()> {
    let Some(fixture) = Installer::start()? else {
        return Ok(());
    };

    fixture.publish(VERSION, "first")?;
    let first = fixture.install_ok()?;
    assert!(
        first.contains(&format!("install: yantra v{VERSION},")),
        "the version has to come off the release list, since install.sh names none:\n{first}"
    );
    assert!(
        first.contains("Tailscale is not installed."),
        "the report has to name what this container does not have:\n{first}"
    );
    assert!(
        first.contains("Install Tailscale and enrol this box."),
        "and say what is left to do about it:\n{first}"
    );

    fixture.sh("id yantra")?;
    for binary in BINARIES {
        assert_eq!(
            fixture
                .sh(&format!("stat -c '%a %U' /usr/local/bin/{binary}"))?
                .trim(),
            "755 root"
        );
        assert_eq!(
            fixture.sha(&format!("/usr/local/bin/{binary}"))?,
            fixture.sha(&format!("/srv/staging/yantra-*/{binary}"))?,
            "{binary} is not the one the archive carried"
        );
    }

    for unit in UNITS {
        let verify = fixture.systemd.exec(&[
            "systemd-analyze",
            "verify",
            &format!("/etc/systemd/system/{unit}"),
        ])?;
        assert_eq!(
            String::from_utf8_lossy(&verify.stderr).trim(),
            "",
            "systemd has a complaint about the {unit} the script installed"
        );
        // Y-365: the unit is the archive's, so SHA256SUMS covered it. Fetched
        // from anywhere else it would not carry this publication's marker.
        assert_eq!(
            fixture.sha(&format!("/etc/systemd/system/{unit}"))?,
            fixture.sha(&format!("/srv/staging/yantra-*/{unit}"))?,
            "{unit} is not the one the archive carried"
        );
        assert_eq!(fixture.systemd.property(unit, "LoadState")?, "loaded");
        assert_eq!(
            fixture.systemd.property(unit, "UnitFileState")?,
            "disabled",
            "{unit} is the owner's to enable"
        );
    }

    assert_eq!(
        fixture.sh("stat -c '%a %U' /etc/yantra/agent.env")?.trim(),
        "644 root"
    );
    let scaffolded = fixture.sh("cat /etc/yantra/agent.env")?;
    assert!(
        scaffolded.contains("#YANTRA_DAEMON="),
        "the address is the one thing an install may not write (ADR-0013 §4):\n{scaffolded}"
    );

    // ADR-0021's only mitigation, so it is asserted rather than commented. The
    // token goes in this file in plain text: nobody but the account the daemon
    // runs as may read it, and that account must be able to *write* it, which
    // is why the owner is `yantra` where `agent.env` above is root's.
    assert_eq!(
        fixture.sh("stat -c '%a %U' /etc/yantra/daemon.env")?.trim(),
        "600 yantra"
    );
    let relay = fixture.sh("cat /etc/yantra/daemon.env")?;
    assert!(
        relay.contains("#YANTRA_NTFY_URL="),
        "an install writes the file and never a relay into it:\n{relay}"
    );

    assert_eq!(
        fixture.scratch_dirs()?.trim(),
        "0",
        "the download outlived the run"
    );

    // Everything above is the arrangement; the run below is the row.
    fixture.sh(&format!(
        "printf '%s\\n' '{EDITED_ENV}' > /etc/yantra/agent.env"
    ))?;
    let edited = fixture.sha("/etc/yantra/agent.env")?;
    fixture.sh(&format!(
        "printf '%s\\n' '{EDITED_RELAY}' > /etc/yantra/daemon.env"
    ))?;
    let relay_edited = fixture.sha("/etc/yantra/daemon.env")?;
    let before: Vec<String> = BINARIES
        .iter()
        .map(|binary| fixture.sha(&format!("/usr/local/bin/{binary}")))
        .collect::<Result<_>>()?;
    let units_before: Vec<String> = UNITS
        .iter()
        .map(|unit| fixture.sha(&format!("/etc/systemd/system/{unit}")))
        .collect::<Result<_>>()?;

    fixture.sh(&format!(
        "systemd-run --unit={AGENT_UNIT} --collect /usr/local/bin/yantra-agent infinity"
    ))?;
    let pid = fixture
        .systemd
        .property(&format!("{AGENT_UNIT}.service"), "MainPID")?;

    // What makes the rename evidence rather than ceremony: the same file, the
    // same moment, written the way an installer would naively write it.
    let naive = fixture
        .systemd
        .exec(&["cp", "/usr/bin/true", "/usr/local/bin/yantra-agent"])?;
    assert!(
        String::from_utf8_lossy(&naive.stderr).contains("Text file busy"),
        "a binary that is executing must refuse a write, or the rename is asserting nothing"
    );

    // The one Tailscale branch a container can reach on top of "not installed".
    fixture.sh("printf '#!/bin/sh\\nexit 1\\n' > /usr/local/bin/tailscale")?;
    fixture.sh("chmod 755 /usr/local/bin/tailscale")?;

    fixture.publish(NEXT_VERSION, "second")?;
    let second = fixture.install_ok()?;
    assert!(
        second.contains(&format!("install: yantra v{NEXT_VERSION},")),
        "the second run must follow the release rather than the file, with nothing edited:\n{second}"
    );
    assert!(
        second.contains("/etc/yantra/agent.env was already here and was left alone."),
        "the second run must say it left the address alone:\n{second}"
    );
    assert!(
        second.contains("Tailscale is installed, not up."),
        "the report is read off the machine rather than printed:\n{second}"
    );
    assert!(
        second.contains("Enrol this box:"),
        "and the step follows the state it just reported:\n{second}"
    );

    for (binary, was) in BINARIES.iter().zip(&before) {
        let now = fixture.sha(&format!("/usr/local/bin/{binary}"))?;
        assert_ne!(&now, was, "{binary} was not replaced by the second run");
        assert_eq!(
            now,
            fixture.sha(&format!("/srv/staging/yantra-*/{binary}"))?,
            "{binary} is not the one the second archive carried"
        );
    }

    for (unit, was) in UNITS.iter().zip(&units_before) {
        let now = fixture.sha(&format!("/etc/systemd/system/{unit}"))?;
        assert_ne!(&now, was, "{unit} was not replaced by the second run");
        assert_eq!(
            now,
            fixture.sha(&format!("/srv/staging/yantra-*/{unit}"))?,
            "{unit} is not the one the second archive carried"
        );
    }

    assert_eq!(
        fixture.sha("/etc/yantra/agent.env")?,
        edited,
        "the second run rewrote an address that was not its to know (ADR-0013 §4)"
    );
    assert_eq!(
        fixture.sha("/etc/yantra/daemon.env")?,
        relay_edited,
        "an update rewrote the relay somebody had set (ADR-0021)"
    );
    assert_eq!(
        fixture
            .systemd
            .property(&format!("{AGENT_UNIT}.service"), "ActiveState")?,
        "active",
        "replacing the binary under it killed the agent:\n{}",
        fixture.systemd.journal(&format!("{AGENT_UNIT}.service"))
    );
    assert_eq!(
        fixture
            .systemd
            .property(&format!("{AGENT_UNIT}.service"), "MainPID")?,
        pid,
        "the agent was restarted rather than left running"
    );
    assert!(
        fixture
            .sh(&format!("readlink /proc/{pid}/exe"))?
            .contains("(deleted)"),
        "the running agent should still be executing the file the rename unlinked"
    );
    assert_eq!(
        fixture.scratch_dirs()?.trim(),
        "0",
        "the download outlived the run"
    );
    Ok(())
}

/// Verification is ahead of every privileged step, so a refusal leaves a box
/// exactly as it found it — no account, no binaries, no units.
#[test]
fn a_corrupted_archive_is_refused_and_nothing_is_installed() -> Result<()> {
    let Some(fixture) = Installer::start()? else {
        return Ok(());
    };

    fixture.publish(VERSION, "corrupt")?;
    fixture.release(&["corrupt", &fixture.repo, VERSION])?;

    let out = fixture.install()?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "a corrupted archive was installed");
    assert!(
        stderr.contains("does not match SHA256SUMS — nothing was installed"),
        "the refusal must name what failed:\n{stderr}"
    );

    fixture.nothing_is_installed("the archive did not verify")
}

/// Every release up to v0.1.0 carries no units in its archive, and `install.sh`
/// now takes them from there. A version that predates them says so, ahead of
/// the first privileged step, rather than failing on a missing file.
#[test]
fn a_release_whose_archive_carries_no_units_is_refused() -> Result<()> {
    let Some(fixture) = Installer::start()? else {
        return Ok(());
    };

    fixture.publish(VERSION, "unitless")?;
    fixture.release(&["strip_units", &fixture.repo, VERSION])?;

    let out = fixture.install()?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !out.status.success(),
        "a release with no units in it installed anyway"
    );
    assert!(
        stderr.contains("carries no units"),
        "the refusal must name what is missing:\n{stderr}"
    );

    fixture.nothing_is_installed("the archive carried no units")
}

/// A release list that does not answer resolves no version, and the script
/// stops there — a `403` from the unauthenticated rate limit takes this same
/// branch (ADR-0027 §4). `YANTRA_VERSION` is the way past it, and it reads no
/// release list at all.
#[test]
fn an_unresolvable_release_list_installs_nothing_until_a_version_is_named() -> Result<()> {
    let Some(fixture) = Installer::start()? else {
        return Ok(());
    };

    fixture.publish(VERSION, "unresolvable")?;
    fixture.release(&["unresolvable", &fixture.repo])?;

    let out = fixture.install()?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !out.status.success(),
        "a run that resolved no version installed something"
    );
    assert!(
        stderr.contains("404") && stderr.contains("nothing was installed"),
        "the refusal must name the answer it got and say it installed nothing:\n{stderr}"
    );
    fixture.nothing_is_installed("no version resolved")?;

    // The archive was installable the whole time, which is what makes the
    // refusal above about the release list and nothing else.
    let named = fixture.install_version(VERSION)?;
    assert!(
        named.status.success(),
        "YANTRA_VERSION must install without reading the release list: {}",
        String::from_utf8_lossy(&named.stderr).trim()
    );
    for binary in BINARIES {
        assert_eq!(
            fixture.sha(&format!("/usr/local/bin/{binary}"))?,
            fixture.sha(&format!("/srv/staging/yantra-*/{binary}"))?,
            "{binary} is not the one the named release carried"
        );
    }
    Ok(())
}

fn last_line(screen: &str) -> &str {
    screen
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("")
}

const HTTP_URL: &str = "install: open the dashboard at http://127.0.0.1:7717";

/// HTTPS is the one step that may fail without stopping the install: a
/// `serve` that refuses, and one a person Ctrl-Cs while it waits on its link,
/// both end on an installed box answering plain HTTP.
#[test]
fn at_a_terminal_a_serve_that_fails_or_is_interrupted_still_ends_on_http() -> Result<()> {
    let Some(fixture) = Installer::start()? else {
        return Ok(());
    };
    fixture.arrange_tailnet()?;
    fixture.sh("touch /var/tmp/tailscale-stub/serve-fails")?;

    fixture.publish(VERSION, "unserved")?;
    let refused = fixture.install_at_terminal("y\n")?;
    assert!(
        refused.contains("tailscale serve failed"),
        "a refused serve must be said:\n{refused}"
    );
    for unit in UNITS {
        assert_eq!(fixture.systemd.property(unit, "UnitFileState")?, "enabled");
    }
    assert_eq!(last_line(&refused), HTTP_URL);

    // A SIGINT reaches the whole foreground group, the script included.
    fixture.sh(
        "rm /var/tmp/tailscale-stub/serve-fails && touch /var/tmp/tailscale-stub/serve-waits",
    )?;
    let interrupted = fixture.install_interrupted("y\n", "To enable, visit")?;
    assert!(
        interrupted.contains("Turn on HTTPS for the dashboard? [Y/n]"),
        "a logged-in box with no HTTPS is asked about HTTPS alone:\n{interrupted}"
    );
    assert!(
        interrupted.contains("tailscale serve failed"),
        "{interrupted}"
    );
    assert_eq!(
        last_line(&interrupted),
        HTTP_URL,
        "a Ctrl-C at the HTTPS link must not end the install"
    );
    Ok(())
}

/// Already logged in, so the one question is HTTPS — and a no to it is still
/// an install that starts the dashboard.
#[test]
fn at_a_terminal_a_no_to_https_on_a_logged_in_box_still_starts_the_dashboard() -> Result<()> {
    let Some(fixture) = Installer::start()? else {
        return Ok(());
    };
    fixture.arrange_tailnet()?;
    fixture.sh("touch /var/tmp/tailscale-stub/up")?;

    fixture.publish(VERSION, "plain")?;
    let screen = fixture.install_at_terminal("n\n")?;
    assert!(
        screen.contains("Turn on HTTPS for the dashboard? [Y/n]"),
        "{screen}"
    );
    let calls = fixture.tailscale_calls()?;
    assert!(
        !calls
            .iter()
            .any(|c| c == "up" || c.starts_with("serve --bg")),
        "a no changed Tailscale's settings: {calls:?}"
    );
    for unit in UNITS {
        assert_eq!(fixture.systemd.property(unit, "UnitFileState")?, "enabled");
    }
    assert_eq!(last_line(&screen), HTTP_URL);
    Ok(())
}

/// Y-384's row: a yes logs the box in, turns on HTTPS, writes this box's own
/// address, starts both units and ends on the dashboard's URL. The second run
/// is the updater — it asks nothing and leaves every file and setting alone.
#[test]
fn at_a_terminal_a_yes_starts_the_dashboard_and_a_second_run_asks_nothing() -> Result<()> {
    let Some(fixture) = Installer::start()? else {
        return Ok(());
    };
    fixture.arrange_tailnet()?;

    fixture.publish(VERSION, "first")?;
    let first = fixture.install_at_terminal("y\n")?;
    assert!(
        first.contains("Log this box in to Tailscale and turn on HTTPS? [Y/n]"),
        "a logged-out box must be asked before it is logged in:\n{first}"
    );
    assert!(
        first.contains("certificate log"),
        "the name going public is said before HTTPS is turned on:\n{first}"
    );
    assert!(
        first.contains("Disable key expiry"),
        "an untagged node expires unless the owner says otherwise:\n{first}"
    );
    let calls = fixture.tailscale_calls()?;
    assert!(
        calls.iter().any(|c| c == "up"),
        "the yes ran no login: {calls:?}"
    );
    assert!(
        calls
            .iter()
            .any(|c| c == "serve --bg --https=8443 http://127.0.0.1:7717"),
        "HTTPS goes in front of the daemon's own address, as `just https` does: {calls:?}"
    );

    let env = fixture.sh("cat /etc/yantra/agent.env")?;
    assert!(
        env.lines().any(|l| l == "YANTRA_DAEMON=127.0.0.1:7717"),
        "an absent agent.env is written with this box's address:\n{env}"
    );
    for unit in UNITS {
        assert_eq!(fixture.systemd.property(unit, "UnitFileState")?, "enabled");
    }
    assert_eq!(
        last_line(&first),
        "install: open the dashboard at https://yantra-box.tail0000.ts.net:8443",
        "the run ends on the one line a person needs"
    );

    // An edited address stands for any configuration a person made afterwards.
    fixture.sh(&format!(
        "printf '%s\\n' '{EDITED_ENV}' > /etc/yantra/agent.env"
    ))?;
    let edited = fixture.sha("/etc/yantra/agent.env")?;
    let relay = fixture.sha("/etc/yantra/daemon.env")?;
    let before = calls.len();

    fixture.publish(NEXT_VERSION, "second")?;
    let second = fixture.install_at_terminal("")?;
    assert!(
        !second.contains("[Y/n]"),
        "the updater asked something it already had an answer to:\n{second}"
    );
    assert!(
        second.contains(&format!("install: yantra v{NEXT_VERSION},")),
        "{second}"
    );
    let later = &fixture.tailscale_calls()?[before..];
    assert!(
        !later
            .iter()
            .any(|c| c == "up" || c.starts_with("serve --bg")),
        "the updater touched Tailscale's settings: {later:?}"
    );
    assert_eq!(
        fixture.sha("/etc/yantra/agent.env")?,
        edited,
        "the updater rewrote agent.env"
    );
    assert_eq!(
        fixture.sha("/etc/yantra/daemon.env")?,
        relay,
        "the updater rewrote daemon.env"
    );
    for binary in BINARIES {
        assert_eq!(
            fixture.sha(&format!("/usr/local/bin/{binary}"))?,
            fixture.sha(&format!("/srv/staging/yantra-*/{binary}"))?,
            "{binary} is not the one the second archive carried"
        );
    }
    assert_eq!(
        last_line(&second),
        "install: open the dashboard at https://yantra-box.tail0000.ts.net:8443"
    );
    Ok(())
}

/// A no to Tailscale installs Yantra and nothing else, and the run ends the way
/// a run with no terminal does: nothing enabled and the steps named.
#[test]
fn at_a_terminal_a_no_to_tailscale_installs_yantra_and_starts_nothing() -> Result<()> {
    let Some(fixture) = Installer::start()? else {
        return Ok(());
    };

    fixture.publish(VERSION, "declined")?;
    let screen = fixture.install_at_terminal("n\n")?;
    assert!(
        screen.contains("Install Tailscale, log this box in and turn on HTTPS? [Y/n]"),
        "a box with no Tailscale must be asked:\n{screen}"
    );
    assert!(
        !fixture
            .systemd
            .exec(&["bash", "-c", "command -v tailscale"])?
            .status
            .success(),
        "a no installed Tailscale anyway"
    );
    assert!(screen.contains("Tailscale is not installed."), "{screen}");
    let env = fixture.sh("cat /etc/yantra/agent.env")?;
    assert!(
        env.contains("#YANTRA_DAEMON="),
        "with no tailnet there is no address to write:\n{env}"
    );
    for unit in UNITS {
        assert_eq!(fixture.systemd.property(unit, "UnitFileState")?, "disabled");
    }
    Ok(())
}
