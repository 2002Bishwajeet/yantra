//! A disposable sshd + tmux container, for integration tests that must talk to
//! a real remote (Y-031).
//!
//! Mocks lie about SSH, so anything in the transport or session layer is tested
//! against the real thing. A container is a truer stand-in for a remote machine
//! than `ssh localhost` — separate filesystem, separate user, real network hop —
//! and it leaves nothing running on the developer's box.
//!
//! We shell out to the `podman` CLI rather than pull in a container crate: the
//! daemon already orchestrates `ssh`, `tmux` and `tailscale` the same way
//! (CLAUDE.md §B2), and `podman run` is a stabler interface than any wrapper.
//!
//! Two properties matter and are both enforced here:
//!
//! * **Nothing of the developer's is touched.** A keypair is generated per run,
//!   and every `ssh` invocation passes `-F /dev/null` and `IdentityAgent=none`
//!   so `~/.ssh` is neither read nor consulted.
//! * **Nothing is left behind.** Teardown is in `Drop`, so it also runs when a
//!   test panics.

// Included by more than one test binary; each uses a different subset.
#![allow(dead_code)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};

/// Bump the tag when `tests/fixture/Containerfile` changes; the image is built
/// once and then reused from the local store.
const IMAGE: &str = "localhost/yantra-fixture:2";
pub const USER: &str = "yantra";
const HOST: &str = "127.0.0.1";
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const BUILD_ATTEMPTS: u32 = 2;
const BUILD_RETRY_PAUSE: Duration = Duration::from_secs(2);
const RUN_ATTEMPTS: u32 = 5;
const RUN_RETRY_PAUSE: Duration = Duration::from_millis(250);

/// A running container with sshd and tmux inside, removed on drop.
#[derive(Debug)]
pub struct SshFixture {
    container: String,
    port: u16,
    /// Holds the ephemeral keypair. Removed on drop along with the container.
    dir: PathBuf,
}

impl SshFixture {
    /// Starts the fixture, or returns `Ok(None)` when `podman` is not installed
    /// so that such a machine skips the test rather than failing it.
    ///
    /// Set `YANTRA_REQUIRE_PODMAN` to turn that skip into a failure. CI sets it,
    /// because there a silent skip means this test stopped checking anything.
    pub fn start() -> Result<Option<Self>> {
        if !podman(&["--version"]).is_ok_and(|out| out.status.success()) {
            if std::env::var_os("YANTRA_REQUIRE_PODMAN").is_some() {
                anyhow::bail!(
                    "YANTRA_REQUIRE_PODMAN is set but `podman` is not available, so the real \
                     sshd + tmux fixture cannot run"
                );
            }
            eprintln!(
                "SKIPPED: `podman` is not available, so the real sshd + tmux fixture \
                 cannot run. Install it (see docs/development.md) to exercise this test."
            );
            return Ok(None);
        }
        ensure_image()?;

        let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let name = format!("yantra-fixture-{}-{stamp}", std::process::id());
        let dir = std::env::temp_dir().join(&name);
        fs::create_dir(&dir).with_context(|| format!("creating {}", dir.display()))?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;

        // Every fallible step from here on is covered by `Drop`.
        let mut fixture = Self {
            container: name,
            port: 0,
            dir,
        };
        fixture.keygen()?;
        fixture.run_container()?;
        fixture.port = fixture.published_port()?;
        fixture.wait_until_ready()?;
        Ok(Some(fixture))
    }

    pub fn host(&self) -> &str {
        HOST
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The private key for this run, and only this run.
    pub fn key_path(&self) -> PathBuf {
        self.dir.join("id_ed25519")
    }

    /// Root inside the container, bypassing SSH. Setup only — rearranging the
    /// machine is not something Yantra does, so it does not go through `Exec`.
    pub fn arrange_as_root(&self, command: &str) -> Result<()> {
        let out = podman(&["exec", "-u", "root", &self.container, "sh", "-c", command])?;
        if !out.status.success() {
            bail!(
                "arranging `{command}` failed ({}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(())
    }

    /// Runs `command` in the container over SSH and returns its stdout.
    pub fn run(&self, command: &str) -> Result<String> {
        let out = self.ssh(command)?;
        if !out.status.success() {
            bail!(
                "`{command}` failed ({}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(String::from_utf8(out.stdout)?)
    }

    fn ssh(&self, command: &str) -> Result<std::process::Output> {
        Command::new("ssh")
            // `-F /dev/null` and `IdentityAgent=none` keep the developer's own
            // SSH config, keys and agent entirely out of the test.
            .args(["-F", "/dev/null"])
            .arg("-i")
            .arg(self.key_path())
            .args(["-p", &self.port.to_string()])
            .args([
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "IdentityAgent=none",
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                "UserKnownHostsFile=/dev/null",
                "-o",
                "GlobalKnownHostsFile=/dev/null",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=5",
                "-o",
                "LogLevel=ERROR",
            ])
            .arg(format!("{USER}@{HOST}"))
            .arg("--")
            .arg(command)
            .output()
            .context("spawning ssh")
    }

    fn keygen(&self) -> Result<()> {
        let out = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-C", "yantra-fixture"])
            .arg("-f")
            .arg(self.key_path())
            .output()
            .context("spawning ssh-keygen")?;
        if !out.status.success() {
            bail!(
                "ssh-keygen failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(())
    }

    /// Starts the container, asking again when it lost the race for its host
    /// port.
    ///
    /// `podman` chooses the port by binding zero and closing the socket, then
    /// its forwarder binds the number again — so a parallel run, or one of this
    /// suite's own loopback `ssh` connections, can take it in between. The port
    /// is not ours to reserve, so asking again is the only move we have, and a
    /// new attempt draws a new number.
    fn run_container(&self) -> Result<()> {
        let pubkey = fs::read_to_string(self.dir.join("id_ed25519.pub"))?;
        let mut failures = Vec::new();
        for attempt in 1..=RUN_ATTEMPTS {
            if attempt > 1 {
                // A run that got far enough to fail may hold the name we reuse.
                let _ = podman(&["rm", "-f", "-t", "0", &self.container]);
                sleep(RUN_RETRY_PAUSE);
            }
            let out = podman(&[
                "run",
                "-d",
                "--rm",
                "--name",
                &self.container,
                // Lets a leaked container be found: `podman ps -a --filter label=yantra-fixture`.
                "--label",
                "yantra-fixture=1",
                "-p",
                "127.0.0.1::22",
                "-e",
                &format!("YANTRA_PUBKEY={}", pubkey.trim()),
                IMAGE,
            ])?;
            if out.status.success() {
                return Ok(());
            }
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let collided = lost_the_port_race(&stderr);
            failures.push(format!(
                "attempt {attempt}/{RUN_ATTEMPTS} ({}): {stderr}",
                out.status
            ));
            if !collided {
                break;
            }
        }
        bail!("podman run failed:\n{}", failures.join("\n"))
    }

    fn published_port(&self) -> Result<u16> {
        let out = podman(&["port", &self.container, "22/tcp"])?;
        let mapping = String::from_utf8(out.stdout)?;
        // `127.0.0.1:38271` — take the port off the last (possibly IPv6) colon.
        mapping
            .trim()
            .rsplit(':')
            .next()
            .and_then(|p| p.parse().ok())
            .with_context(|| format!("no host port published for 22/tcp: {mapping:?}"))
    }

    /// sshd needs a moment after the container starts; poll until it answers.
    fn wait_until_ready(&self) -> Result<()> {
        let deadline = Instant::now() + READY_TIMEOUT;
        let mut last = String::new();
        while Instant::now() < deadline {
            match self.ssh("true") {
                Ok(out) if out.status.success() => return Ok(()),
                Ok(out) => last = String::from_utf8_lossy(&out.stderr).trim().to_string(),
                Err(e) => last = e.to_string(),
            }
            sleep(Duration::from_millis(200));
        }
        bail!("sshd in {} never became reachable: {last}", self.container)
    }
}

impl Drop for SshFixture {
    fn drop(&mut self) {
        // Best effort by design: this also runs while a test is panicking, and
        // a failure to clean up must not mask the original failure.
        let _ = podman(&["rm", "-f", "-t", "0", &self.container]);
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Whether `podman run` failed because something else already held the host
/// port it had picked. `rootlessport` and `pasta` word it differently, and
/// which one reports it depends on the machine, so match the half they share.
pub fn lost_the_port_race(stderr: &str) -> bool {
    stderr
        .to_ascii_lowercase()
        .contains("address already in use")
}

fn podman(args: &[&str]) -> Result<std::process::Output> {
    Command::new("podman")
        .args(args)
        .output()
        .context("spawning podman")
}

/// Builds the image on first use; later runs reuse it from the local store.
///
/// The build fetches Alpine packages, so on a fresh CI runner the whole suite
/// sits behind one third-party fetch; it gets a second attempt (Y-133).
fn ensure_image() -> Result<()> {
    if podman(&["image", "exists", IMAGE])?.status.success() {
        return Ok(());
    }
    let context = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixture");
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
