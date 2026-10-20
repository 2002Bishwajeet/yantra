//! Y-447's done line (ADR-0035, "What proves it"): a chat turn outlives its
//! ssh pipe, its socket and the daemon that started it.
//!
//! A real `yantrad` runs on this host with a scratch `HOME` and
//! `XDG_RUNTIME_DIR`, and reaches §B3's podman fixture over the system `ssh`.
//! Two shims on its `PATH` stand in for what a container cannot hold: a
//! `tailscale` that names this host at 127.0.0.1 and the caller as its owner,
//! and an `ssh` that adds `-F` with a config naming the fixture. The agent is
//! a stand-in on the fixture's `PATH`: one plays a recorded Claude turn, one
//! speaks ACP. A third case runs the real `claude` with the owner's login.
//!
//! The daemon binds the fixed port 7717, so the cases take a file lock and run
//! one at a time whatever the test runner does.

#![allow(clippy::expect_used)]

#[path = "../../yantra-core/tests/common/mod.rs"]
mod common;

use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use common::{SshFixture, USER};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

const WORKSPACE: &str = "kw";
const REPO: &str = "/home/yantra/repo";
const DAEMON: &str = "127.0.0.1:7717";
/// The recording's gap is 0.5 s a line, so a stand-in turn takes about 20 s.
const PATIENCE: Duration = Duration::from_secs(60);
/// A real Claude turn on a cold container loads a 240 MB binary first.
const REAL_PATIENCE: Duration = Duration::from_secs(180);

const RECORDING: &str =
    include_str!("../../yantra-core/tests/recordings/claude-2.1.291-accept.jsonl");

/// Plays the recording a line every 0.5 s, and holds at the `control_request`
/// until a `control_response` arrives on stdin, as `claude -p` does.
const CLAUDE_STAND_IN: &str = r#"#!/bin/sh
IFS= read -r prompt || exit 1
while IFS= read -r line <&3; do
  sleep 0.5
  printf '%s\n' "$line"
  case "$line" in
  *'"type":"control_request"'*)
    while IFS= read -r answer; do
      case "$answer" in *'"type":"control_response"'*) break ;; esac
    done
    touch made.txt
    ;;
  esac
done 3< /home/yantra/recording.jsonl
"#;

/// An ACP agent in a few lines of sh: four chunks, one permission request it
/// holds on, then `made.txt`, a last chunk and the prompt's answer.
const ACP_STAND_IN: &str = r#"#!/bin/sh
say() { printf '%s\n' "$1"; }
chunk() {
  say "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"ses_1\",\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"messageId\":\"m1\",\"content\":{\"type\":\"text\",\"text\":\"$1\"}}}}"
}
while IFS= read -r line; do
  i=$(printf '%s' "$line" | sed -nE 's/.*"id":("[^"]*"|[0-9]+).*/\1/p')
  case "$line" in
  *'"method":"initialize"'*)
    say "{\"jsonrpc\":\"2.0\",\"id\":$i,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{\"loadSession\":true}}}" ;;
  *'"method":"session/new"'*)
    say "{\"jsonrpc\":\"2.0\",\"id\":$i,\"result\":{\"sessionId\":\"ses_1\"}}" ;;
  *'"method":"session/load"'*)
    say "{\"jsonrpc\":\"2.0\",\"id\":$i,\"result\":null}" ;;
  *'"method":"session/prompt"'*)
    for n in 1 2 3 4; do sleep 0.5; chunk "part $n. "; done
    sleep 0.5
    say '{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"sessionId":"ses_1","toolCall":{"toolCallId":"call_1","title":"touch made.txt","kind":"execute"},"options":[{"optionId":"once","name":"Allow once","kind":"allow_once"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}'
    while IFS= read -r answer; do
      case "$answer" in *'"id":7,'*|*'"id":7}'*) break ;; esac
    done
    touch made.txt
    sleep 0.5
    chunk "Made it."
    say "{\"jsonrpc\":\"2.0\",\"id\":$i,\"result\":{\"stopReason\":\"end_turn\"}}" ;;
  esac
done
"#;

const TAILSCALE: &str = r#"#!/bin/sh
case "$1" in
status) cat "$(dirname "$0")/../tailscale/status.json" ;;
whois) cat "$(dirname "$0")/../tailscale/whois.json" ;;
*) exit 1 ;;
esac
"#;

/// Which agent a case runs.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Agent {
    StandIn,
    Acp,
    RealClaude,
}

impl Agent {
    /// The harness a turn names, and the pattern `pgrep -f` finds it by.
    fn harness(self) -> &'static str {
        match self {
            Self::Acp => "gemini",
            Self::StandIn | Self::RealClaude => "claude",
        }
    }

    fn process(self) -> &'static str {
        match self {
            Self::Acp => "bin/gemin[i] --acp",
            Self::StandIn | Self::RealClaude => "bin/claud[e] --permission-mode",
        }
    }

    /// The line in `out` that holds the turn, and the one in `in` that frees it.
    fn request(self) -> (&'static str, &'static str) {
        match self {
            Self::Acp => ("session/request_permission", "\"id\":7,"),
            Self::StandIn | Self::RealClaude => {
                ("\"type\":\"control_request\"", "control_response")
            }
        }
    }

    fn prompt(self) -> &'static str {
        match self {
            Self::RealClaude => {
                "Run the shell command `touch made.txt` in the current directory with the Bash tool, then say done."
            }
            Self::StandIn | Self::Acp => "Run touch made.txt",
        }
    }

    fn patience(self) -> Duration {
        match self {
            Self::RealClaude => REAL_PATIENCE,
            Self::StandIn | Self::Acp => PATIENCE,
        }
    }
}

/// The scratch host: a `HOME`, a runtime directory for the ssh sockets, the
/// shims, and the daemons' logs. Removed, with every process that names it, on
/// drop.
struct Host {
    root: PathBuf,
    real_ssh: PathBuf,
    _lock: fs::File,
}

impl Host {
    fn new(fixture: &SshFixture) -> Result<Self> {
        let lock = fs::File::create(std::env::temp_dir().join("yantra-chat-keeper.lock"))?;
        lock.lock()
            .context("waiting for the other chat_keeper cases")?;
        // Short: the control socket's path budget is 90 bytes (I-28).
        let root = PathBuf::from(format!("/tmp/ykc-{}", std::process::id()));
        if root.exists() {
            fs::remove_dir_all(&root)?;
        }
        for dir in ["home", "run", "bin", "logs", "tailscale"] {
            fs::create_dir_all(root.join(dir))?;
        }
        fs::set_permissions(root.join("run"), fs::Permissions::from_mode(0o700))?;
        let real_ssh = which("ssh")?;
        let host = Self {
            root,
            real_ssh,
            _lock: lock,
        };

        let config = host.root.join("ssh_config");
        fs::write(
            &config,
            format!(
                "Host fixture\n  HostName {}\n  Port {}\n  User {USER}\n  IdentityFile {}\n  \
                 IdentitiesOnly yes\n  IdentityAgent none\n  LogLevel ERROR\n",
                fixture.host(),
                fixture.port(),
                fixture.key_path().display()
            ),
        )?;
        host.script(
            "ssh",
            &format!(
                "#!/bin/sh\nexec {} -F {} \"$@\"\n",
                host.real_ssh.display(),
                config.display()
            ),
        )?;
        host.script("tailscale", TAILSCALE)?;

        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../yantra-core/tests/fixture");
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
            workspaces.join(format!("{WORKSPACE}.toml")),
            format!("machine = \"fixture\"\nrepo = \"{REPO}\"\n"),
        )?;
        Ok(host)
    }

    fn script(&self, name: &str, body: &str) -> Result<()> {
        let path = self.root.join("bin").join(name);
        fs::write(&path, body)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
        Ok(())
    }

    /// Starts a `yantrad` and waits until it answers.
    async fn daemon(&self, label: &str) -> Result<Daemon> {
        let path = format!(
            "{}:{}",
            self.root.join("bin").display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let log = fs::File::create(self.root.join("logs").join(format!("{label}.log")))?;
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
                bail!("yantrad {label} exited {status}: {}", self.log(label));
            }
            if TcpStream::connect(DAEMON).await.is_ok() {
                return Ok(Daemon(child));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let _ = child.kill();
        bail!("yantrad {label} never answered: {}", self.log(label))
    }

    fn log(&self, label: &str) -> String {
        fs::read_to_string(self.root.join("logs").join(format!("{label}.log"))).unwrap_or_default()
    }

    /// Step 2: ends every multiplexed connection, then the daemon's own `ssh`
    /// children, among them the reader.
    fn cut_the_pipe(&self, daemon: &Daemon) -> Result<()> {
        for socket in fs::read_dir(self.root.join("run/yantra/cm"))? {
            let socket = socket?.path();
            let _ = Command::new(self.root.join("bin/ssh"))
                .arg("-o")
                .arg(format!("ControlPath={}", socket.display()))
                .args(["-O", "exit", "fixture"])
                .output();
        }
        for pid in children(daemon.0.id(), "ssh")? {
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
        }
        Ok(())
    }

    /// Every file under the scratch host but the runtime directory and the
    /// logs, which are the daemon's ssh sockets and this test's own.
    fn files(&self) -> Result<BTreeSet<PathBuf>> {
        let mut found = BTreeSet::new();
        let mut todo = vec![self.root.clone()];
        while let Some(dir) = todo.pop() {
            for entry in fs::read_dir(&dir)? {
                let path = entry?.path();
                if path == self.root.join("run") || path == self.root.join("logs") {
                    continue;
                }
                if path.is_dir() {
                    todo.push(path);
                } else {
                    found.insert(path);
                }
            }
        }
        Ok(found)
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        // A killed daemon leaves its ssh children, which name the runtime
        // directory in their ControlPath.
        let _ = Command::new("pkill")
            .args(["-KILL", "-f"])
            .arg(self.root.join("run").display().to_string())
            .status();
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// A `yantrad` that a failed assertion does not leave holding port 7717.
struct Daemon(Child);

impl Daemon {
    fn kill(mut self) -> Result<()> {
        self.0.kill()?;
        self.0.wait()?;
        Ok(())
    }
}

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

/// The pids of `parent`'s children named `name`, from `/proc`.
fn children(parent: u32, name: &str) -> Result<Vec<u32>> {
    let mut found = Vec::new();
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        // `pid (comm) state ppid …`, and `comm` may hold spaces.
        let Some((comm, rest)) = stat
            .split_once(" (")
            .and_then(|(_, rest)| rest.rsplit_once(") "))
        else {
            continue;
        };
        let ppid = rest.split_whitespace().nth(1).and_then(|p| p.parse().ok());
        if comm == name && ppid == Some(parent) {
            found.push(pid);
        }
    }
    Ok(found)
}

/// The fixture's side: a repository, the agent on `PATH`, and what to ask it.
struct Machine {
    fixture: SshFixture,
}

impl Machine {
    fn start(agent: Agent) -> Result<Option<Self>> {
        let login = match agent {
            Agent::RealClaude => match credentials()? {
                Some(login) => Some(login),
                None => return Ok(None),
            },
            Agent::StandIn | Agent::Acp => None,
        };
        let Some(fixture) = SshFixture::start()? else {
            return Ok(None);
        };
        fixture.run(&format!(
            "mkdir -p {REPO} ~/.local/bin && cd {REPO} && git init -q && echo one > README \
             && git add README && git -c user.name=t -c user.email=t@example.com commit -qm one"
        ))?;
        let machine = Self { fixture };
        match agent {
            Agent::StandIn => {
                machine.write("/home/yantra/recording.jsonl", RECORDING)?;
                machine.write("/home/yantra/.local/bin/claude", CLAUDE_STAND_IN)?;
            }
            Agent::Acp => machine.write("/home/yantra/.local/bin/gemini", ACP_STAND_IN)?,
            Agent::RealClaude => {
                let login = login.context("a login")?;
                machine.fixture.arrange_as_root(&format!(
                    "install -d -o {USER} -g {USER} -m 700 /home/{USER}/.claude"
                ))?;
                machine
                    .fixture
                    .copy_in(&login, &format!("/home/{USER}/.claude/.credentials.json"))?;
                machine.fixture.arrange_as_root(&format!(
                    "cd /home/{USER}/.claude && chown {USER}:{USER} .credentials.json \
                     && chmod 400 .credentials.json \
                     && printf '{{\"model\":\"haiku\"}}' > settings.json \
                     && chown {USER}:{USER} settings.json"
                ))?;
                machine
                    .fixture
                    .run("ln -s /opt/claude/claude ~/.local/bin/claude")?;
            }
        }
        Ok(Some(machine))
    }

    fn write(&self, path: &str, body: &str) -> Result<()> {
        let local = std::env::temp_dir().join(format!(
            "ykc-{}-{}",
            std::process::id(),
            Path::new(path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
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

    fn journal(thread: &str, file: &str) -> String {
        format!("~/.yantra/keep/{WORKSPACE}/{thread}/{file}")
    }

    fn size(&self, thread: &str) -> Result<u64> {
        Ok(self
            .sh(&format!("wc -c < {}", Self::journal(thread, "out")))?
            .parse()?)
    }

    fn holds(&self, thread: &str, file: &str, needle: &str) -> Result<bool> {
        let count = self.sh(&format!(
            "grep -cF -- '{needle}' {} || true",
            Self::journal(thread, file)
        ))?;
        Ok(count.parse::<u32>().unwrap_or(0) > 0)
    }

    /// The agent in this thread's worktree: an ACP control run leaves its own
    /// agent running in another.
    fn agent_pid(&self, agent: Agent, thread: &str) -> Result<String> {
        self.sh(&format!(
            "for p in $(pgrep -f '{}'); do case $(readlink /proc/$p/cwd) in */{thread}) echo $p ;; esac; done",
            agent.process()
        ))
    }

    fn session_exists(&self, thread: &str) -> bool {
        self.sh(&format!(
            "tmux has-session -t '=yantra-keep-{WORKSPACE}-{thread}'"
        ))
        .is_ok()
    }

    /// The keeper's processes: the agent, `tail`, and the keeper's own sh.
    fn leftovers(&self, agent: Agent) -> Result<String> {
        self.sh(&format!(
            "pgrep -fl '{}|tail -[nc] |mkfif[o] feed' || true",
            agent.process()
        ))
    }

    async fn until(
        &self,
        within: Duration,
        what: &str,
        done: impl Fn(&Self) -> Result<bool>,
    ) -> Result<()> {
        let deadline = Instant::now() + within;
        loop {
            if done(self)? {
                return Ok(());
            }
            if Instant::now() > deadline {
                bail!("{what} did not happen within {within:?}");
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

/// The owner's login, or `None` and a skip that names why.
fn credentials() -> Result<Option<PathBuf>> {
    let path = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".claude/.credentials.json");
    let why = if std::env::var_os("CI").is_some() {
        "CI has no claude login"
    } else if !path.is_file() {
        "there is no ~/.claude/.credentials.json to log in with"
    } else {
        return Ok(Some(path));
    };
    if std::env::var_os("YANTRA_REQUIRE_CLAUDE").is_some() {
        bail!("YANTRA_REQUIRE_CLAUDE is set, but {why}");
    }
    eprintln!("SKIPPED: {why}, so the real claude cannot run. See docs/development.md#testing.");
    Ok(None)
}

/// A WebSocket client in the few lines the chat needs, so the test adds no
/// dependency: masked text frames out, unmasked frames in.
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

    async fn send(&mut self, frame: Value) -> Result<()> {
        self.write(0x1, frame.to_string().as_bytes()).await
    }

    /// The next JSON frame, or `None` once the daemon closed the socket.
    async fn next(&mut self, within: Duration) -> Result<Option<Value>> {
        tokio::time::timeout(within, async {
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

    /// Frames up to and including the first that `stop` holds of.
    async fn through(
        &mut self,
        within: Duration,
        stop: impl Fn(&Value) -> bool,
    ) -> Result<Vec<Value>> {
        let mut frames = Vec::new();
        loop {
            let Some(frame) = self.next(within).await? else {
                bail!("the socket closed before the frame awaited: {frames:#?}");
            };
            if frame["type"] == "error" {
                bail!("the daemon refused: {frame}");
            }
            let done = stop(&frame);
            frames.push(frame);
            if done {
                return Ok(frames);
            }
        }
    }
}

fn chat(thread: Option<&str>, after: Option<&str>) -> String {
    let mut path = format!("/api/workspaces/{WORKSPACE}/chat");
    if let Some(thread) = thread {
        path.push_str(&format!("?thread={thread}"));
        if let Some(after) = after {
            path.push_str(&format!("&after={}", after.replace(':', "%3A")));
        }
    }
    path
}

/// `run:end:part` as its run and the place in `out`.
fn cursor(frame: &Value) -> Option<(String, (u64, u32))> {
    let text = frame["cursor"].as_str()?;
    let mut parts = text.rsplitn(3, ':');
    let part = parts.next()?.parse().ok()?;
    let end = parts.next()?.parse().ok()?;
    Some((parts.next()?.to_owned(), (end, part)))
}

/// A cursored event by its place in `out`, without the thread or the run,
/// which differ between two threads that ran the same bytes.
fn placed(frames: &[Value]) -> Vec<((u64, u32), Value)> {
    frames
        .iter()
        .filter_map(|frame| {
            let (_, at) = cursor(frame)?;
            Some((
                at,
                json!({"type": frame["type"], "payload": frame["payload"]}),
            ))
        })
        .collect()
}

/// One turn with nobody leaving: the control run the joined events must equal.
async fn control(agent: Agent) -> Result<Vec<Value>> {
    let mut socket = Socket::open(&chat(None, None)).await?;
    socket
        .send(json!({"type": "turn", "text": agent.prompt(), "harness": agent.harness()}))
        .await?;
    let mut frames = socket
        .through(agent.patience(), |frame| frame["type"] == "request.opened")
        .await?;
    let request = frames[frames.len() - 1]["payload"]["requestId"].clone();
    socket
        .send(json!({"type": "answer", "requestId": request, "decision": "accept"}))
        .await?;
    frames.extend(
        socket
            .through(agent.patience(), |frame| {
                frame["type"] == "turn.diff.updated"
            })
            .await?,
    );
    Ok(frames)
}

/// ADR-0035's steps 1 to 7 for one agent.
async fn outlives(agent: Agent) -> Result<()> {
    let Some(machine) = Machine::start(agent)? else {
        return Ok(());
    };
    let host = Host::new(&machine.fixture)?;
    let a = host.daemon("a").await?;
    let control = match agent {
        Agent::RealClaude => None,
        Agent::StandIn | Agent::Acp => Some(control(agent).await?),
    };

    // 1. A turn, read up to its first cursored event, C.
    let mut first = Socket::open(&chat(None, None)).await?;
    first
        .send(json!({"type": "turn", "text": agent.prompt(), "harness": agent.harness()}))
        .await?;
    let drawn = first
        .through(agent.patience(), |frame| cursor(frame).is_some())
        .await?;
    let thread = drawn[0]["payload"]["thread"]
        .as_str()
        .context("the first frame names the thread")?
        .to_owned();
    let c = drawn[drawn.len() - 1]["cursor"]
        .as_str()
        .context("a cursor")?
        .to_owned();
    let (run, c_at) = cursor(&drawn[drawn.len() - 1]).context("a cursor")?;

    // 2. The ssh pipe dies; the agent does not, and `out` grows on.
    let pid = machine.agent_pid(agent, &thread)?;
    assert!(!pid.is_empty(), "the agent runs");
    let (asks, answers) = agent.request();
    let before = machine.size(&thread)?;
    host.cut_the_pipe(&a)?;
    if agent != Agent::RealClaude {
        machine
            .until(Duration::from_secs(10), "out growing", |machine| {
                Ok(machine.size(&thread)? > before)
            })
            .await?;
    }
    assert_eq!(
        machine.agent_pid(agent, &thread)?,
        pid,
        "the same agent runs"
    );

    // 3. The socket goes, and the daemon dies once the agent asks.
    drop(first);
    machine
        .until(agent.patience(), "the request reaching out", |machine| {
            machine.holds(&thread, "out", asks)
        })
        .await?;
    a.kill()?;

    // 4. Nobody answers, and the agent waits.
    tokio::time::sleep(Duration::from_secs(10)).await;
    assert_eq!(
        machine.agent_pid(agent, &thread)?,
        pid,
        "the agent still waits"
    );
    assert!(
        machine.session_exists(&thread),
        "the keeper's session stays"
    );
    assert!(
        !machine.holds(&thread, "in", answers)?,
        "in holds no answer"
    );

    // 5. Another daemon, and a socket after C.
    let files = host.files()?;
    let b = host.daemon("b").await?;
    let mut second = Socket::open(&chat(Some(&thread), Some(&c))).await?;
    let started = second
        .next(agent.patience())
        .await?
        .context("thread.started")?;
    assert_eq!(started["type"], "thread.started", "{started}");
    assert_eq!(started["cursor"], c.as_str(), "the replay continues from C");
    let mut caught = second
        .through(agent.patience(), |frame| frame["type"] == "request.opened")
        .await?;
    let request = caught[caught.len() - 1]["payload"]["requestId"].clone();
    second
        .send(json!({"type": "answer", "requestId": request, "decision": "accept"}))
        .await?;

    // 6. The turn ends where B is, and nothing is lost or doubled.
    caught.extend(
        second
            .through(agent.patience(), |frame| {
                frame["type"] == "turn.diff.updated"
            })
            .await?,
    );
    for frame in &caught {
        if let Some((frame_run, at)) = cursor(frame) {
            assert_eq!(frame_run, run, "one run: {frame}");
            assert!(at > c_at, "after C: {frame}");
        }
    }
    let opened = caught
        .iter()
        .filter(|frame| frame["type"] == "request.opened")
        .count();
    assert_eq!(opened, 1, "request.opened once: {caught:#?}");
    let completed = caught
        .iter()
        .find(|frame| frame["type"] == "turn.completed")
        .context("turn.completed")?;
    assert_eq!(completed["payload"]["state"], "completed", "{completed}");
    machine.sh(&format!(
        "test -f ~/.yantra/worktrees/chat/{WORKSPACE}/{thread}/made.txt"
    ))?;
    let mut joined = placed(&drawn);
    joined.extend(placed(&caught));
    let places: Vec<_> = joined.iter().map(|(at, _)| *at).collect();
    let unique: BTreeSet<_> = places.iter().collect();
    assert_eq!(unique.len(), places.len(), "no cursor twice: {places:?}");
    if let Some(control) = control {
        assert_eq!(
            joined,
            placed(&control),
            "the same events as a turn nobody left"
        );
    }

    // 7. The keeper goes with its Claude turn; an ACP agent stays for the
    // next turn (ADR-0035 decision 3) and stops only when idle.
    match agent {
        Agent::StandIn | Agent::RealClaude => {
            machine
                .until(
                    Duration::from_secs(10),
                    "the keeper's session going",
                    |machine| Ok(!machine.session_exists(&thread)),
                )
                .await?;
            machine
                .until(
                    Duration::from_secs(10),
                    "the keeper's processes going",
                    |machine| Ok(machine.leftovers(agent)?.is_empty()),
                )
                .await?;
        }
        Agent::Acp => assert_eq!(machine.agent_pid(agent, &thread)?, pid, "the agent stays"),
    }
    assert_eq!(host.files()?, files, "yantrad B wrote no file on the host");
    b.kill()?;
    Ok(())
}

#[tokio::test]
async fn a_claude_turn_outlives_its_pipe_its_socket_and_its_daemon() -> Result<()> {
    outlives(Agent::StandIn).await
}

#[tokio::test]
async fn an_acp_turn_outlives_its_pipe_its_socket_and_its_daemon() -> Result<()> {
    outlives(Agent::Acp).await
}

#[tokio::test]
async fn a_real_claude_turn_outlives_its_pipe_its_socket_and_its_daemon() -> Result<()> {
    outlives(Agent::RealClaude).await
}
