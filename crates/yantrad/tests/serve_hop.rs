//! ADR-0042's done test, against the real `yantrad` under its own unit in a
//! disposable podman container with several accounts (§B3, Y-680).
//!
//! Nothing here holds a `tailscaled`, so the `serve` hop is root on the socket
//! writing `X-Forwarded-For`, which is the hop's shape and nothing more. The
//! `tailscale` stub answers `whois` per address: this node at 127.0.0.1, which
//! is the one address the daemon binds here, and the owner's phone at
//! 100.64.0.9. The phone writing through the real `serve` on the box is a check
//! by hand, because a real `serve` needs an auth key.

mod common;

use std::path::Path;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use common::{Systemd, UNPRIVILEGED, repo_root};

const SOCKET: &str = "/run/yantra/yantrad.sock";
const LAYOUT: &str = "/home/yantra/.config/yantra/dashboard.json";
const PHONE: &str = "100.64.0.9";
/// An account added to the `yantra` group, which ADR-0042 makes this machine's owner.
const MEMBER: &str = "member";

const TAILSCALE_STUB: &str = r#"#!/bin/sh
case "$1" in
status) cat /srv/tailscale/status.json ;;
whois) cat "/srv/tailscale/whois-$3.json" 2>/dev/null || { echo 'peer not found' >&2; exit 1; } ;;
*) exit 1 ;;
esac
"#;

struct Hub {
    systemd: Systemd,
}

impl Hub {
    fn start() -> Result<Option<Self>> {
        let Some(systemd) = Systemd::start()? else {
            return Ok(None);
        };
        let hub = Self { systemd };
        hub.systemd.arrange_account()?;
        hub.sh(&format!("useradd --create-home --groups yantra {MEMBER}"))?;
        hub.sh("mkdir -p /srv/tailscale")?;
        hub.systemd.copy_in(
            Path::new(env!("CARGO_BIN_EXE_yantrad")),
            "/usr/local/bin/yantrad",
        )?;
        hub.tailnet()?;
        hub.systemd.install_unit("yantrad.service")?;
        hub.sh(
            "systemctl start yantrad.service && \
             for _ in $(seq 50); do (exec 3<>/dev/tcp/127.0.0.1/7717) 2>/dev/null && exit 0; sleep 0.2; done; exit 1",
        )
        .map_err(|error| error.context(hub.systemd.journal("yantrad.service")))?;
        Ok(Some(hub))
    }

    /// Self at 127.0.0.1 with no peers; `whois` names Self there and the
    /// owner's phone at [`PHONE`], both the owner's and untagged.
    fn tailnet(&self) -> Result<()> {
        let fixtures = repo_root().join("crates/yantra-core/tests/fixture");
        let mut status: Value = serde_json::from_str(&std::fs::read_to_string(
            fixtures.join("tailscale-status.json"),
        )?)?;
        status["Self"]["TailscaleIPs"] = json!(["127.0.0.1"]);
        status["Peer"] = json!({});
        let whois: Value = serde_json::from_str(&std::fs::read_to_string(
            fixtures.join("tailscale-whois.json"),
        )?)?;

        let mut files = vec![("status.json".to_owned(), status.to_string())];
        for (address, id) in [
            ("127.0.0.1", status["Self"]["ID"].clone()),
            (PHONE, json!("nPHONE0000011CNTRL")),
        ] {
            let mut answer = whois.clone();
            answer["Node"]["StableID"] = id;
            answer["Node"]["User"] = status["Self"]["UserID"].clone();
            answer["UserProfile"]["ID"] = status["Self"]["UserID"].clone();
            files.push((format!("whois-{address}.json"), answer.to_string()));
        }
        let mut script = String::new();
        for (name, body) in files {
            script.push_str(&format!(
                "cat > /srv/tailscale/{name} <<'JSON'\n{body}\nJSON\n"
            ));
        }
        self.sh(&format!(
            "{script}chmod -R a+rX /srv/tailscale\n\
             cat > /usr/bin/tailscale <<'STUB'\n{TAILSCALE_STUB}STUB\nchmod 755 /usr/bin/tailscale"
        ))?;
        Ok(())
    }

    fn sh(&self, script: &str) -> Result<String> {
        self.systemd.run(&["bash", "-c", script])
    }

    /// `curl` as `user`, on the socket or to `url`; the status and the body.
    fn curl(&self, user: &str, args: &[&str]) -> Result<(u16, String)> {
        let mut argv = vec!["curl", "-sS", "--max-time", "10", "-w", "\n%{http_code}"];
        argv.extend_from_slice(args);
        let out = self.systemd.exec_as(user, &argv)?;
        if !out.status.success() {
            bail!(
                "curl as {user} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        let said = String::from_utf8(out.stdout)?;
        let (body, status) = said.rsplit_once('\n').unwrap_or(("", said.as_str()));
        Ok((status.trim().parse()?, body.to_owned()))
    }

    /// The layout as it is now, which is a body `PUT /api/layout` accepts.
    fn layout(&self) -> Result<String> {
        let (status, body) = self.curl("root", &["http://127.0.0.1:7717/api/layout"])?;
        if status != 200 {
            bail!("GET /api/layout answered {status}: {body}");
        }
        Ok(body)
    }

    /// `PUT /api/layout` as `user`, on the socket with `forwarded` or to `url`.
    fn put_layout(
        &self,
        user: &str,
        on_socket: bool,
        forwarded: Option<&str>,
    ) -> Result<(u16, String)> {
        let layout = self.layout()?;
        let header = forwarded.map(|address| format!("X-Forwarded-For: {address}"));
        let mut args = vec![
            "-X",
            "PUT",
            "-H",
            "content-type: application/json",
            "--data-binary",
            &layout,
        ];
        if let Some(header) = &header {
            args.extend(["-H", header]);
        }
        if on_socket {
            args.extend(["--unix-socket", SOCKET, "http://yantra/api/layout"]);
        } else {
            args.push("http://127.0.0.1:7717/api/layout");
        }
        self.curl(user, &args)
    }

    fn join(&self, user: &str, name: &str) -> Result<(u16, String)> {
        let body = json!({ "user": name }).to_string();
        self.curl(
            user,
            &[
                "-X",
                "POST",
                "-H",
                "content-type: application/json",
                "--data-binary",
                &body,
                "--unix-socket",
                SOCKET,
                "http://yantra/api/join",
            ],
        )
    }

    fn rev(&self) -> Result<u64> {
        let file: Value = serde_json::from_str(&self.sh(&format!("cat {LAYOUT}"))?)?;
        file["rev"].as_u64().context("a rev")
    }
}

#[test]
fn the_kernel_proves_the_serve_hop() -> Result<()> {
    let Some(hub) = Hub::start()? else {
        return Ok(());
    };

    // (a) This machine's own address over TCP, with a forged header and without.
    for forwarded in [Some(PHONE), None] {
        let (status, body) = hub.put_layout("root", false, forwarded)?;
        assert_eq!(status, 403, "{forwarded:?}: {body}");
        assert!(body.contains(&format!("--unix-socket {SOCKET}")), "{body}");
    }

    // (b) An account that is not root, not yantra and not in the group.
    let (status, body) = hub.put_layout(UNPRIVILEGED, true, Some(PHONE))?;
    assert_eq!(status, 403, "{body}");
    assert!(body.contains(UNPRIVILEGED), "{body}");

    // (c) The serve hop forwarding this machine, and forwarding nothing.
    for forwarded in [Some("127.0.0.1"), None] {
        let (status, body) = hub.put_layout("root", true, forwarded)?;
        assert_eq!(status, 403, "{forwarded:?}: {body}");
    }
    let exists = hub.systemd.exec(&["test", "-e", LAYOUT])?;
    assert!(!exists.status.success(), "a refused write wrote the layout");

    // (d) The request through serve that still writes.
    let (status, body) = hub.put_layout("root", true, Some(PHONE))?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(hub.rev()?, 1, "dashboard.json holds the phone's write");

    // (e) An account joins itself on the socket, and nobody else.
    let (status, body) = hub.join(UNPRIVILEGED, UNPRIVILEGED)?;
    assert_eq!(
        status,
        200,
        "{body}\n{}",
        hub.systemd.journal("yantrad.service")
    );
    let (status, body) = hub.join(UNPRIVILEGED, "someone")?;
    assert_eq!(status, 403, "{body}");

    // (f) A member of the `yantra` group is this machine's owner.
    let (status, body) = hub.put_layout(MEMBER, true, None)?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(hub.rev()?, 2);
    Ok(())
}
