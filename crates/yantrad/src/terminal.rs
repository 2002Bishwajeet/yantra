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

use std::net::SocketAddr;

use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::response::Response;
use axum::routing::get;
use yantra_core::inventory::Inventory;
use yantra_core::pty;

use crate::write::{Refused, allowed, chain};

pub fn router<I, S>(inventory: I) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/workspaces/{name}/terminal", get(attach::<I>))
        .with_state(inventory)
}

async fn attach<I: Inventory + Clone + Send + Sync + 'static>(
    State(inventory): State<I>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    Path(name): Path<String>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, Refused> {
    let caller = allowed(&inventory, from.ip()).await?;
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
    let Some(first) = first_size(&mut socket).await else {
        return;
    };

    let mut terminal = match pty::open(&name, &first.term, (&first).into()).await {
        Ok(terminal) => terminal,
        Err(error) => {
            let said = chain(&error);
            tracing::warn!("no terminal for {name}: {said}");
            let _ = socket.send(Message::Text(said.into())).await;
            return;
        }
    };

    loop {
        // The arms carry the event out rather than handling it, so the borrows
        // `select!` holds end before either side is touched again.
        let event = tokio::select! {
            printed = terminal.read() => Either::Printed(printed),
            typed = socket.recv() => Either::Typed(typed),
        };

        match event {
            Either::Printed(Some(bytes)) => {
                if socket.send(Message::Binary(bytes.into())).await.is_err() {
                    break;
                }
            }
            Either::Typed(Some(Ok(Message::Binary(bytes)))) => {
                if let Err(error) = terminal.write(bytes.into()).await {
                    tracing::warn!("terminal {name} stopped accepting input: {error}");
                    break;
                }
            }
            Either::Typed(Some(Ok(Message::Text(text)))) => resize(&terminal, &name, &text),
            // Ping and pong are axum's to answer.
            Either::Typed(Some(Ok(_))) => {}
            Either::Printed(None) | Either::Typed(None | Some(Err(_))) => break,
        }
    }
    tracing::info!("terminal {name} ended");
}

enum Either {
    Printed(Option<Vec<u8>>),
    Typed(Option<Result<Message, axum::Error>>),
}

/// A pty is opened with a window, so the first control frame is what starts the
/// terminal rather than what resizes it.
async fn first_size(socket: &mut WebSocket) -> Option<Size> {
    while let Some(Ok(message)) = socket.recv().await {
        if let Message::Text(text) = message {
            return match serde_json::from_str::<Size>(&text) {
                Ok(size) => Some(size),
                Err(_) => {
                    let _ = socket
                        .send(Message::Text(
                            "a terminal opens with {\"rows\":…,\"cols\":…,\"term\":…}".into(),
                        ))
                        .await;
                    None
                }
            };
        }
    }
    None
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
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, TcpStream};
    use yantra_core::inventory::{Caller, Fake};

    const ME: u64 = 1;

    /// A real listener, because `oneshot` never gives axum the upgrade it
    /// extracts: the peer address a refusal turns on is the one the kernel
    /// reports, so the tailnet is faked at loopback rather than at 100.64/10.
    async fn handshake(caller: Option<Caller>) -> String {
        let local = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let fake = Fake {
            machines: Vec::new(),
            addresses: Vec::new(),
            callers: caller
                .map(|caller| (local, caller))
                .into_iter()
                .collect::<BTreeMap<_, _>>(),
            owner: ME,
        };
        let app = Router::new().nest("/api", router(fake));

        let listener = TcpListener::bind((local, 0)).await.expect("a free port");
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
                b"GET /api/workspaces/api/terminal HTTP/1.1\r\n\
                  Host: yantra\r\n\
                  Connection: Upgrade\r\n\
                  Upgrade: websocket\r\n\
                  Sec-WebSocket-Version: 13\r\n\
                  Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            )
            .await
            .expect("the request is written");

        let mut status = String::new();
        BufReader::new(stream)
            .read_line(&mut status)
            .await
            .expect("an HTTP response");
        status
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
            let status = handshake(Some(refused)).await;
            assert!(status.starts_with("HTTP/1.1 403"), "{status}");
        }
        let stranger = handshake(None).await;
        assert!(stranger.starts_with("HTTP/1.1 403"), "{stranger}");
    }

    /// The other half, so the refusal above cannot pass by refusing everyone.
    /// Nothing opens here — the pty waits for a size that never arrives.
    #[tokio::test]
    async fn this_owners_untagged_node_is_upgraded() {
        let status = handshake(Some(caller(ME, &[]))).await;
        assert!(status.starts_with("HTTP/1.1 101"), "{status}");
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
