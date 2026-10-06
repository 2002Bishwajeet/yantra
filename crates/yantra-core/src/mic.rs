//! The writer behind the dashboard's push-to-talk ([ADR-0031] §5): `pw-cat`
//! on the machine, fed 16 kHz mono s16le PCM on its stdin, playing into
//! `yantra-mic-sink`.
//!
//! `ssh.rs`'s fourth call shape, [`Ssh::stdio`]: no pty, because a pty changes
//! bytes, and the command still base64 over the same multiplexed socket (I-20,
//! I-26). **It keeps no buffer beyond the pipe and never logs or formats a
//! payload** (Q5).
//!
//! [ADR-0031]: ../../../docs/adr/0031-the-microphone-reaches-a-machine-as-a-virtual-source.md

use std::time::Duration;

use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::task::JoinHandle;

use crate::acp;
use crate::ssh::{self, Ssh};

/// ADR-0031 §5, verbatim. The variable is set here because a non-login ssh
/// command has no `XDG_RUNTIME_DIR`, and `pw-cat` finds PipeWire through it.
pub const WRITER: &str = "XDG_RUNTIME_DIR=/run/user/$(id -u) pw-cat --playback --raw --target yantra-mic-sink --format s16 --rate 16000 --channels 1 -";

/// How long a closed stdin waits for `pw-cat` to drain and exit.
const CLOSE_WITHIN: Duration = Duration::from_secs(5);
/// How long an exited `ssh` waits for stderr's last words.
const STDERR_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,

    #[error("the microphone on the machine stopped taking audio")]
    Write(#[source] std::io::Error),

    #[error("could not wait for the microphone's writer to end")]
    Wait(#[source] std::io::Error),

    /// `stderr` is the end of what `pw-cat` and `ssh` said: a missing
    /// `yantra-mic-sink` and a refused connection both show there.
    #[error("the microphone's writer exited {}{}", status.map_or_else(|| "on a signal".to_owned(), |code| format!("with status {code}")), said(.stderr))]
    Exited { status: Option<i32>, stderr: String },

    /// It exited with status 0 while the button was held.
    #[error("the microphone's writer ended on its own")]
    Ended,

    #[error("the microphone's writer did not end within {} seconds of its input closing", CLOSE_WITHIN.as_secs())]
    Hung,
}

fn said(stderr: &str) -> String {
    if stderr.is_empty() {
        String::new()
    } else {
        format!(": {stderr}")
    }
}

/// One press of the button: a running `pw-cat` and its stdin. Dropping it
/// kills the local `ssh`, which ends `pw-cat` on the far side.
pub struct Stream {
    writer: Box<dyn AsyncWrite + Send + Unpin>,
    child: Option<tokio::process::Child>,
    diagnosis: Option<JoinHandle<String>>,
}

impl std::fmt::Debug for Stream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Stream")
            .field(
                "pid",
                &self.child.as_ref().and_then(tokio::process::Child::id),
            )
            .finish_non_exhaustive()
    }
}

/// Starts [`WRITER`] on the machine `ssh` reaches.
pub fn open(ssh: &Ssh) -> Result<Stream, Error> {
    let ssh::Piped {
        child,
        stdin,
        stdout: _,
        stderr,
        log,
    } = ssh.stdio(WRITER)?;
    let diagnosis = tokio::spawn(async move {
        let tail = acp::tail(stderr).await;
        [String::from_utf8_lossy(&tail).trim(), log.read().trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    });
    Ok(Stream {
        writer: Box::new(stdin),
        child: Some(child),
        diagnosis: Some(diagnosis),
    })
}

/// The same for a machine named the way `~/.ssh/config` names it (ADR-0009).
pub fn open_at(machine: &str) -> Result<Stream, Error> {
    let machine = ssh::machine_at(machine).ok_or(Error::NoStateDir)?;
    open(&Ssh::new(machine)?)
}

impl Stream {
    /// A stream into any writer, with no process behind it.
    pub fn over<W: AsyncWrite + Send + Unpin + 'static>(writer: W) -> Self {
        Self {
            writer: Box::new(writer),
            child: None,
            diagnosis: None,
        }
    }

    pub async fn write(&mut self, bytes: &[u8]) -> Result<(), Error> {
        self.writer.write_all(bytes).await.map_err(Error::Write)?;
        self.writer.flush().await.map_err(Error::Write)
    }

    /// Resolves when the writer's process exits on its own, and never for a
    /// stream with no process.
    pub async fn stopped(&mut self) {
        match self.child.as_mut() {
            Some(child) => {
                let _ = child.wait().await;
            }
            None => std::future::pending().await,
        }
    }

    /// Closes stdin, which ends `pw-cat` (ADR-0031 §6), and waits for it.
    pub async fn close(mut self) -> Result<(), Error> {
        let _ = self.writer.shutdown().await;
        drop(self.writer);
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        let status = match tokio::time::timeout(CLOSE_WITHIN, child.wait()).await {
            Ok(status) => status.map_err(Error::Wait)?,
            Err(_) => {
                let _ = child.kill().await;
                return Err(Error::Hung);
            }
        };
        if status.success() {
            return Ok(());
        }
        let stderr = match self.diagnosis.take() {
            Some(task) => tokio::time::timeout(STDERR_GRACE, task)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default(),
            None => String::new(),
        };
        Err(Error::Exited {
            status: status.code(),
            stderr,
        })
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn bytes_arrive_unchanged_and_in_order_and_close_gives_eof() {
        let (writer, mut reader) = tokio::io::duplex(64 * 1024);
        let mut stream = Stream::over(writer);
        let sent: Vec<Vec<u8>> = (0u8..10).map(|n| vec![n; 640]).collect();
        for chunk in &sent {
            stream.write(chunk).await.expect("the pipe takes it");
        }
        stream.close().await.expect("nothing to wait for");

        let mut heard = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), reader.read_to_end(&mut heard))
            .await
            .expect("close gave the reader EOF")
            .expect("a read");
        assert_eq!(heard, sent.concat());
    }

    #[tokio::test]
    async fn a_reader_that_went_away_is_a_write_error() {
        let (writer, reader) = tokio::io::duplex(16);
        drop(reader);
        let mut stream = Stream::over(writer);
        let error = stream.write(&[0; 640]).await.expect_err("nobody reads");
        assert!(matches!(error, Error::Write(_)), "{error}");
    }

    #[test]
    fn the_writer_is_adr_0031s_command() {
        assert!(WRITER.starts_with("XDG_RUNTIME_DIR=/run/user/$(id -u) pw-cat --playback --raw"));
        assert!(WRITER.contains("--target yantra-mic-sink"));
        assert!(WRITER.ends_with("--format s16 --rate 16000 --channels 1 -"));
    }

    #[test]
    fn an_exit_says_the_status_and_what_was_said() {
        let error = Error::Exited {
            status: Some(1),
            stderr: "target not found".to_owned(),
        };
        assert_eq!(
            error.to_string(),
            "the microphone's writer exited with status 1: target not found"
        );
        let error = Error::Exited {
            status: None,
            stderr: String::new(),
        };
        assert_eq!(
            error.to_string(),
            "the microphone's writer exited on a signal"
        );
    }
}
