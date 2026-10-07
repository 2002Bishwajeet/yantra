//! `GET /api/machines/{machine}/mic` — the dashboard's push-to-talk, carried
//! into [`yantra_core::mic`]'s `pw-cat` on the machine ([ADR-0031] §5–6).
//!
//! **The mic is a write**, so [`crate::write::allowed`] is called by name
//! before the upgrade, as on every terminal route (ADR-0016). The name then
//! reaches `ssh`'s argv, so it is checked before the upgrade too (I-63).
//!
//! **Binary frames are audio** — 16 kHz mono s16le, copied to `pw-cat`'s
//! stdin as they arrive, with no pty and no buffer beyond the pipe. A text
//! frame from the browser carries nothing and is ignored. From the daemon a
//! text frame is the reason the microphone stopped, followed by a close: the
//! terminal routes' protocol.
//!
//! **The socket's end is the button's release.** Closing it closes stdin, and
//! that ends `pw-cat` (§6). The ping is the terminal's, for the same reason: a
//! phone that vanished mid-press would otherwise hold `pw-cat` open.
//!
//! **No audio byte is ever logged** (Q5, §5): not a byte and not a count. The
//! lifecycle is logged, and the reason a stream stopped.
//!
//! [ADR-0031]: ../../../docs/adr/0031-the-microphone-reaches-a-machine-as-a-virtual-source.md

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::get;
use tokio::time::MissedTickBehavior;
use yantra_core::install;
use yantra_core::inventory::Inventory;
use yantra_core::mic::{self, Stream};

use crate::terminal::{MISSES, PING_EVERY};
use crate::write::{Authoriser, Refused, allowed, chain};

/// What starts the writer for a machine: [`mic::open_at`], or a pipe in a test.
type Open = Arc<dyn Fn(&str) -> Result<Stream, mic::Error> + Send + Sync>;

#[derive(Clone)]
struct Mic<I> {
    authoriser: Authoriser<I>,
    open: Open,
}

pub fn router<I, S>(authoriser: Authoriser<I>) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    router_with(authoriser, Arc::new(mic::open_at))
}

fn router_with<I, S>(authoriser: Authoriser<I>, open: Open) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/machines/{machine}/mic", get(talk::<I>))
        .with_state(Mic { authoriser, open })
}

async fn talk<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Mic<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(machine): Path<String>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    install::check_machine(&machine).map_err(|error| Refused::Verb {
        status: StatusCode::BAD_REQUEST,
        said: error.to_string(),
    })?;
    tracing::info!("mic on {machine} for {}", caller.node);

    Ok(upgrade.on_upgrade(move |socket| async move {
        // At once, so the pipe holds the first frames while ssh connects.
        let opened = (state.open)(&machine);
        bridge(socket, &machine, opened).await;
    }))
}

enum Heard {
    Socket(Option<Result<Message, axum::Error>>),
    Stopped,
    Quiet,
}

/// How a press ended: the person let go, or the writer did.
enum End {
    Released,
    Failed(mic::Error),
}

async fn bridge(mut socket: WebSocket, machine: &str, opened: Result<Stream, mic::Error>) {
    let mut stream = match opened {
        Ok(stream) => stream,
        Err(error) => return refuse(&mut socket, machine, &error).await,
    };
    let mut unanswered = 0u8;
    let mut pings = tokio::time::interval(PING_EVERY);
    pings.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let end = loop {
        let heard = tokio::select! {
            message = socket.recv() => Heard::Socket(message),
            () = stream.stopped() => Heard::Stopped,
            _ = pings.tick() => Heard::Quiet,
        };
        match heard {
            Heard::Socket(Some(Ok(Message::Binary(audio)))) => {
                if let Err(error) = stream.write(&audio).await {
                    break End::Failed(error);
                }
            }
            Heard::Socket(Some(Ok(Message::Pong(_)))) => unanswered = 0,
            Heard::Socket(None | Some(Err(_) | Ok(Message::Close(_)))) => break End::Released,
            // Text carries nothing, and an inbound ping is axum's to answer.
            Heard::Socket(Some(Ok(_))) => {}
            Heard::Stopped => break End::Failed(mic::Error::Ended),
            Heard::Quiet => {
                if unanswered >= MISSES {
                    tracing::info!("mic on {machine} answered no ping");
                    break End::Released;
                }
                unanswered += 1;
                if socket.send(Message::Ping(Bytes::new())).await.is_err() {
                    break End::Released;
                }
            }
        }
    };

    match end {
        End::Released => match stream.close().await {
            Ok(()) => tracing::info!("mic on {machine} ended"),
            Err(error) => tracing::warn!("mic on {machine} ended: {}", chain(&error)),
        },
        // The exit status and stderr say more than the broken pipe did.
        End::Failed(error) => {
            let error = stream.close().await.err().unwrap_or(error);
            refuse(&mut socket, machine, &error).await;
        }
    }
}

/// The reason as one text frame, then a close: a close frame's reason is
/// capped at 123 bytes, and an ssh diagnosis is longer.
async fn refuse(socket: &mut WebSocket, machine: &str, error: &mic::Error) {
    let said = chain(error);
    tracing::warn!("mic on {machine} stopped: {said}");
    let _ = socket.send(Message::Text(said.into())).await;
    let _ = socket.send(Message::Close(None)).await;
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use std::net::IpAddr;
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader, DuplexStream};
    use tokio::net::TcpStream;
    use tokio::time::timeout;
    use yantra_core::inventory::Fake;

    use crate::terminal::tests::{
        BINARY, Capture, LOCAL, ME, PING, TEXT, caller, connect_to, direct, frame, pong, send,
        tailnet,
    };

    const MIC: &str = "/api/machines/fixture/mic";
    const CLOSE: u8 = 0x8;

    fn real(authoriser: Authoriser<Fake>) -> Router {
        router(authoriser)
    }

    /// A route whose writer is one end of a pipe, and the other end to read.
    fn piped(authoriser: Authoriser<Fake>) -> (Router, DuplexStream) {
        let (writer, reader) = tokio::io::duplex(64 * 1024);
        let writer = Mutex::new(Some(writer));
        let open: Open = Arc::new(move |_: &str| {
            let writer = writer.lock().expect("the pipe").take().expect("one press");
            Ok(Stream::over(writer))
        });
        (router_with(authoriser, open), reader)
    }

    async fn status(api: Router, path: &str, forwarded: &str) -> String {
        let mut line = String::new();
        connect_to(api, path, forwarded)
            .await
            .read_line(&mut line)
            .await
            .expect("an HTTP response");
        line
    }

    async fn upgraded(api: Router, path: &str) -> BufReader<TcpStream> {
        let mut socket = connect_to(api, path, "").await;
        let mut line = String::new();
        loop {
            line.clear();
            let read = socket.read_line(&mut line).await.expect("a header");
            assert!(read > 0, "the response ended before its headers did");
            assert!(!line.starts_with("HTTP/1.1 4"), "{line}");
            if line == "\r\n" {
                return socket;
            }
        }
    }

    /// Frames the daemon sends until a close, answering its pings.
    async fn until_closed(socket: &mut BufReader<TcpStream>) -> Vec<(u8, Vec<u8>)> {
        let mut seen = Vec::new();
        loop {
            let (opcode, payload) = timeout(Duration::from_secs(30), frame(socket))
                .await
                .expect("the daemon ends the socket")
                .expect("a frame");
            match opcode {
                PING => pong(socket).await,
                CLOSE => return seen,
                _ => seen.push((opcode, payload)),
            }
        }
    }

    /// The mic is a write: a `GET` that reached `pw-cat` without ADR-0016's
    /// check would be a microphone for anyone the bind address admits.
    #[tokio::test]
    async fn a_caller_who_is_not_the_owner_is_not_upgraded() {
        for refused in [caller(ME + 1, &[]), caller(ME, &["tag:ci"])] {
            let said = status(real(direct(Some(refused))), MIC, "").await;
            assert!(said.starts_with("HTTP/1.1 403"), "{said}");
        }
        let stranger = status(real(direct(None)), MIC, "").await;
        assert!(stranger.starts_with("HTTP/1.1 403"), "{stranger}");

        let (api, _reader) = piped(direct(Some(caller(ME, &[]))));
        let owner = status(api, MIC, "").await;
        assert!(owner.starts_with("HTTP/1.1 101"), "{owner}");
    }

    /// ADR-0017: the proxy's own address is ours, so the forwarded header is
    /// what names the caller, and here it names a tagged node.
    #[tokio::test]
    async fn a_forwarded_tagged_node_is_not_upgraded() {
        let tagged: IpAddr = "100.64.0.4".parse().expect("v4");
        let ours = Authoriser::new(
            tailnet(vec![
                (LOCAL, caller(ME, &[])),
                (tagged, caller(ME, &["tag:ci"])),
            ]),
            &[SocketAddr::new(LOCAL, 7717)],
        );
        let said = status(real(ours), MIC, "X-Forwarded-For: 100.64.0.4\r\n").await;
        assert!(said.starts_with("HTTP/1.1 403"), "{said}");
    }

    /// I-63: the name reaches `ssh`'s argv.
    #[tokio::test]
    async fn a_name_that_is_not_an_ssh_destination_is_refused_before_the_upgrade() {
        let said = status(
            real(direct(Some(caller(ME, &[])))),
            "/api/machines/-oProxyCommand=id/mic",
            "",
        )
        .await;
        assert!(said.starts_with("HTTP/1.1 400"), "{said}");
    }

    /// A real `ssh` to a name that cannot resolve exits at once, and the
    /// browser is told why before the close.
    #[tokio::test]
    async fn a_writer_that_could_not_start_is_one_text_frame_and_a_close() {
        let mut socket = upgraded(
            real(direct(Some(caller(ME, &[])))),
            "/api/machines/nowhere.invalid/mic",
        )
        .await;
        let seen = until_closed(&mut socket).await;
        assert_eq!(seen.len(), 1, "{seen:?}");
        let (opcode, said) = &seen[0];
        assert_eq!(*opcode, TEXT);
        let said = String::from_utf8_lossy(said);
        assert!(said.contains("exited with status 255"), "{said}");
        assert!(said.contains("nowhere.invalid"), "ssh's own words: {said}");
    }

    /// §5 and §6: each binary frame reaches the writer unchanged and in order,
    /// a text frame reaches nothing, and the client's close is the writer's EOF.
    #[tokio::test]
    async fn frames_reach_the_writer_unchanged_and_the_close_ends_it() {
        let (api, mut reader) = piped(direct(Some(caller(ME, &[]))));
        let mut socket = upgraded(api, MIC).await;
        let frames: Vec<Vec<u8>> = (0u8..5).map(|n| vec![n, 0xff, 0x00, n]).collect();
        for audio in &frames {
            send(&mut socket, BINARY, audio).await;
        }
        send(&mut socket, TEXT, b"ignored").await;
        send(&mut socket, CLOSE, &[]).await;

        let mut heard = Vec::new();
        timeout(Duration::from_secs(5), reader.read_to_end(&mut heard))
            .await
            .expect("the close gave the writer EOF")
            .expect("a read");
        assert_eq!(heard, frames.concat());
    }

    /// **Q5 on the route that carries a voice.** The lifecycle is logged; a
    /// byte of the stream never is.
    #[tokio::test]
    async fn the_mic_logs_its_lifecycle_and_never_its_stream() {
        let capture = Capture::default();
        let writer = capture.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .with_writer(move || writer.clone())
            .finish();
        let _logging = tracing::subscriber::set_default(subscriber);

        let (api, mut reader) = piped(direct(Some(caller(ME, &[]))));
        let mut socket = upgraded(api, MIC).await;
        send(&mut socket, BINARY, b"spoken-as-audio").await;
        send(&mut socket, CLOSE, &[]).await;
        let mut heard = Vec::new();
        timeout(Duration::from_secs(5), reader.read_to_end(&mut heard))
            .await
            .expect("EOF")
            .expect("a read");
        assert_eq!(heard, b"spoken-as-audio");
        // The ended line is written after the close; give the bridge its turn.
        for _ in 0..50 {
            if String::from_utf8_lossy(&capture.0.lock().expect("the log")).contains("ended") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let logged = String::from_utf8_lossy(&capture.0.lock().expect("the log")).into_owned();
        assert!(logged.contains("mic on fixture for nSOME"), "{logged}");
        assert!(logged.contains("mic on fixture ended"), "{logged}");
        assert!(
            !logged.contains("spoken-as-audio"),
            "audio was logged: {logged}"
        );
        assert!(!logged.contains("15 bytes"), "a count was logged: {logged}");
    }

    /// A pipe that `ssh` no longer drains is a reason and a close, not a
    /// bridge that stops pinging and never hears the release.
    #[tokio::test]
    async fn a_writer_that_stops_draining_is_one_text_frame_and_a_close() {
        let (writer, _undrained) = tokio::io::duplex(16);
        let writer = Mutex::new(Some(writer));
        let open: Open = Arc::new(move |_: &str| {
            let writer = writer.lock().expect("the pipe").take().expect("one press");
            Ok(Stream::over(writer))
        });
        let api = router_with(direct(Some(caller(ME, &[]))), open);
        let mut socket = upgraded(api, MIC).await;
        send(&mut socket, BINARY, &[0; 100]).await;

        let seen = until_closed(&mut socket).await;
        assert_eq!(seen.len(), 1, "{seen:?}");
        let (opcode, said) = &seen[0];
        assert_eq!(*opcode, TEXT);
        let said = String::from_utf8_lossy(said);
        assert!(said.contains("took no audio"), "{said}");
    }

    /// The terminal's ping, on the mic: a vanished phone does not hold
    /// `pw-cat` open, because its socket ends and that closes the writer.
    #[tokio::test]
    async fn a_peer_that_stops_answering_is_closed_and_its_writer_ended() {
        let (api, mut reader) = piped(direct(Some(caller(ME, &[]))));
        let mut socket = upgraded(api, MIC).await;
        let pinged = timeout(PING_EVERY * 8, async {
            let mut sent = 0u8;
            while let Ok((PING, _)) = frame(&mut socket).await {
                sent += 1;
            }
            sent
        })
        .await;
        assert_eq!(pinged.ok(), Some(MISSES));

        let mut heard = Vec::new();
        timeout(Duration::from_secs(5), reader.read_to_end(&mut heard))
            .await
            .expect("the writer got EOF")
            .expect("a read");
        assert!(heard.is_empty());
    }
}
