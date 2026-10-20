//! `/api/mcp`: the room tools over MCP's Streamable HTTP transport
//! ([ADR-0038](../../../docs/adr/0038-rooms-and-guest-devices.md) decision 2),
//! and `POST /api/rooms/{room}/resume` (decision 4).
//!
//! **A small subset, on purpose**: POST with one JSON-RPC message and a JSON
//! answer. A notification or a response gets `202` and no body, a batch is
//! refused because 2025-06-18 removed it, and `GET`, the optional event stream,
//! is `405`. No session id is issued.
//!
//! **Every request passes [`allowed`] first**, so only the owner's own untagged
//! nodes reach a room in this row. The label comes from identity and never
//! from the body: the caller's machine is `whois` joined to the tailnet list on
//! the stable id, as `/api/join` does. `X-Yantra-Thread` only routes, and only
//! when the workspace it names is on the caller's machine.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{Value, json};
use tokio::sync::watch;
use yantra_core::inventory::Inventory;
use yantra_core::room::{self, Call, Reader, Thread};
use yantra_core::workspace;

use crate::room::Rooms;
use crate::write::{Authoriser, Refused, allowed};

const THREAD: &str = "x-yantra-thread";
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

/// Turns a workspace's name into its machine. A test names its own.
type Locate = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

#[derive(Clone)]
struct Served<I> {
    authoriser: Authoriser<I>,
    rooms: Rooms,
    locate: Locate,
    /// [`crate::heartbeat::Fleet::closing`].
    closing: watch::Sender<bool>,
}

pub fn router<I, S>(
    authoriser: Authoriser<I>,
    rooms: Rooms,
    closing: watch::Sender<bool>,
) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    let locate: Locate = Arc::new(|name| workspace::load(name).ok().map(|w| w.machine));
    routes(authoriser, rooms, locate, closing)
}

fn routes<I, S>(
    authoriser: Authoriser<I>,
    rooms: Rooms,
    locate: Locate,
    closing: watch::Sender<bool>,
) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/mcp", post(mcp::<I>).get(stream::<I>))
        .route("/rooms/{room}/resume", post(resume::<I>))
        .with_state(Served {
            authoriser,
            rooms,
            locate,
            closing,
        })
}

/// The spec lets a server refuse the event stream.
async fn stream<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Served<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Response, Refused> {
    allowed(&state.authoriser, from.ip(), &headers).await?;
    Ok((StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response())
}

async fn mcp<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Served<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return Ok(refused(&Value::Null, PARSE_ERROR, "Parse error"));
    };
    if message.is_array() {
        return Ok(refused(
            &Value::Null,
            INVALID_REQUEST,
            "MCP 2025-06-18 has no batches: send one message a request",
        ));
    }
    let id = message.get("id");
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        // A response to nothing this server asked.
        return Ok(
            if message.get("result").is_some() || message.get("error").is_some() {
                StatusCode::ACCEPTED.into_response()
            } else {
                refused(
                    id.unwrap_or(&Value::Null),
                    INVALID_REQUEST,
                    "Invalid Request",
                )
            },
        );
    };
    let Some(id) = id else {
        return Ok(StatusCode::ACCEPTED.into_response());
    };
    let params = message.get("params").unwrap_or(&Value::Null);
    let answer = match method {
        "initialize" => {
            let version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .and_then(|asked| {
                    room::PROTOCOL_VERSIONS
                        .into_iter()
                        .find(|known| *known == asked)
                })
                .unwrap_or(room::PROTOCOL_VERSIONS[0]);
            result(
                id,
                json!({"protocolVersion": version,
                       "capabilities": {"tools": {}},
                       "serverInfo": {"name": "yantrad", "version": env!("CARGO_PKG_VERSION")}}),
            )
        }
        "ping" => result(id, json!({})),
        "tools/list" => result(id, json!({"tools": room::tools()})),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let arguments = params.get("arguments").unwrap_or(&Value::Null);
            match room::call(name, arguments) {
                Err(why) => error(id, INVALID_PARAMS, &why),
                Ok(call) => {
                    let machine = machine_of(&state.authoriser, &caller.node).await?;
                    let thread = thread_of(&headers, &machine, &state.locate);
                    let label = match &thread {
                        Some(thread) => format!("{machine} · chat {}", thread.thread),
                        None => machine,
                    };
                    let reader = Reader {
                        node: caller.node,
                        thread,
                    };
                    result(id, tool(&state, &reader, &label, call).await?)
                }
            }
        }
        _ => error(id, METHOD_NOT_FOUND, "Method not found"),
    };
    Ok(Json(answer).into_response())
}

async fn tool<I>(
    state: &Served<I>,
    reader: &Reader,
    label: &str,
    call: Call,
) -> Result<Value, Refused> {
    let said = match call {
        Call::Send { room, text } => state
            .rooms
            .send(reader, label, &room, &text)
            .map(|sent| json!({"seq": sent.seq, "delivered": sent.delivered}).to_string()),
        Call::Read { room, wait } => {
            let read = state
                .rooms
                .read(reader, &room, Duration::from_secs(wait), &state.closing)
                .await;
            match read {
                Ok(None) => {
                    return Err(Refused::Verb {
                        status: StatusCode::SERVICE_UNAVAILABLE,
                        said: "yantrad is shutting down; read again once it is back".to_owned(),
                    });
                }
                Ok(Some(messages)) if messages.is_empty() => {
                    Ok(format!("No new messages in room {room}."))
                }
                Ok(Some(messages)) => Ok(messages
                    .iter()
                    .map(|message| room::wrap(&room, message))
                    .collect::<Vec<_>>()
                    .join("\n\n")),
                Err(error) => Err(error),
            }
        }
    };
    let is_error = said.is_err();
    let text = said.unwrap_or_else(|error| error.to_string());
    Ok(json!({"content": [{"type": "text", "text": text}], "isError": is_error}))
}

/// I-5 and I-52: `whois` spells the stable id `StableID`, which is what
/// `status` calls `ID`, so the two join on it.
async fn machine_of<I: Inventory>(
    authoriser: &Authoriser<I>,
    node: &str,
) -> Result<String, Refused> {
    authoriser
        .inventory()
        .machines()
        .await
        .map_err(Refused::CannotAsk)?
        .into_iter()
        .find(|machine| machine.id == node)
        .map(|machine| machine.name)
        .ok_or_else(|| Refused::Verb {
            status: StatusCode::SERVICE_UNAVAILABLE,
            said: format!(
                "tailscale knows the caller as {node} but does not list it, so there is no machine name to label with"
            ),
        })
}

/// The header's thread, when its workspace is on the caller's machine.
fn thread_of(headers: &HeaderMap, machine: &str, locate: &Locate) -> Option<Thread> {
    let (workspace, thread) = headers.get(THREAD)?.to_str().ok()?.split_once('/')?;
    let usable = !thread.is_empty()
        && thread
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let on = locate(workspace)?;
    (usable && on.eq_ignore_ascii_case(machine)).then(|| Thread {
        workspace: workspace.to_owned(),
        thread: thread.to_owned(),
    })
}

async fn resume<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Served<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<StatusCode, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    state.rooms.resume(&name).map_err(|error| Refused::Verb {
        status: StatusCode::NOT_FOUND,
        said: error.to_string(),
    })?;
    tracing::info!("room {name}: resumed for {}", caller.node);
    Ok(StatusCode::NO_CONTENT)
}

fn result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn refused(id: &Value, code: i64, message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(error(id, code, message))).into_response()
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use crate::room::tests::{rooms, woken};
    use axum::body::Body;
    use axum::http::{Method, Request};
    use std::net::IpAddr;
    use tower::ServiceExt as _;
    use yantra_core::inventory::{self, Caller, Fake, MachineInfo, Os, Ownership};

    const ME: u64 = 1;
    const ALPHA: [u8; 4] = [100, 64, 0, 2];
    const BETA: [u8; 4] = [100, 64, 0, 3];
    const STRANGER: [u8; 4] = [100, 64, 0, 4];

    fn machine(id: &str, name: &str) -> MachineInfo {
        MachineInfo {
            id: id.to_owned(),
            name: name.to_owned(),
            dns_name: format!("{name}.example.ts.net."),
            os: Os::Linux,
            online: true,
            last_seen: None,
            expired: false,
            key_expires: None,
            addresses: Vec::new(),
            ownership: Ownership::Yours,
        }
    }

    fn caller(node: &str, user: u64) -> Caller {
        Caller {
            node: node.to_owned(),
            user,
            tags: Vec::new(),
        }
    }

    fn fake() -> Fake {
        Fake {
            machines: vec![machine("nALPHA", "alpha"), machine("nBETA", "beta")],
            addresses: Vec::new(),
            callers: [
                (IpAddr::from(ALPHA), caller("nALPHA", ME)),
                (IpAddr::from(BETA), caller("nBETA", ME)),
                (IpAddr::from(STRANGER), caller("nFRIEND", 7)),
            ]
            .into_iter()
            .collect(),
            owner: ME,
        }
    }

    /// `wa` is on alpha and `wb` on beta.
    fn locate() -> Locate {
        Arc::new(|name| match name {
            "wa" => Some("alpha".to_owned()),
            "wb" => Some("beta".to_owned()),
            _ => None,
        })
    }

    struct App {
        router: Router,
        woke: crate::room::tests::Woken,
        pauses: tokio::sync::mpsc::UnboundedReceiver<yantra_core::notify::Message>,
    }

    fn app() -> App {
        app_with(fake())
    }

    fn app_with<I: Inventory + Clone + Send + Sync + 'static>(inventory: I) -> App {
        let (rooms, woke, pauses) = rooms();
        App {
            router: routes(
                Authoriser::new(inventory, &[]),
                rooms,
                locate(),
                watch::Sender::new(false),
            ),
            woke,
            pauses,
        }
    }

    async fn send(
        app: &App,
        method: Method,
        path: &str,
        body: Option<Value>,
        from: [u8; 4],
        thread: Option<&str>,
    ) -> (StatusCode, String) {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(thread) = thread {
            request = request.header(THREAD, thread);
        }
        let mut request = request
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
            .expect("a request");
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((from, 61620))));
        let response = app
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("the router is infallible");
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("the body is in memory");
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    async fn rpc(app: &App, from: [u8; 4], thread: Option<&str>, body: Value) -> Value {
        let (status, said) = send(app, Method::POST, "/mcp", Some(body), from, thread).await;
        assert_eq!(status, StatusCode::OK, "{said}");
        serde_json::from_str(&said).expect("a JSON answer")
    }

    async fn tool(
        app: &App,
        from: [u8; 4],
        thread: Option<&str>,
        name: &str,
        args: Value,
    ) -> Value {
        let answer = rpc(
            app,
            from,
            thread,
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                   "params": {"name": name, "arguments": args}}),
        )
        .await;
        answer["result"].clone()
    }

    fn text(result: &Value) -> &str {
        result["content"][0]["text"].as_str().expect("a text block")
    }

    #[tokio::test]
    async fn the_handshake_echoes_the_version_lists_the_room_tools_and_takes_a_notification() {
        let app = app();
        let initialized = rpc(
            &app,
            ALPHA,
            None,
            json!({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                   "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                              "clientInfo": {"name": "claude-code", "version": "2"}}}),
        )
        .await;
        assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(initialized["result"]["capabilities"], json!({"tools": {}}));

        let (status, said) = send(
            &app,
            Method::POST,
            "/mcp",
            Some(json!({"jsonrpc": "2.0", "method": "notifications/initialized"})),
            ALPHA,
            None,
        )
        .await;
        assert_eq!((status, said.as_str()), (StatusCode::ACCEPTED, ""));

        let listed = rpc(
            &app,
            ALPHA,
            None,
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        )
        .await;
        assert_eq!(listed["result"]["tools"], room::tools());
        let pinged = rpc(
            &app,
            ALPHA,
            None,
            json!({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
        )
        .await;
        assert_eq!(pinged["result"], json!({}));
    }

    #[tokio::test]
    async fn get_is_405_a_batch_is_refused_and_an_unknown_method_is_named() {
        let app = app();
        let (status, _) = send(&app, Method::GET, "/mcp", None, ALPHA, None).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);

        let (status, said) = send(
            &app,
            Method::POST,
            "/mcp",
            Some(json!([{"jsonrpc": "2.0", "id": 1, "method": "ping"}])),
            ALPHA,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
        assert!(said.contains("no batches"), "{said}");

        let unknown = rpc(
            &app,
            ALPHA,
            None,
            json!({"jsonrpc": "2.0", "id": 4, "method": "resources/list"}),
        )
        .await;
        assert_eq!(unknown["error"]["code"], METHOD_NOT_FOUND);
        let bad = rpc(
            &app,
            ALPHA,
            None,
            json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                   "params": {"name": "room_read", "arguments": {"room": "R1"}}}),
        )
        .await;
        assert_eq!(bad["error"]["code"], INVALID_PARAMS);
    }

    #[tokio::test]
    async fn a_foreign_user_is_403_and_a_tailscale_that_cannot_answer_is_503() {
        let app = app();
        for (method, path) in [
            (Method::POST, "/mcp"),
            (Method::GET, "/mcp"),
            (Method::POST, "/rooms/r1/resume"),
        ] {
            let (status, said) = send(
                &app,
                method,
                path,
                Some(json!({"jsonrpc": "2.0", "id": 0, "method": "ping"})),
                STRANGER,
                None,
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {said}");
        }

        #[derive(Clone)]
        struct Down;
        impl Inventory for Down {
            async fn machines(&self) -> Result<Vec<MachineInfo>, inventory::Error> {
                unreachable!("no caller was established")
            }
            async fn addresses(&self) -> Result<Vec<IpAddr>, inventory::Error> {
                Ok(Vec::new())
            }
            async fn whois(&self, _: IpAddr) -> Result<Option<Caller>, inventory::Error> {
                Err(inventory::Error::Command {
                    stderr: "failed to connect to local tailscaled".into(),
                })
            }
            async fn owner(&self) -> Result<u64, inventory::Error> {
                Ok(ME)
            }
        }
        let down = app_with(Down);
        let (status, _) = send(
            &down,
            Method::POST,
            "/mcp",
            Some(json!({"jsonrpc": "2.0", "id": 0, "method": "ping"})),
            ALPHA,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    /// The label is the caller's machine and the header's thread, and a send
    /// wakes the other member's thread with the message wrapped.
    #[tokio::test]
    async fn a_send_is_labelled_from_identity_and_wakes_the_other_thread() {
        let app = app();
        let joined = tool(
            &app,
            BETA,
            Some("wb/B2"),
            "room_read",
            json!({"room": "r1"}),
        )
        .await;
        assert_eq!(text(&joined), "No new messages in room r1.");

        let sent = tool(
            &app,
            ALPHA,
            Some("wa/A1"),
            "room_send",
            json!({"room": "r1", "text": "hi", "from": "the owner"}),
        )
        .await;
        assert_eq!(sent["isError"], false, "{sent}");
        assert_eq!(
            serde_json::from_str::<Value>(text(&sent)).expect("JSON"),
            json!({"seq": 1, "delivered": 1})
        );
        let woke = woken(&app.woke);
        assert_eq!(woke.len(), 1);
        assert_eq!(
            woke[0].0,
            Thread {
                workspace: "wb".to_owned(),
                thread: "B2".to_owned()
            }
        );
        assert!(
            woke[0].1.starts_with(
                "<room name=\"r1\" from=\"alpha · chat A1\" seq=\"1\" budget=\"1/20\">\nhi\n"
            ),
            "{}",
            woke[0].1
        );

        let back = tool(
            &app,
            BETA,
            Some("wb/B2"),
            "room_send",
            json!({"room": "r1", "text": "ok"}),
        )
        .await;
        assert_eq!(back["isError"], false, "{back}");
        let woke = woken(&app.woke);
        assert_eq!(woke.len(), 2, "{woke:?}");
        assert_eq!(
            woke[1].0,
            Thread {
                workspace: "wa".to_owned(),
                thread: "A1".to_owned()
            }
        );
        assert!(
            woke[1].1.contains("from=\"beta · chat B2\" seq=\"2\""),
            "{}",
            woke[1].1
        );
        assert!(!woke[1].1.contains("hi"), "not its own: {}", woke[1].1);
        let read = tool(
            &app,
            ALPHA,
            Some("wa/A1"),
            "room_read",
            json!({"room": "r1"}),
        )
        .await;
        assert_eq!(
            text(&read),
            "No new messages in room r1.",
            "the wake delivered it once"
        );
    }

    #[tokio::test]
    async fn the_header_is_ignored_for_a_thread_on_another_node() {
        let app = app();
        for header in ["wa/A1", "nosuch/A1", "wb/../x", "wb", "wb/"] {
            let joined = tool(&app, BETA, Some(header), "room_read", json!({"room": "r1"})).await;
            assert_eq!(joined["isError"], false, "{header}");
        }
        let sent = tool(
            &app,
            ALPHA,
            Some("wb/B2"),
            "room_send",
            json!({"room": "r1", "text": "hi"}),
        )
        .await;
        assert_eq!(sent["isError"], false, "{sent}");
        assert!(
            woken(&app.woke).is_empty(),
            "beta reads as a node, so nothing wakes"
        );
        let read = tool(&app, BETA, None, "room_read", json!({"room": "r1"})).await;
        assert!(
            text(&read).contains("from=\"alpha\" seq=\"1\""),
            "no thread in the label: {read}"
        );
    }

    #[tokio::test]
    async fn a_room_pauses_once_at_its_budget_and_resume_lifts_it() {
        let mut app = app();
        for n in 1..=room::BUDGET {
            let sent = tool(
                &app,
                ALPHA,
                None,
                "room_send",
                json!({"room": "r2", "text": format!("secret {n}")}),
            )
            .await;
            assert_eq!(sent["isError"], false, "{n}: {sent}");
        }
        let refused = tool(
            &app,
            ALPHA,
            None,
            "room_send",
            json!({"room": "r2", "text": "more"}),
        )
        .await;
        assert_eq!(refused["isError"], true);
        assert_eq!(text(&refused), "room r2 is paused, waiting for the owner");

        let told = app.pauses.try_recv().expect("one notification");
        assert!(
            told.body.contains("r2") && !told.body.contains("secret"),
            "{}",
            told.body
        );
        assert!(app.pauses.try_recv().is_err(), "only one");

        let (status, _) = send(&app, Method::POST, "/rooms/nope/resume", None, ALPHA, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, said) = send(&app, Method::POST, "/rooms/r2/resume", None, ALPHA, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{said}");
        let sent = tool(
            &app,
            ALPHA,
            None,
            "room_send",
            json!({"room": "r2", "text": "again"}),
        )
        .await;
        assert_eq!(sent["isError"], false, "{sent}");
    }
}
