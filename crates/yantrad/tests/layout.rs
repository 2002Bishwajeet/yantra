//! The dashboard layout's done test (Y-515,
//! [ADR-0036](../../../docs/adr/0036-the-dashboard-layout-syncs-through-the-daemon.md)),
//! against a real `yantrad` and `yantra` in a disposable podman container (§B3).
//!
//! It proves the 409 and the atomic write: a stale `rev` changes no byte on
//! disk, a save replaces the file by rename, and a save that cannot write its
//! temporary file leaves the old file whole.

mod common;

use std::path::{Path, PathBuf};
use std::process::Output;

use anyhow::{Result, bail};
use serde_json::{Value, json};

use common::{Systemd, UNPRIVILEGED, repo_root};

const FILE: &str = "/home/deploy/.config/yantra/dashboard.json";
const TEMP: &str = "/home/deploy/.config/yantra/dashboard.json.tmp";
const URL: &str = "http://127.0.0.1:7717/api/layout";

const TAILSCALE_STUB: &str = r#"#!/bin/sh
case "$1" in
status) cat /srv/tailscale/status.json ;;
whois) cat /srv/tailscale/whois.json ;;
*) exit 1 ;;
esac
"#;

/// As `own_box.rs` has it, and not in `common`, which `yantra`'s tests build
/// too, where `CARGO_BIN_EXE_yantrad` does not exist.
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

struct Daemon {
    systemd: Systemd,
}

impl Daemon {
    fn start() -> Result<Option<Self>> {
        let Some(yantra) = built_yantra()? else {
            return Ok(None);
        };
        let Some(systemd) = Systemd::start()? else {
            return Ok(None);
        };
        let daemon = Self { systemd };
        daemon.sh("mkdir -p /srv/tailscale")?;
        let fixtures = repo_root().join("crates/yantra-core/tests/fixture");
        for (from, to) in [
            (
                PathBuf::from(env!("CARGO_BIN_EXE_yantrad")),
                "/usr/local/bin/yantrad",
            ),
            (yantra, "/usr/local/bin/yantra"),
            (
                fixtures.join("tailscale-whois.json"),
                "/srv/tailscale/whois.json",
            ),
        ] {
            daemon.systemd.copy_in(&from, to)?;
        }

        // Self at the one address the daemon can bind here, and no peers. The
        // whois answers the fixture's owner, so curl in the container is the owner.
        let mut status: Value = serde_json::from_str(&std::fs::read_to_string(
            fixtures.join("tailscale-status.json"),
        )?)?;
        status["Self"]["TailscaleIPs"] = json!(["127.0.0.1"]);
        status["Peer"] = json!({});
        let status = serde_json::to_string_pretty(&status)?;
        daemon.sh(&format!(
            "cat > /srv/tailscale/status.json <<'JSON'\n{status}\nJSON\n\
             cat > /usr/bin/tailscale <<'STUB'\n{TAILSCALE_STUB}STUB\n\
             chmod 755 /usr/bin/tailscale"
        ))?;

        daemon.sh(&format!(
            "systemd-run --unit=yantrad --uid={UNPRIVILEGED} /usr/local/bin/yantrad && \
             for _ in $(seq 50); do (exec 3<>/dev/tcp/127.0.0.1/7717) 2>/dev/null && exit 0; sleep 0.2; done; exit 1"
        ))
        .map_err(|error| {
            error.context(daemon.systemd.journal("yantrad.service"))
        })?;
        Ok(Some(daemon))
    }

    fn sh(&self, script: &str) -> Result<String> {
        self.systemd.run(&["bash", "-c", script])
    }

    fn as_deploy(&self, script: &str) -> Result<Output> {
        self.systemd.exec_as(UNPRIVILEGED, &["bash", "-c", script])
    }

    /// The status and the body.
    fn get(&self) -> Result<(u16, String)> {
        self.curl(&["-X", "GET"])
    }

    fn put(&self, layout: &Value) -> Result<(u16, String)> {
        let body = layout.to_string();
        self.curl(&[
            "-X",
            "PUT",
            "-H",
            "content-type: application/json",
            "--data-binary",
            &body,
        ])
    }

    fn curl(&self, args: &[&str]) -> Result<(u16, String)> {
        let mut argv = vec!["curl", "-sS", "--max-time", "10", "-w", "\n%{http_code}"];
        argv.extend_from_slice(args);
        argv.push(URL);
        let said = self.systemd.run(&argv)?;
        let (body, status) = said.rsplit_once('\n').unwrap_or(("", said.as_str()));
        Ok((status.trim().parse()?, body.to_owned()))
    }

    fn file(&self) -> Result<String> {
        self.sh(&format!("cat {FILE}"))
    }

    fn inode(&self) -> Result<String> {
        Ok(self.sh(&format!("stat -c %i {FILE}"))?.trim().to_owned())
    }

    fn exists(&self, path: &str) -> Result<bool> {
        Ok(self.systemd.exec(&["test", "-e", path])?.status.success())
    }
}

fn parsed(body: &str) -> Result<Value> {
    Ok(serde_json::from_str(body)?)
}

/// `layout` at `rev`, with the phone list cut to its first `keep` widgets.
fn edited(layout: &Value, rev: u64, keep: usize) -> Value {
    let mut edited = layout.clone();
    edited["rev"] = rev.into();
    if let Some(phone) = edited["phone"].as_array_mut() {
        phone.truncate(keep);
    }
    edited
}

#[test]
fn a_stale_rev_is_409_and_every_save_is_a_rename() -> Result<()> {
    let Some(daemon) = Daemon::start()? else {
        return Ok(());
    };

    let (status, body) = daemon.get()?;
    assert_eq!(status, 200, "{body}");
    let default = parsed(&body)?;
    assert_eq!(
        (default["v"].as_u64(), default["rev"].as_u64()),
        (Some(1), Some(0))
    );
    assert!(
        !default["phone"].as_array().is_none_or(Vec::is_empty),
        "{default}"
    );
    assert!(!daemon.exists(FILE)?, "a read writes nothing");

    let first = edited(&default, 0, 3);
    let (status, body) = daemon.put(&first)?;
    assert_eq!(status, 200, "{body}");
    let saved = parsed(&body)?;
    assert_eq!(saved, edited(&default, 1, 3));
    assert_eq!(
        parsed(&daemon.file()?)?,
        saved,
        "the file holds what was answered"
    );

    // A second device that read rev 0 is refused, and is handed rev 1.
    let before = daemon.file()?;
    let (status, body) = daemon.put(&edited(&default, 0, 1))?;
    assert_eq!(status, 409, "{body}");
    assert_eq!(parsed(&body)?, saved);
    assert_eq!(daemon.file()?, before, "a stale write changes no byte");

    // A rename gives the path a new inode; a rewrite in place keeps it.
    let inode = daemon.inode()?;
    let (status, body) = daemon.put(&edited(&default, 1, 2))?;
    assert_eq!(status, 200, "{body}");
    assert_ne!(daemon.inode()?, inode, "the save rewrote the file in place");
    assert!(!daemon.exists(TEMP)?, "the save left its temporary file");

    // With the temporary name taken, the save fails and the file is whole.
    daemon.as_deploy(&format!("mkdir {TEMP}"))?;
    let before = daemon.file()?;
    let (status, body) = daemon.put(&edited(&default, 2, 1))?;
    assert!((500..600).contains(&status), "{status}: {body}");
    assert_eq!(daemon.file()?, before, "a failed save changed the file");
    daemon.as_deploy(&format!("rmdir {TEMP}"))?;

    // The CLI reads and writes the same file as the same account (ADR-0012).
    let shown = daemon.as_deploy("yantra layout show")?;
    assert!(
        shown.status.success(),
        "{}",
        String::from_utf8_lossy(&shown.stderr)
    );
    assert_eq!(parsed(&String::from_utf8(shown.stdout)?)?, parsed(&before)?);

    let stale = edited(&default, 0, 1).to_string();
    let refused = daemon.as_deploy(&format!("printf '%s' '{stale}' | yantra layout set -"))?;
    assert_eq!(refused.status.code(), Some(1), "a stale set must exit 1");
    let said = String::from_utf8_lossy(&refused.stderr);
    assert!(
        said.contains("rev 2"),
        "the refusal names the current rev: {said}"
    );
    assert_eq!(daemon.file()?, before);

    let (_, body) = daemon.get()?;
    assert_eq!(parsed(&body)?["rev"], 2, "the daemon reads what is on disk");
    Ok(())
}
