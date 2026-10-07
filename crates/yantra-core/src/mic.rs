//! The writer behind the dashboard's push-to-talk ([ADR-0031] §5): `pw-cat`
//! on the machine, fed 16 kHz mono s16le PCM on its stdin, playing into
//! `yantra-mic-sink`.
//!
//! `ssh.rs`'s fourth call shape, [`Ssh::stdio`]: no pty, because a pty changes
//! bytes, and the command still base64 over the same multiplexed socket (I-20,
//! I-26). **It keeps no buffer beyond the pipe and never logs or formats a
//! payload** (Q5).
//!
//! `yantra mic` (§7, recipe B) adds the laptop half: [`record`] runs
//! [`RECORDER`] here, and [`relay`] copies what it hears into a [`Stream`].
//!
//! [ADR-0031]: ../../../docs/adr/0031-the-microphone-reaches-a-machine-as-a-virtual-source.md

use std::future::Future;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::{Child, ChildStdout};
use tokio::task::JoinHandle;

use crate::acp;
use crate::ssh::{self, Ssh};

/// ADR-0031 §5, verbatim. The variable is set here because a non-login ssh
/// command has no `XDG_RUNTIME_DIR`, and `pw-cat` finds PipeWire through it.
pub const WRITER: &str = "XDG_RUNTIME_DIR=/run/user/$(id -u) pw-cat --playback --raw --target yantra-mic-sink --format s16 --rate 16000 --channels 1 -";

/// ADR-0031 §7's laptop half: the default source, in the format `WRITER` takes.
pub const RECORDER: &[&str] = &[
    "pw-record",
    "--raw",
    "--format",
    "s16",
    "--rate",
    "16000",
    "--channels",
    "1",
    "-",
];

/// 20 ms of 16 kHz mono s16le, the size the dashboard sends.
const CHUNK: usize = 640;

/// How long a closed stdin waits for `pw-cat` to drain and exit.
const CLOSE_WITHIN: Duration = Duration::from_secs(5);
/// How long an exited `ssh` waits for stderr's last words.
const STDERR_GRACE: Duration = Duration::from_secs(5);
/// How long one chunk may wait for a pipe that `ssh` no longer drains.
const WRITE_WITHIN: Duration = Duration::from_secs(5);

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

    #[error("the microphone on the machine took no audio for {} seconds", WRITE_WITHIN.as_secs())]
    Stalled,

    #[error("the microphone's writer did not end within {} seconds of its input closing", CLOSE_WITHIN.as_secs())]
    Hung,

    #[error("this laptop has no `pw-record`; it needs the PipeWire tools to read its microphone")]
    NoRecorder,

    #[error("could not read this laptop's microphone")]
    Record(#[source] std::io::Error),
}

/// Why [`relay`] stopped copying without an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// The recorder closed its output.
    Recorder,
    /// The caller's `stop` resolved.
    Stopped,
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
    Ok(piped(ssh.stdio_detached(WRITER)?))
}

fn piped(
    ssh::Piped {
        child,
        stdin,
        mut stdout,
        stderr,
        log,
    }: ssh::Piped,
) -> Stream {
    // A closed stdout would end `ssh` at the first line the far side prints.
    tokio::spawn(async move { tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await });
    let diagnosis = tokio::spawn(async move {
        let tail = acp::tail(stderr).await;
        [String::from_utf8_lossy(&tail).trim(), log.read().trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    });
    Stream {
        writer: Box::new(stdin),
        child: Some(child),
        diagnosis: Some(diagnosis),
    }
}

/// The same for a machine named the way `~/.ssh/config` names it (ADR-0009).
pub fn open_at(machine: &str) -> Result<Stream, Error> {
    let machine = ssh::machine_at(machine).ok_or(Error::NoStateDir)?;
    open(&Ssh::new(machine)?)
}

/// A running [`RECORDER`], and the end of what it said on stderr.
#[derive(Debug)]
pub struct Recorder {
    child: Child,
    said: JoinHandle<Vec<u8>>,
}

impl Recorder {
    /// Stops the recorder and returns the end of its stderr.
    pub async fn end(mut self) -> String {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
        let said = tokio::time::timeout(STDERR_GRACE, self.said)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        String::from_utf8_lossy(&said).trim().to_owned()
    }
}

/// Starts [`RECORDER`] on this laptop. Its stdout is the audio.
pub fn record() -> Result<(Recorder, ChildStdout), Error> {
    spawn(RECORDER[0], &RECORDER[1..])
}

fn spawn(program: &str, args: &[&str]) -> Result<(Recorder, ChildStdout), Error> {
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        // A terminal's Ctrl-C is for `yantra`, which then ends this itself.
        .process_group(0)
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => Error::NoRecorder,
            _ => Error::Record(error),
        })?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err(Error::Record(std::io::Error::other(
            "the recorder started without the pipes it was given",
        )));
    };
    // An undrained stderr blocks the recorder once the pipe fills.
    let said = tokio::spawn(acp::tail(stderr));
    Ok((Recorder { child, said }, stdout))
}

/// Copies `recorder` into `stream` one chunk at a time until the recorder
/// ends, `stop` resolves, or the writer exits ([`Error::Ended`]). It holds no
/// more than one chunk and never looks inside it (Q5).
pub async fn relay(
    mut recorder: impl AsyncRead + Unpin,
    stream: &mut Stream,
    stop: impl Future,
) -> Result<Ended, Error> {
    let mut chunk = [0u8; CHUNK];
    tokio::pin!(stop);
    loop {
        let read = tokio::select! {
            read = recorder.read(&mut chunk) => read.map_err(Error::Record)?,
            _ = &mut stop => return Ok(Ended::Stopped),
            () = stream.stopped() => return Err(Error::Ended),
        };
        if read == 0 {
            return Ok(Ended::Recorder);
        }
        // `stop` still counts while a stalled connection holds the write.
        tokio::select! {
            written = stream.write(&chunk[..read]) => written?,
            _ = &mut stop => return Ok(Ended::Stopped),
        }
    }
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
        let written = async {
            self.writer.write_all(bytes).await?;
            self.writer.flush().await
        };
        match tokio::time::timeout(WRITE_WITHIN, written).await {
            Ok(written) => written.map_err(Error::Write),
            Err(_) => Err(Error::Stalled),
        }
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
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::ReadBuf;

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

    #[tokio::test(start_paused = true)]
    async fn a_pipe_nobody_drains_is_a_stall_not_a_hang() {
        let (writer, _reader) = tokio::io::duplex(16);
        let mut stream = Stream::over(writer);
        let error = stream.write(&[0; 640]).await.expect_err("nobody reads");
        assert!(matches!(error, Error::Stalled), "{error}");
    }

    /// The far side may print before it reads: a dropped stdout would end
    /// `ssh` on that line, and every write after it would fail.
    #[tokio::test]
    async fn a_writer_that_prints_still_takes_audio() {
        let dir = std::env::temp_dir().join(format!("yantra-mic-stdout-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a dir");
        let heard = dir.join("heard");
        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "sleep 0.2; echo the far side said hello; cat > '{}'",
                heard.display()
            ))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("sh starts");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");
        let log = ssh::LogFile::new(&dir).expect("a log");
        let mut stream = piped(ssh::Piped {
            child,
            stdin,
            stdout,
            stderr,
            log,
        });

        tokio::time::sleep(Duration::from_millis(400)).await;
        stream.write(&[5; CHUNK]).await.expect("the pipe takes it");
        stream
            .close()
            .await
            .expect("pw-cat's stand-in ended cleanly");
        assert_eq!(std::fs::read(&heard).expect("it heard"), [5; CHUNK]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A recorder that talks a lot on stderr fills the pipe at 64 KiB, and an
    /// undrained pipe would block it before its audio arrived.
    #[tokio::test]
    async fn a_recorder_that_fills_stderr_still_delivers_its_audio() {
        let (recorder, audio) = spawn(
            "sh",
            &[
                "-c",
                "yes 'pw-record says' | head -c 200000 >&2; printf abc",
            ],
        )
        .expect("sh starts");
        let (writer, mut heard) = tokio::io::duplex(64 * 1024);
        let mut stream = Stream::over(writer);
        let ended = tokio::time::timeout(
            Duration::from_secs(10),
            relay(audio, &mut stream, std::future::pending::<()>()),
        )
        .await
        .expect("the recorder was not blocked on stderr")
        .expect("nothing failed");
        assert_eq!(ended, Ended::Recorder);
        stream.close().await.expect("nothing to wait for");
        let mut got = Vec::new();
        heard.read_to_end(&mut got).await.expect("a read");
        assert_eq!(got, b"abc");
        let said = recorder.end().await;
        assert!(said.contains("pw-record says"), "{said}");
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

    #[test]
    fn the_recorder_is_adr_0031s_command() {
        assert_eq!(
            RECORDER.join(" "),
            "pw-record --raw --format s16 --rate 16000 --channels 1 -"
        );
    }

    #[tokio::test]
    async fn the_recorders_bytes_arrive_unchanged_until_it_ends() {
        let (mut mic_in, recorder) = tokio::io::duplex(64 * 1024);
        let (writer, mut heard) = tokio::io::duplex(64 * 1024);
        let mut stream = Stream::over(writer);
        let said: Vec<u8> = (0..5000u32).map(|n| (n % 251) as u8).collect();
        mic_in.write_all(&said).await.expect("the pipe takes it");
        drop(mic_in);

        let ended = relay(recorder, &mut stream, std::future::pending::<()>())
            .await
            .expect("nothing failed");
        assert_eq!(ended, Ended::Recorder);
        stream.close().await.expect("nothing to wait for");

        let mut got = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), heard.read_to_end(&mut got))
            .await
            .expect("close gave the reader EOF")
            .expect("a read");
        assert_eq!(got, said);
    }

    #[tokio::test]
    async fn stop_ends_the_copy_and_close_gives_the_reader_eof() {
        let (mut mic_in, recorder) = tokio::io::duplex(64 * 1024);
        let (writer, mut heard) = tokio::io::duplex(64 * 1024);
        let mut stream = Stream::over(writer);
        let (fire, stop) = tokio::sync::oneshot::channel::<()>();

        let speaking = async {
            mic_in
                .write_all(&[7; CHUNK])
                .await
                .expect("the pipe takes it");
            let mut got = [0u8; CHUNK];
            heard.read_exact(&mut got).await.expect("it arrives");
            let _ = fire.send(());
            got
        };
        let (ended, got) = tokio::join!(relay(recorder, &mut stream, stop), speaking);
        assert_eq!(ended.expect("nothing failed"), Ended::Stopped);
        assert_eq!(got, [7; CHUNK]);

        // The recorder is still open, so only `stop` can have ended it.
        stream.close().await.expect("nothing to wait for");
        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), heard.read_to_end(&mut rest))
            .await
            .expect("close gave the reader EOF")
            .expect("a read");
        assert!(rest.is_empty());
        drop(mic_in);
    }

    struct Unplugged;

    impl AsyncRead for Unplugged {
        fn poll_read(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Poll::Ready(Err(std::io::Error::other("unplugged")))
        }
    }

    #[tokio::test]
    async fn a_recorder_that_cannot_be_read_is_a_record_error() {
        let (writer, _heard) = tokio::io::duplex(64);
        let mut stream = Stream::over(writer);
        let error = relay(Unplugged, &mut stream, std::future::pending::<()>())
            .await
            .expect_err("the read failed");
        assert!(matches!(error, Error::Record(_)), "{error}");
    }

    #[tokio::test]
    async fn a_laptop_without_the_recorder_is_told_what_it_needs() {
        let error = spawn("yantra-test-no-such-recorder", &[]).expect_err("not on PATH");
        assert!(matches!(error, Error::NoRecorder), "{error}");
        let said = error.to_string();
        assert!(said.contains("`pw-record`"), "{said}");
        assert!(said.contains("PipeWire"), "{said}");
    }
}
