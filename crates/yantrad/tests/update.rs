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
//! stub answering the shapes in `yantra-core/tests/fixture`. The last test
//! publishes the archive release.yml built instead, and only runs there (Y-483).
//!
//! [ADR-0027]: ../../../docs/adr/0027-the-appliance-pulls-its-own-update.md

mod common;

use std::path::PathBuf;
use std::process::Output;

use anyhow::{Context, Result, bail};

use common::{Systemd, UNPRIVILEGED, fixture_dir, repo_root};
use yantra_core::update::{TRIGGER, UPDATER};

const OLD: &str = "0.2.0";
const NEW: &str = "0.3.0";
const OLD_MARK: &str = "y368-release-old";
const NEW_MARK: &str = "y368-release-new";

/// Where the archive from `YANTRA_RELEASE_ARCHIVE` lands in the container.
const BUILT: &str = "/fixture/built.tar.gz";
const SECOND_MARK: &str = "y483-second-build";

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

/// ADR-0042: the daemon's own account on its socket, because this box's own
/// address is refused over TCP.
const OWNER_CURL: &str = "runuser -u yantra -- curl --unix-socket /run/yantra/yantrad.sock";

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

    /// The archive release.yml built, as `version`, with `marker` appended to
    /// each binary when it is not empty.
    fn publish_archive(&self, version: &str, marker: &str) -> Result<()> {
        self.sh(&format!(
            "bash /fixture/release.sh publish_archive {} {version} '{marker}' {BUILT}",
            self.repo
        ))?;
        Ok(())
    }

    /// The box as a person leaves it: v0.2.0 installed with no terminal, the
    /// daemon and the path unit enabled, one machine it reaches over ssh, and
    /// a tmux session there with something running in it.
    fn arrange(&self) -> Result<()> {
        self.publish(OLD, OLD_MARK)?;
        self.install("/fixture/install.sh", OLD)?;
        self.leave_running()
    }

    /// `script` piped to bash as `deploy`, with no terminal, which reaches root
    /// through `sudo` as a person's install does.
    fn install(&self, script: &str, version: &str) -> Result<()> {
        let installed = self.systemd.exec_as(
            UNPRIVILEGED,
            &["bash", "-c", &format!("cat {script} | bash")],
        )?;
        if !installed.status.success() {
            bail!(
                "installing v{version} failed: {}",
                String::from_utf8_lossy(&installed.stderr).trim()
            );
        }
        Ok(())
    }

    /// Everything after the install: the machine over ssh, the tmux session,
    /// and the daemon and the path unit enabled and answering.
    fn leave_running(&self) -> Result<()> {
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
        self.healthy()
    }

    fn healthy(&self) -> Result<()> {
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

    /// Starts the root unit, which must fail and say `words`. The v0.2.0
    /// daemon must still be on disk and still be the process `before`.
    fn unit_refuses(&self, before: &str, words: &str) -> Result<()> {
        let started = self
            .systemd
            .exec(&["systemctl", "start", "yantra-update.service"])?;
        let journal = self.systemd.journal("yantra-update.service");
        assert!(!started.status.success(), "the unit installed:\n{journal}");
        assert_eq!(
            self.systemd
                .property("yantra-update.service", "ActiveState")?,
            "failed",
            "{journal}"
        );
        assert!(journal.contains(words), "{journal}");
        assert!(
            self.carries("/usr/local/bin/yantrad", OLD_MARK)?,
            "a refused update replaced yantrad"
        );
        assert_eq!(
            self.daemon_pid()?,
            before,
            "a refused update restarted yantrad"
        );
        Ok(())
    }

    /// `web/src/api/socket.ts`'s reconnect budget, handed to the client.
    fn client(&self, mode: &str) -> Result<Output> {
        let (attempts, pause) = socket_budget()?;
        self.systemd.exec_as(
            "yantra",
            &[
                "python3",
                "/fixture/terminal.py",
                mode,
                SESSION,
                &attempts.to_string(),
                &pause.to_string(),
                PANE_MARK,
            ],
        )
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

/// Y-479: "Restart now" after a dashboard save is the Y-368 trigger and
/// nothing else. The release is unchanged, so the restart reinstalls v0.2.0,
/// and the new process reads the id the daemon wrote.
#[test]
fn restart_now_after_a_config_save_restarts_the_daemon() -> Result<()> {
    const ID: &str = "Iv1.y479";
    let Some(appliance) = Appliance::start()? else {
        return Ok(());
    };
    appliance.arrange()?;

    let post = |path: &str, body: &str| {
        appliance.sh(&format!(
            "{OWNER_CURL} -sS -o /dev/null -w '%{{http_code}}' -X POST -H 'Content-Type: application/json' \
             -d '{body}' http://yantra{path}"
        ))
    };
    assert_eq!(
        post("/api/github/client-id", &format!(r#"{{"id":"{ID}"}}"#))?,
        "204"
    );
    let before = appliance.daemon_pid()?;
    assert_eq!(post("/api/update", "")?, "202");

    appliance.sh(&format!(
        "for _ in $(seq 120); do
           pid=$(systemctl show yantrad.service -p MainPID --value)
           [ \"$pid\" != {before} ] && [ \"$pid\" != 0 ] && curl -fsS http://127.0.0.1:7717/healthz && exit 0
           sleep 0.5
         done; exit 1"
    ))?;
    let story = format!(
        "--- yantra-update ---\n{}\n--- yantrad ---\n{}",
        appliance.systemd.journal("yantra-update.service"),
        appliance.systemd.journal("yantrad.service"),
    );

    let after = appliance.daemon_pid()?;
    assert_ne!(after, before, "yantrad was not restarted:\n{story}");
    // The trigger is removed when the unit starts, so wait for it to finish.
    appliance.sh(
        "for _ in $(seq 120); do systemctl is-active yantra-update.service | grep -qx activating || exit 0; sleep 0.5; done; exit 1",
    )?;
    assert_eq!(
        appliance
            .systemd
            .property("yantra-update.service", "Result")?,
        "success",
        "{story}"
    );
    assert!(!appliance.exists(TRIGGER)?, "the trigger outlived the unit");
    assert!(
        appliance.carries("/etc/yantra/daemon.env", ID)?,
        "the saved id is not in daemon.env"
    );
    let seen = appliance.systemd.exec_as(
        "yantra",
        &[
            "grep",
            "-qa",
            &format!("YANTRA_GITHUB_CLIENT_ID={ID}"),
            &format!("/proc/{after}/environ"),
        ],
    )?;
    assert!(
        seen.status.success(),
        "the restarted yantrad does not hold the saved id"
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

/// Y-803, ADR-0027 decision 4: the nightly key signs the nightly. yantrad's
/// account writes the channel file and the unit takes no argument, so the unit
/// installs the nightly that the file names and restarts the daemon.
#[test]
fn the_root_unit_installs_a_signed_nightly() -> Result<()> {
    let Some(appliance) = Appliance::start()? else {
        return Ok(());
    };
    appliance.arrange()?;
    let before = appliance.daemon_pid()?;
    appliance.publish(NEW, NEW_MARK)?;
    // With no stable release list, only the nightly can resolve.
    appliance.sh(&format!(
        "bash /fixture/release.sh nightly {repo} {NEW} && \
         bash /fixture/release.sh unresolvable {repo} && \
         runuser -u yantra -- sh -c 'echo nightly > /etc/yantra/channel'",
        repo = appliance.repo
    ))?;

    let started = appliance
        .systemd
        .exec(&["systemctl", "start", "yantra-update.service"])?;
    let journal = appliance.systemd.journal("yantra-update.service");
    assert!(started.status.success(), "{journal}");
    assert!(
        journal.contains(&format!("install: yantra v{NEW},")) && journal.contains(", nightly"),
        "the unit did not install the nightly:\n{journal}"
    );
    let after = appliance.daemon_pid()?;
    assert_ne!(after, before, "yantrad was not restarted:\n{journal}");
    assert!(
        appliance.runs(&after, NEW_MARK)?,
        "the running yantrad is not the nightly"
    );
    appliance.healthy()
}

/// Y-803: the box verifies with the key of the release it fetches. A nightly
/// that the stable key signed, or that nothing signed, is not the sign job's
/// nightly. The root unit installs nothing and restarts nothing.
#[test]
fn the_root_unit_refuses_a_nightly_the_nightly_key_did_not_sign() -> Result<()> {
    let Some(appliance) = Appliance::start()? else {
        return Ok(());
    };
    appliance.arrange()?;
    let before = appliance.daemon_pid()?;
    appliance.publish(NEW, NEW_MARK)?;
    appliance.sh(&format!(
        "bash /fixture/release.sh nightly {repo} {NEW} && \
         bash /fixture/release.sh cross {repo} nightly && \
         runuser -u yantra -- sh -c 'echo nightly > /etc/yantra/channel'",
        repo = appliance.repo
    ))?;
    appliance.unit_refuses(&before, "is not the nightly key's signature")?;

    appliance.sh(&format!(
        "bash /fixture/release.sh unsign {} nightly",
        appliance.repo
    ))?;
    appliance.unit_refuses(&before, "carries no SHA256SUMS.sig")
}

/// Y-780: a stable release with no `SHA256SUMS.sig` is one the release
/// workflow did not sign. The root unit installs nothing and restarts nothing.
#[test]
fn the_root_unit_refuses_an_unsigned_release() -> Result<()> {
    let Some(appliance) = Appliance::start()? else {
        return Ok(());
    };
    appliance.arrange()?;
    let before = appliance.daemon_pid()?;
    appliance.publish(NEW, NEW_MARK)?;
    appliance.sh(&format!(
        "bash /fixture/release.sh unsign {} {NEW}",
        appliance.repo
    ))?;

    appliance.unit_refuses(&before, "carries no SHA256SUMS.sig")
}

/// Y-612: the daemon runs as `yantra`, which cannot read the root unit's
/// journal, so the unit writes its own progress to `/run/yantra-update` and
/// `GET /api/about` reads it. A failure stays there after the oneshot exits,
/// in the unit's own words. The fixture's host is local, so the steps before
/// the failure may pass between two reads: they are reported, not asserted.
#[test]
fn a_failed_update_is_read_back_on_about_in_the_units_words() -> Result<()> {
    let Some(appliance) = Appliance::start()? else {
        return Ok(());
    };
    appliance.arrange()?;
    appliance.publish(NEW, NEW_MARK)?;
    appliance.sh(&format!(
        "bash /fixture/release.sh corrupt {} {NEW}",
        appliance.repo
    ))?;

    let asked = appliance.sh(&format!(
        "{OWNER_CURL} -sS -o /dev/null -w '%{{http_code}}' -X POST http://yantra/api/update"
    ))?;
    assert_eq!(asked, "202");

    let read = appliance.systemd.exec(&[
        "python3",
        "-c",
        r#"
import json, sys, time, urllib.request
steps = []
for _ in range(240):
    update = json.load(urllib.request.urlopen("http://127.0.0.1:7717/api/about"))["update"]
    if update and steps[-1:] != [update["step"]]:
        steps.append(update["step"])
    if update and update["step"] == "failed":
        print(json.dumps({"steps": steps, "said": update["said"]}))
        sys.exit(0)
    time.sleep(0.25)
sys.exit("About never said the update failed; it saw " + json.dumps(steps))
"#,
    ])?;
    let story = format!(
        "{}\n--- yantra-update ---\n{}\n--- yantrad ---\n{}",
        String::from_utf8_lossy(&read.stderr),
        appliance.systemd.journal("yantra-update.service"),
        appliance.systemd.journal("yantrad.service"),
    );
    assert!(read.status.success(), "{story}");
    let seen: serde_json::Value = serde_json::from_slice(&read.stdout)?;
    eprintln!("About saw the steps {}", seen["steps"]);
    assert!(
        seen["said"]
            .as_str()
            .is_some_and(|said| said.contains("does not match SHA256SUMS")),
        "{seen}\n{story}"
    );

    // The unit keeps the failure, so a recovery at a terminal must clear it.
    appliance.publish(NEW, NEW_MARK)?;
    appliance.install("/fixture/install.sh", NEW)?;
    let recovered = appliance.sh("for _ in $(seq 120); do \
           curl -fsS http://127.0.0.1:7717/api/about && exit 0; sleep 0.25; \
         done; exit 1")?;
    let recovered: serde_json::Value = serde_json::from_str(&recovered)?;
    assert!(
        appliance.carries("/usr/local/bin/yantrad", NEW_MARK)?,
        "the terminal run did not install v{NEW}"
    );
    assert_eq!(
        recovered["update"],
        serde_json::Value::Null,
        "the failure outlived the recovery: {recovered}"
    );
    Ok(())
}

/// The version `yantra --version` must print: the tag on a tag push, and the
/// crate's own version on a dispatch, which has no tag.
fn expected_version() -> String {
    match std::env::var("YANTRA_RELEASE_TAG") {
        Ok(tag) if !tag.is_empty() => tag.strip_prefix('v').unwrap_or(&tag).to_owned(),
        _ => env!("CARGO_PKG_VERSION").to_owned(),
    }
}

/// Y-483: the archive release.yml built installs with no terminal through its
/// own install.sh, and then updates through the real unit while a tmux session
/// survives. "The second build" is the same archive republished under
/// v0.3.0 with a marker on each binary, so both builds hold the same code; what
/// differs is the bytes, which is what makes the update replace files, keep
/// `.prev` and restart the daemon. release.yml runs this; elsewhere it skips.
#[test]
fn the_built_archive_installs_updates_and_keeps_a_session() -> Result<()> {
    let Some(archive) = std::env::var_os("YANTRA_RELEASE_ARCHIVE") else {
        return Ok(());
    };
    let archive = PathBuf::from(archive);
    if !archive.is_file() {
        bail!(
            "YANTRA_RELEASE_ARCHIVE names {}, which is not a file",
            archive.display()
        );
    }
    let Some(appliance) = Appliance::start()? else {
        return Ok(());
    };
    appliance.systemd.copy_in(&archive, BUILT)?;
    let expected = format!("yantra {}", expected_version());

    appliance.publish_archive(OLD, "")?;
    // The staged archive's own install.sh, not the repository's.
    appliance.install(&format!("/srv/staging/yantra-{OLD}-*/install.sh"), OLD)?;
    appliance.leave_running()?;

    let version = || -> Result<String> {
        Ok(appliance
            .sh("/usr/local/bin/yantra --version")?
            .trim()
            .to_owned())
    };
    assert_eq!(version()?, expected, "the installed yantra is not the tag");

    let (server, pane) = appliance.session_pids()?;
    let before = appliance.daemon_pid()?;
    appliance.publish_archive(NEW, SECOND_MARK)?;

    let started = appliance
        .systemd
        .exec(&["systemctl", "start", "yantra-update.service"])?;
    let story = format!(
        "--- yantra-update ---\n{}\n--- yantrad ---\n{}",
        appliance.systemd.journal("yantra-update.service"),
        appliance.systemd.journal("yantrad.service"),
    );
    assert!(started.status.success(), "{story}");
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

    let after = appliance.daemon_pid()?;
    assert_ne!(after, before, "yantrad was not restarted:\n{story}");
    assert!(
        appliance.runs(&after, SECOND_MARK)?,
        "the running yantrad is not the second build"
    );
    assert!(
        appliance.exists("/usr/local/bin/yantrad.prev")?,
        "the update kept no yantrad.prev"
    );
    assert!(
        !appliance.carries("/usr/local/bin/yantrad.prev", SECOND_MARK)?,
        "yantrad.prev is the second build, not the first"
    );
    assert_eq!(version()?, expected, "the updated yantra is not the tag");

    assert_eq!(
        appliance.session_pids()?,
        (server, pane.clone()),
        "the tmux server or its pane is a new process"
    );
    assert_eq!(
        appliance.sh(&format!("cat /proc/{pane}/comm"))?.trim(),
        "sleep"
    );
    appliance.healthy()
}
