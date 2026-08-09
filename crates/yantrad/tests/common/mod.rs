//! A disposable container running a real `systemd` as PID 1, for the tests that
//! need one (Y-142, Y-158).
//!
//! The sshd + tmux fixture next door (`yantra-core/tests/common`) exists because
//! mocks lie about SSH; this one exists for the same reason one layer out, since
//! a unit file — and a script that installs one — is worth only what a real
//! `systemd` says about it. Teardown is in `Drop`, so it also runs when a test
//! panics.

// Included by more than one test binary; each uses a different subset.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};

/// Bump the tag when `tests/fixture/Containerfile` changes; the image is built
/// once and then reused from the local store.
const IMAGE: &str = "localhost/yantra-systemd:3";
const BOOT_TIMEOUT: Duration = Duration::from_secs(60);
const BUILD_ATTEMPTS: u32 = 2;
const BUILD_RETRY_PAUSE: Duration = Duration::from_secs(2);

/// The account the image carries for the steps that must not be root's
/// (`docs/appliance.md`).
pub const UNPRIVILEGED: &str = "deploy";

/// A container running systemd as PID 1, removed on drop.
#[derive(Debug)]
pub struct Systemd {
    container: String,
}

impl Systemd {
    /// Starts the fixture, or returns `Ok(None)` when `podman` is not installed
    /// so that such a machine skips the test rather than failing it.
    ///
    /// `YANTRA_REQUIRE_PODMAN` turns that skip into a failure (I-32).
    pub fn start() -> Result<Option<Self>> {
        if !podman(&["--version"]).is_ok_and(|out| out.status.success()) {
            if std::env::var_os("YANTRA_REQUIRE_PODMAN").is_some() {
                bail!(
                    "YANTRA_REQUIRE_PODMAN is set but `podman` is not available, so the real \
                     systemd fixture cannot run"
                );
            }
            eprintln!(
                "SKIPPED: `podman` is not available, so the real systemd fixture cannot run. \
                 Install it (see docs/development.md) to exercise this test."
            );
            return Ok(None);
        }
        ensure_image()?;

        let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let name = format!("yantra-systemd-{}-{stamp}", std::process::id());
        let out = podman(&[
            "run",
            "-d",
            "--rm",
            "--name",
            &name,
            // Lets a leaked container be found: `podman ps -a --filter label=yantra-fixture`.
            "--label",
            "yantra-fixture=1",
            // The cgroup, /run and /sys/fs/cgroup arrangement systemd needs as PID 1.
            "--systemd=always",
            IMAGE,
        ])?;
        if !out.status.success() {
            bail!(
                "podman run failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }

        // Every fallible step from here on is covered by `Drop`.
        let fixture = Self { container: name };
        fixture.wait_until_booted()?;
        Ok(Some(fixture))
    }

    pub fn exec(&self, args: &[&str]) -> Result<Output> {
        let mut argv = vec!["exec", &self.container];
        argv.extend_from_slice(args);
        podman(&argv)
    }

    /// `exec`, as an account that is not root.
    pub fn exec_as(&self, user: &str, args: &[&str]) -> Result<Output> {
        let mut argv = vec!["exec", "-u", user, &self.container];
        argv.extend_from_slice(args);
        podman(&argv)
    }

    /// Runs `args` in the container and returns stdout, failing the test with
    /// whatever the command said if it did not succeed.
    pub fn run(&self, args: &[&str]) -> Result<String> {
        let out = self.exec(args)?;
        if !out.status.success() {
            bail!(
                "`{}` failed ({}): {}",
                args.join(" "),
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(String::from_utf8(out.stdout)?)
    }

    pub fn copy_in(&self, from: &Path, to: &str) -> Result<()> {
        let out = podman(&[
            "cp",
            &from.display().to_string(),
            &format!("{}:{to}", self.container),
        ])?;
        if !out.status.success() {
            bail!(
                "copying {} into the container failed: {}",
                from.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(())
    }

    /// What the install has to have done before a unit naming `User=yantra` can
    /// run at all. Not something Yantra does at run time — the fixture arranges
    /// the machine, exactly as the sshd one does.
    pub fn arrange_account(&self) -> Result<()> {
        self.run(&[
            "useradd",
            "--system",
            "--create-home",
            "--home-dir",
            "/home/yantra",
            "--shell",
            "/usr/sbin/nologin",
            "yantra",
        ])?;
        Ok(())
    }

    pub fn install_unit(&self, name: &str) -> Result<()> {
        self.copy_in(
            &repo_root().join("crates").join(unit_source(name)),
            &format!("/etc/systemd/system/{name}"),
        )?;
        self.run(&["systemctl", "daemon-reload"])?;
        Ok(())
    }

    pub fn property(&self, unit: &str, name: &str) -> Result<String> {
        Ok(self
            .run(&["systemctl", "show", unit, "-p", name, "--value"])?
            .trim()
            .to_owned())
    }

    pub fn journal(&self, unit: &str) -> String {
        self.run(&["journalctl", "-u", unit, "--no-pager"])
            .unwrap_or_else(|e| e.to_string())
    }

    /// systemd needs a moment as PID 1; poll until it says where it got to.
    /// `degraded` is expected — `systemd-resolved` and `systemd-oomd` have no
    /// business succeeding in a container and are nothing to do with the units
    /// under test.
    fn wait_until_booted(&self) -> Result<()> {
        let deadline = Instant::now() + BOOT_TIMEOUT;
        let mut last = String::new();
        while Instant::now() < deadline {
            match self.exec(&["systemctl", "is-system-running"]) {
                Ok(out) => {
                    last = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if matches!(last.as_str(), "running" | "degraded" | "maintenance") {
                        return Ok(());
                    }
                }
                Err(e) => last = e.to_string(),
            }
            sleep(Duration::from_millis(200));
        }
        bail!(
            "systemd in {} never finished booting: {last}",
            self.container
        )
    }
}

impl Drop for Systemd {
    fn drop(&mut self) {
        // Best effort by design: this also runs while a test is panicking, and
        // a failure to clean up must not mask the original failure.
        let _ = podman(&["rm", "-f", "-t", "0", &self.container]);
    }
}

fn podman(args: &[&str]) -> Result<Output> {
    Command::new("podman")
        .args(args)
        .output()
        .context("spawning podman")
}

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture")
}

fn unit_source(name: &str) -> String {
    let crate_dir = name.trim_end_matches(".service");
    format!("{crate_dir}/{name}")
}

/// Builds the image on first use; later runs reuse it from the local store.
/// The build fetches Fedora packages, so it gets a second attempt (Y-133).
fn ensure_image() -> Result<()> {
    if podman(&["image", "exists", IMAGE])?.status.success() {
        return Ok(());
    }
    let context = fixture_dir();
    let mut failures = Vec::new();
    for attempt in 1..=BUILD_ATTEMPTS {
        if attempt > 1 {
            sleep(BUILD_RETRY_PAUSE);
        }
        let out = Command::new("podman")
            .args(["build", "-t", IMAGE, "."])
            .current_dir(&context)
            .output()
            .context("spawning podman build")?;
        if out.status.success() {
            return Ok(());
        }
        failures.push(format!(
            "attempt {attempt}/{BUILD_ATTEMPTS} ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    bail!(
        "building {IMAGE} from {} failed every attempt:\n{}",
        context.display(),
        failures.join("\n")
    );
}
