//! The keeper that holds a Chat turn on its machine (Y-447,
//! [ADR-0035](../../../docs/adr/0035-a-chat-turn-outlives-its-ssh-pipe.md)).
//!
//! A POSIX `sh` script, [`keep.sh`](keep.sh), runs in a tmux session of its
//! own and holds the agent. The agent's stdin is fed from the journal `in` and
//! its stdout goes to `out`, both in `~/.yantra/keep/<workspace>/<thread>/`.
//! The daemon writes `in` and reads `out` over ssh, so a dropped pipe, a closed
//! browser and a daemon restart detach a turn and cancel none.
//!
//! The session is the thread's lock: `duplicate session` at a start means a
//! turn is already running (I-1). The pane is addressed by its `%id` (I-21),
//! `remain-on-exit` keeps the agent's status (I-4), and the script reaches the
//! pane through `respawn-pane` inside the base64 envelope (I-29, I-26, I-35).

use std::fmt;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, DuplexStream,
};
use tokio::sync::oneshot;

use crate::delegate::Place;
use crate::ssh::{self, Exec, Ssh};
use crate::tmux::{self, Opened, Tmux, sq};

/// Every keeper session's name starts with this, and no workspace's may.
pub const PREFIX: &str = "yantra-keep-";

const SCRIPT: &str = include_str!("keep.sh");

/// What the far reader says on stderr once the keeper's pane is dead.
const ENDED: &str = "yantra-keeper-ended";

/// How long one write to `in` may take before it counts as failed.
const APPEND_WITHIN: Duration = Duration::from_secs(30);
/// How many times the last read of a dead keeper's `out` is tried.
const DRAIN_TRIES: u32 = 6;
/// The longest wait between two tries of a reader or a writer.
const BACKOFF: Duration = Duration::from_secs(8);

/// Whether a tmux session is a keeper, which the session list hides.
pub fn is_keeper(session: &str) -> bool {
    session.starts_with(PREFIX)
}

/// The two limits the keeper enforces, and how often it checks them (ADR-0035
/// decision 5). A test passes small ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// The most `out` may hold, in bytes.
    pub cap: u64,
    /// How long `in` and `out` may both stay unchanged, in seconds.
    pub idle: u64,
    /// How often the keeper looks, in seconds.
    pub tick: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            cap: 64 << 20,
            idle: 24 * 60 * 60,
            tick: 60,
        }
    }
}

/// One thread's keeper: the session that holds it and the directory of its
/// journals. A workspace name and a thread id hold only `[A-Za-z0-9_-]`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Keeper {
    workspace: String,
    thread: String,
}

impl Keeper {
    pub fn new(workspace: &str, thread: &str) -> Self {
        Self {
            workspace: workspace.to_owned(),
            thread: thread.to_owned(),
        }
    }

    /// The keeper of a chat thread, whose id is `chat/<workspace>/<thread>`.
    pub fn of(place: &Place) -> Option<Self> {
        let mut parts = place.id.split('/');
        match (parts.next(), parts.next(), parts.next(), parts.next()) {
            (Some("chat"), Some(workspace), Some(thread), None) => {
                Some(Self::new(workspace, thread))
            }
            _ => None,
        }
    }

    /// The keeper a session name names. A thread id holds no `-`.
    pub fn parse(session: &str) -> Option<Self> {
        let (workspace, thread) = session.strip_prefix(PREFIX)?.rsplit_once('-')?;
        (!workspace.is_empty() && !thread.is_empty()).then(|| Self::new(workspace, thread))
    }

    pub fn session(&self) -> String {
        format!("{PREFIX}{}-{}", self.workspace, self.thread)
    }

    pub fn workspace(&self) -> &str {
        &self.workspace
    }

    pub fn thread(&self) -> &str {
        &self.thread
    }

    /// The journal directory as a word the far shell expands.
    fn dir(&self) -> String {
        format!(
            "\"$HOME\"/.yantra/keep/{}/{}",
            sq(&self.workspace),
            sq(&self.thread)
        )
    }

    /// Where the chat's images land, as a word the far shell expands.
    pub(crate) fn images(&self) -> String {
        format!("{}/images", self.dir())
    }

    /// Deletes the journals and the images, for [`crate::thread::remove`].
    pub(crate) fn removal(&self) -> String {
        format!("rm -rf {}", self.dir())
    }
}

/// Where in a keeper's `out` an event was read (ADR-0035 decision 8):
/// `<run>:<end of its line>:<its number among that line's events>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub run: String,
    pub end: u64,
    pub part: u32,
}

impl Cursor {
    pub fn parse(text: &str) -> Option<Self> {
        let mut parts = text.rsplitn(3, ':');
        let part = parts.next()?.parse().ok()?;
        let end = parts.next()?.parse().ok()?;
        let run = parts.next().filter(|run| !run.is_empty())?;
        Some(Self {
            run: run.to_owned(),
            end,
            part,
        })
    }

    /// Whether this comes after `other` in the same run.
    pub fn after(&self, other: &Self) -> bool {
        self.run == other.run && (self.end, self.part) > (other.end, other.part)
    }
}

impl fmt::Display for Cursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}:{}", self.run, self.end, self.part)
    }
}

/// Reads `reader` line by line until it ends, and gives each line with the
/// offset in `out` where it ends. Reading from `from`, only whole lines count,
/// so a reader that drops mid-line is continued from the line's start.
pub(crate) async fn read_lines<R: AsyncRead + Unpin>(
    reader: R,
    from: Option<u64>,
    mut each: impl FnMut(&[u8], Option<u64>),
) {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let mut at = from;
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => return,
            Ok(read) => match &mut at {
                Some(at) => {
                    if !line.ends_with(b"\n") {
                        return;
                    }
                    *at += read as u64;
                    each(&line, Some(*at));
                }
                None => each(&line, None),
            },
        }
    }
}

/// The whole lines of `out` with the offset each one ends at, and the offset
/// after the last of them.
pub(crate) fn lines(out: &[u8]) -> (Vec<(&[u8], u64)>, u64) {
    let mut found = Vec::new();
    let mut start = 0;
    while let Some(at) = out[start..].iter().position(|&byte| byte == b'\n') {
        let end = start + at + 1;
        found.push((&out[start..end], end as u64));
        start = end;
    }
    (found, start as u64)
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    #[error(transparent)]
    Tmux(#[from] tmux::Error),

    /// `said` is the end of what the command and `ssh` said.
    #[error("the keeper's journals could not be {what}: it exited {status}{}", colon(.said))]
    Journal {
        what: &'static str,
        status: i32,
        said: String,
    },

    /// `in` is not as long as the daemon wrote it, so a line would land out
    /// of order.
    #[error("the keeper's `in` holds {found} bytes where {expected} were written")]
    Behind { found: String, expected: u64 },
}

fn colon(said: &str) -> String {
    if said.is_empty() {
        String::new()
    } else {
        format!(": {said}")
    }
}

/// How a start went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Started {
    /// The thread's session was already there, so a turn is running.
    Busy,
    /// The keeper runs in this pane.
    Running { pane: String },
}

/// A fresh id for one keeper's life, which the cursors carry.
pub fn run_id() -> Result<String, Error> {
    Ok(ssh::nonce()?)
}

/// Starts `agent` in a new keeper. The session is taken first, so a running
/// turn's journals are never emptied; then the journals are emptied apart from
/// `images/`, `run` is written, and the script goes into the pane.
pub async fn start<E: Exec>(
    exec: &E,
    tmux: &Tmux,
    keeper: &Keeper,
    agent: &str,
    run: &str,
    limits: Limits,
) -> Result<Started, Error> {
    let made = exec
        .exec(&format!(
            "umask 077 && mkdir -p {d} && chmod 700 {d} && cd {d} && pwd",
            d = keeper.dir()
        ))
        .await?;
    let dir = String::from_utf8_lossy(&made.stdout)
        .lines()
        .last()
        .unwrap_or_default()
        .to_owned();
    if !made.success() || !dir.starts_with('/') {
        return Err(failed("made", &made));
    }
    let session = match tmux.ensure(exec, &keeper.session(), &dir, None).await? {
        Opened::Created(session) => session,
        Opened::Attached(_) => {
            if !stale(exec, tmux, keeper).await? {
                return Ok(Started::Busy);
            }
            kill(exec, tmux, keeper).await?;
            match tmux.ensure(exec, &keeper.session(), &dir, None).await? {
                Opened::Created(session) => session,
                Opened::Attached(_) => return Ok(Started::Busy),
            }
        }
    };
    let started = async {
        let prepared = exec.exec(&prepare(&dir, run)).await?;
        if !prepared.success() {
            return Err(failed("prepared", &prepared));
        }
        tmux.respawn(exec, &session.pane_id, &command(&dir, agent, limits))
            .await?;
        Ok(())
    }
    .await;
    if let Err(error) = started {
        // The lock goes with the start that failed.
        let _ = tmux.kill(exec, &keeper.session()).await;
        return Err(error);
    }
    Ok(Started::Running {
        pane: session.pane_id,
    })
}

/// Whether the keeper's session is one a failed start left behind, which no
/// daemon will ever feed: its pane never got the script, or its agent is alive
/// and `in` is still empty. Only a start under the thread's claim writes the
/// first line, so a session nobody holds that has none is never fed (Y-541).
pub async fn stale<E: Exec>(exec: &E, tmux: &Tmux, keeper: &Keeper) -> Result<bool, Error> {
    let Some(found) = pane(exec, tmux, keeper).await? else {
        return Ok(false);
    };
    if found.start_command.is_none() {
        return Ok(true);
    }
    Ok(!found.dead && size(exec, keeper, File::In).await? == 0)
}

/// Empties the journals apart from `images/`, so they hold one keeper's life.
fn prepare(dir: &str, run: &str) -> String {
    format!(
        "cd {} && rm -f in out err run mode feed feed.pid in.part && : >in && : >out && : >err \
         && printf '%s\\n' {} >run",
        sq(dir),
        sq(run)
    )
}

/// The pane's command: the script with its arguments, inside the envelope.
fn command(dir: &str, agent: &str, limits: Limits) -> String {
    use base64::Engine as _;
    let agent = base64::engine::general_purpose::STANDARD.encode(agent);
    ssh::stdio_payload(&format!(
        "set -- {} {} {} {agent} {}\n{SCRIPT}",
        sq(dir),
        limits.cap,
        limits.idle,
        limits.tick
    ))
}

fn failed(what: &'static str, out: &ssh::Output) -> Error {
    Error::Journal {
        what,
        status: out.status,
        said: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
    }
}

/// The keeper's pane, or `None` when its session is gone.
pub async fn pane<E: Exec>(
    exec: &E,
    tmux: &Tmux,
    keeper: &Keeper,
) -> Result<Option<tmux::Pane>, Error> {
    Ok(tmux.pane(exec, &keeper.session()).await?)
}

/// Kills the keeper's session. A session that is already gone is success (I-30).
pub async fn kill<E: Exec>(exec: &E, tmux: &Tmux, keeper: &Keeper) -> Result<(), Error> {
    Ok(tmux.kill(exec, &keeper.session()).await?)
}

/// Closes the agent's stdin by killing the `tail` that feeds it. A stdin that
/// is already closed is success.
pub async fn close_stdin<E: Exec>(exec: &E, keeper: &Keeper) -> Result<(), Error> {
    let out = exec
        .exec(&format!(
            "cd {} 2>/dev/null || exit 0; [ ! -f feed.pid ] || kill \"$(cat feed.pid)\" 2>/dev/null; exit 0",
            keeper.dir()
        ))
        .await?;
    if !out.success() {
        return Err(failed("closed", &out));
    }
    Ok(())
}

/// One of a keeper's files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum File {
    In,
    Out,
    Err,
    Run,
    Mode,
}

impl File {
    fn name(self) -> &'static str {
        match self {
            Self::In => "in",
            Self::Out => "out",
            Self::Err => "err",
            Self::Run => "run",
            Self::Mode => "mode",
        }
    }
}

/// What `file` holds, up to `upto` bytes. A file or a directory that is not
/// there holds nothing.
pub async fn read<E: Exec>(
    exec: &E,
    keeper: &Keeper,
    file: File,
    upto: Option<u64>,
) -> Result<Vec<u8>, Error> {
    let name = file.name();
    let read = match upto {
        Some(bytes) => format!("head -c {bytes} {name}"),
        None => format!("cat {name}"),
    };
    let out = exec
        .exec(&format!(
            "cd {} 2>/dev/null || exit 0; [ -f {name} ] || exit 0; {read}",
            keeper.dir()
        ))
        .await?;
    if !out.success() {
        return Err(failed("read", &out));
    }
    Ok(out.stdout)
}

/// How many bytes `file` holds; a file that is not there holds none.
pub async fn size<E: Exec>(exec: &E, keeper: &Keeper, file: File) -> Result<u64, Error> {
    let name = file.name();
    let out = exec
        .exec(&format!(
            "cd {} 2>/dev/null || {{ echo 0; exit 0; }}; [ -f {name} ] || {{ echo 0; exit 0; }}; \
             wc -c <{name}",
            keeper.dir()
        ))
        .await?;
    let said = String::from_utf8_lossy(&out.stdout);
    match said.lines().last().map(str::trim).map(str::parse) {
        Some(Ok(size)) if out.success() => Ok(size),
        _ => Err(failed("read", &out)),
    }
}

/// Writes the turn's permission mode, which an adopting daemon reads back.
pub async fn write_mode<E: Exec>(exec: &E, keeper: &Keeper, mode: &str) -> Result<(), Error> {
    let out = exec
        .exec(&format!(
            "umask 077 && cd {} && printf '%s\\n' {} >mode",
            keeper.dir(),
            sq(mode)
        ))
        .await?;
    if !out.success() {
        return Err(failed("written", &out));
    }
    Ok(())
}

/// Appends `line` to `in`, which holds `at` bytes before it. The line rides
/// stdin, so its size is not bound by a command line. A retry after a lost
/// answer finds the line already there and succeeds, so no line lands twice.
pub async fn append(ssh: &Ssh, keeper: &Keeper, at: u64, line: &[u8]) -> Result<(), Error> {
    let len = line.len() as u64;
    let ssh::Piped {
        mut child,
        mut stdin,
        stdout,
        stderr,
        log,
    } = ssh.stdio(&appending(keeper, at, len))?;
    drop(stdout);
    let said = crate::acp::diagnosis(stderr, log);
    let fed = async move {
        let fed = stdin.write_all(line).await;
        drop(stdin);
        fed
    };
    let (fed, status) = tokio::join!(fed, child.wait());
    let said = said.await.unwrap_or_default();
    let status = status.ok().and_then(|status| status.code()).unwrap_or(-1);
    match status {
        0 if fed.is_ok() => Ok(()),
        3 => Err(Error::Behind {
            found: said,
            expected: at,
        }),
        _ => Err(Error::Journal {
            what: "written",
            status,
            said,
        }),
    }
}

fn appending(keeper: &Keeper, at: u64, len: u64) -> String {
    let end = at + len;
    format!(
        "cd {} || exit 1\n\
         n=$(($(wc -c <in))) || exit 1\n\
         if [ \"$n\" -eq {end} ]; then cat >/dev/null; exit 0; fi\n\
         if [ \"$n\" -ne {at} ]; then cat >/dev/null; echo \"$n\" >&2; exit 3; fi\n\
         cat >in.part\n\
         if [ \"$(($(wc -c <in.part)))\" -ne {len} ]; then rm -f in.part; exit 4; fi\n\
         cat in.part >>in\n\
         s=$?\n\
         rm -f in.part\n\
         exit \"$s\"\n",
        keeper.dir()
    )
}

/// A writer whose every line is appended to `in`, which holds `at` bytes now.
/// A line that cannot be written is tried again for as long as the keeper's
/// pane lives, as the reader is. An `in` that another writer changed ends the
/// keeper and says why in `err`, so the turn fails where it can be seen.
pub fn feed(ssh: Ssh, tmux: Tmux, keeper: Keeper, at: u64) -> Feed {
    let (ours, theirs) = tokio::io::duplex(1 << 16);
    let (close, closed) = oneshot::channel();
    tokio::spawn(pump_in(ssh, tmux, keeper, at, ours, closed));
    Feed {
        inner: theirs,
        close: Some(close),
    }
}

/// The writer [`feed`] gives. Shutting it down closes the agent's stdin once
/// every line is in `in`; dropping it leaves the agent's stdin open, so a
/// daemon that stops detaches a turn and does not end it.
#[derive(Debug)]
pub struct Feed {
    inner: DuplexStream,
    close: Option<oneshot::Sender<()>>,
}

impl AsyncWrite for Feed {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        if let Some(close) = self.close.take() {
            let _ = close.send(());
        }
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

async fn pump_in(
    ssh: Ssh,
    tmux: Tmux,
    keeper: Keeper,
    mut at: u64,
    from: DuplexStream,
    mut closed: oneshot::Receiver<()>,
) {
    let mut lines = BufReader::new(from);
    let mut line = Vec::new();
    loop {
        line.clear();
        match lines.read_until(b'\n', &mut line).await {
            Ok(0) => break,
            Ok(_) if line.ends_with(b"\n") => {}
            _ => return,
        }
        let mut wait = Duration::from_secs(1);
        loop {
            let tried = tokio::time::timeout(APPEND_WITHIN, append(&ssh, &keeper, at, &line)).await;
            match tried {
                Ok(Ok(())) => break,
                Ok(Err(behind @ Error::Behind { .. })) => {
                    let _ = ssh
                        .exec(&format!(
                            "cd {} && printf '%s\\n' {} >>err",
                            keeper.dir(),
                            sq(&format!("yantra: {behind}"))
                        ))
                        .await;
                    let _ = kill(&ssh, &tmux, &keeper).await;
                    return;
                }
                _ => {
                    // A pane that is gone or dead reads no more lines.
                    if let Ok(found) = pane(&ssh, &tmux, &keeper).await
                        && found.is_none_or(|found| found.dead)
                    {
                        return;
                    }
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(BACKOFF);
                }
            }
        }
        at += line.len() as u64;
    }
    if closed.try_recv().is_ok() {
        let _ = close_stdin(&ssh, &keeper).await;
    }
}

/// A reader of `out` from byte `from` on, which outlives its `ssh`: when one
/// drops while the pane lives, another carries on from the next byte, after 1,
/// 2, 4 and then every 8 seconds (ADR-0035 decision 6). Once the pane is dead
/// it reads the rest of `out` and ends.
pub fn follow(ssh: Ssh, tmux: Tmux, keeper: Keeper, pane: String, from: u64) -> DuplexStream {
    let (ours, theirs) = tokio::io::duplex(1 << 16);
    tokio::spawn(pump_out(ssh, tmux, keeper, pane, from, ours));
    theirs
}

/// How one far reader ended.
enum Read {
    /// The pane is dead.
    Ended,
    /// The `ssh` ended without saying so.
    Dropped,
    /// Nobody reads any more.
    Closed,
}

async fn pump_out(
    ssh: Ssh,
    tmux: Tmux,
    keeper: Keeper,
    pane: String,
    mut at: u64,
    mut to: DuplexStream,
) {
    let mut wait = Duration::from_secs(1);
    loop {
        let before = at;
        match read_once(&ssh, &tmux, &keeper, &pane, &mut at, &mut to).await {
            Read::Closed => return,
            Read::Ended => {
                drain(&ssh, &keeper, at, &mut to).await;
                return;
            }
            Read::Dropped => {}
        }
        if at > before {
            wait = Duration::from_secs(1);
        }
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(BACKOFF);
    }
}

/// One far `tail -f`, which a loop beside it ends once the pane is dead. So a
/// reader whose local `ssh` was killed still ends with its keeper (I-27).
async fn read_once(
    ssh: &Ssh,
    tmux: &Tmux,
    keeper: &Keeper,
    pane: &str,
    at: &mut u64,
    to: &mut DuplexStream,
) -> Read {
    let Ok(ssh::Piped {
        mut child,
        stdin,
        mut stdout,
        stderr,
        log,
    }) = ssh.stdio(&reading(tmux, keeper, pane, *at))
    else {
        return Read::Dropped;
    };
    drop(stdin);
    let said = tokio::spawn(crate::acp::tail(stderr));
    let mut chunk = vec![0u8; 1 << 16];
    loop {
        match stdout.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if to.write_all(&chunk[..read]).await.is_err() {
                    return Read::Closed;
                }
                *at += read as u64;
            }
        }
    }
    let _ = child.wait().await;
    drop(log);
    let said = said.await.unwrap_or_default();
    if String::from_utf8_lossy(&said).contains(ENDED) {
        Read::Ended
    } else {
        Read::Dropped
    }
}

/// The far loop ends the `tail` only on a dead pane or one tmux cannot find;
/// any other answer, such as a tmux that failed to fork, is asked again.
fn reading(tmux: &Tmux, keeper: &Keeper, pane: &str, at: u64) -> String {
    format!(
        "cd {dir} || {{ echo {ENDED} >&2; exit 1; }}\n\
         tail -c +{from} -f out &\n\
         t=$!\n\
         while sleep 2; do\n\
         \x20 kill -0 \"$t\" 2>/dev/null || exit 1\n\
         \x20 case \"$({tmux} display-message -p -t {pane} '#{{pane_dead}}' 2>&1)\" in\n\
         \x20 1|*\"can't find\"*|*\"no server running\"*|*\"error connecting to\"*\"No such file\"*) break ;;\n\
         \x20 esac\n\
         done\n\
         kill \"$t\" 2>/dev/null\n\
         echo {ENDED} >&2\n",
        dir = keeper.dir(),
        from = at + 1,
        tmux = sq(tmux.path()),
        pane = sq(pane),
    )
}

/// The rest of `out` once the pane is dead, which the far `tail` may not have
/// sent before it was killed.
async fn drain(ssh: &Ssh, keeper: &Keeper, at: u64, to: &mut DuplexStream) {
    let mut wait = Duration::from_secs(1);
    for _ in 0..DRAIN_TRIES {
        let read = ssh
            .exec(&format!(
                "cd {} 2>/dev/null || exit 0; tail -c +{} out",
                keeper.dir(),
                at + 1
            ))
            .await;
        if let Ok(out) = read
            && out.success()
        {
            let _ = to.write_all(&out.stdout).await;
            return;
        }
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(BACKOFF);
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, ExitStatus};
    use std::time::Instant;

    #[test]
    fn a_keeper_is_named_by_its_workspace_and_thread_and_read_back() {
        let keeper = Keeper::new("web-app", "1a2b3c4d5e6f7a8b");
        assert_eq!(keeper.session(), "yantra-keep-web-app-1a2b3c4d5e6f7a8b");
        assert_eq!(Keeper::parse(&keeper.session()), Some(keeper.clone()));
        assert!(is_keeper(&keeper.session()));
        assert!(!is_keeper("web-app"));
        assert_eq!(Keeper::parse("yantra-keep-"), None);
        assert_eq!(Keeper::parse("web-app"), None);
        let place = Place {
            id: "chat/web-app/1a2b3c4d5e6f7a8b".to_owned(),
            repo: "/r".to_owned(),
            worktree: "/w".to_owned(),
            branch: "b".to_owned(),
            base: "0".to_owned(),
        };
        assert_eq!(Keeper::of(&place), Some(keeper));
    }

    #[test]
    fn a_cursor_reads_back_and_orders_within_its_run() {
        let at = Cursor::parse("Y01:120:1").expect("a cursor");
        assert_eq!(at.to_string(), "Y01:120:1");
        assert!(Cursor::parse("Y01:120:2").expect("one").after(&at));
        assert!(Cursor::parse("Y01:121:0").expect("one").after(&at));
        assert!(!Cursor::parse("Y01:120:1").expect("one").after(&at));
        assert!(!Cursor::parse("Y02:999:0").expect("one").after(&at));
        assert_eq!(Cursor::parse("120:1"), None);
        assert_eq!(Cursor::parse("Y01:x:1"), None);
    }

    #[test]
    fn only_whole_lines_are_counted() {
        let (found, offset) = lines(b"ab\ncd\nef");
        assert_eq!(found, [(&b"ab\n"[..], 3), (&b"cd\n"[..], 6)]);
        assert_eq!(offset, 6);
    }

    /// I-26: the agent reaches the script as base64, and the directory as one
    /// quoted word.
    #[test]
    fn the_pane_command_carries_the_script_and_its_arguments_encoded() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let pane = command(
            "/home/u/.yantra/keep/w/t",
            "exec claude -p",
            Limits::default(),
        );
        let encoded = pane
            .split("echo ")
            .nth(1)
            .and_then(|rest| rest.split(' ').next())
            .expect("an encoded script");
        let script = String::from_utf8(b64.decode(encoded).expect("base64")).expect("utf-8");
        let agent = b64.encode("exec claude -p");
        assert!(
            script.starts_with(&format!(
                "set -- '/home/u/.yantra/keep/w/t' 67108864 86400 {agent} 60\n"
            )),
            "{script}"
        );
        assert!(script.ends_with(SCRIPT));
    }

    /// A scratch directory of the host's, removed when the test ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "yantra-keep-{label}-{}-{}",
                std::process::id(),
                ssh::nonce().expect("a nonce")
            ));
            std::fs::create_dir_all(&dir).expect("a scratch directory");
            Self(dir)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn read(&self, name: &str) -> String {
            std::fs::read_to_string(self.path(name)).unwrap_or_default()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The script under the host's `/bin/sh`, as tmux would run it.
    fn keep(dir: &Path, agent: &str, cap: u64, idle: u64, tick: u64) -> Child {
        use base64::Engine as _;
        let agent = base64::engine::general_purpose::STANDARD.encode(agent);
        Command::new("/bin/sh")
            .args(["-c", SCRIPT, "keep"])
            .arg(dir)
            .args([cap.to_string(), idle.to_string(), agent, tick.to_string()])
            .spawn()
            .expect("sh runs")
    }

    fn until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !done() {
            assert!(Instant::now() < deadline, "{what} within 20 s");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn ended(child: &mut Child) -> ExitStatus {
        let mut status = None;
        until("the keeper ends", || {
            status = child.try_wait().expect("it can be waited on");
            status.is_some()
        });
        status.expect("an exit status")
    }

    fn alive(pid: &str) -> bool {
        Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    fn append_to(scratch: &Scratch, text: &str) {
        use std::io::Write as _;
        std::fs::OpenOptions::new()
            .append(true)
            .open(scratch.path("in"))
            .expect("in is there")
            .write_all(text.as_bytes())
            .expect("in takes the line");
    }

    #[test]
    fn bytes_pass_from_in_to_out_and_a_closed_stdin_ends_the_keeper_clean() {
        let scratch = Scratch::new("pass");
        let mut keeper = keep(&scratch.0, "exec cat", 1 << 20, 3600, 1);
        until("feed.pid is written", || {
            !scratch.read("feed.pid").trim().is_empty()
        });
        append_to(&scratch, "{\"one\":1}\n");
        until("the line reaches out", || {
            scratch.read("out") == "{\"one\":1}\n"
        });
        append_to(&scratch, "{\"two\":2}\n");
        until("the second line follows", || {
            scratch.read("out") == "{\"one\":1}\n{\"two\":2}\n"
        });

        let tail = scratch.read("feed.pid");
        Command::new("kill")
            .arg(tail.trim())
            .status()
            .expect("kill runs");
        assert_eq!(ended(&mut keeper).code(), Some(0), "cat's own status");
        assert!(!scratch.path("feed").exists(), "the fifo is removed");
        assert!(!scratch.path("feed.pid").exists());
        assert!(!alive(&tail), "the tail is gone");
    }

    #[test]
    fn the_keeper_exits_with_the_agents_status_and_leaves_no_tail() {
        let scratch = Scratch::new("status");
        let mut keeper = keep(&scratch.0, "exit 7", 1 << 20, 3600, 1);
        assert_eq!(ended(&mut keeper).code(), Some(7));
        assert!(!scratch.path("feed").exists());
        assert!(!scratch.path("feed.pid").exists());
    }

    #[test]
    fn output_over_the_cap_stops_the_agent_and_says_why() {
        let scratch = Scratch::new("cap");
        let mut keeper = keep(&scratch.0, "exec yes", 100, 3600, 1);
        assert_eq!(ended(&mut keeper).code(), Some(143), "SIGTERM");
        assert!(
            scratch
                .read("err")
                .contains("yantra: output passed 100 bytes"),
            "{}",
            scratch.read("err")
        );
    }

    #[test]
    fn a_keeper_idle_past_its_limit_stops_the_agent_and_says_why() {
        let scratch = Scratch::new("idle");
        let started = Instant::now();
        let mut keeper = keep(&scratch.0, "exec sleep 60", 1 << 20, 2, 1);
        assert_eq!(ended(&mut keeper).code(), Some(143), "SIGTERM");
        assert!(started.elapsed() < Duration::from_secs(15));
        assert!(
            scratch.read("err").contains("yantra: idle for 2 seconds"),
            "{}",
            scratch.read("err")
        );
    }

    #[test]
    fn a_line_written_to_in_keeps_the_keeper_from_going_idle() {
        let scratch = Scratch::new("busy");
        let mut keeper = keep(&scratch.0, "exec cat", 1 << 20, 3, 1);
        until("feed.pid is written", || {
            !scratch.read("feed.pid").trim().is_empty()
        });
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            append_to(&scratch, "x\n");
            std::thread::sleep(Duration::from_millis(500));
            assert!(
                keeper.try_wait().expect("waitable").is_none(),
                "a keeper that is written to is not idle"
            );
        }
        let _ = Command::new("kill")
            .arg(scratch.read("feed.pid").trim())
            .status();
        assert_eq!(ended(&mut keeper).code(), Some(0));
    }

    /// Answers every command with a path, as `Tmux::resolve`'s probe would.
    struct Found(String);

    impl Exec for Found {
        async fn exec(&self, _: &str) -> Result<ssh::Output, ssh::Error> {
            Ok(ssh::Output {
                status: 0,
                stdout: format!("{}\n", self.0).into_bytes(),
                stderr: Vec::new(),
            })
        }
    }

    /// The far reader under the host's `/bin/sh`, against a tmux that first
    /// answers nonsense, then `0`, then that it cannot find the pane. Only the
    /// last ends the `tail`.
    #[tokio::test]
    async fn the_far_reader_ends_only_on_a_dead_or_missing_pane() {
        use std::os::unix::fs::PermissionsExt as _;
        let scratch = Scratch::new("reader");
        std::fs::write(scratch.path("out"), b"").expect("out");
        let fake = scratch.path("tmux");
        std::fs::write(
            &fake,
            format!(
                "#!/bin/sh\necho x >>{calls}\ncase $(wc -l <{calls}) in\n\
                 *1) echo 'server exited unexpectedly' >&2 ;;\n*2) echo 0 ;;\n\
                 *) echo \"can't find pane: %9\" >&2; exit 1 ;;\nesac\n",
                calls = sq(&scratch.path("calls").to_string_lossy())
            ),
        )
        .expect("a fake tmux");
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755))
            .expect("the fake runs");
        let tmux = Tmux::resolve(&Found(fake.to_string_lossy().into_owned()))
            .await
            .expect("the fake resolves");
        let script = reading(&tmux, &Keeper::new("w", "t"), "%9", 0).replacen(
            "cd \"$HOME\"/.yantra/keep/'w'/'t'",
            &format!("cd {}", sq(&scratch.0.to_string_lossy())),
            1,
        );
        let out = Command::new("/bin/sh")
            .args(["-c", &script])
            .output()
            .expect("sh runs");
        assert!(String::from_utf8_lossy(&out.stderr).contains(ENDED));
        assert_eq!(
            scratch.read("calls").lines().count(),
            3,
            "asked three times"
        );
    }

    #[test]
    fn the_append_command_writes_only_at_the_offset_it_names() {
        let script = appending(&Keeper::new("w", "t"), 10, 4);
        assert!(script.starts_with("cd \"$HOME\"/.yantra/keep/'w'/'t' || exit 1\n"));
        assert!(script.contains("if [ \"$n\" -eq 14 ]; then cat >/dev/null; exit 0; fi"));
        assert!(script.contains("if [ \"$n\" -ne 10 ]; then"));
        assert!(script.contains("-ne 4 ]; then rm -f in.part; exit 4; fi"));
    }

    /// The append's three cases under the host's `/bin/sh`: a line lands at
    /// its offset, a retry of it lands nothing, and an offset that is wrong
    /// lands nothing and says so.
    #[test]
    fn an_append_lands_once_and_never_out_of_order() {
        let scratch = Scratch::new("append");
        std::fs::write(scratch.path("in"), b"0123456789").expect("in");
        let run = |at: u64, line: &str| {
            use std::io::Write as _;
            let script = appending(&Keeper::new("w", "t"), at, line.len() as u64).replacen(
                "cd \"$HOME\"/.yantra/keep/'w'/'t'",
                &format!("cd {}", sq(&scratch.0.to_string_lossy())),
                1,
            );
            let mut child = Command::new("/bin/sh")
                .args(["-c", &script])
                .stdin(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("sh runs");
            child
                .stdin
                .take()
                .expect("stdin")
                .write_all(line.as_bytes())
                .expect("written");
            child.wait().expect("it ends").code()
        };
        assert_eq!(run(10, "abc\n"), Some(0));
        assert_eq!(scratch.read("in"), "0123456789abc\n");
        assert_eq!(run(10, "abc\n"), Some(0), "a retry finds it there");
        assert_eq!(scratch.read("in"), "0123456789abc\n");
        assert_eq!(run(3, "zzz\n"), Some(3));
        assert_eq!(scratch.read("in"), "0123456789abc\n");
        assert!(!scratch.path("in.part").exists());
    }
}
