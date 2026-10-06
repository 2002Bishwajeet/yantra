//! `GET /api/workspaces/{name}/chat?thread=<id>` — a chat thread on a
//! WebSocket ([ADR-0026] decision 3).
//!
//! Each turn is one `claude -p` in the thread's own worktree
//! ([`yantra_core::claude`], [`yantra_core::thread`]). Without `?thread=` the
//! first turn opens a thread and the socket says so with `thread.started`;
//! with it, the socket replays what the transcript holds and continues there.
//! **There is no session-addressed form**: a thread is a worktree of a
//! workspace's repository, and a bare session names none.
//!
//! The browser sends three frames, `turn`, `answer` and `cancel`, and one turn
//! runs at a time. The daemon sends [`ThreadEvent`]s and one typed [`Failure`].
//! A socket that closes mid-turn cancels the turn; the worktree stays, as
//! `thread.rs` requires.
//!
//! **An upgrade is a `GET`**, so [`allowed`] is called by name before it, as
//! in [`crate::terminal`]. Q5 holds: the socket's lifecycle is logged, and not
//! one word of a prompt, a reply or a tool's output is.
//!
//! [ADR-0026]: ../../../docs/adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md

use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use axum::routing::get;
use serde::{Deserialize, Serialize};
use yantra_core::chat::{ContentDelta, Decision, Event, StreamKind, ThreadEvent};
use yantra_core::claude::{Events, Turn};
use yantra_core::inventory::Inventory;
use yantra_core::logs::{self, Who};
use yantra_core::ssh::{self, Ssh};
use yantra_core::thread::{self, Place};
use yantra_core::workspace::{self, Workspace};

use crate::write::{Authoriser, Refused, allowed, chain};

/// How many transcript records an attach replays.
const HISTORY: usize = 200;
/// How long a cancelled turn has to end by itself before its `ssh` is dropped.
const STOP_GRACE: Duration = Duration::from_secs(10);

pub fn router<I, S>(authoriser: Authoriser<I>) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/workspaces/{name}/chat", get(chat::<I>))
        .with_state(authoriser)
}

async fn chat<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
    uri: Uri,
    upgrade: WebSocketUpgrade,
) -> Result<Response, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    let thread = read_thread(&uri);
    tracing::info!("chat {name} for {}", caller.node);

    Ok(upgrade.on_upgrade(move |mut socket| async move {
        match Fleet::of(&name) {
            Ok(fleet) => converse(&fleet, &name, thread, &mut socket).await,
            Err(said) => {
                tracing::warn!("chat {name}: {said}");
                let _ = socket.say(&failure(Kind::Unreachable, said)).await;
            }
        }
        tracing::info!("chat {name} ended");
    }))
}

/// `?thread=`, read by hand as `terminal.rs` reads `?at=`. It is compared with
/// what git lists and never reaches a shell.
fn read_thread(uri: &Uri) -> Option<String> {
    uri.query()?
        .split('&')
        .find_map(|pair| pair.strip_prefix("thread="))
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

/// What a browser sends.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(tag = "type", rename_all = "camelCase")]
enum Frame {
    Turn {
        text: String,
    },
    Answer {
        #[serde(rename = "requestId")]
        request_id: String,
        decision: Decision,
    },
    Cancel,
}

/// The one frame the daemon sends that is not a [`ThreadEvent`].
#[derive(Debug, Serialize)]
struct Failure {
    #[serde(rename = "type")]
    tag: &'static str,
    kind: Kind,
    said: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Kind {
    /// `?thread=` names no thread of this workspace.
    UnknownThread,
    /// A turn is running, and one runs at a time.
    Busy,
    /// A frame this daemon cannot read, or an answer to nothing.
    BadFrame,
    /// The workspace, its machine or its `claude` could not be reached.
    Unreachable,
}

fn failure(kind: Kind, said: impl Into<String>) -> Failure {
    Failure {
        tag: "error",
        kind,
        said: said.into(),
    }
}

/// Where a conversation's turns run: a workspace's machine over ssh, or a
/// test's script. The four calls are the whole of what the socket asks.
trait Machine: Sync {
    async fn open(&self) -> Result<Place, String>;
    async fn find(&self, thread: &str) -> Result<Option<Place>, String>;
    async fn history(&self, place: &Place) -> Result<Vec<logs::Entry>, String>;
    fn start(&self, place: &Place, text: &str) -> Result<(Turn, Events), String>;
}

struct Fleet {
    workspace: Workspace,
    ssh: Ssh,
}

impl Fleet {
    fn of(name: &str) -> Result<Self, String> {
        let workspace = workspace::load(name).map_err(|error| chain(&error))?;
        let machine = ssh::machine_at(&workspace.machine)
            .ok_or("this daemon has no directory for its ssh sockets")?;
        let ssh = Ssh::new(machine).map_err(|error| chain(&error))?;
        Ok(Self { workspace, ssh })
    }
}

impl Machine for Fleet {
    async fn open(&self) -> Result<Place, String> {
        thread::open(&self.ssh, &self.workspace)
            .await
            .map_err(|error| chain(&error))
    }

    async fn find(&self, id: &str) -> Result<Option<Place>, String> {
        let places = thread::list(&self.ssh, &self.workspace)
            .await
            .map_err(|error| chain(&error))?;
        Ok(places.into_iter().find(|place| thread::name(place) == id))
    }

    async fn history(&self, place: &Place) -> Result<Vec<logs::Entry>, String> {
        match thread::logs(&self.ssh, place, None, HISTORY, 0).await {
            Ok(transcript) => Ok(transcript.entries),
            // A thread whose first turn never answered has nothing to replay.
            Err(logs::Error::NoTranscript { .. }) => Ok(Vec::new()),
            Err(error) => Err(chain(&error)),
        }
    }

    fn start(&self, place: &Place, text: &str) -> Result<(Turn, Events), String> {
        Turn::start(&self.ssh, place, text).map_err(|error| chain(&error))
    }
}

/// The browser's end of the socket. Only text frames carry anything; `None`
/// is a socket that closed or failed.
trait Peer {
    async fn hear(&mut self) -> Option<String>;
    async fn say_text(&mut self, text: String) -> bool;

    async fn say<T: Serialize + Sync>(&mut self, frame: &T) -> bool {
        match serde_json::to_string(frame) {
            Ok(text) => self.say_text(text).await,
            Err(_) => false,
        }
    }
}

impl Peer for WebSocket {
    async fn hear(&mut self) -> Option<String> {
        loop {
            match self.recv().await? {
                Ok(Message::Text(text)) => return Some(text.to_string()),
                Ok(Message::Close(_)) | Err(_) => return None,
                // A ping is still axum's to answer.
                Ok(_) => {}
            }
        }
    }

    async fn say_text(&mut self, text: String) -> bool {
        self.send(Message::Text(text.into())).await.is_ok()
    }
}

/// One socket, from the attach to the close.
async fn converse<M: Machine, P: Peer>(
    machine: &M,
    name: &str,
    thread: Option<String>,
    peer: &mut P,
) {
    let mut place = None;
    if let Some(id) = thread {
        match machine.find(&id).await {
            Ok(Some(found)) => {
                tracing::info!("chat {name} attached thread {id}");
                if !replay(machine, &found, peer).await {
                    return;
                }
                place = Some(found);
            }
            Ok(None) => {
                let said = format!("{name} has no chat thread {id}");
                let _ = peer.say(&failure(Kind::UnknownThread, said)).await;
                return;
            }
            Err(said) => {
                tracing::warn!("chat {name}: {said}");
                let _ = peer.say(&failure(Kind::Unreachable, said)).await;
                return;
            }
        }
    }

    let mut turn: Option<(Turn, Events)> = None;
    let mut sent = 0usize;
    loop {
        let step = tokio::select! {
            heard = peer.hear() => Step::Heard(heard),
            event = next(&mut turn) => Step::Event(event),
        };
        let open = match step {
            Step::Heard(None) => false,
            Step::Heard(Some(text)) => match serde_json::from_str::<Frame>(&text) {
                Ok(Frame::Turn { .. }) if turn.is_some() => {
                    let said = "a turn is running; stop it or wait for it to end";
                    peer.say(&failure(Kind::Busy, said)).await
                }
                Ok(Frame::Turn { text }) if text.trim().is_empty() => {
                    peer.say(&failure(Kind::BadFrame, "a turn needs some text"))
                        .await
                }
                Ok(Frame::Turn { text }) => {
                    sent += 1;
                    begin(machine, name, &mut place, &mut turn, &text, sent, peer).await
                }
                Ok(Frame::Answer {
                    request_id,
                    decision,
                }) => {
                    let answered = match &turn {
                        Some((running, _)) => running
                            .answer(&request_id, decision)
                            .map_err(|error| chain(&error)),
                        None => Err("no turn is running, so nothing is waiting".to_owned()),
                    };
                    match answered {
                        Ok(()) => true,
                        Err(said) => peer.say(&failure(Kind::BadFrame, said)).await,
                    }
                }
                Ok(Frame::Cancel) => {
                    if let Some((running, _)) = &turn {
                        tracing::info!("chat {name}: the turn was cancelled");
                        running.cancel();
                    }
                    true
                }
                Err(error) => {
                    let said = format!("a frame is a turn, an answer or a cancel: {error}");
                    peer.say(&failure(Kind::BadFrame, said)).await
                }
            },
            Step::Event(Some(event)) => {
                if let Event::TurnCompleted(done) = &event.event {
                    tracing::info!("chat {name}: the turn ended {:?}", done.state);
                    turn = None;
                }
                peer.say(&event).await
            }
            Step::Event(None) => {
                turn = None;
                true
            }
        };
        if !open {
            break;
        }
    }

    if let Some((running, mut events)) = turn.take() {
        tracing::info!("chat {name}: the socket closed mid-turn, so the turn is cancelled");
        running.cancel();
        let _ = tokio::time::timeout(STOP_GRACE, async {
            while let Some(event) = events.recv().await {
                if matches!(event.event, Event::TurnCompleted(_)) {
                    return;
                }
            }
        })
        .await;
    }
}

enum Step {
    Heard(Option<String>),
    Event(Option<ThreadEvent>),
}

async fn next(turn: &mut Option<(Turn, Events)>) -> Option<ThreadEvent> {
    match turn {
        Some((_, events)) => events.recv().await,
        None => std::future::pending().await,
    }
}

/// What the transcript holds, as the deltas a live turn would have sent.
async fn replay<M: Machine, P: Peer>(machine: &M, place: &Place, peer: &mut P) -> bool {
    let entries = match machine.history(place).await {
        Ok(entries) => entries,
        Err(said) => return peer.say(&failure(Kind::Unreachable, said)).await,
    };
    for (at, entry) in entries.into_iter().enumerate() {
        if entry.text.is_empty() {
            continue;
        }
        let event = delta(
            place,
            match entry.who {
                Who::User => StreamKind::UserText,
                Who::Assistant => StreamKind::AssistantText,
            },
            entry.text,
            format!("history:{at}"),
        );
        if !peer.say(&event).await {
            return false;
        }
    }
    true
}

fn delta(place: &Place, stream_kind: StreamKind, text: String, item: String) -> ThreadEvent {
    ThreadEvent {
        thread_id: thread::name(place).to_owned(),
        event: Event::ContentDelta(ContentDelta {
            stream_kind,
            delta: text,
            item_id: Some(item),
        }),
    }
}

/// Opens the thread on the first turn, repeats what the person wrote, and
/// starts `claude`. `false` is a socket that went away.
async fn begin<M: Machine, P: Peer>(
    machine: &M,
    name: &str,
    place: &mut Option<Place>,
    turn: &mut Option<(Turn, Events)>,
    text: &str,
    sent: usize,
    peer: &mut P,
) -> bool {
    let here = match place {
        Some(here) => here,
        None => match machine.open().await {
            Ok(opened) => {
                let id = thread::name(&opened).to_owned();
                tracing::info!("chat {name} opened thread {id}");
                let started = ThreadEvent {
                    thread_id: id.clone(),
                    event: Event::ThreadStarted { thread: id },
                };
                if !peer.say(&started).await {
                    return false;
                }
                place.insert(opened)
            }
            Err(said) => {
                tracing::warn!("chat {name}: {said}");
                return peer.say(&failure(Kind::Unreachable, said)).await;
            }
        },
    };
    let said = delta(
        here,
        StreamKind::UserText,
        text.to_owned(),
        format!("user:{sent}"),
    );
    if !peer.say(&said).await {
        return false;
    }
    match machine.start(here, text) {
        Ok(started) => {
            tracing::info!("chat {name}: a turn started");
            *turn = Some(started);
            true
        }
        Err(said) => {
            tracing::warn!("chat {name}: {said}");
            peer.say(&failure(Kind::Unreachable, said)).await
        }
    }
}

/// The shapes on this seam, for the check in [`crate::contract`].
#[cfg(test)]
#[allow(clippy::expect_used)]
pub(crate) fn answers() -> Vec<(&'static str, &'static str, serde_json::Value)> {
    use yantra_core::chat::{
        Item, ItemStatus, ItemType, RequestOpened, RequestOption, RequestResolved, RequestType,
        StopReason, TokenUsage, TurnCompleted, TurnState,
    };
    let event = |event| {
        serde_json::to_value(ThreadEvent {
            thread_id: "1a2b3c4d".to_owned(),
            event,
        })
        .expect("an event serialises")
    };
    let frame = |frame: Frame| serde_json::to_value(frame).expect("a frame serialises");
    let options = [
        ("accept", "Accept", Decision::Accept),
        ("accept_always", "Accept always", Decision::AcceptAlways),
        ("decline", "Decline", Decision::Decline),
    ]
    .map(|(id, label, decision)| RequestOption {
        option_id: id.to_owned(),
        label: label.to_owned(),
        decision,
    })
    .to_vec();
    vec![
        (
            "chatEvents",
            "ThreadEvent[]",
            serde_json::Value::Array(vec![
                event(Event::ThreadStarted {
                    thread: "1a2b3c4d".to_owned(),
                }),
                event(Event::TurnStarted),
                event(Event::ContentDelta(ContentDelta {
                    stream_kind: StreamKind::AssistantText,
                    delta: "Running the tests.".to_owned(),
                    item_id: Some("msg_1:1".to_owned()),
                })),
                event(Event::ItemStarted(Item {
                    item_id: "toolu_1".to_owned(),
                    item_type: Some(ItemType::CommandExecution),
                    status: Some(ItemStatus::InProgress),
                    title: Some("cargo test".to_owned()),
                    output: None,
                    changes: vec![],
                })),
                event(Event::RequestOpened(RequestOpened {
                    request_id: "r1".to_owned(),
                    request_type: RequestType::ExecCommandApproval,
                    item_id: Some("toolu_1".to_owned()),
                    title: Some("cargo test".to_owned()),
                    detail: Some("Run the unit tests".to_owned()),
                    options,
                })),
                event(Event::RequestResolved(RequestResolved {
                    request_id: "r1".to_owned(),
                    request_type: RequestType::ExecCommandApproval,
                    decision: Decision::Accept,
                })),
                event(Event::ItemCompleted(Item {
                    item_id: "toolu_1".to_owned(),
                    item_type: None,
                    status: Some(ItemStatus::Completed),
                    title: None,
                    output: Some("test result: ok".to_owned()),
                    changes: vec![],
                })),
                event(Event::TokenUsageUpdated(TokenUsage {
                    used_tokens: 29_149,
                    max_tokens: 200_000,
                })),
                event(Event::TurnCompleted(TurnCompleted {
                    state: TurnState::Completed,
                    stop_reason: Some(StopReason::EndTurn),
                    message: None,
                })),
                event(Event::TurnCompleted(TurnCompleted {
                    state: TurnState::Failed,
                    stop_reason: None,
                    message: Some("Not logged in · Please run /login".to_owned()),
                })),
            ]),
        ),
        (
            "chatFailure",
            "ChatFailure",
            serde_json::to_value(failure(Kind::Busy, "a turn is running"))
                .expect("a failure serialises"),
        ),
        (
            "chatFrames",
            "ChatFrame[]",
            serde_json::Value::Array(vec![
                frame(Frame::Turn {
                    text: "run the tests".to_owned(),
                }),
                frame(Frame::Answer {
                    request_id: "r1".to_owned(),
                    decision: Decision::AcceptAlways,
                }),
                frame(Frame::Cancel),
            ]),
        ),
    ]
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::collections::BTreeMap;
    use std::net::{IpAddr, Ipv4Addr};
    use std::sync::{Arc, Mutex, PoisonError};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::mpsc;
    use yantra_core::inventory::{Caller, Fake};

    const ME: u64 = 1;
    const LOCAL: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
    const THREAD: &str = "1a2b3c4d";

    fn place() -> Place {
        Place {
            id: format!("chat/web/{THREAD}"),
            repo: "/home/u/repo".to_owned(),
            worktree: format!("/home/u/.yantra/worktrees/chat/web/{THREAD}"),
            branch: format!("yantra/chat/web/{THREAD}"),
            base: "0123abcd".to_owned(),
        }
    }

    /// Claude's end of one turn's pipe.
    struct Claude {
        hears: BufReader<ReadHalf<DuplexStream>>,
        says: WriteHalf<DuplexStream>,
    }

    impl Claude {
        async fn heard(&mut self) -> Option<Value> {
            let mut line = String::new();
            let read =
                tokio::time::timeout(Duration::from_secs(5), self.hears.read_line(&mut line))
                    .await
                    .expect("the turn writes or closes")
                    .expect("the pipe reads");
            (read > 0).then(|| serde_json::from_str(&line).expect("a JSON line"))
        }

        async fn say(&mut self, line: Value) {
            self.says
                .write_all(format!("{line}\n").as_bytes())
                .await
                .expect("the pipe writes");
        }
    }

    /// A machine with one thread, whose turns are pipes the test holds.
    #[derive(Default)]
    struct Script {
        threads: Vec<Place>,
        history: Vec<logs::Entry>,
        unreachable: bool,
        turns: Mutex<Vec<Claude>>,
        opened: Mutex<usize>,
    }

    impl Script {
        fn claude(&self) -> Claude {
            self.turns
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(0)
        }
    }

    impl Machine for Script {
        async fn open(&self) -> Result<Place, String> {
            if self.unreachable {
                return Err("ssh: connect to host m port 22: Connection refused".to_owned());
            }
            *self.opened.lock().unwrap_or_else(PoisonError::into_inner) += 1;
            Ok(place())
        }

        async fn find(&self, id: &str) -> Result<Option<Place>, String> {
            Ok(self
                .threads
                .iter()
                .find(|place| thread::name(place) == id)
                .cloned())
        }

        async fn history(&self, _: &Place) -> Result<Vec<logs::Entry>, String> {
            Ok(self.history.clone())
        }

        fn start(&self, place: &Place, text: &str) -> Result<(Turn, Events), String> {
            let (ours, theirs) = tokio::io::duplex(1 << 16);
            let (read, write) = tokio::io::split(ours);
            let (hears, says) = tokio::io::split(theirs);
            self.turns
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(Claude {
                    hears: BufReader::new(hears),
                    says,
                });
            Ok(Turn::over(read, write, thread::name(place), text))
        }
    }

    /// The browser, as two channels.
    struct Browser {
        from: mpsc::UnboundedReceiver<String>,
        to: mpsc::UnboundedSender<String>,
    }

    impl Peer for Browser {
        async fn hear(&mut self) -> Option<String> {
            self.from.recv().await
        }

        async fn say_text(&mut self, text: String) -> bool {
            self.to.send(text).is_ok()
        }
    }

    struct Tab {
        send: Option<mpsc::UnboundedSender<String>>,
        heard: mpsc::UnboundedReceiver<String>,
    }

    impl Tab {
        fn send(&self, frame: Value) {
            self.send
                .as_ref()
                .expect("the tab is open")
                .send(frame.to_string())
                .expect("the socket listens");
        }

        async fn next(&mut self) -> Value {
            let text = tokio::time::timeout(Duration::from_secs(5), self.heard.recv())
                .await
                .expect("a frame within 5 s")
                .expect("the socket is open");
            serde_json::from_str(&text).expect("every frame is JSON")
        }

        fn close(&mut self) {
            self.send = None;
        }
    }

    fn connect(script: Arc<Script>, thread: Option<&str>) -> (Tab, tokio::task::JoinHandle<()>) {
        let (send, from) = mpsc::unbounded_channel();
        let (to, heard) = mpsc::unbounded_channel();
        let thread = thread.map(str::to_owned);
        let served = tokio::spawn(async move {
            converse(script.as_ref(), "web", thread, &mut Browser { from, to }).await;
        });
        (
            Tab {
                send: Some(send),
                heard,
            },
            served,
        )
    }

    #[tokio::test]
    async fn the_first_turn_opens_a_thread_and_relays_claudes_events() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "run the tests"}));

        assert_eq!(
            tab.next().await,
            json!({"threadId": THREAD, "type": "thread.started", "payload": {"thread": THREAD}})
        );
        assert_eq!(
            tab.next().await,
            json!({"threadId": THREAD, "type": "content.delta", "payload":
                {"streamKind": "user_text", "delta": "run the tests", "itemId": "user:1"}})
        );
        let mut claude = script.claude();
        assert_eq!(
            claude.heard().await.expect("the prompt")["message"]["content"][0]["text"],
            "run the tests"
        );
        claude
            .say(json!({"type": "system", "subtype": "init"}))
            .await;
        assert_eq!(tab.next().await["type"], "turn.started");

        // One turn at a time.
        tab.send(json!({"type": "turn", "text": "and the docs"}));
        let busy = tab.next().await;
        assert_eq!(busy["type"], "error");
        assert_eq!(busy["kind"], "busy");

        claude
            .say(
                json!({"type": "result", "subtype": "success", "is_error": false,
                        "stop_reason": "end_turn"}),
            )
            .await;
        assert_eq!(
            tab.next().await["payload"],
            json!({"state": "completed", "stopReason": "end_turn"})
        );
        assert_eq!(*script.opened.lock().expect("a lock"), 1);
    }

    #[tokio::test]
    async fn a_frame_it_cannot_read_and_an_answer_to_nothing_are_bad_frames() {
        let (mut tab, _served) = connect(Arc::new(Script::default()), None);
        for frame in [
            json!({"type": "shout", "text": "hi"}),
            json!({"type": "turn"}),
            json!({"type": "turn", "text": "   "}),
            json!({"type": "answer", "requestId": "r1", "decision": "maybe"}),
            json!({"type": "answer", "requestId": "r1", "decision": "accept"}),
        ] {
            let said = tab.next_after(frame).await;
            assert_eq!(said["type"], "error", "{said}");
            assert_eq!(said["kind"], "badFrame", "{said}");
        }
        // The socket is still open for a good one.
        tab.send(json!({"type": "cancel"}));
        tab.send(json!({"type": "shout"}));
        assert_eq!(tab.next().await["kind"], "badFrame");
    }

    impl Tab {
        async fn next_after(&mut self, frame: Value) -> Value {
            self.send(frame);
            self.next().await
        }
    }

    #[tokio::test]
    async fn every_frame_the_browser_sends_parses() {
        for (text, frame) in [
            (
                r#"{"type":"turn","text":"hi"}"#,
                Frame::Turn {
                    text: "hi".to_owned(),
                },
            ),
            (
                r#"{"type":"answer","requestId":"r","decision":"acceptAlways"}"#,
                Frame::Answer {
                    request_id: "r".to_owned(),
                    decision: Decision::AcceptAlways,
                },
            ),
            (r#"{"type":"cancel"}"#, Frame::Cancel),
        ] {
            let parsed: Frame = serde_json::from_str(text).expect("a frame parses");
            assert_eq!(format!("{parsed:?}"), format!("{frame:?}"));
        }
    }

    #[tokio::test]
    async fn an_answer_reaches_claude_and_a_closed_socket_cancels_the_turn() {
        let script = Arc::new(Script::default());
        let (mut tab, served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "touch a"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude();
        claude.heard().await;
        claude
            .say(
                json!({"type": "control_request", "request_id": "r1", "request": {
                "subtype": "can_use_tool", "tool_name": "Bash",
                "input": {"command": "touch a"}, "tool_use_id": "t1"}}),
            )
            .await;
        assert_eq!(tab.next().await["type"], "request.opened");

        tab.send(json!({"type": "answer", "requestId": "r1", "decision": "accept"}));
        let answer = claude.heard().await.expect("the answer");
        assert_eq!(answer["response"]["response"]["behavior"], "allow");
        assert_eq!(tab.next().await["payload"]["decision"], "accept");

        tab.close();
        assert_eq!(
            claude.heard().await.expect("an interrupt")["request"]["subtype"],
            "interrupt"
        );
        assert_eq!(claude.heard().await, None, "stdin closes");
        drop(claude);
        tokio::time::timeout(Duration::from_secs(5), served)
            .await
            .expect("the socket's task ends")
            .expect("it did not panic");
    }

    #[tokio::test]
    async fn an_attach_replays_the_transcript_and_continues_the_thread() {
        let script = Arc::new(Script {
            threads: vec![place()],
            history: vec![
                logs::Entry {
                    who: Who::User,
                    at: None,
                    text: "hello".to_owned(),
                    tools: vec![],
                },
                logs::Entry {
                    who: Who::Assistant,
                    at: None,
                    text: String::new(),
                    tools: vec![],
                },
                logs::Entry {
                    who: Who::Assistant,
                    at: None,
                    text: "hi there".to_owned(),
                    tools: vec![],
                },
            ],
            ..Script::default()
        });
        let (mut tab, _served) = connect(Arc::clone(&script), Some(THREAD));
        assert_eq!(
            tab.next().await["payload"],
            json!({"streamKind": "user_text", "delta": "hello", "itemId": "history:0"})
        );
        assert_eq!(
            tab.next().await["payload"],
            json!({"streamKind": "assistant_text", "delta": "hi there", "itemId": "history:2"})
        );
        tab.send(json!({"type": "turn", "text": "again"}));
        assert_eq!(tab.next().await["payload"]["streamKind"], "user_text");
        assert_eq!(*script.opened.lock().expect("a lock"), 0, "no new thread");
    }

    #[tokio::test]
    async fn a_thread_that_is_not_there_and_a_machine_that_is_not_are_named() {
        let (mut tab, served) = connect(Arc::new(Script::default()), Some("ffffffff"));
        assert_eq!(
            tab.next().await,
            json!({"type": "error", "kind": "unknownThread",
                   "said": "web has no chat thread ffffffff"})
        );
        served.await.expect("the socket ends");

        let down = Arc::new(Script {
            unreachable: true,
            ..Script::default()
        });
        let (mut tab, _served) = connect(down, None);
        tab.send(json!({"type": "turn", "text": "hi"}));
        assert_eq!(
            tab.next().await,
            json!({"type": "error", "kind": "unreachable",
                   "said": "ssh: connect to host m port 22: Connection refused"})
        );
    }

    #[test]
    fn the_thread_is_read_from_the_query() {
        let uri = |text: &str| text.parse::<Uri>().expect("a uri");
        assert_eq!(
            read_thread(&uri("/api/workspaces/w/chat?thread=1a2b3c4d")),
            Some(THREAD.to_owned())
        );
        assert_eq!(read_thread(&uri("/api/workspaces/w/chat?thread=")), None);
        assert_eq!(read_thread(&uri("/api/workspaces/w/chat")), None);
    }

    fn caller(user: u64, tags: &[&str]) -> Caller {
        Caller {
            node: "nSOME000000011CNTRL".to_string(),
            user,
            tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
        }
    }

    /// The upgrade's status line, from a real listener: the refusal turns on
    /// the peer address the kernel reports.
    async fn handshake(caller: Option<Caller>) -> String {
        let fake = Fake {
            machines: Vec::new(),
            addresses: Vec::new(),
            callers: caller
                .map(|caller| (LOCAL, caller))
                .into_iter()
                .collect::<BTreeMap<_, _>>(),
            owner: ME,
        };
        let app = Router::new().nest("/api", router(Authoriser::new(fake, &[])));
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
                b"GET /api/workspaces/web/chat HTTP/1.1\r\n\
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

    #[tokio::test]
    async fn the_route_refuses_whoever_allowed_refuses_and_upgrades_the_owner() {
        for refused in [
            Some(caller(ME + 1, &[])),
            Some(caller(ME, &["tag:ci"])),
            None,
        ] {
            let status = handshake(refused).await;
            assert!(status.starts_with("HTTP/1.1 403"), "{status}");
        }
        let owner = handshake(Some(caller(ME, &[]))).await;
        assert!(owner.starts_with("HTTP/1.1 101"), "{owner}");
    }
}
