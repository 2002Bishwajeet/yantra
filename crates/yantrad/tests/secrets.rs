//! Y-647's done line: no process the daemon starts holds the GitHub token or
//! the relay's secrets, read from a real child's environment.
//!
//! A real `yantrad` runs on this host with all three in its environment, as the
//! unit gives them. Its `tailscale` and `ssh` are shims that write `env` to a
//! file and answer, so no podman fixture is needed: an ssh that fails still ran.
//!
//! The daemon binds the fixed port 7717, so this takes `chat_keeper.rs`'s lock.
//! The fake token makes the daemon ask api.github.com once; nothing here reads
//! the answer.

#![allow(clippy::expect_used)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpStream, UnixStream};
use yantra_core::SECRETS;

const DAEMON: &str = "127.0.0.1:7717";
/// A peer the status fixture lists as online.
const MACHINE: &str = "bishwajeets-macbook-pro";

/// Renamed into place, so a file that exists is a whole one.
fn recorder(name: &str, then: &str) -> String {
    format!(
        "#!/bin/sh\nhere=\"$(dirname \"$0\")/../env\"\nenv > \"$here/.{name}-$$\"\n\
         mv \"$here/.{name}-$$\" \"$here/{name}-$$.env\"\n{then}\n"
    )
}

const TAILSCALE: &str = r#"case "$1" in
status) cat "$(dirname "$0")/../tailscale/status.json" ;;
whois) cat "$(dirname "$0")/../tailscale/whois.json" ;;
*) exit 1 ;;
esac"#;

/// The scratch host, removed with every process that names it on drop.
struct Host {
    root: PathBuf,
    _lock: fs::File,
}

impl Host {
    fn new() -> Result<Self> {
        let lock = fs::File::create(std::env::temp_dir().join("yantra-chat-keeper.lock"))?;
        lock.lock()
            .context("waiting for the other cases that bind 7717")?;
        let root = root();
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        for dir in ["home", "run", "bin", "env", "tailscale"] {
            fs::create_dir_all(root.join(dir))?;
        }
        fs::set_permissions(root.join("run"), fs::Permissions::from_mode(0o700))?;
        let host = Self { root, _lock: lock };

        host.script("ssh", &recorder("ssh", "exit 255"))?;
        host.script("tailscale", &recorder("tailscale", TAILSCALE))?;

        let fixtures =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../yantra-core/tests/fixture");
        let status = fs::read_to_string(fixtures.join("tailscale-status.json"))?;
        let at = r#""TailscaleIPs": ["100.64.0.1", "fd7a:115c:a1e0::1"],"#;
        if status.matches(at).count() != 1 {
            bail!("tailscale-status.json no longer names Self's addresses as {at}");
        }
        fs::write(
            host.root.join("tailscale/status.json"),
            status.replacen(at, r#""TailscaleIPs": ["127.0.0.1"],"#, 1),
        )?;
        fs::copy(
            fixtures.join("tailscale-whois.json"),
            host.root.join("tailscale/whois.json"),
        )?;

        let workspaces = host.root.join("home/.config/yantra/workspaces");
        fs::create_dir_all(&workspaces)?;
        fs::write(
            workspaces.join("sw.toml"),
            format!("machine = \"{MACHINE}\"\nrepo = \"/home/yantra/repo\"\n"),
        )?;
        Ok(host)
    }

    fn script(&self, name: &str, body: &str) -> Result<()> {
        let path = self.root.join("bin").join(name);
        fs::write(&path, body)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
        Ok(())
    }

    async fn daemon(&self) -> Result<Daemon> {
        let path = format!(
            "{}:{}",
            self.root.join("bin").display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let log = fs::File::create(self.root.join("yantrad.log"))?;
        let mut child = Command::new(env!("CARGO_BIN_EXE_yantrad"))
            .env_clear()
            .env("PATH", path)
            .env("HOME", self.root.join("home"))
            .env("XDG_RUNTIME_DIR", self.root.join("run"))
            .env("RUNTIME_DIRECTORY", self.root.join("run"))
            .env("RUST_LOG", "info")
            .env(yantra_core::github::TOKEN, "gho_notarealtoken")
            .env(yantra_core::notify::RELAY_TOKEN, "tk_notarealtoken")
            .env(yantra_core::notify::RELAY_URL, "http://127.0.0.1:9/never")
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .spawn()
            .context("starting yantrad")?;
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if let Some(status) = child.try_wait()? {
                bail!("yantrad exited {status}: {}", self.log());
            }
            if TcpStream::connect(DAEMON).await.is_ok() {
                return Ok(Daemon(child));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let _ = child.kill();
        bail!("yantrad never answered: {}", self.log())
    }

    fn log(&self) -> String {
        fs::read_to_string(self.root.join("yantrad.log")).unwrap_or_default()
    }

    /// Each recorded environment, by file name.
    fn recorded(&self) -> Result<Vec<(String, String)>> {
        let mut found = Vec::new();
        for entry in fs::read_dir(self.root.join("env"))? {
            let path = entry?.path();
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
            if let Some(name) = name.filter(|n| n.ends_with(".env")) {
                found.push((name, fs::read_to_string(&path)?));
            }
        }
        Ok(found)
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = Command::new("pkill")
            .args(["-KILL", "-f"])
            .arg(self.root.display().to_string())
            .status();
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Short: the control socket's path budget is 90 bytes (I-28).
fn root() -> PathBuf {
    PathBuf::from(format!("/tmp/yks-{}", std::process::id()))
}

/// ADR-0042: this host's own address is refused over TCP, so the requests go
/// on the daemon's socket, as the account that runs it.
fn daemon_socket() -> PathBuf {
    root().join("run/yantrad.sock")
}

/// A `yantrad` that a failed assertion does not leave holding port 7717.
struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Opens a terminal socket and sends the window it must open with, which sends
/// the daemon to ssh. What it answers does not matter here.
async fn knock(path: &str) -> Result<()> {
    let mut stream = BufReader::new(UnixStream::connect(daemon_socket()).await?);
    stream
        .get_mut()
        .write_all(
            format!(
                "GET {path} HTTP/1.1\r\nHost: yantra\r\nConnection: Upgrade\r\n\
                 Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\
                 Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
            )
            .as_bytes(),
        )
        .await?;
    let mut status = String::new();
    stream.read_line(&mut status).await?;
    if !status.starts_with("HTTP/1.1 101") {
        bail!("the upgrade was refused: {status}");
    }
    let mut line = String::new();
    while line != "\r\n" {
        line.clear();
        if stream.read_line(&mut line).await? == 0 {
            bail!("the upgrade ended mid-header");
        }
    }

    let payload = json!({"rows": 24, "cols": 80, "term": "xterm-256color"}).to_string();
    let mask = [0x5a, 0x17, 0xc3, 0x09];
    let mut frame = vec![0x81, 0x80 | u8::try_from(payload.len())?];
    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .bytes()
            .enumerate()
            .map(|(at, byte)| byte ^ mask[at % 4]),
    );
    stream.get_mut().write_all(&frame).await?;

    // The daemon's first frame is the reason the terminal did not open, sent
    // once every ssh it tried has run.
    let mut head = [0u8; 2];
    let _ = tokio::time::timeout(Duration::from_secs(30), stream.read_exact(&mut head)).await;
    Ok(())
}

#[tokio::test]
async fn no_child_the_daemon_starts_holds_a_secret() -> Result<()> {
    let host = Host::new()?;
    let _daemon = host.daemon().await?;

    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        let names: Vec<String> = host.recorded()?.into_iter().map(|(n, _)| n).collect();
        if ["ssh-", "tailscale-"]
            .iter()
            .all(|kind| names.iter().any(|n| n.starts_with(kind)))
        {
            break;
        }
        if Instant::now() > deadline {
            bail!(
                "the daemon ran no ssh or no tailscale: {names:?}\n{}",
                host.log()
            );
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    knock(&format!("/api/machines/{MACHINE}/sessions/x/terminal")).await?;

    let recorded = host.recorded()?;
    for (name, env) in &recorded {
        if !env.lines().any(|line| line.starts_with("PATH=")) {
            bail!("{name} holds no PATH, so it proves nothing:\n{env}");
        }
        for secret in SECRETS {
            if env
                .lines()
                .any(|line| line.starts_with(&format!("{secret}=")))
            {
                bail!("{name} holds {secret}");
            }
        }
    }
    eprintln!("read {} environments", recorded.len());
    Ok(())
}
