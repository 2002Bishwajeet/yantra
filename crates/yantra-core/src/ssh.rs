//! Running one command on one machine, over the system `ssh` binary (I-20).
//!
//! Three things here look like over-engineering and are not. Each fixes a
//! defect in `ssh(1)` that is unrecoverable at the `ssh` layer — see ADR-0006:
//!
//! - **The sentinel.** `ssh` reports a signal-killed remote command as exit 255
//!   with empty stderr, indistinguishable from a dropped connection. The remote
//!   side reports its own status instead; presence of the sentinel is the
//!   transport verdict, its value is the command verdict.
//! - **The base64 payload.** `ssh` joins its arguments and hands them to the
//!   remote *login shell*, so a repo path containing `$(...)` is remote code
//!   execution. A quote-free wire format removes the quoting problem entirely.
//! - **`-E`.** Diverts `ssh`'s own diagnostics off stderr so stderr belongs to
//!   the command.
//!
//! A stdin-EOF watchdog was tried and withdrawn — it killed every command that
//! took longer than a few hundred milliseconds. See ADR-0008.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::AsyncReadExt;

/// The longest `ControlPath` that works. The master binds the path plus a
/// 17-character temporary suffix, so this is below `sun_path` (108 on Linux).
#[cfg(target_os = "macos")]
const CONTROL_PATH_LIMIT: usize = 86;
#[cfg(not(target_os = "macos"))]
const CONTROL_PATH_LIMIT: usize = 90;

/// How long an idle multiplexed connection is kept alive, in seconds.
const CONTROL_PERSIST: &str = "300";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Machine {
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity: Option<PathBuf>,
    /// Directory holding multiplexing sockets and the known-hosts file.
    pub state_dir: PathBuf,
}

/// A machine reached by ssh destination alone, letting `~/.ssh/config` supply
/// user, port and identity (ADR-0009). `None` if no state directory exists.
///
/// Control sockets are runtime state, and the runtime directory is also the
/// shortest — which matters against I-28's 90-byte path budget.
pub fn machine_at(host: &str) -> Option<Machine> {
    use etcetera::BaseStrategy as _;
    let base = etcetera::choose_base_strategy().ok()?;
    Some(Machine {
        host: host.to_owned(),
        user: None,
        port: None,
        identity: None,
        state_dir: base
            .runtime_dir()
            .unwrap_or_else(|| base.data_dir())
            .join("yantra"),
    })
}

impl Machine {
    fn destination(&self) -> String {
        match &self.user {
            Some(user) => format!("{user}@{}", self.host),
            None => self.host.clone(),
        }
    }

    fn control_path(&self) -> PathBuf {
        self.state_dir.join("cm").join("%C")
    }

    fn known_hosts(&self) -> PathBuf {
        self.state_dir.join("known_hosts")
    }
}

/// What the remote command did. Only produced when the sentinel came back, so
/// `status` is always the command's own — never `ssh`'s.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    /// The remote exit status, or `128 + signal` if it was killed.
    pub status: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl Output {
    pub fn success(&self) -> bool {
        self.status == 0
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `%C` expands to 40 characters, so the parent directory must be short.
    #[error("control socket path would be {len} bytes, over the {limit}-byte limit: {}", path.display())]
    ControlPathTooLong {
        path: PathBuf,
        len: usize,
        limit: usize,
    },

    #[error("could not prepare the ssh state directory {}", path.display())]
    StateDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("could not spawn `ssh` — is OpenSSH installed and on PATH?")]
    Spawn(#[source] std::io::Error),

    /// The sentinel never came back, so the command's fate is unknown. This is
    /// deliberately distinct from a command that ran and failed.
    #[error("ssh to {host} failed before the command reported a status: {diagnosis}")]
    Transport { host: String, diagnosis: String },
}

/// The seam the layers above are tested against (§B2). Implementations of this
/// trait are the only thing that may talk to a real machine.
pub trait Exec {
    fn exec(
        &self,
        command: &str,
    ) -> impl std::future::Future<Output = Result<Output, Error>> + Send;
}

#[derive(Debug, Clone)]
pub struct Ssh {
    machine: Machine,
}

impl Ssh {
    /// Fails fast on a control path that is too long, turning what would
    /// otherwise be an opaque 255 at first use into a configuration error.
    pub fn new(machine: Machine) -> Result<Self, Error> {
        let path = machine.control_path();
        let len = path.as_os_str().len();
        if len > CONTROL_PATH_LIMIT {
            return Err(Error::ControlPathTooLong {
                path,
                len,
                limit: CONTROL_PATH_LIMIT,
            });
        }
        Ok(Self { machine })
    }
}

impl Exec for Ssh {
    async fn exec(&self, command: &str) -> Result<Output, Error> {
        let m = &self.machine;

        let sockets = m.state_dir.join("cm");
        std::fs::create_dir_all(&sockets).map_err(|source| Error::StateDir {
            path: sockets.clone(),
            source,
        })?;

        let log = LogFile::new(&m.state_dir)?;
        let nonce = nonce()?;

        let mut cmd = tokio::process::Command::new("ssh");
        cmd.arg("-E").arg(log.path());
        for opt in [
            "BatchMode=yes",
            "StrictHostKeyChecking=accept-new",
            "LogLevel=ERROR",
            // A ~/.ssh/config that forces a pty would corrupt stdout with CRLF
            // and merge stderr into it.
            "RequestTTY=no",
            "ConnectTimeout=10",
            // The only defence against a host that freezes without closing TCP.
            "ServerAliveInterval=15",
            "ServerAliveCountMax=3",
            "ControlMaster=auto",
        ] {
            cmd.arg("-o").arg(opt);
        }
        cmd.arg("-o")
            .arg(format!("ControlPersist={CONTROL_PERSIST}"));
        cmd.arg("-o")
            .arg(format!("ControlPath={}", m.control_path().display()));
        cmd.arg("-o")
            .arg(format!("UserKnownHostsFile={}", m.known_hosts().display()));
        if let Some(port) = m.port {
            cmd.arg("-p").arg(port.to_string());
        }
        if let Some(identity) = &m.identity {
            cmd.arg("-i").arg(identity);
            cmd.arg("-o").arg("IdentitiesOnly=yes");
        }
        cmd.arg(m.destination());
        cmd.arg(payload(command, &nonce));

        // ADR-0008: no stdin is forwarded. The watchdog that needed a held-open
        // pipe is withdrawn, and a remote command reading stdin would hang.
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(Error::Spawn)?;
        let mut out = child.stdout.take();
        let mut err = child.stderr.take();

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let (read_out, read_err) = tokio::join!(
            async {
                match &mut out {
                    Some(pipe) => pipe.read_to_end(&mut stdout).await.map(|_| ()),
                    None => Ok(()),
                }
            },
            async {
                match &mut err {
                    Some(pipe) => pipe.read_to_end(&mut stderr).await.map(|_| ()),
                    None => Ok(()),
                }
            }
        );
        let status = child.wait().await;

        let transport = |diagnosis: String| Error::Transport {
            host: m.host.clone(),
            diagnosis,
        };
        read_out.map_err(|e| transport(format!("reading stdout: {e}")))?;
        read_err.map_err(|e| transport(format!("reading stderr: {e}")))?;
        status.map_err(|e| transport(format!("waiting for ssh: {e}")))?;

        match split_sentinel(&stderr, &nonce) {
            Some((stderr, status)) => Ok(Output {
                status,
                stdout,
                stderr,
            }),
            None => Err(transport(log.read_or_default())),
        }
    }
}

/// Wraps `command` so the remote side reports its own exit status. Encoded
/// rather than quoted: `ssh` hands whatever it is given to the remote *login
/// shell*, which may not even be POSIX.
///
/// The command runs in a *child* shell — `exit 3` in the wrapper's own shell
/// would terminate it before the sentinel is printed.
fn payload(command: &str, nonce: &str) -> String {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;

    let script = format!(
        "CMD=$(echo {inner} | base64 -d)\n\
         /bin/sh -c \"$CMD\"\n\
         r=$?\n\
         printf '\\n{nonce}:%d' \"$r\" >&2\n",
        inner = b64.encode(command),
    );

    format!("echo {} | base64 -d | /bin/sh", b64.encode(script))
}

/// Splits the trailer off stderr. Returns the caller's stderr and the remote
/// status, or `None` when the sentinel is absent — which means transport
/// failure, not a failed command.
fn split_sentinel(stderr: &[u8], nonce: &str) -> Option<(Vec<u8>, i32)> {
    let marker = format!("\n{nonce}:");
    let at = stderr
        .windows(marker.len())
        .rposition(|w| w == marker.as_bytes())?;

    let value = std::str::from_utf8(&stderr[at + marker.len()..]).ok()?;
    let status = value.trim_end().parse().ok()?;
    Some((stderr[..at].to_vec(), status))
}

fn nonce() -> Result<String, Error> {
    let mut bytes = [0u8; 8];
    // getrandom only fails if the OS entropy source is unavailable, which on a
    // machine that just booted a daemon means something is deeply wrong.
    getrandom::fill(&mut bytes).map_err(|e| Error::Spawn(std::io::Error::other(e)))?;
    Ok(format!("Y{}", hex(&bytes)))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Holds `ssh`'s own diagnostics away from the command's stderr, and removes the
/// file afterwards. `-E` appends, so each exec needs its own.
#[derive(Debug)]
struct LogFile {
    path: PathBuf,
}

impl LogFile {
    fn new(state_dir: &Path) -> Result<Self, Error> {
        let logs = state_dir.join("log");
        std::fs::create_dir_all(&logs).map_err(|source| Error::StateDir {
            path: logs.clone(),
            source,
        })?;
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).map_err(|source| Error::StateDir {
            path: logs.clone(),
            source: std::io::Error::other(source),
        })?;
        Ok(Self {
            path: logs.join(format!("ssh-{}.log", hex(&bytes))),
        })
    }

    fn path(&self) -> &Path {
        &self.path
    }

    /// Empty is a real answer: a silently dropped multiplexed connection and a
    /// ServerAlive timeout both produce no diagnostics at all.
    fn read_or_default(&self) -> String {
        match std::fs::read_to_string(&self.path) {
            Ok(text) if !text.trim().is_empty() => text.trim().to_owned(),
            _ => "no diagnostics; the connection dropped silently".to_owned(),
        }
    }
}

impl Drop for LogFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn sentinel_is_split_off_stderr() {
        let stderr = b"warning: something\nYdeadbeef:7";
        let (rest, status) = split_sentinel(stderr, "Ydeadbeef").expect("sentinel is present");
        assert_eq!(rest, b"warning: something");
        assert_eq!(status, 7);
    }

    #[test]
    fn a_missing_sentinel_is_not_a_status() {
        assert!(split_sentinel(b"connection died", "Ydeadbeef").is_none());
    }

    /// Remote output that looks like a sentinel must not be believed, which is
    /// why the nonce is random per exec rather than a fixed string.
    #[test]
    fn a_forged_sentinel_with_the_wrong_nonce_is_ignored() {
        assert!(split_sentinel(b"\nYcafecafe:0", "Ydeadbeef").is_none());
    }

    /// The real trailer is the last one, so a command echoing the nonce cannot
    /// shadow it.
    #[test]
    fn the_last_sentinel_wins() {
        let stderr = b"\nYdeadbeef:1\nYdeadbeef:0";
        let (_, status) = split_sentinel(stderr, "Ydeadbeef").expect("sentinel is present");
        assert_eq!(status, 0);
    }

    #[test]
    fn an_overlong_control_path_is_refused_before_use() {
        let machine = Machine {
            host: "example".to_owned(),
            user: None,
            port: None,
            identity: None,
            state_dir: PathBuf::from("/".to_owned() + &"x".repeat(100)),
        };
        assert!(matches!(
            Ssh::new(machine),
            Err(Error::ControlPathTooLong { .. })
        ));
    }

    #[test]
    fn the_command_is_never_interpolated_unquoted() {
        let hostile = "echo $(id -un) `whoami` \"quoted\"";
        let wire = payload(hostile, "Ynonce");
        assert!(
            !wire.contains("id -un"),
            "the command must reach the wire encoded, not inline: {wire}"
        );
    }
}
