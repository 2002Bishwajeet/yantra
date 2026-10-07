//! `GET /api/workspaces/{name}/chat?thread=<id>` — a chat thread on a
//! WebSocket ([ADR-0026] decision 3).
//!
//! A thread is a worktree of the workspace's repository ([`thread`]), and one
//! harness speaks in it, chosen by the turn that opens it. Claude's turns are
//! each one `claude -p` ([`yantra_core::claude`]). Every other harness is one
//! ACP agent for the life of the socket ([`yantra_core::acp`], [ADR-0033]
//! decision 2), whose session id the thread's git config keeps. Without
//! `?thread=` the first turn opens a thread and the socket says so with
//! `thread.started`; with it, the socket says `thread.started` too, replays
//! the conversation and continues there. **There is no session-addressed
//! form**: a bare session names no worktree.
//!
//! The browser sends three frames, `turn`, `answer` and `cancel`, and one turn
//! runs at a time. The daemon sends [`ThreadEvent`]s and one typed [`Failure`].
//! A socket that closes mid-turn cancels the turn; the worktree stays, as
//! `thread.rs` requires.
//!
//! **A binary frame is an image** (Y-424). It goes to the machine through
//! [`Images`], one directory per socket, and gets exactly one [`Attachment`]
//! in reply, in order. Every Claude turn may read that directory, and the
//! socket's close removes it. The daemon writes nothing of it to disk.
//!
//! **An upgrade is a `GET`**, so [`allowed`] is called by name before it, as
//! in [`crate::terminal`]. Q5 holds: the socket's lifecycle is logged, and not
//! one word of a prompt, a reply or a tool's output is.
//!
//! [ADR-0026]: ../../../docs/adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md
//! [ADR-0033]: ../../../docs/adr/0033-other-harnesses-speak-acp-and-claude-delegates.md

use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use axum::routing::get;
use serde::{Deserialize, Serialize};
use yantra_core::acp::{self, Agent, Answer, Harness};
use yantra_core::chat::{
    ContentDelta, Decision, Event, RequestOption, StopReason, StreamKind, ThreadEvent, TurnState,
};
use yantra_core::claude::{Events, Turn};
use yantra_core::image::{self, Images};
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
/// How long a harness may take to start and open its session. Meanwhile no
/// frame is read, so a hung agent must not hold the socket for good.
const CONNECT_WITHIN: Duration = Duration::from_secs(60);
/// How a Claude turn that has no login ends, in Claude's own words.
const CLAUDE_NOT_LOGGED_IN: &str = "Not logged in";
/// The largest image a frame carries, above a 10 MB screenshot.
const IMAGE_LIMIT: usize = 16 * 1024 * 1024;
/// How long one image may take to land. Meanwhile no frame is read.
const PUT_WITHIN: Duration = Duration::from_secs(60);
/// How long the socket's close waits for its images to be removed.
const CLEAR_WITHIN: Duration = Duration::from_secs(10);

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

    Ok(sized(upgrade).on_upgrade(move |mut socket| async move {
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

/// tungstenite's own limits are 64 MiB a message and 16 MiB a frame.
fn sized(upgrade: WebSocketUpgrade) -> WebSocketUpgrade {
    upgrade
        .max_message_size(IMAGE_LIMIT)
        .max_frame_size(IMAGE_LIMIT)
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
        /// Read only on the turn that opens a thread.
        #[serde(default)]
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        harness: Option<String>,
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
    #[serde(flatten)]
    login: Option<Login>,
}

/// The one reply to each image, in the order the images came.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Attachment {
    /// `path` is where Claude reads it on the machine.
    Attached {
        path: String,
    },
    NotAttached {
        kind: NotAttached,
        said: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum NotAttached {
    /// The bytes are not a PNG, JPEG, GIF or WebP.
    NotAnImage,
    /// The machine could not be reached, or did not write it.
    Unreachable,
}

/// What a `notLoggedIn` failure names: whose login, where, and how to make it.
#[derive(Debug, Serialize)]
struct Login {
    harness: &'static str,
    machine: String,
    command: String,
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
    /// The workspace, its machine or its harness could not be reached.
    Unreachable,
    /// The harness has no login on the machine (ADR-0033 decision 6).
    NotLoggedIn,
}

fn failure(kind: Kind, said: impl Into<String>) -> Failure {
    Failure {
        tag: "error",
        kind,
        said: said.into(),
        login: None,
    }
}

// The command is always ours: an agent's auth-method description is prose,
// and pasted into a shell its backticks run.
fn not_logged_in(harness: Option<Harness>, machine: &str, said: String) -> Failure {
    Failure {
        login: Some(Login {
            harness: name_of(harness),
            machine: machine.to_owned(),
            command: acp::login_command(harness).to_owned(),
        }),
        ..failure(Kind::NotLoggedIn, said)
    }
}

/// `None` is Claude, which is not an ACP harness.
fn name_of(harness: Option<Harness>) -> &'static str {
    harness.map_or("claude", Harness::name)
}

fn harness_named(name: &str) -> Result<Option<Harness>, String> {
    if name == "claude" {
        return Ok(None);
    }
    name.parse().map(Some).map_err(|_: String| {
        format!("`{name}` is not a harness: claude, codex, gemini, grok or opencode")
    })
}

/// Where a conversation's turns run: a workspace's machine over ssh, or a
/// test's script. These calls are the whole of what the socket asks.
trait Machine: Sync {
    /// The machine's name, as a login failure names it.
    fn machine(&self) -> &str;
    async fn open(&self) -> Result<Place, String>;
    async fn find(&self, thread: &str) -> Result<Option<Place>, String>;
    /// Removes a thread whose harness never started, so it is not taken for
    /// a Claude thread later.
    async fn remove(&self, place: &Place) -> Result<(), String>;
    async fn history(&self, place: &Place) -> Result<Vec<logs::Entry>, String>;
    /// `images` is the directory a Claude turn may read.
    fn start(
        &self,
        place: &Place,
        text: &str,
        images: Option<&str>,
    ) -> Result<(Turn, Events), String>;
    /// Writes one image on the machine and returns its path.
    async fn put(&self, images: &mut Images, bytes: &[u8]) -> Result<String, image::Error>;
    /// Removes the socket's images.
    async fn clear(&self, images: &Images) -> Result<(), String>;
    async fn recall(&self, place: &Place) -> Result<Option<(Harness, String)>, String>;
    async fn remember(&self, place: &Place, harness: Harness, session: &str) -> Result<(), String>;
    fn start_acp(&self, harness: Harness) -> Result<(Agent, acp::Events), String>;
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
    fn machine(&self) -> &str {
        &self.workspace.machine
    }

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

    async fn remove(&self, place: &Place) -> Result<(), String> {
        thread::remove(&self.ssh, place)
            .await
            .map_err(|error| chain(&error))
    }

    async fn history(&self, place: &Place) -> Result<Vec<logs::Entry>, String> {
        match thread::logs(&self.ssh, place, None, HISTORY, 0).await {
            Ok(transcript) => Ok(transcript.entries),
            // A thread whose first turn never answered has nothing to replay.
            Err(logs::Error::NoTranscript { .. }) => Ok(Vec::new()),
            Err(error) => Err(chain(&error)),
        }
    }

    fn start(
        &self,
        place: &Place,
        text: &str,
        images: Option<&str>,
    ) -> Result<(Turn, Events), String> {
        Turn::start(&self.ssh, place, text, images).map_err(|error| chain(&error))
    }

    async fn put(&self, images: &mut Images, bytes: &[u8]) -> Result<String, image::Error> {
        images.put(&self.ssh, bytes).await
    }

    async fn clear(&self, images: &Images) -> Result<(), String> {
        images
            .remove(&self.ssh)
            .await
            .map_err(|error| chain(&error))
    }

    async fn recall(&self, place: &Place) -> Result<Option<(Harness, String)>, String> {
        thread::recall(&self.ssh, place)
            .await
            .map_err(|error| chain(&error))
    }

    async fn remember(&self, place: &Place, harness: Harness, session: &str) -> Result<(), String> {
        thread::remember(&self.ssh, place, harness, session)
            .await
            .map_err(|error| chain(&error))
    }

    fn start_acp(&self, harness: Harness) -> Result<(Agent, acp::Events), String> {
        Agent::start(&self.ssh, harness).map_err(|error| chain(&error))
    }
}

/// What the browser sent: a JSON frame, or an image.
enum Heard {
    Text(String),
    Binary(Bytes),
}

/// The browser's end of the socket. `None` is a socket that closed or failed.
trait Peer {
    async fn hear(&mut self) -> Option<Heard>;
    async fn say_text(&mut self, text: String) -> bool;

    async fn say<T: Serialize + Sync>(&mut self, frame: &T) -> bool {
        match serde_json::to_string(frame) {
            Ok(text) => self.say_text(text).await,
            Err(_) => false,
        }
    }
}

impl Peer for WebSocket {
    async fn hear(&mut self) -> Option<Heard> {
        loop {
            match self.recv().await? {
                Ok(Message::Text(text)) => return Some(Heard::Text(text.to_string())),
                Ok(Message::Binary(bytes)) => return Some(Heard::Binary(bytes)),
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

type Prompt = Pin<Box<dyn Future<Output = Result<StopReason, acp::Error>> + Send>>;

/// One ACP agent, held for the life of the socket.
struct Acp {
    harness: Harness,
    agent: Arc<Agent>,
    /// `None` once the agent has gone and its events have ended.
    events: Option<acp::Events>,
    session: String,
    /// The agent's own words on how to log in, from `initialize`.
    login: Option<String>,
    /// The options of each request relayed and not yet resolved, so a
    /// browser's decision can name the agent's option.
    asked: HashMap<String, Vec<RequestOption>>,
    prompt: Option<Prompt>,
}

enum Speaker {
    Claude(Option<(Turn, Events)>),
    Acp(Box<Acp>),
}

struct Conversation {
    place: Place,
    speaker: Speaker,
}

impl Conversation {
    fn harness(&self) -> Option<Harness> {
        match &self.speaker {
            Speaker::Claude(_) => None,
            Speaker::Acp(acp) => Some(acp.harness),
        }
    }

    fn busy(&self) -> bool {
        match &self.speaker {
            Speaker::Claude(turn) => turn.is_some(),
            Speaker::Acp(acp) => acp.prompt.is_some(),
        }
    }

    fn started(&self) -> ThreadEvent {
        let id = thread::name(&self.place).to_owned();
        ThreadEvent {
            thread_id: id.clone(),
            event: Event::ThreadStarted {
                thread: id,
                harness: name_of(self.harness()).to_owned(),
            },
        }
    }
}

/// One socket, from the attach to the close.
async fn converse<M: Machine, P: Peer>(
    machine: &M,
    name: &str,
    thread: Option<String>,
    peer: &mut P,
) {
    let mut here = None;
    if let Some(id) = thread {
        match attach(machine, name, &id, peer).await {
            Some(attached) => here = Some(attached),
            None => return,
        }
    }

    let mut images = Images::new();
    let mut sent = 0usize;
    loop {
        let step = tokio::select! {
            heard = peer.hear() => Step::Heard(heard),
            step = listen(&mut here) => step,
        };
        let open = match step {
            Step::Heard(None) => false,
            Step::Heard(Some(Heard::Binary(bytes))) => {
                let reply = land(machine, name, &mut images, &bytes).await;
                peer.say(&reply).await
            }
            Step::Heard(Some(Heard::Text(text))) => match serde_json::from_str::<Frame>(&text) {
                Ok(Frame::Turn { text, harness }) => {
                    let asked = harness.as_deref().map(harness_named).transpose();
                    let theirs = here
                        .as_ref()
                        .map(|running| (running.busy(), running.harness()));
                    match (asked, theirs) {
                        (_, Some((true, _))) => {
                            let said = "a turn is running; stop it or wait for it to end";
                            peer.say(&failure(Kind::Busy, said)).await
                        }
                        _ if text.trim().is_empty() => {
                            peer.say(&failure(Kind::BadFrame, "a turn needs some text"))
                                .await
                        }
                        (Err(said), _) => peer.say(&failure(Kind::BadFrame, said)).await,
                        (Ok(Some(asked)), Some((_, theirs))) if asked != theirs => {
                            let said = format!(
                                "this thread is {}'s, and a thread keeps its harness",
                                name_of(theirs)
                            );
                            peer.say(&failure(Kind::BadFrame, said)).await
                        }
                        (Ok(asked), _) => {
                            sent += 1;
                            let pick = asked.flatten();
                            let turn = Said {
                                text,
                                sent,
                                images: images.dir(),
                            };
                            begin(machine, name, &mut here, pick, turn, peer).await
                        }
                    }
                }
                Ok(Frame::Answer {
                    request_id,
                    decision,
                }) => {
                    let answered = match here.as_mut().map(|running| &mut running.speaker) {
                        Some(Speaker::Claude(Some((running, _)))) => running
                            .answer(&request_id, decision)
                            .map_err(|error| chain(&error)),
                        Some(Speaker::Acp(acp)) => answer(acp, &request_id, decision),
                        _ => Err("no turn is running, so nothing is waiting".to_owned()),
                    };
                    match answered {
                        Ok(()) => true,
                        Err(said) => peer.say(&failure(Kind::BadFrame, said)).await,
                    }
                }
                Ok(Frame::Cancel) => {
                    cancel(name, here.as_ref());
                    true
                }
                Err(error) => {
                    let said = format!("a frame is a turn, an answer or a cancel: {error}");
                    peer.say(&failure(Kind::BadFrame, said)).await
                }
            },
            Step::Event(event) => {
                let Some(running) = here.as_mut() else {
                    continue;
                };
                relay(machine, name, running, event, peer).await
            }
            Step::Prompted(result) => {
                let Some(running) = here.as_mut() else {
                    continue;
                };
                prompted(machine, name, running, result, peer).await
            }
        };
        if !open {
            break;
        }
    }

    if let Some(running) = here {
        hang_up(name, running).await;
    }
    if images.used() {
        match tokio::time::timeout(CLEAR_WITHIN, machine.clear(&images)).await {
            Ok(Ok(())) => tracing::info!("chat {name}: its images were removed"),
            Ok(Err(said)) => tracing::warn!("chat {name}: its images stay: {said}"),
            Err(_) => tracing::warn!("chat {name}: its images stay: the machine did not answer"),
        }
    }
}

/// Writes one image and says where it landed. Never a byte or a size in the log.
async fn land<M: Machine>(
    machine: &M,
    name: &str,
    images: &mut Images,
    bytes: &[u8],
) -> Attachment {
    let unreachable = |said: String| {
        tracing::warn!("chat {name}: an image was not attached: {said}");
        Attachment::NotAttached {
            kind: NotAttached::Unreachable,
            said,
        }
    };
    match tokio::time::timeout(PUT_WITHIN, machine.put(images, bytes)).await {
        Ok(Ok(path)) => {
            tracing::info!("chat {name}: image attached");
            Attachment::Attached { path }
        }
        Ok(Err(error @ image::Error::NotAnImage)) => {
            tracing::info!("chat {name}: a frame was not an image");
            Attachment::NotAttached {
                kind: NotAttached::NotAnImage,
                said: error.to_string(),
            }
        }
        Ok(Err(error)) => unreachable(chain(&error)),
        Err(_) => unreachable(format!(
            "the machine did not take the image within {} seconds",
            PUT_WITHIN.as_secs()
        )),
    }
}

enum Step {
    Heard(Option<Heard>),
    Event(Option<ThreadEvent>),
    Prompted(Result<StopReason, acp::Error>),
}

/// The next thing the thread's harness says, or never when nothing runs.
async fn listen(here: &mut Option<Conversation>) -> Step {
    match here.as_mut().map(|running| &mut running.speaker) {
        Some(Speaker::Claude(Some((_, events)))) => Step::Event(events.recv().await),
        Some(Speaker::Acp(acp)) => {
            let Acp { events, prompt, .. } = acp.as_mut();
            let Some(open) = events else {
                return Step::Prompted(finish(prompt).await);
            };
            tokio::select! {
                event = open.recv() => {
                    if event.is_none() {
                        // Polled again, an ended channel answers at once, forever.
                        *events = None;
                    }
                    Step::Event(event)
                }
                result = finish(prompt) => Step::Prompted(result),
            }
        }
        _ => std::future::pending().await,
    }
}

async fn finish(prompt: &mut Option<Prompt>) -> Result<StopReason, acp::Error> {
    match prompt {
        Some(running) => running.await,
        None => std::future::pending().await,
    }
}

/// Sends one event on. `false` is a socket that went away.
async fn relay<M: Machine, P: Peer>(
    machine: &M,
    name: &str,
    running: &mut Conversation,
    event: Option<ThreadEvent>,
    peer: &mut P,
) -> bool {
    let id = thread::name(&running.place).to_owned();
    match &mut running.speaker {
        Speaker::Claude(turn) => {
            let Some(event) = event else {
                *turn = None;
                return true;
            };
            let mut logged_out = None;
            if let Event::TurnCompleted(done) = &event.event {
                tracing::info!("chat {name}: the turn ended {:?}", done.state);
                *turn = None;
                logged_out = done
                    .message
                    .as_ref()
                    .filter(|said| {
                        done.state == TurnState::Failed && said.starts_with(CLAUDE_NOT_LOGGED_IN)
                    })
                    .cloned();
            }
            if !peer.say(&event).await {
                return false;
            }
            match logged_out {
                Some(said) => {
                    let refusal = not_logged_in(None, machine.machine(), said);
                    peer.say(&refusal).await
                }
                None => true,
            }
        }
        Speaker::Acp(acp) => match event.and_then(|event| relabel(acp, &id, event)) {
            Some(event) => peer.say(&event).await,
            None => true,
        },
    }
}

/// An ACP event as the browser reads it: under the worktree's thread, and
/// without ACP's own `thread.started`, whose id is the agent's session.
fn relabel(acp: &mut Acp, id: &str, mut event: ThreadEvent) -> Option<ThreadEvent> {
    match &event.event {
        Event::ThreadStarted { .. } => return None,
        Event::RequestOpened(opened) => {
            acp.asked
                .insert(opened.request_id.clone(), opened.options.clone());
        }
        Event::RequestResolved(resolved) => {
            acp.asked.remove(&resolved.request_id);
        }
        _ => {}
    }
    id.clone_into(&mut event.thread_id);
    Some(event)
}

/// Sends on what the agent said before it answered, so the browser reads
/// every event in order. `false` is a socket that went away.
async fn drain<P: Peer>(acp: &mut Acp, id: &str, peer: &mut P) -> bool {
    while let Some(event) = acp
        .events
        .as_mut()
        .and_then(|events| events.try_recv().ok())
    {
        if let Some(event) = relabel(acp, id, event)
            && !peer.say(&event).await
        {
            return false;
        }
    }
    true
}

/// An ACP turn ended. The agent emitted `turn.completed` before it answered,
/// so a refusal follows it.
async fn prompted<M: Machine, P: Peer>(
    machine: &M,
    name: &str,
    running: &mut Conversation,
    result: Result<StopReason, acp::Error>,
    peer: &mut P,
) -> bool {
    let id = thread::name(&running.place).to_owned();
    let Speaker::Acp(acp) = &mut running.speaker else {
        return true;
    };
    acp.prompt = None;
    if !drain(acp, &id, peer).await {
        return false;
    }
    match result {
        Ok(reason) => {
            tracing::info!("chat {name}: the turn ended {reason:?}");
            true
        }
        Err(error) => {
            tracing::info!("chat {name}: the turn failed");
            peer.say(&refused(machine, acp.harness, acp.login.clone(), &error))
                .await
        }
    }
}

/// What an agent's refusal tells the browser: the login to make, or the
/// agent's own words.
fn refused<M: Machine>(
    machine: &M,
    harness: Harness,
    login: Option<String>,
    error: &acp::Error,
) -> Failure {
    if error.is_auth() {
        let said = match login {
            Some(hint) => format!("{error}. {hint}"),
            None => error.to_string(),
        };
        not_logged_in(Some(harness), machine.machine(), said)
    } else {
        failure(Kind::Unreachable, chain(error))
    }
}

/// The browser's decision, as the option the agent offered for it.
fn answer(acp: &Acp, request: &str, decision: Decision) -> Result<(), String> {
    let options = acp
        .asked
        .get(request)
        .ok_or_else(|| format!("no request `{request}` is waiting for an answer"))?;
    let answer = if decision == Decision::Cancel {
        Answer::Cancelled
    } else {
        let option = options
            .iter()
            .find(|option| option.decision == decision)
            .ok_or_else(|| format!("request `{request}` offered no {decision:?}"))?;
        Answer::Selected(option.option_id.clone())
    };
    acp.agent
        .answer(request, answer)
        .map_err(|error| chain(&error))
}

fn cancel(name: &str, here: Option<&Conversation>) {
    match here.map(|running| &running.speaker) {
        Some(Speaker::Claude(Some((running, _)))) => {
            tracing::info!("chat {name}: the turn was cancelled");
            running.cancel();
        }
        Some(Speaker::Acp(acp)) if acp.prompt.is_some() => {
            tracing::info!("chat {name}: the turn was cancelled");
            // An agent that is gone has no turn left to stop.
            let _ = acp.agent.cancel(&acp.session);
        }
        _ => {}
    }
}

/// The socket closed: a running turn is cancelled and given a moment to end.
async fn hang_up(name: &str, running: Conversation) {
    match running.speaker {
        Speaker::Claude(Some((turn, mut events))) => {
            tracing::info!("chat {name}: the socket closed mid-turn, so the turn is cancelled");
            turn.cancel();
            let _ = tokio::time::timeout(STOP_GRACE, async {
                while let Some(event) = events.recv().await {
                    if matches!(event.event, Event::TurnCompleted(_)) {
                        return;
                    }
                }
            })
            .await;
        }
        Speaker::Acp(mut acp) => {
            if let Some(prompt) = acp.prompt.take() {
                tracing::info!("chat {name}: the socket closed mid-turn, so the turn is cancelled");
                let _ = acp.agent.cancel(&acp.session);
                let _ = tokio::time::timeout(STOP_GRACE, prompt).await;
            }
        }
        Speaker::Claude(None) => {}
    }
}

/// `?thread=`: finds the thread, says whose it is and replays it. `None` ends
/// the socket.
async fn attach<M: Machine, P: Peer>(
    machine: &M,
    name: &str,
    id: &str,
    peer: &mut P,
) -> Option<Conversation> {
    let unreachable = |said: String| {
        tracing::warn!("chat {name}: {said}");
        failure(Kind::Unreachable, said)
    };
    let place = match machine.find(id).await {
        Ok(Some(found)) => found,
        Ok(None) => {
            let said = format!("{name} has no chat thread {id}");
            let _ = peer.say(&failure(Kind::UnknownThread, said)).await;
            return None;
        }
        Err(said) => {
            let _ = peer.say(&unreachable(said)).await;
            return None;
        }
    };
    let kept = match machine.recall(&place).await {
        Ok(kept) => kept,
        Err(said) => {
            let _ = peer.say(&unreachable(said)).await;
            return None;
        }
    };
    tracing::info!(
        "chat {name} attached thread {id} of {}",
        name_of(kept.as_ref().map(|(harness, _)| *harness))
    );
    let mut running = match kept {
        None => Conversation {
            place,
            speaker: Speaker::Claude(None),
        },
        Some((harness, session)) => match connect(machine, &place, harness, Some(session)).await {
            Ok(acp) => Conversation {
                place,
                speaker: Speaker::Acp(Box::new(acp)),
            },
            Err(refusal) => {
                let _ = peer.say(&refusal).await;
                return None;
            }
        },
    };
    if !peer.say(&running.started()).await {
        return None;
    }
    let replayed = match &mut running.speaker {
        Speaker::Claude(_) => replay(machine, &running.place, peer).await,
        Speaker::Acp(acp) => drain(acp, id, peer).await,
    };
    replayed.then_some(running)
}

/// Starts `harness` in the thread's worktree, and loads `session` or makes
/// one and keeps it.
async fn connect<M: Machine>(
    machine: &M,
    place: &Place,
    harness: Harness,
    session: Option<String>,
) -> Result<Acp, Failure> {
    tokio::time::timeout(
        CONNECT_WITHIN,
        start_session(machine, place, harness, session),
    )
    .await
    .unwrap_or_else(|_| {
        Err(failure(
            Kind::Unreachable,
            format!(
                "{} did not open a session within {} seconds",
                harness.name(),
                CONNECT_WITHIN.as_secs()
            ),
        ))
    })
}

async fn start_session<M: Machine>(
    machine: &M,
    place: &Place,
    harness: Harness,
    session: Option<String>,
) -> Result<Acp, Failure> {
    let (agent, events) = machine
        .start_acp(harness)
        .map_err(|said| failure(Kind::Unreachable, said))?;
    let capabilities = agent
        .initialize()
        .await
        .map_err(|error| refused(machine, harness, None, &error))?;
    let login = capabilities.login;
    // An agent that cannot load starts a new conversation in the same worktree.
    let session = match session.filter(|_| capabilities.load_session) {
        Some(session) => {
            agent
                .load_session(&session, &place.worktree)
                .await
                .map_err(|error| refused(machine, harness, login.clone(), &error))?;
            session
        }
        None => {
            let session = agent
                .new_session(&place.worktree)
                .await
                .map_err(|error| refused(machine, harness, login.clone(), &error))?;
            machine
                .remember(place, harness, &session)
                .await
                .map_err(|said| failure(Kind::Unreachable, said))?;
            session
        }
    };
    Ok(Acp {
        harness,
        agent: Arc::new(agent),
        events: Some(events),
        session,
        login,
        asked: HashMap::new(),
        prompt: None,
    })
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

/// One turn the person sent: what they wrote, its number on this socket, and
/// the directory of the images it may read.
struct Said<'a> {
    text: String,
    sent: usize,
    images: Option<&'a str>,
}

/// Opens the thread on the first turn with the harness `pick` names, repeats
/// what the person wrote, and starts the turn. `false` is a socket that went
/// away.
async fn begin<M: Machine, P: Peer>(
    machine: &M,
    name: &str,
    here: &mut Option<Conversation>,
    pick: Option<Harness>,
    Said { text, sent, images }: Said<'_>,
    peer: &mut P,
) -> bool {
    let running = match here {
        Some(running) => running,
        None => match open(machine, name, pick).await {
            Ok(opened) => {
                if !peer.say(&opened.started()).await {
                    return false;
                }
                here.insert(opened)
            }
            Err(refusal) => return peer.say(&refusal).await,
        },
    };
    let said = delta(
        &running.place,
        StreamKind::UserText,
        text.clone(),
        format!("user:{sent}"),
    );
    if !peer.say(&said).await {
        return false;
    }
    match &mut running.speaker {
        Speaker::Claude(turn) => match machine.start(&running.place, &text, images) {
            Ok(started) => {
                tracing::info!("chat {name}: a turn started");
                *turn = Some(started);
                true
            }
            Err(said) => {
                tracing::warn!("chat {name}: {said}");
                peer.say(&failure(Kind::Unreachable, said)).await
            }
        },
        Speaker::Acp(acp) => {
            tracing::info!("chat {name}: a turn started");
            let agent = Arc::clone(&acp.agent);
            let session = acp.session.clone();
            acp.prompt = Some(Box::pin(async move { agent.prompt(&session, &text).await }));
            true
        }
    }
}

/// A new thread, and for an ACP harness its agent and session. A thread whose
/// agent never started is removed again: without a harness in its git config
/// it would read as Claude's.
async fn open<M: Machine>(
    machine: &M,
    name: &str,
    pick: Option<Harness>,
) -> Result<Conversation, Failure> {
    let place = machine.open().await.map_err(|said| {
        tracing::warn!("chat {name}: {said}");
        failure(Kind::Unreachable, said)
    })?;
    let id = thread::name(&place).to_owned();
    tracing::info!("chat {name} opened thread {id} for {}", name_of(pick));
    let Some(harness) = pick else {
        return Ok(Conversation {
            place,
            speaker: Speaker::Claude(None),
        });
    };
    match connect(machine, &place, harness, None).await {
        Ok(acp) => {
            // ACP's own `thread.started` waits in its events, and the relay drops it.
            Ok(Conversation {
                place,
                speaker: Speaker::Acp(Box::new(acp)),
            })
        }
        Err(refusal) => {
            tracing::warn!("chat {name}: {} did not start", harness.name());
            if let Err(said) = machine.remove(&place).await {
                tracing::warn!("chat {name}: thread {id} stays: {said}");
            }
            Err(refusal)
        }
    }
}

/// The shapes on this seam, for the check in [`crate::contract`].
#[cfg(test)]
#[allow(clippy::expect_used)]
pub(crate) fn answers() -> Vec<(&'static str, &'static str, serde_json::Value)> {
    use yantra_core::chat::{
        Item, ItemStatus, ItemType, RequestOpened, RequestResolved, RequestType, TokenUsage,
        TurnCompleted,
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
                    harness: "opencode".to_owned(),
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
            "chatNotLoggedIn",
            "ChatFailure",
            serde_json::to_value(not_logged_in(
                Some(Harness::Opencode),
                "cachyos-g14",
                "the agent refused: Authentication required (-32000)".to_owned(),
            ))
            .expect("a failure serialises"),
        ),
        (
            "chatAttached",
            "ChatAttached",
            serde_json::to_value(Attachment::Attached {
                path: "/tmp/yantra-chat-Y0123456789abcdef/1.png".to_owned(),
            })
            .expect("an attachment serialises"),
        ),
        (
            "chatNotAttached",
            "ChatNotAttached",
            serde_json::to_value(Attachment::NotAttached {
                kind: NotAttached::NotAnImage,
                said: image::Error::NotAnImage.to_string(),
            })
            .expect("an attachment serialises"),
        ),
        (
            "chatFrames",
            "ChatFrame[]",
            serde_json::Value::Array(vec![
                frame(Frame::Turn {
                    text: "run the tests".to_owned(),
                    harness: Some("opencode".to_owned()),
                }),
                frame(Frame::Turn {
                    text: "and the docs".to_owned(),
                    harness: None,
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
#[allow(clippy::expect_used, clippy::panic)]
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
    const IMAGES: &str = "/tmp/yantra-chat-Y0123456789abcdef";

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

    /// An ACP agent's end of its pipe, as `acp.rs`'s tests script it.
    struct Acp {
        hears: BufReader<ReadHalf<DuplexStream>>,
        says: WriteHalf<DuplexStream>,
    }

    impl Acp {
        async fn heard(&mut self) -> Value {
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(5), self.hears.read_line(&mut line))
                .await
                .expect("the daemon writes within 5 s")
                .expect("the pipe reads");
            serde_json::from_str(&line).expect("a JSON line")
        }

        async fn say(&mut self, message: Value) {
            self.says
                .write_all(format!("{message}\n").as_bytes())
                .await
                .expect("the pipe writes");
        }

        async fn reply(&mut self, request: &Value, result: Value) {
            self.say(json!({"jsonrpc": "2.0", "id": request["id"], "result": result}))
                .await;
        }

        /// Answers `initialize` with no auth methods, so the login is Yantra's.
        async fn initialized(&mut self) {
            let request = self.heard().await;
            assert_eq!(request["method"], "initialize");
            self.reply(
                &request,
                json!({"protocolVersion": 1, "agentCapabilities": {"loadSession": true}}),
            )
            .await;
        }

        async fn update(&mut self, update: Value) {
            self.say(json!({"jsonrpc": "2.0", "method": "session/update",
                            "params": {"sessionId": SESSION, "update": update}}))
                .await;
        }
    }

    const SESSION: &str = "ses_1";

    /// A machine with one thread, whose turns and agents are pipes the test holds.
    #[derive(Default)]
    struct Script {
        threads: Vec<Place>,
        history: Vec<logs::Entry>,
        unreachable: bool,
        /// Each makes one call of the machine fail, as ssh would.
        recall_fails: bool,
        remember_fails: bool,
        start_acp_fails: bool,
        /// What the thread's git config keeps.
        kept: Option<(Harness, String)>,
        turns: Mutex<Vec<Claude>>,
        agents: Mutex<Vec<Acp>>,
        opened: Mutex<usize>,
        removed: Mutex<usize>,
        remembered: Mutex<Vec<(Harness, String)>>,
        /// Each write of an image fails, as a full disk would.
        put_fails: bool,
        /// The size of each image that reached the machine.
        put: Mutex<Vec<usize>>,
        cleared: Mutex<usize>,
        /// The images directory each Claude turn was started with.
        started_with: Mutex<Vec<Option<String>>>,
    }

    impl Script {
        fn claude(&self) -> Claude {
            self.turns
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(0)
        }

        async fn agent(&self) -> Acp {
            for _ in 0..500 {
                let found = {
                    let mut agents = self.agents.lock().unwrap_or_else(PoisonError::into_inner);
                    (!agents.is_empty()).then(|| agents.remove(0))
                };
                if let Some(agent) = found {
                    return agent;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("no agent started within 5 s");
        }
    }

    impl Machine for Script {
        fn machine(&self) -> &str {
            "m"
        }

        async fn remove(&self, _: &Place) -> Result<(), String> {
            *self.removed.lock().unwrap_or_else(PoisonError::into_inner) += 1;
            Ok(())
        }

        async fn recall(&self, _: &Place) -> Result<Option<(Harness, String)>, String> {
            if self.recall_fails {
                return Err("git config: ssh: connection reset".to_owned());
            }
            Ok(self.kept.clone())
        }

        async fn remember(&self, _: &Place, harness: Harness, session: &str) -> Result<(), String> {
            if self.remember_fails {
                return Err("git config: could not lock config file".to_owned());
            }
            self.remembered
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push((harness, session.to_owned()));
            Ok(())
        }

        fn start_acp(&self, harness: Harness) -> Result<(Agent, acp::Events), String> {
            if self.start_acp_fails {
                return Err("ssh: could not start the agent".to_owned());
            }
            let (ours, theirs) = tokio::io::duplex(1 << 16);
            let (read, write) = tokio::io::split(ours);
            let (hears, says) = tokio::io::split(theirs);
            self.agents
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(Acp {
                    hears: BufReader::new(hears),
                    says,
                });
            Ok(Agent::over(harness, read, write))
        }

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

        fn start(
            &self,
            place: &Place,
            text: &str,
            images: Option<&str>,
        ) -> Result<(Turn, Events), String> {
            self.started_with
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(images.map(str::to_owned));
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

        async fn put(&self, images: &mut Images, bytes: &[u8]) -> Result<String, image::Error> {
            let fails = self.put_fails;
            images
                .put_with(bytes, |_| async move {
                    let mut put = self.put.lock().unwrap_or_else(PoisonError::into_inner);
                    put.push(bytes.len());
                    if fails {
                        return Err(image::Error::Put {
                            status: Some(1),
                            said: "mkdir: can't create directory: No space left on device"
                                .to_owned(),
                        });
                    }
                    Ok(format!("{IMAGES}/{}.png", put.len()))
                })
                .await
        }

        async fn clear(&self, _: &Images) -> Result<(), String> {
            *self.cleared.lock().unwrap_or_else(PoisonError::into_inner) += 1;
            Ok(())
        }
    }

    /// The browser, as two channels.
    struct Browser {
        from: mpsc::UnboundedReceiver<Heard>,
        to: mpsc::UnboundedSender<String>,
    }

    impl Peer for Browser {
        async fn hear(&mut self) -> Option<Heard> {
            self.from.recv().await
        }

        async fn say_text(&mut self, text: String) -> bool {
            self.to.send(text).is_ok()
        }
    }

    struct Tab {
        send: Option<mpsc::UnboundedSender<Heard>>,
        heard: mpsc::UnboundedReceiver<String>,
    }

    impl Tab {
        fn send(&self, frame: Value) {
            self.send
                .as_ref()
                .expect("the tab is open")
                .send(Heard::Text(frame.to_string()))
                .expect("the socket listens");
        }

        fn send_image(&self, bytes: Vec<u8>) {
            self.send
                .as_ref()
                .expect("the tab is open")
                .send(Heard::Binary(Bytes::from(bytes)))
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
            json!({"threadId": THREAD, "type": "thread.started",
                   "payload": {"thread": THREAD, "harness": "claude"}})
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
                    harness: None,
                },
            ),
            (
                r#"{"type":"turn","text":"hi","harness":"codex"}"#,
                Frame::Turn {
                    text: "hi".to_owned(),
                    harness: Some("codex".to_owned()),
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
            json!({"thread": THREAD, "harness": "claude"}),
            "the browser locks its picker"
        );
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

    const WORKTREE: &str = "/home/u/.yantra/worktrees/chat/web/1a2b3c4d";

    /// The first turn of an opencode thread, up to its `session/prompt`.
    async fn an_opencode_thread(script: &Arc<Script>) -> (Tab, Acp, Value) {
        let (mut tab, _served) = connect(Arc::clone(script), None);
        tab.send(json!({"type": "turn", "text": "list the files", "harness": "opencode"}));
        let mut agent = script.agent().await;
        agent.initialized().await;
        let new = agent.heard().await;
        assert_eq!(new["method"], "session/new");
        assert_eq!(new["params"]["cwd"], WORKTREE);
        agent
            .reply(&new, json!({"sessionId": SESSION, "configOptions": []}))
            .await;
        assert_eq!(
            tab.next().await,
            json!({"threadId": THREAD, "type": "thread.started",
                   "payload": {"thread": THREAD, "harness": "opencode"}})
        );
        assert_eq!(tab.next().await["payload"]["itemId"], "user:1");
        let prompt = agent.heard().await;
        assert_eq!(prompt["method"], "session/prompt");
        assert_eq!(prompt["params"]["sessionId"], SESSION);
        assert_eq!(tab.next().await["type"], "turn.started");
        (tab, agent, prompt)
    }

    #[tokio::test]
    async fn the_first_turn_picks_the_harness_and_the_thread_keeps_it() {
        let script = Arc::new(Script::default());
        let (_tab, _agent, _prompt) = an_opencode_thread(&script).await;
        assert_eq!(
            *script.remembered.lock().expect("a lock"),
            [(Harness::Opencode, SESSION.to_owned())]
        );
        assert_eq!(*script.removed.lock().expect("a lock"), 0);
    }

    #[tokio::test]
    async fn acp_deltas_items_and_requests_arrive_under_the_worktree_thread() {
        let script = Arc::new(Script::default());
        let (mut tab, mut agent, prompt) = an_opencode_thread(&script).await;
        agent
            .update(
                json!({"sessionUpdate": "agent_message_chunk", "messageId": "m1",
                           "content": {"type": "text", "text": "Listing."}}),
            )
            .await;
        agent
            .update(json!({"sessionUpdate": "tool_call", "toolCallId": "call_1",
                           "title": "ls", "kind": "execute", "status": "pending"}))
            .await;
        agent.say(asked(7)).await;
        for kind in ["content.delta", "item.started", "request.opened"] {
            let event = tab.next().await;
            assert_eq!(event["type"], kind, "{event}");
            assert_eq!(event["threadId"], THREAD, "{event}");
        }
        agent
            .reply(&prompt, json!({"stopReason": "end_turn"}))
            .await;
        let done = tab.next().await;
        assert_eq!(done["threadId"], THREAD);
        assert_eq!(
            done["payload"],
            json!({"state": "completed", "stopReason": "end_turn"})
        );
    }

    /// R19 §2's permission request, as opencode words it.
    fn asked(id: u64) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": "session/request_permission",
               "params": {"sessionId": SESSION,
                   "toolCall": {"toolCallId": "call_1", "title": "ls", "kind": "execute"},
                   "options": [
                       {"optionId": "once", "name": "Allow once", "kind": "allow_once"},
                       {"optionId": "always", "name": "Always allow", "kind": "allow_always"},
                       {"optionId": "reject", "name": "Reject", "kind": "reject_once"}]}})
    }

    #[tokio::test]
    async fn an_answer_names_the_option_the_agent_offered() {
        let script = Arc::new(Script::default());
        let (mut tab, mut agent, _prompt) = an_opencode_thread(&script).await;
        agent.say(asked(7)).await;
        let opened = tab.next().await;
        let request = opened["payload"]["requestId"].clone();
        tab.send(json!({"type": "answer", "requestId": request, "decision": "acceptAlways"}));
        assert_eq!(
            agent.heard().await,
            json!({"jsonrpc": "2.0", "id": 7,
                   "result": {"outcome": {"outcome": "selected", "optionId": "always"}}})
        );
        let resolved = tab.next().await;
        assert_eq!(resolved["type"], "request.resolved");
        assert_eq!(resolved["payload"]["decision"], "acceptAlways");

        // Answered once, it is an answer to nothing.
        let again = tab
            .next_after(json!({"type": "answer", "requestId": request, "decision": "accept"}))
            .await;
        assert_eq!(again["kind"], "badFrame", "{again}");
    }

    #[tokio::test]
    async fn an_answer_to_nothing_on_an_acp_thread_is_a_bad_frame() {
        let script = Arc::new(Script::default());
        let (mut tab, _agent, _prompt) = an_opencode_thread(&script).await;
        let said = tab
            .next_after(json!({"type": "answer", "requestId": "9", "decision": "accept"}))
            .await;
        assert_eq!(said["kind"], "badFrame", "{said}");
    }

    #[tokio::test]
    async fn cancel_sends_session_cancel_and_a_closed_socket_cancels_too() {
        let script = Arc::new(Script::default());
        let (mut tab, mut agent, prompt) = an_opencode_thread(&script).await;
        tab.send(json!({"type": "cancel"}));
        assert_eq!(
            agent.heard().await,
            json!({"jsonrpc": "2.0", "method": "session/cancel",
                   "params": {"sessionId": SESSION}})
        );
        agent
            .reply(&prompt, json!({"stopReason": "cancelled"}))
            .await;
        assert_eq!(tab.next().await["payload"]["state"], "cancelled");

        tab.send(json!({"type": "turn", "text": "again"}));
        assert_eq!(tab.next().await["payload"]["itemId"], "user:2");
        assert_eq!(agent.heard().await["method"], "session/prompt");
        tab.close();
        assert_eq!(agent.heard().await["method"], "session/cancel");
    }

    #[tokio::test]
    async fn an_attach_loads_the_acp_session_and_replays_it() {
        let script = Arc::new(Script {
            threads: vec![place()],
            kept: Some((Harness::Opencode, SESSION.to_owned())),
            ..Script::default()
        });
        let (mut tab, _served) = connect(Arc::clone(&script), Some(THREAD));
        let mut agent = script.agent().await;
        agent.initialized().await;
        let load = agent.heard().await;
        assert_eq!(load["method"], "session/load");
        assert_eq!(
            load["params"],
            json!({"sessionId": SESSION, "cwd": WORKTREE, "mcpServers": []})
        );
        agent
            .update(
                json!({"sessionUpdate": "user_message_chunk", "messageId": "m0",
                           "content": {"type": "text", "text": "list the files"}}),
            )
            .await;
        agent.reply(&load, json!({})).await;

        assert_eq!(
            tab.next().await["payload"],
            json!({"thread": THREAD, "harness": "opencode"})
        );
        let replayed = tab.next().await;
        assert_eq!(replayed["threadId"], THREAD);
        assert_eq!(
            replayed["payload"],
            json!({"streamKind": "user_text", "delta": "list the files", "itemId": "m0"})
        );
        tab.send(json!({"type": "turn", "text": "again", "harness": "opencode"}));
        assert_eq!(tab.next().await["payload"]["itemId"], "user:1");
        let prompt = agent.heard().await;
        assert_eq!(prompt["params"]["sessionId"], SESSION);
        assert_eq!(*script.opened.lock().expect("a lock"), 0, "no new thread");
    }

    #[tokio::test]
    async fn a_harness_it_does_not_know_and_a_harness_change_are_bad_frames() {
        let (mut tab, _served) = connect(Arc::new(Script::default()), None);
        let said = tab
            .next_after(json!({"type": "turn", "text": "hi", "harness": "aider"}))
            .await;
        assert_eq!(said["kind"], "badFrame", "{said}");
        assert_eq!(
            said["said"],
            "`aider` is not a harness: claude, codex, gemini, grok or opencode"
        );

        let claudes = Arc::new(Script {
            threads: vec![place()],
            ..Script::default()
        });
        let (mut tab, _served) = connect(Arc::clone(&claudes), Some(THREAD));
        assert_eq!(tab.next().await["payload"]["harness"], "claude");
        let said = tab
            .next_after(json!({"type": "turn", "text": "hi", "harness": "codex"}))
            .await;
        assert_eq!(said["kind"], "badFrame", "{said}");
        assert_eq!(
            said["said"],
            "this thread is claude's, and a thread keeps its harness"
        );
        assert!(claudes.agents.lock().expect("a lock").is_empty());
    }

    #[tokio::test]
    async fn an_agent_with_no_login_names_the_command_and_the_thread_goes() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "hi", "harness": "opencode"}));
        let mut agent = script.agent().await;
        agent.initialized().await;
        let new = agent.heard().await;
        agent
            .say(json!({"jsonrpc": "2.0", "id": new["id"],
                        "error": {"code": -32000, "message": "Authentication required"}}))
            .await;
        assert_eq!(
            tab.next().await,
            json!({"type": "error", "kind": "notLoggedIn",
                   "said": "the agent refused: Authentication required (-32000)",
                   "harness": "opencode", "machine": "m", "command": "opencode auth login"})
        );
        assert_eq!(*script.removed.lock().expect("a lock"), 1);
        assert!(script.remembered.lock().expect("a lock").is_empty());
    }

    #[tokio::test]
    async fn the_agents_own_login_words_win() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "hi", "harness": "codex"}));
        let mut agent = script.agent().await;
        let request = agent.heard().await;
        agent
            .reply(
                &request,
                json!({"protocolVersion": 1, "agentCapabilities": {},
                       "authMethods": [{"id": "chat-gpt", "name": "ChatGPT",
                                        "description": "Run `codex login` on this machine"}]}),
            )
            .await;
        let new = agent.heard().await;
        agent
            .say(json!({"jsonrpc": "2.0", "id": new["id"],
                        "error": {"code": -32000, "message": "Authentication required"}}))
            .await;
        let said = tab.next().await;
        assert_eq!(said["harness"], "codex");
        assert_eq!(said["command"], "codex login");
        assert!(
            said["said"]
                .as_str()
                .is_some_and(|s| s.contains("Run `codex login` on this machine"))
        );
    }

    #[tokio::test]
    async fn a_claude_turn_with_no_login_says_not_logged_in_after_it_ends() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "hi"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude();
        claude.heard().await;
        claude
            .say(
                json!({"type": "result", "subtype": "success", "is_error": true,
                        "result": "Not logged in · Please run /login"}),
            )
            .await;
        let ended = tab.next().await;
        assert_eq!(ended["payload"]["state"], "failed", "{ended}");
        assert_eq!(
            tab.next().await,
            json!({"type": "error", "kind": "notLoggedIn",
                   "said": "Not logged in · Please run /login",
                   "harness": "claude", "machine": "m",
                   "command": "run claude and type /login"})
        );
    }

    /// An agent that has gone ends its events once, and the loop does not
    /// spin on the end.
    #[tokio::test]
    async fn listen_stops_reading_events_that_have_ended() {
        let (ours, _theirs) = tokio::io::duplex(64);
        let (read, write) = tokio::io::split(ours);
        let (agent, _) = Agent::over(Harness::Opencode, read, write);
        let (sender, events) = tokio::sync::mpsc::unbounded_channel();
        drop(sender);
        let mut here = Some(Conversation {
            place: place(),
            speaker: Speaker::Acp(Box::new(super::Acp {
                harness: Harness::Opencode,
                agent: Arc::new(agent),
                events: Some(events),
                session: SESSION.to_owned(),
                login: None,
                asked: HashMap::new(),
                prompt: None,
            })),
        });
        assert!(matches!(listen(&mut here).await, Step::Event(None)));
        let again = tokio::time::timeout(Duration::from_millis(100), listen(&mut here)).await;
        assert!(again.is_err(), "nothing runs, so nothing is heard");
    }

    #[tokio::test]
    async fn an_agent_that_closed_is_unreachable_in_its_own_words() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "hi", "harness": "grok"}));
        drop(script.agent().await);
        assert_eq!(
            tab.next().await,
            json!({"type": "error", "kind": "unreachable",
                   "said": "the agent closed the connection"})
        );
        assert_eq!(*script.removed.lock().expect("a lock"), 1);
    }

    fn refusal(id: &Value, code: i64, message: &str) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
    }

    /// R19 §1: opencode's `session/new` needs no login, so a lapsed one
    /// arrives as the refusal of a prompt.
    #[tokio::test]
    async fn a_prompt_the_agent_refuses_ends_the_turn_and_then_says_why() {
        for (code, message, then) in [
            (
                -32000,
                "Authentication required",
                json!({"type": "error", "kind": "notLoggedIn",
                       "said": "the agent refused: Authentication required (-32000)",
                       "harness": "opencode", "machine": "m", "command": "opencode auth login"}),
            ),
            (
                -32603,
                "Internal error",
                json!({"type": "error", "kind": "unreachable",
                       "said": "the agent refused: Internal error (-32603)"}),
            ),
        ] {
            let script = Arc::new(Script::default());
            let (mut tab, mut agent, prompt) = an_opencode_thread(&script).await;
            agent.say(refusal(&prompt["id"], code, message)).await;
            let ended = tab.next().await;
            assert_eq!(ended["type"], "turn.completed", "{ended}");
            assert_eq!(ended["payload"]["state"], "failed", "{ended}");
            assert_eq!(tab.next().await, then);
            assert_eq!(
                *script.removed.lock().expect("a lock"),
                0,
                "the thread stays"
            );
        }
    }

    #[tokio::test]
    async fn an_attach_that_cannot_recall_the_harness_is_unreachable() {
        let script = Arc::new(Script {
            threads: vec![place()],
            recall_fails: true,
            ..Script::default()
        });
        let (mut tab, served) = connect(Arc::clone(&script), Some(THREAD));
        assert_eq!(
            tab.next().await,
            json!({"type": "error", "kind": "unreachable",
                   "said": "git config: ssh: connection reset"})
        );
        served.await.expect("the socket ends");
        assert_eq!(*script.removed.lock().expect("a lock"), 0);
    }

    #[tokio::test]
    async fn an_agent_that_cannot_load_starts_a_new_session_in_the_thread() {
        let script = Arc::new(Script {
            threads: vec![place()],
            kept: Some((Harness::Opencode, SESSION.to_owned())),
            ..Script::default()
        });
        let (_tab, _served) = connect(Arc::clone(&script), Some(THREAD));
        let mut agent = script.agent().await;
        let initialize = agent.heard().await;
        agent
            .reply(
                &initialize,
                json!({"protocolVersion": 1, "agentCapabilities": {}}),
            )
            .await;
        assert_eq!(agent.heard().await["method"], "session/new");
    }

    #[tokio::test(start_paused = true)]
    async fn an_agent_that_never_answers_is_unreachable_and_frees_the_socket() {
        let script = Arc::new(Script {
            threads: vec![place()],
            kept: Some((Harness::Opencode, SESSION.to_owned())),
            ..Script::default()
        });
        let (mut tab, served) = connect(Arc::clone(&script), Some(THREAD));
        let mut agent = script.agent().await;
        assert_eq!(agent.heard().await["method"], "initialize");
        tokio::time::advance(CONNECT_WITHIN + Duration::from_secs(1)).await;
        let said = tab.next().await;
        assert_eq!(said["kind"], "unreachable", "{said}");
        assert!(
            said["said"]
                .as_str()
                .is_some_and(|s| s.contains("within 60 seconds"))
        );
        served.await.expect("the socket ends");
    }

    #[tokio::test]
    async fn a_session_the_agent_will_not_load_is_named_and_the_thread_stays() {
        for (code, message, kind) in [
            (-32000, "Authentication required", "notLoggedIn"),
            (-32603, "Internal error", "unreachable"),
        ] {
            let script = Arc::new(Script {
                threads: vec![place()],
                kept: Some((Harness::Opencode, SESSION.to_owned())),
                ..Script::default()
            });
            let (mut tab, served) = connect(Arc::clone(&script), Some(THREAD));
            let mut agent = script.agent().await;
            agent.initialized().await;
            let load = agent.heard().await;
            assert_eq!(load["method"], "session/load");
            agent.say(refusal(&load["id"], code, message)).await;
            let said = tab.next().await;
            assert_eq!(said["kind"], kind, "{said}");
            assert_eq!(
                said["said"],
                format!("the agent refused: {message} ({code})")
            );
            served.await.expect("the socket ends");
            assert_eq!(
                *script.removed.lock().expect("a lock"),
                0,
                "the thread stays"
            );
        }
    }

    #[tokio::test]
    async fn an_agent_that_will_not_start_is_unreachable() {
        let script = Arc::new(Script {
            start_acp_fails: true,
            ..Script::default()
        });
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "hi", "harness": "gemini"}));
        let unreachable = json!({"type": "error", "kind": "unreachable",
                                 "said": "ssh: could not start the agent"});
        assert_eq!(tab.next().await, unreachable);
        assert_eq!(
            *script.removed.lock().expect("a lock"),
            1,
            "a new thread goes"
        );

        let kept = Arc::new(Script {
            threads: vec![place()],
            kept: Some((Harness::Opencode, SESSION.to_owned())),
            start_acp_fails: true,
            ..Script::default()
        });
        let (mut tab, served) = connect(Arc::clone(&kept), Some(THREAD));
        assert_eq!(tab.next().await, unreachable);
        served.await.expect("the socket ends");
        assert_eq!(
            *kept.removed.lock().expect("a lock"),
            0,
            "a kept thread stays"
        );
    }

    #[tokio::test]
    async fn a_session_it_cannot_remember_is_unreachable_and_the_thread_goes() {
        let script = Arc::new(Script {
            remember_fails: true,
            ..Script::default()
        });
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "hi", "harness": "opencode"}));
        let mut agent = script.agent().await;
        agent.initialized().await;
        let new = agent.heard().await;
        agent
            .reply(&new, json!({"sessionId": SESSION, "configOptions": []}))
            .await;
        assert_eq!(
            tab.next().await,
            json!({"type": "error", "kind": "unreachable",
                   "said": "git config: could not lock config file"})
        );
        assert_eq!(*script.removed.lock().expect("a lock"), 1);
    }

    #[tokio::test]
    async fn a_decision_the_agent_did_not_offer_is_a_bad_frame_and_reaches_nobody() {
        let script = Arc::new(Script::default());
        let (mut tab, mut agent, _prompt) = an_opencode_thread(&script).await;
        agent
            .say(
                json!({"jsonrpc": "2.0", "id": 8, "method": "session/request_permission",
                   "params": {"sessionId": SESSION,
                       "toolCall": {"toolCallId": "call_1", "title": "ls", "kind": "execute"},
                       "options": [
                           {"optionId": "once", "name": "Allow once", "kind": "allow_once"},
                           {"optionId": "reject", "name": "Reject", "kind": "reject_once"}]}}),
            )
            .await;
        let request = tab.next().await["payload"]["requestId"].clone();
        let said = tab
            .next_after(json!({"type": "answer", "requestId": request, "decision": "acceptAlways"}))
            .await;
        assert_eq!(said["kind"], "badFrame", "{said}");
        assert_eq!(
            said["said"],
            format!(
                "request `{}` offered no AcceptAlways",
                request.as_str().expect("an id")
            )
        );

        // The next line the agent hears is the answer it was offered.
        tab.send(json!({"type": "answer", "requestId": request, "decision": "accept"}));
        assert_eq!(
            agent.heard().await,
            json!({"jsonrpc": "2.0", "id": 8,
                   "result": {"outcome": {"outcome": "selected", "optionId": "once"}}})
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

    /// A PNG's magic, then `len` bytes in all.
    fn png(len: usize) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.resize(len, 0x5a);
        bytes
    }

    /// Y-424: a screenshot reaches the machine whole, and the reply names
    /// where it landed.
    #[tokio::test]
    async fn a_10_mb_image_reaches_the_machine_and_the_reply_names_its_path() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send_image(png(10_000_000));
        assert_eq!(
            tab.next().await,
            json!({"type": "attached", "path": format!("{IMAGES}/1.png")})
        );
        assert_eq!(*script.put.lock().expect("a lock"), [10_000_000]);
    }

    #[tokio::test]
    async fn a_frame_that_is_not_an_image_is_refused_and_the_socket_stays_open() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send_image(b"<svg onload=alert(1)>".to_vec());
        assert_eq!(
            tab.next().await,
            json!({"type": "notAttached", "kind": "notAnImage",
                   "said": "that is not a PNG, JPEG, GIF or WebP image"})
        );
        assert!(script.put.lock().expect("a lock").is_empty());

        tab.send(json!({"type": "turn", "text": "still here"}));
        assert_eq!(tab.next().await["type"], "thread.started");
    }

    #[tokio::test]
    async fn an_image_the_machine_cannot_write_is_unreachable() {
        let script = Arc::new(Script {
            put_fails: true,
            ..Script::default()
        });
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send_image(png(64));
        let said = tab.next().await;
        assert_eq!(said["type"], "notAttached", "{said}");
        assert_eq!(said["kind"], "unreachable", "{said}");
        assert!(
            said["said"]
                .as_str()
                .is_some_and(|said| said.contains("No space left on device")),
            "{said}"
        );
    }

    /// Two images and a junk frame between them: one reply each, in order.
    #[tokio::test]
    async fn every_image_gets_one_reply_in_order() {
        let (mut tab, _served) = connect(Arc::new(Script::default()), None);
        tab.send_image(png(64));
        tab.send_image(b"GIF8".to_vec());
        tab.send_image(png(128));
        assert_eq!(tab.next().await["path"], format!("{IMAGES}/1.png"));
        assert_eq!(tab.next().await["kind"], "notAnImage");
        assert_eq!(tab.next().await["path"], format!("{IMAGES}/2.png"));
    }

    #[tokio::test]
    async fn a_claude_turn_after_an_image_may_read_its_directory() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "before"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude();
        claude.heard().await;
        claude
            .say(json!({"type": "result", "subtype": "success", "is_error": false}))
            .await;
        assert_eq!(tab.next().await["type"], "turn.completed");

        tab.send_image(png(64));
        assert_eq!(tab.next().await["type"], "attached");
        tab.send(json!({"type": "turn", "text": format!("what is in {IMAGES}/1.png?")}));
        tab.next().await;
        assert_eq!(
            *script.started_with.lock().expect("a lock"),
            [None, Some(IMAGES.to_owned())]
        );
    }

    async fn closed(script: Arc<Script>, image: bool) -> usize {
        let (mut tab, served) = connect(Arc::clone(&script), None);
        if image {
            tab.send_image(png(64));
            tab.next().await;
        }
        tab.close();
        tokio::time::timeout(Duration::from_secs(5), served)
            .await
            .expect("the socket's task ends")
            .expect("it did not panic");
        *script.cleared.lock().expect("a lock")
    }

    #[tokio::test]
    async fn a_close_removes_the_images_and_a_socket_with_none_removes_nothing() {
        assert_eq!(closed(Arc::new(Script::default()), true).await, 1);
        assert_eq!(closed(Arc::new(Script::default()), false).await, 0);
    }

    /// **Q5 for an image**: the log says one landed, and never a byte of it
    /// or its size.
    #[tokio::test]
    async fn an_image_is_logged_as_attached_and_never_as_bytes() {
        use crate::terminal::tests::Capture;
        let capture = Capture::default();
        let writer = capture.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            // A timestamp can hold the image size's digits.
            .without_time()
            .with_max_level(tracing::Level::TRACE)
            .with_writer(move || writer.clone())
            .finish();
        let _logging = tracing::subscriber::set_default(subscriber);

        let script = Arc::new(Script::default());
        let (mut tab, served) = connect(Arc::clone(&script), None);
        let mut marked = png(8);
        marked.extend_from_slice(b"pasted-as-image-bytes");
        let size = marked.len();
        tab.send_image(marked);
        assert_eq!(tab.next().await["type"], "attached");
        tab.close();
        tokio::time::timeout(Duration::from_secs(5), served)
            .await
            .expect("the socket's task ends")
            .expect("it did not panic");

        let logged = String::from_utf8_lossy(&capture.0.lock().expect("the log")).into_owned();
        assert!(logged.contains("chat web: image attached"), "{logged}");
        assert!(!logged.contains("pasted-as-image-bytes"), "{logged}");
        assert!(!logged.contains(&size.to_string()), "{logged}");
    }

    /// A client frame with a 64-bit length and a zero mask.
    async fn send_big(socket: &mut BufReader<TcpStream>, payload: &[u8]) {
        let mut head = vec![0x82, 0x80 | 127];
        head.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        head.extend_from_slice(&[0, 0, 0, 0]);
        // The daemon may drop a socket whose frame is over the limit mid-write.
        let _ = socket.get_mut().write_all(&head).await;
        let _ = socket.get_mut().write_all(payload).await;
    }

    /// What a socket with the route's limits says to one binary frame: its
    /// length, or nothing when the frame was refused.
    async fn heard_of(payload: &[u8]) -> Option<String> {
        use crate::terminal::tests::{TEXT, connect_to, frame};
        let api = Router::new().route(
            "/big",
            get(|upgrade: WebSocketUpgrade| async move {
                sized(upgrade).on_upgrade(|mut socket| async move {
                    if let Some(Ok(Message::Binary(bytes))) = socket.recv().await {
                        let _ = socket
                            .send(Message::Text(bytes.len().to_string().into()))
                            .await;
                    }
                })
            }),
        );
        let mut socket = connect_to(api, "/api/big", "").await;
        let mut line = String::new();
        while line != "\r\n" {
            line.clear();
            socket.read_line(&mut line).await.expect("a header");
        }
        send_big(&mut socket, payload).await;
        match tokio::time::timeout(Duration::from_secs(10), frame(&mut socket)).await {
            Ok(Ok((TEXT, said))) => Some(String::from_utf8_lossy(&said).into_owned()),
            _ => None,
        }
    }

    /// The route's own limit holds a 10 MB screenshot and refuses what is over it.
    #[tokio::test]
    async fn the_socket_takes_a_10_mb_screenshot_and_nothing_over_its_limit() {
        assert_eq!(
            heard_of(&png(10_000_000)).await.as_deref(),
            Some("10000000")
        );
        assert_eq!(heard_of(&png(IMAGE_LIMIT + 1)).await, None);
    }
}
