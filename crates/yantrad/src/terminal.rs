//! `GET /api/workspaces/{name}/terminal`,
//! `GET /api/machines/{machine}/sessions/{session}/terminal`,
//! `GET /api/machines/{machine}/install/{index}/terminal` and
//! `GET /api/machines/{machine}/owner/terminal?as=<admin>` —
//! [`yantra_core::pty::Terminal`] on a WebSocket.
//!
//! **Two addresses, one bridge.** A workspace is read for the machine and the
//! session it names, so a caller that has both needs no workspace
//! ([ADR-0022](../../../docs/adr/0022-a-socket-may-address-a-session-rather-than-a-workspace.md)).
//! The second route is the first one's `allowed()`, protocol and ping,
//! unchanged — what differs is the [`Target`] a socket carries and the name a
//! refusal says.
//!
//! **The third is a one-off terminal, and it runs a command it is handed by
//! index** ([ADR-0030]). An install whose sudo wanted a password left the
//! command; the socket names its place in what the daemon remembers, never the
//! command itself, and the terminal ends when the command does, saying how.
//!
//! **The fourth is the owner terminal, and it runs no command** ([ADR-0046]
//! §2). It is the login shell of the owner's admin account, so it needs the
//! owner's live session cookie, and it ends as the third does.
//!
//! **An upgrade is a `GET`, so it does not inherit the write check, and this is
//! the route that most needs one.** [`crate::write::allowed`] is called by name
//! before the upgrade rather than left to a reader to notice: `up` starts a
//! process Yantra chose, and a terminal runs whatever the person on the other
//! end types
//! ([ADR-0016](../../../docs/adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)).
//!
//! **The third thing a handler may do about ssh, beside the other two.**
//! [`crate::refresh`] states the rule — a handler reads memory, nothing awaits
//! ssh on a read — and [`crate::write`] is the exception because a person tapped
//! a button once. This one holds an ssh connection open for as long as someone
//! is looking at the terminal. What keeps it from being the storm that rule
//! prevents is that the request is over before any of it: the upgrade answers,
//! and the connection belongs to the socket rather than to a handler.
//!
//! **Q5 closed *reference-only, always* and names a terminal stream in the
//! sentence, so nothing here logs a byte of one** — not truncated, not at
//! debug. The lifecycle is logged; the payload never is. On the one-off route
//! the payload is a sudo password.
//!
//! The frames need no envelope, because the protocol already carries two kinds.
//! **Binary is terminal bytes**, in both directions. **Text is control**: from
//! the browser it is always a [`Size`], which must arrive before anything else
//! because a pty is opened with a window and a terminal, and nothing else tells
//! the daemon how big a browser is or which one it is; from the daemon it is the
//! reason a terminal could not be opened, which a close frame cannot carry —
//! that reason is capped at 123 bytes and an ssh diagnosis is longer — or, on
//! the one-off route alone, the [`Exit`] it ended with.
//!
//! **The daemon originates the ping, because nothing else here is on a timer**
//! (Y-134). A [`pty::Terminal`] owns the local `ssh`, the pty master and the
//! reader thread, and its `Drop` is what detaches the tmux client on the far
//! side — so a socket whose peer vanished holds all of it until a send fails,
//! and a send needs the far side to print first, which an agent thinking
//! quietly never does. **The instrument is a ping and never a traffic timer**:
//! output in progress is not idleness and silence is not death, so neither
//! direction of the stream says anything about whether the peer is there. The
//! pong RFC 6455 requires does, and it is a protocol frame rather than the
//! stream, so Q5's line above still holds — nothing reads what is on it.
//!
//! [ADR-0030]: ../../../docs/adr/0030-a-one-off-terminal-runs-only-a-command-an-install-left.md
//! [ADR-0046]: ../../../docs/adr/0046-the-owner-types-sudo-in-an-owner-terminal.md

use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::Response;
use axum::routing::get;
use tokio::time::MissedTickBehavior;
use yantra_core::inventory::Inventory;
use yantra_core::pty;
use yantra_core::{identity, install};

use crate::write::{
    Authoriser, Left, Missed, Peer, Refused, allowed_socket, chain, left_command, signed_in_socket,
    until_revoked,
};

/// Long enough that a socket nobody is typing at costs one frame a browser
/// answers in microseconds; short enough that what a vanished peer holds is
/// bounded well under the kernel's own retransmission budget.
#[cfg(not(test))]
pub(crate) const PING_EVERY: Duration = Duration::from_secs(20);
#[cfg(test)]
pub(crate) const PING_EVERY: Duration = Duration::from_millis(200);

/// One unanswered ping is a phone whose radio slept or a busy main thread; two
/// in a row is a peer that is not there.
pub(crate) const MISSES: u8 = 2;

pub fn router<I, S>(authoriser: Authoriser<I>, left: Left) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    // A handler takes one state, and the one-off route also reads what an
    // install left.
    let once: Router<S> = Router::new()
        .route(
            "/machines/{machine}/install/{index}/terminal",
            get(step::<I>),
        )
        .with_state(OneOff {
            authoriser: authoriser.clone(),
            left,
        });
    Router::new()
        .route("/workspaces/{name}/terminal", get(attach::<I>))
        .route(
            "/machines/{machine}/sessions/{session}/terminal",
            get(tap::<I>),
        )
        .route("/machines/{machine}/owner/terminal", get(owner::<I>))
        .with_state(authoriser)
        .merge(once)
}

#[derive(Clone)]
struct OneOff<I> {
    authoriser: Authoriser<I>,
    left: Left,
}

async fn attach<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
    Path(name): Path<String>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, Refused> {
    let (caller, revoked) = allowed_socket(&authoriser, &from, &headers).await?;
    let target = Target::Workspace(name);
    tracing::info!("terminal {target} for {}", caller.node);

    Ok(upgrade.on_upgrade(move |socket| until_revoked(revoked, bridge(socket, target))))
}

/// The same socket, addressed the way the kill route already is (ADR-0022 §4).
/// It attaches and never creates, so a session that went away between the list
/// and the tap is refused by name rather than opened.
async fn tap<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
    Path((machine, session)): Path<(String, String)>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, Refused> {
    let (caller, revoked) = allowed_socket(&authoriser, &from, &headers).await?;
    let target = Target::Session { machine, session };
    tracing::info!("terminal {target} for {}", caller.node);

    Ok(upgrade.on_upgrade(move |socket| until_revoked(revoked, bridge(socket, target))))
}

/// Y-394, [ADR-0030] §2: a step an install left, by its place in the list and
/// the `at` of the install event the caller read, so nothing a caller writes
/// can run and a newer install is never run under an older one's name. The
/// name is checked before the upgrade because it reaches `ssh`'s argv (I-63);
/// a step that is not there, or no longer the latest, is refused by name after
/// it, as a session that is not there is.
///
/// [ADR-0030]: ../../../docs/adr/0030-a-one-off-terminal-runs-only-a-command-an-install-left.md
async fn step<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<OneOff<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
    Path((machine, index)): Path<(String, usize)>,
    uri: Uri,
    upgrade: WebSocketUpgrade,
) -> Result<Response, Refused> {
    let (caller, revoked) = allowed_socket(&state.authoriser, &from, &headers).await?;
    install::check_machine(&machine).map_err(|error| Refused::Verb {
        status: StatusCode::BAD_REQUEST,
        said: error.to_string(),
    })?;
    let at = read_at(&uri).ok_or_else(|| Refused::Verb {
        status: StatusCode::BAD_REQUEST,
        said: "a step names the install it was read from, as ?at=".to_owned(),
    })?;
    let target = Target::Step {
        machine,
        index,
        at,
        left: state.left,
    };
    tracing::info!("terminal {target} for {}", caller.node);

    Ok(upgrade.on_upgrade(move |socket| until_revoked(revoked, bridge(socket, target))))
}

/// The install a caller read its step from, as `?at=` its event's time.
/// Read by hand, as `write.rs` reads `?force=true`.
fn read_at(uri: &Uri) -> Option<u64> {
    query(uri, "at=")?.parse().ok()
}

fn query<'a>(uri: &'a Uri, key: &str) -> Option<&'a str> {
    uri.query()?
        .split('&')
        .find_map(|pair| pair.strip_prefix(key))
}

/// Y-701, [ADR-0046] §2: the admin account's login shell. Both names reach
/// `ssh`'s argv (I-63), so each is checked before the upgrade. The account
/// name is read as sent: a name that needs decoding is not one sshd takes.
///
/// [ADR-0046]: ../../../docs/adr/0046-the-owner-types-sudo-in-an-owner-terminal.md
async fn owner<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<Peer>,
    headers: HeaderMap,
    Path(machine): Path<String>,
    uri: Uri,
    upgrade: WebSocketUpgrade,
) -> Result<Response, Refused> {
    let (caller, revoked) = signed_in_socket(&authoriser, &from, &headers).await?;
    install::check_machine(&machine).map_err(|error| Refused::Verb {
        status: StatusCode::BAD_REQUEST,
        said: error.to_string(),
    })?;
    let user = query(&uri, "as=")
        .filter(|user| identity::usable_user(user))
        .ok_or_else(|| Refused::Verb {
            status: StatusCode::BAD_REQUEST,
            said: "an owner terminal names the admin account as ?as=: letters, digits, `.`, `_` \
                   and `-`, at most 32, not starting with `-` or `.`"
                .to_owned(),
        })?
        .to_owned();
    let target = Target::Owner { machine, user };
    tracing::info!("terminal {target} for {}", caller.node);

    Ok(upgrade.on_upgrade(move |socket| until_revoked(Some(revoked), bridge(socket, target))))
}

/// What a socket attaches to: a workspace this daemon looks up, a machine and a
/// session it is handed, or a step an install left on a machine.
enum Target {
    Workspace(String),
    Session {
        machine: String,
        session: String,
    },
    Step {
        machine: String,
        index: usize,
        at: u64,
        left: Left,
    },
    Owner {
        machine: String,
        user: String,
    },
}

impl Target {
    async fn open(&self, term: &str, size: pty::Size) -> Result<pty::Terminal, Unopened> {
        Ok(match self {
            Self::Workspace(name) => pty::open(name, term, size).await?,
            Self::Session { machine, session } => {
                pty::open_session(machine, session, term, size).await?
            }
            Self::Step {
                machine,
                index,
                at,
                left,
            } => {
                let command =
                    left_command(left, machine, *index, *at).map_err(|missed| match missed {
                        Missed::Nothing => Unopened::NoStep {
                            machine: machine.clone(),
                            index: *index,
                        },
                        Missed::Newer => Unopened::Newer {
                            machine: machine.clone(),
                            index: *index,
                        },
                    })?;
                pty::run(machine, &command, term, size).await?
            }
            Self::Owner { machine, user } => pty::login(machine, user, term, size).await?,
        })
    }

    /// A one-off terminal ends when its command or shell does, and says how;
    /// the other two end when the person leaves.
    fn reports_exit(&self) -> bool {
        matches!(self, Self::Step { .. } | Self::Owner { .. })
    }
}

/// What every log line on this route says, and the whole of what Q5 lets it
/// say about a stream. A step is named by its place, never by its command.
impl std::fmt::Display for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Workspace(name) => write!(f, "{name}"),
            Self::Session { machine, session } => write!(f, "{session} on {machine}"),
            Self::Step { machine, index, .. } => write!(f, "install step {index} on {machine}"),
            Self::Owner { machine, user } => write!(f, "owner terminal as {user} on {machine}"),
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum Unopened {
    #[error(transparent)]
    Pty(#[from] pty::Error),

    /// A restart empties the list, and the next install replaces it.
    #[error("no install on {machine} left a step {index}; press Install again")]
    NoStep { machine: String, index: usize },

    /// The page read an older install than the daemon holds, so the command it
    /// shows is not the one this step would run.
    #[error("a newer install on {machine} replaced step {index}; read the page again")]
    Newer { machine: String, index: usize },
}

/// The browser's window and the terminal it is, which are the facts about the
/// caller that only the far end of the socket has.
///
/// I-36 refuses a *user's* `TERM` as an input; this one is a constant the
/// dashboard's own code holds, and `terminfo::choose` probes it either way.
#[derive(Debug, serde::Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
#[serde(deny_unknown_fields)]
struct Size {
    rows: u16,
    cols: u16,
    term: String,
}

impl From<&Size> for pty::Size {
    fn from(size: &Size) -> Self {
        Self {
            rows: size.rows,
            cols: size.cols,
        }
    }
}

/// The text frame a one-off terminal ends on (ADR-0030 §5). `None` is a status
/// that could not be read.
#[derive(Debug, serde::Serialize)]
struct Exit {
    exit: Option<i32>,
}

async fn bridge(mut socket: WebSocket, target: Target) {
    // The pty arrives with the first control frame, so the socket outlives the
    // terminal at both ends and the ping has to cover the whole of it.
    let mut terminal: Option<pty::Terminal> = None;
    let mut unanswered = 0u8;
    let mut pings = tokio::time::interval(PING_EVERY);
    // Delay, not the default burst: opening the pty can outlast an interval,
    // and catch-up ticks would count as misses nobody was given time to answer.
    pings.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        // The arms carry the event out rather than handling it, so the borrows
        // `select!` holds end before either side is touched again.
        let event = tokio::select! {
            printed = printed(&mut terminal) => Either::Printed(printed),
            typed = socket.recv() => Either::Typed(typed),
            _ = pings.tick() => Either::Quiet,
        };

        match event {
            Either::Printed(Some(bytes)) => {
                if socket.send(Message::Binary(bytes.into())).await.is_err() {
                    break;
                }
            }
            Either::Typed(Some(Ok(Message::Binary(bytes)))) => {
                if let Some(open) = terminal.as_mut()
                    && let Err(error) = open.write(bytes.into()).await
                {
                    tracing::warn!("terminal {target} stopped accepting input: {error}");
                    break;
                }
            }
            Either::Typed(Some(Ok(Message::Text(text)))) => {
                if !control(&mut socket, &mut terminal, &target, &text).await {
                    break;
                }
            }
            Either::Typed(Some(Ok(Message::Pong(_)))) => unanswered = 0,
            // An inbound ping is still axum's to answer.
            Either::Typed(Some(Ok(_))) => {}
            Either::Quiet => {
                if unanswered >= MISSES {
                    tracing::info!("terminal {target} answered no ping");
                    break;
                }
                unanswered += 1;
                if socket.send(Message::Ping(Bytes::new())).await.is_err() {
                    break;
                }
            }
            Either::Printed(None) => {
                if target.reports_exit() {
                    exited(&mut socket, &mut terminal, &target).await;
                }
                break;
            }
            Either::Typed(None | Some(Err(_))) => break,
        }
    }
    tracing::info!("terminal {target} ended");
}

/// The command's status, then a close: a one-off terminal is over, and a
/// reopened socket would run the command again.
async fn exited(socket: &mut WebSocket, terminal: &mut Option<pty::Terminal>, target: &Target) {
    let exit = match terminal.as_mut() {
        Some(open) => open.exited().await,
        None => None,
    };
    match exit {
        Some(code) => tracing::info!("terminal {target} exited {code}"),
        None => tracing::info!("terminal {target} exited with no status to read"),
    }
    if let Ok(said) = serde_json::to_string(&Exit { exit }) {
        let _ = socket.send(Message::Text(said.into())).await;
    }
    let _ = socket.send(Message::Close(None)).await;
}

enum Either {
    Printed(Option<Vec<u8>>),
    Typed(Option<Result<Message, axum::Error>>),
    Quiet,
}

/// A `select!` arm has to be a future, and nothing is printed before there is
/// something to print it.
async fn printed(terminal: &mut Option<pty::Terminal>) -> Option<Vec<u8>> {
    match terminal {
        Some(open) => open.read().await,
        None => std::future::pending().await,
    }
}

/// A pty is opened with a window, so the first control frame is what starts the
/// terminal and every later one resizes it. `false` ends the socket.
async fn control(
    socket: &mut WebSocket,
    terminal: &mut Option<pty::Terminal>,
    target: &Target,
    text: &str,
) -> bool {
    if let Some(open) = terminal.as_ref() {
        resize(open, target, text);
        return true;
    }

    let Ok(size) = serde_json::from_str::<Size>(text) else {
        let _ = socket
            .send(Message::Text(
                "a terminal opens with {\"rows\":…,\"cols\":…,\"term\":…}".into(),
            ))
            .await;
        return false;
    };

    match target.open(&size.term, (&size).into()).await {
        Ok(open) => {
            *terminal = Some(open);
            true
        }
        Err(error) => {
            let said = chain(&error);
            tracing::warn!("no terminal for {target}: {said}");
            let _ = socket.send(Message::Text(said.into())).await;
            false
        }
    }
}

/// A window that could not be parsed or set leaves a working terminal at the
/// wrong size, which is worth saying and is not worth ending a session over.
///
/// One message does both jobs, so `term` arrives again here and is not read: a
/// caller cannot become a different terminal without opening another socket.
fn resize(terminal: &pty::Terminal, target: &Target, text: &str) {
    match serde_json::from_str::<Size>(text) {
        Ok(size) => {
            if let Err(error) = terminal.resize((&size).into()) {
                tracing::warn!("terminal {target}: {error}");
            }
        }
        Err(_) => tracing::warn!("terminal {target} was sent a control frame that is not a size"),
    }
}

/// The shapes on this seam that the browser writes or reads outside the
/// stream, for the check in [`crate::contract`].
#[cfg(test)]
#[allow(clippy::expect_used)]
pub(crate) fn answers() -> Vec<(&'static str, &'static str, serde_json::Value)> {
    vec![
        (
            "terminalSize",
            "TerminalSize",
            serde_json::to_value(Size {
                rows: 40,
                cols: 120,
                term: "xterm-256color".to_owned(),
            })
            .expect("two numbers and a name"),
        ),
        (
            "terminalExit",
            "TerminalExit",
            serde_json::to_value(Exit { exit: Some(0) }).expect("a number"),
        ),
    ]
}

#[cfg(test)]
#[allow(clippy::expect_used)]
pub(crate) mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::net::SocketAddr;
    use std::net::{IpAddr, Ipv4Addr};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::time::timeout;
    use yantra_core::inventory::{Caller, Fake};

    pub(crate) const ME: u64 = 1;

    pub(crate) const LOCAL: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

    pub(crate) const TEXT: u8 = 0x1;
    pub(crate) const BINARY: u8 = 0x2;
    pub(crate) const PING: u8 = 0x9;

    /// The three addresses one bridge serves (ADR-0022, ADR-0030).
    const WORKSPACE: &str = "/api/workspaces/api/terminal";
    const SESSION: &str = "/api/machines/fixture/sessions/scratch/terminal";
    const STEP: &str = "/api/machines/fixture/install/0/terminal?at=100";

    /// The `at` of the install event every test here remembers.
    const AT: u64 = 100;

    const WINDOW: &str = r#"{"rows":24,"cols":80,"term":"xterm-256color"}"#;

    pub(crate) fn tailnet(callers: Vec<(IpAddr, Caller)>) -> Fake {
        Fake {
            machines: Vec::new(),
            addresses: Vec::new(),
            callers: callers.into_iter().collect::<BTreeMap<_, _>>(),
            owner: ME,
        }
    }

    /// Bound to nothing, so the loopback peer is never this machine and is
    /// the caller, as ADR-0016 wrote it.
    pub(crate) fn direct(caller: Option<Caller>) -> Authoriser<Fake> {
        Authoriser::new(
            tailnet(caller.map(|caller| (LOCAL, caller)).into_iter().collect()),
            &[],
            std::path::Path::new("yantrad.sock"),
            crate::passkey::Passkeys::trusting(),
        )
    }

    /// What an install on `machine` left.
    fn left(machine: &str, commands: &[&str]) -> Left {
        let left = Left::default();
        left.lock().expect("a fresh lock").insert(
            machine.to_owned(),
            (AT, commands.iter().map(|one| (*one).to_owned()).collect()),
        );
        left
    }

    /// A real listener, because `oneshot` never gives axum the upgrade it
    /// extracts: the peer address a refusal turns on is the one the kernel
    /// reports, so the tailnet is faked at loopback rather than at 100.64/10.
    async fn connect(
        authoriser: Authoriser<Fake>,
        path: &str,
        forwarded: &str,
    ) -> BufReader<TcpStream> {
        connect_with(authoriser, Left::default(), path, forwarded).await
    }

    async fn connect_with(
        authoriser: Authoriser<Fake>,
        left: Left,
        path: &str,
        forwarded: &str,
    ) -> BufReader<TcpStream> {
        connect_to(router(authoriser, left), path, forwarded).await
    }

    /// Serves `api` under `/api` on a real listener and sends the upgrade.
    pub(crate) async fn connect_to(
        api: Router,
        path: &str,
        forwarded: &str,
    ) -> BufReader<TcpStream> {
        let app = Router::new().nest("/api", api);

        let listener = TcpListener::bind((LOCAL, 0)).await.expect("a free port");
        let address = listener.local_addr().expect("it is bound");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app.into_make_service_with_connect_info::<Peer>()).await;
        });

        let mut stream = TcpStream::connect(address).await.expect("the daemon is up");
        stream
            .write_all(
                format!(
                    "GET {path} HTTP/1.1\r\n\
                     Host: yantra\r\n\
                     Connection: Upgrade\r\n\
                     Upgrade: websocket\r\n\
                     Sec-WebSocket-Version: 13\r\n\
                     Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                     {forwarded}\r\n"
                )
                .as_bytes(),
            )
            .await
            .expect("the request is written");

        BufReader::new(stream)
    }

    async fn handshake(authoriser: Authoriser<Fake>, path: &str, forwarded: &str) -> String {
        let mut status = String::new();
        connect(authoriser, path, forwarded)
            .await
            .read_line(&mut status)
            .await
            .expect("an HTTP response");
        status
    }

    /// Past the handshake and onto the frames, which is where a ping is.
    async fn upgraded(authoriser: Authoriser<Fake>) -> BufReader<TcpStream> {
        upgraded_at(authoriser, Left::default(), WORKSPACE, "").await
    }

    async fn upgraded_at(
        authoriser: Authoriser<Fake>,
        left: Left,
        path: &str,
        headers: &str,
    ) -> BufReader<TcpStream> {
        let mut socket = connect_with(authoriser, left, path, headers).await;
        let mut line = String::new();
        loop {
            line.clear();
            let read = socket.read_line(&mut line).await.expect("a header");
            assert!(read > 0, "the response ended before its headers did");
            if line == "\r\n" {
                return socket;
            }
            assert!(!line.starts_with("HTTP/1.1 4"), "{line}");
        }
    }

    /// Server frames are unmasked. The length is seven bits, or sixteen after
    /// a 126; nothing here sends a frame longer than that.
    pub(crate) async fn frame(socket: &mut BufReader<TcpStream>) -> std::io::Result<(u8, Vec<u8>)> {
        let mut head = [0u8; 2];
        socket.read_exact(&mut head).await?;
        let length = match head[1] & 0x7f {
            126 => usize::from(socket.read_u16().await?),
            short => usize::from(short),
        };
        let mut payload = vec![0u8; length];
        socket.read_exact(&mut payload).await?;
        Ok((head[0] & 0x0f, payload))
    }

    /// A client frame must be masked or the far side is entitled to drop the
    /// socket; a zero mask leaves the payload as it is.
    pub(crate) async fn send(socket: &mut BufReader<TcpStream>, opcode: u8, payload: &[u8]) {
        let length = u8::try_from(payload.len()).expect("a short frame");
        assert!(length < 126, "a frame this helper can send");
        let mut out = vec![0x80 | opcode, 0x80 | length, 0, 0, 0, 0];
        out.extend_from_slice(payload);
        socket
            .get_mut()
            .write_all(&out)
            .await
            .expect("a frame is written");
    }

    pub(crate) async fn pong(socket: &mut BufReader<TcpStream>) {
        send(socket, 0xa, &[]).await;
    }

    pub(crate) fn caller(user: u64, tags: &[&str]) -> Caller {
        Caller {
            node: "nSOME000000011CNTRL".to_string(),
            user,
            tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
        }
    }

    /// The refusal, and the reason this route exists as its own module: an
    /// upgrade is a `GET`, and a `GET` that reached a handler without
    /// ADR-0016's check would be a shell for anyone the bind address admits.
    #[tokio::test]
    async fn a_caller_who_is_not_the_owner_is_not_upgraded() {
        for refused in [caller(ME + 1, &[]), caller(ME, &["tag:ci"])] {
            let status = handshake(direct(Some(refused)), WORKSPACE, "").await;
            assert!(status.starts_with("HTTP/1.1 403"), "{status}");
        }
        let stranger = handshake(direct(None), WORKSPACE, "").await;
        assert!(stranger.starts_with("HTTP/1.1 403"), "{stranger}");
    }

    /// The other half, so the refusal above cannot pass by refusing everyone.
    /// Nothing opens here — the pty waits for a size that never arrives.
    #[tokio::test]
    async fn this_owners_untagged_node_is_upgraded() {
        let status = handshake(direct(Some(caller(ME, &[]))), WORKSPACE, "").await;
        assert!(status.starts_with("HTTP/1.1 101"), "{status}");
    }

    /// **ADR-0022's route is the same route.** A socket that names a machine and
    /// a session upgrades for the owner's untagged node and refuses everything
    /// else, because it calls the one `allowed()` above it — the whole of the
    /// protection, and deliberately the only check either address gets.
    #[tokio::test]
    async fn a_session_addressed_socket_sits_on_the_same_authoriser() {
        let tagged = handshake(direct(Some(caller(ME, &["tag:ci"]))), SESSION, "").await;
        assert!(tagged.starts_with("HTTP/1.1 403"), "{tagged}");

        let stranger = handshake(direct(None), SESSION, "").await;
        assert!(stranger.starts_with("HTTP/1.1 403"), "{stranger}");

        let owner = handshake(direct(Some(caller(ME, &[]))), SESSION, "").await;
        assert!(owner.starts_with("HTTP/1.1 101"), "{owner}");
    }

    /// **ADR-0030's route sits on it too**, and it is the one a password is
    /// typed into.
    #[tokio::test]
    async fn a_one_off_terminal_sits_on_the_same_authoriser() {
        let tagged = handshake(direct(Some(caller(ME, &["tag:ci"]))), STEP, "").await;
        assert!(tagged.starts_with("HTTP/1.1 403"), "{tagged}");

        let stranger = handshake(direct(None), STEP, "").await;
        assert!(stranger.starts_with("HTTP/1.1 403"), "{stranger}");

        let owner = handshake(direct(Some(caller(ME, &[]))), STEP, "").await;
        assert!(owner.starts_with("HTTP/1.1 101"), "{owner}");
    }

    /// I-63 on the one-off route: the name reaches `ssh`'s argv, so one that
    /// could be read as an option is a 400 before any upgrade.
    #[tokio::test]
    async fn a_name_that_is_not_an_ssh_destination_is_refused_before_the_upgrade() {
        let status = handshake(
            direct(Some(caller(ME, &[]))),
            "/api/machines/-oProxyCommand=id/install/0/terminal?at=100",
            "",
        )
        .await;
        assert!(status.starts_with("HTTP/1.1 400"), "{status}");
    }

    /// ADR-0030 §2: the socket names a place in what the install left, and a
    /// place with nothing in it runs nothing — refused by name, as a session
    /// that is not there is.
    #[tokio::test]
    async fn a_step_outside_what_the_install_left_is_refused_by_name() {
        let said = refusal("/api/machines/fixture/install/3/terminal?at=100").await;
        assert_eq!(
            said,
            "no install on fixture left a step 3; press Install again"
        );
    }

    /// The first text frame a step socket answers once it is sized: how it was
    /// refused.
    async fn refusal(path: &str) -> String {
        let mut socket = upgraded_at(
            direct(Some(caller(ME, &[]))),
            left("fixture", &["sudo apk add tmux"]),
            path,
            "",
        )
        .await;
        send(&mut socket, TEXT, WINDOW.as_bytes()).await;
        loop {
            let (opcode, payload) = timeout(PING_EVERY * 10, frame(&mut socket))
                .await
                .expect("an answer")
                .expect("a frame");
            if opcode == PING {
                pong(&mut socket).await;
                continue;
            }
            assert_eq!(opcode, TEXT, "the refusal is a text frame");
            return String::from_utf8_lossy(&payload).into_owned();
        }
    }

    /// ADR-0030 §2: the page names the install it read. A newer one replaced
    /// that list, so the command the page shows is not the one at this place,
    /// and the step is refused by name rather than run under the wrong one.
    #[tokio::test]
    async fn a_step_from_an_install_that_is_no_longer_the_latest_is_refused_by_name() {
        let said = refusal("/api/machines/fixture/install/0/terminal?at=99").await;
        assert_eq!(
            said,
            "a newer install on fixture replaced step 0; read the page again"
        );
    }

    /// A socket that names no install cannot be matched to one, so it is
    /// refused before the upgrade.
    #[tokio::test]
    async fn a_step_socket_that_names_no_install_is_refused_before_the_upgrade() {
        let status = handshake(
            direct(Some(caller(ME, &[]))),
            "/api/machines/fixture/install/0/terminal",
            "",
        )
        .await;
        assert!(status.starts_with("HTTP/1.1 400"), "{status}");
    }

    /// A restart forgets what was left, and a later install on the same
    /// machine replaces it; the key is the lowercased name, as the lock's is.
    #[test]
    fn what_an_install_left_is_found_by_its_place_and_nothing_else() {
        let left = left("pi", &["sudo apt-get update; sudo apt-get install -y tmux"]);
        assert_eq!(
            left_command(&left, "PI", 0, AT).as_deref(),
            Ok("sudo apt-get update; sudo apt-get install -y tmux")
        );
        assert_eq!(left_command(&left, "pi", 1, AT), Err(Missed::Nothing));
        assert_eq!(left_command(&left, "mac", 0, AT), Err(Missed::Nothing));
        assert_eq!(left_command(&left, "pi", 0, AT + 1), Err(Missed::Newer));
        assert_eq!(
            left_command(&Left::default(), "pi", 0, AT),
            Err(Missed::Nothing)
        );
    }

    #[derive(Clone, Default)]
    pub(crate) struct Capture(pub(crate) Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("the log").extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// **Q5 on the route that carries a password, as far as a unit test
    /// reaches.** A real `ssh` under a real pty, to a name that cannot resolve,
    /// prints and exits with no network: what it printed reaches the socket and
    /// not this thread's log, and the terminal ends on `ssh`'s own status. The
    /// typed frame is sent, but `ssh` may exit before it is written, so the
    /// password half is `yantra-core/tests/install.rs`'s: it captures every
    /// thread's log while a real password goes through the pty.
    #[tokio::test]
    async fn a_one_off_terminal_logs_its_lifecycle_and_never_its_stream() {
        let capture = Capture::default();
        let writer = capture.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .with_writer(move || writer.clone())
            .finish();
        let _logging = tracing::subscriber::set_default(subscriber);

        let mut socket = upgraded_at(
            direct(Some(caller(ME, &[]))),
            left("nowhere.invalid", &["sudo apk add tmux"]),
            "/api/machines/nowhere.invalid/install/0/terminal?at=100",
            "",
        )
        .await;
        send(&mut socket, TEXT, WINDOW.as_bytes()).await;
        send(&mut socket, BINARY, b"typed-as-keystrokes\r").await;

        let mut printed = Vec::new();
        let exit = loop {
            let (opcode, payload) = timeout(Duration::from_secs(30), frame(&mut socket))
                .await
                .expect("the terminal ends")
                .expect("a frame");
            match opcode {
                PING => pong(&mut socket).await,
                BINARY => printed.extend_from_slice(&payload),
                _ => {
                    // A close here is a terminal that ended with no exit frame.
                    assert_eq!(opcode, TEXT, "the terminal ends on its exit frame");
                    break String::from_utf8_lossy(&payload).into_owned();
                }
            }
        };
        assert_eq!(exit, r#"{"exit":255}"#, "ssh's own status");

        let printed = String::from_utf8_lossy(&printed).into_owned();
        assert!(
            printed.contains("nowhere.invalid"),
            "ssh printed its diagnosis: {printed:?}"
        );

        let logged = String::from_utf8_lossy(&capture.0.lock().expect("the log")).into_owned();
        assert!(
            logged.contains("install step 0 on nowhere.invalid"),
            "{logged}"
        );
        assert!(logged.contains("exited 255"), "{logged}");
        assert!(
            !logged.contains("typed-as-keystrokes"),
            "what was typed was logged: {logged}"
        );
        let line = printed
            .lines()
            .find(|line| line.contains("nowhere.invalid"))
            .unwrap_or_default()
            .trim();
        assert!(
            !line.is_empty() && !logged.contains(line),
            "what was printed was logged: {logged}"
        );
    }

    /// **ADR-0042 on the route that hands over a shell.** Loopback is declared
    /// as what this daemon bound, so the peer is this machine: refused with a
    /// forged header and without one, as any account here could have sent it.
    #[tokio::test]
    async fn a_peer_that_is_this_machine_is_not_upgraded_with_or_without_a_header() {
        let ours = || {
            Authoriser::new(
                tailnet(vec![(LOCAL, caller(ME, &[]))]),
                &[SocketAddr::new(LOCAL, 7717)],
                std::path::Path::new("yantrad.sock"),
                crate::passkey::Passkeys::trusting(),
            )
        };

        let forged = handshake(ours(), WORKSPACE, "X-Forwarded-For: 100.64.0.2\r\n").await;
        assert!(forged.starts_with("HTTP/1.1 403"), "{forged}");
        let bare = handshake(ours(), WORKSPACE, "").await;
        assert!(bare.starts_with("HTTP/1.1 403"), "{bare}");
    }

    /// **The half of Y-134 that is easy to break.** An agent that runs quietly
    /// for an hour prints nothing and takes nothing, and a daemon that reaped it
    /// would have killed the thing M6 exists for. Nothing is typed here, nothing
    /// is printed, and every frame the daemon originates is another ping.
    #[tokio::test]
    async fn a_peer_that_answers_is_not_closed_however_long_it_prints_nothing() {
        let mut socket = upgraded(direct(Some(caller(ME, &[])))).await;

        for _ in 0..6 {
            let (opcode, _) = timeout(PING_EVERY * 3, frame(&mut socket))
                .await
                .expect("a ping within three intervals")
                .expect("a peer that answers is still connected");
            assert_eq!(opcode, PING, "the daemon closed a peer that was answering");
            pong(&mut socket).await;
        }
    }

    /// The other half, and the one the row was opened for: the peer is gone,
    /// the far side has printed nothing to fail a send on, and the socket ends
    /// anyway — which is what drops the `Terminal` when there is one.
    #[tokio::test]
    async fn a_peer_that_stops_answering_is_closed() {
        let mut socket = upgraded(direct(Some(caller(ME, &[])))).await;

        let unanswered = timeout(PING_EVERY * 8, async {
            let mut sent = 0u8;
            loop {
                match frame(&mut socket).await {
                    Ok((PING, _)) => sent += 1,
                    _ => return sent,
                }
            }
        })
        .await;

        assert_eq!(
            unanswered.ok(),
            Some(MISSES),
            "a socket nobody answered outlived its pings"
        );
    }

    const OWNER: &str = "/api/machines/fixture/owner/terminal?as=owner";

    /// The owner's untagged node on a store that checks cookies, and the
    /// header of one live session in it.
    fn signed_in() -> (Authoriser<Fake>, String) {
        let passkeys = crate::passkey::Passkeys::memory();
        let (_, token, _) = crate::passkey::tests::enrolled(&passkeys, "iPhone");
        let authoriser = Authoriser::new(
            tailnet(vec![(LOCAL, caller(ME, &[]))]),
            &[],
            std::path::Path::new("yantrad.sock"),
            passkeys,
        );
        (
            authoriser,
            format!("Cookie: {}={token}\r\n", crate::passkey::COOKIE),
        )
    }

    /// ADR-0046 §2.6: the owner terminal is an admin shell, so the owner's own
    /// node with no cookie is 401 and an agent's token is 403.
    #[tokio::test]
    async fn the_owner_terminal_needs_a_live_cookie_and_refuses_an_agent() {
        let (authoriser, _) = signed_in();
        let bare = handshake(authoriser.clone(), OWNER, "").await;
        assert!(bare.starts_with("HTTP/1.1 401"), "{bare}");

        let agent = authoriser.passkeys().mint_agent("api");
        let bearer = format!("Authorization: Bearer {}\r\n", agent.token);
        let refused = handshake(authoriser, OWNER, &bearer).await;
        assert!(refused.starts_with("HTTP/1.1 403"), "{refused}");
    }

    /// The other half, so the refusal above cannot pass by refusing everyone.
    #[tokio::test]
    async fn the_owner_terminal_upgrades_for_a_live_cookie() {
        let (authoriser, cookie) = signed_in();
        let status = handshake(authoriser, OWNER, &cookie).await;
        assert!(status.starts_with("HTTP/1.1 101"), "{status}");
    }

    /// I-63: both names reach `ssh`'s argv, so a name `ssh` could read as an
    /// option or a token is a 400 before any upgrade, as is no name.
    #[tokio::test]
    async fn a_bad_machine_or_account_is_refused_before_the_upgrade() {
        let (authoriser, cookie) = signed_in();
        let too_long = format!("as={}", "a".repeat(33));
        for query in [
            "", "as=", "as=-x", "as=a%20b", "as=a+b", "as=%25h", &too_long,
        ] {
            let path = format!("/api/machines/fixture/owner/terminal?{query}");
            let status = handshake(authoriser.clone(), &path, &cookie).await;
            assert!(status.starts_with("HTTP/1.1 400"), "{query}: {status}");
        }
        let status = handshake(
            authoriser,
            "/api/machines/-oProxyCommand=id/owner/terminal?as=owner",
            &cookie,
        )
        .await;
        assert!(status.starts_with("HTTP/1.1 400"), "{status}");
    }

    /// **Q5 on the route a sudo password is typed into.** As the one-off test
    /// above: a real `ssh` to a name that cannot resolve, whose printed and
    /// typed bytes reach no log line. The password half is
    /// `yantra-core/tests/owner_terminal.rs`'s.
    #[tokio::test]
    async fn the_owner_terminal_logs_its_lifecycle_and_never_its_stream() {
        let capture = Capture::default();
        let writer = capture.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .with_writer(move || writer.clone())
            .finish();
        let _logging = tracing::subscriber::set_default(subscriber);

        let (authoriser, cookie) = signed_in();
        let mut socket = upgraded_at(
            authoriser,
            Left::default(),
            "/api/machines/nowhere.invalid/owner/terminal?as=owner",
            &cookie,
        )
        .await;
        send(&mut socket, TEXT, WINDOW.as_bytes()).await;
        send(&mut socket, BINARY, b"typed-as-keystrokes\r").await;

        let mut printed = Vec::new();
        let exit = loop {
            let (opcode, payload) = timeout(Duration::from_secs(30), frame(&mut socket))
                .await
                .expect("the terminal ends")
                .expect("a frame");
            match opcode {
                PING => pong(&mut socket).await,
                BINARY => printed.extend_from_slice(&payload),
                _ => {
                    assert_eq!(opcode, TEXT, "the terminal ends on its exit frame");
                    break String::from_utf8_lossy(&payload).into_owned();
                }
            }
        };
        assert_eq!(exit, r#"{"exit":255}"#, "ssh's own status");

        let printed = String::from_utf8_lossy(&printed).into_owned();
        let logged = String::from_utf8_lossy(&capture.0.lock().expect("the log")).into_owned();
        assert!(
            logged.contains("owner terminal as owner on nowhere.invalid"),
            "{logged}"
        );
        assert!(logged.contains("exited 255"), "{logged}");
        assert!(
            !logged.contains("typed-as-keystrokes"),
            "what was typed was logged: {logged}"
        );
        let line = printed
            .lines()
            .find(|line| line.contains("nowhere.invalid"))
            .unwrap_or_default()
            .trim();
        assert!(
            !line.is_empty() && !logged.contains(line),
            "what was printed was logged: {logged}"
        );
    }

    /// Two numbers and a name, and nothing else. A typo that silently opened an
    /// 80x24 terminal would look like a browser that cannot measure itself, and
    /// one that silently fell back would look like a terminal that lost colour.
    #[test]
    fn a_window_is_two_numbers_and_the_terminal_the_caller_is() {
        let size: Size = serde_json::from_str(r#"{"rows":40,"cols":120,"term":"xterm-256color"}"#)
            .expect("a window");
        assert_eq!(
            pty::Size::from(&size),
            pty::Size {
                rows: 40,
                cols: 120
            }
        );
        assert_eq!(size.term, "xterm-256color");

        serde_json::from_str::<Size>(r#"{"rows":40,"term":"xterm-256color"}"#)
            .expect_err("a window has two sides");
        serde_json::from_str::<Size>(r#"{"rows":40,"cols":120}"#)
            .expect_err("a caller that does not say what it is");
        serde_json::from_str::<Size>(r#"{"rows":40,"cols":120,"term":"xterm","font":"mono"}"#)
            .expect_err("a field this seam does not carry");
    }
}
