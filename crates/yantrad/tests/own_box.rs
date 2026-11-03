//! The box reached from itself (Y-598), against a real `systemd`, `sshd`, `tmux`,
//! `yantrad` and `yantra` in a disposable podman container (§B3).
//!
//! `yantrad` runs as `yantra` and reaches every machine over ssh, itself
//! included (ADR-0009), and `tailscale status` lists Self. So [`install.sh`]
//! must leave a key and a `Host` block that work from the first sweep, or the
//! owner's own sessions never appear. **The done condition is the listing**: a
//! session on the person's account in `GET /api/sessions`, under the box's name.
//!
//! `tailscaled` is a stub, and `/etc/hosts` stands in for MagicDNS. So this
//! proves the login and the listing, and not that the name resolves on a tailnet.
//!
//! [`install.sh`]: ../../../install.sh

mod common;

use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use common::{Systemd, UNPRIVILEGED, fixture_dir, repo_root};

/// Self's name in `tailscale-status.json`, which is what the inventory calls it.
const MACHINE: &str = "cachyos-g14";
const VERSION: &str = "0.2.0";
const NEXT_VERSION: &str = "0.3.0";
const SESSION: &str = "own-box";

const PUBLIC_KEY: &str = "/home/yantra/.ssh/id_yantra.pub";
const CONFIG: &str = "/home/yantra/.ssh/config";
const AUTHORIZED: &str = "/home/deploy/.ssh/authorized_keys";

const DASHBOARD: &str = "install: open the dashboard at https://cachyos-g14.example.ts.net:8443";
const JOIN: &str = "curl -fsSL https://cachyos-g14.example.ts.net:8443/join | sh";

/// `refresh.rs` looks every 30 s, and the first look is before the key is there.
const TWO_SWEEPS: Duration = Duration::from_secs(90);

/// In `/usr/bin` because `sudo`'s `secure_path` omits `/usr/local/bin`. `serve`
/// reports HTTPS as on, so `--yes` has no question to answer about it.
const TAILSCALE_STUB: &str = r#"#!/bin/sh
case "$1" in
status) cat /srv/tailscale/status.json ;;
whois) cat /srv/tailscale/whois.json ;;
ip) echo 127.0.0.1 ;;
serve) printf '{"TCP": {"8443": {"HTTPS": true}}}\n' ;;
*) exit 1 ;;
esac
"#;

struct OwnBox {
    systemd: Systemd,
    repo: String,
}

/// `cargo nextest run -p yantrad`, which `just test-embedded` runs, builds no
/// `yantra`. So the absence skips as a missing podman does, on the same terms.
fn built_yantra() -> Result<Option<PathBuf>> {
    let yantra = Path::new(env!("CARGO_BIN_EXE_yantrad")).with_file_name("yantra");
    if yantra.is_file() {
        return Ok(Some(yantra));
    }
    if std::env::var_os("YANTRA_REQUIRE_PODMAN").is_some() {
        bail!(
            "YANTRA_REQUIRE_PODMAN is set but {} is missing. Build it: cargo nextest run --workspace",
            yantra.display()
        );
    }
    eprintln!(
        "SKIPPED: {} is missing. Build it: cargo nextest run --workspace",
        yantra.display()
    );
    Ok(None)
}

impl OwnBox {
    fn start() -> Result<Option<Self>> {
        let Some(yantra) = built_yantra()? else {
            return Ok(None);
        };
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
        let own = Self { systemd, repo };

        own.sh("mkdir -p /fixture /srv/units /srv/tailscale")?;
        let crates = repo_root().join("crates");
        for (from, to) in [
            (repo_root().join("install.sh"), "/fixture/install.sh"),
            (fixture_dir().join("release.sh"), "/fixture/release.sh"),
            (fixture_dir().join("server.py"), "/fixture/server.py"),
            (env!("CARGO_BIN_EXE_yantrad").into(), "/fixture/yantrad"),
            (yantra, "/fixture/yantra"),
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
            own.systemd.copy_in(&from, to)?;
        }

        // Self at the one address a container has for the daemon to bind. No
        // peers: each would add a machine that no container can reach.
        let mut status: Value = serde_json::from_str(&std::fs::read_to_string(
            crates.join("yantra-core/tests/fixture/tailscale-status.json"),
        )?)?;
        status["Self"]["TailscaleIPs"] = json!(["127.0.0.1"]);
        status["Peer"] = json!({});
        let status = serde_json::to_string_pretty(&status)?;
        own.sh(&format!(
            "cat > /srv/tailscale/status.json <<'JSON'\n{status}\nJSON\n\
             cat > /usr/bin/tailscale <<'STUB'\n{TAILSCALE_STUB}STUB\n\
             chmod 755 /usr/bin/tailscale\n\
             printf '127.0.0.1 {MACHINE}\\n' >> /etc/hosts"
        ))?;

        own.sh("bash /fixture/release.sh serve")?;
        Ok(Some(own))
    }

    fn sh(&self, script: &str) -> Result<String> {
        self.systemd.run(&["bash", "-c", script])
    }

    /// The real `yantrad` and `yantra`, in place of the stand-ins.
    fn publish(&self, version: &str, marker: &str) -> Result<()> {
        self.sh(&format!(
            "bash /fixture/release.sh publish {} {version} {marker} /fixture/yantrad /fixture/yantra",
            self.repo
        ))?;
        Ok(())
    }

    /// `--yes` with no terminal, as a person with sudo.
    fn install_as_person(&self) -> Result<Output> {
        self.systemd.exec_as(
            UNPRIVILEGED,
            &["bash", "-c", "cat /fixture/install.sh | bash -s -- --yes"],
        )
    }

    /// `--yes` as root, with `env` set the way `box/payload/firstboot.sh` sets it.
    fn install_as_root(&self, env: &str) -> Result<Output> {
        self.systemd.exec(&[
            "bash",
            "-c",
            &format!("cat /fixture/install.sh | {env} bash -s -- --yes"),
        ])
    }

    fn start_session(&self) -> Result<()> {
        let session = self.systemd.exec_as(
            UNPRIVILEGED,
            &["tmux", "new-session", "-d", "-s", SESSION, "sleep 3600"],
        )?;
        if !session.status.success() {
            bail!(
                "tmux new-session failed: {}",
                String::from_utf8_lossy(&session.stderr).trim()
            );
        }
        Ok(())
    }

    /// Polls until the daemon's own sweep has logged in here and read tmux.
    fn wait_for_listing(&self) -> Result<()> {
        let deadline = Instant::now() + TWO_SWEEPS;
        let mut last = String::new();
        while Instant::now() < deadline {
            let said = self.systemd.exec(&[
                "curl",
                "-fsS",
                "--max-time",
                "5",
                "http://127.0.0.1:7717/api/sessions",
            ])?;
            last = String::from_utf8_lossy(&said.stdout).into_owned();
            if lists_session(&last) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        bail!(
            "GET /api/sessions never listed {SESSION} on {MACHINE}. It last said:\n{last}\n--- yantrad ---\n{}",
            self.systemd.journal("yantrad.service")
        )
    }

    fn lines_equal(&self, path: &str, wanted: &str) -> Result<usize> {
        Ok(self
            .sh(&format!("cat {path}"))?
            .lines()
            .filter(|line| *line == wanted)
            .count())
    }

    fn exists(&self, path: &str) -> Result<bool> {
        Ok(self.systemd.exec(&["test", "-e", path])?.status.success())
    }

    /// A file and not a directory, because the ssh client makes `~/.ssh` itself.
    fn ssh_files(&self) -> Result<String> {
        self.sh("find /home/yantra /home/deploy -path '*/.ssh/*' -type f")
    }
}

fn lists_session(body: &str) -> bool {
    let Ok(body) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    let holds = |answer: &Value| {
        answer["machine"] == MACHINE
            && answer["sessions"]
                .as_array()
                .is_some_and(|sessions| sessions.iter().any(|s| s["name"] == SESSION))
    };
    body["data"]
        .as_array()
        .is_some_and(|answers| answers.iter().any(holds))
}

/// What the run printed, having ended well and on the dashboard's address.
fn finished(out: Output) -> Result<String> {
    let screen = String::from_utf8(out.stdout)?;
    if !out.status.success() {
        bail!(
            "install.sh failed ({}):\n{screen}\n{}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    assert_eq!(
        screen.lines().rfind(|line| !line.is_empty()),
        Some(DASHBOARD),
        "the run must end on the one line a person needs:\n{screen}"
    );
    Ok(screen)
}

#[test]
fn an_install_lets_the_daemon_list_its_own_sessions() -> Result<()> {
    let Some(own) = OwnBox::start()? else {
        return Ok(());
    };
    own.publish(VERSION, "first")?;
    own.sh("systemctl start sshd.service")?;

    let screen = finished(own.install_as_person()?)?;
    assert!(
        screen.contains("yantrad logs in here as deploy"),
        "the run tried no real login, or the login failed:\n{screen}"
    );

    own.start_session()?;
    own.wait_for_listing()?;

    let key = own.sh(&format!("cat {PUBLIC_KEY}"))?;
    let again = finished(own.install_as_person()?)?;
    assert!(again.contains("yantrad logs in here as deploy"), "{again}");
    assert_eq!(
        own.lines_equal(AUTHORIZED, key.trim())?,
        1,
        "a second run must not add the key again (§B4)"
    );
    assert_eq!(
        own.lines_equal(CONFIG, &format!("Host {MACHINE}"))?,
        1,
        "a second run must not add a second Host block (§B4)"
    );
    Ok(())
}

/// First boot runs as root, and root is not an account to log in as.
#[test]
fn first_boot_names_the_account_as_root() -> Result<()> {
    let firstboot = std::fs::read_to_string(repo_root().join("box/payload/firstboot.sh"))?;
    let named = firstboot
        .find("export YANTRA_ACCOUNT=$user")
        .context("firstboot.sh does not name the account to install.sh")?;
    let installed = firstboot
        .find("install.sh | bash")
        .context("firstboot.sh no longer pipes install.sh into bash")?;
    assert!(named < installed, "firstboot.sh names the account too late");

    let Some(own) = OwnBox::start()? else {
        return Ok(());
    };
    own.publish(VERSION, "first")?;
    own.sh("systemctl start sshd.service")?;

    let screen = finished(own.install_as_root(&format!("YANTRA_ACCOUNT={UNPRIVILEGED}"))?)?;
    assert!(
        screen.contains("yantrad logs in here as deploy"),
        "{screen}"
    );

    own.start_session()?;
    own.wait_for_listing()
}

#[test]
fn root_with_no_account_authorises_nothing() -> Result<()> {
    let Some(own) = OwnBox::start()? else {
        return Ok(());
    };
    own.publish(VERSION, "first")?;

    let screen = finished(own.install_as_root("")?)?;
    assert!(
        screen.contains(JOIN),
        "with no account, the join command is what is left:\n{screen}"
    );
    assert_eq!(own.ssh_files()?, "", "no account was named:\n{screen}");
    Ok(())
}

/// The block is the owner's (ADR-0009), so the key does not go to an account
/// that block never logs in as, and the install still finishes.
#[test]
fn a_kept_block_for_another_account_places_no_key() -> Result<()> {
    let Some(own) = OwnBox::start()? else {
        return Ok(());
    };
    own.publish(VERSION, "first")?;
    own.systemd.arrange_account()?;
    own.sh(&format!(
        "install -d -m 700 -o yantra -g yantra /home/yantra/.ssh && \
         printf 'Host {MACHINE}\\n    User someone\\n' > {CONFIG} && \
         chown yantra:yantra {CONFIG} && chmod 600 {CONFIG}"
    ))?;
    let kept = own.sh(&format!("cat {CONFIG}"))?;

    let screen = finished(own.install_as_person()?)?;
    assert!(
        screen.contains(&format!("ssh logs in to {MACHINE} as someone")),
        "the run must say why it placed no key:\n{screen}"
    );
    assert!(screen.contains(JOIN), "{screen}");
    assert!(!own.exists(AUTHORIZED)?, "a key was placed:\n{screen}");
    assert_eq!(own.sh(&format!("cat {CONFIG}"))?, kept);
    Ok(())
}

/// D2 §1: the updater touches no configuration, and it is the real unit here.
#[test]
fn an_update_touches_no_ssh_file() -> Result<()> {
    let Some(own) = OwnBox::start()? else {
        return Ok(());
    };
    own.publish(VERSION, "first")?;
    let first = own.systemd.exec_as(
        UNPRIVILEGED,
        &["bash", "-c", "cat /fixture/install.sh | bash"],
    )?;
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    own.sh("systemctl enable --now yantrad.service yantra-update.path")?;

    own.publish(NEXT_VERSION, "second")?;
    own.sh("systemctl start yantra-update.service")?;

    let journal = own.systemd.journal("yantra-update.service");
    assert!(
        journal.contains(&format!("install: yantra v{NEXT_VERSION},")),
        "the unit did not install v{NEXT_VERSION}:\n{journal}"
    );
    assert_eq!(own.ssh_files()?, "", "{journal}");
    Ok(())
}
