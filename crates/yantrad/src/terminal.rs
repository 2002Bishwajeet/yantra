//! `GET /api/workspaces/{name}/terminal` — [`yantra_core::pty::Terminal`] on a
//! WebSocket.
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
//! debug. The lifecycle is logged; the payload never is.
//!
//! The frames need no envelope, because the protocol already carries two kinds.
//! **Binary is terminal bytes**, in both directions. **Text is control**: from
//! the browser it is always a [`Size`], which must arrive before anything else
//! because a pty is opened with a window and a terminal, and nothing else tells
//! the daemon how big a browser is or which one it is; from the daemon it is the
//! reason a terminal could not be opened, which a close frame cannot carry —
//! that reason is capped at 123 bytes and an ssh diagnosis is longer.
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

use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use tokio::time::MissedTickBehavior;
use yantra_core::inventory::Inventory;
use yantra_core::pty;

use crate::write::{Authoriser, Refused, allowed, chain};

/// Long enough that a socket nobody is typing at costs one frame a browser
/// answers in microseconds; short enough that what a vanished peer holds is
/// bounded well under the kernel's own retransmission budget.
#[cfg(not(test))]
const PING_EVERY: Duration = Duration::from_secs(20);
#[cfg(test)]
const PING_EVERY: Duration = Duration::from_millis(200);

/// One unanswered ping is a phone whose radio slept or a busy main thread; two
/// in a row is a peer that is not there.
const MISSES: u8 = 2;

pub fn router<I, S>(authoriser: Authoriser<I>) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/workspaces/{name}/terminal", get(attach::<I>))
        .with_state(authoriser)
}

async fn attach<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    tracing::info!("terminal {name} for {}", caller.node);

    Ok(upgrade.on_upgrade(move |socket| bridge(socket, name)))
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

async fn bridge(mut socket: WebSocket, name: String) {
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
                    tracing::warn!("terminal {name} stopped accepting input: {error}");
                    break;
                }
            }
            Either::Typed(Some(Ok(Message::Text(text)))) => {
                if !control(&mut socket, &mut terminal, &name, &text).await {
                    break;
                }
            }
            Either::Typed(Some(Ok(Message::Pong(_)))) => unanswered = 0,
            // An inbound ping is still axum's to answer.
            Either::Typed(Some(Ok(_))) => {}
            Either::Quiet => {
                if unanswered >= MISSES {
                    tracing::info!("terminal {name} answered no ping");
                    break;
                }
                unanswered += 1;
                if socket.send(Message::Ping(Bytes::new())).await.is_err() {
                    break;
                }
            }
            Either::Printed(None) | Either::Typed(None | Some(Err(_))) => break,
        }
    }
    tracing::info!("terminal {name} ended");
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
    name: &str,
    text: &str,
) -> bool {
    if let Some(open) = terminal.as_ref() {
        resize(open, name, text);
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

    match pty::open(name, &size.term, (&size).into()).await {
        Ok(open) => {
            *terminal = Some(open);
            true
        }
        Err(error) => {
            let said = chain(&error);
            tracing::warn!("no terminal for {name}: {said}");
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
fn resize(terminal: &pty::Terminal, name: &str, text: &str) {
    match serde_json::from_str::<Size>(text) {
        Ok(size) => {
            if let Err(error) = terminal.resize((&size).into()) {
                tracing::warn!("terminal {name}: {error}");
            }
        }
        Err(_) => tracing::warn!("terminal {name} was sent a control frame that is not a size"),
    }
}

/// The one shape on this seam that the *browser* writes, for the check in
/// [`crate::contract`].
#[cfg(test)]
#[allow(clippy::expect_used)]
pub(crate) fn answers() -> Vec<(&'static str, &'static str, serde_json::Value)> {
    vec![(
        "terminalSize",
        "TerminalSize",
        serde_json::to_value(Size {
            rows: 40,
            cols: 120,
            term: "xterm-256color".to_owned(),
        })
        .expect("two numbers and a name"),
    )]
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::net::{IpAddr, Ipv4Addr};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::time::timeout;
    use yantra_core::inventory::{Caller, Fake};

    const ME: u64 = 1;

    const LOCAL: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

    const PING: u8 = 0x9;

    fn tailnet(callers: Vec<(IpAddr, Caller)>) -> Fake {
        Fake {
            machines: Vec::new(),
            addresses: Vec::new(),
            callers: callers.into_iter().collect::<BTreeMap<_, _>>(),
            owner: ME,
        }
    }

    /// Bound to nothing, so the loopback peer is never ours and no header is
    /// read — the direct port, which is what these tests stood on before
    /// ADR-0017.
    fn direct(caller: Option<Caller>) -> Authoriser<Fake> {
        Authoriser::new(
            tailnet(caller.map(|caller| (LOCAL, caller)).into_iter().collect()),
            &[],
        )
    }

    /// A real listener, because `oneshot` never gives axum the upgrade it
    /// extracts: the peer address a refusal turns on is the one the kernel
    /// reports, so the tailnet is faked at loopback rather than at 100.64/10.
    async fn connect(authoriser: Authoriser<Fake>, forwarded: &str) -> BufReader<TcpStream> {
        let app = Router::new().nest("/api", router(authoriser));

        let listener = TcpListener::bind((LOCAL, 0)).await.expect("a free port");
        let address = listener.local_addr().expect("it is bound");
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });

        let mut stream = TcpStream::connect(address).await.expect("the daemon is up");
        stream
            .write_all(
                format!(
                    "GET /api/workspaces/api/terminal HTTP/1.1\r\n\
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

    async fn handshake(authoriser: Authoriser<Fake>, forwarded: &str) -> String {
        let mut status = String::new();
        connect(authoriser, forwarded)
            .await
            .read_line(&mut status)
            .await
            .expect("an HTTP response");
        status
    }

    /// Past the handshake and onto the frames, which is where a ping is.
    async fn upgraded(authoriser: Authoriser<Fake>) -> BufReader<TcpStream> {
        let mut socket = connect(authoriser, "").await;
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

    /// Server frames are unmasked, and nothing the daemon sends before a pty
    /// exists is longer than a control frame may be, so the header is two bytes.
    async fn frame(socket: &mut BufReader<TcpStream>) -> std::io::Result<(u8, Vec<u8>)> {
        let mut head = [0u8; 2];
        socket.read_exact(&mut head).await?;
        let mut payload = vec![0u8; usize::from(head[1] & 0x7f)];
        socket.read_exact(&mut payload).await?;
        Ok((head[0] & 0x0f, payload))
    }

    /// A client frame must be masked or the far side is entitled to drop the
    /// socket, which would prove liveness detection works by breaking it.
    async fn pong(socket: &mut BufReader<TcpStream>) {
        socket
            .get_mut()
            .write_all(&[0x8a, 0x80, 0, 0, 0, 0])
            .await
            .expect("a pong is written");
    }

    fn caller(user: u64, tags: &[&str]) -> Caller {
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
            let status = handshake(direct(Some(refused)), "").await;
            assert!(status.starts_with("HTTP/1.1 403"), "{status}");
        }
        let stranger = handshake(direct(None), "").await;
        assert!(stranger.starts_with("HTTP/1.1 403"), "{stranger}");
    }

    /// The other half, so the refusal above cannot pass by refusing everyone.
    /// Nothing opens here — the pty waits for a size that never arrives.
    #[tokio::test]
    async fn this_owners_untagged_node_is_upgraded() {
        let status = handshake(direct(Some(caller(ME, &[]))), "").await;
        assert!(status.starts_with("HTTP/1.1 101"), "{status}");
    }

    /// **ADR-0017 on the route that hands over a shell.** Loopback is declared
    /// as what this daemon bound, which is the only way a test can stand where
    /// `tailscale serve` stands: the peer is then ours, and the header names a
    /// tagged node the proxy would otherwise have laundered into the owner's.
    #[tokio::test]
    async fn a_forwarded_tagged_node_is_not_upgraded_even_though_the_peer_is_ours() {
        let tagged: IpAddr = "100.64.0.4".parse().expect("v4");
        let ours = || {
            Authoriser::new(
                tailnet(vec![
                    (LOCAL, caller(ME, &[])),
                    (tagged, caller(ME, &["tag:ci"])),
                ]),
                &[SocketAddr::new(LOCAL, 7717)],
            )
        };

        let refused = handshake(ours(), "X-Forwarded-For: 100.64.0.4\r\n").await;
        assert!(refused.starts_with("HTTP/1.1 403"), "{refused}");

        // The proxy's own node still opens one, so the refusal above is the
        // forwarded address being read rather than the hop being distrusted.
        let unproxied = handshake(ours(), "").await;
        assert!(unproxied.starts_with("HTTP/1.1 101"), "{unproxied}");
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
