//! An update on the appliance, end to end, against a real `systemd`, a real
//! `sshd` and a real `tmux` in a disposable podman container (§B3, Y-368).
//!
//! **This is the row's done condition** ([ADR-0027] §5): a live tmux session
//! survives the restart, and the dashboard's socket closes and comes back
//! within the browser's own reconnect budget. The budget is read out of
//! `web/src/api/socket.ts`, so a change there is a change here.
//!
//! The release is the fixture's, served from inside the container by
//! `release.sh`, and its `yantrad` is the real one this test run built. The
//! other two binaries stay stand-ins: nothing here runs them. The far machine
//! is the same container, reached over ssh as `deploy`, and `tailscale` is a
//! stub answering the shapes in `yantra-core/tests/fixture`.
//!
//! [ADR-0027]: ../../../docs/adr/0027-the-appliance-pulls-its-own-update.md

mod common;

use std::process::Output;

use anyhow::{Context, Result, bail};

use common::{Systemd, UNPRIVILEGED, fixture_dir, repo_root};
use yantra_core::update::{TRIGGER, UPDATER};

const OLD: &str = "0.2.0";
const NEW: &str = "0.3.0";
const OLD_MARK: &str = "y368-release-old";
const NEW_MARK: &str = "y368-release-new";

const SESSION: &str = "survivor";
/// What the pane prints once, so a reattached terminal can only show it if
/// tmux redrew the pane that was there before.
const PANE_MARK: &str = "y368-pane-marker";

/// `status` and `whois` are all `yantrad` asks, and both answer this box's
/// owner, untagged, at loopback.
const TAILSCALE_STUB: &str = r#"#!/bin/sh
case "$1" in
status) cat /srv/tailscale/status.json ;;
whois) cat /srv/tailscale/whois.json ;;
*) exit 1 ;;
esac
"#;

struct Appliance {
    systemd: Systemd,
    repo: String,
}

impl Appliance {
    fn start() -> Result<Option<Self>> {
        let script = std::fs::read_to_string(repo_root().join("install.sh"))?;
        let repo = script
            .lines()
            .find_map(|line| line.strip_prefix("REPO="))
            .context("install.sh assigns no REPO")?
            .trim_matches('"')
            .to_owned();
        let Some(systemd) = Systemd::start()? else {
            return Ok(None);
        };
        let appliance = Self { systemd, repo };

        appliance.sh("mkdir -p /fixture /srv/units /srv/tailscale")?;
        let crates = repo_root().join("crates");
        for (from, to) in [
            (repo_root().join("install.sh"), "/fixture/install.sh"),
            (fixture_dir().join("release.sh"), "/fixture/release.sh"),
            (fixture_dir().join("server.py"), "/fixture/server.py"),
            (fixture_dir().join("terminal.py"), "/fixture/terminal.py"),
            (env!("CARGO_BIN_EXE_yantrad").into(), "/fixture/yantrad"),
            (
                crates.join("yantrad/yantrad.service"),
                "/srv/units/yantrad.service",
            ),
            (
                crates.join("yantra-agent/yantra-agent.service"),
                "/srv/units/yantra-agent.service",
            ),
            (
                crates.join("yantrad/yantra-update.path"),
                "/srv/units/yantra-update.path",
            ),
            (
                crates.join("yantrad/yantra-update.service"),
                "/srv/units/yantra-update.service",
            ),
            (
                crates.join("yantra-core/tests/fixture/tailscale-whois.json"),
                "/srv/tailscale/whois.json",
            ),
        ] {
            appliance.systemd.copy_in(&from, to)?;
        }

        // The recorded shape, with this node at the one address a container
        // has for the daemon to bind.
        let status = std::fs::read_to_string(
            crates.join("yantra-core/tests/fixture/tailscale-status.json"),
        )?;
        let at = r#""TailscaleIPs": ["100.64.0.1", "fd7a:115c:a1e0::1"],"#;
        if status.matches(at).count() != 1 {
            bail!("tailscale-status.json no longer names Self's addresses as {at}");
        }
        let status = status.replacen(at, r#""TailscaleIPs": ["127.0.0.1"],"#, 1);
        appliance.sh(&format!(
            "cat > /srv/tailscale/status.json <<'JSON'\n{status}\nJSON\n\
             cat > /usr/bin/tailscale <<'STUB'\n{TAILSCALE_STUB}STUB\n\
             chmod 755 /usr/bin/tailscale"
        ))?;

        appliance.sh("bash /fixture/release.sh serve")?;
        Ok(Some(appliance))
    }

    fn sh(&self, script: &str) -> Result<String> {
        self.systemd.run(&["bash", "-c", script])
    }

    /// The real `yantrad`, marked, in place of the stand-in.
    fn publish(&self, version: &str, marker: &str) -> Result<()> {
        self.sh(&format!(
            "bash /fixture/release.sh publish {} {version} {marker} /fixture/yantrad",
            self.repo
        ))?;
        Ok(())
    }

    /// The box as a person leaves it: v0.2.0 installed with no terminal, the
    /// daemon and the path unit enabled, one machine it reaches over ssh, and
    /// a tmux session there with something running in it.
    fn arrange(&self) -> Result<()> {
        self.publish(OLD, OLD_MARK)?;
        let installed = self.systemd.exec_as(
            UNPRIVILEGED,
            &["bash", "-c", "cat /fixture/install.sh | bash"],
        )?;
        if !installed.status.success() {
            bail!(
                "installing v{OLD} failed: {}",
                String::from_utf8_lossy(&installed.stderr).trim()
            );
        }

        self.sh(&format!(
            "install -d -m 700 -o yantra -g yantra /home/yantra/.ssh && \
             sudo -u yantra ssh-keygen -q -t ed25519 -N '' -f /home/yantra/.ssh/id_ed25519 && \
             install -d -m 700 -o {UNPRIVILEGED} -g {UNPRIVILEGED} /home/{UNPRIVILEGED}/.ssh && \
             install -m 600 -o {UNPRIVILEGED} -g {UNPRIVILEGED} /home/yantra/.ssh/id_ed25519.pub \
                 /home/{UNPRIVILEGED}/.ssh/authorized_keys && \
             printf 'Host fixture\\n    HostName 127.0.0.1\\n    User {UNPRIVILEGED}\\n    IdentityFile /home/yantra/.ssh/id_ed25519\\n' \
                 > /home/yantra/.ssh/config && \
             chown yantra:yantra /home/yantra/.ssh/config && chmod 600 /home/yantra/.ssh/config && \
             systemctl start sshd.service"
        ))?;
        // A reach that fails here is the fixture's, and says so before the
        // daemon is asked to make the same connection.
        self.sh(
            "sudo -u yantra ssh -o BatchMode=yes -o StrictHostKeyChecking=no \
             -o UserKnownHostsFile=/dev/null fixture true",
        )
        .context("the yantra account cannot reach the far machine")?;

        let session = self.systemd.exec_as(
            UNPRIVILEGED,
            &[
                "tmux",
                "new-session",
                "-d",
                "-s",
                SESSION,
                &format!("echo {PANE_MARK}; exec sleep 3600"),
            ],
        )?;
        if !session.status.success() {
            bail!(
                "tmux new-session failed: {}",
                String::from_utf8_lossy(&session.stderr).trim()
            );
        }

        self.sh("systemctl enable --now yantrad.service yantra-update.path")?;
        let ready = self.systemd.exec(&[
            "bash",
            "-c",
            "for _ in $(seq 60); do curl -fsS http://127.0.0.1:7717/healthz && exit 0; sleep 0.5; done; exit 1",
        ])?;
        if !ready.status.success() {
            bail!(
                "yantrad never answered /healthz:\n{}",
                self.systemd.journal("yantrad.service")
            );
        }
        Ok(())
    }

    /// The tmux server, and the `sleep` its pane `exec`ed into.
    fn session_pids(&self) -> Result<(String, String)> {
        let out = self.systemd.exec_as(
            UNPRIVILEGED,
            &[
                "tmux",
                "display-message",
                "-p",
                "-t",
                SESSION,
                "#{pid} #{pane_pid}",
            ],
        )?;
        let said = String::from_utf8(out.stdout)?;
        let (server, pane) = said
            .trim()
            .split_once(' ')
            .with_context(|| format!("tmux named no pids: {said:?}"))?;
        Ok((server.to_owned(), pane.to_owned()))
    }

    fn daemon_pid(&self) -> Result<String> {
        self.systemd.property("yantrad.service", "MainPID")
    }

    fn carries(&self, path: &str, marker: &str) -> Result<bool> {
        Ok(self
            .systemd
            .exec(&["grep", "-q", "-a", marker, path])?
            .status
            .success())
    }

    /// Read as `yantra`: `/proc/<pid>/exe` needs ptrace access, and the
    /// container's root has no `CAP_SYS_PTRACE` over another account's process.
    fn runs(&self, pid: &str, marker: &str) -> Result<bool> {
        let exe = format!("/proc/{pid}/exe");
        let out = self
            .systemd
            .exec_as("yantra", &["grep", "-q", "-a", marker, &exe])?;
        if out.status.code() == Some(2) {
            bail!("{exe}: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(out.status.success())
    }

    fn exists(&self, path: &str) -> Result<bool> {
        Ok(self.systemd.exec(&["test", "-e", path])?.status.success())
    }

    /// `web/src/api/socket.ts`'s reconnect budget, handed to the client.
    fn client(&self, mode: &str) -> Result<Output> {
        let (attempts, pause) = socket_budget()?;
        self.systemd.exec(&[
            "python3",
            "/fixture/terminal.py",
            mode,
            SESSION,
            &attempts.to_string(),
            &pause.to_string(),
            PANE_MARK,
        ])
    }

    /// Everything a failure needs to be read without rerunning it.
    fn story(&self, out: &Output) -> String {
        format!(
            "client ({}):\n{}\n{}\n--- yantra-update ---\n{}\n--- yantrad ---\n{}",
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
            self.systemd.journal("yantra-update.service"),
            self.systemd.journal("yantrad.service"),
        )
    }
}

fn socket_budget() -> Result<(u32, u32)> {
    let socket = std::fs::read_to_string(repo_root().join("web/src/api/socket.ts"))?;
    let constant = |name: &str| -> Result<u32> {
        let prefix = format!("export const {name} = ");
        socket
            .lines()
            .find_map(|line| line.strip_prefix(&prefix))
            .with_context(|| format!("socket.ts no longer exports {name}"))?
            .trim()
            .parse()
            .with_context(|| format!("socket.ts's {name} is not a number"))
    };
    Ok((constant("ATTEMPTS")?, constant("PAUSE")?))
}

/// ADR-0027 §5, both halves: the session on the far machine is the same
/// process tree afterwards, and the socket to it closes and reopens in the
/// browser's budget. Then §3 and §6: the new daemon runs, the old one is kept
/// as `.prev`, the trigger is gone and the updater is the new release's.
#[test]
fn an_update_restarts_the_daemon_and_the_session_and_its_socket_survive() -> Result<()> {
    let Some(appliance) = Appliance::start()? else {
        return Ok(());
    };
    appliance.arrange()?;
    let (server, pane) = appliance.session_pids()?;
    let before = appliance.daemon_pid()?;
    appliance.publish(NEW, NEW_MARK)?;

    let out = appliance.client("update")?;
    let story = appliance.story(&out);
    assert!(out.status.success(), "{story}");

    assert_eq!(
        appliance
            .systemd
            .property("yantra-update.service", "Result")?,
        "success",
        "{story}"
    );
    assert!(
        appliance
            .systemd
            .journal("yantra-update.service")
            .contains(&format!("install: yantra v{NEW},")),
        "the unit did not install v{NEW}:\n{story}"
    );
    assert_eq!(
        appliance.session_pids()?,
        (server, pane.clone()),
        "the tmux server or its pane is a new process"
    );
    assert_eq!(
        appliance.sh(&format!("cat /proc/{pane}/comm"))?.trim(),
        "sleep"
    );

    let after = appliance.daemon_pid()?;
    assert_ne!(after, before, "yantrad was not restarted:\n{story}");
    assert!(
        appliance.runs(&after, NEW_MARK)?,
        "the running yantrad is not v{NEW}"
    );
    assert!(
        appliance.carries("/usr/local/bin/yantrad.prev", OLD_MARK)?,
        "yantrad.prev is not the v{OLD} it replaced"
    );
    assert!(
        appliance.carries(UPDATER, NEW_MARK)?,
        "{UPDATER} is not v{NEW}'s install.sh"
    );
    assert!(!appliance.exists(TRIGGER)?, "the trigger outlived the unit");

    // A stop that waited on an upgraded socket would reach TimeoutStopSec and
    // end in SIGKILL, which systemd writes down.
    let journal = appliance.systemd.journal("yantrad.service");
    assert!(
        !journal.contains("stop-sigterm") && !journal.contains("signal SIGKILL"),
        "yantrad did not stop on SIGTERM:\n{journal}"
    );

    // ADR-0027 §6: a second run of the same release leaves the rollback alone.
    appliance.sh("systemctl start yantra-update.service")?;
    assert!(
        appliance.carries("/usr/local/bin/yantrad.prev", OLD_MARK)?,
        "a repeated update overwrote yantrad.prev with v{NEW}"
    );
    Ok(())
}

/// A checksum that does not match installs nothing and restarts nothing:
/// the restart is `ExecStartPost`, so a failed install never reaches it.
#[test]
fn a_failed_update_restarts_nothing_and_the_socket_stays_up() -> Result<()> {
    let Some(appliance) = Appliance::start()? else {
        return Ok(());
    };
    appliance.arrange()?;
    let before = appliance.daemon_pid()?;
    appliance.publish(NEW, NEW_MARK)?;
    appliance.sh(&format!(
        "bash /fixture/release.sh corrupt {} {NEW}",
        appliance.repo
    ))?;

    let out = appliance.client("refused")?;
    let story = appliance.story(&out);
    assert!(out.status.success(), "{story}");

    assert_eq!(
        appliance
            .systemd
            .property("yantra-update.service", "ActiveState")?,
        "failed"
    );
    assert!(
        appliance
            .systemd
            .journal("yantra-update.service")
            .contains("does not match SHA256SUMS"),
        "{story}"
    );
    assert_eq!(
        appliance.daemon_pid()?,
        before,
        "a failed install restarted yantrad"
    );
    assert!(
        appliance.carries("/usr/local/bin/yantrad", OLD_MARK)?,
        "a failed install replaced yantrad"
    );
    assert!(!appliance.exists(TRIGGER)?, "the trigger outlived the unit");
    Ok(())
}
