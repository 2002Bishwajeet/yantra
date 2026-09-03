//! [`attach`]'s command, run under a pseudo-terminal.
//!
//! The third ssh call shape. [`Exec`](crate::ssh::Exec) is one shot with no
//! stdin and `RequestTTY=no`, and `yantra attach` hands the whole process over
//! with `execve`; a browser terminal is neither — it wants bytes in both
//! directions, a window that changes size, and an end that leaves nothing
//! running.
//!
//! **It never derives the command.** [`attach::plan`] resolves the machine, the
//! tmux path for that host (I-34), the session spelled so a login `zsh` cannot
//! glob it (I-35) and a `TERM` the far side has (I-36, I-43); this runs what
//! [`attach::remote_command`] renders from those, over the same multiplexed
//! socket as every other ssh Yantra opens (I-20, I-28).
//!
//! **Reconnecting is opening another one.** tmux draws the pane's current
//! contents for every client that attaches — measured, alternate screen
//! included — so replay is the far side's and no buffer belongs here (Y-132).
//!
//! A pty rather than `ssh -tt` with pipes because of the window, not the
//! keystrokes: Y-127 measured both interrupting, and only the pty carries a size
//! the caller chose — pipes report openssh's `80x24` and have nothing to resize.
//! The command also goes to the remote login shell directly rather than through
//! ADR-0006's base64 envelope, whose `/bin/sh` reads from a pipe, which is the
//! one thing tmux refuses to attach from.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::mpsc;

use crate::attach::{self, Plan};
use crate::ssh::{self, Ssh};

/// Chunks that may wait for a caller before the far side is made to wait. A
/// terminal nobody is draining slows down; it does not grow (Q5 — the stream is
/// never stored, and a buffer is storage).
const BACKLOG: usize = 64;
const CHUNK: usize = 8 * 1024;

/// A terminal window, in cells. Pixels are what the pty layer wants and no
/// caller of this has any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Attach(#[from] attach::Error),

    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    #[error("could not open a pseudo-terminal: {0}")]
    Open(String),

    #[error("could not start `ssh` under a pseudo-terminal: {0}")]
    Spawn(String),

    #[error("could not resize the terminal to {cols}x{rows}: {reason}")]
    Resize {
        rows: u16,
        cols: u16,
        reason: String,
    },

    #[error("could not send to the terminal")]
    Send(#[source] std::io::Error),

    /// The writer is only unreachable if the task holding it panicked, so this
    /// says the terminal is unusable rather than that one write failed.
    #[error("the terminal is no longer writable")]
    Unusable,
}

/// A live attachment to a session.
///
/// Dropping it ends the local `ssh` and waits for it, which detaches the far
/// side. The session itself outlives this — ending one is `down`'s.
pub struct Terminal {
    output: mpsc::Receiver<Vec<u8>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl std::fmt::Debug for Terminal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Terminal")
            .field("size", &self.master.get_size().ok())
            .finish()
    }
}

/// Attaches to `name`'s session for a caller sitting at `term`, in a window of
/// `size`. Fails rather than creating anything when there is no session.
pub async fn open(name: &str, term: &str, size: Size) -> Result<Terminal, Error> {
    started(attach::plan(name, term).await?, size)
}

/// The same for a session no workspace need name (ADR-0022).
pub async fn open_session(
    machine: &str,
    session: &str,
    term: &str,
    size: Size,
) -> Result<Terminal, Error> {
    started(attach::plan_on(machine, session, term).await?, size)
}

fn started(plan: Plan, size: Size) -> Result<Terminal, Error> {
    let machine = ssh::machine_at(&plan.machine).ok_or(attach::Error::NoStateDir)?;
    on(&Ssh::new(machine)?, &plan, size)
}

/// The testable half — everything after the plan is resolved.
pub fn on(ssh: &Ssh, plan: &Plan, size: Size) -> Result<Terminal, Error> {
    let remote = attach::remote_command(plan.tmux.path(), &plan.session, plan.term.term());
    let argv = ssh.tty_argv(&remote)?;

    let pair = native_pty_system()
        .openpty(window(size))
        .map_err(|e| Error::Open(format!("{e:#}")))?;

    let mut command = CommandBuilder::new("ssh");
    command.args(argv);
    // `CommandBuilder` clears the environment and resolves the program through
    // its own `PATH` rather than the caller's (Y-127).
    command.env("PATH", std::env::var("PATH").unwrap_or_default());
    command.env("TERM", plan.term.term());

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| Error::Spawn(format!("{e:#}")))?;
    // Holding this end open would keep the master from ever reading EOF.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| Error::Open(format!("{e:#}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| Error::Open(format!("{e:#}")))?;

    let (chunks, output) = mpsc::channel(BACKLOG);
    // A thread of its own rather than `spawn_blocking`: this read blocks for as
    // long as someone is looking at the terminal, and tokio's blocking pool is
    // shared with everything else the daemon does (I-13).
    std::thread::spawn(move || pump(reader, &chunks));

    Ok(Terminal {
        output,
        writer: Arc::new(Mutex::new(writer)),
        master: pair.master,
        child,
    })
}

impl Terminal {
    /// The next bytes the far side printed, or `None` once the connection ended.
    pub async fn read(&mut self) -> Option<Vec<u8>> {
        self.output.recv().await
    }

    /// Sends `bytes` as though they were typed.
    ///
    /// `&mut` where `&` would compile: the pty master is not `Sync`, so a future
    /// holding `&Terminal` across an await is not `Send` — and the task on the
    /// other end of Y-129's socket is.
    pub async fn write(&mut self, bytes: Vec<u8>) -> Result<(), Error> {
        let writer = Arc::clone(&self.writer);
        // Blocking, and it really can block: `ssh` stops reading its stdin when
        // the connection stalls, and a pty's buffer is a few kilobytes (I-13).
        tokio::task::spawn_blocking(move || match writer.lock() {
            Ok(mut writer) => writer
                .write_all(&bytes)
                .and_then(|()| writer.flush())
                .map_err(Error::Send),
            Err(_) => Err(Error::Unusable),
        })
        .await
        .map_err(|_| Error::Unusable)?
    }

    /// Tells the far side the window changed, which is `TIOCSWINSZ` here and a
    /// `SIGWINCH` to `ssh` (I-18).
    pub fn resize(&self, size: Size) -> Result<(), Error> {
        self.master.resize(window(size)).map_err(|e| Error::Resize {
            rows: size.rows,
            cols: size.cols,
            reason: format!("{e:#}"),
        })
    }
}

impl Drop for Terminal {
    /// Waits, so a caller that has dropped this knows nothing local is left
    /// running — the half of I-27 a pty can actually settle.
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn window(size: Size) -> PtySize {
    PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Reads until the pty hangs up or the caller stops listening. Never returns an
/// error: a read that fails and a closed receiver are both "the terminal ended",
/// and there is nobody left to tell.
fn pump(mut reader: Box<dyn Read + Send>, chunks: &mpsc::Sender<Vec<u8>>) {
    let mut buf = [0u8; CHUNK];
    while let Ok(read) = reader.read(&mut buf) {
        if read == 0 || chunks.blocking_send(buf[..read].to_vec()).is_err() {
            return;
        }
    }
}
