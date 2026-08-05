//! The service units under a real `systemd`, in a disposable podman container
//! (§B3, Y-142).
//!
//! **Q19's answer is yes, up to one boundary.** A real systemd in a container
//! shows that a unit parses, enables, starts, and — the part the whole design
//! rests on — that a daemon refusing the way `listen_on` refuses is *retried*
//! rather than left `failed`. It cannot show boot ordering: there is no
//! `tailscaled` in here to be ordered against, so `After=` is asserted by
//! nothing below and stays undemonstrated until a box exists.
//!
//! **The refusal is real rather than arranged.** No `tailscale` binary exists
//! in the container, so `inventory::addresses` cannot be asked and the daemon
//! exits `Error::Tailnet` — the same exit the boot race produces when
//! `tailscaled`'s socket answers before its netmap has arrived.
//!
//! A test run of this crate builds `yantrad` and no other binary, so the agent
//! is here as a unit rather than as a process.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};

/// Bump the tag when `tests/fixture/Containerfile` changes; the image is built
/// once and then reused from the local store.
const IMAGE: &str = "localhost/yantra-systemd:1";
const BOOT_TIMEOUT: Duration = Duration::from_secs(60);
const BUILD_ATTEMPTS: u32 = 2;
const BUILD_RETRY_PAUSE: Duration = Duration::from_secs(2);

/// Two of the unit's own `RestartSec=10`, and then some for a slow container.
const RETRY_WINDOW: Duration = Duration::from_secs(28);

/// systemd's own default, and the number the unit's `RestartSec` exists to
/// replace: five starts this fast land inside the ten-second start limit.
const SYSTEMD_DEFAULT_RESTART_SEC: &str = "100ms";

/// A container running systemd as PID 1, removed on drop.
#[derive(Debug)]
struct Systemd {
    container: String,
}

impl Systemd {
    /// Starts the fixture, or returns `Ok(None)` when `podman` is not installed
    /// so that such a machine skips the test rather than failing it.
    ///
    /// `YANTRA_REQUIRE_PODMAN` turns that skip into a failure (I-32).
    fn start() -> Result<Option<Self>> {
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

    fn exec(&self, args: &[&str]) -> Result<Output> {
        let mut argv = vec!["exec", &self.container];
        argv.extend_from_slice(args);
        podman(&argv)
    }

    /// Runs `args` in the container and returns stdout, failing the test with
    /// whatever the command said if it did not succeed.
    fn run(&self, args: &[&str]) -> Result<String> {
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

    fn copy_in(&self, from: &Path, to: &str) -> Result<()> {
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
    fn arrange_account(&self) -> Result<()> {
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

    fn install_unit(&self, name: &str) -> Result<()> {
        self.copy_in(
            &repo_root().join("crates").join(unit_source(name)),
            &format!("/etc/systemd/system/{name}"),
        )?;
        self.run(&["systemctl", "daemon-reload"])?;
        Ok(())
    }

    fn property(&self, unit: &str, name: &str) -> Result<String> {
        Ok(self
            .run(&["systemctl", "show", unit, "-p", name, "--value"])?
            .trim()
            .to_owned())
    }

    fn journal(&self, unit: &str) -> String {
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

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("."))
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

/// Everything the install does for the daemon, so that what is measured after
/// it is the unit rather than the arrangement.
fn daemon_installed() -> Result<Option<Systemd>> {
    let Some(fixture) = Systemd::start()? else {
        return Ok(None);
    };
    fixture.arrange_account()?;
    fixture.copy_in(
        Path::new(env!("CARGO_BIN_EXE_yantrad")),
        "/usr/local/bin/yantrad",
    )?;
    fixture.install_unit("yantrad.service")?;
    Ok(Some(fixture))
}

/// The row's evidence. `yantrad` exits non-zero because it will not guess a
/// bind address, and the unit's job is to keep asking rather than to give up —
/// a headless box in `failed` is a box that is off until someone notices.
#[test]
fn a_daemon_that_cannot_ask_tailscale_is_retried_rather_than_left_failed() -> Result<()> {
    let Some(fixture) = daemon_installed()? else {
        return Ok(());
    };

    fixture.run(&[
        "systemd-analyze",
        "verify",
        "/etc/systemd/system/yantrad.service",
    ])?;
    fixture.run(&["systemctl", "enable", "yantrad.service"])?;
    assert_eq!(
        fixture
            .run(&["systemctl", "is-enabled", "yantrad.service"])?
            .trim(),
        "enabled"
    );

    fixture.run(&["systemctl", "start", "yantrad.service"])?;
    let deadline = Instant::now() + RETRY_WINDOW;
    while Instant::now() < deadline {
        if fixture.property("yantrad.service", "ActiveState")? == "failed" {
            bail!(
                "the unit gave up instead of retrying:\n{}",
                fixture.journal("yantrad.service")
            );
        }
        sleep(Duration::from_millis(500));
    }

    let restarts: u32 = fixture.property("yantrad.service", "NRestarts")?.parse()?;
    assert!(
        restarts >= 2,
        "expected the supervisor to have retried at least twice in {RETRY_WINDOW:?}, saw \
         {restarts}:\n{}",
        fixture.journal("yantrad.service")
    );
    let journal = fixture.journal("yantrad.service");
    assert!(
        journal.contains("could not ask Tailscale which addresses this machine holds"),
        "the retried failure must be `listen_on`'s and not something else:\n{journal}"
    );
    Ok(())
}

/// What makes the test above evidence about the tuning rather than about
/// systemd: the same unit, the same binary, the same refusal, and systemd's
/// default `RestartSec` — which reaches the start limit and stays there.
#[test]
fn systemds_default_restart_delay_would_leave_the_same_unit_failed() -> Result<()> {
    let Some(fixture) = daemon_installed()? else {
        return Ok(());
    };

    fixture.run(&["mkdir", "-p", "/etc/systemd/system/yantrad.service.d"])?;
    fixture.run(&[
        "sh",
        "-c",
        &format!(
            "printf '[Service]\\nRestartSec={SYSTEMD_DEFAULT_RESTART_SEC}\\n' \
             > /etc/systemd/system/yantrad.service.d/default.conf"
        ),
    ])?;
    fixture.run(&["systemctl", "daemon-reload"])?;
    fixture.run(&["systemctl", "start", "yantrad.service"])?;

    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if fixture.property("yantrad.service", "ActiveState")? == "failed" {
            let journal = fixture.journal("yantrad.service");
            assert!(
                journal.contains("Start request repeated too quickly"),
                "the start limit is what must have stopped it:\n{journal}"
            );
            return Ok(());
        }
        sleep(Duration::from_millis(200));
    }
    bail!(
        "the start limit did not trip, so the unit's own RestartSec is asserting nothing:\n{}",
        fixture.journal("yantrad.service")
    );
}

/// R-12's install story for the agent, which has never had one. The binary is
/// not built by this crate's test run, so what is asserted is the unit: it
/// parses, it enables, and without the one file that carries `YANTRA_DAEMON` it
/// refuses and says which file (ADR-0013 §4).
#[test]
fn the_agent_unit_enables_and_refuses_without_the_address_it_reports_to() -> Result<()> {
    let Some(fixture) = Systemd::start()? else {
        return Ok(());
    };
    fixture.arrange_account()?;
    fixture.install_unit("yantra-agent.service")?;

    let verify = fixture.exec(&[
        "systemd-analyze",
        "verify",
        "/etc/systemd/system/yantra-agent.service",
    ])?;
    let complaints: Vec<String> = String::from_utf8_lossy(&verify.stderr)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect();
    assert_eq!(
        complaints,
        vec![
            "yantra-agent.service: Command /usr/local/bin/yantra-agent is not executable: No such \
             file or directory"
        ],
        "systemd's only complaint may be the binary this container has no copy of"
    );

    fixture.run(&["systemctl", "enable", "yantra-agent.service"])?;
    assert_eq!(
        fixture
            .run(&["systemctl", "is-enabled", "yantra-agent.service"])?
            .trim(),
        "enabled"
    );

    let _ = fixture.exec(&["systemctl", "start", "yantra-agent.service"]);
    let journal = fixture.journal("yantra-agent.service");
    assert!(
        journal.contains("Failed to load environment files"),
        "a missing /etc/yantra/agent.env must name itself:\n{journal}"
    );
    assert_ne!(
        fixture.property("yantra-agent.service", "ActiveState")?,
        "failed",
        "an agent that cannot read its address is retried too:\n{journal}"
    );
    Ok(())
}
