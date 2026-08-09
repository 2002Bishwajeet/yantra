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

mod common;

use std::path::Path;
use std::thread::sleep;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};

use common::Systemd;

/// Two of the unit's own `RestartSec=10`, and then some for a slow container.
const RETRY_WINDOW: Duration = Duration::from_secs(28);

/// systemd's own default, and the number the unit's `RestartSec` exists to
/// replace: five starts this fast land inside the ten-second start limit.
const SYSTEMD_DEFAULT_RESTART_SEC: &str = "100ms";

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
