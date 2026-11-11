//! ADR-0044's done test, against the real `yantrad` under its own unit in a
//! disposable podman container (§B3, Y-687). A soft authenticator on the host
//! plays the owner's phone: it answers the ceremonies the daemon in the
//! container sends, and its requests reach the daemon the way the `serve` hop
//! does, as root on the socket with `X-Forwarded-For`.
//!
//! Two cases are proved elsewhere. A revoked session's open WebSocket closing
//! is `mic::tests::a_revoked_session_closes_its_open_mic`, because no socket
//! here stays open without a machine to reach. Decision 12's agent token is
//! `rooms.rs` and `main.rs`'s `an_agent_token_gets_403_on_every_owner_route`, because only a Chat
//! turn mints one.

mod common;

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use webauthn_authenticator_rs::WebauthnAuthenticator as _;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_rs::prelude::{CreationChallengeResponse, RequestChallengeResponse, Url};

use common::{Systemd, UNPRIVILEGED, repo_root};

const SOCKET: &str = "/run/yantra/yantrad.sock";
const FILE: &str = "/home/yantra/.config/yantra/passkeys.toml";
const PHONE: &str = "100.64.0.9";
const COOKIE: &str = "__Host-yantra_session";

const TAILSCALE_STUB: &str = r#"#!/bin/sh
case "$1" in
status) cat /srv/tailscale/status.json ;;
whois) cat "/srv/tailscale/whois-$3.json" 2>/dev/null || { echo 'peer not found' >&2; exit 1; } ;;
*) exit 1 ;;
esac
"#;

/// What one request answered.
struct Answer {
    status: u16,
    head: String,
    body: String,
}

impl Answer {
    fn json(&self) -> Result<Value> {
        serde_json::from_str(&self.body).with_context(|| format!("not JSON: {}", self.body))
    }

    /// The token the `Set-Cookie` line carries, and the whole line.
    fn cookie(&self) -> Result<(String, String)> {
        let line = self
            .head
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("set-cookie:"))
            .with_context(|| format!("no Set-Cookie in {}", self.head))?;
        let token = line
            .split_once(&format!("{COOKIE}="))
            .and_then(|(_, rest)| rest.split(';').next())
            .context("the session cookie")?;
        Ok((token.to_owned(), line.trim().to_owned()))
    }
}

struct Hub {
    systemd: Systemd,
    origin: Url,
}

impl Hub {
    fn start() -> Result<Option<Self>> {
        let Some(systemd) = Systemd::start()? else {
            return Ok(None);
        };
        systemd.arrange_account()?;
        systemd.run(&["mkdir", "-p", "/srv/tailscale"])?;
        systemd.copy_in(
            Path::new(env!("CARGO_BIN_EXE_yantrad")),
            "/usr/local/bin/yantrad",
        )?;
        let name = tailnet(&systemd)?;
        systemd.install_unit("yantrad.service")?;
        let hub = Self {
            systemd,
            origin: Url::parse(&format!("https://{name}:8443"))?,
        };
        hub.restart()?;
        Ok(Some(hub))
    }

    /// Starts the unit and waits until it has looked at the tailnet, which
    /// is when it knows the name a passkey is bound to.
    fn restart(&self) -> Result<()> {
        self.sh(
            "systemctl daemon-reload && systemctl restart yantrad.service && \
             for _ in $(seq 50); do (exec 3<>/dev/tcp/127.0.0.1/7717) 2>/dev/null && exit 0; sleep 0.2; done; exit 1",
        )
        .map_err(|error| error.context(self.systemd.journal("yantrad.service")))?;
        for _ in 0..50 {
            if self
                .phone("POST", "/api/passkey/login/start", None, None)?
                .status
                != 503
            {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        bail!(
            "yantrad never learnt its MagicDNS name\n{}",
            self.systemd.journal("yantrad.service")
        )
    }

    /// Restarts the unit with `YANTRA_ORIGIN` set to `origin`, as
    /// `/etc/yantra/daemon.env` would set it.
    fn serve_at(&mut self, origin: &str) -> Result<()> {
        self.sh(&format!(
            "mkdir -p /etc/systemd/system/yantrad.service.d && \
             printf '[Service]\\nEnvironment=YANTRA_ORIGIN={origin}\\n' \
               > /etc/systemd/system/yantrad.service.d/origin.conf"
        ))?;
        self.origin = Url::parse(origin)?;
        self.restart()
    }

    fn sh(&self, script: &str) -> Result<String> {
        self.systemd.run(&["bash", "-c", script])
    }

    /// `curl -i` as `user` on the socket, with `headers` and a JSON `body`.
    fn curl(
        &self,
        user: &str,
        method: &str,
        path: &str,
        headers: &[String],
        body: Option<&Value>,
    ) -> Result<Answer> {
        let body = body.map(Value::to_string);
        let url = format!("http://yantra{path}");
        let mut argv = vec![
            "curl",
            "-sS",
            "-i",
            "--max-time",
            "10",
            "-w",
            "\n%{http_code}",
            "-X",
            method,
            "--unix-socket",
            SOCKET,
        ];
        for header in headers {
            argv.extend(["-H", header.as_str()]);
        }
        if let Some(body) = &body {
            argv.extend([
                "-H",
                "content-type: application/json",
                "--data-binary",
                body,
            ]);
        }
        argv.push(&url);
        let out = self.systemd.exec_as(user, &argv)?;
        if !out.status.success() {
            bail!(
                "curl as {user} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        let said = String::from_utf8(out.stdout)?;
        let (answer, status) = said.rsplit_once('\n').unwrap_or(("", said.as_str()));
        let (head, body) = answer.split_once("\r\n\r\n").unwrap_or((answer, ""));
        Ok(Answer {
            status: status.trim().parse()?,
            head: head.to_owned(),
            body: body.to_owned(),
        })
    }

    /// The owner's phone through the `serve` hop, with `token` as its cookie.
    fn phone(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<&Value>,
    ) -> Result<Answer> {
        self.phone_from(method, path, token, None, body)
    }

    fn phone_from(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        origin: Option<&str>,
        body: Option<&Value>,
    ) -> Result<Answer> {
        let mut headers = vec![format!("X-Forwarded-For: {PHONE}")];
        headers.extend(token.map(|token| format!("Cookie: {COOKIE}={token}")));
        headers.extend(origin.map(|origin| format!("Origin: {origin}")));
        self.curl("root", method, path, &headers, body)
    }

    /// A code from `user` on the socket.
    fn code(&self, user: &str) -> Result<Answer> {
        self.curl(user, "POST", "/api/passkey/code", &[], None)
    }

    /// Enrolment with `code`, signed by `soft`: the finish's answer.
    fn enrol(&self, soft: &mut SoftPasskey, code: &str, device: &str) -> Result<Answer> {
        let begun = self.phone(
            "POST",
            "/api/passkey/register/start",
            None,
            Some(&json!({ "code": code, "device": device })),
        )?;
        if begun.status != 200 {
            return Ok(begun);
        }
        let begun = begun.json()?;
        let options: CreationChallengeResponse = serde_json::from_value(begun["options"].clone())?;
        let credential = soft
            .do_registration(self.origin.clone(), options)
            .map_err(|error| anyhow::anyhow!("the soft authenticator: {error:?}"))?;
        self.phone(
            "POST",
            "/api/passkey/register/finish",
            None,
            Some(&json!({ "ceremony": begun["ceremony"], "credential": credential })),
        )
    }

    fn sign_in(&self, soft: &mut SoftPasskey) -> Result<Answer> {
        let begun = self.phone(
            "POST",
            "/api/passkey/login/start",
            None,
            Some(&json!({ "device": "Mac" })),
        )?;
        assert_eq!(begun.status, 200, "{}", begun.body);
        let begun = begun.json()?;
        let options: RequestChallengeResponse = serde_json::from_value(begun["options"].clone())?;
        let credential = soft
            .do_authentication(self.origin.clone(), options)
            .map_err(|error| anyhow::anyhow!("the soft authenticator: {error:?}"))?;
        self.phone(
            "POST",
            "/api/passkey/login/finish",
            None,
            Some(&json!({ "ceremony": begun["ceremony"], "credential": credential })),
        )
    }

    /// `PUT /api/layout` from the phone, with the layout the socket reads.
    fn write(&self, token: Option<&str>, origin: Option<&str>) -> Result<Answer> {
        let layout = self
            .curl("yantra", "GET", "/api/layout", &[], None)?
            .json()?;
        self.phone_from("PUT", "/api/layout", token, origin, Some(&layout))
    }
}

/// Self at 127.0.0.1, the one address the daemon binds here, and `whois`
/// naming Self there and the owner's phone at [`PHONE`]. The node's name.
fn tailnet(systemd: &Systemd) -> Result<String> {
    let fixtures = repo_root().join("crates/yantra-core/tests/fixture");
    let mut status: Value = serde_json::from_str(&std::fs::read_to_string(
        fixtures.join("tailscale-status.json"),
    )?)?;
    status["Self"]["TailscaleIPs"] = json!(["127.0.0.1"]);
    status["Peer"] = json!({});
    let whois: Value = serde_json::from_str(&std::fs::read_to_string(
        fixtures.join("tailscale-whois.json"),
    )?)?;

    let mut script = format!("cat > /srv/tailscale/status.json <<'JSON'\n{status}\nJSON\n");
    for (address, id) in [
        ("127.0.0.1", status["Self"]["ID"].clone()),
        (PHONE, json!("nPHONE0000011CNTRL")),
    ] {
        let mut answer = whois.clone();
        answer["Node"]["StableID"] = id;
        answer["Node"]["User"] = status["Self"]["UserID"].clone();
        answer["UserProfile"]["ID"] = status["Self"]["UserID"].clone();
        script.push_str(&format!(
            "cat > /srv/tailscale/whois-{address}.json <<'JSON'\n{answer}\nJSON\n"
        ));
    }
    systemd.run(&[
        "bash",
        "-c",
        &format!(
            "{script}chmod -R a+rX /srv/tailscale\n\
             cat > /usr/bin/tailscale <<'STUB'\n{TAILSCALE_STUB}STUB\nchmod 755 /usr/bin/tailscale"
        ),
    ])?;
    Ok(status["Self"]["DNSName"]
        .as_str()
        .context("Self's DNSName")?
        .trim_end_matches('.')
        .to_owned())
}

#[test]
fn a_write_needs_the_owners_passkey() -> Result<()> {
    let Some(hub) = Hub::start()? else {
        return Ok(());
    };

    // (a) No cookie from the owner's phone: 401 on a read and a write; the
    //     open routes answer.
    let read = hub.phone("GET", "/api/sessions", None, None)?;
    assert_eq!(read.status, 401, "{}", read.body);
    assert!(
        read.body.contains("sign in from the dashboard"),
        "{}",
        read.body
    );
    assert_eq!(hub.write(None, None)?.status, 401);
    for open in ["/healthz", "/api/about", "/join"] {
        let answer = hub.phone("GET", open, None, None)?;
        assert_ne!(answer.status, 401, "{open}: {}", answer.body);
        assert_ne!(answer.status, 403, "{open}: {}", answer.body);
    }

    // (b) A code from the yantra uid enrols once; a code from another uid is
    //     refused, and a used code is refused.
    let refused = hub.code(UNPRIVILEGED)?;
    assert_eq!(refused.status, 403, "{}", refused.body);
    let code = hub.code("yantra")?;
    assert_eq!(code.status, 200, "{}", code.body);
    let code = code.json()?["code"].as_str().context("a code")?.to_owned();
    let mut phone = SoftPasskey::new(true);
    let enrolled = hub.enrol(&mut phone, &code, "iPhone")?;
    assert_eq!(enrolled.status, 200, "{}", enrolled.body);
    let again = hub.enrol(&mut SoftPasskey::new(true), &code, "Thief")?;
    assert_eq!(again.status, 401, "a used code: {}", again.body);

    // (c) A sign-in sets the cookie with all five attributes, and a write
    //     with it passes.
    let signed = hub.sign_in(&mut phone)?;
    assert_eq!(signed.status, 200, "{}", signed.body);
    let (token, line) = signed.cookie()?;
    for attribute in [
        "Secure",
        "HttpOnly",
        "SameSite=Strict",
        "Path=/",
        "Max-Age=2592000",
    ] {
        assert!(line.contains(attribute), "{attribute} missing from {line}");
    }
    let wrote = hub.write(
        Some(&token),
        Some(hub.origin.as_str().trim_end_matches('/')),
    )?;
    assert_eq!(wrote.status, 200, "{}", wrote.body);

    // (d) The same cookie with a foreign Origin is refused.
    let foreign = hub.write(Some(&token), Some("https://evil.example"))?;
    assert_eq!(foreign.status, 403, "{}", foreign.body);

    // (e) A forged cookie, and the hash the file keeps, are refused; the file
    //     is 0600 and holds no token.
    assert_eq!(
        hub.phone("GET", "/api/sessions", Some("forged"), None)?
            .status,
        401
    );
    let file = hub.sh(&format!("stat -c %a {FILE} && cat {FILE}"))?;
    let (mode, saved) = file.split_once('\n').context("a mode and a file")?;
    assert_eq!(mode, "600", "{file}");
    assert!(!saved.contains(&token), "the file holds a token");
    let saved: toml::Value = toml::from_str(saved)?;
    let hash = saved["session"][0]["hash"].as_str().context("a hash")?;
    assert_eq!(
        hub.phone("GET", "/api/sessions", Some(hash), None)?.status,
        401
    );
    assert_eq!(
        hub.phone("GET", "/api/sessions", Some(&token), None)?
            .status,
        200
    );

    // (f) A session survives a restart; a revoked one is refused on its next
    //     request. A code that outlived its life is refused.
    hub.sh("mkdir -p /etc/systemd/system/yantrad.service.d && \
         printf '[Service]\\nEnvironment=YANTRA_PASSKEY_CODE_SECONDS=1\\n' \
           > /etc/systemd/system/yantrad.service.d/code.conf")?;
    hub.restart()?;
    assert_eq!(
        hub.phone("GET", "/api/sessions", Some(&token), None)?
            .status,
        200
    );
    let listed = hub
        .curl("yantra", "GET", "/api/passkey", &[], None)?
        .json()?;
    let id = listed["sessions"]
        .as_array()
        .context("sessions")?
        .iter()
        .find(|session| session["device"] == "Mac")
        .and_then(|session| session["id"].as_str())
        .context("the Mac's session")?
        .to_owned();
    let revoked = hub.curl(
        "yantra",
        "DELETE",
        &format!("/api/sessions/{id}"),
        &[],
        None,
    )?;
    assert!(revoked.status < 300, "{}", revoked.body);
    assert_eq!(
        hub.phone("GET", "/api/sessions", Some(&token), None)?
            .status,
        401
    );

    let code = hub.code("yantra")?.json()?["code"]
        .as_str()
        .context("a code")?
        .to_owned();
    std::thread::sleep(Duration::from_secs(2));
    let late = hub.enrol(&mut SoftPasskey::new(true), &code, "Late")?;
    assert_eq!(late.status, 401, "an expired code: {}", late.body);
    Ok(())
}

/// The 2026-11-12 amendment: with `YANTRA_ORIGIN` set, a passkey is made and
/// used for that origin, and a write names it rather than the MagicDNS one.
#[test]
fn a_configured_origin_is_the_one_a_passkey_and_a_write_use() -> Result<()> {
    let Some(mut hub) = Hub::start()? else {
        return Ok(());
    };
    let magic = hub.origin.as_str().trim_end_matches('/').to_owned();
    let own = "https://yantra.cloudx.run";
    hub.serve_at(own)?;

    let code = hub.code("yantra")?.json()?["code"]
        .as_str()
        .context("a code")?
        .to_owned();
    let mut phone = SoftPasskey::new(true);
    let enrolled = hub.enrol(&mut phone, &code, "iPhone")?;
    assert_eq!(enrolled.status, 200, "{}", enrolled.body);
    let signed = hub.sign_in(&mut phone)?;
    assert_eq!(signed.status, 200, "{}", signed.body);
    let (token, _) = signed.cookie()?;

    let listed = hub
        .curl("yantra", "GET", "/api/passkey", &[], None)?
        .json()?;
    assert_eq!(listed["relying_party"], "yantra.cloudx.run", "{listed}");
    let wrote = hub.write(Some(&token), Some(own))?;
    assert_eq!(wrote.status, 200, "{}", wrote.body);
    let refused = hub.write(Some(&token), Some(&magic))?;
    assert_eq!(refused.status, 403, "{}", refused.body);
    Ok(())
}
