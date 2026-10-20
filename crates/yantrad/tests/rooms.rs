//! Y-534's done line (ADR-0038 decisions 1 to 4): sessions on two machines
//! talk through a room, a Chat thread wakes on a message in a capped mode, and
//! a room pauses at its turn budget.
//!
//! A real `yantrad` runs on this host with a scratch `HOME`, as in
//! `chat_keeper.rs`, and reaches two podman fixtures, `alpha` and `beta`, over
//! the system `ssh`. The `tailscale` shim names this host at 127.0.0.1 and the
//! two machines at 127.0.0.2 and 127.0.0.3, and answers `whois` for each
//! address from its own file. The test opens each HTTP connection from the
//! loopback address of the machine it plays, so `whois` sees that machine.
//!
//! The Claude stand-in records its arguments and its prompt, then prints a
//! recorded `init` and `result`. **No real `claude` calls the route**: a
//! fixture cannot reach the host's loopback. The arguments prove that a turn
//! gets the server; the owner's walk in Y-535 proves the real client.
//!
//! `wa` names alpha the way an ssh config often does, as a user at a DNS
//! name, and not by its Tailscale name, so the header must still route.
//!
//! The daemon binds the fixed port 7717, so this takes `chat_keeper.rs`'s lock.

#![allow(clippy::expect_used)]

#[path = "../../yantra-core/tests/common/mod.rs"]
mod common;

use std::fs;
use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use common::{SshFixture, USER};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpSocket, TcpStream};

const REPO: &str = "/home/yantra/repo";
const DAEMON: &str = "127.0.0.1:7717";
const PATIENCE: Duration = Duration::from_secs(60);
const ALPHA: &str = "127.0.0.2";
const BETA: &str = "127.0.0.3";
const STRANGER: &str = "127.0.0.4";
/// What `wa` and the ssh config call alpha: not its Tailscale name.
const ALPHA_SSH: &str = "alpha.example.ts.net";

const RECORDING: &str =
    include_str!("../../yantra-core/tests/recordings/claude-2.1.291-accept.jsonl");

/// Records `$@` and the prompt line under its pid, then plays a turn.
const CLAUDE_STAND_IN: &str = r#"#!/bin/sh
IFS= read -r prompt || exit 1
mkdir -p /home/yantra/calls
printf '%s\n' "$*" > "/home/yantra/calls/$$.args"
printf '%s\n' "$prompt" > "/home/yantra/calls/$$.prompt"
cat /home/yantra/turn.jsonl
"#;

const TAILSCALE: &str = r#"#!/bin/sh
here="$(dirname "$0")/../tailscale"
case "$1" in
status) cat "$here/status.json" ;;
whois) cat "$here/whois-$3.json" 2>/dev/null || { echo 'peer not found' >&2; exit 1; } ;;
*) exit 1 ;;
esac
"#;

/// One fixture machine, with a repository and the stand-in on `PATH`.
struct Machine {
    fixture: SshFixture,
}

impl Machine {
    fn start() -> Result<Option<Self>> {
        let Some(fixture) = SshFixture::start()? else {
            return Ok(None);
        };
        fixture.run(&format!(
            "mkdir -p {REPO} ~/.local/bin && cd {REPO} && git init -q && echo one > README \
             && git add README && git -c user.name=t -c user.email=t@example.com commit -qm one"
        ))?;
        let machine = Self { fixture };
        let init = RECORDING
            .lines()
            .find(|line| line.contains(r#""subtype":"init""#))
            .context("the recording has an init")?;
        let result = RECORDING.lines().last().context("the recording ends")?;
        machine.write("/home/yantra/turn.jsonl", &format!("{init}\n{result}\n"))?;
        machine.write("/home/yantra/.local/bin/claude", CLAUDE_STAND_IN)?;
        Ok(Some(machine))
    }

    fn write(&self, path: &str, body: &str) -> Result<()> {
        let name = Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let local = std::env::temp_dir().join(format!(
            "ykr-{}-{}-{name}",
            std::process::id(),
            self.fixture.port()
        ));
        fs::write(&local, body)?;
        let copied = self.fixture.copy_in(&local, path);
        let _ = fs::remove_file(&local);
        copied?;
        self.fixture
            .arrange_as_root(&format!("chown {USER}:{USER} {path} && chmod 755 {path}"))
    }

    fn sh(&self, command: &str) -> Result<String> {
        Ok(self.fixture.run(command)?.trim().to_owned())
    }

    /// Each Claude call's arguments and prompt text, oldest first.
    fn calls(&self) -> Result<Vec<(String, String)>> {
        let listed = self.sh("ls -tr /home/yantra/calls/*.args 2>/dev/null || true")?;
        let mut calls = Vec::new();
        for args in listed.lines().filter(|line| !line.is_empty()) {
            let prompt = args.trim_end_matches(".args").to_owned() + ".prompt";
            let line = self.sh(&format!("cat {prompt}"))?;
            let line: Value = serde_json::from_str(&line).context("the prompt is a JSON line")?;
            let text = line["message"]["content"][0]["text"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            calls.push((self.sh(&format!("cat {args}"))?, text));
        }
        Ok(calls)
    }

    async fn until_calls(&self, count: usize) -> Result<Vec<(String, String)>> {
        let deadline = Instant::now() + PATIENCE;
        loop {
            let calls = self.calls()?;
            if calls.len() >= count {
                return Ok(calls);
            }
            if Instant::now() > deadline {
                bail!("{count} Claude calls did not happen: {calls:#?}");
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

/// The scratch host, removed with every process that names it on drop.
struct Host {
    root: PathBuf,
    _lock: fs::File,
}

impl Host {
    fn new(alpha: &SshFixture, beta: &SshFixture) -> Result<Self> {
        let lock = fs::File::create(std::env::temp_dir().join("yantra-chat-keeper.lock"))?;
        lock.lock().context("waiting for the other 7717 cases")?;
        // Short: the control socket's path budget is 90 bytes (I-28).
        let root = PathBuf::from(format!("/tmp/ykr-{}", std::process::id()));
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        for dir in ["home", "run", "bin", "logs", "tailscale"] {
            fs::create_dir_all(root.join(dir))?;
        }
        fs::set_permissions(root.join("run"), fs::Permissions::from_mode(0o700))?;
        let host = Self { root, _lock: lock };

        let block = |name: &str, fixture: &SshFixture| {
            format!(
                "Host {name}\n  HostName {}\n  Port {}\n  User {USER}\n  IdentityFile {}\n  \
                 IdentitiesOnly yes\n  IdentityAgent none\n  LogLevel ERROR\n",
                fixture.host(),
                fixture.port(),
                fixture.key_path().display()
            )
        };
        let config = host.root.join("ssh_config");
        fs::write(&config, block(ALPHA_SSH, alpha) + &block("beta", beta))?;
        host.script(
            "ssh",
            &format!(
                "#!/bin/sh\nexec {} -F {} \"$@\"\n",
                which("ssh")?.display(),
                config.display()
            ),
        )?;
        host.script("tailscale", TAILSCALE)?;
        host.tailnet()?;

        let workspaces = host.root.join("home/.config/yantra/workspaces");
        fs::create_dir_all(&workspaces)?;
        let alpha_at = format!("{USER}@{ALPHA_SSH}");
        for (name, machine) in [("wa", alpha_at.as_str()), ("wb", "beta")] {
            fs::write(
                workspaces.join(format!("{name}.toml")),
                format!("machine = \"{machine}\"\nrepo = \"{REPO}\"\n"),
            )?;
        }
        Ok(host)
    }

    /// Self at 127.0.0.1, alpha and beta as peers with their own stable ids,
    /// and a `whois` answer for each address. 127.0.0.4 is another user's.
    fn tailnet(&self) -> Result<()> {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../yantra-core/tests/fixture");
        let mut status: Value =
            serde_json::from_str(&fs::read_to_string(fixtures.join("tailscale-status.json"))?)?;
        status["Self"]["TailscaleIPs"] = json!(["127.0.0.1"]);
        let template = status["Peer"]
            .as_object()
            .and_then(|peers| peers.values().next())
            .cloned()
            .context("the fixture has a peer")?;
        let mut peers = serde_json::Map::new();
        for (name, id, address) in [("alpha", "nALPHA", ALPHA), ("beta", "nBETA", BETA)] {
            let mut peer = template.clone();
            peer["ID"] = json!(id);
            peer["PublicKey"] = json!(format!("nodekey:{id}"));
            peer["HostName"] = json!(name);
            peer["DNSName"] = json!(format!("{name}.example.ts.net."));
            peer["OS"] = json!("linux");
            peer["UserID"] = json!(1);
            peer["TailscaleIPs"] = json!([address]);
            peers.insert(format!("nodekey:{id}"), peer);
        }
        status["Peer"] = Value::Object(peers);
        fs::write(self.root.join("tailscale/status.json"), status.to_string())?;

        let whois: Value =
            serde_json::from_str(&fs::read_to_string(fixtures.join("tailscale-whois.json"))?)?;
        let self_id = status["Self"]["ID"].clone();
        for (address, id, user) in [
            ("127.0.0.1", self_id, 1),
            (ALPHA, json!("nALPHA"), 1),
            (BETA, json!("nBETA"), 1),
            (STRANGER, json!("nFRIEND"), 7),
        ] {
            let mut answer = whois.clone();
            answer["Node"]["StableID"] = id;
            answer["Node"]["User"] = json!(user);
            answer["UserProfile"]["ID"] = json!(user);
            fs::write(
                self.root.join(format!("tailscale/whois-{address}.json")),
                answer.to_string(),
            )?;
        }
        Ok(())
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
        let log = fs::File::create(self.root.join("logs/yantrad.log"))?;
        let mut child = Command::new(env!("CARGO_BIN_EXE_yantrad"))
            .env_clear()
            .env("PATH", path)
            .env("HOME", self.root.join("home"))
            .env("XDG_RUNTIME_DIR", self.root.join("run"))
            .env("RUST_LOG", "info")
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
        fs::read_to_string(self.root.join("logs/yantrad.log")).unwrap_or_default()
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = Command::new("pkill")
            .args(["-KILL", "-f"])
            .arg(self.root.join("run").display().to_string())
            .status();
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// A `yantrad` that a failed assertion does not leave holding port 7717.
struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn which(binary: &str) -> Result<PathBuf> {
    std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .map(|dir| Path::new(dir).join(binary))
        .find(|path| path.is_file())
        .with_context(|| format!("no {binary} on PATH"))
}

/// One HTTP/1.1 request from `from`, so `whois` sees that address.
async fn http(
    from: &str,
    method: &str,
    path: &str,
    thread: Option<&str>,
    body: Option<&Value>,
) -> Result<(u16, String)> {
    let socket = TcpSocket::new_v4()?;
    socket.bind(SocketAddr::new(from.parse()?, 0))?;
    let mut stream = socket.connect(DAEMON.parse()?).await?;
    let body = body.map(Value::to_string).unwrap_or_default();
    let thread = thread.map_or_else(String::new, |thread| {
        format!("X-Yantra-Thread: {thread}\r\n")
    });
    stream
        .write_all(
            format!(
                "{method} {path} HTTP/1.1\r\nHost: yantra\r\nConnection: close\r\n\
                 Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n\
                 {thread}Content-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await?;
    let mut answer = String::new();
    tokio::time::timeout(PATIENCE, stream.read_to_string(&mut answer))
        .await
        .context("no answer in time")??;
    let (head, body) = answer.split_once("\r\n\r\n").context("an HTTP answer")?;
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|status| status.parse().ok())
        .context("a status")?;
    Ok((status, body.to_owned()))
}

/// A `tools/call` from `from`, and its result.
async fn tool(from: &str, thread: Option<&str>, name: &str, arguments: Value) -> Result<Value> {
    let call = json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                      "params": {"name": name, "arguments": arguments}});
    let (status, body) = http(from, "POST", "/api/mcp", thread, Some(&call)).await?;
    if status != 200 {
        bail!("{name} answered {status}: {body}");
    }
    let answer: Value = serde_json::from_str(&body)?;
    Ok(answer["result"].clone())
}

fn text(result: &Value) -> &str {
    result["content"][0]["text"].as_str().unwrap_or_default()
}

/// The WebSocket client `chat_keeper.rs` uses: masked text frames out,
/// unmasked frames in.
struct Socket {
    stream: BufReader<TcpStream>,
}

impl Socket {
    async fn open(path: &str) -> Result<Self> {
        let mut stream = BufReader::new(TcpStream::connect(DAEMON).await?);
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
        Ok(Self { stream })
    }

    async fn write(&mut self, opcode: u8, payload: &[u8]) -> Result<()> {
        let mask = [0x5a, 0x17, 0xc3, 0x09];
        let mut frame = vec![0x80 | opcode];
        match payload.len() {
            len @ 0..=125 => frame.push(0x80 | len as u8),
            len @ 126..=0xffff => {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(len as u16).to_be_bytes());
            }
            len => {
                frame.push(0x80 | 127);
                frame.extend_from_slice(&(len as u64).to_be_bytes());
            }
        }
        frame.extend_from_slice(&mask);
        frame.extend(
            payload
                .iter()
                .enumerate()
                .map(|(at, byte)| byte ^ mask[at % 4]),
        );
        self.stream.get_mut().write_all(&frame).await?;
        Ok(())
    }

    async fn next(&mut self) -> Result<Option<Value>> {
        tokio::time::timeout(PATIENCE, async {
            loop {
                let mut head = [0u8; 2];
                if self.stream.read_exact(&mut head).await.is_err() {
                    return Ok(None);
                }
                let len = match head[1] & 0x7f {
                    126 => u64::from(self.stream.read_u16().await?),
                    127 => self.stream.read_u64().await?,
                    len => u64::from(len),
                };
                let mut payload = vec![0u8; usize::try_from(len)?];
                self.stream.read_exact(&mut payload).await?;
                match head[0] & 0x0f {
                    0x1 => return Ok(Some(serde_json::from_slice(&payload)?)),
                    0x8 => return Ok(None),
                    0x9 => self.write(0xa, &payload).await?,
                    _ => {}
                }
            }
        })
        .await
        .context("no frame arrived in time")?
    }

    /// One whole turn in a new thread, and the thread's id.
    async fn turn(workspace: &str, mode: &str) -> Result<String> {
        let mut socket = Self::open(&format!("/api/workspaces/{workspace}/chat")).await?;
        let frame =
            json!({"type": "turn", "text": "join the room", "harness": "claude", "mode": mode});
        socket.write(0x1, frame.to_string().as_bytes()).await?;
        let mut thread = None;
        loop {
            let Some(frame) = socket.next().await? else {
                bail!("the socket closed before the turn ended");
            };
            if frame["type"] == "error" {
                bail!("the daemon refused: {frame}");
            }
            if frame["type"] == "thread.started" {
                thread = frame["payload"]["thread"].as_str().map(str::to_owned);
            }
            if frame["type"] == "turn.diff.updated" {
                return thread.context("thread.started came first");
            }
        }
    }
}

#[tokio::test]
async fn two_machines_talk_through_a_room_and_a_room_pauses_at_its_budget() -> Result<()> {
    let Some(alpha) = Machine::start()? else {
        return Ok(());
    };
    let Some(beta) = Machine::start()? else {
        return Ok(());
    };
    let host = Host::new(&alpha.fixture, &beta.fixture)?;
    let _daemon = host.daemon().await?;
    let walked = walk(&alpha, &beta).await;
    if walked.is_err() {
        eprintln!("yantrad's log:\n{}", host.log());
    }
    walked
}

async fn walk(alpha: &Machine, beta: &Machine) -> Result<()> {
    // 1. Each turn gets the room server and names its own thread.
    let a = Socket::turn("wa", "supervised").await?;
    let b = Socket::turn("wb", "full-access").await?;
    let (a_header, b_header) = (format!("wa/{a}"), format!("wb/{b}"));
    for (machine, header) in [(alpha, &a_header), (beta, &b_header)] {
        let calls = machine.until_calls(1).await?;
        let args = &calls[0].0;
        assert!(args.contains("--mcp-config "), "{args}");
        assert!(
            args.contains(r#""url":"http://127.0.0.1:7717/api/mcp""#),
            "{args}"
        );
        assert!(
            args.contains(&format!(r#""X-Yantra-Thread":"{header}""#)),
            "{args}"
        );
    }

    // 2. Beta speaks MCP, and thread B joins r1.
    let initialize = json!({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                            "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                       "clientInfo": {"name": "claude-code", "version": "2"}}});
    let (status, body) = http(BETA, "POST", "/api/mcp", None, Some(&initialize)).await?;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains(r#""protocolVersion":"2025-06-18""#), "{body}");
    let listed = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
    let (status, body) = http(BETA, "POST", "/api/mcp", None, Some(&listed)).await?;
    assert_eq!(status, 200, "{body}");
    assert!(
        body.contains("room_send") && body.contains("room_read"),
        "{body}"
    );
    let joined = tool(BETA, Some(&b_header), "room_read", json!({"room": "r1"})).await?;
    assert_eq!(joined["isError"], false, "{joined}");

    // 3. Thread A sends from alpha.
    let sent = tool(
        ALPHA,
        Some(&a_header),
        "room_send",
        json!({"room": "r1", "text": "hello from A"}),
    )
    .await?;
    assert_eq!(sent["isError"], false, "{sent}");
    let sent: Value = serde_json::from_str(text(&sent))?;
    assert!(sent["delivered"].as_u64() >= Some(1), "{sent}");

    // 4. Thread B wakes on beta, in acceptEdits though its mode is full access.
    let calls = beta.until_calls(2).await?;
    let (args, prompt) = &calls[1];
    assert!(
        prompt.starts_with(&format!(
            "<room name=\"r1\" from=\"alpha · chat {a}\" seq=\"1\""
        )),
        "{prompt}"
    );
    assert!(prompt.contains("hello from A"), "{prompt}");
    assert!(args.contains("--permission-mode acceptEdits"), "{args}");

    // 5. A reader on alpha waits and gets B's reply, and B's reply wakes
    //    thread A without A's own message, which is after A's cursor too.
    let waiting = tokio::spawn(tool(
        ALPHA,
        None,
        "room_read",
        json!({"room": "r1", "wait": 20}),
    ));
    tokio::time::sleep(Duration::from_secs(1)).await;
    let replied = tool(
        BETA,
        Some(&b_header),
        "room_send",
        json!({"room": "r1", "text": "reply from B"}),
    )
    .await?;
    assert_eq!(replied["isError"], false, "{replied}");
    let read = waiting.await??;
    assert!(text(&read).contains("reply from B"), "{read}");
    assert!(
        text(&read).contains(&format!("from=\"beta · chat {b}\"")),
        "{read}"
    );
    let calls = alpha.until_calls(2).await?;
    let (_, prompt) = &calls[1];
    assert!(prompt.contains("reply from B"), "{prompt}");
    assert!(!prompt.contains("hello from A"), "not its own: {prompt}");

    // 6. r2 pauses at its budget, and the owner resumes it.
    for n in 1..=20 {
        let sent = tool(
            ALPHA,
            None,
            "room_send",
            json!({"room": "r2", "text": format!("m{n}")}),
        )
        .await?;
        assert_eq!(sent["isError"], false, "{n}: {sent}");
    }
    let refused = tool(
        ALPHA,
        None,
        "room_send",
        json!({"room": "r2", "text": "m21"}),
    )
    .await?;
    assert_eq!(refused["isError"], true, "{refused}");
    assert!(text(&refused).contains("paused"), "{refused}");
    let (status, body) = http("127.0.0.1", "POST", "/api/rooms/r2/resume", None, None).await?;
    assert_eq!(status, 204, "{body}");
    let again = tool(
        ALPHA,
        None,
        "room_send",
        json!({"room": "r2", "text": "m22"}),
    )
    .await?;
    assert_eq!(again["isError"], false, "{again}");

    // 7. Another user's node is refused.
    let (status, body) = http(STRANGER, "POST", "/api/mcp", None, Some(&listed)).await?;
    assert_eq!(status, 403, "{body}");
    Ok(())
}
