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
//! `github.com` and `raw.githubusercontent.com` at a local HTTPS server whose
//! certificate is in the container's trust store, so `curl`, TLS, the URLs the
//! script builds and the checksums are all real — and so is a corrupted
//! archive, which the published host cannot serve. The cost is that the archive
//! is this fixture's rather than a published one, so the shape of it is
//! asserted against `release.yml`, which is what produces the real one.
//!
//! It runs as an unprivileged account through `sudo`, the way
//! `docs/appliance.md` says to run it: as root every missing `as_root` passes.
//!
//! Nothing here holds a `tailscaled`, so the Tailscale step is proved by its
//! report — twice, because a report that never changes is a constant.

mod common;

use std::process::Output;

use anyhow::{Context, Result, bail};

use common::{Systemd, UNPRIVILEGED, fixture_dir, repo_root};

const BINARIES: [&str; 3] = ["yantrad", "yantra", "yantra-agent"];

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

/// The container, the release it is served, and `install.sh`'s own constants.
struct Installer {
    systemd: Systemd,
    repo: String,
    version: String,
    commit: String,
}

impl Installer {
    fn start() -> Result<Option<Self>> {
        let script = std::fs::read_to_string(repo_root().join("install.sh"))?;
        let Some(systemd) = Systemd::start()? else {
            return Ok(None);
        };
        let installer = Self {
            repo: constant(&script, "REPO")?,
            version: constant(&script, "VERSION")?,
            commit: constant(&script, "COMMIT")?,
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

    /// `marker` goes into every file of the archive, so a run that installed
    /// the other publication is a different checksum rather than a guess.
    fn publish(&self, marker: &str) -> Result<()> {
        self.release(&["publish", &self.repo, &self.version, &self.commit, marker])?;
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
}

/// `install.sh`'s own constants, so the fixture serves the URLs the script
/// builds rather than a second copy of them: bump one and this follows.
fn constant(script: &str, name: &str) -> Result<String> {
    let assignment = format!("{name}=");
    let value = script
        .lines()
        .find_map(|line| line.strip_prefix(&assignment))
        .with_context(|| format!("install.sh assigns no {name}"))?
        .trim_matches('"');
    let Some(parameter) = value.strip_prefix("${") else {
        return Ok(value.to_owned());
    };
    Ok(parameter
        .split_once(":-")
        .and_then(|(_, default)| default.strip_suffix('}'))
        .with_context(|| format!("{name} is not `${{OVERRIDE:-default}}`"))?
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
    Ok(())
}

/// The row's evidence, and all of it is about the second run: an `agent.env`
/// somebody edited is still theirs afterwards, and three binaries are replaced
/// under an executing one.
#[test]
fn a_second_run_replaces_a_running_binary_and_leaves_an_edited_agent_env_alone() -> Result<()> {
    let Some(fixture) = Installer::start()? else {
        return Ok(());
    };

    fixture.publish("first")?;
    let first = fixture.install_ok()?;
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

    for unit in ["yantrad.service", "yantra-agent.service"] {
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

    fixture.publish("second")?;
    let second = fixture.install_ok()?;
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

    fixture.publish("corrupt")?;
    fixture.release(&["corrupt", &fixture.repo, &fixture.version])?;

    let out = fixture.install()?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "a corrupted archive was installed");
    assert!(
        stderr.contains("does not match SHA256SUMS — nothing was installed"),
        "the refusal must name what failed:\n{stderr}"
    );

    for binary in BINARIES {
        assert!(
            !fixture
                .systemd
                .exec(&["test", "-e", &format!("/usr/local/bin/{binary}")])?
                .status
                .success(),
            "{binary} was installed from an archive that did not verify"
        );
    }
    for path in ["/etc/yantra", "/etc/systemd/system/yantrad.service"] {
        assert!(
            !fixture
                .systemd
                .exec(&["test", "-e", path])?
                .status
                .success(),
            "{path} was written before the archive was checked"
        );
    }
    assert!(
        !fixture.systemd.exec(&["id", "yantra"])?.status.success(),
        "the account outlived a run that installed nothing"
    );
    assert_eq!(
        fixture.scratch_dirs()?.trim(),
        "0",
        "the download outlived the run"
    );
    Ok(())
}
