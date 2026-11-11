//! `GET /api/workspaces/{name}/chat?thread=<id>&after=<cursor>` — a chat
//! thread on a WebSocket ([ADR-0026] decision 3).
//!
//! A thread is a worktree of the workspace's repository ([`thread`]), and one
//! harness speaks in it, chosen by the turn that opens it. Claude is one
//! `claude -p` that lives across turns ([`yantra_core::claude`], [ADR-0041]).
//! Every other harness is one ACP agent ([`yantra_core::acp`], [ADR-0033]
//! decision 2). The thread's git config keeps either one's session id. Without `?thread=` the first turn opens a
//! thread and the socket says so with `thread.started`; with it, the socket
//! says `thread.started` too, replays the conversation and continues there.
//!
//! **`GET /api/machines/{machine}/chat` is a home thread** ([ADR-0046]
//! decision 1): Claude in the joined account's `$HOME`, with no workspace,
//! worktree or checkpoint. The thread store holds it, and its keeper takes
//! [`keep::HOME`] in the workspace slot. `revert` and `diff` get `badFrame`.
//!
//! **A turn outlives its socket** ([ADR-0035]). Each agent runs in a keeper on
//! its machine ([`yantra_core::keep`]), a tmux session that is also the
//! thread's lock. A [`Registry`] in the daemon holds every live keeper: it
//! reads each one, answers what the turn's mode answers, keeps the checkpoint
//! at a turn's end and removes the keeper's session. A socket subscribes to its
//! thread's keeper and owns nothing, so a socket that closes detaches. Only the
//! `cancel` frame and the thread's removal stop a turn. `?after=` is the last
//! cursor the browser drew, and the socket sends only the events after it.
//!
//! The browser sends seven frames, `turn`, `answer`, `cancel`, `revert`,
//! `diff`, `stopTask` and `stopAll`, and one turn runs at a time in a thread,
//! across every tab and every restart. The daemon sends [`ThreadEvent`]s and
//! one typed [`Failure`].
//!
//! **A Claude keeper holds the thread, not the turn** ([ADR-0041]). A
//! background task outlives its turn, and its end opens a wake turn that gets
//! its own checkpoint and diff. `cancel` stops the turn and leaves the tasks,
//! `stopTask` stops one, and `stopAll` stops every one and closes the keeper.
//! A keeper closes after [`CLAUDE_IDLE`] with no turn and no task. A task pins
//! it open until Claude has been silent for [`PIN`]. A turn that ends with no
//! socket attached sends one notification.
//!
//! **A `turn` sent while one runs is queued** (Y-561): every socket of the
//! thread gets a [`QueueFrame`], an attaching one too, empty or not, and the
//! turn's end sends the queue as one prompt. `cancel` empties it. A socket
//! follows the next keeper of its thread. A revert starts only with no turn
//! started, running or queued, and none starts or queues while it runs.
//!
//! **Each `turn` carries the thread's [`PermissionMode`]** (Y-453), and the
//! keeper's `mode` file keeps it for a daemon that adopts the turn. A request
//! the mode answers is answered here and never relayed, so the browser shows
//! no card for it. On a Claude thread, `auto` and `auto-accept-edits` reach the
//! harness as Claude's own `--permission-mode`, and the daemon answers nothing
//! for them. On an ACP thread, `auto-accept-edits` accepts only an edit inside
//! the worktree. No mode answers a question to the person. A request nobody is
//! attached to see sends one Y-451 notification, which names only the
//! workspace and the thread.
//!
//! **A `turn` may carry `interaction: plan`** (Y-565), on a Claude thread
//! only; any other harness gets `badFrame`. Claude runs in its own plan mode,
//! and the turn runs as `supervised` whatever its mode, so the daemon accepts
//! nothing for it and the keeper's `mode` file says `supervised`. A room wake
//! is never a plan turn.
//! **A `turn` may name a [`Model`], an [`Effort`] and a [`ContextLength`]**
//! (Y-564, Y-663). A Claude keeper starts with them as `--model`, `--effort`
//! and `--autocompact`, and a later turn that changes one sets it on the live
//! process (ADR-0041 decision 5). An ACP turn ignores the model and effort. A
//! Codex keeper starts with the length of the turn that starts it, as
//! `model_auto_compact_token_limit`; a later change does not reach a running
//! `codex-acp`. Gemini, Grok and opencode ignore the length.
//!
//! **Each turn ends in a checkpoint** (Y-448, [`checkpoint`]): the first turn
//! keeps the tree before it, each turn's end keeps the tree after it and sends
//! `turn.diff.updated`, and `revert` puts the files back as a checkpoint kept
//! them. The conversation is not rewound.
//!
//! **`diff` gets one [`BranchDiffReply`]** (Y-490): everything the thread
//! changed since its branch left the repository's `HEAD`, read through a
//! private index. It runs beside the socket's loop, so a turn's events and a
//! `cancel` still flow, and a revert in the thread refuses it as busy.
//!
//! **A binary frame is an image** (Y-424). It goes to the thread's keeper
//! directory through [`Images`] and gets exactly one [`Attachment`] in reply,
//! in order. A Claude turn may read that directory, and `thread::remove`
//! deletes it with the thread. The daemon writes nothing of it to disk.
//!
//! **An upgrade is a `GET`**, so [`allowed`] is called by name before it, as
//! in [`crate::terminal`]. Q5 holds: the socket's lifecycle is logged, and not
//! one word of a prompt, a reply or a tool's output is.
//!
//! [ADR-0026]: ../../../docs/adr/0026-the-chat-is-a-stream-json-bridge-in-the-daemon.md
//! [ADR-0033]: ../../../docs/adr/0033-other-harnesses-speak-acp-and-claude-delegates.md
//! [ADR-0035]: ../../../docs/adr/0035-a-chat-turn-outlives-its-ssh-pipe.md
//! [ADR-0041]: ../../../docs/adr/0041-a-claude-keeper-holds-the-thread.md
//! [ADR-0046]: ../../../docs/adr/0046-the-owner-types-sudo-in-an-owner-terminal.md

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use axum::routing::get;
use serde::{Deserialize, Serialize};
use tokio::sync::{OnceCell, broadcast, mpsc, oneshot, watch};
use tokio::time::MissedTickBehavior;
use yantra_core::acp::{self, Agent, Answer, Harness};
use yantra_core::chat::{
    ContentDelta, ContextLength, Decision, Effort, Event, Interaction, Model, PermissionMode,
    RequestOption, Scope, StopReason, StreamKind, ThreadEvent, TurnDiff, TurnState,
};
use yantra_core::checkpoint::{self, BranchDiff, Diff};
use yantra_core::claude::{self, Events, Said, Session};
use yantra_core::image::{self, Images};
use yantra_core::inventory::Inventory;
use yantra_core::keep::{self, Cursor, File, Keeper, Limits};
use yantra_core::logs::{self, Who};
use yantra_core::notify::{self, Phase, Relay};
use yantra_core::room;
use yantra_core::ssh::{self, Exec as _, Ssh};
use yantra_core::thread::{self, Place};
use yantra_core::tmux::Tmux;
use yantra_core::workspace::{self, Workspace};

use crate::store::Store;
use crate::terminal::{MISSES, PING_EVERY};
use crate::write::{Authoriser, Refused, allowed, chain, checked};

/// How many transcript records an attach replays.
const HISTORY: usize = 200;
/// How long a cancelled turn has to end by itself before its keeper is
/// killed, and how long a closed keeper has to exit before its session is
/// removed.
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
/// How long one checkpoint call may take. Meanwhile no frame is read.
const CHECKPOINT_WITHIN: Duration = Duration::from_secs(60);
/// An ACP keeper with no turn and no socket for this long stops (ADR-0035
/// decision 7).
const IDLE: Duration = Duration::from_secs(15 * 60);
/// How often an ACP keeper looks at whether it is idle.
const IDLE_TICK: Duration = Duration::from_secs(60);
/// A Claude keeper with no turn and no background task for this long closes
/// (ADR-0041 decision 4).
const CLAUDE_IDLE: Duration = Duration::from_secs(30 * 60);
/// A background task holds a Claude keeper open until Claude has said nothing
/// for this long, T3 Code's `DEFAULT_MAX_IDLE_PIN_MS`.
const PIN: Duration = Duration::from_secs(4 * 60 * 60);
/// How many events a slow socket may fall behind before it is closed, to
/// reconnect from its cursor.
const BACKLOG: usize = 4096;

#[derive(Clone)]
struct Chats<I> {
    authoriser: Authoriser<I>,
    registry: Registry,
}

pub fn router<I, S>(authoriser: Authoriser<I>, registry: Registry) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/workspaces/{name}/chat", get(chat::<I>))
        .route("/machines/{machine}/chat", get(home_chat::<I>))
        .with_state(Chats {
            authoriser,
            registry,
        })
}

async fn chat<I: Inventory + Clone + Send + Sync + 'static>(
    State(Chats {
        authoriser,
        registry,
    }): State<Chats<I>>,
    ConnectInfo(from): ConnectInfo<crate::write::Peer>,
    headers: HeaderMap,
    Path(name): Path<String>,
    uri: Uri,
    upgrade: WebSocketUpgrade,
) -> Result<Response, Refused> {
    let caller = allowed(&authoriser, &from, &headers).await?;
    let query = read_query(&uri);
    tracing::info!("chat {name} for {}", caller.node);
    Ok(served(upgrade, name.clone(), query, move || {
        Fleet::of(&name, registry)
    }))
}

/// `GET /api/machines/{machine}/chat`: a home thread, which has no workspace
/// (ADR-0046 decision 1.6, ADR-0026 decision 3's session-addressed form).
async fn home_chat<I: Inventory + Clone + Send + Sync + 'static>(
    State(Chats {
        authoriser,
        registry,
    }): State<Chats<I>>,
    ConnectInfo(from): ConnectInfo<crate::write::Peer>,
    headers: HeaderMap,
    Path(machine): Path<String>,
    uri: Uri,
    upgrade: WebSocketUpgrade,
) -> Result<Response, Refused> {
    let caller = allowed(&authoriser, &from, &headers).await?;
    checked(&machine)?;
    let query = read_query(&uri);
    tracing::info!("chat home on {machine} for {}", caller.node);
    Ok(served(upgrade, keep::HOME.to_owned(), query, move || {
        Home::on(&machine, registry)
    }))
}

/// Upgrades to a conversation on the machine `machine` makes.
fn served<M: Machine>(
    upgrade: WebSocketUpgrade,
    name: String,
    query: ChatQuery,
    machine: impl FnOnce() -> Result<M, String> + Send + 'static,
) -> Response {
    sized(upgrade).on_upgrade(move |mut socket| async move {
        match machine() {
            Ok(machine) => converse(Arc::new(machine), &name, query, &mut socket).await,
            Err(said) => {
                tracing::warn!("chat {name}: {said}");
                let _ = socket.say(&failure(Kind::Unreachable, said)).await;
            }
        }
        // A close frame is how the browser tells an end the daemon chose from
        // a dropped network, which it reopens.
        let _ = socket.send(Message::Close(None)).await;
        let _ = tokio::time::timeout(CLEAR_WITHIN, async {
            while let Some(Ok(_)) = socket.recv().await {}
        })
        .await;
        tracing::info!("chat {name} ended");
    })
}

/// tungstenite's own limits are 64 MiB a message and 16 MiB a frame.
fn sized(upgrade: WebSocketUpgrade) -> WebSocketUpgrade {
    upgrade
        .max_message_size(IMAGE_LIMIT)
        .max_frame_size(IMAGE_LIMIT)
}

/// The route's query, as the browser writes it.
#[derive(Debug, Default, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(Serialize))]
struct ChatQuery {
    /// The thread to attach to. It is compared with what git lists and never
    /// reaches a shell.
    #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
    thread: Option<String>,
    /// The last cursor the browser drew (ADR-0035 decision 8).
    #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
    after: Option<String>,
}

/// Read by hand as `terminal.rs` reads `?at=`, with the percent-decoding a
/// cursor's `:` needs.
fn read_query(uri: &Uri) -> ChatQuery {
    let mut query = ChatQuery::default();
    for pair in uri.query().unwrap_or_default().split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let value = decoded(value).filter(|value| !value.is_empty());
        match key {
            "thread" => query.thread = value,
            "after" => query.after = value,
            _ => {}
        }
    }
    query
}

fn decoded(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
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
        /// Holds for this turn; the browser keeps it between turns.
        #[serde(default)]
        mode: PermissionMode,
        /// Holds for this turn, as `mode` does. Only Claude has a plan mode.
        #[serde(default)]
        #[cfg_attr(test, serde(skip_serializing_if = "is_build"))]
        interaction: Interaction,
        /// Claude's `--model` and `--effort`, each only when picked.
        #[serde(default)]
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        model: Option<Model>,
        #[serde(default)]
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        effort: Option<Effort>,
        /// The tokens a thread fills before it compacts, only when picked.
        #[serde(default, rename = "contextLength")]
        #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
        context: Option<ContextLength>,
    },
    Answer {
        #[serde(rename = "requestId")]
        request_id: String,
        decision: Decision,
        /// The labels chosen for each question text, for a question.
        #[serde(default)]
        answers: Option<BTreeMap<String, Vec<String>>>,
    },
    Cancel,
    /// Puts the thread's files back as checkpoint `turn` kept them.
    Revert {
        turn: u32,
    },
    /// Asks for the thread's whole-branch diff.
    Diff,
    /// Stops one of Claude's background tasks.
    StopTask {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    /// Stops the turn and every background task, and closes the keeper.
    StopAll,
    /// A browser cannot send a protocol ping, so it sends this and waits for a [`Pong`].
    Ping,
}

/// The answer to [`Frame::Ping`]. It proves the socket is alive, nothing more.
#[derive(Debug, Serialize)]
struct Pong {
    #[serde(rename = "type")]
    tag: &'static str,
}

/// The one frame the daemon sends that is not a [`ThreadEvent`].
#[derive(Debug, Clone, Serialize)]
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

/// The reply to a `diff` frame. Like [`Attachment`], it is no journalled event.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchDiffReply {
    #[serde(rename = "type")]
    tag: &'static str,
    thread_id: String,
    /// The merge-base of the thread's branch and the repository's `HEAD`.
    base: String,
    files: Vec<ChangedFile>,
    files_truncated: bool,
    unified_diff: String,
    truncated: bool,
}

/// No counts is a binary file; `from` is a rename's old path.
#[derive(Debug, Serialize)]
struct ChangedFile {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted: Option<u32>,
}

impl BranchDiffReply {
    fn of(place: &Place, diff: BranchDiff) -> Self {
        Self {
            tag: "branchDiff",
            thread_id: thread::name(place).to_owned(),
            base: diff.base,
            files: diff
                .files
                .into_iter()
                .map(|file| ChangedFile {
                    path: file.path,
                    from: file.from,
                    added: file.added,
                    deleted: file.deleted,
                })
                .collect(),
            files_truncated: diff.files_truncated,
            unified_diff: diff.diff.unified,
            truncated: diff.diff.truncated,
        }
    }
}

/// The turns a person sent while one runs, as they are now. Like
/// [`BranchDiffReply`], it is no journalled event.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueFrame {
    #[serde(rename = "type")]
    tag: &'static str,
    thread_id: String,
    texts: Vec<String>,
}

impl QueueFrame {
    /// The queue of the thread whose keeper is `id`.
    fn of(id: &str, next: &[Next]) -> Self {
        Self {
            tag: "queue",
            thread_id: id.rsplit('/').next().unwrap_or(id).to_owned(),
            texts: next.iter().map(|next| next.text.clone()).collect(),
        }
    }
}

/// The browser sends no `interaction` for a build turn.
#[cfg(test)]
fn is_build(interaction: &Interaction) -> bool {
    *interaction == Interaction::Build
}

/// One turn: what the person or a room wrote, and the thread's permission and
/// interaction modes. A turn sent while one runs is held as one for that turn's end.
struct Next {
    text: String,
    mode: PermissionMode,
    interaction: Interaction,
    model: Option<Model>,
    effort: Option<Effort>,
    context: Option<ContextLength>,
    /// A room's turn, which keeps the model, effort and context length the
    /// thread runs with.
    room: bool,
}

impl Next {
    fn prompt(&self) -> claude::Prompt<'_> {
        claude::Prompt {
            text: &self.text,
            mode: self.mode,
            interaction: self.interaction,
            model: self.model.as_ref(),
            effort: self.effort,
            context: self.context,
        }
    }
}

/// The held turns as one: their texts joined with a blank line, with the last one's modes,
/// model, effort and context length.
fn joined(mut next: Vec<Next>) -> Option<Next> {
    let last = next.pop()?;
    let mut texts: Vec<String> = next.into_iter().map(|next| next.text).collect();
    texts.push(last.text);
    Some(Next {
        text: texts.join("\n\n"),
        ..last
    })
}

/// What a `notLoggedIn` failure names: whose login, where, and how to make it.
#[derive(Debug, Clone, Serialize)]
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
    /// git could not keep, diff or restore a checkpoint.
    Checkpoint,
    /// git could not diff the thread's branch.
    Diff,
    /// A background task could not be stopped.
    StopTask,
}

fn failure(kind: Kind, said: impl Into<String>) -> Failure {
    Failure {
        tag: "error",
        kind,
        said: said.into(),
        login: None,
    }
}

fn busy() -> Failure {
    failure(
        Kind::Busy,
        "a turn is running; stop it or wait for it to end",
    )
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

pub(crate) fn harness_named(name: &str) -> Result<Option<Harness>, String> {
    if name == "claude" {
        return Ok(None);
    }
    name.parse().map(Some).map_err(|_: String| {
        format!("`{name}` is not a harness: claude, codex, gemini, grok or opencode")
    })
}

/// How a start went: the thread's keeper was already there, which means a
/// turn runs, or a new one runs this.
enum Started<T> {
    Busy,
    Running(T),
}

/// A Claude session in a new keeper, the run its cursors carry, and the
/// session id it resumed.
struct KeptClaude {
    session: Session,
    events: Events,
    run: String,
    resumed: Option<String>,
}

/// An ACP agent in a new keeper, and the run its cursors carry.
struct KeptAgent {
    agent: Agent,
    events: acp::Events,
    run: String,
}

/// A keeper this daemon did not start, read back from its journals
/// (ADR-0035 decision 9). `replayed` is every event its `out` made so far.
enum Adopted {
    Claude {
        session: Session,
        events: Events,
        run: String,
        replayed: Vec<ThreadEvent>,
        mode: PermissionMode,
        running: bool,
        prompts: usize,
    },
    Acp {
        agent: Agent,
        events: acp::Events,
        run: String,
        replayed: Vec<ThreadEvent>,
        mode: PermissionMode,
        prompting: bool,
        prompts: usize,
    },
}

/// A keeper's journals, for a socket's replay: `out` up to where the
/// daemon's reader had got, and all of `in`.
struct Journals {
    run: String,
    out: Vec<u8>,
    input: Vec<u8>,
    /// The last lines of `err`, for a turn that ended with no `result`.
    said: String,
}

/// Where a conversation's turns run: a workspace's machine over ssh, or a
/// test's script. These calls are the whole of what the chat asks. Each is
/// `Send`, because a keeper's task outlives the socket that started it.
trait Machine: Send + Sync + 'static {
    /// The machine's name, as a login failure names it.
    fn machine(&self) -> &str;
    fn registry(&self) -> &Registry;
    /// Whether the thread is a git worktree that each turn checkpoints. A home
    /// thread is not, so it skips every checkpoint (ADR-0046 decision 1.3).
    fn tracked(&self) -> bool {
        true
    }
    /// Makes the thread `id` names, an id [`thread::new_id`] gave.
    fn open(&self, id: &str) -> impl Future<Output = Result<Place, String>> + Send;
    fn find(&self, thread: &str) -> impl Future<Output = Result<Option<Place>, String>> + Send;
    /// Removes a thread whose harness never started, so it is not taken for
    /// a Claude thread later.
    fn remove(&self, place: &Place) -> impl Future<Output = Result<(), String>> + Send;
    fn history(
        &self,
        place: &Place,
    ) -> impl Future<Output = Result<Vec<logs::Entry>, String>> + Send;
    /// Starts Claude in a keeper, resuming `resumed`, and sends it `first`.
    fn start(
        &self,
        place: &Place,
        first: &claude::Prompt<'_>,
        resumed: Option<&str>,
    ) -> impl Future<Output = Result<Started<KeptClaude>, String>> + Send;
    /// Writes one image on the machine and returns its path.
    fn put(
        &self,
        images: &mut Images,
        bytes: &[u8],
    ) -> impl Future<Output = Result<String, image::Error>> + Send;
    /// Removes the images of a socket whose thread never opened.
    fn clear(&self, images: &Images) -> impl Future<Output = Result<(), String>> + Send;
    fn recall(
        &self,
        place: &Place,
    ) -> impl Future<Output = Result<Option<(Harness, String)>, String>> + Send;
    fn remember(
        &self,
        place: &Place,
        harness: Harness,
        session: &str,
    ) -> impl Future<Output = Result<(), String>> + Send;
    /// The Claude session id git config keeps.
    fn claude_session(
        &self,
        place: &Place,
    ) -> impl Future<Output = Result<Option<String>, String>> + Send;
    /// Keeps a Claude thread's session id (ADR-0041 decision 8).
    fn remember_claude(
        &self,
        place: &Place,
        session: &str,
    ) -> impl Future<Output = Result<(), String>> + Send;
    /// Keeps the thread's title, for the list of threads.
    fn remember_title(
        &self,
        place: &Place,
        title: &str,
    ) -> impl Future<Output = Result<(), String>> + Send;
    /// Starts `harness` in a keeper that compacts at `context`, for Codex.
    fn start_acp(
        &self,
        place: &Place,
        harness: Harness,
        context: Option<ContextLength>,
    ) -> impl Future<Output = Result<Started<KeptAgent>, String>> + Send;
    /// Reads back the thread's keeper, or `None` when there is none.
    fn adopt(
        &self,
        place: &Place,
        harness: Option<Harness>,
    ) -> impl Future<Output = Result<Option<Adopted>, String>> + Send;
    /// `upto` cuts `out`; `None` reads all of it.
    fn journals(
        &self,
        place: &Place,
        upto: Option<u64>,
    ) -> impl Future<Output = Result<Journals, String>> + Send;
    fn write_mode(
        &self,
        place: &Place,
        mode: PermissionMode,
    ) -> impl Future<Output = Result<(), String>> + Send;
    /// Closes the stdin of keeper `run`'s agent, which ends an ACP agent.
    fn close_stdin(
        &self,
        place: &Place,
        run: &str,
    ) -> impl Future<Output = Result<(), String>> + Send;
    /// How many bytes the keeper's `out` holds.
    fn out_size(&self, place: &Place) -> impl Future<Output = Result<u64, String>> + Send;
    /// Waits up to `within` for the keeper's pane to die, then removes its
    /// session, and says how the keeper ended.
    fn finish(
        &self,
        place: &Place,
        within: Duration,
    ) -> impl Future<Output = Result<Option<String>, String>> + Send;
    fn base(&self, place: &Place) -> impl Future<Output = Result<Option<u32>, String>> + Send;
    fn capture(&self, place: &Place) -> impl Future<Output = Result<u32, String>> + Send;
    fn diff(&self, place: &Place, turn: u32) -> impl Future<Output = Result<Diff, String>> + Send;
    /// The newest checkpoint that has a diff, which is the last turn's.
    fn latest(&self, place: &Place) -> impl Future<Output = Result<Option<u32>, String>> + Send;
    fn revert(&self, place: &Place, turn: u32) -> impl Future<Output = Result<(), String>> + Send;
    fn branch_diff(&self, place: &Place)
    -> impl Future<Output = Result<BranchDiff, String>> + Send;
    /// Kills the keeper of thread `thread`, which is gone, once its agent has
    /// ended. `false` is an agent that still runs.
    fn kill_orphan(&self, thread: &str) -> impl Future<Output = Result<bool, String>> + Send;
}

struct Fleet {
    workspace: Workspace,
    ssh: Ssh,
    tmux: OnceCell<Tmux>,
    registry: Registry,
}

impl Fleet {
    fn of(name: &str, registry: Registry) -> Result<Self, String> {
        let workspace = workspace::load(name).map_err(|error| chain(&error))?;
        Self::on(workspace, registry)
    }

    fn on(workspace: Workspace, registry: Registry) -> Result<Self, String> {
        let machine = ssh::machine_at(&workspace.machine)
            .ok_or("this daemon has no directory for its ssh sockets")?;
        let ssh = Ssh::new(machine).map_err(|error| chain(&error))?;
        Ok(Self {
            workspace,
            ssh,
            tmux: OnceCell::new(),
            registry,
        })
    }

    async fn tmux(&self) -> Result<&Tmux, String> {
        self.tmux
            .get_or_try_init(|| Tmux::resolve(&self.ssh))
            .await
            .map_err(|error| chain(&error))
    }

    /// Starts Claude in the thread's keeper. `mcp` adds the room tools.
    async fn start_claude(
        &self,
        place: &Place,
        first: &claude::Prompt<'_>,
        resumed: Option<&str>,
        mcp: Option<&claude::Mcp>,
    ) -> Result<Started<KeptClaude>, String> {
        let keeper = keeper_of(place)?;
        let tmux = self.tmux().await?;
        let run = keep::run_id().map_err(|error| chain(&error))?;
        let agent = claude::command(
            &place.worktree,
            &keeper,
            first.mode,
            first.interaction,
            first.model,
            first.effort,
            first.context,
            mcp,
            resumed,
        );
        let started = keep::start(&self.ssh, tmux, &keeper, &agent, &run, Limits::default())
            .await
            .map_err(|error| chain(&error))?;
        let keep::Started::Running { pane } = started else {
            return Ok(Started::Busy);
        };
        if let Err(error) = keep::write_mode(&self.ssh, &keeper, &mode_name(first.mode)).await {
            // The lock goes with the start that failed; `keep::stale` catches a
            // kill that fails too.
            let _ = keep::kill(&self.ssh, tmux, &keeper).await;
            return Err(chain(&error));
        }
        let reader = keep::follow(self.ssh.clone(), tmux.clone(), keeper.clone(), pane, 0);
        let writer = keep::feed(self.ssh.clone(), tmux.clone(), keeper.clone(), &run, 0);
        let said = self.said(&keeper);
        let (session, events) =
            Session::kept(reader, writer, thread::name(place), &run, first, said);
        Ok(Started::Running(KeptClaude {
            session,
            events,
            run,
            resumed: resumed.map(str::to_owned),
        }))
    }

    /// What the keeper's `err` says, read once its `out` has ended.
    fn said(&self, keeper: &Keeper) -> Said {
        let (ssh, keeper) = (self.ssh.clone(), keeper.clone());
        Box::pin(async move {
            let err = keep::read(&ssh, &keeper, File::Err, None)
                .await
                .unwrap_or_default();
            last_said(&err)
        })
    }
}

/// The last five lines of a keeper's `err`.
fn last_said(err: &[u8]) -> String {
    let err = String::from_utf8_lossy(err);
    let lines: Vec<&str> = err.lines().filter(|line| !line.is_empty()).collect();
    lines[lines.len().saturating_sub(5)..].join("\n")
}

fn keeper_of(place: &Place) -> Result<Keeper, String> {
    Keeper::of(place).ok_or_else(|| format!("{} is not a chat thread", place.id))
}

fn mode_name(mode: PermissionMode) -> String {
    serde_json::to_value(mode)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn mode_named(name: &str) -> PermissionMode {
    serde_json::from_value(serde_json::Value::String(name.trim().to_owned())).unwrap_or_default()
}

impl Machine for Fleet {
    fn machine(&self) -> &str {
        &self.workspace.machine
    }

    fn registry(&self) -> &Registry {
        &self.registry
    }

    async fn open(&self, id: &str) -> Result<Place, String> {
        thread::open_as(&self.ssh, &self.workspace, id)
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

    async fn start(
        &self,
        place: &Place,
        first: &claude::Prompt<'_>,
        resumed: Option<&str>,
    ) -> Result<Started<KeptClaude>, String> {
        let mcp = self.registry.daemon.map(|daemon| claude::Mcp {
            url: format!("http://{daemon}/api/mcp"),
            thread: format!("{}/{}", self.workspace.name, thread::name(place)),
        });
        self.start_claude(place, first, resumed, mcp.as_ref()).await
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

    async fn claude_session(&self, place: &Place) -> Result<Option<String>, String> {
        thread::claude_session(&self.ssh, place)
            .await
            .map_err(|error| chain(&error))
    }

    async fn remember_claude(&self, place: &Place, session: &str) -> Result<(), String> {
        thread::remember_claude(&self.ssh, place, session)
            .await
            .map_err(|error| chain(&error))
    }

    async fn remember_title(&self, place: &Place, title: &str) -> Result<(), String> {
        thread::remember_title(&self.ssh, place, title)
            .await
            .map_err(|error| chain(&error))
    }

    async fn start_acp(
        &self,
        place: &Place,
        harness: Harness,
        context: Option<ContextLength>,
    ) -> Result<Started<KeptAgent>, String> {
        let keeper = keeper_of(place)?;
        let tmux = self.tmux().await?;
        let run = keep::run_id().map_err(|error| chain(&error))?;
        let started = keep::start(
            &self.ssh,
            tmux,
            &keeper,
            &harness.kept_command(&place.worktree, context),
            &run,
            Limits::default(),
        )
        .await
        .map_err(|error| chain(&error))?;
        let keep::Started::Running { pane } = started else {
            return Ok(Started::Busy);
        };
        let reader = keep::follow(self.ssh.clone(), tmux.clone(), keeper.clone(), pane, 0);
        let writer = keep::feed(self.ssh.clone(), tmux.clone(), keeper.clone(), &run, 0);
        let said = self.said(&keeper);
        let (agent, events) = Agent::kept(harness, reader, writer, &run, context, said);
        Ok(Started::Running(KeptAgent { agent, events, run }))
    }

    async fn adopt(
        &self,
        place: &Place,
        harness: Option<Harness>,
    ) -> Result<Option<Adopted>, String> {
        let keeper = keeper_of(place)?;
        let tmux = self.tmux().await?;
        let Some(pane) = keep::pane(&self.ssh, tmux, &keeper)
            .await
            .map_err(|error| chain(&error))?
        else {
            return Ok(None);
        };
        if keep::stale(&self.ssh, tmux, &keeper)
            .await
            .map_err(|error| chain(&error))?
        {
            // A failed start left it, and nothing will ever feed it.
            keep::kill(&self.ssh, tmux, &keeper)
                .await
                .map_err(|error| chain(&error))?;
            return Ok(None);
        }
        let read = |file| keep::read(&self.ssh, &keeper, file, None);
        let run = String::from_utf8_lossy(&read(File::Run).await.map_err(|e| chain(&e))?)
            .trim()
            .to_owned();
        if run.is_empty() {
            // A start that never wrote `run` left nothing to read back.
            return Ok(None);
        }
        let mode = mode_named(&String::from_utf8_lossy(
            &read(File::Mode).await.map_err(|e| chain(&e))?,
        ));
        let input = read(File::In).await.map_err(|e| chain(&e))?;
        let out = read(File::Out).await.map_err(|e| chain(&e))?;
        let writer = keep::feed(
            self.ssh.clone(),
            tmux.clone(),
            keeper.clone(),
            &run,
            input.len() as u64,
        );
        let said = self.said(&keeper);
        let follow = |offset| {
            keep::follow(
                self.ssh.clone(),
                tmux.clone(),
                keeper.clone(),
                pane.id.clone(),
                offset,
            )
        };
        Ok(Some(match harness {
            None => {
                let replayed = claude::replay(thread::name(place), &run, &out, &input);
                let (events, running, prompts) = (
                    replayed.events.clone(),
                    replayed.running(),
                    replayed.prompts.len(),
                );
                let reader = follow(replayed.offset);
                let (session, live) = Session::resume(reader, writer, replayed, said);
                Adopted::Claude {
                    session,
                    events: live,
                    run,
                    replayed: events,
                    mode,
                    running,
                    prompts,
                }
            }
            Some(harness) => {
                let replayed = acp::replay(&run, &out, &input);
                let (events, prompting, prompts) = (
                    replayed.events.clone(),
                    replayed.prompting(),
                    replayed.prompts,
                );
                let reader = follow(replayed.offset);
                let (agent, live) = Agent::resume(harness, reader, writer, replayed, said);
                Adopted::Acp {
                    agent,
                    events: live,
                    run,
                    replayed: events,
                    mode,
                    prompting,
                    prompts,
                }
            }
        }))
    }

    async fn journals(&self, place: &Place, upto: Option<u64>) -> Result<Journals, String> {
        let keeper = keeper_of(place)?;
        let read = |file, upto| keep::read(&self.ssh, &keeper, file, upto);
        let run = read(File::Run, None).await.map_err(|e| chain(&e))?;
        let out = read(File::Out, upto).await.map_err(|e| chain(&e))?;
        let input = read(File::In, None).await.map_err(|e| chain(&e))?;
        let err = read(File::Err, None).await.map_err(|e| chain(&e))?;
        Ok(Journals {
            run: String::from_utf8_lossy(&run).trim().to_owned(),
            out,
            input,
            said: last_said(&err),
        })
    }

    async fn write_mode(&self, place: &Place, mode: PermissionMode) -> Result<(), String> {
        keep::write_mode(&self.ssh, &keeper_of(place)?, &mode_name(mode))
            .await
            .map_err(|error| chain(&error))
    }

    async fn close_stdin(&self, place: &Place, run: &str) -> Result<(), String> {
        keep::close_stdin(&self.ssh, &keeper_of(place)?, run)
            .await
            .map_err(|error| chain(&error))
    }

    async fn out_size(&self, place: &Place) -> Result<u64, String> {
        keep::size(&self.ssh, &keeper_of(place)?, File::Out)
            .await
            .map_err(|error| chain(&error))
    }

    async fn finish(&self, place: &Place, within: Duration) -> Result<Option<String>, String> {
        let keeper = keeper_of(place)?;
        let tmux = self.tmux().await?;
        let deadline = Instant::now() + within;
        let mut ended = None;
        loop {
            match keep::pane(&self.ssh, tmux, &keeper)
                .await
                .map_err(|error| chain(&error))?
            {
                None => break,
                Some(pane) if pane.dead => {
                    // I-47, I-48: the status and the signal are both read.
                    ended = Some(match (pane.status, pane.signal) {
                        (_, Some(signal)) => format!("on signal {signal}"),
                        (Some(status), None) => format!("with status {status}"),
                        (None, None) => "with no status".to_owned(),
                    });
                    break;
                }
                Some(_) if Instant::now() >= deadline => {
                    ended = Some("killed".to_owned());
                    break;
                }
                Some(_) => tokio::time::sleep(Duration::from_millis(500)).await,
            }
        }
        keep::kill(&self.ssh, tmux, &keeper)
            .await
            .map_err(|error| chain(&error))?;
        Ok(ended)
    }

    async fn base(&self, place: &Place) -> Result<Option<u32>, String> {
        checkpoint::base(&self.ssh, place)
            .await
            .map_err(|error| chain(&error))
    }

    async fn capture(&self, place: &Place) -> Result<u32, String> {
        checkpoint::capture(&self.ssh, place)
            .await
            .map_err(|error| chain(&error))
    }

    async fn diff(&self, place: &Place, turn: u32) -> Result<Diff, String> {
        checkpoint::diff(&self.ssh, place, turn)
            .await
            .map_err(|error| chain(&error))
    }

    async fn latest(&self, place: &Place) -> Result<Option<u32>, String> {
        checkpoint::latest(&self.ssh, place)
            .await
            .map_err(|error| chain(&error))
    }

    async fn revert(&self, place: &Place, turn: u32) -> Result<(), String> {
        checkpoint::revert(&self.ssh, place, turn)
            .await
            .map_err(|error| chain(&error))
    }

    async fn branch_diff(&self, place: &Place) -> Result<BranchDiff, String> {
        checkpoint::branch(&self.ssh, place)
            .await
            .map_err(|error| chain(&error))
    }

    async fn kill_orphan(&self, thread: &str) -> Result<bool, String> {
        let tmux = self.tmux().await?;
        let keeper = Keeper::new(&self.workspace.name, thread);
        let pane = keep::pane(&self.ssh, tmux, &keeper)
            .await
            .map_err(|error| chain(&error))?;
        if pane.is_some_and(|pane| !pane.dead) {
            return Ok(false);
        }
        keep::kill(&self.ssh, tmux, &keeper)
            .await
            .map_err(|error| chain(&error))?;
        Ok(true)
    }
}

/// A home thread's machine (ADR-0046 decision 1): Claude in the joined
/// account's `$HOME`, with no workspace, worktree or checkpoint. The store
/// holds the thread, and the keeper is a fleet's under [`keep::HOME`].
struct Home {
    fleet: Fleet,
    home: OnceCell<String>,
}

const CLAUDE_ONLY: &str = "a home chat runs Claude only";
const NO_STORE: &str = "a home chat needs the thread store";
const NO_TREE: &str = "a home chat has no worktree to checkpoint";

impl Home {
    fn on(machine: &str, registry: Registry) -> Result<Self, String> {
        let workspace = Workspace {
            name: keep::HOME.to_owned(),
            machine: machine.to_owned(),
            repo: std::path::PathBuf::new(),
            startup: None,
        };
        Ok(Self {
            fleet: Fleet::on(workspace, registry)?,
            home: OnceCell::new(),
        })
    }

    fn store(&self) -> Result<&Store, String> {
        self.fleet
            .registry
            .store
            .as_ref()
            .ok_or_else(|| NO_STORE.to_owned())
    }

    /// The far shell expands `$HOME`; the daemon never guesses it.
    async fn home(&self) -> Result<&str, String> {
        let home = self
            .home
            .get_or_try_init(|| async {
                let out = self
                    .fleet
                    .ssh
                    .exec("printf '%s' \"$HOME\"")
                    .await
                    .map_err(|error| chain(&error))?;
                let home = String::from_utf8_lossy(&out.stdout).into_owned();
                if !out.success() || !home.starts_with('/') {
                    return Err(format!("{} named no home directory", self.machine()));
                }
                Ok(home)
            })
            .await?;
        Ok(home)
    }

    async fn place(&self, id: &str) -> Result<Place, String> {
        Ok(Place {
            id: format!("chat/{}/{id}", keep::HOME),
            repo: String::new(),
            worktree: self.home().await?.to_owned(),
            branch: String::new(),
            base: String::new(),
        })
    }
}

impl Machine for Home {
    fn machine(&self) -> &str {
        self.fleet.machine()
    }

    fn registry(&self) -> &Registry {
        &self.fleet.registry
    }

    fn tracked(&self) -> bool {
        false
    }

    async fn open(&self, id: &str) -> Result<Place, String> {
        self.store()?;
        self.place(id).await
    }

    async fn find(&self, id: &str) -> Result<Option<Place>, String> {
        let row = self
            .store()?
            .get("", id)
            .await
            .map_err(|error| chain(&error))?;
        match row.filter(|row| row.machine == self.machine()) {
            Some(_) => self.place(id).await.map(Some),
            None => Ok(None),
        }
    }

    /// The keeper and its journals go, and no file in `$HOME` does.
    async fn remove(&self, place: &Place) -> Result<(), String> {
        let tmux = self.fleet.tmux().await?;
        keep::forget(&self.fleet.ssh, tmux, &keeper_of(place)?)
            .await
            .map_err(|error| chain(&error))
    }

    /// Only the stored session's transcript: every home thread shares the
    /// directory (ADR-0046 decision 1.8).
    async fn history(&self, place: &Place) -> Result<Vec<logs::Entry>, String> {
        let Some((_, session)) = stored(self, place).await else {
            return Ok(Vec::new());
        };
        match logs::read(&self.fleet.ssh, &place.worktree, Some(&session), HISTORY, 0).await {
            Ok(transcript) => Ok(transcript.entries),
            Err(logs::Error::NoTurnYet { .. }) => Ok(Vec::new()),
            Err(error) => Err(chain(&error)),
        }
    }

    /// No room tools: a room addresses a workspace's threads.
    async fn start(
        &self,
        place: &Place,
        first: &claude::Prompt<'_>,
        resumed: Option<&str>,
    ) -> Result<Started<KeptClaude>, String> {
        self.fleet.start_claude(place, first, resumed, None).await
    }

    async fn put(&self, images: &mut Images, bytes: &[u8]) -> Result<String, image::Error> {
        self.fleet.put(images, bytes).await
    }

    async fn clear(&self, images: &Images) -> Result<(), String> {
        self.fleet.clear(images).await
    }

    async fn recall(&self, _: &Place) -> Result<Option<(Harness, String)>, String> {
        Ok(None)
    }

    async fn remember(&self, _: &Place, _: Harness, _: &str) -> Result<(), String> {
        Err(CLAUDE_ONLY.to_owned())
    }

    async fn claude_session(&self, place: &Place) -> Result<Option<String>, String> {
        Ok(stored(self, place).await.map(|(_, session)| session))
    }

    /// The store keeps it, and there is no git config.
    async fn remember_claude(&self, _: &Place, _: &str) -> Result<(), String> {
        Ok(())
    }

    async fn remember_title(&self, _: &Place, _: &str) -> Result<(), String> {
        Ok(())
    }

    async fn start_acp(
        &self,
        _: &Place,
        _: Harness,
        _: Option<ContextLength>,
    ) -> Result<Started<KeptAgent>, String> {
        Err(CLAUDE_ONLY.to_owned())
    }

    async fn adopt(
        &self,
        place: &Place,
        harness: Option<Harness>,
    ) -> Result<Option<Adopted>, String> {
        self.fleet.adopt(place, harness).await
    }

    async fn journals(&self, place: &Place, upto: Option<u64>) -> Result<Journals, String> {
        self.fleet.journals(place, upto).await
    }

    async fn write_mode(&self, place: &Place, mode: PermissionMode) -> Result<(), String> {
        self.fleet.write_mode(place, mode).await
    }

    async fn close_stdin(&self, place: &Place, run: &str) -> Result<(), String> {
        self.fleet.close_stdin(place, run).await
    }

    async fn out_size(&self, place: &Place) -> Result<u64, String> {
        self.fleet.out_size(place).await
    }

    async fn finish(&self, place: &Place, within: Duration) -> Result<Option<String>, String> {
        self.fleet.finish(place, within).await
    }

    async fn base(&self, _: &Place) -> Result<Option<u32>, String> {
        Err(NO_TREE.to_owned())
    }

    async fn capture(&self, _: &Place) -> Result<u32, String> {
        Err(NO_TREE.to_owned())
    }

    async fn diff(&self, _: &Place, _: u32) -> Result<Diff, String> {
        Err(NO_TREE.to_owned())
    }

    async fn latest(&self, _: &Place) -> Result<Option<u32>, String> {
        Err(NO_TREE.to_owned())
    }

    async fn revert(&self, _: &Place, _: u32) -> Result<(), String> {
        Err(NO_TREE.to_owned())
    }

    async fn branch_diff(&self, _: &Place) -> Result<BranchDiff, String> {
        Err(NO_TREE.to_owned())
    }

    async fn kill_orphan(&self, thread: &str) -> Result<bool, String> {
        self.fleet.kill_orphan(thread).await
    }
}

/// A wait or a turn's end that nobody is attached to see (ADR-0035 decision
/// 10, ADR-0041 decision 3). It names the workspace and the thread by its
/// title, and links to the thread, with no word of the request or the reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wait {
    pub workspace: String,
    pub thread: String,
    pub phase: Phase,
    /// The store's title and machine for the thread, filled when it is told.
    pub title: Option<String>,
    pub machine: Option<String>,
}

impl Wait {
    fn new(workspace: &str, thread: &str, phase: Phase) -> Self {
        Self {
            workspace: workspace.to_owned(),
            thread: thread.to_owned(),
            phase,
            title: None,
            machine: None,
        }
    }

    /// `base` is the dashboard's HTTPS origin, when tailscale names this node.
    fn message(&self, base: Option<&str>) -> notify::Message {
        let what = match self.phase {
            Phase::Completed => "finished a turn",
            _ => "waits for an answer",
        };
        let title = self.title.as_deref().unwrap_or("a chat thread");
        notify::Message {
            body: format!("{}: {title} {what}", self.workspace)
                .chars()
                .take(notify::BODY_MAX)
                .collect(),
            title: Some(self.phase.headline().to_owned()),
            priority: None,
            click: base.and_then(|base| self.link(base)),
        }
    }

    /// The thread's page, which for a home thread needs the store's machine.
    fn link(&self, base: &str) -> Option<String> {
        let page = if self.workspace == keep::HOME {
            format!("m/{}/home", encoded(self.machine.as_deref()?))
        } else {
            format!("w/{}", encoded(&self.workspace))
        };
        Some(format!("{base}/{page}?thread={}", encoded(&self.thread)))
    }

    /// A home thread's row has no workspace (ADR-0046 decision 1.4).
    async fn named(&mut self, store: &Store) {
        let workspace = if self.workspace == keep::HOME {
            ""
        } else {
            &self.workspace
        };
        match store.get(workspace, &self.thread).await {
            Ok(Some(row)) => {
                self.title = row.title.filter(|title| !title.trim().is_empty());
                self.machine = Some(row.machine);
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(
                "chat {}: the thread's title could not be read: {error}",
                self.workspace
            ),
        }
    }
}

/// RFC 3986's unreserved characters stay; every other byte is `%XX`.
fn encoded(segment: &str) -> String {
    segment
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                char::from(byte).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// Sends each wait to the relay, one at a time, for the life of the daemon.
pub async fn tell(
    relay: Relay,
    store: Store,
    base: Option<String>,
    mut waits: mpsc::UnboundedReceiver<Wait>,
) {
    while let Some(mut wait) = waits.recv().await {
        wait.named(&store).await;
        if let Err(error) = notify::post(&relay, wait.message(base.as_deref())).await {
            tracing::warn!(
                "chat {}: the wait was not notified: {error}",
                wait.workspace
            );
        }
    }
}

/// What a held thread is doing. A working thread's start is unknown after a
/// restart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Doing {
    Working(Option<SystemTime>),
    Idle,
}

/// Every live keeper this daemon reads, shared by every socket and by the
/// refresh pass that adopts keepers after a restart. It holds nothing on disk
/// (ADR-0035 decision 13).
#[derive(Clone, Default)]
pub struct Registry {
    held: Arc<Mutex<Held>>,
    waits: Option<mpsc::UnboundedSender<Wait>>,
    /// Where a Claude turn reaches the room tools (ADR-0038 decision 2).
    daemon: Option<SocketAddr>,
    /// Bumped when a held thread's turn or tool changes, for room presence.
    changed: watch::Sender<u64>,
    /// The thread store (ADR-0045), which wins over git config for a session.
    store: Option<Store>,
}

#[derive(Default)]
struct Held {
    lives: HashMap<String, Arc<Live>>,
    /// Threads a revert runs in.
    reverting: HashSet<String>,
    /// Keepers a task is starting or reading back, so a refresh pass does not
    /// adopt a keeper between its start and its registration.
    claimed: HashSet<String>,
    /// The mode of each thread's last Claude turn a person sent.
    modes: HashMap<String, PermissionMode>,
    /// Room prompts that wait for a thread's turn to end, each with the
    /// sender that tells its wake what came of it.
    queued: HashMap<String, Vec<Queued>>,
    /// Turns a person sent while one ran, for that turn's end (Y-561).
    next: HashMap<String, Vec<Next>>,
    /// Sockets that follow each thread's next keeper.
    waiters: HashMap<String, Vec<Waiter>>,
    /// Keeper sessions whose workspace or thread is gone, already warned
    /// about. A refresh pass still looks at each.
    gone: HashSet<String>,
}

/// A room prompt held for a thread's next turn.
type Queued = (String, oneshot::Sender<Woke>);

/// A socket's wait for its thread's next keeper: a subscription taken before
/// that keeper's first frame, or why the turn queued for it did not start.
type Waiter = oneshot::Sender<Following>;
type Following = Result<broadcast::Receiver<Sent>, Failure>;

/// What a room's wake of a thread came to (ADR-0038 decision 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Woke {
    /// A turn started with the prompt.
    Started,
    /// No turn started, and a later wake may start one.
    Failed,
    /// No wake reaches this thread: it is an ACP thread, or it is gone.
    Never,
}

impl Held {
    /// Takes the turns held for `live`'s thread, and tells every socket the queue is empty.
    fn drain_next(&mut self, live: &Live) -> Vec<Next> {
        let next = self.next.remove(&live.id).unwrap_or_default();
        if !next.is_empty() {
            live.publish(&QueueFrame::of(&live.id, &[]), None);
        }
        next
    }
}

impl std::fmt::Debug for Registry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registry").finish_non_exhaustive()
    }
}

impl Registry {
    /// A registry whose waits go to `waits`.
    pub fn telling(waits: mpsc::UnboundedSender<Wait>) -> Self {
        Self {
            held: Arc::default(),
            waits: Some(waits),
            daemon: None,
            changed: watch::Sender::default(),
            store: None,
        }
    }

    /// This registry, whose threads keep their sessions in `store` first.
    #[must_use]
    pub fn storing(mut self, store: Store) -> Self {
        self.store = Some(store);
        self
    }

    /// This registry, whose Claude turns reach the room tools at `daemon`.
    #[must_use]
    pub fn reaching(mut self, daemon: SocketAddr) -> Self {
        self.daemon = Some(daemon);
        self
    }

    fn lock(&self) -> MutexGuard<'_, Held> {
        self.held.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn live(&self, id: &str) -> Option<Arc<Live>> {
        self.lock().lives.get(id).cloned()
    }

    /// Whether this daemon reads the keeper `session` names.
    pub fn holds(&self, session: &str) -> bool {
        Keeper::parse(session).is_some_and(|keeper| {
            let id = format!("chat/{}/{}", keeper.workspace(), keeper.thread());
            let held = self.lock();
            held.lives.contains_key(&id) || held.claimed.contains(&id)
        })
    }

    /// What each thread of workspace `name` that this daemon holds is doing, by
    /// short id. Read from memory.
    pub fn doing(&self, name: &str) -> Vec<(String, Doing)> {
        let prefix = format!("chat/{name}/");
        self.lock()
            .lives
            .values()
            .filter_map(|live| {
                let short = live.id.strip_prefix(&prefix)?;
                Some((short.to_owned(), live.doing()))
            })
            .collect()
    }

    /// What thread `thread` of `workspace` is doing, when this daemon holds it.
    pub fn doing_in(&self, workspace: &str, thread: &str) -> Option<Doing> {
        Some(self.live(&format!("chat/{workspace}/{thread}"))?.doing())
    }

    /// Whether thread `thread` of `workspace` runs a turn, and its tool. `None`
    /// is a thread this daemon holds no keeper for. Read from memory.
    pub fn activity(&self, workspace: &str, thread: &str) -> Option<room::Activity> {
        let live = self.live(&format!("chat/{workspace}/{thread}"))?;
        let state = live.lock();
        Some(room::Activity {
            busy: state.busy,
            tool: state.tool.as_ref().map(|(_, tool)| tool.clone()),
        })
    }

    /// Changes each time [`Self::activity`] may answer otherwise.
    pub fn changed(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    /// Whether a turn runs, starts, keeps its checkpoint or reverts in thread
    /// `id`, so a commit or a push there must wait (Y-544).
    pub fn occupied(&self, id: &str) -> bool {
        let held = self.lock();
        held.reverting.contains(id)
            || held.claimed.contains(id)
            || held.lives.get(id).is_some_and(|live| live.unsettled())
    }

    /// Holds a keeper for thread `id`, busy or not, for a route's test.
    #[cfg(test)]
    pub(crate) fn hold_for_test(&self, id: &str, busy: bool) {
        let place = Place {
            id: id.to_owned(),
            branch: format!("yantra/{id}"),
            repo: String::new(),
            worktree: String::new(),
            base: String::new(),
        };
        let (live, commands) = Live::new(&place, "run".to_owned(), false);
        live.set_busy(busy);
        self.insert(&live);
        std::mem::forget(commands);
    }

    #[cfg(test)]
    pub(crate) fn mark_reverting(&self, id: &str) {
        self.lock().reverting.insert(id.to_owned());
    }

    /// Marks thread `id` as reverting, unless a turn runs, starts, keeps its checkpoint or waits
    /// there. One lock with [`Self::claim`], [`Self::hold`] and [`Self::mark_busy`], so no turn
    /// starts beside a revert (Y-542).
    fn begin_revert(&self, id: &str) -> Result<(), Failure> {
        let mut held = self.lock();
        if held.reverting.contains(id) {
            return Err(elsewhere());
        }
        if held.claimed.contains(id)
            || held.next.contains_key(id)
            || held.lives.get(id).is_some_and(|live| live.unsettled())
        {
            return Err(busy());
        }
        held.reverting.insert(id.to_owned());
        Ok(())
    }

    fn end_revert(&self, id: &str) {
        self.lock().reverting.remove(id);
    }

    /// Marks `live` busy with a turn. `Ok(false)` is a keeper that runs a turn or is closing.
    fn mark_busy(&self, live: &Live) -> Result<bool, Failure> {
        let held = self.lock();
        if held.reverting.contains(&live.id) {
            return Err(elsewhere());
        }
        let mut state = live.lock();
        if state.busy || state.closing {
            return Ok(false);
        }
        state.set_busy(true);
        Ok(true)
    }

    /// Adds `live` unless the thread already has one.
    fn insert(&self, live: &Arc<Live>) -> bool {
        let mut held = self.lock();
        if held.lives.contains_key(&live.id) {
            return false;
        }
        held.lives.insert(live.id.clone(), Arc::clone(live));
        live.lock().changed = Some(self.changed.clone());
        bump(&self.changed);
        for waiter in held.waiters.remove(&live.id).unwrap_or_default() {
            if let Some((_, _, receiver)) = live.subscribe() {
                let _ = waiter.send(Ok(receiver));
            }
        }
        true
    }

    /// A wait for thread `id`'s next keeper.
    fn follow(&self, id: &str) -> oneshot::Receiver<Following> {
        let (waiter, waiting) = oneshot::channel();
        let mut held = self.lock();
        let waiters = held.waiters.entry(id.to_owned()).or_default();
        waiters.retain(|waiter| !waiter.is_closed());
        waiters.push(waiter);
        waiting
    }

    /// Tells every socket that waits for thread `id`'s next keeper that none starts.
    fn refuse(&self, id: &str, refusal: &Failure) {
        for waiter in self.lock().waiters.remove(id).unwrap_or_default() {
            let _ = waiter.send(Err(refusal.clone()));
        }
    }

    /// Holds `next` for the end of the turn `live` runs, and tells every socket. A `live` that
    /// runs no turn and is not closing, has left the registry, or reverts gives `next` back.
    fn hold(&self, live: &Live, next: Next) -> Result<(), Next> {
        let mut held = self.lock();
        let current = held
            .lives
            .get(&live.id)
            .is_some_and(|held| std::ptr::eq(held.as_ref(), live));
        let ending = {
            let state = live.lock();
            state.busy || state.checkpointing || state.closing
        };
        if !current || !ending || held.reverting.contains(&live.id) {
            return Err(next);
        }
        let queue = held.next.entry(live.id.clone()).or_default();
        queue.push(next);
        live.publish(&QueueFrame::of(&live.id, queue), None);
        Ok(())
    }

    /// Takes the turns held for `live`'s thread and marks it busy with them, unless a turn runs
    /// or the keeper is closing.
    fn take_next(&self, live: &Live) -> Vec<Next> {
        let mut held = self.lock();
        {
            let mut state = live.lock();
            if state.busy || state.closing || !held.next.contains_key(&live.id) {
                return Vec::new();
            }
            state.set_busy(true);
        }
        held.drain_next(live)
    }

    /// Drops the turns held for `live`'s thread.
    fn clear_next(&self, live: &Live) {
        self.lock().drain_next(live);
    }

    /// The queue of thread `id`, empty included, for a socket that attaches.
    fn queue_of(&self, id: &str) -> QueueFrame {
        QueueFrame::of(id, self.lock().next.get(id).map_or(&[], Vec::as_slice))
    }

    /// Marks a thread's keeper as being started or read back. `false` is a
    /// thread another task already holds, or one that reverts.
    fn claim(&self, id: &str) -> bool {
        let mut held = self.lock();
        !held.lives.contains_key(id)
            && !held.reverting.contains(id)
            && held.claimed.insert(id.to_owned())
    }

    fn release(&self, id: &str) {
        self.lock().claimed.remove(id);
    }

    fn remember_mode(&self, id: &str, mode: PermissionMode) {
        self.lock().modes.insert(id.to_owned(), mode);
    }

    fn mode(&self, id: &str) -> Option<PermissionMode> {
        self.lock().modes.get(id).copied()
    }

    /// Queues `prompt` while a turn runs or ends in thread `id`, or its
    /// keeper closes; that end sends it, and the receiver says whether its
    /// turn started. `None` is a thread whose keeper is free or gone.
    fn queue(&self, id: &str, prompt: &str) -> Option<oneshot::Receiver<Woke>> {
        let mut held = self.lock();
        if !held.lives.get(id).is_some_and(|live| {
            let state = live.lock();
            state.busy || state.checkpointing || state.closing
        }) {
            return None;
        }
        let (woke, heard) = oneshot::channel();
        held.queued
            .entry(id.to_owned())
            .or_default()
            .push((prompt.to_owned(), woke));
        Some(heard)
    }

    /// Takes the room prompts queued for `live`'s thread and marks it busy
    /// with them, unless a turn runs or the keeper is closing. A thread that
    /// reverts gives them back to their rooms.
    fn take_queued(&self, live: &Live) -> Vec<Queued> {
        let mut held = self.lock();
        if held.reverting.contains(&live.id) {
            for (_, woke) in held.queued.remove(&live.id).unwrap_or_default() {
                let _ = woke.send(Woke::Failed);
            }
            return Vec::new();
        }
        let mut state = live.lock();
        if state.busy || state.closing || !held.queued.contains_key(&live.id) {
            return Vec::new();
        }
        state.busy = true;
        state.bump();
        held.queued.remove(&live.id).unwrap_or_default()
    }

    /// Lets `live`'s thread go, and returns the room prompts and the person's
    /// turns queued for it. Both happen under one lock, so nothing queues
    /// behind a keeper that is gone.
    fn forget(&self, live: &Live) -> (Vec<Queued>, Vec<Next>) {
        let mut held = self.lock();
        if !held
            .lives
            .get(&live.id)
            .is_some_and(|held| std::ptr::eq(held.as_ref(), live))
        {
            return (Vec::new(), Vec::new());
        }
        held.lives.remove(&live.id);
        bump(&self.changed);
        let next = held.drain_next(live);
        (held.queued.remove(&live.id).unwrap_or_default(), next)
    }

    fn wait(&self, workspace: &str, thread: &str, phase: Phase) {
        if let Some(waits) = &self.waits {
            let _ = waits.send(Wait::new(workspace, thread, phase));
        }
    }
}

/// `YANTRA_CHAT_IDLE`, in seconds, shortens [`CLAUDE_IDLE`] for the podman
/// tests. A release build ignores it.
fn claude_idle() -> Duration {
    #[cfg(debug_assertions)]
    if let Some(seconds) = std::env::var("YANTRA_CHAT_IDLE")
        .ok()
        .and_then(|seconds| seconds.parse().ok())
    {
        return Duration::from_secs(seconds);
    }
    CLAUDE_IDLE
}

/// A thread's claim, released however the task that holds it ends. A keeper
/// started under it and never handed to a task is killed first, so no keeper
/// is left that nothing reads and nothing may adopt.
struct Claim<M: Machine> {
    machine: Arc<M>,
    place: Place,
    started: bool,
}

impl<M: Machine> Claim<M> {
    fn take(machine: &Arc<M>, place: &Place) -> Option<Self> {
        machine.registry().claim(&place.id).then(|| Self {
            machine: Arc::clone(machine),
            place: place.clone(),
            started: false,
        })
    }

    /// Claims the thread, waiting while another task holds it. `None` is a
    /// thread whose keeper a task now reads.
    async fn wait(machine: &Arc<M>, place: &Place) -> Result<Option<Self>, Failure> {
        let deadline = tokio::time::Instant::now() + CONNECT_WITHIN;
        loop {
            if machine.registry().live(&place.id).is_some() {
                return Ok(None);
            }
            if let Some(claim) = Self::take(machine, place) {
                return Ok(Some(claim));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(busy());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Kills the keeper started under the claim, then lets the thread go.
    async fn stop(mut self) {
        if std::mem::take(&mut self.started)
            && let Err(said) = self.machine.finish(&self.place, Duration::ZERO).await
        {
            tracing::warn!("chat: the keeper of {} stays: {said}", self.place.id);
        }
    }
}

impl<M: Machine> Drop for Claim<M> {
    fn drop(&mut self) {
        if !self.started {
            self.machine.registry().release(&self.place.id);
            return;
        }
        let (machine, place) = (Arc::clone(&self.machine), self.place.clone());
        let stopped = async move {
            if let Err(said) = machine.finish(&place, Duration::ZERO).await {
                tracing::warn!("chat: the keeper of {} stays: {said}", place.id);
            }
            machine.registry().release(&place.id);
        };
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => drop(runtime.spawn(stopped)),
            Err(_) => self.machine.registry().release(&self.place.id),
        }
    }
}

/// What a keeper's task is asked by a socket.
enum Command {
    Turn(Next),
    Answer {
        request: String,
        decision: Decision,
        answers: Option<BTreeMap<String, Vec<String>>>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Cancel,
    StopTask {
        task: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    StopAll,
}

/// One frame sent to every socket of a thread, with the cursor of the event
/// it carries.
#[derive(Clone)]
struct Sent {
    cursor: Option<Cursor>,
    text: Arc<str>,
}

/// One live keeper, held by the registry until its session is removed.
struct Live {
    id: String,
    run: String,
    commands: mpsc::UnboundedSender<Command>,
    state: Mutex<Published>,
}

struct Published {
    /// The last event sent that carries a cursor.
    last: Option<Cursor>,
    busy: bool,
    /// When the running turn started. `None` when idle, and for a keeper
    /// adopted as busy, whose start is unknown.
    since: Option<SystemTime>,
    /// Set while a turn's end keeps its checkpoint, so no revert runs beside
    /// the capture. A new turn may still start.
    checkpointing: bool,
    /// Set once the keeper's task is closing its agent or removing its
    /// session, so it takes no turn.
    closing: bool,
    /// `None` once the keeper is gone, which ends every subscription.
    sender: Option<broadcast::Sender<Sent>>,
    /// How many prompts this keeper's run has sent, for an ACP prompt's item.
    prompts: usize,
    /// The `turn.completed` the daemon made for the last turn, which no
    /// replay of `out` makes again, until the next turn starts.
    ended: Option<ThreadEvent>,
    /// The last turn's `turn.diff.updated`, until the next turn starts or a
    /// revert puts its files back (ADR-0035 decision 8).
    diff: Option<ThreadEvent>,
    /// The item the running turn is in, and what it is, for room presence.
    tool: Option<(String, String)>,
    /// [`Registry::changed`], once the registry holds this keeper.
    changed: Option<watch::Sender<u64>>,
}

impl Published {
    fn set_busy(&mut self, busy: bool) {
        self.busy = busy;
        self.since = busy.then(SystemTime::now);
        self.bump();
    }

    fn set_tool(&mut self, tool: Option<(String, String)>) {
        if self.tool != tool {
            self.tool = tool;
            self.bump();
        }
    }

    fn bump(&self) {
        if let Some(changed) = &self.changed {
            bump(changed);
        }
    }
}

fn bump(changed: &watch::Sender<u64>) {
    changed.send_modify(|count| *count += 1);
}

impl Live {
    fn new(
        place: &Place,
        run: String,
        busy: bool,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<Command>) {
        let (commands, received) = mpsc::unbounded_channel();
        let (sender, _) = broadcast::channel(BACKLOG);
        let live = Arc::new(Self {
            id: place.id.clone(),
            run,
            commands,
            state: Mutex::new(Published {
                last: None,
                busy,
                since: None,
                checkpointing: false,
                closing: false,
                sender: Some(sender),
                prompts: 0,
                ended: None,
                diff: None,
                tool: None,
                changed: None,
            }),
        });
        (live, received)
    }

    fn lock(&self) -> MutexGuard<'_, Published> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn busy(&self) -> bool {
        self.lock().busy
    }

    fn doing(&self) -> Doing {
        let state = self.lock();
        if state.busy {
            Doing::Working(state.since)
        } else {
            Doing::Idle
        }
    }

    fn set_busy(&self, busy: bool) {
        self.lock().set_busy(busy);
    }

    /// Whether a turn runs or its checkpoint is still being kept.
    fn unsettled(&self) -> bool {
        let state = self.lock();
        state.busy || state.checkpointing
    }

    /// Marks the keeper closing, so it takes no turn, unless one runs.
    fn close_unless_busy(&self) -> bool {
        let mut state = self.lock();
        if state.busy {
            return false;
        }
        state.closing = true;
        true
    }

    /// Whether any socket is attached.
    fn watched(&self) -> bool {
        self.lock()
            .sender
            .as_ref()
            .is_some_and(|sender| sender.receiver_count() > 0)
    }

    /// Sends `frame` to every socket. An event's cursor moves `last`, under
    /// the same lock a subscription is taken, so none is sent twice or missed.
    fn publish<T: Serialize>(&self, frame: &T, cursor: Option<&str>) {
        let Ok(text) = serde_json::to_string(frame) else {
            return;
        };
        let cursor = cursor.and_then(Cursor::parse);
        let mut state = self.lock();
        if let Some(cursor) = &cursor {
            state.last = Some(cursor.clone());
        }
        if let Some(sender) = &state.sender {
            // Nobody attached is not this keeper's failure.
            let _ = sender.send(Sent {
                cursor,
                text: text.into(),
            });
        }
    }

    fn event(&self, event: &ThreadEvent) {
        match &event.event {
            Event::TurnCompleted(_) if event.cursor.is_none() => {
                let mut state = self.lock();
                state.ended = Some(event.clone());
                state.set_tool(None);
            }
            Event::TurnStarted => {
                let mut state = self.lock();
                state.ended = None;
                state.diff = None;
                state.set_tool(None);
            }
            Event::TurnCompleted(_) => {
                let mut state = self.lock();
                state.ended = None;
                state.set_tool(None);
            }
            Event::ItemStarted(item) => {
                let what = item.title.clone().or_else(|| {
                    item.item_type
                        .and_then(|kind| serde_json::to_value(kind).ok())
                        .and_then(|kind| kind.as_str().map(str::to_owned))
                });
                if let Some(what) = what {
                    self.lock().set_tool(Some((item.item_id.clone(), what)));
                }
            }
            Event::ItemCompleted(item) => {
                let mut state = self.lock();
                if state
                    .tool
                    .as_ref()
                    .is_some_and(|(id, _)| *id == item.item_id)
                {
                    state.set_tool(None);
                }
            }
            Event::TurnDiffUpdated(_) => self.lock().diff = Some(event.clone()),
            _ => {}
        }
        self.publish(event, event.cursor.as_deref());
    }

    /// A subscription, the last cursor sent before it, and what the daemon
    /// made for the last turn that no replay of `out` makes again: its end,
    /// then its diff.
    fn subscribe(&self) -> Option<Subscribed> {
        let state = self.lock();
        let receiver = state.sender.as_ref()?.subscribe();
        let remade = state.ended.iter().chain(&state.diff).cloned().collect();
        Some((state.last.clone(), remade, receiver))
    }

    /// Ends every subscription.
    fn close(&self) {
        self.lock().sender = None;
    }

    fn command(&self, command: Command) {
        let _ = self.commands.send(command);
    }
}

/// A socket's subscription to its thread's keeper.
struct Sub {
    receiver: broadcast::Receiver<Sent>,
    /// The last cursor this socket was sent by a replay.
    seen: Option<Cursor>,
}

/// What a subscription gave: a frame to send, nothing more, or a socket that
/// fell too far behind.
enum News {
    Frame(Arc<str>),
    Ended,
    Behind,
}

async fn next_sent(sub: &mut Option<Sub>) -> News {
    let Some(open) = sub else {
        return std::future::pending().await;
    };
    loop {
        match open.receiver.recv().await {
            Ok(sent) if !repeated(&sent, open.seen.as_ref()) => return News::Frame(sent.text),
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(_)) => return News::Behind,
            Err(broadcast::error::RecvError::Closed) => return News::Ended,
        }
    }
}

async fn next_keeper(waiter: &mut Option<oneshot::Receiver<Following>>) -> Following {
    if let Some(waiting) = waiter
        && let Ok(followed) = waiting.await
    {
        return followed;
    }
    // A wait the registry dropped is not polled again.
    *waiter = None;
    std::future::pending().await
}

/// Whether a replay already sent `sent`.
fn repeated(sent: &Sent, seen: Option<&Cursor>) -> bool {
    match (&sent.cursor, seen) {
        (Some(cursor), Some(seen)) => !cursor.after(seen) && cursor.run == seen.run,
        _ => false,
    }
}

/// Sends what the old subscription still holds before a new one replaces it, so no end or diff
/// is dropped. `false` is a socket that went away, or fell too far behind.
async fn flush<P: Peer>(sub: &mut Option<Sub>, peer: &mut P) -> bool {
    let Some(open) = sub else {
        return true;
    };
    loop {
        match open.receiver.try_recv() {
            Ok(sent) if !repeated(&sent, open.seen.as_ref()) => {
                if !peer.say_text(sent.text.to_string()).await {
                    return false;
                }
            }
            Ok(_) => {}
            Err(broadcast::error::TryRecvError::Lagged(_)) => return false,
            Err(_) => return true,
        }
    }
}

/// What the browser sent: a JSON frame, or an image.
enum Heard {
    Text(String),
    Binary(Bytes),
    /// The answer to a protocol ping.
    Pong,
}

/// The browser's end of the socket. `None` is a socket that closed or failed.
trait Peer {
    async fn hear(&mut self) -> Option<Heard>;
    async fn say_text(&mut self, text: String) -> bool;
    async fn ping(&mut self) -> bool;

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
                Ok(Message::Pong(_)) => return Some(Heard::Pong),
                Ok(Message::Close(_)) | Err(_) => return None,
                // A ping is still axum's to answer.
                Ok(_) => {}
            }
        }
    }

    async fn say_text(&mut self, text: String) -> bool {
        self.send(Message::Text(text.into())).await.is_ok()
    }

    async fn ping(&mut self) -> bool {
        self.send(Message::Ping(Bytes::new())).await.is_ok()
    }
}

/// The thread a socket is on.
struct Here {
    place: Place,
    harness: Option<Harness>,
    /// An ACP thread's session, which a new keeper loads.
    session: Option<String>,
}

impl Here {
    /// `continues` is the browser's cursor when what follows continues from
    /// it. Without one a whole replay follows, and the browser starts over.
    fn started(&self, continues: Option<&Cursor>) -> ThreadEvent {
        let id = thread::name(&self.place).to_owned();
        ThreadEvent {
            thread_id: id.clone(),
            cursor: continues.map(Cursor::to_string),
            event: Event::ThreadStarted {
                thread: id,
                harness: name_of(self.harness).to_owned(),
            },
        }
    }
}

/// One socket, from the attach to the close. The close detaches: a running
/// turn carries on in its keeper.
async fn converse<M: Machine, P: Peer>(
    machine: Arc<M>,
    name: &str,
    query: ChatQuery,
    peer: &mut P,
) {
    let mut here: Option<Here> = None;
    let mut sub: Option<Sub> = None;
    if let Some(id) = &query.thread {
        let after = query.after.as_deref().and_then(Cursor::parse);
        match attach(&machine, name, id, after, peer).await {
            Some((attached, subscribed)) => {
                here = Some(attached);
                sub = subscribed;
            }
            None => return,
        }
    }

    // A thread id taken before the thread opens, so an image sent first
    // already lands in the thread's own directory.
    let mut early: Option<String> = None;
    let mut images: Option<Images> = None;
    // A branch diff runs beside the loop and sends its frame back here.
    let (diffs, mut diffed) = mpsc::unbounded_channel::<String>();
    // The thread's next keeper, such as one a queued turn or a room starts.
    let mut waiter = None;
    // Two missed pings end the socket, as terminal.rs bridge() does; the turn
    // goes on in its keeper. A phone that slept leaves a socket nobody closes.
    let mut unanswered = 0u8;
    let mut pings = tokio::time::interval(PING_EVERY);
    pings.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        if waiter.is_none()
            && let Some(here) = &here
        {
            waiter = Some(machine.registry().follow(&here.place.id));
        }
        let open = tokio::select! {
            heard = peer.hear() => match heard {
                None => false,
                Some(Heard::Pong) => {
                    unanswered = 0;
                    true
                }
                Some(Heard::Binary(bytes)) => {
                    let reply = land(&machine, name, here.as_ref(), &mut early, &mut images, &bytes).await;
                    peer.say(&reply).await
                }
                Some(Heard::Text(text)) => {
                    heard_frame(&machine, name, &text, &mut here, &mut sub, &mut early, &diffs, peer).await
                }
            },
            Some(text) = diffed.recv() => peer.say_text(text).await,
            _ = pings.tick() => {
                if unanswered >= MISSES {
                    tracing::info!("chat {name}: the socket answered no ping");
                    false
                } else {
                    unanswered += 1;
                    peer.ping().await
                }
            }
            followed = next_keeper(&mut waiter) => {
                waiter = None;
                match followed {
                    // A socket that started the keeper itself already follows it.
                    Ok(receiver) if sub.as_ref().is_none_or(|open| open.receiver.is_closed()) => {
                        let flushed = flush(&mut sub, peer).await;
                        sub = Some(Sub { receiver, seen: None });
                        flushed
                    }
                    Ok(_) => true,
                    Err(refusal) => peer.say(&refusal).await,
                }
            }
            sent = next_sent(&mut sub) => match sent {
                News::Frame(text) => peer.say_text(text.to_string()).await,
                News::Ended => {
                    sub = None;
                    true
                }
                News::Behind => {
                    tracing::info!("chat {name}: the socket fell behind, so it closes to reconnect");
                    false
                }
            },
        };
        if !open {
            break;
        }
    }

    if here.is_none()
        && let Some(images) = images.filter(Images::used)
    {
        match tokio::time::timeout(CLEAR_WITHIN, machine.clear(&images)).await {
            Ok(Ok(())) => tracing::info!("chat {name}: its images were removed"),
            Ok(Err(said)) => tracing::warn!("chat {name}: its images stay: {said}"),
            Err(_) => tracing::warn!("chat {name}: its images stay: the machine did not answer"),
        }
    }
}

/// One JSON frame. `false` is a socket that went away.
#[allow(clippy::too_many_arguments)]
async fn heard_frame<M: Machine, P: Peer>(
    machine: &Arc<M>,
    name: &str,
    text: &str,
    here: &mut Option<Here>,
    sub: &mut Option<Sub>,
    early: &mut Option<String>,
    diffs: &mpsc::UnboundedSender<String>,
    peer: &mut P,
) -> bool {
    let live = here
        .as_ref()
        .and_then(|here| machine.registry().live(&here.place.id));
    match serde_json::from_str::<Frame>(text) {
        Ok(Frame::Turn {
            text,
            harness,
            mode,
            interaction,
            model,
            effort,
            context,
        }) => {
            let asked = harness.as_deref().map(harness_named).transpose();
            let theirs = here.as_ref().map(|here| here.harness);
            match (asked, theirs) {
                _ if text.trim().is_empty() => {
                    peer.say(&failure(Kind::BadFrame, "a turn needs some text"))
                        .await
                }
                (Err(said), _) => peer.say(&failure(Kind::BadFrame, said)).await,
                (Ok(Some(asked)), Some(theirs)) if asked != theirs => {
                    let said = format!(
                        "this thread is {}'s, and a thread keeps its harness",
                        name_of(theirs)
                    );
                    peer.say(&failure(Kind::BadFrame, said)).await
                }
                (Ok(asked), theirs)
                    if interaction == Interaction::Plan
                        && theirs.unwrap_or_else(|| asked.flatten()).is_some() =>
                {
                    peer.say(&failure(
                        Kind::BadFrame,
                        "plan mode needs the Claude harness",
                    ))
                    .await
                }
                (Ok(asked), _) => {
                    let next = Next {
                        text,
                        // A plan turn asks about all it relays, here and in an adopting daemon.
                        mode: match interaction {
                            Interaction::Plan => PermissionMode::Supervised,
                            Interaction::Build => mode,
                        },
                        interaction,
                        model,
                        effort,
                        context,
                        room: false,
                    };
                    let next = match &live {
                        Some(live) => match machine.registry().hold(live, next) {
                            Ok(()) => {
                                tracing::info!("chat {name}: a turn waits for the running one");
                                return true;
                            }
                            Err(next) => next,
                        },
                        None => next,
                    };
                    begin(machine, name, here, sub, early, asked.flatten(), next, peer).await
                }
            }
        }
        Ok(Frame::Answer {
            request_id,
            decision,
            answers,
        }) => {
            let answered = match live {
                Some(live) => {
                    let (reply, replied) = oneshot::channel();
                    live.command(Command::Answer {
                        request: request_id,
                        decision,
                        answers,
                        reply,
                    });
                    replied
                        .await
                        .unwrap_or_else(|_| Err("the turn has ended".to_owned()))
                }
                None => Err("no turn is running, so nothing is waiting".to_owned()),
            };
            match answered {
                Ok(()) => true,
                Err(said) => peer.say(&failure(Kind::BadFrame, said)).await,
            }
        }
        Ok(Frame::Cancel) => {
            if let Some(live) = live {
                tracing::info!("chat {name}: the turn was cancelled");
                machine.registry().clear_next(&live);
                live.command(Command::Cancel);
            }
            true
        }
        Ok(Frame::StopTask { task_id }) => {
            let stopped = match live {
                Some(live) => {
                    let (reply, replied) = oneshot::channel();
                    live.command(Command::StopTask {
                        task: task_id,
                        reply,
                    });
                    replied
                        .await
                        .unwrap_or_else(|_| Err("the keeper has ended".to_owned()))
                }
                None => Err("no keeper runs in this thread, so no task runs".to_owned()),
            };
            match stopped {
                Ok(()) => {
                    tracing::info!("chat {name}: a background task was stopped");
                    true
                }
                Err(said) => peer.say(&failure(Kind::StopTask, said)).await,
            }
        }
        Ok(Frame::StopAll) => {
            if let Some(live) = live {
                tracing::info!("chat {name}: every background task was stopped");
                machine.registry().clear_next(&live);
                live.command(Command::StopAll);
            }
            true
        }
        Ok(Frame::Revert { turn }) => match here.as_ref() {
            None => {
                let said = "no thread is open, so there is nothing to revert";
                peer.say(&failure(Kind::BadFrame, said)).await
            }
            Some(_) if !machine.tracked() => {
                let said = "a home chat has no worktree, so there is nothing to revert";
                peer.say(&failure(Kind::BadFrame, said)).await
            }
            Some(here) => {
                let place = here.place.clone();
                if let Err(refusal) = machine.registry().begin_revert(&place.id) {
                    return peer.say(&refusal).await;
                }
                let said =
                    revert(machine.as_ref(), name, &place, turn, live.as_deref(), peer).await;
                machine.registry().end_revert(&place.id);
                said
            }
        },
        // A running turn does not refuse it: it reads through a private index.
        Ok(Frame::Diff) => match here.as_ref() {
            None => {
                let said = "no thread is open, so there is nothing to diff";
                peer.say(&failure(Kind::BadFrame, said)).await
            }
            Some(_) if !machine.tracked() => {
                let said = "a home chat has no worktree, so there is nothing to diff";
                peer.say(&failure(Kind::BadFrame, said)).await
            }
            // A revert half done is no tree to diff.
            Some(here) if machine.registry().lock().reverting.contains(&here.place.id) => {
                peer.say(&elsewhere()).await
            }
            Some(here) => {
                let (machine, name, place) =
                    (Arc::clone(machine), name.to_owned(), here.place.clone());
                let diffs = diffs.clone();
                tokio::spawn(async move {
                    let _ = diffs.send(branch_diff(machine.as_ref(), &name, &place).await);
                });
                true
            }
        },
        Ok(Frame::Ping) => peer.say(&Pong { tag: "pong" }).await,
        Err(error) => {
            let said = format!(
                "a frame is a turn, an answer, a cancel, a revert, a diff or a stop: {error}"
            );
            peer.say(&failure(Kind::BadFrame, said)).await
        }
    }
}

/// Writes one image and says where it landed. Never a byte or a size in the log.
async fn land<M: Machine>(
    machine: &Arc<M>,
    name: &str,
    here: Option<&Here>,
    early: &mut Option<String>,
    images: &mut Option<Images>,
    bytes: &[u8],
) -> Attachment {
    let unreachable = |said: String| {
        tracing::warn!("chat {name}: an image was not attached: {said}");
        Attachment::NotAttached {
            kind: NotAttached::Unreachable,
            said,
        }
    };
    if images.is_none() {
        let thread = match here {
            Some(here) => thread::name(&here.place).to_owned(),
            None => match early.clone().map_or_else(thread::new_id, Ok) {
                Ok(id) => early.insert(id).clone(),
                Err(error) => return unreachable(chain(&error)),
            },
        };
        *images = Some(Images::of(&Keeper::new(name, &thread)));
    }
    let Some(images) = images.as_mut() else {
        return unreachable("no directory for the images".to_owned());
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

/// Frees the thread for its next turn, keeps the tree and sends the turn's
/// diff to every socket; no revert runs meanwhile. The diff is never logged.
async fn checkpointed<M: Machine>(
    machine: &M,
    name: &str,
    place: &Place,
    failed: bool,
    live: &Live,
) {
    {
        let mut state = live.lock();
        state.set_busy(false);
        state.checkpointing = machine.tracked();
    }
    if !machine.tracked() {
        return;
    }
    let kept = match within(machine.capture(place)).await {
        Ok(turn) => within(machine.diff(place, turn))
            .await
            .map(|diff| (turn, diff)),
        Err(said) => Err(said),
    };
    match kept {
        Ok((turn, Diff { unified, truncated })) => {
            tracing::info!("chat {name}: checkpoint {turn} kept");
            live.event(&diffed(place, turn, unified, truncated));
        }
        Err(said) => {
            tracing::warn!("chat {name}: no checkpoint: {said}");
            // A failed turn's own error is the one the browser keeps.
            if !failed {
                live.publish(&failure(Kind::Checkpoint, said), None);
            }
        }
    }
    live.lock().checkpointing = false;
}

fn diffed(place: &Place, turn: u32, unified_diff: String, truncated: bool) -> ThreadEvent {
    ThreadEvent {
        thread_id: thread::name(place).to_owned(),
        cursor: None,
        event: Event::TurnDiffUpdated(TurnDiff {
            turn,
            unified_diff,
            truncated,
        }),
    }
}

/// The last turn's diff, for a tab back after its keeper has gone.
async fn last_diff<M: Machine>(machine: &M, place: &Place) -> Option<ThreadEvent> {
    if !machine.tracked() {
        return None;
    }
    let turn = within(machine.latest(place)).await.ok()??;
    let Diff { unified, truncated } = within(machine.diff(place, turn)).await.ok()?;
    Some(diffed(place, turn, unified, truncated))
}

async fn within<T>(call: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::time::timeout(CHECKPOINT_WITHIN, call)
        .await
        .unwrap_or_else(|_| {
            Err(format!(
                "git did not answer within {} seconds",
                CHECKPOINT_WITHIN.as_secs()
            ))
        })
}

/// Another socket holds the thread for a revert.
fn elsewhere() -> Failure {
    failure(
        Kind::Busy,
        "another tab is running a turn or a revert in this thread; wait for it to end",
    )
}

/// Puts the files back as checkpoint `turn` kept them. The conversation stays.
async fn revert<M: Machine, P: Peer>(
    machine: &M,
    name: &str,
    place: &Place,
    turn: u32,
    live: Option<&Live>,
    peer: &mut P,
) -> bool {
    match within(machine.revert(place, turn)).await {
        Ok(()) => {
            tracing::info!("chat {name}: reverted to checkpoint {turn}");
            // A tab back later must not draw the reverted turn's diff again.
            if let Some(live) = live {
                live.lock().diff = None;
            }
            peer.say(&ThreadEvent {
                thread_id: thread::name(place).to_owned(),
                cursor: None,
                event: Event::ThreadReverted { turn },
            })
            .await
        }
        Err(said) => {
            tracing::warn!("chat {name}: no revert: {said}");
            peer.say(&failure(Kind::Checkpoint, said)).await
        }
    }
}

/// The frame that answers a `diff`. git's words are not logged either,
/// because they may name a path (Q5).
async fn branch_diff<M: Machine>(machine: &M, name: &str, place: &Place) -> String {
    let reply = match within(machine.branch_diff(place)).await {
        Ok(diff) => {
            tracing::info!("chat {name}: branch diff sent");
            serde_json::to_string(&BranchDiffReply::of(place, diff))
        }
        Err(said) => {
            tracing::warn!("chat {name}: no branch diff");
            serde_json::to_string(&failure(Kind::Diff, said))
        }
    };
    reply.unwrap_or_default()
}

/// What an agent's refusal tells the browser: the login to make, or the
/// agent's own words.
fn refused(machine: &str, harness: Harness, login: Option<String>, error: &acp::Error) -> Failure {
    if error.is_auth() {
        let said = match login {
            Some(hint) => format!("{error}. {hint}"),
            None => error.to_string(),
        };
        not_logged_in(Some(harness), machine, said)
    } else {
        failure(Kind::Unreachable, chain(error))
    }
}

/// An ACP event as the browser reads it: under the worktree's thread, and
/// without ACP's own `thread.started`, whose id is the agent's session.
fn relabel(id: &str, mut event: ThreadEvent) -> Option<ThreadEvent> {
    if matches!(event.event, Event::ThreadStarted { .. }) {
        return None;
    }
    id.clone_into(&mut event.thread_id);
    Some(event)
}

/// The events a replay made that a browser which drew `after` has not seen:
/// those after it, each daemon-made `request.resolved`, and the other
/// daemon-made events that stand before an event after it (ADR-0035
/// decision 8).
fn missed(events: Vec<ThreadEvent>, after: &Cursor) -> Vec<ThreadEvent> {
    let mut kept = Vec::new();
    let mut later = true;
    for event in events.into_iter().rev() {
        match event.cursor.as_deref().and_then(Cursor::parse) {
            Some(cursor) => {
                later = cursor.after(after);
                if later {
                    kept.push(event);
                }
            }
            None if later || matches!(event.event, Event::RequestResolved(_)) => kept.push(event),
            None => {}
        }
    }
    kept.reverse();
    kept
}

/// The requests a replay opened and nothing resolved, with their scopes.
fn waiting(events: &[ThreadEvent]) -> Vec<(String, Scope, Vec<RequestOption>)> {
    let mut open: Vec<(String, Scope, Vec<RequestOption>)> = Vec::new();
    for event in events {
        match &event.event {
            Event::RequestOpened(opened) => open.push((
                opened.request_id.clone(),
                opened.scope,
                opened.options.clone(),
            )),
            Event::RequestResolved(resolved) => {
                open.retain(|(request, _, _)| *request != resolved.request_id);
            }
            _ => {}
        }
    }
    open
}

/// The events a replay made up to `last`, the last cursor the keeper's task
/// had sent when the socket subscribed. What follows reaches the socket live.
fn sent_by(events: Vec<ThreadEvent>, last: Option<&Cursor>) -> Vec<ThreadEvent> {
    events
        .into_iter()
        .take_while(|event| {
            let cursor = event.cursor.as_deref().and_then(Cursor::parse);
            match (cursor, last) {
                (None, _) => true,
                (Some(_), None) => false,
                (Some(cursor), Some(last)) => cursor.run == last.run && !cursor.after(last),
            }
        })
        .collect()
}

fn last_cursor(events: &[ThreadEvent]) -> Option<Cursor> {
    events
        .iter()
        .rev()
        .find_map(|event| event.cursor.as_deref().and_then(Cursor::parse))
}

/// `?thread=`: finds the thread, says whose it is and replays it, then
/// subscribes to its keeper. `None` ends the socket.
async fn attach<M: Machine, P: Peer>(
    machine: &Arc<M>,
    name: &str,
    id: &str,
    after: Option<Cursor>,
    peer: &mut P,
) -> Option<(Here, Option<Sub>)> {
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
    let kept = match recalled(machine.as_ref(), &place).await {
        Ok(kept) => kept,
        Err(said) => {
            let _ = peer.say(&unreachable(said)).await;
            return None;
        }
    };
    let here = Here {
        place,
        harness: kept.as_ref().map(|(harness, _)| *harness),
        session: kept.map(|(_, session)| session),
    };
    tracing::info!(
        "chat {name} attached thread {id} of {}",
        name_of(here.harness)
    );
    let mut live = machine.registry().live(&here.place.id);
    if live.is_none() {
        // A keeper no task reads yet, as just after a restart, is read now.
        if let Err(refusal) = adopt_place(machine, name, here.place.clone()).await {
            tracing::warn!("chat {name}: {}", refusal.said);
        }
        live = machine.registry().live(&here.place.id);
    }
    // An ended Claude turn's journals stay until the thread's next turn.
    let ended = match (&live, here.harness, &after) {
        (None, None, Some(after)) => machine
            .journals(&here.place, None)
            .await
            .ok()
            .filter(|journals| journals.run == after.run),
        _ => None,
    };
    let honoured = match (&live, &ended) {
        (Some(live), _) => after.filter(|after| after.run == live.run),
        (None, Some(_)) => after,
        (None, None) => None,
    };
    if !peer.say(&here.started(honoured.as_ref())).await {
        return None;
    }
    let sub = match (live, here.harness) {
        (Some(live), _) => Some(replay_live(machine.as_ref(), &here, &live, honoured, peer).await?),
        (None, None) => {
            let sent = match (ended, honoured) {
                (Some(journals), Some(after)) => {
                    let id = thread::name(&here.place);
                    let replayed =
                        claude::replay(id, &journals.run, &journals.out, &journals.input);
                    let ended = replayed.end(journals.said);
                    let mut events = missed(replayed.events, &after);
                    events.extend(ended);
                    events.extend(last_diff(machine.as_ref(), &here.place).await);
                    say_all(peer, &events).await
                }
                _ => replay(machine.as_ref(), &here.place, None, peer).await,
            };
            if !sent || !peer.say(&machine.registry().queue_of(&here.place.id)).await {
                return None;
            }
            None
        }
        (None, Some(harness)) => {
            match connect(
                machine,
                name,
                &here.place,
                harness,
                here.session.clone(),
                None,
            )
            .await
            {
                Ok((_, Some(receiver))) => {
                    if !peer.say(&machine.registry().queue_of(&here.place.id)).await {
                        return None;
                    }
                    Some(Sub {
                        receiver,
                        seen: None,
                    })
                }
                // Another task started it meanwhile, and has sent events already.
                Ok((_, None)) => {
                    let Some(live) = machine.registry().live(&here.place.id) else {
                        let said = "the agent's keeper went away";
                        let _ = peer.say(&failure(Kind::Unreachable, said)).await;
                        return None;
                    };
                    Some(replay_live(machine.as_ref(), &here, &live, None, peer).await?)
                }
                Err(refusal) => {
                    let _ = peer.say(&refusal).await;
                    return None;
                }
            }
        }
    };
    Some((here, sub))
}

async fn say_all<P: Peer>(peer: &mut P, events: &[ThreadEvent]) -> bool {
    for event in events {
        if !peer.say(event).await {
            return false;
        }
    }
    true
}

/// Subscribes to a live keeper and sends what the browser has not drawn: the
/// events after `after`, a cursor of this run, or without one the whole run,
/// after the transcript for Claude.
async fn replay_live<M: Machine, P: Peer>(
    machine: &M,
    here: &Here,
    live: &Live,
    after: Option<Cursor>,
    peer: &mut P,
) -> Option<Sub> {
    let subscribed = live.subscribe()?;
    replay_subscribed(machine, here, subscribed, after, peer).await
}

/// A live keeper's subscription.
type Subscribed = (Option<Cursor>, Vec<ThreadEvent>, broadcast::Receiver<Sent>);

/// [`replay_live`] with the subscription already taken.
async fn replay_subscribed<M: Machine, P: Peer>(
    machine: &M,
    here: &Here,
    (last, remade, receiver): Subscribed,
    after: Option<Cursor>,
    peer: &mut P,
) -> Option<Sub> {
    let upto = last.as_ref().map_or(0, |last| last.end);
    let journals = match machine.journals(&here.place, Some(upto)).await {
        Ok(journals) => journals,
        Err(said) => {
            let _ = peer.say(&failure(Kind::Unreachable, said)).await;
            return None;
        }
    };
    let id = thread::name(&here.place);
    let (events, prompt) = match here.harness {
        None => {
            let replayed = claude::replay(id, &journals.run, &journals.out, &journals.input);
            // The keeper's replay draws this run's prompts, so the transcript stops at the first.
            (replayed.events, replayed.prompts.into_iter().next())
        }
        Some(_) => {
            let replayed = acp::replay(&journals.run, &journals.out, &journals.input);
            let events = replayed
                .events
                .into_iter()
                .filter_map(|event| relabel(id, event))
                .collect();
            (events, None)
        }
    };
    let events = sent_by(events, last.as_ref());
    let events = match after {
        Some(after) => missed(events, &after),
        None => {
            if here.harness.is_none()
                && !replay(machine, &here.place, prompt.as_deref(), peer).await
            {
                return None;
            }
            events
        }
    };
    if !say_all(peer, &events).await {
        return None;
    }
    if !say_all(peer, &remade).await {
        return None;
    }
    // Always, so a tab that missed the queue's end draws it empty.
    if !peer.say(&machine.registry().queue_of(&here.place.id)).await {
        return None;
    }
    Some(Sub {
        receiver,
        seen: last,
    })
}

/// What the transcript holds, as the deltas a live turn would have sent. A
/// running turn's prompt, and what follows it, are left to the keeper's
/// replay.
async fn replay<M: Machine, P: Peer>(
    machine: &M,
    place: &Place,
    cut_at: Option<&str>,
    peer: &mut P,
) -> bool {
    let mut entries = match machine.history(place).await {
        Ok(entries) => entries,
        Err(said) => return peer.say(&failure(Kind::Unreachable, said)).await,
    };
    if let Some(prompt) = cut_at
        && let Some(at) = entries
            .iter()
            .rposition(|entry| entry.who == Who::User && entry.text == prompt)
    {
        entries.truncate(at);
    }
    for (at, entry) in entries.into_iter().enumerate() {
        if entry.text.is_empty() {
            continue;
        }
        let event = ThreadEvent {
            thread_id: thread::name(place).to_owned(),
            cursor: None,
            event: Event::ContentDelta(ContentDelta {
                stream_kind: match entry.who {
                    Who::User => StreamKind::UserText,
                    Who::Assistant => StreamKind::AssistantText,
                },
                delta: entry.text,
                item_id: Some(format!("history:{at}")),
            }),
        };
        if !peer.say(&event).await {
            return false;
        }
    }
    true
}

/// The prompt of a turn, as the browser draws it.
fn delta(place: &Place, stream_kind: StreamKind, text: String, item: &str) -> ThreadEvent {
    ThreadEvent {
        thread_id: thread::name(place).to_owned(),
        cursor: None,
        event: Event::ContentDelta(ContentDelta {
            stream_kind,
            delta: text,
            item_id: Some(format!("user:{item}")),
        }),
    }
}

/// Opens the thread on the first turn with the harness `pick` names, and
/// starts the turn. `false` is a socket that went away.
#[allow(clippy::too_many_arguments)]
async fn begin<M: Machine, P: Peer>(
    machine: &Arc<M>,
    name: &str,
    here: &mut Option<Here>,
    sub: &mut Option<Sub>,
    early: &mut Option<String>,
    pick: Option<Harness>,
    next: Next,
    peer: &mut P,
) -> bool {
    let here = match here {
        Some(here) => here,
        None => match open(machine, name, early, pick, next.context).await {
            Ok((opened, subscribed)) => {
                if !peer.say(&opened.started(None)).await {
                    return false;
                }
                titled(machine.as_ref(), name, &opened.place, &next.text).await;
                if subscribed.is_some() {
                    *sub = subscribed;
                }
                here.insert(opened)
            }
            Err(refusal) => return peer.say(&refusal).await,
        },
    };
    if machine.registry().lock().reverting.contains(&here.place.id) {
        return peer.say(&elsewhere()).await;
    }
    // A turn with no checkpoint before it could not be reverted.
    if machine.tracked() {
        match within(machine.base(&here.place)).await {
            Ok(Some(turn)) => tracing::info!("chat {name}: checkpoint {turn} kept"),
            Ok(None) => {}
            Err(said) => {
                tracing::warn!("chat {name}: no checkpoint: {said}");
                return peer.say(&failure(Kind::Checkpoint, said)).await;
            }
        }
    }
    if here.harness.is_none() {
        machine.registry().remember_mode(&here.place.id, next.mode);
    }
    // A keeper that ended closes the subscription before the loop sees it.
    let unsubscribed = sub.as_ref().is_none_or(|open| open.receiver.is_closed());
    match start_or_hold(machine, name, here, next, unsubscribed).await {
        Ok(Some(follow)) => {
            if !flush(sub, peer).await {
                return false;
            }
            *sub = match follow {
                Follow::New(receiver) => Some(Sub {
                    receiver,
                    seen: None,
                }),
                Follow::Replay(subscribed) => {
                    let replayed =
                        replay_subscribed(machine.as_ref(), here, subscribed, None, peer).await;
                    if replayed.is_none() {
                        return false;
                    }
                    replayed
                }
            };
            true
        }
        Ok(None) => true,
        Err(refusal) => peer.say(&refusal).await,
    }
}

/// Keeps the title the thread lists by, from its first prompt. A failed write
/// leaves it untitled.
async fn titled<M: Machine>(machine: &M, name: &str, place: &Place, prompt: &str) {
    let title = thread::title(prompt);
    if let Some((store, key)) = stored_as(machine, place)
        && let Err(error) = store
            .put_title(
                &key.workspace,
                &key.thread,
                machine.machine(),
                &key.place,
                &title,
            )
            .await
    {
        tracing::warn!("chat {name}: the store has no title: {}", chain(&error));
    }
    if let Err(said) = machine.remember_title(place, &title).await {
        tracing::warn!("chat {name}: thread {} has no title: {said}", place.id);
    }
}

/// A new thread, and for an ACP harness its keeper, agent and session. A
/// thread whose agent never started is removed again: without a harness in
/// its git config it would read as Claude's.
async fn open<M: Machine>(
    machine: &Arc<M>,
    name: &str,
    early: &mut Option<String>,
    pick: Option<Harness>,
    context: Option<ContextLength>,
) -> Result<(Here, Option<Sub>), Failure> {
    let id = match early.take().map_or_else(thread::new_id, Ok) {
        Ok(id) => id,
        Err(error) => return Err(failure(Kind::Unreachable, chain(&error))),
    };
    let place = machine.open(&id).await.map_err(|said| {
        tracing::warn!("chat {name}: {said}");
        failure(Kind::Unreachable, said)
    })?;
    tracing::info!("chat {name} opened thread {id} for {}", name_of(pick));
    let Some(harness) = pick else {
        return Ok((
            Here {
                place,
                harness: None,
                session: None,
            },
            None,
        ));
    };
    let connected = connect(machine, name, &place, harness, None, context)
        .await
        .and_then(|(session, receiver)| {
            Ok((session, subscribing(machine.as_ref(), &place, receiver)?))
        });
    match connected {
        Ok((session, receiver)) => Ok((
            Here {
                place,
                harness: Some(harness),
                session: Some(session),
            },
            Some(Sub {
                receiver,
                seen: None,
            }),
        )),
        Err(refusal) => {
            tracing::warn!("chat {name}: {} did not start", harness.name());
            if let Err(said) = machine.remove(&place).await {
                tracing::warn!("chat {name}: thread {id} stays: {said}");
            }
            if let Some((store, key)) = stored_as(machine.as_ref(), &place)
                && let Err(error) = store.remove(&key.workspace, &key.thread).await
            {
                tracing::warn!(
                    "chat {name}: the store keeps thread {id}: {}",
                    chain(&error)
                );
            }
            Err(refusal)
        }
    }
}

/// What came of an attempt to start a turn.
enum Turned<T> {
    Started(T),
    /// Another task started or holds the thread first, or a revert runs there.
    Lost,
}

/// Starts `next`, or holds it behind the turn that another task started first, until
/// [`CONNECT_WITHIN`]. `Ok(None)` is a held turn; the socket follows the next keeper.
async fn start_or_hold<M: Machine>(
    machine: &Arc<M>,
    name: &str,
    here: &Here,
    mut next: Next,
    unsubscribed: bool,
) -> Result<Option<Follow>, Failure> {
    let deadline = tokio::time::Instant::now() + CONNECT_WITHIN;
    loop {
        if let Some(live) = machine.registry().live(&here.place.id) {
            match machine.registry().hold(&live, next) {
                Ok(()) => {
                    tracing::info!("chat {name}: a turn waits for the running one");
                    return Ok(None);
                }
                Err(back) => next = back,
            }
        }
        let turn = Next {
            text: next.text.clone(),
            mode: next.mode,
            interaction: next.interaction,
            model: next.model.clone(),
            effort: next.effort,
            context: next.context,
            room: next.room,
        };
        let turned = match here.harness {
            None => claude_turn(machine, name, &here.place, turn, unsubscribed).await?,
            Some(harness) => acp_turn(machine, name, here, harness, turn, unsubscribed).await?,
        };
        match turned {
            Turned::Started(follow) => return Ok(follow),
            Turned::Lost if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Turned::Lost => return Err(busy()),
        }
    }
}

/// Sends a turn to the thread's Claude keeper, or starts one that resumes the
/// session when there is none (ADR-0041 decision 1). A socket whose
/// subscription ended, `unsubscribed`, follows the keeper that takes the turn.
async fn claude_turn<M: Machine>(
    machine: &Arc<M>,
    name: &str,
    place: &Place,
    turn: Next,
    unsubscribed: bool,
) -> Result<Turned<Option<Follow>>, Failure> {
    // A keeper that is closing takes no turn; the next one resumes the session.
    let deadline = tokio::time::Instant::now() + STOP_GRACE + STOP_GRACE;
    while let Some(live) = machine.registry().live(&place.id)
        && live.lock().closing
        && tokio::time::Instant::now() < deadline
    {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if let Some(live) = machine.registry().live(&place.id) {
        if !machine.registry().mark_busy(&live)? {
            return Ok(Turned::Lost);
        }
        let follow = if unsubscribed {
            live.subscribe()
                .map(|(_, _, receiver)| Follow::New(receiver))
        } else {
            None
        };
        tracing::info!("chat {name}: a turn started");
        live.command(Command::Turn(turn));
        return Ok(Turned::Started(follow));
    }
    let Some(mut claim) = Claim::take(machine, place) else {
        return Ok(Turned::Lost);
    };
    let started = match resumable(machine.as_ref(), name, place).await {
        Ok(resumed) => {
            machine
                .start(place, &turn.prompt(), resumed.as_deref())
                .await
        }
        Err(said) => Err(said),
    };
    let KeptClaude {
        session,
        events,
        run,
        resumed,
    } = match started {
        Ok(Started::Running(kept)) => kept,
        Ok(Started::Busy) => {
            // A keeper no task reads yet is read now, so the next attach sees it.
            if let Err(refusal) = adopt_claimed(machine, name, place.clone(), &claim).await {
                tracing::warn!("chat {name}: {}", refusal.said);
            }
            return Err(busy());
        }
        Err(said) => {
            tracing::warn!("chat {name}: {said}");
            return Err(failure(Kind::Unreachable, said));
        }
    };
    claim.started = true;
    let (live, commands) = Live::new(place, run, true);
    live.lock().prompts = 1;
    let receiver = live.subscribe().map(|(_, _, receiver)| receiver);
    if !machine.registry().insert(&live) {
        return Ok(Turned::Lost);
    }
    claim.started = false;
    drop(claim);
    tracing::info!("chat {name}: a turn started");
    live.event(&claude::prompted(
        thread::name(place),
        &live.run,
        1,
        turn.text,
    ));
    tokio::spawn(keep_claude(
        Arc::clone(machine),
        name.to_owned(),
        place.clone(),
        live,
        commands,
        ClaudeKeeper {
            session,
            events: Some(events),
            mode: turn.mode,
            remembered: resumed,
        },
    ));
    Ok(Turned::Started(receiver.map(Follow::New)))
}

/// How a socket follows the keeper that takes its turn.
enum Follow {
    /// A subscription taken before the keeper sent anything.
    New(broadcast::Receiver<Sent>),
    /// A keeper that another task started; its events so far are replayed.
    Replay(Subscribed),
}

/// Sends a turn to the thread's ACP keeper, starting one that loads the session when it has gone.
/// A socket whose subscription ended, `unsubscribed`, follows the keeper that takes the turn.
async fn acp_turn<M: Machine>(
    machine: &Arc<M>,
    name: &str,
    here: &Here,
    harness: Harness,
    Next {
        text,
        mode,
        context,
        ..
    }: Next,
    unsubscribed: bool,
) -> Result<Turned<Option<Follow>>, Failure> {
    let mut subscribed = None;
    // A keeper that is stopping takes no turn; the next one loads the session.
    let deadline = tokio::time::Instant::now() + STOP_GRACE + STOP_GRACE;
    while let Some(live) = machine.registry().live(&here.place.id)
        && live.lock().closing
        && tokio::time::Instant::now() < deadline
    {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let live = match machine.registry().live(&here.place.id) {
        Some(live) => {
            if unsubscribed {
                subscribed = live
                    .subscribe()
                    .map(|(_, _, receiver)| Follow::New(receiver));
            }
            live
        }
        None => {
            let (_, receiver) = connect(
                machine,
                name,
                &here.place,
                harness,
                here.session.clone(),
                context,
            )
            .await?;
            let gone = || failure(Kind::Unreachable, "the agent's keeper went away");
            let live = machine.registry().live(&here.place.id).ok_or_else(gone)?;
            subscribed = Some(match receiver {
                Some(receiver) => Follow::New(receiver),
                // Another task started it meanwhile, and has sent events already.
                None => Follow::Replay(live.subscribe().ok_or_else(gone)?),
            });
            live
        }
    };
    if !machine.registry().mark_busy(&live)? {
        return Ok(Turned::Lost);
    }
    tracing::info!("chat {name}: a turn started");
    live.command(Command::Turn(Next {
        text,
        mode,
        interaction: Interaction::Build,
        model: None,
        effort: None,
        context: None,
        room: false,
    }));
    Ok(Turned::Started(subscribed))
}

/// Starts `harness` in a keeper and loads `session` or makes one, or reads back a keeper already
/// there. The subscription is `None` for a keeper another task reads, which may have sent events.
async fn connect<M: Machine>(
    machine: &Arc<M>,
    name: &str,
    place: &Place,
    harness: Harness,
    session: Option<String>,
    context: Option<ContextLength>,
) -> Result<(String, Option<broadcast::Receiver<Sent>>), Failure> {
    let Some(mut claim) = Claim::wait(machine, place).await? else {
        return Ok((session.unwrap_or_default(), None));
    };
    let started = tokio::time::timeout(
        CONNECT_WITHIN,
        start_session(machine, name, place, harness, session, context, &mut claim),
    )
    .await;
    match started {
        Ok(started) => started,
        Err(_) => {
            claim.stop().await;
            Err(failure(
                Kind::Unreachable,
                format!(
                    "{} did not open a session within {} seconds",
                    harness.name(),
                    CONNECT_WITHIN.as_secs()
                ),
            ))
        }
    }
}

async fn start_session<M: Machine>(
    machine: &Arc<M>,
    name: &str,
    place: &Place,
    harness: Harness,
    session: Option<String>,
    context: Option<ContextLength>,
    claim: &mut Claim<M>,
) -> Result<(String, Option<broadcast::Receiver<Sent>>), Failure> {
    match machine.start_acp(place, harness, context).await {
        Ok(Started::Running(kept)) => {
            claim.started = true;
            let (session, receiver) =
                run_session(machine, name, place, harness, session, kept, claim).await?;
            Ok((session, Some(receiver)))
        }
        Ok(Started::Busy) => {
            adopt_claimed(machine, name, place.clone(), claim).await?;
            Ok((session.unwrap_or_default(), None))
        }
        Err(said) => Err(failure(Kind::Unreachable, said)),
    }
}

/// `receiver`, or a subscription to the thread's live keeper.
fn subscribing<M: Machine>(
    machine: &M,
    place: &Place,
    receiver: Option<broadcast::Receiver<Sent>>,
) -> Result<broadcast::Receiver<Sent>, Failure> {
    receiver
        .or_else(|| {
            let live = machine.registry().live(&place.id)?;
            live.subscribe().map(|(_, _, receiver)| receiver)
        })
        .ok_or_else(|| failure(Kind::Unreachable, "the agent's keeper went away"))
}

/// Opens the session in a keeper just started, and starts its task.
async fn run_session<M: Machine>(
    machine: &Arc<M>,
    name: &str,
    place: &Place,
    harness: Harness,
    session: Option<String>,
    KeptAgent { agent, events, run }: KeptAgent,
    claim: &mut Claim<M>,
) -> Result<(String, broadcast::Receiver<Sent>), Failure> {
    let opened = open_session(machine.as_ref(), place, harness, &agent, session).await;
    let (session, login) = match opened {
        Ok(opened) => opened,
        Err(refusal) => {
            // The keeper goes with the start that failed.
            drop(agent);
            if let Err(said) = machine.finish(place, Duration::ZERO).await {
                tracing::warn!("chat {name}: the keeper stays: {said}");
            }
            claim.started = false;
            return Err(refusal);
        }
    };
    let (live, commands) = Live::new(place, run, false);
    let (_, _, receiver) = live
        .subscribe()
        .ok_or_else(|| failure(Kind::Unreachable, "the agent's keeper went away"))?;
    if !machine.registry().insert(&live) {
        return Err(busy());
    }
    claim.started = false;
    tokio::spawn(keep_acp(
        Arc::clone(machine),
        name.to_owned(),
        place.clone(),
        live,
        commands,
        AcpAgent {
            harness,
            agent: Arc::new(agent),
            events: Some(events),
            session: session.clone(),
            login,
            asked: HashMap::new(),
            mode: PermissionMode::default(),
            prompt: None,
        },
    ));
    Ok((session, receiver))
}

async fn open_session<M: Machine>(
    machine: &M,
    place: &Place,
    harness: Harness,
    agent: &Agent,
    session: Option<String>,
) -> Result<(String, Option<String>), Failure> {
    let capabilities = agent
        .initialize()
        .await
        .map_err(|error| refused(machine.machine(), harness, None, &error))?;
    let login = capabilities.login;
    // An agent that cannot load starts a new conversation in the same worktree.
    let session = match session.filter(|_| capabilities.load_session) {
        Some(session) => {
            agent
                .load_session(&session, &place.worktree)
                .await
                .map_err(|error| refused(machine.machine(), harness, login.clone(), &error))?;
            session
        }
        None => {
            let session = agent
                .new_session(&place.worktree)
                .await
                .map_err(|error| refused(machine.machine(), harness, login.clone(), &error))?;
            let stored = store_session(machine, place, harness.name(), &session).await;
            if let Err(said) = machine.remember(place, harness, &session).await {
                if !stored {
                    return Err(failure(Kind::Unreachable, said));
                }
                tracing::warn!(
                    "chat {}: the session is not in git config: {said}",
                    place.id
                );
            }
            session
        }
    };
    Ok((session, login))
}

/// One Claude session a keeper holds, across turns.
struct ClaudeKeeper {
    session: Session,
    /// `None` once Claude's stdout has ended.
    events: Option<Events>,
    /// The mode the running turn was sent with.
    mode: PermissionMode,
    /// The session id the thread's git config keeps.
    remembered: Option<String>,
}

/// What a Claude keeper's task heard next.
enum Heeded {
    Command(Option<Command>),
    Event(Option<ThreadEvent>),
    Kill,
    Idle,
}

/// Reads one Claude keeper for as long as its process lives (ADR-0041): runs
/// each turn, answers what the mode answers, keeps each turn's checkpoint, a
/// wake turn's too, and closes the keeper once the thread is idle, its
/// background tasks have been silent too long, or `out` has passed half its
/// cap with no task running.
async fn keep_claude<M: Machine>(
    machine: Arc<M>,
    name: String,
    place: Place,
    live: Arc<Live>,
    mut commands: mpsc::UnboundedReceiver<Command>,
    mut claude: ClaudeKeeper,
) {
    let thread = thread::name(&place).to_owned();
    let idle = claude_idle();
    let mut kill_at: Option<tokio::time::Instant> = None;
    // When the thread last had a turn end or a task start or end.
    let mut quiet = tokio::time::Instant::now();
    // Background work pins the keeper, and every line Claude writes restarts the pin.
    let close_at = |claude: &ClaudeKeeper, quiet: tokio::time::Instant| {
        let state = live.lock();
        (!state.busy && !state.closing).then(|| {
            if claude.session.background().is_empty() {
                quiet + idle
            } else {
                claude.session.heard().map_or(quiet, |at| at.max(quiet)) + PIN
            }
        })
    };
    loop {
        let closes = close_at(&claude, quiet);
        let heeded = tokio::select! {
            command = commands.recv() => Heeded::Command(command),
            event = next_event(&mut claude.events) => Heeded::Event(event),
            () = until(kill_at) => Heeded::Kill,
            () = until(closes) => Heeded::Idle,
        };
        match heeded {
            Heeded::Command(Some(Command::Turn(turn))) => {
                send_turn(machine.as_ref(), &name, &place, &live, &mut claude, turn).await;
            }
            Heeded::Command(Some(Command::Answer {
                request,
                decision,
                answers,
                reply,
            })) => {
                let answered = claude.session.answer(&request, decision, answers);
                let _ = reply.send(answered.map_err(|error| chain(&error)));
            }
            Heeded::Command(Some(Command::Cancel)) => {
                if live.busy() {
                    claude.session.cancel();
                    kill_at.get_or_insert(tokio::time::Instant::now() + STOP_GRACE);
                }
            }
            Heeded::Command(Some(Command::StopTask { task, reply })) => {
                let stopped = claude.session.stop_task(&task);
                let _ = reply.send(stopped.map_err(|error| chain(&error)));
            }
            Heeded::Command(Some(Command::StopAll)) => {
                for task in claude.session.background() {
                    let _ = claude.session.stop_task(&task);
                }
                if live.busy() {
                    claude.session.cancel();
                }
                live.lock().closing = true;
                close_claude(&claude, &mut kill_at);
            }
            Heeded::Command(None) => {}
            Heeded::Event(None) => break,
            Heeded::Event(Some(event)) => {
                match &event.event {
                    Event::RequestOpened(opened) => {
                        if let Some(decision) = claude::answers(claude.mode, opened.scope) {
                            match claude.session.answer(&opened.request_id, decision, None) {
                                Ok(()) => continue,
                                Err(error) => tracing::warn!(
                                    "chat {name}: {:?} could not answer: {error}",
                                    claude.mode
                                ),
                            }
                        }
                        if !live.watched() {
                            machine
                                .registry()
                                .wait(&name, &thread, Phase::WaitingForApproval);
                        }
                    }
                    Event::TurnStarted => {
                        live.set_busy(true);
                        remember(machine.as_ref(), &name, &place, &mut claude).await;
                    }
                    Event::BackgroundUpdated { .. } => quiet = tokio::time::Instant::now(),
                    _ => {}
                }
                live.event(&event);
                if let Event::TurnCompleted(done) = &event.event {
                    tracing::info!("chat {name}: the turn ended {:?}", done.state);
                    let failed = done.state == TurnState::Failed;
                    if let Some(said) = done
                        .message
                        .as_ref()
                        .filter(|said| failed && said.starts_with(CLAUDE_NOT_LOGGED_IN))
                    {
                        live.publish(&not_logged_in(None, machine.machine(), said.clone()), None);
                    }
                    // A closing keeper keeps the deadline its close armed.
                    if !live.lock().closing {
                        kill_at = None;
                    }
                    claude_turn_ended(machine.as_ref(), &name, &place, &live, failed).await;
                    // A keeper with background work waits for it (ADR-0041 decision 9).
                    if claude.session.background().is_empty()
                        && let Ok(size) = machine.out_size(&place).await
                        && size > Limits::default().cap / 2
                        && live.close_unless_busy()
                    {
                        tracing::info!(
                            "chat {name}: the keeper's out is past half its cap, so it is replaced"
                        );
                        close_claude(&claude, &mut kill_at);
                    }
                    claude_next(machine.as_ref(), &name, &place, &live, &mut claude).await;
                    quiet = tokio::time::Instant::now();
                }
            }
            Heeded::Kill => {
                kill_at = None;
                tracing::info!("chat {name}: claude did not stop, so its keeper is killed");
                if let Err(said) = machine.finish(&place, Duration::ZERO).await {
                    tracing::warn!("chat {name}: {said}");
                }
            }
            Heeded::Idle => {
                // A line that made no event moved the pin since the wait began.
                let due =
                    close_at(&claude, quiet).is_some_and(|at| at <= tokio::time::Instant::now());
                if due && live.close_unless_busy() {
                    tracing::info!("chat {name}: the thread is idle, so its keeper closes");
                    close_claude(&claude, &mut kill_at);
                }
            }
        }
    }
    tracing::info!("chat {name}: claude ended");
    let (queued, next) = finish(machine.as_ref(), &name, &place, &live).await;
    drop(claude);
    let next = joined(next);
    if next.is_some() || !queued.is_empty() {
        tokio::spawn(async move {
            // The person's turn first, so the room's prompts queue behind it.
            if let Some(next) = next {
                send_queued(
                    Arc::clone(&machine),
                    name.clone(),
                    place.clone(),
                    None,
                    next,
                )
                .await;
            }
            if queued.is_empty() {
                return;
            }
            let (prompts, told): (Vec<String>, Vec<_>) = queued.into_iter().unzip();
            let woke = wake_on(machine, name, place, prompts.join("\n\n")).await;
            for tell in told {
                let _ = tell.send(woke);
            }
        });
    }
}

/// Sends a turn the thread is marked busy with to Claude: its mode, the prompt
/// the browser draws, and the prompt. A room's turn keeps the model, effort and context length. A keeper whose stdin has gone holds the
/// turn for the next one.
async fn send_turn<M: Machine>(
    machine: &M,
    name: &str,
    place: &Place,
    live: &Live,
    claude: &mut ClaudeKeeper,
    mut turn: Next,
) {
    if turn.room {
        (turn.model, turn.effort, turn.context) = claude.session.picked();
    }
    if let Err(said) = machine.write_mode(place, turn.mode).await {
        tracing::warn!("chat {name}: the mode was not written: {said}");
    }
    claude.mode = turn.mode;
    let n = {
        let mut state = live.lock();
        state.prompts += 1;
        state.prompts
    };
    if let Err(error) = claude.session.send_turn(&turn.prompt()) {
        tracing::warn!("chat {name}: the turn was not sent: {error}");
        live.lock().closing = true;
        if machine.registry().hold(live, turn).is_err() {
            live.set_busy(false);
        }
        return;
    }
    live.event(&claude::prompted(
        thread::name(place),
        &live.run,
        n,
        turn.text,
    ));
}

/// Keeps the session id of the turn that started, when it is new.
async fn remember<M: Machine>(machine: &M, name: &str, place: &Place, claude: &mut ClaudeKeeper) {
    let Some(session) = claude.session.session_id() else {
        return;
    };
    if claude.remembered.as_ref() == Some(&session) {
        return;
    }
    let stored = store_session(machine, place, name_of(None), &session).await;
    match machine.remember_claude(place, &session).await {
        Ok(()) => claude.remembered = Some(session),
        Err(said) => {
            tracing::warn!("chat {name}: the session id is not in git config: {said}");
            if stored {
                claude.remembered = Some(session);
            }
        }
    }
}

/// A thread as its store row keys it.
struct Key {
    workspace: String,
    thread: String,
    /// The branch and worktree the row keeps.
    place: Place,
}

/// The store and the thread's key in it, for a registry that has one. A home
/// thread's row has no workspace, branch or worktree (ADR-0046 decision 1.4).
fn stored_as<'a, M: Machine>(machine: &'a M, place: &Place) -> Option<(&'a Store, Key)> {
    let store = machine.registry().store.as_ref()?;
    let keeper = Keeper::of(place)?;
    let mut place = place.clone();
    let workspace = if keeper.workspace() == keep::HOME {
        place.branch.clear();
        place.worktree.clear();
        String::new()
    } else {
        keeper.workspace().to_owned()
    };
    let thread = keeper.thread().to_owned();
    Some((
        store,
        Key {
            workspace,
            thread,
            place,
        },
    ))
}

/// Writes a session to the store before git config (ADR-0045 decision 3).
/// `false` is a session the store does not hold.
async fn store_session<M: Machine>(
    machine: &M,
    place: &Place,
    harness: &str,
    session: &str,
) -> bool {
    let Some((store, key)) = stored_as(machine, place) else {
        return false;
    };
    let put = store
        .put_session(
            &key.workspace,
            &key.thread,
            machine.machine(),
            &key.place,
            harness,
            session,
        )
        .await;
    put.inspect_err(|error| {
        tracing::warn!(
            "chat {}: the store has no session: {}",
            place.id,
            chain(error)
        )
    })
    .is_ok()
}

/// The harness and session the store keeps for the thread. A store that
/// cannot be read is logged, and git config answers.
async fn stored<M: Machine>(machine: &M, place: &Place) -> Option<(String, String)> {
    let (store, key) = stored_as(machine, place)?;
    store
        .session(&key.workspace, &key.thread)
        .await
        .inspect_err(|error| {
            tracing::warn!(
                "chat {}: the store was not read: {}",
                place.id,
                chain(error)
            )
        })
        .ok()
        .flatten()
}

/// The session a new Claude keeper resumes. The store's wins and is written
/// back to git config, where an agent may have changed it; a thread the store
/// lacks is read from git config and kept (ADR-0045 decisions 4 and 5).
async fn resumable<M: Machine>(
    machine: &M,
    name: &str,
    place: &Place,
) -> Result<Option<String>, String> {
    let kept = machine.claude_session(place).await?;
    let Some((_, session)) = stored(machine, place)
        .await
        .filter(|(harness, _)| harness == name_of(None))
    else {
        if let Some(session) = &kept {
            store_session(machine, place, name_of(None), session).await;
        }
        return Ok(kept);
    };
    if kept.as_ref() != Some(&session) {
        tracing::warn!("chat {name}: git config names another session, so the store's resumes");
        if let Err(said) = machine.remember_claude(place, &session).await {
            tracing::warn!("chat {name}: the session id is not in git config: {said}");
        }
    }
    Ok(Some(session))
}

/// [`Machine::recall`], with the store's answer winning as [`resumable`]'s does.
/// `None` is a Claude thread.
async fn recalled<M: Machine>(
    machine: &M,
    place: &Place,
) -> Result<Option<(Harness, String)>, String> {
    let kept = machine.recall(place).await?;
    let Some((named, session)) = stored(machine, place).await else {
        if let Some((harness, session)) = &kept {
            store_session(machine, place, harness.name(), session).await;
        }
        return Ok(kept);
    };
    let harness = match harness_named(&named) {
        Ok(Some(harness)) => harness,
        Ok(None) => return Ok(None),
        Err(_) => return Ok(kept),
    };
    let wins = (harness, session);
    if kept.as_ref() != Some(&wins) {
        tracing::warn!(
            "chat {}: git config names another session, so the store's resumes",
            place.id
        );
        if let Err(said) = machine.remember(place, wins.0, &wins.1).await {
            tracing::warn!(
                "chat {}: the session is not in git config: {said}",
                place.id
            );
        }
    }
    Ok(Some(wins))
}

/// A Claude turn ended, a wake turn too: the thread is free, the tree is kept,
/// and nobody attached is told (ADR-0041 decision 3).
async fn claude_turn_ended<M: Machine>(
    machine: &M,
    name: &str,
    place: &Place,
    live: &Live,
    failed: bool,
) {
    checkpointed(machine, name, place, failed, live).await;
    if !live.watched() {
        machine
            .registry()
            .wait(name, thread::name(place), Phase::Completed);
    }
}

/// Sends what waits for the thread's next turn, unless the keeper closes: the
/// person's turns first, then a room's prompts (ADR-0041 decision 7).
async fn claude_next<M: Machine>(
    machine: &M,
    name: &str,
    place: &Place,
    live: &Live,
    claude: &mut ClaudeKeeper,
) {
    if let Some(turn) = joined(machine.registry().take_next(live)) {
        machine.registry().remember_mode(&live.id, turn.mode);
        send_turn(machine, name, place, live, claude, turn).await;
        return;
    }
    let queued = machine.registry().take_queued(live);
    if queued.is_empty() {
        return;
    }
    let (prompts, told): (Vec<String>, Vec<_>) = queued.into_iter().unzip();
    let turn = Next {
        text: prompts.join("\n\n"),
        mode: room::cap(machine.registry().mode(&live.id).unwrap_or_default()),
        interaction: Interaction::Build,
        model: None,
        effort: None,
        context: None,
        room: true,
    };
    send_turn(machine, name, place, live, claude, turn).await;
    tracing::info!(
        "chat {name}: a room message woke thread {}",
        thread::name(place)
    );
    for tell in told {
        let _ = tell.send(Woke::Started);
    }
}

/// Closes Claude's stdin, and kills it at `kill_at` if it ignores that.
fn close_claude(claude: &ClaudeKeeper, kill_at: &mut Option<tokio::time::Instant>) {
    claude.session.close();
    kill_at.get_or_insert(tokio::time::Instant::now() + STOP_GRACE);
}

async fn until(at: Option<tokio::time::Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// Removes an ended keeper's session (I-30) and lets its thread go. It returns
/// the room prompts and the person's turns queued for the thread; a room
/// prompt dropped tells its wake it failed.
async fn finish<M: Machine>(
    machine: &M,
    name: &str,
    place: &Place,
    live: &Live,
) -> (Vec<Queued>, Vec<Next>) {
    live.lock().closing = true;
    match machine.finish(place, STOP_GRACE).await {
        Ok(Some(ended)) => tracing::info!("chat {name}: the keeper ended {ended}"),
        Ok(None) => {}
        Err(said) => tracing::warn!("chat {name}: the keeper's session stays: {said}"),
    }
    let queued = machine.registry().forget(live);
    live.close();
    queued
}

/// Starts the turns a person queued behind a keeper that ended in a new
/// keeper: Claude's, or `acp`'s harness loading its session. Boxed like
/// [`wake_on`], because that keeper's end may start another.
fn send_queued<M: Machine>(
    machine: Arc<M>,
    name: String,
    place: Place,
    acp: Option<(Harness, String)>,
    next: Next,
) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(async move {
        if acp.is_none() {
            machine.registry().remember_mode(&place.id, next.mode);
        }
        let (harness, session) = acp.unzip();
        let here = Here {
            place,
            harness,
            session,
        };
        let place = &here.place;
        if let Err(refusal) = start_or_hold(&machine, &name, &here, next, false).await {
            tracing::warn!(
                "chat {name}: the queued turn did not start: {}",
                refusal.said
            );
            machine.registry().refuse(&place.id, &refusal);
        }
    })
}

type Prompt = Pin<Box<dyn Future<Output = Result<StopReason, acp::Error>> + Send>>;

/// One ACP agent a keeper holds, across turns.
struct AcpAgent {
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
    /// The mode the running turn was sent with.
    mode: PermissionMode,
    prompt: Option<Prompt>,
}

/// What an ACP keeper's task heard next.
enum Step {
    Command(Option<Command>),
    Event(Option<ThreadEvent>),
    Prompted(Result<StopReason, acp::Error>),
    Kill,
    Idle,
}

async fn finish_prompt(prompt: &mut Option<Prompt>) -> Result<StopReason, acp::Error> {
    match prompt {
        Some(running) => running.await,
        None => std::future::pending().await,
    }
}

async fn next_event(events: &mut Option<acp::Events>) -> Option<ThreadEvent> {
    match events {
        Some(open) => open.recv().await,
        None => std::future::pending().await,
    }
}

/// Reads one ACP keeper for as long as its agent lives: runs each turn,
/// answers what the mode answers, keeps each turn's checkpoint, and stops the
/// agent once the thread is idle or `out` has passed half its cap.
async fn keep_acp<M: Machine>(
    machine: Arc<M>,
    name: String,
    place: Place,
    live: Arc<Live>,
    mut commands: mpsc::UnboundedReceiver<Command>,
    mut acp: AcpAgent,
) {
    let thread = thread::name(&place).to_owned();
    let mut kill_at: Option<tokio::time::Instant> = None;
    let mut quiet_since = tokio::time::Instant::now();
    let mut idle = tokio::time::interval(IDLE_TICK);
    loop {
        let step = tokio::select! {
            command = commands.recv() => Step::Command(command),
            event = next_event(&mut acp.events) => Step::Event(event),
            result = finish_prompt(&mut acp.prompt) => Step::Prompted(result),
            () = until(kill_at) => Step::Kill,
            _ = idle.tick() => Step::Idle,
        };
        match step {
            Step::Command(Some(Command::Turn(Next { text, mode, .. }))) => {
                prompt(machine.as_ref(), &name, &place, &live, &mut acp, text, mode).await;
            }
            Step::Command(Some(Command::Answer {
                request,
                decision,
                answers,
                reply,
            })) => {
                let _ = reply.send(if answers.is_some() {
                    Err(format!("{} asks no questions", acp.harness.name()))
                } else {
                    answer(&acp, &request, decision)
                });
            }
            // An ACP agent has no background task Yantra knows of, so stopping all stops the turn.
            Step::Command(Some(Command::Cancel | Command::StopAll)) => {
                if live.busy() {
                    // An agent that is gone has no turn left to stop.
                    let _ = acp.agent.cancel(&acp.session);
                    kill_at.get_or_insert(tokio::time::Instant::now() + STOP_GRACE);
                }
            }
            Step::Command(Some(Command::StopTask { reply, .. })) => {
                let _ = reply.send(Err(format!(
                    "{} runs no background task Yantra can stop",
                    acp.harness.name()
                )));
            }
            Step::Command(None) => {}
            Step::Event(None) => break,
            Step::Event(Some(event)) => {
                quiet_since = tokio::time::Instant::now();
                let Some(event) = relabel(&thread, event) else {
                    continue;
                };
                match &event.event {
                    Event::RequestOpened(opened) => {
                        acp.asked
                            .insert(opened.request_id.clone(), opened.options.clone());
                        if let Some(decision) = acp.mode.answers(opened.scope) {
                            // An agent that offered no such option is asked by the person.
                            match answer(&acp, &opened.request_id, decision) {
                                Ok(()) => continue,
                                Err(said) => tracing::warn!(
                                    "chat {name}: {:?} could not answer: {said}",
                                    acp.mode
                                ),
                            }
                        }
                        if !live.watched() {
                            machine
                                .registry()
                                .wait(&name, &thread, Phase::WaitingForApproval);
                        }
                    }
                    Event::RequestResolved(resolved) => {
                        acp.asked.remove(&resolved.request_id);
                    }
                    Event::TurnStarted => live.set_busy(true),
                    _ => {}
                }
                let ended = matches!(event.event, Event::TurnCompleted(_));
                let failed = matches!(&event.event,
                    Event::TurnCompleted(done) if done.state == TurnState::Failed);
                live.event(&event);
                // A turn an earlier daemon sent has no prompt here to end it.
                if ended && acp.prompt.is_none() {
                    turn_ended(machine.as_ref(), &name, &place, &live, failed, &mut kill_at).await;
                    prompt_next(machine.as_ref(), &name, &place, &live, &mut acp).await;
                }
            }
            Step::Prompted(result) => {
                acp.prompt = None;
                drain(&mut acp, &thread, &live);
                let failed = result.is_err();
                match result {
                    Ok(reason) => tracing::info!("chat {name}: the turn ended {reason:?}"),
                    Err(error) => {
                        tracing::info!("chat {name}: the turn failed");
                        live.publish(
                            &refused(machine.machine(), acp.harness, acp.login.clone(), &error),
                            None,
                        );
                    }
                }
                turn_ended(machine.as_ref(), &name, &place, &live, failed, &mut kill_at).await;
                prompt_next(machine.as_ref(), &name, &place, &live, &mut acp).await;
                quiet_since = tokio::time::Instant::now();
            }
            Step::Kill => {
                kill_at = None;
                let closing = live.lock().closing;
                if live.busy() || closing {
                    tracing::info!("chat {name}: the agent did not stop, so its keeper is killed");
                    if let Err(said) = machine.finish(&place, Duration::ZERO).await {
                        tracing::warn!("chat {name}: {said}");
                        // The keeper stays, so it takes turns again, the held ones first.
                        live.lock().closing = false;
                        prompt_next(machine.as_ref(), &name, &place, &live, &mut acp).await;
                    }
                }
            }
            Step::Idle => {
                if !live.busy() && !live.watched() && quiet_since.elapsed() >= IDLE {
                    tracing::info!("chat {name}: the thread is idle, so its agent stops");
                    close_agent(machine.as_ref(), &name, &place, &live, &mut kill_at).await;
                    // A close that failed takes the turns held while it ran.
                    prompt_next(machine.as_ref(), &name, &place, &live, &mut acp).await;
                    quiet_since = tokio::time::Instant::now();
                }
            }
        }
    }
    tracing::info!("chat {name}: the agent ended");
    let (_, next) = finish(machine.as_ref(), &name, &place, &live).await;
    // A keeper that closed with turns queued hands them to the next one.
    if let Some(next) = joined(next) {
        let acp = Some((acp.harness, acp.session));
        tokio::spawn(send_queued(machine, name, place, acp, next));
    }
}

/// Sends the turns queued behind the one that ended, unless the keeper closes.
async fn prompt_next<M: Machine>(
    machine: &M,
    name: &str,
    place: &Place,
    live: &Live,
    acp: &mut AcpAgent,
) {
    if let Some(Next { text, mode, .. }) = joined(machine.registry().take_next(live)) {
        prompt(machine, name, place, live, acp, text, mode).await;
    }
}

/// Sends a turn the thread is marked busy with to the agent: its mode, the prompt the browser
/// draws, and the prompt.
async fn prompt<M: Machine>(
    machine: &M,
    name: &str,
    place: &Place,
    live: &Live,
    acp: &mut AcpAgent,
    text: String,
    mode: PermissionMode,
) {
    if let Err(said) = machine.write_mode(place, mode).await {
        tracing::warn!("chat {name}: the mode was not written: {said}");
    }
    acp.mode = mode;
    let n = {
        let mut state = live.lock();
        state.prompts += 1;
        state.prompts
    };
    let item = format!("{}:{n}", live.run);
    live.publish(
        &delta(place, StreamKind::UserText, text.clone(), &item),
        None,
    );
    let agent = Arc::clone(&acp.agent);
    let session = acp.session.clone();
    acp.prompt = Some(Box::pin(async move { agent.prompt(&session, &text).await }));
}

/// An ACP turn ended: the thread is free, the tree is kept, and a keeper whose
/// `out` has passed half its cap stops, so the next turn loads the session in
/// a new one (ADR-0035 decision 5).
async fn turn_ended<M: Machine>(
    machine: &M,
    name: &str,
    place: &Place,
    live: &Live,
    failed: bool,
    kill_at: &mut Option<tokio::time::Instant>,
) {
    *kill_at = None;
    checkpointed(machine, name, place, failed, live).await;
    if let Ok(size) = machine.out_size(place).await
        && size > Limits::default().cap / 2
    {
        tracing::info!("chat {name}: the keeper's out is past half its cap, so it is replaced");
        close_agent(machine, name, place, live, kill_at).await;
    }
}

/// Ends an idle agent: it takes no turn while it closes, and the kill at
/// `kill_at` ends one that ignores the closed stdin.
async fn close_agent<M: Machine>(
    machine: &M,
    name: &str,
    place: &Place,
    live: &Live,
    kill_at: &mut Option<tokio::time::Instant>,
) {
    {
        let mut state = live.lock();
        if state.busy {
            return;
        }
        state.closing = true;
    }
    match machine.close_stdin(place, &live.run).await {
        Ok(()) => *kill_at = Some(tokio::time::Instant::now() + STOP_GRACE),
        Err(said) => {
            tracing::warn!("chat {name}: {said}");
            live.lock().closing = false;
        }
    }
}

/// Sends on what the agent said before it answered, so every event arrives in
/// order.
fn drain(acp: &mut AcpAgent, thread: &str, live: &Live) {
    while let Some(event) = acp
        .events
        .as_mut()
        .and_then(|events| events.try_recv().ok())
    {
        if let Some(event) = relabel(thread, event) {
            if let Event::RequestResolved(resolved) = &event.event {
                acp.asked.remove(&resolved.request_id);
            }
            live.event(&event);
        }
    }
}

/// The browser's decision, as the option the agent offered for it.
fn answer(acp: &AcpAgent, request: &str, decision: Decision) -> Result<(), String> {
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

/// Starts a turn in thread `thread` of `workspace` with a room's `prompt`,
/// or queues it while a turn runs there (ADR-0038 decision 3). It resolves
/// once a turn starts with the prompt or cannot, so the room gives back what
/// did not arrive.
pub async fn wake(registry: Registry, workspace: String, thread: String, prompt: String) -> Woke {
    let woke = async {
        let fleet = Arc::new(Fleet::of(&workspace, registry)?);
        let Some(place) = fleet.find(&thread).await? else {
            tracing::info!("chat {workspace}: thread {thread} is gone, so it is not woken");
            return Ok(Woke::Never);
        };
        Ok::<Woke, String>(wake_on(fleet, workspace.clone(), place, prompt).await)
    }
    .await;
    woke.unwrap_or_else(|said| {
        tracing::warn!("chat {workspace}: thread {thread} was not woken: {said}");
        Woke::Failed
    })
}

/// The turn runs at [`room::cap`] of the person's last mode, and as
/// `Supervised` when this daemon has not seen one. An ACP thread is never
/// woken: `--mcp-config` is Claude's. A queued prompt resolves when the turn
/// it waits for ends and the next one starts or cannot. Boxed, because a
/// turn's end may wake its thread again.
fn wake_on<M: Machine>(
    machine: Arc<M>,
    name: String,
    place: Place,
    prompt: String,
) -> Pin<Box<dyn Future<Output = Woke> + Send>> {
    Box::pin(async move {
        let thread = thread::name(&place).to_owned();
        match recalled(machine.as_ref(), &place).await {
            Ok(None) => {}
            Ok(Some((harness, _))) => {
                tracing::info!(
                    "chat {name}: thread {thread} is {}'s, so a room message does not wake it",
                    harness.name()
                );
                return Woke::Never;
            }
            Err(said) => {
                tracing::warn!("chat {name}: thread {thread} was not woken: {said}");
                return Woke::Failed;
            }
        }
        let reverting = || machine.registry().lock().reverting.contains(&place.id);
        let mut checkpointed = !machine.tracked();
        let deadline = tokio::time::Instant::now() + CONNECT_WITHIN;
        loop {
            if let Some(heard) = machine.registry().queue(&place.id, &prompt) {
                tracing::info!("chat {name}: a room message waits for thread {thread}'s turn");
                return heard.await.unwrap_or(Woke::Failed);
            }
            // As in `begin`: a revert first, then a checkpoint, then the turn.
            if reverting() {
                tracing::info!("chat {name}: thread {thread} is reverting, so it was not woken");
                return Woke::Failed;
            }
            if !checkpointed {
                if let Err(said) = within(machine.base(&place)).await {
                    tracing::warn!(
                        "chat {name}: no checkpoint, so thread {thread} was not woken: {said}"
                    );
                    return Woke::Failed;
                }
                checkpointed = true;
                continue;
            }
            let mode = room::cap(machine.registry().mode(&place.id).unwrap_or_default());
            let turn = Next {
                text: prompt.clone(),
                mode,
                interaction: Interaction::Build,
                model: None,
                effort: None,
                context: None,
                room: true,
            };
            match claude_turn(&machine, &name, &place, turn, false).await {
                Ok(Turned::Started(_)) => {
                    tracing::info!("chat {name}: a room message woke thread {thread}");
                    return Woke::Started;
                }
                Ok(Turned::Lost) => {}
                Err(refusal) if refusal.kind != Kind::Busy => {
                    tracing::warn!(
                        "chat {name}: thread {thread} was not woken: {}",
                        refusal.said
                    );
                    return Woke::Failed;
                }
                Err(_) => {}
            }
            if tokio::time::Instant::now() >= deadline {
                tracing::warn!(
                    "chat {name}: thread {thread} stayed busy, so a room message was given back"
                );
                return Woke::Failed;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
}

/// Starts a home thread on `machine` with `prompt`, for `yantra chat new
/// --home` (ADR-0046 decision 1.1), and answers its id. The turn runs with no
/// socket, as a room's wake does.
pub async fn start_home(
    registry: Registry,
    machine: &str,
    prompt: String,
) -> Result<String, String> {
    let home = Arc::new(Home::on(machine, registry)?);
    let id = thread::new_id().map_err(|error| chain(&error))?;
    let place = home.open(&id).await?;
    tracing::info!("chat home on {machine} opened thread {id}");
    titled(home.as_ref(), keep::HOME, &place, &prompt).await;
    let turn = Next {
        text: prompt,
        mode: PermissionMode::Supervised,
        interaction: Interaction::Build,
        model: None,
        effort: None,
        context: None,
        room: false,
    };
    match claude_turn(&home, keep::HOME, &place, turn, false).await {
        Ok(Turned::Started(_)) => Ok(id),
        Ok(Turned::Lost) => Err(busy().said),
        Err(refusal) => Err(refusal.said),
    }
}

/// Removes home thread `id` on `machine`: its keeper, its journals and its
/// row, and no file in `$HOME` (ADR-0046 decision 1.7). `false` is a thread
/// the machine does not have.
pub async fn remove_home(registry: Registry, machine: &str, id: &str) -> Result<bool, String> {
    forget(&Home::on(machine, registry)?, id).await
}

async fn forget<M: Machine>(machine: &M, id: &str) -> Result<bool, String> {
    let Some(place) = machine.find(id).await? else {
        return Ok(false);
    };
    machine.remove(&place).await?;
    let (store, key) = stored_as(machine, &place).ok_or(NO_STORE)?;
    store
        .remove(&key.workspace, &key.thread)
        .await
        .map_err(|error| chain(&error))
}

/// Reads back the keeper of the thread `thread` in workspace `workspace` on
/// `machine`, which no task of this daemon holds (ADR-0035 decision 9). The
/// refresh pass calls it for each keeper session it finds.
pub async fn adopt(registry: &Registry, machine: &str, workspace: &str, thread: &str) {
    if registry.holds(&Keeper::new(workspace, thread).session()) {
        return;
    }
    let adopted = adopted(registry, machine, workspace, thread).await;
    let session = Keeper::new(workspace, thread).session();
    match adopted {
        Ok(None) => {
            registry.lock().gone.remove(&session);
        }
        // Said once while it stays, and looked at again on every pass.
        Ok(Some(said)) => {
            if registry.lock().gone.insert(session) {
                tracing::warn!("chat {workspace}: keeper {thread} was not adopted: {said}");
            }
        }
        Err(said) => tracing::warn!("chat {workspace}: keeper {thread} was not adopted: {said}"),
    }
}

/// [`adopt`] on a home thread's machine or on its workspace's.
async fn adopted(
    registry: &Registry,
    machine: &str,
    workspace: &str,
    thread: &str,
) -> Result<Option<String>, String> {
    if workspace == keep::HOME {
        let home = Home::on(machine, registry.clone())?;
        return adopt_in(&Arc::new(home), workspace, thread).await;
    }
    match workspace::load(workspace) {
        Ok(loaded) => {
            adopt_in(
                &Arc::new(Fleet::on(loaded, registry.clone())?),
                workspace,
                thread,
            )
            .await
        }
        Err(error @ workspace::Error::NotFound { .. }) => Ok(Some(chain(&error))),
        Err(error) => Err(chain(&error)),
    }
}

/// [`adopt`] on a workspace's machine. `Some` says why a keeper whose thread
/// is gone stays: its agent still runs, so it is killed only once it ends.
async fn adopt_in<M: Machine>(
    machine: &Arc<M>,
    name: &str,
    thread: &str,
) -> Result<Option<String>, String> {
    let Some(place) = machine.find(thread).await? else {
        if machine.kill_orphan(thread).await? {
            tracing::info!("chat {name}: thread {thread} is gone, so its keeper was killed");
            return Ok(None);
        }
        return Ok(Some(format!(
            "{name} has no chat thread {thread}, and its agent still runs"
        )));
    };
    // A pass never waits: a task that holds the thread reads its keeper.
    let Some(claim) = Claim::take(machine, &place) else {
        return Ok(None);
    };
    adopt_claimed(machine, name, place, &claim)
        .await
        .map(|()| None)
        .map_err(|refusal| refusal.said)
}

/// Reads back a thread's keeper unless a task reads it already, waiting while
/// another task starts or reads it back.
async fn adopt_place<M: Machine>(
    machine: &Arc<M>,
    name: &str,
    place: Place,
) -> Result<(), Failure> {
    match Claim::wait(machine, &place).await? {
        Some(claim) => adopt_claimed(machine, name, place, &claim).await,
        None => Ok(()),
    }
}

/// Reads back a thread's keeper and starts its task, answering what its mode
/// answers and noting what waits. The caller holds the thread's claim.
async fn adopt_claimed<M: Machine>(
    machine: &Arc<M>,
    name: &str,
    place: Place,
    _claim: &Claim<M>,
) -> Result<(), Failure> {
    let unreachable = |said: String| failure(Kind::Unreachable, said);
    let kept = recalled(machine.as_ref(), &place)
        .await
        .map_err(unreachable)?;
    let harness = kept.as_ref().map(|(harness, _)| *harness);
    let Some(adopted) = machine.adopt(&place, harness).await.map_err(unreachable)? else {
        return Ok(());
    };
    let thread = thread::name(&place).to_owned();
    match adopted {
        Adopted::Claude {
            session,
            events,
            run,
            replayed,
            mode,
            running,
            prompts,
        } => {
            // An idle keeper is adopted live too: its process waits for the next turn.
            let (live, commands) = Live::new(&place, run, running);
            {
                let mut state = live.lock();
                state.last = last_cursor(&replayed);
                state.prompts = prompts;
            }
            if !machine.registry().insert(&live) {
                return Ok(());
            }
            tracing::info!("chat {name}: adopted the keeper of thread {thread}");
            if running {
                for (request, scope, _) in waiting(&replayed) {
                    match claude::answers(mode, scope) {
                        Some(decision) => {
                            if let Err(error) = session.answer(&request, decision, None) {
                                tracing::warn!("chat {name}: {mode:?} could not answer: {error}");
                            }
                        }
                        None => machine
                            .registry()
                            .wait(name, &thread, Phase::WaitingForApproval),
                    }
                }
            }
            tokio::spawn(keep_claude(
                Arc::clone(machine),
                name.to_owned(),
                place,
                live,
                commands,
                ClaudeKeeper {
                    session,
                    events: Some(events),
                    mode,
                    remembered: None,
                },
            ));
        }
        Adopted::Acp {
            agent,
            events,
            run,
            replayed,
            mode,
            prompting,
            prompts,
        } => {
            let Some((harness, session)) = kept else {
                return Err(unreachable(format!("thread {thread} keeps no harness")));
            };
            let (live, commands) = Live::new(&place, run, prompting);
            {
                let mut state = live.lock();
                state.last = last_cursor(&replayed);
                state.prompts = prompts;
            }
            if !machine.registry().insert(&live) {
                return Ok(());
            }
            tracing::info!("chat {name}: adopted the keeper of thread {thread}");
            let mut acp = AcpAgent {
                harness,
                agent: Arc::new(agent),
                events: Some(events),
                session,
                login: None,
                asked: HashMap::new(),
                mode,
                prompt: None,
            };
            for (request, scope, options) in waiting(&replayed) {
                acp.asked.insert(request.clone(), options);
                match mode.answers(scope) {
                    Some(decision) => {
                        if let Err(said) = answer(&acp, &request, decision) {
                            tracing::warn!("chat {name}: {mode:?} could not answer: {said}");
                        }
                    }
                    None => machine
                        .registry()
                        .wait(name, &thread, Phase::WaitingForApproval),
                }
            }
            tokio::spawn(keep_acp(
                Arc::clone(machine),
                name.to_owned(),
                place,
                live,
                commands,
                acp,
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::expect_used)]
pub(crate) fn answers() -> Vec<(&'static str, &'static str, serde_json::Value)> {
    use yantra_core::chat::{
        BackgroundTask, Item, ItemStatus, ItemType, RequestOpened, RequestResolved, RequestType,
        Scope, TokenUsage, TurnCompleted,
    };
    use yantra_core::checkpoint::FileStat;
    let at = |cursor: Option<&str>, event| {
        serde_json::to_value(ThreadEvent {
            thread_id: "1a2b3c4d".to_owned(),
            cursor: cursor.map(str::to_owned),
            event,
        })
        .expect("an event serialises")
    };
    let event = |event| at(None, event);
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
                at(
                    Some("Y0123456789abcdef:812:0"),
                    Event::ContentDelta(ContentDelta {
                        stream_kind: StreamKind::AssistantText,
                        delta: "Running the tests.".to_owned(),
                        item_id: Some("msg_1:1".to_owned()),
                    }),
                ),
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
                    questions: vec![],
                    scope: Scope::Other,
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
                event(Event::CommandsUpdated {
                    commands: vec![yantra_core::chat::Command {
                        name: "review".to_owned(),
                        description: "review changes".to_owned(),
                        hint: Some("<branch>".to_owned()),
                    }],
                }),
                at(
                    Some("Y0123456789abcdef:1630:0"),
                    Event::BackgroundUpdated {
                        tasks: vec![BackgroundTask {
                            task_id: "b561loltj".to_owned(),
                            kind: "local_bash".to_owned(),
                            description: "Background sleep then echo completion marker".to_owned(),
                        }],
                    },
                ),
                event(Event::BackgroundUpdated { tasks: vec![] }),
                event(Event::TokenUsageUpdated(TokenUsage {
                    used_tokens: 29_149,
                    max_tokens: 200_000,
                })),
                event(Event::TurnCompleted(TurnCompleted {
                    duration_ms: None,
                    state: TurnState::Completed,
                    stop_reason: Some(StopReason::EndTurn),
                    message: None,
                })),
                event(Event::TurnCompleted(TurnCompleted {
                    duration_ms: None,
                    state: TurnState::Failed,
                    stop_reason: None,
                    message: Some("Not logged in · Please run /login".to_owned()),
                })),
            ]),
        ),
        (
            "chatCheckpoints",
            "ThreadEvent[]",
            serde_json::Value::Array(vec![
                event(Event::TurnDiffUpdated(TurnDiff {
                    turn: 1,
                    unified_diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n\
                                   @@ -1 +1 @@\n-one\n+two\n"
                        .to_owned(),
                    truncated: false,
                })),
                event(Event::ThreadReverted { turn: 0 }),
            ]),
        ),
        (
            "chatFailure",
            "ChatFailure",
            serde_json::to_value(failure(Kind::Busy, "a turn is running"))
                .expect("a failure serialises"),
        ),
        (
            "chatCheckpointFailed",
            "ChatFailure",
            serde_json::to_value(failure(
                Kind::Checkpoint,
                "git could not keep or restore a checkpoint: fatal: unable to write new index file",
            ))
            .expect("a failure serialises"),
        ),
        (
            "chatStopTaskFailed",
            "ChatFailure",
            serde_json::to_value(failure(
                Kind::StopTask,
                "no background task `b561loltj` is running",
            ))
            .expect("a failure serialises"),
        ),
        (
            "chatDiffFailed",
            "ChatFailure",
            serde_json::to_value(failure(
                Kind::Diff,
                "git could not keep or restore a checkpoint: fatal: bad object HEAD",
            ))
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
                path: "/home/u/.yantra/keep/web/1a2b3c4d/images/Y0123456789abcdef-1.png".to_owned(),
            })
            .expect("an attachment serialises"),
        ),
        (
            "chatBranchDiff",
            "ChatBranchDiff",
            serde_json::to_value(BranchDiffReply::of(
                &Place {
                    id: "chat/web/1a2b3c4d".to_owned(),
                    repo: "/home/u/web".to_owned(),
                    worktree: "/home/u/.yantra/worktrees/chat/web/1a2b3c4d".to_owned(),
                    branch: "yantra/chat/web/1a2b3c4d".to_owned(),
                    base: "0123abcd".to_owned(),
                },
                BranchDiff {
                    base: "0123abcd0123abcd0123abcd0123abcd0123abcd".to_owned(),
                    files: vec![
                        FileStat {
                            path: "src/new.rs".to_owned(),
                            from: Some("src/old.rs".to_owned()),
                            added: Some(3),
                            deleted: Some(1),
                        },
                        FileStat {
                            path: "logo.png".to_owned(),
                            from: None,
                            added: None,
                            deleted: None,
                        },
                    ],
                    files_truncated: false,
                    diff: Diff {
                        unified: "diff --git a/src/old.rs b/src/new.rs\n".to_owned(),
                        truncated: false,
                    },
                },
            ))
            .expect("a branch diff serialises"),
        ),
        (
            "chatQueue",
            "ChatQueue",
            serde_json::to_value(QueueFrame::of(
                "chat/web/1a2b3c4d",
                &[Next {
                    text: "and the docs".to_owned(),
                    mode: PermissionMode::Supervised,
                    interaction: Interaction::Build,
                    model: None,
                    effort: None,
                    context: None,
                    room: false,
                }],
            ))
            .expect("a queue serialises"),
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
                    mode: PermissionMode::AutoAcceptEdits,
                    interaction: Interaction::Build,
                    model: None,
                    effort: None,
                    context: None,
                }),
                frame(Frame::Turn {
                    text: "and the docs".to_owned(),
                    harness: None,
                    mode: PermissionMode::Supervised,
                    interaction: Interaction::Plan,
                    model: None,
                    effort: None,
                    context: None,
                }),
                frame(Frame::Turn {
                    text: "think it through".to_owned(),
                    harness: None,
                    mode: PermissionMode::Supervised,
                    interaction: Interaction::Build,
                    model: Model::try_from("opus".to_owned()).ok(),
                    effort: Some(Effort::High),
                    context: ContextLength::try_from(400_000).ok(),
                }),
                frame(Frame::Answer {
                    request_id: "r1".to_owned(),
                    decision: Decision::AcceptAlways,
                    answers: None,
                }),
                frame(Frame::Cancel),
                frame(Frame::StopTask {
                    task_id: "b561loltj".to_owned(),
                }),
                frame(Frame::StopAll),
                frame(Frame::Revert { turn: 0 }),
                frame(Frame::Diff),
                frame(Frame::Ping),
            ]),
        ),
        (
            "chatPong",
            "ChatPong",
            serde_json::to_value(Pong { tag: "pong" }).expect("a pong serialises"),
        ),
        (
            "chatQuery",
            "ChatQuery",
            serde_json::to_value(ChatQuery {
                thread: Some("1a2b3c4d".to_owned()),
                after: Some("Y0123456789abcdef:812:0".to_owned()),
            })
            .expect("a query serialises"),
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::watch;
    use yantra_core::checkpoint::FileStat;
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

    fn home_place() -> Place {
        Place {
            id: format!("chat/{}/{THREAD}", keep::HOME),
            repo: String::new(),
            worktree: "/home/u".to_owned(),
            branch: String::new(),
            base: String::new(),
        }
    }

    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// What a keeper's journals hold, as `keep.sh` writes them.
    #[derive(Debug, Default, Clone)]
    struct Journal {
        run: String,
        out: Vec<u8>,
        input: Vec<u8>,
        mode: Option<PermissionMode>,
        alive: bool,
    }

    /// One keeper: its journals, and what stops its pipes as a closed stdin
    /// and a killed session would.
    struct Keep {
        journal: Arc<Mutex<Journal>>,
        stdin: watch::Sender<bool>,
        kill: watch::Sender<bool>,
    }

    impl Keep {
        fn new(journal: Journal) -> Self {
            Self {
                journal: Arc::new(Mutex::new(journal)),
                stdin: watch::Sender::new(false),
                kill: watch::Sender::new(false),
            }
        }

        fn alive(&self) -> bool {
            lock(&self.journal).alive
        }

        /// The daemon's reader and writer, and the agent's ends, with every
        /// line on its way recorded in the journal.
        fn pipes(&self) -> (DuplexStream, DuplexStream, End) {
            let (daemon_writes, into_in) = tokio::io::duplex(1 << 16);
            let (to_agent, agent_hears) = tokio::io::duplex(1 << 16);
            let (agent_says, from_agent) = tokio::io::duplex(1 << 16);
            let (to_daemon, daemon_reads) = tokio::io::duplex(1 << 16);
            let mut stdin = self.stdin.subscribe();
            let mut killed = self.kill.subscribe();
            tokio::spawn(pump(
                into_in,
                to_agent,
                Arc::clone(&self.journal),
                File::In,
                async move {
                    tokio::select! {
                        _ = stdin.wait_for(|closed| *closed) => {}
                        _ = killed.wait_for(|killed| *killed) => {}
                    }
                },
            ));
            let mut killed = self.kill.subscribe();
            tokio::spawn(pump(
                from_agent,
                to_daemon,
                Arc::clone(&self.journal),
                File::Out,
                async move {
                    let _ = killed.wait_for(|killed| *killed).await;
                },
            ));
            (
                daemon_reads,
                daemon_writes,
                End {
                    hears: BufReader::new(agent_hears),
                    says: agent_says,
                },
            )
        }
    }

    async fn pump(
        from: DuplexStream,
        mut to: DuplexStream,
        journal: Arc<Mutex<Journal>>,
        file: File,
        stop: impl Future<Output = ()>,
    ) {
        let mut from = BufReader::new(from);
        tokio::pin!(stop);
        loop {
            let mut line = Vec::new();
            tokio::select! {
                read = from.read_until(b'\n', &mut line) => {
                    if !matches!(read, Ok(n) if n > 0) {
                        return;
                    }
                    {
                        let mut journal = lock(&journal);
                        match file {
                            File::Out => journal.out.extend_from_slice(&line),
                            _ => journal.input.extend_from_slice(&line),
                        }
                    }
                    if to.write_all(&line).await.is_err() {
                        return;
                    }
                }
                () = &mut stop => return,
            }
        }
    }

    /// The agent's end of a keeper's pipes.
    struct End {
        hears: BufReader<DuplexStream>,
        says: DuplexStream,
    }

    impl End {
        async fn line(&mut self) -> Option<Value> {
            let mut line = String::new();
            let read =
                tokio::time::timeout(Duration::from_secs(5), self.hears.read_line(&mut line))
                    .await
                    .expect("the daemon writes or closes within 5 s")
                    .expect("the pipe reads");
            (read > 0).then(|| serde_json::from_str(&line).expect("a JSON line"))
        }

        async fn write(&mut self, line: Value) {
            self.says
                .write_all(format!("{line}\n").as_bytes())
                .await
                .expect("the pipe writes");
        }
    }

    /// Claude's end of one turn's keeper.
    struct Claude(End);

    impl Claude {
        async fn heard(&mut self) -> Option<Value> {
            self.0.line().await
        }

        async fn say(&mut self, line: Value) {
            self.0.write(line).await;
        }
    }

    /// An ACP agent's end of its keeper, as `acp.rs`'s tests script it.
    struct Acp(End);

    impl Acp {
        async fn heard(&mut self) -> Value {
            self.0.line().await.expect("the daemon writes a line")
        }

        /// Whether stdin closed with nothing more written.
        async fn closed(&mut self) -> bool {
            self.0.line().await.is_none()
        }

        async fn say(&mut self, message: Value) {
            self.0.write(message).await;
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

    fn said() -> Said {
        Box::pin(async { String::new() })
    }

    /// A machine with one thread, whose keepers are pipes the test holds.
    #[derive(Default)]
    struct Script {
        /// Its thread is a home thread, which keeps no checkpoint.
        home: bool,
        threads: Vec<Place>,
        history: Vec<logs::Entry>,
        unreachable: bool,
        /// Each makes one call of the machine fail, as ssh would.
        recall_fails: bool,
        remember_fails: bool,
        start_acp_fails: bool,
        /// What the thread's git config keeps.
        kept: Option<(Harness, String)>,
        /// The thread's keeper, which a test may start the script with.
        keep: Mutex<Option<Keep>>,
        runs: Mutex<u32>,
        turns: Mutex<Vec<Claude>>,
        agents: Mutex<Vec<Acp>>,
        /// The context length each ACP keeper was started with.
        contexts: Mutex<Vec<Option<ContextLength>>>,
        opened: Mutex<usize>,
        removed: Mutex<usize>,
        remembered: Mutex<Vec<(Harness, String)>>,
        titled: Mutex<Vec<String>>,
        title_fails: bool,
        /// Each write of an image fails, as a full disk would.
        put_fails: bool,
        /// The size of each image that reached the machine.
        put: Mutex<Vec<usize>>,
        cleared: Mutex<usize>,
        /// Each Claude session id the thread was told to keep.
        claude_sessions: Mutex<Vec<String>>,
        /// The Claude session id the thread's git config keeps.
        claude_kept: Option<String>,
        /// The permission mode each Claude keeper was started with.
        modes: Mutex<Vec<PermissionMode>>,
        /// The command each Claude turn would run.
        commands: Mutex<Vec<String>>,
        /// How long each `finish` was given, and each closed stdin.
        finished: Mutex<Vec<Duration>>,
        stdin_closed: Mutex<usize>,
        /// Each makes one checkpoint call fail, as git would.
        base_fails: bool,
        capture_fails: bool,
        revert_fails: bool,
        branch_fails: bool,
        /// How many checkpoints the thread holds.
        checkpoints: Mutex<u32>,
        reverted: Mutex<Vec<u32>>,
        /// Capture never answers, as a machine that went to sleep.
        capture_hangs: bool,
        /// Holds each capture until notified, as a slow git would.
        capture_gate: Option<Arc<tokio::sync::Notify>>,
        /// What `out_size` says in place of the journal's size.
        out_bytes: Option<u64>,
        /// Holds a Claude start after its keeper exists, until notified.
        start_gate: Option<Arc<tokio::sync::Notify>>,
        /// Holds a branch diff until notified, as a slow git would.
        branch_gate: Option<Arc<tokio::sync::Notify>>,
        /// How many keepers were read back.
        adopted: Mutex<usize>,
        /// Each orphan keeper killed.
        orphans: Mutex<Vec<String>>,
        /// An orphan's agent still runs, so it is not killed.
        orphan_runs: bool,
        /// Shared by every tab connected to this script.
        registry: Registry,
    }

    impl Script {
        /// A script whose thread already has a keeper, as after a restart.
        fn keeping(self, journal: Journal) -> Self {
            *lock(&self.keep) = Some(Keep::new(Journal {
                alive: true,
                ..journal
            }));
            self
        }

        async fn claude(&self) -> Claude {
            for _ in 0..500 {
                let found = {
                    let mut turns = lock(&self.turns);
                    (!turns.is_empty()).then(|| turns.remove(0))
                };
                if let Some(turn) = found {
                    return turn;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("no turn started within 5 s");
        }

        async fn agent(&self) -> Acp {
            for _ in 0..500 {
                let found = {
                    let mut agents = lock(&self.agents);
                    (!agents.is_empty()).then(|| agents.remove(0))
                };
                if let Some(agent) = found {
                    return agent;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("no agent started within 5 s");
        }

        fn journal(&self) -> Journal {
            lock(&self.keep)
                .as_ref()
                .map(|keep| lock(&keep.journal).clone())
                .unwrap_or_default()
        }

        /// A new keeper, unless one is alive. Its pipes are the test's.
        fn begin(
            &self,
            mode: Option<PermissionMode>,
        ) -> Option<(String, DuplexStream, DuplexStream, End)> {
            let mut keep = lock(&self.keep);
            if keep.as_ref().is_some_and(Keep::alive) {
                return None;
            }
            let run = {
                let mut runs = lock(&self.runs);
                *runs += 1;
                runs.to_string()
            };
            let started = Keep::new(Journal {
                run: run.clone(),
                mode,
                alive: true,
                ..Journal::default()
            });
            let (reader, writer, end) = started.pipes();
            *keep = Some(started);
            Some((run, reader, writer, end))
        }
    }

    impl Machine for Script {
        fn machine(&self) -> &str {
            "m"
        }

        fn registry(&self) -> &Registry {
            &self.registry
        }

        fn tracked(&self) -> bool {
            !self.home
        }

        async fn open(&self, _: &str) -> Result<Place, String> {
            if self.unreachable {
                return Err("ssh: connect to host m port 22: Connection refused".to_owned());
            }
            *lock(&self.opened) += 1;
            Ok(if self.home { home_place() } else { place() })
        }

        async fn find(&self, id: &str) -> Result<Option<Place>, String> {
            Ok(self
                .threads
                .iter()
                .find(|place| thread::name(place) == id)
                .cloned())
        }

        async fn remove(&self, _: &Place) -> Result<(), String> {
            *lock(&self.removed) += 1;
            Ok(())
        }

        async fn history(&self, _: &Place) -> Result<Vec<logs::Entry>, String> {
            Ok(self.history.clone())
        }

        async fn start(
            &self,
            place: &Place,
            first: &claude::Prompt<'_>,
            resumed: Option<&str>,
        ) -> Result<Started<KeptClaude>, String> {
            let Some((run, reader, writer, end)) = self.begin(Some(first.mode)) else {
                return Ok(Started::Busy);
            };
            lock(&self.modes).push(first.mode);
            lock(&self.commands).push(claude::command(
                &place.worktree,
                &keeper_of(place)?,
                first.mode,
                first.interaction,
                first.model,
                first.effort,
                first.context,
                None,
                resumed,
            ));
            lock(&self.turns).push(Claude(end));
            if let Some(gate) = &self.start_gate {
                gate.notified().await;
            }
            let (session, events) =
                Session::kept(reader, writer, thread::name(place), &run, first, said());
            Ok(Started::Running(KeptClaude {
                session,
                events,
                run,
                resumed: resumed.map(str::to_owned),
            }))
        }

        async fn claude_session(&self, _: &Place) -> Result<Option<String>, String> {
            Ok(self.claude_kept.clone())
        }

        async fn remember_claude(&self, _: &Place, session: &str) -> Result<(), String> {
            lock(&self.claude_sessions).push(session.to_owned());
            Ok(())
        }

        async fn put(&self, images: &mut Images, bytes: &[u8]) -> Result<String, image::Error> {
            let fails = self.put_fails;
            images
                .put_with(bytes, |_| async move {
                    let mut put = lock(&self.put);
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
            *lock(&self.cleared) += 1;
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
            lock(&self.remembered).push((harness, session.to_owned()));
            Ok(())
        }

        async fn remember_title(&self, _: &Place, title: &str) -> Result<(), String> {
            if self.title_fails {
                return Err("git config: could not lock config file".to_owned());
            }
            lock(&self.titled).push(title.to_owned());
            Ok(())
        }

        async fn start_acp(
            &self,
            _: &Place,
            harness: Harness,
            context: Option<ContextLength>,
        ) -> Result<Started<KeptAgent>, String> {
            if self.start_acp_fails {
                return Err("ssh: could not start the agent".to_owned());
            }
            let Some((run, reader, writer, end)) = self.begin(None) else {
                return Ok(Started::Busy);
            };
            lock(&self.agents).push(Acp(end));
            lock(&self.contexts).push(context);
            let (agent, events) = Agent::kept(harness, reader, writer, &run, context, said());
            Ok(Started::Running(KeptAgent { agent, events, run }))
        }

        async fn adopt(
            &self,
            place: &Place,
            harness: Option<Harness>,
        ) -> Result<Option<Adopted>, String> {
            let keep = lock(&self.keep);
            let Some(keep) = keep.as_ref().filter(|keep| keep.alive()) else {
                return Ok(None);
            };
            let Journal {
                run,
                out,
                input,
                mode,
                ..
            } = lock(&keep.journal).clone();
            let (reader, writer, end) = keep.pipes();
            *lock(&self.adopted) += 1;
            let mode = mode.unwrap_or_default();
            Ok(Some(match harness {
                None => {
                    lock(&self.turns).push(Claude(end));
                    let replayed = claude::replay(thread::name(place), &run, &out, &input);
                    let (events, running, prompts) = (
                        replayed.events.clone(),
                        replayed.running(),
                        replayed.prompts.len(),
                    );
                    let (session, live) = Session::resume(reader, writer, replayed, said());
                    Adopted::Claude {
                        session,
                        events: live,
                        run,
                        replayed: events,
                        mode,
                        running,
                        prompts,
                    }
                }
                Some(harness) => {
                    lock(&self.agents).push(Acp(end));
                    let replayed = acp::replay(&run, &out, &input);
                    let (events, prompting, prompts) = (
                        replayed.events.clone(),
                        replayed.prompting(),
                        replayed.prompts,
                    );
                    let (agent, live) = Agent::resume(harness, reader, writer, replayed, said());
                    Adopted::Acp {
                        agent,
                        events: live,
                        run,
                        replayed: events,
                        mode,
                        prompting,
                        prompts,
                    }
                }
            }))
        }

        async fn journals(&self, _: &Place, upto: Option<u64>) -> Result<Journals, String> {
            let journal = self.journal();
            if journal.run.is_empty() {
                return Err("cat: no such file: run".to_owned());
            }
            let upto = upto
                .and_then(|upto| usize::try_from(upto).ok())
                .unwrap_or(usize::MAX)
                .min(journal.out.len());
            Ok(Journals {
                run: journal.run,
                out: journal.out[..upto].to_vec(),
                input: journal.input,
                said: String::new(),
            })
        }

        async fn write_mode(&self, _: &Place, mode: PermissionMode) -> Result<(), String> {
            if let Some(keep) = lock(&self.keep).as_ref() {
                lock(&keep.journal).mode = Some(mode);
            }
            Ok(())
        }

        async fn close_stdin(&self, _: &Place, _: &str) -> Result<(), String> {
            *lock(&self.stdin_closed) += 1;
            if let Some(keep) = lock(&self.keep).as_ref() {
                keep.stdin.send_replace(true);
            }
            Ok(())
        }

        async fn out_size(&self, _: &Place) -> Result<u64, String> {
            Ok(self
                .out_bytes
                .unwrap_or_else(|| self.journal().out.len() as u64))
        }

        async fn finish(&self, _: &Place, within: Duration) -> Result<Option<String>, String> {
            lock(&self.finished).push(within);
            if let Some(keep) = lock(&self.keep).as_ref() {
                lock(&keep.journal).alive = false;
                keep.kill.send_replace(true);
            }
            Ok(Some("with status 0".to_owned()))
        }

        async fn base(&self, _: &Place) -> Result<Option<u32>, String> {
            if self.base_fails {
                return Err("git: fatal: Unable to create index.lock: File exists".to_owned());
            }
            let mut held = lock(&self.checkpoints);
            if *held > 0 {
                return Ok(None);
            }
            *held = 1;
            Ok(Some(0))
        }

        async fn capture(&self, _: &Place) -> Result<u32, String> {
            if self.capture_fails {
                return Err("git: fatal: unable to write new index file".to_owned());
            }
            if self.capture_hangs {
                std::future::pending::<()>().await;
            }
            if let Some(gate) = &self.capture_gate {
                gate.notified().await;
            }
            let mut held = lock(&self.checkpoints);
            *held += 1;
            Ok(*held - 1)
        }

        async fn diff(&self, _: &Place, turn: u32) -> Result<Diff, String> {
            Ok(Diff {
                unified: format!("diff for turn {turn}\n"),
                truncated: false,
            })
        }

        async fn latest(&self, _: &Place) -> Result<Option<u32>, String> {
            Ok(lock(&self.checkpoints)
                .checked_sub(1)
                .filter(|&turn| turn > 0))
        }

        async fn branch_diff(&self, _: &Place) -> Result<BranchDiff, String> {
            if let Some(gate) = &self.branch_gate {
                gate.notified().await;
            }
            if self.branch_fails {
                return Err("git: fatal: the branch has no merge-base with HEAD".to_owned());
            }
            Ok(BranchDiff {
                base: "0123abcd".to_owned(),
                files: vec![
                    FileStat {
                        path: "new.txt".to_owned(),
                        from: Some("old.txt".to_owned()),
                        added: Some(2),
                        deleted: Some(0),
                    },
                    FileStat {
                        path: "blob.bin".to_owned(),
                        from: None,
                        added: None,
                        deleted: None,
                    },
                ],
                files_truncated: false,
                diff: Diff {
                    unified: "diff --git a/old.txt b/new.txt\n".to_owned(),
                    truncated: false,
                },
            })
        }

        async fn revert(&self, _: &Place, turn: u32) -> Result<(), String> {
            if self.revert_fails {
                return Err("the thread has no checkpoint 4".to_owned());
            }
            lock(&self.reverted).push(turn);
            Ok(())
        }

        async fn kill_orphan(&self, thread: &str) -> Result<bool, String> {
            if self.orphan_runs {
                return Ok(false);
            }
            lock(&self.orphans).push(thread.to_owned());
            Ok(true)
        }
    }

    /// The browser, as two channels. `held` stops the first frame the daemon
    /// sends: it says so on the sender, then waits for the receiver.
    struct Browser {
        from: mpsc::UnboundedReceiver<Heard>,
        to: mpsc::UnboundedSender<String>,
        held: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>,
        pings: Arc<AtomicUsize>,
        /// Answers each ping; a tab that slept has none.
        pong: Option<mpsc::WeakUnboundedSender<Heard>>,
    }

    impl Peer for Browser {
        async fn hear(&mut self) -> Option<Heard> {
            self.from.recv().await
        }

        async fn say_text(&mut self, text: String) -> bool {
            if let Some((reached, released)) = self.held.take() {
                let _ = reached.send(());
                let _ = released.await;
            }
            self.to.send(text).is_ok()
        }

        async fn ping(&mut self) -> bool {
            self.pings.fetch_add(1, Ordering::SeqCst);
            if let Some(back) = self.pong.as_ref().and_then(|back| back.upgrade()) {
                let _ = back.send(Heard::Pong);
            }
            true
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

        async fn next_after(&mut self, frame: Value) -> Value {
            self.send(frame);
            self.next().await
        }

        /// Whether nothing more arrives within a moment.
        async fn quiet(&mut self) -> bool {
            tokio::time::timeout(Duration::from_millis(200), self.heard.recv())
                .await
                .is_err()
        }

        fn close(&mut self) {
            self.send = None;
        }
    }

    fn connect(script: Arc<Script>, thread: Option<&str>) -> (Tab, tokio::task::JoinHandle<()>) {
        connect_after(script, thread, None)
    }

    fn connect_after(
        script: Arc<Script>,
        thread: Option<&str>,
        after: Option<&str>,
    ) -> (Tab, tokio::task::JoinHandle<()>) {
        connect_held(script, thread, after, None)
    }

    fn connect_held(
        script: Arc<Script>,
        thread: Option<&str>,
        after: Option<&str>,
        held: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>,
    ) -> (Tab, tokio::task::JoinHandle<()>) {
        let (tab, served, _) = connect_pinged(script, thread, after, held, true);
        (tab, served)
    }

    fn connect_pinged(
        script: Arc<Script>,
        thread: Option<&str>,
        after: Option<&str>,
        held: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>,
        answering: bool,
    ) -> (Tab, tokio::task::JoinHandle<()>, Arc<AtomicUsize>) {
        let (send, from) = mpsc::unbounded_channel();
        let pong = answering.then(|| send.downgrade());
        let pings = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&pings);
        let (to, heard) = mpsc::unbounded_channel();
        let query = ChatQuery {
            thread: thread.map(str::to_owned),
            after: after.map(str::to_owned),
        };
        let served = tokio::spawn(async move {
            let mut browser = Browser {
                from,
                to,
                held,
                pings: counted,
                pong,
            };
            let name = if script.home { keep::HOME } else { "web" };
            converse(script, name, query, &mut browser).await;
        });
        (
            Tab {
                send: Some(send),
                heard,
            },
            served,
            pings,
        )
    }

    /// Waits for `done` to hold of the script, as a keeper's task runs apart
    /// from any socket.
    async fn until_script(script: &Script, done: impl Fn(&Script) -> bool) {
        for _ in 0..500 {
            if done(script) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the script never reached the state");
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
                {"streamKind": "user_text", "delta": "run the tests", "itemId": "user:1:1"}})
        );
        let mut claude = script.claude().await;
        assert_eq!(
            claude.heard().await.expect("the prompt")["message"]["content"][0]["text"],
            "run the tests"
        );
        claude
            .say(json!({"type": "system", "subtype": "init"}))
            .await;
        assert_eq!(tab.next().await["type"], "turn.started");

        // One turn at a time: a second waits for the first.
        assert_eq!(
            tab.next_after(json!({"type": "turn", "text": "and the docs"}))
                .await,
            queue(&["and the docs"])
        );

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
            json!({"type": "turn", "text": "hi", "model": "opus; touch /tmp/pwned"}),
            json!({"type": "turn", "text": "hi", "effort": "ultra"}),
            json!({"type": "turn", "text": "hi", "contextLength": 50_000}),
            json!({"type": "turn", "text": "hi", "contextLength": "1m; touch /tmp/pwned"}),
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

    #[tokio::test]
    async fn every_frame_the_browser_sends_parses() {
        for (text, frame) in [
            (
                r#"{"type":"turn","text":"hi"}"#,
                Frame::Turn {
                    text: "hi".to_owned(),
                    harness: None,
                    mode: PermissionMode::Supervised,
                    interaction: Interaction::Build,
                    model: None,
                    effort: None,
                    context: None,
                },
            ),
            (
                r#"{"type":"turn","text":"hi","harness":"codex","mode":"full-access"}"#,
                Frame::Turn {
                    text: "hi".to_owned(),
                    harness: Some("codex".to_owned()),
                    mode: PermissionMode::FullAccess,
                    interaction: Interaction::Build,
                    model: None,
                    effort: None,
                    context: None,
                },
            ),
            (
                r#"{"type":"turn","text":"hi","interaction":"plan"}"#,
                Frame::Turn {
                    text: "hi".to_owned(),
                    harness: None,
                    mode: PermissionMode::Supervised,
                    interaction: Interaction::Plan,
                    model: None,
                    effort: None,
                    context: None,
                },
            ),
            (
                r#"{"type":"answer","requestId":"r","decision":"acceptAlways"}"#,
                Frame::Answer {
                    request_id: "r".to_owned(),
                    decision: Decision::AcceptAlways,
                    answers: None,
                },
            ),
            (
                r#"{"type":"turn","text":"hi","model":"claude-opus-5-5","effort":"xhigh"}"#,
                Frame::Turn {
                    text: "hi".to_owned(),
                    harness: None,
                    mode: PermissionMode::Supervised,
                    interaction: Interaction::Build,
                    model: Model::try_from("claude-opus-5-5".to_owned()).ok(),
                    effort: Some(Effort::Xhigh),
                    context: None,
                },
            ),
            (
                r#"{"type":"turn","text":"hi","harness":"codex","contextLength":1000000}"#,
                Frame::Turn {
                    text: "hi".to_owned(),
                    harness: Some("codex".to_owned()),
                    mode: PermissionMode::Supervised,
                    interaction: Interaction::Build,
                    model: None,
                    effort: None,
                    context: ContextLength::try_from(1_000_000).ok(),
                },
            ),
            (r#"{"type":"cancel"}"#, Frame::Cancel),
            (r#"{"type":"revert","turn":2}"#, Frame::Revert { turn: 2 }),
            (r#"{"type":"diff"}"#, Frame::Diff),
        ] {
            let parsed: Frame = serde_json::from_str(text).expect("a frame parses");
            assert_eq!(format!("{parsed:?}"), format!("{frame:?}"));
        }
    }

    #[tokio::test]
    async fn an_answer_reaches_claude_and_a_closed_socket_only_detaches() {
        let script = Arc::new(Script::default());
        let (mut tab, served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "touch a"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
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
        tokio::time::timeout(Duration::from_secs(5), served)
            .await
            .expect("the socket's task ends")
            .expect("it did not panic");
        claude
            .say(json!({"type": "result", "subtype": "success", "is_error": false}))
            .await;
        until_turn_over(&script).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(300), claude.heard())
                .await
                .is_err(),
            "no interrupt, and stdin stays open for the next turn"
        );
        assert!(lock(&script.finished).is_empty(), "the keeper stays");
        assert_eq!(*lock(&script.checkpoints), 2, "0 and 1");
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
        no_queue(&mut tab).await;
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
        an_opencode_thread_in(script, "supervised").await
    }

    async fn an_opencode_thread_in(script: &Arc<Script>, mode: &str) -> (Tab, Acp, Value) {
        let (mut tab, _served) = connect(Arc::clone(script), None);
        tab.send(
            json!({"type": "turn", "text": "list the files", "harness": "opencode",
                        "mode": mode}),
        );
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
        assert_eq!(tab.next().await["payload"]["itemId"], "user:1:1");
        let prompt = agent.heard().await;
        assert_eq!(prompt["method"], "session/prompt");
        assert_eq!(prompt["params"]["sessionId"], SESSION);
        assert_eq!(tab.next().await["type"], "turn.started");
        (tab, agent, prompt)
    }

    #[tokio::test]
    async fn the_first_turn_titles_the_thread_and_a_failed_title_does_not_stop_it() {
        let script = Arc::new(Script::default());
        let (_tab, _agent, _prompt) = an_opencode_thread(&script).await;
        assert_eq!(*script.titled.lock().expect("a lock"), ["list the files"]);

        let script = Arc::new(Script {
            title_fails: true,
            ..Script::default()
        });
        let (_tab, _agent, prompt) = an_opencode_thread(&script).await;
        assert_eq!(prompt["method"], "session/prompt", "the turn still runs");
        assert!(script.titled.lock().expect("a lock").is_empty());
    }

    fn storing(claude_kept: Option<&str>) -> (Arc<Script>, Store) {
        let (store, _) = crate::store::tests::scratch();
        let script = Arc::new(Script {
            claude_kept: claude_kept.map(str::to_owned),
            registry: Registry::default().storing(store.clone()),
            ..Script::default()
        });
        (script, store)
    }

    /// ADR-0045 decision 4: an agent in the worktree that rewrites git config
    /// does not change which conversation resumes.
    #[tokio::test]
    async fn a_start_resumes_the_stores_session_and_writes_it_back_to_git_config() {
        let (script, store) = storing(Some("B"));
        store
            .put_session("web", THREAD, "m", &place(), "claude", "A")
            .await
            .expect("a row");

        a_claude_turn_in(&script, None).await;

        let commands = lock(&script.commands);
        assert!(commands[0].contains("--resume 'A'"), "{}", commands[0]);
        assert_eq!(*lock(&script.claude_sessions), ["A"]);
    }

    /// Decision 5: a thread made before the store resumes git config's session,
    /// and the store keeps it from then on.
    #[tokio::test]
    async fn a_thread_the_store_lacks_resumes_git_configs_session_and_keeps_it() {
        let (script, store) = storing(Some("B"));

        a_claude_turn_in(&script, None).await;

        assert!(lock(&script.commands)[0].contains("--resume 'B'"));
        assert!(
            lock(&script.claude_sessions).is_empty(),
            "git config says B"
        );
        assert_eq!(
            store.session("web", THREAD).await.expect("a read"),
            Some(("claude".to_owned(), "B".to_owned()))
        );
    }

    /// Decision 3: the session Claude's `init` names reaches the store and git config.
    #[tokio::test]
    async fn a_claude_session_reaches_the_store_and_git_config() {
        let (script, store) = storing(None);
        let (_tab, mut claude) = a_claude_turn_in(&script, None).await;

        claude
            .say(json!({"type": "system", "subtype": "init", "session_id": "S"}))
            .await;

        for _ in 0..500 {
            if !lock(&script.claude_sessions).is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(*lock(&script.claude_sessions), ["S"]);
        assert_eq!(
            store.session("web", THREAD).await.expect("a read"),
            Some(("claude".to_owned(), "S".to_owned()))
        );
        let rows = store.list("web").await.expect("rows");
        assert_eq!(rows[0].title.as_deref(), Some("fix it"));
    }

    /// Decision 3: an ACP thread whose git config write fails still starts,
    /// because the store holds its session and title.
    #[tokio::test]
    async fn an_acp_session_the_store_holds_survives_a_failed_git_write() {
        let (store, _) = crate::store::tests::scratch();
        let script = Arc::new(Script {
            remember_fails: true,
            registry: Registry::default().storing(store.clone()),
            ..Script::default()
        });

        let (_tab, _agent, prompt) = an_opencode_thread(&script).await;

        assert_eq!(prompt["method"], "session/prompt", "the turn runs");
        assert_eq!(
            store.session("web", THREAD).await.expect("a read"),
            Some(("opencode".to_owned(), SESSION.to_owned()))
        );
        let rows = store.list("web").await.expect("rows");
        assert_eq!(rows[0].title.as_deref(), Some("list the files"));
    }

    /// Decision 4 for ACP: the store's session is the one an attach loads.
    #[tokio::test]
    async fn recall_answers_the_stores_session_and_writes_it_back() {
        let (store, _) = crate::store::tests::scratch();
        store
            .put_session("web", THREAD, "m", &place(), "opencode", "A")
            .await
            .expect("a row");
        let script = Script {
            kept: Some((Harness::Opencode, "B".to_owned())),
            registry: Registry::default().storing(store),
            ..Script::default()
        };

        let recalled = recalled(&script, &place()).await.expect("recalled");

        assert_eq!(recalled, Some((Harness::Opencode, "A".to_owned())));
        assert_eq!(
            *lock(&script.remembered),
            [(Harness::Opencode, "A".to_owned())]
        );
    }

    #[test]
    fn a_turn_records_when_it_started_and_a_finished_or_adopted_one_does_not() {
        let registry = Registry::default();
        let (live, _commands) = Live::new(&place(), "1".to_owned(), false);
        assert!(registry.insert(&live));
        let name = THREAD.rsplit('/').next().expect("an id");
        let workspace = place()
            .id
            .split('/')
            .nth(1)
            .expect("a workspace")
            .to_owned();
        let doing = |registry: &Registry| registry.doing(&workspace);
        assert_eq!(doing(&registry), [(name.to_owned(), Doing::Idle)]);

        assert_eq!(registry.mark_busy(&live).ok(), Some(true));
        assert!(matches!(doing(&registry)[0].1, Doing::Working(Some(_))));
        live.set_busy(false);
        assert_eq!(doing(&registry)[0].1, Doing::Idle);

        let (adopted, _commands) = Live::new(&place(), "2".to_owned(), true);
        assert_eq!(adopted.lock().since, None);
        assert!(adopted.busy());
    }

    #[test]
    fn a_held_threads_activity_follows_its_turn_and_tool_and_bumps_the_watch() {
        use yantra_core::chat::{Item, ItemType};
        let registry = Registry::default();
        let mut changed = registry.changed();
        assert_eq!(registry.activity("web", THREAD), None, "not held");
        registry.hold_for_test(&format!("chat/web/{THREAD}"), true);
        assert!(changed.has_changed().expect("held"), "the hold bumps");
        changed.mark_unchanged();
        let busy = |tool: Option<&str>| {
            Some(room::Activity {
                busy: true,
                tool: tool.map(str::to_owned),
            })
        };
        assert_eq!(registry.activity("web", THREAD), busy(None));

        let live = registry.live(&format!("chat/web/{THREAD}")).expect("held");
        let item = |id: &str, title: Option<&str>| Item {
            item_id: id.to_owned(),
            item_type: Some(ItemType::CommandExecution),
            status: None,
            title: title.map(str::to_owned),
            output: None,
            changes: vec![],
        };
        let at = |event| ThreadEvent {
            thread_id: THREAD.to_owned(),
            cursor: None,
            event,
        };
        live.event(&at(Event::ItemStarted(item("t1", Some("cargo test")))));
        assert_eq!(registry.activity("web", THREAD), busy(Some("cargo test")));
        assert!(changed.has_changed().expect("held"));
        changed.mark_unchanged();

        live.event(&at(Event::ItemCompleted(item("t0", None))));
        assert_eq!(
            registry.activity("web", THREAD),
            busy(Some("cargo test")),
            "another item's end leaves the tool"
        );
        live.event(&at(Event::ItemCompleted(item("t1", None))));
        assert_eq!(registry.activity("web", THREAD), busy(None));
        live.event(&at(Event::ItemStarted(item("t2", None))));
        assert_eq!(
            registry.activity("web", THREAD),
            busy(Some("command_execution")),
            "an item with no title is named by its type"
        );
        changed.mark_unchanged();

        live.set_busy(false);
        assert!(changed.has_changed().expect("held"));
        live.event(&at(Event::TurnStarted));
        assert_eq!(
            registry.activity("web", THREAD),
            Some(room::Activity {
                busy: false,
                tool: None
            })
        );
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
    async fn cancel_sends_session_cancel_and_a_closed_socket_does_not() {
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
        assert_eq!(tab.next().await["type"], "turn.diff.updated");

        tab.send(json!({"type": "turn", "text": "again"}));
        assert_eq!(tab.next().await["payload"]["itemId"], "user:1:2");
        let again = agent.heard().await;
        assert_eq!(again["method"], "session/prompt");
        tab.close();
        agent.reply(&again, json!({"stopReason": "end_turn"})).await;
        until_script(&script, |script| *lock(&script.checkpoints) == 3).await;
        assert!(lock(&script.finished).is_empty(), "the agent stays");
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
        no_queue(&mut tab).await;
        let replayed = tab.next().await;
        assert_eq!(replayed["threadId"], THREAD);
        assert_eq!(
            replayed["payload"],
            json!({"streamKind": "user_text", "delta": "list the files", "itemId": "m0"})
        );
        tab.send(json!({"type": "turn", "text": "again", "harness": "opencode"}));
        assert_eq!(tab.next().await["payload"]["itemId"], "user:1:1");
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
        no_queue(&mut tab).await;
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
        let mut claude = script.claude().await;
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

    #[tokio::test]
    async fn a_ping_frame_gets_a_pong_and_no_error() {
        let (mut tab, _served) = connect(Arc::new(Script::default()), None);
        assert_eq!(
            tab.next_after(json!({"type": "ping"})).await,
            json!({"type": "pong"})
        );
        assert!(tab.quiet().await);
    }

    #[tokio::test]
    async fn a_peer_that_answers_no_ping_is_closed_after_the_misses() {
        let (_tab, served, pings) =
            connect_pinged(Arc::new(Script::default()), None, None, None, false);
        tokio::time::timeout(PING_EVERY * (u32::from(MISSES) + 6), served)
            .await
            .expect("the socket closes")
            .expect("the task ends cleanly");
        assert_eq!(pings.load(Ordering::SeqCst), usize::from(MISSES));
    }

    #[tokio::test]
    async fn a_peer_that_answers_pings_stays_open() {
        let (_tab, served, pings) =
            connect_pinged(Arc::new(Script::default()), None, None, None, true);
        tokio::time::sleep(PING_EVERY * (u32::from(MISSES) + 4)).await;
        assert!(!served.is_finished());
        assert!(pings.load(Ordering::SeqCst) > usize::from(MISSES));
    }

    #[tokio::test(start_paused = true)]
    async fn an_agent_that_never_answers_is_unreachable_and_frees_the_socket() {
        let script = Arc::new(Script {
            threads: vec![place()],
            kept: Some((Harness::Opencode, SESSION.to_owned())),
            ..Script::default()
        });
        let (mut tab, served) = connect(Arc::clone(&script), Some(THREAD));
        assert_eq!(tab.next().await["type"], "thread.started");
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
            assert_eq!(tab.next().await["type"], "thread.started");
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
        assert_eq!(tab.next().await["type"], "thread.started");
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
    fn the_thread_and_the_cursor_are_read_from_the_query() {
        let query = |text: &str| read_query(&text.parse::<Uri>().expect("a uri"));
        assert_eq!(
            query("/api/workspaces/w/chat?thread=1a2b3c4d&after=Y0a%3A812%3A0"),
            ChatQuery {
                thread: Some(THREAD.to_owned()),
                after: Some("Y0a:812:0".to_owned()),
            }
        );
        assert_eq!(
            query("/api/workspaces/w/chat?thread=&after="),
            ChatQuery::default()
        );
        assert_eq!(query("/api/workspaces/w/chat"), ChatQuery::default());
        assert_eq!(
            query("/api/workspaces/w/chat?after=%zz"),
            ChatQuery::default(),
            "a broken escape is no cursor"
        );
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
        handshake_to(caller, "/api/workspaces/web/chat").await
    }

    async fn handshake_to(caller: Option<Caller>, path: &str) -> String {
        let fake = Fake {
            machines: Vec::new(),
            addresses: Vec::new(),
            callers: caller
                .map(|caller| (LOCAL, caller))
                .into_iter()
                .collect::<BTreeMap<_, _>>(),
            owner: ME,
        };
        let app = Router::new().nest(
            "/api",
            router(
                Authoriser::new(fake, &[], std::path::Path::new("yantrad.sock")),
                Registry::default(),
            ),
        );
        let listener = TcpListener::bind((LOCAL, 0)).await.expect("a free port");
        let address = listener.local_addr().expect("it is bound");
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<crate::write::Peer>(),
            )
            .await;
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
                     Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
                )
                .as_bytes(),
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

    /// ADR-0046 decision 1.6: the home socket authorises first, and a machine
    /// name that is no ssh destination is a 400 before the upgrade (I-63).
    #[tokio::test]
    async fn the_home_route_refuses_a_stranger_and_a_bad_machine_name_before_the_upgrade() {
        let stranger = handshake_to(
            Some(caller(ME + 1, &[])),
            "/api/machines/-oProxyCommand=x/chat",
        )
        .await;
        assert!(stranger.starts_with("HTTP/1.1 403"), "{stranger}");
        let bad = handshake_to(Some(caller(ME, &[])), "/api/machines/-oProxyCommand=x/chat").await;
        assert!(bad.starts_with("HTTP/1.1 400"), "{bad}");
        let owner = handshake_to(Some(caller(ME, &[])), "/api/machines/box/chat").await;
        assert!(owner.starts_with("HTTP/1.1 101"), "{owner}");
    }

    /// A PNG's magic, then `len` bytes in all.
    /// The daemon ends a socket it chose to end with a close frame, so the
    /// browser does not take it for a network that dropped.
    #[tokio::test]
    async fn a_socket_the_daemon_ends_gets_a_close_frame() {
        use crate::terminal::tests::{TEXT, connect_to, frame, tailnet};
        let api = router(
            Authoriser::new(
                tailnet(vec![(LOCAL, caller(ME, &[]))]),
                &[],
                std::path::Path::new("yantrad.sock"),
            ),
            Registry::default(),
        );
        let mut socket = connect_to(
            api,
            "/api/workspaces/yantra-test-no-such-workspace/chat",
            "",
        )
        .await;
        let mut line = String::new();
        while line != "\r\n" {
            line.clear();
            socket.read_line(&mut line).await.expect("a header");
        }
        let (op, said) = frame(&mut socket).await.expect("a frame");
        assert_eq!(op, TEXT);
        assert!(String::from_utf8_lossy(&said).contains("unreachable"));
        let (op, _) = frame(&mut socket).await.expect("a frame");
        assert_eq!(op, 0x8, "a close frame");
    }

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

    /// ADR-0041: the live process reads the images directory from its start.
    #[tokio::test]
    async fn a_claude_turn_after_an_image_may_read_its_directory() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "before"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        claude
            .say(json!({"type": "result", "subtype": "success", "is_error": false}))
            .await;
        assert_eq!(tab.next().await["type"], "turn.completed");
        assert_eq!(tab.next().await["type"], "turn.diff.updated");

        tab.send_image(png(64));
        assert_eq!(tab.next().await["type"], "attached");
        tab.send(json!({"type": "turn", "text": format!("what is in {IMAGES}/1.png?")}));
        assert_eq!(
            prompt_of(&claude.heard().await.expect("a line")),
            format!("what is in {IMAGES}/1.png?")
        );
        let commands = lock(&script.commands);
        assert_eq!(commands.len(), 1, "one process for both turns");
        assert!(
            commands[0].contains(&format!(
                "--add-dir \"$HOME\"/.yantra/keep/'web'/'{THREAD}'/images"
            )),
            "{}",
            commands[0]
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

    /// A Claude turn on a new thread, from the prompt to `turn.completed`.
    async fn a_claude_turn_that_ends(script: &Arc<Script>) -> (Tab, Claude) {
        let (mut tab, _served) = connect(Arc::clone(script), None);
        tab.send(json!({"type": "turn", "text": "fix the test"}));
        assert_eq!(tab.next().await["type"], "thread.started");
        assert_eq!(tab.next().await["payload"]["itemId"], "user:1:1");
        let mut claude = script.claude().await;
        claude.heard().await;
        claude
            .say(
                json!({"type": "result", "subtype": "success", "is_error": false,
                        "stop_reason": "end_turn"}),
            )
            .await;
        assert_eq!(tab.next().await["type"], "turn.completed");
        (tab, claude)
    }

    #[tokio::test]
    async fn checkpoint_a_claude_turn_sends_completed_then_its_diff() {
        let script = Arc::new(Script::default());
        let (mut tab, _claude) = a_claude_turn_that_ends(&script).await;
        assert_eq!(
            tab.next().await,
            json!({"threadId": THREAD, "type": "turn.diff.updated", "payload":
                {"turn": 1, "unifiedDiff": "diff for turn 1\n", "truncated": false}})
        );
        assert_eq!(*script.checkpoints.lock().expect("a lock"), 2, "0 and 1");
    }

    /// A home thread on a script whose every checkpoint call would fail.
    fn home(store: Option<Store>) -> Arc<Script> {
        let registry = Registry::default();
        Arc::new(Script {
            home: true,
            threads: vec![home_place()],
            base_fails: true,
            capture_fails: true,
            revert_fails: true,
            branch_fails: true,
            registry: match store {
                Some(store) => registry.storing(store),
                None => registry,
            },
            ..Script::default()
        })
    }

    /// ADR-0046 decision 1.3: a home turn keeps no checkpoint, sends no diff
    /// and no checkpoint failure, and refuses a revert and a diff.
    #[tokio::test]
    async fn a_home_turn_skips_the_checkpoint_and_refuses_revert_and_diff() {
        let script = home(None);
        let (mut tab, _claude) = a_claude_turn_that_ends(&script).await;
        assert!(tab.quiet().await, "no diff and no checkpoint failure");
        assert_eq!(*lock(&script.checkpoints), 0, "no base and no capture");

        for frame in [
            json!({"type": "revert", "turn": 1}),
            json!({"type": "diff"}),
        ] {
            let said = tab.next_after(frame).await;
            assert_eq!(said["kind"], "badFrame", "{said}");
            assert!(
                said["said"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("home chat")
            );
        }
        assert!(lock(&script.reverted).is_empty());
    }

    /// ADR-0046 decision 1.4: a home thread resumes the session its row keeps.
    #[tokio::test]
    async fn a_home_thread_resumes_the_stored_session() {
        let (store, _) = crate::store::tests::scratch();
        store
            .put_session(
                "",
                THREAD,
                "m",
                &Place {
                    worktree: String::new(),
                    ..home_place()
                },
                "claude",
                "A",
            )
            .await
            .expect("a row");
        let script = home(Some(store.clone()));

        let (_tab, _claude) = a_claude_turn_in(&script, None).await;

        let command = lock(&script.commands)[0].clone();
        assert!(command.starts_with("cd '/home/u' "), "{command}");
        assert!(command.contains("--resume 'A'"), "{command}");
    }

    /// Decisions 1.4 and 1.8: every home thread shares one transcript
    /// directory, so a new one never resumes the newest transcript there, and
    /// its row has no workspace, branch or worktree.
    #[tokio::test]
    async fn a_new_home_thread_with_no_session_starts_fresh() {
        let (store, _) = crate::store::tests::scratch();
        let script = home(Some(store.clone()));

        let (_tab, _claude) = a_claude_turn_in(&script, None).await;

        let command = lock(&script.commands)[0].clone();
        assert!(!command.contains("--resume"), "{command}");
        assert!(!command.contains("ls -t"), "{command}");
        let row = store
            .get("", THREAD)
            .await
            .expect("a read")
            .expect("the row");
        assert_eq!(
            (
                row.branch.as_str(),
                row.worktree.as_str(),
                row.title.as_deref()
            ),
            ("", "", Some("fix it")),
            "a home row has no branch or worktree"
        );
    }

    /// Decision 1.7: removing a home thread forgets its row.
    #[tokio::test]
    async fn removing_a_home_thread_forgets_its_row() {
        let (store, _) = crate::store::tests::scratch();
        store
            .put_title(
                "",
                THREAD,
                "m",
                &Place {
                    worktree: String::new(),
                    ..home_place()
                },
                "hi",
            )
            .await
            .expect("a row");
        let script = home(Some(store.clone()));

        assert_eq!(forget(script.as_ref(), THREAD).await, Ok(true));

        assert_eq!(*lock(&script.removed), 1, "the keeper and its journals");
        assert_eq!(store.get("", THREAD).await.expect("a read"), None);
        assert_eq!(forget(script.as_ref(), "0000").await, Ok(false));
    }

    #[tokio::test]
    async fn checkpoint_an_acp_turn_sends_completed_then_its_diff() {
        let script = Arc::new(Script::default());
        let (mut tab, mut agent, prompt) = an_opencode_thread(&script).await;
        agent
            .reply(&prompt, json!({"stopReason": "end_turn"}))
            .await;
        assert_eq!(tab.next().await["type"], "turn.completed");
        let diff = tab.next().await;
        assert_eq!(diff["type"], "turn.diff.updated");
        assert_eq!(diff["threadId"], THREAD);
        assert_eq!(diff["payload"]["turn"], 1);
    }

    /// ADR-0035 decision 8 on a live keeper: a tab back after the turn ended
    /// gets that turn's diff once, and none after a revert put its files back.
    #[tokio::test]
    async fn a_tab_back_after_an_acp_turn_ended_gets_its_diff_until_a_revert() {
        let script = Arc::new(Script {
            threads: vec![place()],
            kept: Some((Harness::Opencode, SESSION.to_owned())),
            ..Script::default()
        });
        let (mut tab, mut agent, prompt) = an_opencode_thread(&script).await;
        agent
            .reply(&prompt, json!({"stopReason": "end_turn"}))
            .await;
        let ended = through(&mut tab, "turn.diff.updated").await;
        let cursor = ended
            .iter()
            .rev()
            .find_map(|frame| frame["cursor"].as_str())
            .expect("a cursor")
            .to_owned();
        tab.close();

        let (mut back, _b) = connect_after(Arc::clone(&script), Some(THREAD), Some(&cursor));
        assert_eq!(back.next().await["type"], "thread.started");
        assert_eq!(Some(&back.next().await), ended.last(), "the diff");
        no_queue(&mut back).await;
        assert!(back.quiet().await, "once");
        back.send(json!({"type": "revert", "turn": 0}));
        assert_eq!(back.next().await["type"], "thread.reverted");
        back.close();

        let (mut again, _c) = connect_after(Arc::clone(&script), Some(THREAD), Some(&cursor));
        assert_eq!(again.next().await["type"], "thread.started");
        no_queue(&mut again).await;
        assert!(again.quiet().await, "a reverted turn's diff is not sent");
    }

    #[tokio::test]
    async fn checkpoint_a_capture_that_fails_says_so_in_gits_words() {
        let script = Arc::new(Script {
            capture_fails: true,
            ..Script::default()
        });
        let (mut tab, _claude) = a_claude_turn_that_ends(&script).await;
        assert_eq!(
            tab.next().await,
            json!({"type": "error", "kind": "checkpoint",
                   "said": "git: fatal: unable to write new index file"})
        );
    }

    #[tokio::test]
    async fn checkpoint_a_turn_with_no_baseline_does_not_start() {
        let script = Arc::new(Script {
            base_fails: true,
            ..Script::default()
        });
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test"}));
        assert_eq!(tab.next().await["type"], "thread.started");
        let said = tab.next().await;
        assert_eq!(said["kind"], "checkpoint", "{said}");
        assert!(
            script.turns.lock().expect("a lock").is_empty(),
            "no turn ran"
        );
    }

    #[tokio::test]
    async fn checkpoint_a_socket_closed_mid_turn_keeps_the_tree_when_the_turn_ends() {
        let script = Arc::new(Script::default());
        let (mut tab, served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        tab.close();
        tokio::time::timeout(Duration::from_secs(5), served)
            .await
            .expect("the socket's task ends")
            .expect("it did not panic");
        assert_eq!(*lock(&script.checkpoints), 1, "the turn still runs");
        claude
            .say(json!({"type": "result", "subtype": "success", "is_error": false}))
            .await;
        until_script(&script, |script| *lock(&script.checkpoints) == 2).await;
    }

    #[tokio::test]
    async fn revert_while_a_turn_runs_is_refused_as_busy() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test"}));
        tab.next().await;
        tab.next().await;
        let said = tab.next_after(json!({"type": "revert", "turn": 0})).await;
        assert_eq!(said["kind"], "busy", "{said}");
        assert!(script.reverted.lock().expect("a lock").is_empty());
    }

    #[tokio::test]
    async fn revert_or_a_turn_from_a_second_tab_while_a_turn_runs_is_refused_as_busy() {
        let script = Arc::new(Script {
            threads: vec![place()],
            ..Script::default()
        });
        let (mut first, _a) = connect(Arc::clone(&script), None);
        first.send(json!({"type": "turn", "text": "fix the test"}));
        first.next().await;
        first.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;

        let (mut second, _b) = connect(Arc::clone(&script), Some(THREAD));
        assert_eq!(second.next().await["type"], "thread.started");
        assert_eq!(
            second.next().await["payload"],
            json!({"streamKind": "user_text", "delta": "fix the test", "itemId": "user:1:1"}),
            "the running turn's prompt"
        );
        no_queue(&mut second).await;
        let said = second
            .next_after(json!({"type": "revert", "turn": 0}))
            .await;
        assert_eq!(said["kind"], "busy", "{said}");
        assert_eq!(
            second
                .next_after(json!({"type": "turn", "text": "and the docs"}))
                .await,
            queue(&["and the docs"]),
            "a turn waits for the running one"
        );
        assert!(script.reverted.lock().expect("a lock").is_empty());

        claude
            .say(
                json!({"type": "result", "subtype": "success", "is_error": false,
                        "stop_reason": "end_turn"}),
            )
            .await;
        assert_eq!(first.next().await, queue(&["and the docs"]), "every tab");
        assert_eq!(first.next().await["type"], "turn.completed");
        assert_eq!(first.next().await["type"], "turn.diff.updated");
        through(&mut second, "turn.diff.updated").await;
        claude.heard().await;
        claude
            .say(json!({"type": "result", "subtype": "success", "is_error": false}))
            .await;
        through(&mut second, "turn.diff.updated").await;
        assert_eq!(
            second
                .next_after(json!({"type": "revert", "turn": 0}))
                .await["type"],
            "thread.reverted",
            "the thread is free once the turn's checkpoint is kept"
        );
    }

    #[tokio::test]
    async fn checkpoint_a_failed_turn_keeps_its_own_error() {
        let script = Arc::new(Script {
            capture_fails: true,
            ..Script::default()
        });
        let (mut tab, mut agent, prompt) = an_opencode_thread(&script).await;
        agent
            .say(refusal(&prompt["id"], -32603, "Internal error"))
            .await;
        assert_eq!(tab.next().await["type"], "turn.completed");
        assert_eq!(tab.next().await["kind"], "unreachable");
        assert_eq!(
            tab.next_after(json!({"type": "revert", "turn": 0})).await["type"],
            "thread.reverted",
            "no checkpoint error followed the turn's own"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn checkpoint_a_capture_that_never_answers_is_a_checkpoint_failure() {
        let script = Arc::new(Script {
            capture_hangs: true,
            ..Script::default()
        });
        let (mut tab, _claude) = a_claude_turn_that_ends(&script).await;
        // No 5 s bound here: the paused clock would fire it before the 60 s one.
        let said = tab.heard.recv().await.expect("the socket is open");
        assert_eq!(
            serde_json::from_str::<Value>(&said).expect("JSON"),
            json!({"type": "error", "kind": "checkpoint",
                   "said": "git did not answer within 60 seconds"})
        );
    }

    #[tokio::test]
    async fn revert_with_no_thread_is_a_bad_frame() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        let said = tab.next_after(json!({"type": "revert", "turn": 0})).await;
        assert_eq!(said["kind"], "badFrame", "{said}");
        assert!(script.reverted.lock().expect("a lock").is_empty());
    }

    #[tokio::test]
    async fn revert_that_succeeds_sends_thread_reverted() {
        let script = Arc::new(Script {
            threads: vec![place()],
            ..Script::default()
        });
        let (mut tab, _served) = connect(Arc::clone(&script), Some(THREAD));
        assert_eq!(tab.next().await["type"], "thread.started");
        no_queue(&mut tab).await;
        assert_eq!(
            tab.next_after(json!({"type": "revert", "turn": 2})).await,
            json!({"threadId": THREAD, "type": "thread.reverted", "payload": {"turn": 2}})
        );
        assert_eq!(*script.reverted.lock().expect("a lock"), [2]);
    }

    #[tokio::test]
    async fn revert_that_fails_is_a_checkpoint_failure() {
        let script = Arc::new(Script {
            threads: vec![place()],
            revert_fails: true,
            ..Script::default()
        });
        let (mut tab, _served) = connect(Arc::clone(&script), Some(THREAD));
        tab.next().await;
        no_queue(&mut tab).await;
        assert_eq!(
            tab.next_after(json!({"type": "revert", "turn": 4})).await,
            json!({"type": "error", "kind": "checkpoint",
                   "said": "the thread has no checkpoint 4"})
        );
    }

    #[tokio::test]
    async fn branch_diff_with_no_thread_is_a_bad_frame() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        let said = tab.next_after(json!({"type": "diff"})).await;
        assert_eq!(said["kind"], "badFrame", "{said}");
    }

    #[tokio::test]
    async fn branch_diff_of_a_thread_is_one_reply() {
        let script = Arc::new(Script {
            threads: vec![place()],
            ..Script::default()
        });
        let (mut tab, _served) = connect(Arc::clone(&script), Some(THREAD));
        assert_eq!(tab.next().await["type"], "thread.started");
        no_queue(&mut tab).await;
        assert_eq!(
            tab.next_after(json!({"type": "diff"})).await,
            json!({"type": "branchDiff", "threadId": THREAD, "base": "0123abcd",
                   "files": [{"path": "new.txt", "from": "old.txt", "added": 2, "deleted": 0},
                             {"path": "blob.bin"}],
                   "filesTruncated": false,
                   "unifiedDiff": "diff --git a/old.txt b/new.txt\n", "truncated": false})
        );
    }

    #[tokio::test]
    async fn branch_diff_that_fails_is_a_diff_failure_in_gits_words() {
        let script = Arc::new(Script {
            threads: vec![place()],
            branch_fails: true,
            ..Script::default()
        });
        let (mut tab, _served) = connect(Arc::clone(&script), Some(THREAD));
        tab.next().await;
        no_queue(&mut tab).await;
        assert_eq!(
            tab.next_after(json!({"type": "diff"})).await,
            json!({"type": "error", "kind": "diff",
                   "said": "git: fatal: the branch has no merge-base with HEAD"})
        );
    }

    #[tokio::test]
    async fn branch_diff_while_a_revert_runs_is_busy() {
        let script = Arc::new(Script {
            threads: vec![place()],
            ..Script::default()
        });
        let (mut tab, _served) = connect(Arc::clone(&script), Some(THREAD));
        tab.next().await;
        no_queue(&mut tab).await;
        script.registry.lock().reverting.insert(place().id);
        let said = tab.next_after(json!({"type": "diff"})).await;
        assert_eq!(said["kind"], "busy", "{said}");
        script.registry.lock().reverting.remove(&place().id);
        let said = tab.next_after(json!({"type": "diff"})).await;
        assert_eq!(said["type"], "branchDiff", "{said}");
    }

    /// A slow git holds neither the turn's events nor a cancel.
    #[tokio::test]
    async fn a_slow_branch_diff_runs_beside_the_turn() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let script = Arc::new(Script {
            branch_gate: Some(Arc::clone(&gate)),
            ..Script::default()
        });
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        tab.send(json!({"type": "diff"}));
        claude
            .say(
                json!({"type": "control_request", "request_id": "r1", "request": {
                "subtype": "can_use_tool", "tool_name": "Bash",
                "input": {"command": "touch a"}, "tool_use_id": "t1"}}),
            )
            .await;
        assert_eq!(tab.next().await["type"], "request.opened");
        tab.send(json!({"type": "cancel"}));
        // The cancel first refuses the waiting request, then interrupts.
        tokio::time::timeout(Duration::from_secs(5), async {
            while claude.heard().await.expect("a line")["request"]["subtype"] != "interrupt" {}
        })
        .await
        .expect("the cancel is read while the diff runs");
        gate.notify_one();
        let mut said = tab.next().await;
        while said["type"] != "branchDiff" {
            said = tab.next().await;
        }
    }

    #[tokio::test]
    async fn branch_diff_while_a_turn_runs_is_answered() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        let said = tab.next_after(json!({"type": "diff"})).await;
        assert_eq!(said["type"], "branchDiff", "{said}");
    }

    /// The first turn of a Claude thread in `mode`, up to Claude's prompt.
    async fn a_claude_turn_in(script: &Arc<Script>, mode: Option<&str>) -> (Tab, Claude) {
        let mut turn = json!({"type": "turn", "text": "fix it"});
        if let Some(mode) = mode {
            turn["mode"] = json!(mode);
        }
        a_claude_turn(script, turn).await
    }

    /// The first turn of a Claude thread, sent as `turn`, up to Claude's prompt.
    async fn a_claude_turn(script: &Arc<Script>, turn: Value) -> (Tab, Claude) {
        let (mut tab, _served) = connect(Arc::clone(script), None);
        tab.send(turn);
        assert_eq!(tab.next().await["type"], "thread.started");
        assert_eq!(tab.next().await["payload"]["itemId"], "user:1:1");
        let mut claude = script.claude().await;
        claude.heard().await.expect("the prompt");
        (tab, claude)
    }

    fn can_use(request: &str, tool: &str, input: Value) -> Value {
        json!({"type": "control_request", "request_id": request, "request": {
               "subtype": "can_use_tool", "tool_name": tool, "input": input,
               "tool_use_id": format!("t-{request}")}})
    }

    fn an_edit(request: &str) -> Value {
        can_use(
            request,
            "Edit",
            json!({"file_path": "a.txt", "old_string": "one", "new_string": "two"}),
        )
    }

    fn a_command(request: &str) -> Value {
        can_use(request, "Bash", json!({"command": "cargo test"}))
    }

    /// Y-453: the default asks about every request the harness sends.
    #[tokio::test]
    async fn supervised_mode_relays_every_request_as_a_card() {
        let script = Arc::new(Script::default());
        let (mut tab, mut claude) = a_claude_turn_in(&script, None).await;
        assert_eq!(
            *script.modes.lock().expect("a lock"),
            [PermissionMode::Supervised]
        );
        claude.say(an_edit("r1")).await;
        let edit = tab.next().await;
        assert_eq!(edit["type"], "request.opened", "{edit}");
        assert_eq!(edit["payload"]["requestType"], "file_change_approval");
        claude.say(a_command("r2")).await;
        let command = tab.next().await;
        assert_eq!(command["type"], "request.opened", "{command}");
        assert_eq!(command["payload"]["requestType"], "exec_command_approval");
    }

    /// Claude's own acceptEdits accepts an edit inside the worktree, so an edit
    /// that reaches the daemon is outside it and still opens a card.
    #[tokio::test]
    async fn auto_accept_edits_mode_relays_an_edit_claude_still_asks_about() {
        let script = Arc::new(Script::default());
        let (mut tab, mut claude) = a_claude_turn_in(&script, Some("auto-accept-edits")).await;
        assert_eq!(
            *script.modes.lock().expect("a lock"),
            [PermissionMode::AutoAcceptEdits]
        );
        claude
            .say(can_use(
                "r1",
                "Edit",
                json!({"file_path": "/home/u/.bashrc", "old_string": "a", "new_string": "b"}),
            ))
            .await;
        let edit = tab.next().await;
        assert_eq!(edit["type"], "request.opened", "{edit}");
        assert_eq!(edit["payload"]["requestType"], "file_change_approval");

        claude.say(a_command("r2")).await;
        let command = tab.next().await;
        assert_eq!(command["type"], "request.opened", "{command}");
        assert_eq!(command["payload"]["requestId"], "r2");
    }

    #[tokio::test]
    async fn full_access_mode_answers_every_request_without_a_card() {
        let script = Arc::new(Script::default());
        let (mut tab, mut claude) = a_claude_turn_in(&script, Some("full-access")).await;
        for (request, line) in [("r1", an_edit("r1")), ("r2", a_command("r2"))] {
            claude.say(line).await;
            let answer = claude.heard().await.expect("the daemon's answer");
            assert_eq!(answer["response"]["request_id"], request);
            assert_eq!(answer["response"]["response"]["behavior"], "allow");
            let resolved = tab.next().await;
            assert_eq!(resolved["type"], "request.resolved", "no card: {resolved}");
            assert_eq!(resolved["payload"]["requestId"], request);
        }
        assert_eq!(
            *script.modes.lock().expect("a lock"),
            [PermissionMode::FullAccess],
            "Claude itself still runs in its own default mode"
        );
    }

    /// Y-565: a plan turn runs in Claude's plan mode.
    #[tokio::test]
    async fn plan_a_turn_runs_claude_in_plan_mode() {
        let script = Arc::new(Script::default());
        a_claude_turn(
            &script,
            json!({"type": "turn", "text": "fix it", "interaction": "plan"}),
        )
        .await;
        let commands = lock(&script.commands);
        assert_eq!(commands.len(), 1);
        assert!(
            commands[0].contains("--permission-mode plan -p"),
            "{}",
            commands[0]
        );
    }

    /// Y-565: Full access does not hold in a plan turn. A command is relayed,
    /// and the keeper keeps `supervised` for a daemon that adopts the turn.
    #[tokio::test]
    async fn plan_in_full_access_relays_a_command_and_keeps_supervised() {
        let script = Arc::new(Script::default());
        let (mut tab, mut claude) = a_claude_turn(
            &script,
            json!({"type": "turn", "text": "fix it", "mode": "full-access",
                   "interaction": "plan"}),
        )
        .await;
        assert_eq!(*lock(&script.modes), [PermissionMode::Supervised]);
        let kept = lock(&script.keep)
            .as_ref()
            .map(|keep| lock(&keep.journal).mode);
        assert_eq!(kept, Some(Some(PermissionMode::Supervised)));

        claude.say(a_command("r1")).await;
        let asked = tab.next().await;
        assert_eq!(asked["type"], "request.opened", "{asked}");
        assert_eq!(asked["payload"]["requestId"], "r1");
    }

    /// Y-565: only Claude has a plan mode, so a plan turn for another harness
    /// is refused, and no thread opens for it.
    #[tokio::test]
    async fn plan_a_turn_for_an_acp_harness_is_a_bad_frame() {
        let script = Arc::new(Script::default());
        let (mut tab, _agent, _prompt) = an_opencode_thread(&script).await;
        let said = tab
            .next_after(json!({"type": "turn", "text": "plan it", "interaction": "plan"}))
            .await;
        assert_eq!(
            said,
            json!({"type": "error", "kind": "badFrame",
                   "said": "plan mode needs the Claude harness"})
        );

        let (mut fresh, _served) = connect(Arc::clone(&script), None);
        let said = fresh
            .next_after(
                json!({"type": "turn", "text": "plan it", "harness": "codex",
                               "interaction": "plan"}),
            )
            .await;
        assert_eq!(said["kind"], "badFrame", "{said}");
        assert_eq!(*lock(&script.opened), 1, "only the opencode thread opened");
    }

    #[tokio::test]
    async fn auto_mode_starts_claude_in_auto_and_relays_what_it_asks() {
        let script = Arc::new(Script::default());
        let (mut tab, mut claude) = a_claude_turn_in(&script, Some("auto")).await;
        assert_eq!(
            *script.modes.lock().expect("a lock"),
            [PermissionMode::Auto]
        );
        claude.say(a_command("r1")).await;
        let asked = tab.next().await;
        assert_eq!(asked["type"], "request.opened", "{asked}");
        assert_eq!(asked["payload"]["requestId"], "r1");
    }

    /// An ACP harness has no review of its own, so Auto asks, as T3 Code does.
    #[tokio::test]
    async fn auto_mode_on_an_acp_thread_asks() {
        let script = Arc::new(Script::default());
        let (mut tab, mut agent, _prompt) = an_opencode_thread_in(&script, "auto").await;
        agent.say(asked(7)).await;
        let opened = tab.next().await;
        assert_eq!(opened["type"], "request.opened", "{opened}");
        assert_eq!(opened["threadId"], THREAD);
    }

    #[tokio::test]
    async fn full_access_mode_on_an_acp_thread_picks_the_agents_allow_once() {
        let script = Arc::new(Script::default());
        let (mut tab, mut agent, _prompt) = an_opencode_thread_in(&script, "full-access").await;
        agent.say(asked(7)).await;
        assert_eq!(
            agent.heard().await,
            json!({"jsonrpc": "2.0", "id": 7,
                   "result": {"outcome": {"outcome": "selected", "optionId": "once"}}})
        );
        let resolved = tab.next().await;
        assert_eq!(resolved["type"], "request.resolved", "no card: {resolved}");
        assert_eq!(resolved["payload"]["decision"], "accept");
    }

    fn asked_to(id: u64, kind: &str, path: &str) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": "session/request_permission",
               "params": {"sessionId": SESSION,
                   "toolCall": {"toolCallId": "call_1", "title": path, "kind": kind,
                       "locations": [{"path": path}]},
                   "options": [
                       {"optionId": "once", "name": "Allow once", "kind": "allow_once"},
                       {"optionId": "reject", "name": "Reject", "kind": "reject_once"}]}})
    }

    #[tokio::test]
    async fn auto_accept_edits_on_an_acp_thread_accepts_an_edit_inside_the_worktree() {
        let script = Arc::new(Script::default());
        let (mut tab, mut agent, _prompt) =
            an_opencode_thread_in(&script, "auto-accept-edits").await;
        agent
            .say(asked_to(7, "edit", &format!("{WORKTREE}/src/./a.txt")))
            .await;
        assert_eq!(
            agent.heard().await,
            json!({"jsonrpc": "2.0", "id": 7,
                   "result": {"outcome": {"outcome": "selected", "optionId": "once"}}})
        );
        let resolved = tab.next().await;
        assert_eq!(resolved["type"], "request.resolved", "no card: {resolved}");
    }

    /// Y-453: only an edit inside the worktree is the person's to skip.
    #[tokio::test]
    async fn auto_accept_edits_on_an_acp_thread_asks_about_the_rest() {
        let script = Arc::new(Script::default());
        let (mut tab, mut agent, _prompt) =
            an_opencode_thread_in(&script, "auto-accept-edits").await;
        let inside = format!("{WORKTREE}/a.txt");
        let escape = format!("{WORKTREE}/../1a2b3c4e/a.txt");
        for (id, kind, path) in [
            (1, "delete", inside.as_str()),
            (2, "move", inside.as_str()),
            (3, "edit", escape.as_str()),
            (4, "edit", "/home/u/.bashrc"),
            (5, "edit", "a.txt"),
            (6, "execute", inside.as_str()),
        ] {
            agent.say(asked_to(id, kind, path)).await;
            let opened = tab.next().await;
            assert_eq!(opened["type"], "request.opened", "{kind} {path}: {opened}");
        }
    }

    /// A question to the person is not a permission, so Full access asks it.
    #[tokio::test]
    async fn full_access_mode_relays_a_question_to_the_person() {
        let script = Arc::new(Script::default());
        let (mut tab, mut claude) = a_claude_turn_in(&script, Some("full-access")).await;
        claude
            .say(can_use("r1", "AskUserQuestion", json!({"questions": []})))
            .await;
        let asked = tab.next().await;
        assert_eq!(asked["type"], "request.opened", "{asked}");
        assert_eq!(asked["payload"]["requestId"], "r1");
    }

    /// Y-654: the browser answers a question with the labels it chose.
    #[tokio::test]
    async fn an_answer_with_answers_reaches_claude_and_an_empty_one_is_a_bad_frame() {
        let script = Arc::new(Script::default());
        let (mut tab, mut claude) = a_claude_turn_in(&script, None).await;
        let questions = json!({"questions": [{"question": "Which?", "header": "Pick",
            "multiSelect": true, "options": [{"label": "A", "description": "a"}]}]});
        claude
            .say(can_use("r1", "AskUserQuestion", questions.clone()))
            .await;
        let asked = tab.next().await;
        assert_eq!(asked["payload"]["questions"][0]["question"], "Which?");

        let refused = tab
            .next_after(json!({"type": "answer", "requestId": "r1", "decision": "accept"}))
            .await;
        assert_eq!(refused["kind"], "badFrame", "{refused}");

        tab.send(
            json!({"type": "answer", "requestId": "r1", "decision": "accept",
                        "answers": {"Which?": ["A", "B"]}}),
        );
        let sent = claude.heard().await.expect("the answer");
        assert_eq!(sent["response"]["response"]["behavior"], "allow");
        assert_eq!(
            sent["response"]["response"]["updatedInput"]["answers"],
            json!({"Which?": "A, B"})
        );
        assert_eq!(
            sent["response"]["response"]["updatedInput"]["questions"],
            questions["questions"]
        );
    }

    const ACCEPT: &str =
        include_str!("../../yantra-core/tests/recordings/claude-2.1.291-accept.jsonl");

    /// The recording's lines, split at its one `control_request`.
    fn recorded() -> (Vec<Value>, Vec<Value>) {
        let lines: Vec<Value> = ACCEPT
            .lines()
            .map(|line| serde_json::from_str(line).expect("a JSON line"))
            .collect();
        let at = lines
            .iter()
            .position(|line| line["type"] == "control_request")
            .expect("the recording asks once");
        let (head, tail) = lines.split_at(at + 1);
        (head.to_vec(), tail.to_vec())
    }

    /// Every frame a tab gets up to and including the first `stop` type.
    async fn through(tab: &mut Tab, stop: &str) -> Vec<Value> {
        let mut frames = Vec::new();
        loop {
            let frame = tab.next().await;
            let done = frame["type"] == stop;
            frames.push(frame);
            if done {
                return frames;
            }
        }
    }

    /// ADR-0035 decision 8: a tab that reconnects with the last cursor it drew
    /// gets each later event once, and then the live ones.
    #[tokio::test]
    async fn a_tab_that_reconnects_after_a_cursor_gets_each_later_event_once() {
        let script = Arc::new(Script {
            threads: vec![place()],
            ..Script::default()
        });
        let (mut first, _a) = connect(Arc::clone(&script), None);
        first.send(json!({"type": "turn", "text": "Run touch made.txt"}));
        assert_eq!(first.next().await["type"], "thread.started");
        assert_eq!(first.next().await["payload"]["itemId"], "user:1:1");
        let mut claude = script.claude().await;
        claude.heard().await;
        let (head, tail) = recorded();
        for line in head {
            claude.say(line).await;
        }
        let drawn = through(&mut first, "request.opened").await;
        let at = drawn
            .iter()
            .position(|frame| frame.get("cursor").is_some())
            .expect("a cursored event");
        let cursor = drawn[at]["cursor"].as_str().expect("a cursor").to_owned();
        assert!(cursor.starts_with("1:"), "{cursor}");

        let (mut second, _b) = connect_after(Arc::clone(&script), Some(THREAD), Some(&cursor));
        let started = second.next().await;
        assert_eq!(started["type"], "thread.started");
        assert_eq!(started["cursor"], cursor.as_str(), "what follows continues");
        let mut replayed = Vec::new();
        for _ in at + 1..drawn.len() {
            replayed.push(second.next().await);
        }
        assert_eq!(replayed, drawn[at + 1..], "each later event once");
        no_queue(&mut second).await;
        assert!(second.quiet().await, "and nothing twice");

        let request = drawn[drawn.len() - 1]["payload"]["requestId"].clone();
        second.send(json!({"type": "answer", "requestId": request, "decision": "accept"}));
        assert!(claude.heard().await.is_some(), "the answer");
        for line in tail {
            claude.say(line).await;
        }
        let live = through(&mut second, "turn.completed").await;
        assert_eq!(live, through(&mut first, "turn.completed").await);
        assert_eq!(live[0]["type"], "request.resolved");
    }

    /// A tab with no cursor of this run gets the whole run, after the
    /// transcript before its prompt.
    #[tokio::test]
    async fn a_tab_with_a_cursor_of_another_run_gets_the_whole_run() {
        let script = Arc::new(Script {
            threads: vec![place()],
            ..Script::default()
        });
        let (mut first, _a) = connect(Arc::clone(&script), None);
        first.send(json!({"type": "turn", "text": "Run touch made.txt"}));
        first.next().await;
        let prompt = first.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        for line in recorded().0 {
            claude.say(line).await;
        }
        let drawn = through(&mut first, "request.opened").await;

        let (mut second, _b) = connect_after(Arc::clone(&script), Some(THREAD), Some("0:9:0"));
        assert_eq!(
            second.next().await.get("cursor"),
            None,
            "a whole replay follows"
        );
        assert_eq!(second.next().await, prompt);
        for frame in &drawn {
            assert_eq!(&second.next().await, frame);
        }
        no_queue(&mut second).await;
        assert!(second.quiet().await);
    }

    /// A turn that ended while the tab was away: its journals stay, so the
    /// tab gets the end and the turn's diff, and not the transcript again.
    #[tokio::test]
    async fn a_tab_back_after_its_turn_ended_gets_the_end() {
        let script = Arc::new(Script {
            threads: vec![place()],
            history: vec![logs::Entry {
                who: Who::User,
                at: None,
                text: "Run touch made.txt".to_owned(),
                tools: vec![],
            }],
            ..Script::default()
        });
        let (mut first, _a) = connect(Arc::clone(&script), None);
        first.send(json!({"type": "turn", "text": "Run touch made.txt"}));
        first.next().await;
        first.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        let (head, tail) = recorded();
        for line in head {
            claude.say(line).await;
        }
        let drawn = through(&mut first, "request.opened").await;
        let cursor = drawn[drawn.len() - 1]["cursor"]
            .as_str()
            .expect("a cursor")
            .to_owned();
        first.close();
        let request = drawn[drawn.len() - 1]["payload"]["requestId"].clone();
        let (mut answering, _b) = connect_after(Arc::clone(&script), Some(THREAD), Some(&cursor));
        answering.next().await;
        answering.send(json!({"type": "answer", "requestId": request, "decision": "accept"}));
        claude.heard().await;
        for line in tail {
            claude.say(line).await;
        }
        let ended = through(&mut answering, "turn.diff.updated").await;
        // The keeper ends, so the tab back reads the journals.
        drop(claude);
        until_script(&script, |script| {
            script.registry.live(&place().id).is_none()
        })
        .await;

        let (mut back, _c) = connect_after(Arc::clone(&script), Some(THREAD), Some(&cursor));
        assert_eq!(back.next().await["cursor"], cursor.as_str());
        let cursored = |frames: &[Value]| -> Vec<Value> {
            frames
                .iter()
                .filter(|frame| frame.get("cursor").is_some())
                .cloned()
                .collect()
        };
        let caught = through(&mut back, "turn.diff.updated").await;
        assert_eq!(cursored(&caught), cursored(&ended), "the end, once");
        assert_eq!(
            caught.last(),
            ended.last(),
            "and the turn's diff (ADR-0035 decision 8)"
        );
        no_queue(&mut back).await;
        assert!(back.quiet().await, "and no transcript");
    }

    /// A connect that times out lets the thread go and kills the keeper it
    /// started, so a refresh pass may adopt and a later turn may start.
    #[tokio::test(start_paused = true)]
    async fn a_connect_that_times_out_releases_the_thread_and_kills_its_keeper() {
        let script = Arc::new(Script {
            threads: vec![place()],
            kept: Some((Harness::Opencode, SESSION.to_owned())),
            ..Script::default()
        });
        let (mut tab, served) = connect(Arc::clone(&script), Some(THREAD));
        assert_eq!(tab.next().await["type"], "thread.started");
        let mut agent = script.agent().await;
        assert_eq!(agent.heard().await["method"], "initialize");
        tokio::time::advance(CONNECT_WITHIN + Duration::from_secs(1)).await;
        assert_eq!(tab.next().await["kind"], "unreachable");
        served.await.expect("the socket ends");
        assert!(
            !script.registry.holds(&format!("yantra-keep-web-{THREAD}")),
            "the thread is not claimed"
        );
        assert_eq!(
            *lock(&script.finished),
            [Duration::ZERO],
            "the keeper is killed"
        );
        assert!(!script.journal().alive);

        let (mut again, _served) = connect(Arc::clone(&script), Some(THREAD));
        assert_eq!(again.next().await["type"], "thread.started");
        assert_eq!(script.agent().await.heard().await["method"], "initialize");
    }

    /// A tab that attaches while a turn's keeper is starting waits for that
    /// start, and reads the turn from its task. It never reads the keeper
    /// back as a second reader and writer.
    #[tokio::test]
    async fn a_tab_that_attaches_during_a_start_does_not_adopt_the_keeper() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let script = Arc::new(Script {
            threads: vec![place()],
            start_gate: Some(Arc::clone(&gate)),
            ..Script::default()
        });
        let (mut first, _a) = connect(Arc::clone(&script), None);
        first.send(json!({"type": "turn", "text": "Run touch made.txt"}));
        assert_eq!(first.next().await["type"], "thread.started");
        until_script(&script, |script| lock(&script.modes).len() == 1).await;

        let (mut second, _b) = connect(Arc::clone(&script), Some(THREAD));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            *lock(&script.adopted),
            0,
            "the starting keeper is not adopted"
        );
        gate.notify_one();
        assert_eq!(first.next().await["payload"]["itemId"], "user:1:1");
        assert_eq!(second.next().await["type"], "thread.started");
        assert_eq!(
            second.next().await["payload"]["delta"],
            "Run touch made.txt"
        );
        no_queue(&mut second).await;

        let mut claude = script.claude().await;
        claude.heard().await;
        let (head, _) = recorded();
        for line in head {
            claude.say(line).await;
        }
        let drawn = through(&mut first, "request.opened").await;
        assert_eq!(through(&mut second, "request.opened").await, drawn);
        assert_eq!(*lock(&script.adopted), 0);
        assert!(lock(&script.turns).is_empty(), "one reader for the keeper");
    }

    /// A turn whose `out` ends with no `result` gets its end from the daemon.
    /// A tab that comes back with a cursor after it still gets that end.
    #[tokio::test]
    async fn a_tab_back_after_a_turn_ended_with_no_result_gets_the_failed_end() {
        for finishing in [false, true] {
            let script = Arc::new(Script {
                threads: vec![place()],
                capture_hangs: finishing,
                ..Script::default()
            });
            let (mut first, _a) = connect(Arc::clone(&script), None);
            first.send(json!({"type": "turn", "text": "Run touch made.txt"}));
            first.next().await;
            first.next().await;
            let mut claude = script.claude().await;
            claude.heard().await;
            let (head, _) = recorded();
            for line in head {
                claude.say(line).await;
            }
            let drawn = through(&mut first, "request.opened").await;
            let cursor = drawn[drawn.len() - 1]["cursor"]
                .as_str()
                .expect("a cursor")
                .to_owned();
            first.close();
            drop(claude);
            if finishing {
                // The keeper's task waits on the checkpoint, so its turn is
                // over and the thread is still held.
                tokio::time::sleep(Duration::from_millis(300)).await;
                assert!(script.registry.live(&place().id).is_some());
            } else {
                until_script(&script, |script| {
                    script.registry.live(&place().id).is_none()
                })
                .await;
            }

            let (mut back, _b) = connect_after(Arc::clone(&script), Some(THREAD), Some(&cursor));
            assert_eq!(back.next().await["cursor"], cursor.as_str());
            let ended = through(&mut back, "turn.completed").await;
            let end = &ended[ended.len() - 1];
            assert_eq!(end["payload"]["state"], "failed", "{end}");
            assert_eq!(end["payload"]["message"], "claude ended without a result");
        }
    }

    /// I-1 through the keeper: the session the thread names already exists,
    /// so a turn runs there, and this one is refused without starting.
    #[tokio::test]
    async fn a_turn_whose_keeper_already_runs_is_busy() {
        let script = Arc::new(
            Script::default().keeping(Journal {
                run: "7".to_owned(),
                input: format!(
                    "{}\n",
                    json!({"type": "user", "message": {"role": "user",
                "content": [{"type": "text", "text": "elsewhere"}]}})
                )
                .into_bytes(),
                ..Journal::default()
            }),
        );
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test"}));
        assert_eq!(tab.next().await["type"], "thread.started");
        let said = tab.next().await;
        assert_eq!(said["kind"], "busy", "{said}");
        assert!(lock(&script.modes).is_empty(), "no turn started");
        assert!(
            script.registry.live(&place().id).is_some(),
            "the keeper is read back"
        );
    }

    fn prompted(text: &str) -> String {
        format!(
            "{}\n",
            json!({"type": "user", "message": {"role": "user",
                   "content": [{"type": "text", "text": text}]}})
        )
    }

    fn allowed_in(request: &str) -> String {
        format!(
            "{}\n",
            json!({"type": "control_response", "response": {"subtype": "success",
                   "request_id": request, "response": {"behavior": "allow",
                   "updatedInput": {"command": "cargo test"}}}})
        )
    }

    fn lines(values: &[Value]) -> Vec<u8> {
        values
            .iter()
            .map(|value| format!("{value}\n"))
            .collect::<String>()
            .into_bytes()
    }

    /// ADR-0035 decision 9: an adopted turn answers what its mode answers,
    /// and never a request `in` already answered.
    #[tokio::test]
    async fn an_adopted_turn_answers_only_what_in_has_not() {
        let script = Arc::new(
            Script {
                threads: vec![place()],
                ..Script::default()
            }
            .keeping(Journal {
                run: "7".to_owned(),
                mode: Some(PermissionMode::FullAccess),
                input: [prompted("fix it"), allowed_in("r1")].concat().into_bytes(),
                out: lines(&[
                    json!({"type": "system", "subtype": "init"}),
                    a_command("r1"),
                    a_command("r2"),
                ]),
                ..Journal::default()
            }),
        );
        let (mut tab, _served) = connect(Arc::clone(&script), Some(THREAD));
        assert_eq!(tab.next().await["type"], "thread.started");
        let mut claude = script.claude().await;
        let answer = claude.heard().await.expect("one answer");
        assert_eq!(answer["response"]["request_id"], "r2");
        claude
            .say(json!({"type": "result", "subtype": "success", "is_error": false}))
            .await;
        assert!(
            tokio::time::timeout(Duration::from_millis(300), claude.heard())
                .await
                .is_err(),
            "and no other"
        );
        let answered = String::from_utf8_lossy(&script.journal().input)
            .matches("\"r1\"")
            .count();
        assert_eq!(answered, 1, "r1 was answered once, before the restart");
    }

    /// Y-451 and ADR-0035 decision 10: a request no tab is attached to see
    /// sends one notification naming the workspace and the thread.
    #[tokio::test]
    async fn a_wait_nobody_sees_is_notified_after_a_restart_and_live() {
        let (waits, mut heard) = mpsc::unbounded_channel();
        let script = Arc::new(
            Script {
                threads: vec![place()],
                registry: Registry::telling(waits),
                ..Script::default()
            }
            .keeping(Journal {
                run: "7".to_owned(),
                input: prompted("fix it").into_bytes(),
                out: lines(&[
                    json!({"type": "system", "subtype": "init"}),
                    a_command("r1"),
                ]),
                ..Journal::default()
            }),
        );
        adopt_place(&script, "web", place())
            .await
            .expect("the keeper is read back");
        let wait = Wait::new("web", THREAD, Phase::WaitingForApproval);
        assert_eq!(heard.recv().await, Some(wait.clone()));
        let told = titled_wait(&wait, "web", "Fix the flaky test").await;
        let message = told.message(Some(BASE));
        assert_eq!(message.body, "web: Fix the flaky test waits for an answer");
        assert_eq!(
            message.click.as_deref(),
            Some("https://box.tail.ts.net:8443/w/web?thread=1a2b3c4d")
        );

        let mut claude = script.claude().await;
        claude.say(a_command("r2")).await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), heard.recv()).await,
            Ok(Some(wait))
        );
        let (mut tab, _served) = connect(Arc::clone(&script), Some(THREAD));
        tab.next().await;
        claude.say(a_command("r3")).await;
        while tab.next().await["payload"]["requestId"] != "r3" {}
        assert!(
            heard.try_recv().is_err(),
            "a tab sees it, so nothing is sent"
        );
    }

    /// Only `cancel` stops a turn: it interrupts and leaves stdin open, and a
    /// turn that does not end within 10 s has its keeper killed.
    #[tokio::test(start_paused = true)]
    async fn a_cancelled_turn_that_does_not_end_is_killed_after_the_grace() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        tab.send(json!({"type": "cancel"}));
        assert_eq!(
            claude.heard().await.expect("an interrupt")["request"]["subtype"],
            "interrupt"
        );
        tokio::time::sleep(STOP_GRACE + Duration::from_secs(1)).await;
        let ended = tab.next().await;
        assert_eq!(ended["payload"]["state"], "cancelled", "{ended}");
        assert_eq!(*lock(&script.finished), [Duration::ZERO, STOP_GRACE]);
    }

    const WAKE: &str =
        include_str!("../../yantra-core/tests/recordings/claude-2.1.319-background-wake.jsonl");

    /// The wake recording's lines `from..to`: 0..7 is the turn that starts the
    /// task, 7..10 its end, and 10..13 the wake turn.
    fn woken(from: usize, to: usize) -> Vec<Value> {
        WAKE.lines()
            .skip(from)
            .take(to - from)
            .map(|line| serde_json::from_str(line).expect("a JSON line"))
            .collect()
    }

    /// A thread whose first turn left a background task running.
    async fn a_turn_that_leaves_a_task(script: &Arc<Script>) -> (Tab, Claude, Vec<Value>) {
        let (mut tab, _served) = connect(Arc::clone(script), None);
        tab.send(json!({"type": "turn", "text": "sleep in the background"}));
        assert_eq!(tab.next().await["type"], "thread.started");
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        for line in woken(0, 7) {
            claude.say(line).await;
        }
        let frames = through(&mut tab, "turn.diff.updated").await;
        (tab, claude, frames)
    }

    fn rosters(frames: &[Value]) -> Vec<usize> {
        frames
            .iter()
            .filter(|frame| frame["type"] == "thread.background.updated")
            .map(|frame| frame["payload"]["tasks"].as_array().map_or(0, Vec::len))
            .collect()
    }

    /// ADR-0041 decisions 1 to 3: the keeper outlives its turn, and the turn
    /// Claude starts when the task ends is turn 2, with its checkpoint and diff.
    #[tokio::test]
    async fn a_background_task_keeps_the_keeper_and_its_wake_is_the_next_turn() {
        let script = Arc::new(Script::default());
        let (mut tab, mut claude, first) = a_turn_that_leaves_a_task(&script).await;
        assert_eq!(rosters(&first), [1], "{first:?}");
        let task = first
            .iter()
            .find(|frame| frame["type"] == "thread.background.updated")
            .map(|frame| frame["payload"]["tasks"][0].clone());
        assert_eq!(
            task,
            Some(json!({"taskId": "b561loltj", "kind": "local_bash",
                        "description": "Background sleep then echo completion marker"}))
        );
        assert_eq!(first[first.len() - 1]["payload"]["turn"], 1);
        assert!(
            script.registry.live(&place().id).is_some(),
            "the keeper stays"
        );
        assert!(lock(&script.finished).is_empty());

        for line in woken(7, 13) {
            claude.say(line).await;
        }
        let wake = through(&mut tab, "turn.diff.updated").await;
        let kinds: Vec<&str> = wake
            .iter()
            .filter_map(|frame| frame["type"].as_str())
            .collect();
        assert!(kinds.contains(&"turn.started"), "{kinds:?}");
        assert!(kinds.contains(&"turn.completed"), "{kinds:?}");
        assert_eq!(rosters(&wake), [0]);
        assert_eq!(wake[wake.len() - 1]["payload"]["turn"], 2);
        assert_eq!(*lock(&script.checkpoints), 3, "0, 1 and the wake's 2");
        assert!(
            tokio::time::timeout(Duration::from_millis(300), claude.heard())
                .await
                .is_err(),
            "no prompt is written for a wake"
        );
    }

    /// ADR-0041 decision 3 and Q5: a turn end nobody sees sends one
    /// notification that names only the workspace and the thread.
    #[tokio::test]
    async fn a_turn_end_nobody_sees_is_notified_once() {
        let (waits, mut heard) = mpsc::unbounded_channel();
        let script = Arc::new(Script {
            registry: Registry::telling(waits),
            ..Script::default()
        });
        let (mut tab, served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        tab.close();
        served.await.expect("the socket's task ends");
        claude.say(ended()).await;
        let wait = Wait::new("web", THREAD, Phase::Completed);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), heard.recv()).await,
            Ok(Some(wait.clone()))
        );
        let told = titled_wait(&wait, "web", "Fix the flaky test").await;
        let message = told.message(Some(BASE));
        assert_eq!(message.body, "web: Fix the flaky test finished a turn");
        assert_eq!(
            message.click.as_deref(),
            Some("https://box.tail.ts.net:8443/w/web?thread=1a2b3c4d")
        );
        until_turn_over(&script).await;
        assert!(heard.try_recv().is_err(), "one notification");
    }

    const BASE: &str = "https://box.tail.ts.net:8443";

    /// `wait` as `tell` names it, from a store whose row for it under
    /// `workspace` has `title`.
    async fn titled_wait(wait: &Wait, workspace: &str, title: &str) -> Wait {
        let (store, _) = crate::store::tests::scratch();
        store
            .put_title(workspace, &wait.thread, "laptop", &place(), title)
            .await
            .expect("the title is kept");
        let mut told = wait.clone();
        told.named(&store).await;
        told
    }

    /// Y-669: a thread the store has no title for is never named by its id.
    #[tokio::test]
    async fn a_wait_with_no_title_says_a_chat_thread_and_not_its_id() {
        let (store, _) = crate::store::tests::scratch();
        let mut wait = Wait::new("web", THREAD, Phase::WaitingForApproval);
        wait.named(&store).await;
        let message = wait.message(Some(BASE));
        assert_eq!(message.body, "web: a chat thread waits for an answer");
        assert!(!message.body.contains(THREAD), "{}", message.body);
        assert_eq!(
            message.click.as_deref(),
            Some("https://box.tail.ts.net:8443/w/web?thread=1a2b3c4d")
        );
        assert_eq!(wait.message(None).click, None, "no base, no link");
    }

    /// A home thread's page is its machine's, which only the store knows.
    #[tokio::test]
    async fn a_home_thread_wait_links_to_its_machine_home() {
        let wait = Wait::new(keep::HOME, THREAD, Phase::Completed);
        assert_eq!(wait.message(Some(BASE)).click, None, "no row, no machine");
        let told = titled_wait(&wait, "", "Tidy dotfiles").await;
        let message = told.message(Some(BASE));
        assert_eq!(message.body, "yantra-home: Tidy dotfiles finished a turn");
        assert_eq!(
            message.click.as_deref(),
            Some("https://box.tail.ts.net:8443/m/laptop/home?thread=1a2b3c4d")
        );
    }

    #[test]
    fn a_link_percent_encodes_its_segments() {
        let mut wait = Wait::new("a b/c", "t#1", Phase::Completed);
        wait.title = Some("x".repeat(400));
        let message = wait.message(Some(BASE));
        assert_eq!(
            message.click.as_deref(),
            Some("https://box.tail.ts.net:8443/w/a%20b%2Fc?thread=t%231")
        );
        assert_eq!(message.body.chars().count(), notify::BODY_MAX);
    }

    /// A keeper is closed, then its agent ends or is killed.
    async fn until_closed(script: &Script, claude: Claude) {
        until_script(script, closing).await;
        drop(claude);
        until_script(script, |script| script.registry.live(&place().id).is_none()).await;
    }

    fn closing(script: &Script) -> bool {
        script
            .registry
            .live(&place().id)
            .is_none_or(|live| live.lock().closing)
    }

    /// ADR-0041 decision 4: a keeper with no turn and no task closes after
    /// 30 minutes, a tab attached or not.
    #[tokio::test(start_paused = true)]
    async fn an_idle_claude_keeper_closes_after_thirty_minutes() {
        let script = Arc::new(Script::default());
        let (_tab, mut claude) = a_claude_turn_that_ends(&script).await;
        until_turn_over(&script).await;
        tokio::time::sleep(CLAUDE_IDLE - Duration::from_secs(60)).await;
        assert!(!closing(&script), "not yet");
        tokio::time::sleep(Duration::from_secs(120)).await;
        assert!(closing(&script));
        assert_eq!(claude.heard().await, None, "its stdin closed");
        until_closed(&script, claude).await;
    }

    /// ADR-0041 decision 4: a task pins the keeper, every line Claude writes
    /// restarts the pin, and 4 hours of silence close it.
    #[tokio::test(start_paused = true)]
    async fn a_task_pins_the_keeper_until_four_silent_hours() {
        let script = Arc::new(Script::default());
        let (_tab, mut claude, _) = a_turn_that_leaves_a_task(&script).await;
        tokio::time::sleep(CLAUDE_IDLE * 2).await;
        assert!(!closing(&script), "a task pins it past the idle close");
        tokio::time::sleep(PIN - CLAUDE_IDLE * 3).await;
        // A line that makes no event still restarts the pin.
        claude
            .say(json!({"type": "system", "subtype": "thinking_tokens", "estimated_tokens": 5}))
            .await;
        tokio::time::sleep(PIN - Duration::from_secs(60)).await;
        assert!(!closing(&script), "the pin restarted");
        tokio::time::sleep(Duration::from_secs(120)).await;
        assert!(closing(&script));
        assert_eq!(claude.heard().await, None, "its stdin closed");
        until_closed(&script, claude).await;
    }

    /// ADR-0041 decision 9: past half its cap, a keeper is replaced between
    /// turns, unless background work runs.
    #[tokio::test]
    async fn a_keeper_past_half_its_cap_closes_only_with_no_task() {
        let big = || Script {
            out_bytes: Some(Limits::default().cap / 2 + 1),
            ..Script::default()
        };
        let script = Arc::new(big());
        let (_tab, mut claude) = a_claude_turn_that_ends(&script).await;
        assert_eq!(claude.heard().await, None, "its stdin closed");
        until_closed(&script, claude).await;

        let script = Arc::new(big());
        let (_tab, _claude, _) = a_turn_that_leaves_a_task(&script).await;
        until_turn_over(&script).await;
        assert!(!closing(&script), "the task holds it");
    }

    /// ADR-0041: a restart adopts a keeper whose turn ended as live, and the
    /// next turn goes to its process.
    #[tokio::test]
    async fn an_idle_claude_keeper_is_adopted_and_takes_the_next_turn() {
        let script = Arc::new(
            Script {
                threads: vec![place()],
                ..Script::default()
            }
            .keeping(Journal {
                run: "7".to_owned(),
                input: prompted("fix it").into_bytes(),
                out: lines(&[
                    json!({"type": "system", "subtype": "init", "permissionMode": "default"}),
                    ended(),
                ]),
                ..Journal::default()
            }),
        );
        adopt_place(&script, "web", place())
            .await
            .expect("the keeper is read back");
        let live = script.registry.live(&place().id).expect("adopted live");
        assert!(!live.busy());
        let (mut tab, _served) = connect(Arc::clone(&script), Some(THREAD));
        through(&mut tab, "queue").await;
        tab.send(json!({"type": "turn", "text": "and the docs"}));
        let mut claude = script.claude().await;
        assert_eq!(
            prompt_of(&claude.heard().await.expect("a line")),
            "and the docs"
        );
        assert!(lock(&script.modes).is_empty(), "no new process");
        let frames = through(&mut tab, "content.delta").await;
        assert_eq!(frames[frames.len() - 1]["payload"]["itemId"], "user:7:2");
    }

    /// ADR-0041 decision 6: Stop sends `stop_task` for a task that runs, and
    /// a task that does not run is a `stopTask` failure.
    #[tokio::test]
    async fn stop_task_reaches_claude_and_an_unknown_task_is_refused() {
        let script = Arc::new(Script::default());
        let (mut tab, mut claude, _) = a_turn_that_leaves_a_task(&script).await;
        tab.send(json!({"type": "stopTask", "taskId": "b561loltj"}));
        let stop = claude.heard().await.expect("a stop");
        assert_eq!(
            stop["request"],
            json!({"subtype": "stop_task", "task_id": "b561loltj"})
        );
        let said = tab
            .next_after(json!({"type": "stopTask", "taskId": "b0000000"}))
            .await;
        assert_eq!(said["kind"], "stopTask", "{said}");
        assert!(
            said["said"]
                .as_str()
                .is_some_and(|said| said.contains("b0000000"))
        );
        assert!(!closing(&script), "one task's stop keeps the keeper");
    }

    /// ADR-0041 decision 6: Stop all stops every task, then closes the
    /// keeper, and the tab's roster empties though Claude never said so.
    #[tokio::test]
    async fn stop_all_stops_every_task_and_closes_the_keeper() {
        let script = Arc::new(Script::default());
        let (mut tab, mut claude, _) = a_turn_that_leaves_a_task(&script).await;
        tab.send(json!({"type": "stopAll"}));
        assert_eq!(
            claude.heard().await.expect("a stop")["request"]["subtype"],
            "stop_task"
        );
        assert_eq!(claude.heard().await, None, "then stdin closes");
        until_closed(&script, claude).await;
        let frames = through(&mut tab, "thread.background.updated").await;
        assert_eq!(rosters(&frames), [0]);
    }

    /// Stop all during a turn: the cancelled turn's end keeps the kill
    /// deadline, so a Claude that ignores its closed stdin is killed.
    #[tokio::test(start_paused = true)]
    async fn stop_all_kills_a_claude_that_ignores_its_closed_stdin() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        tab.send(json!({"type": "stopAll"}));
        assert_eq!(
            claude.heard().await.expect("an interrupt")["request"]["subtype"],
            "interrupt"
        );
        assert_eq!(claude.heard().await, None, "then stdin closes");
        claude
            .say(
                json!({"type": "result", "subtype": "success", "is_error": false,
                        "terminal_reason": "aborted_streaming"}),
            )
            .await;
        assert_eq!(tab.next().await["payload"]["state"], "cancelled");
        tokio::time::sleep(STOP_GRACE + Duration::from_secs(1)).await;
        until_script(&script, |script| !lock(&script.finished).is_empty()).await;
        assert_eq!(lock(&script.finished)[0], Duration::ZERO, "it was killed");
    }

    /// ADR-0041 decision 6: a cancel ends the turn and leaves its tasks running.
    #[tokio::test]
    async fn a_cancel_leaves_the_background_tasks_running() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "sleep in the background"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        for line in woken(0, 4) {
            claude.say(line).await;
        }
        through(&mut tab, "thread.background.updated").await;
        tab.send(json!({"type": "cancel"}));
        assert_eq!(
            claude.heard().await.expect("an interrupt")["request"]["subtype"],
            "interrupt"
        );
        claude
            .say(
                json!({"type": "result", "subtype": "success", "is_error": false,
                        "terminal_reason": "aborted_streaming"}),
            )
            .await;
        let ended = through(&mut tab, "turn.diff.updated").await;
        assert!(rosters(&ended).is_empty(), "the task still runs: {ended:?}");
        assert!(!closing(&script), "and so does the keeper");
        tab.send(json!({"type": "stopTask", "taskId": "b561loltj"}));
        assert_eq!(
            claude.heard().await.expect("a stop")["request"]["subtype"],
            "stop_task",
            "the task can still be stopped"
        );
    }

    /// ADR-0041 decision 7: a prompt sent while a wake turn runs waits for
    /// the wake's `result`, then goes to the same process.
    #[tokio::test]
    async fn a_prompt_sent_during_a_wake_waits_for_its_result() {
        let script = Arc::new(Script::default());
        let (mut tab, mut claude, _) = a_turn_that_leaves_a_task(&script).await;
        for line in woken(7, 11) {
            claude.say(line).await;
        }
        through(&mut tab, "turn.started").await;
        assert_eq!(
            tab.next_after(json!({"type": "turn", "text": "and then"}))
                .await,
            queue(&["and then"])
        );
        for line in woken(11, 13) {
            claude.say(line).await;
        }
        let frames = through(&mut tab, "content.delta").await;
        let prompt = &frames[frames.len() - 1]["payload"];
        assert_eq!(prompt["delta"], "and then", "{frames:?}");
        assert_eq!(prompt["itemId"], "user:1:2");
        assert_eq!(
            prompt_of(&claude.heard().await.expect("a line")),
            "and then"
        );
        assert_eq!(lock(&script.modes).len(), 1, "one process");
    }

    /// ADR-0035 decision 7: an ACP keeper with no turn and no tab stops.
    #[tokio::test(start_paused = true)]
    async fn an_idle_acp_keeper_with_no_tab_stops() {
        let script = Arc::new(Script::default());
        let (mut tab, mut agent, prompt) = an_opencode_thread(&script).await;
        agent
            .reply(&prompt, json!({"stopReason": "end_turn"}))
            .await;
        assert_eq!(tab.next().await["type"], "turn.completed");
        assert_eq!(tab.next().await["type"], "turn.diff.updated");
        tokio::time::sleep(IDLE * 2).await;
        assert_eq!(*lock(&script.stdin_closed), 0, "a tab is attached");
        tab.close();
        tokio::time::sleep(IDLE_TICK * 2).await;
        assert_eq!(*lock(&script.stdin_closed), 1);
        assert!(agent.closed().await, "its stdin closed");
        drop(agent);
        until_script(&script, |script| !lock(&script.finished).is_empty()).await;
        assert!(script.registry.live(&place().id).is_none());
    }

    fn cursored(text: &str, cursor: Option<&str>) -> ThreadEvent {
        ThreadEvent {
            thread_id: THREAD.to_owned(),
            cursor: cursor.map(str::to_owned),
            event: Event::ContentDelta(ContentDelta {
                stream_kind: StreamKind::AssistantText,
                delta: text.to_owned(),
                item_id: None,
            }),
        }
    }

    #[test]
    fn a_replay_after_a_cursor_keeps_what_follows_it() {
        let events = vec![
            cursored("a", Some("r:10:0")),
            cursored("made before b", None),
            cursored("b", Some("r:20:0")),
            cursored("c", Some("r:20:1")),
            cursored("made last", None),
        ];
        let after = Cursor::parse("r:20:0").expect("a cursor");
        let kept: Vec<String> = missed(events.clone(), &after)
            .into_iter()
            .map(|event| match event.event {
                Event::ContentDelta(delta) => delta.delta,
                _ => String::new(),
            })
            .collect();
        assert_eq!(kept, ["c", "made last"]);
        let upto = Cursor::parse("r:20:0").expect("a cursor");
        assert_eq!(sent_by(events, Some(&upto)).len(), 3, "a, made before b, b");
    }

    /// A room prompt, as `room::wrap` makes one.
    const ROOM_PROMPT: &str =
        "<room name=\"r1\" from=\"alpha · chat A\" seq=\"1\" budget=\"1/20\">\nhi\n</room>";

    fn prompt_of(line: &Value) -> &str {
        line["message"]["content"][0]["text"]
            .as_str()
            .expect("a user prompt")
    }

    /// ADR-0038 decisions 3 and 5: an idle thread wakes with the message as
    /// its prompt, never above acceptEdits, and as Supervised when this
    /// daemon has seen no turn of it.
    #[tokio::test]
    async fn wake_starts_a_turn_on_an_idle_thread_in_the_capped_mode() {
        for (last, capped) in [
            (None, PermissionMode::Supervised),
            (Some(PermissionMode::Supervised), PermissionMode::Supervised),
            (Some(PermissionMode::Auto), PermissionMode::AutoAcceptEdits),
            (
                Some(PermissionMode::FullAccess),
                PermissionMode::AutoAcceptEdits,
            ),
        ] {
            let script = Arc::new(Script::default());
            if let Some(mode) = last {
                script.registry.remember_mode(&place().id, mode);
            }
            assert_eq!(
                wake_on(
                    Arc::clone(&script),
                    "web".to_owned(),
                    place(),
                    ROOM_PROMPT.to_owned(),
                )
                .await,
                Woke::Started
            );
            let mut claude = script.claude().await;
            assert_eq!(
                prompt_of(&claude.heard().await.expect("a line")),
                ROOM_PROMPT
            );
            assert_eq!(*lock(&script.modes), [capped], "{last:?}");
        }
    }

    fn queued(script: &Script) -> usize {
        script
            .registry
            .lock()
            .queued
            .get(&place().id)
            .map_or(0, Vec::len)
    }

    #[tokio::test]
    async fn wake_queues_on_a_busy_thread_and_sends_one_prompt_when_its_turn_ends() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "work", "mode": "full-access"}));
        tab.next().await;
        tab.next().await;
        let mut first = script.claude().await;
        first.heard().await;
        let mut waking = Vec::new();
        for (n, prompt) in ["one", "two"].into_iter().enumerate() {
            waking.push(tokio::spawn(wake_on(
                Arc::clone(&script),
                "web".to_owned(),
                place(),
                prompt.to_owned(),
            )));
            until_script(&script, |script| queued(script) == n + 1).await;
        }
        assert!(
            waking.iter().all(|wake| !wake.is_finished()),
            "a queued wake waits for the turn it waits behind"
        );
        assert_eq!(
            lock(&script.modes).len(),
            1,
            "no second turn beside the first"
        );

        first
            .say(json!({"type": "result", "subtype": "success", "is_error": false}))
            .await;
        let mode = first.heard().await.expect("a line");
        assert_eq!(mode["request"]["subtype"], "set_permission_mode");
        assert_eq!(mode["request"]["mode"], "acceptEdits", "a room's cap");
        assert_eq!(
            prompt_of(&first.heard().await.expect("a line")),
            "one\n\ntwo"
        );
        for wake in waking {
            assert_eq!(wake.await.expect("no panic"), Woke::Started);
        }
        assert_eq!(
            *lock(&script.modes),
            [PermissionMode::FullAccess],
            "one process"
        );
        first
            .say(json!({"type": "result", "subtype": "success", "is_error": false}))
            .await;
        until_turn_over(&script).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(300), first.heard())
                .await
                .is_err(),
            "the queue was sent once"
        );
    }

    /// The `queue` frame a thread's sockets get.
    fn queue(texts: &[&str]) -> Value {
        json!({"type": "queue", "threadId": THREAD, "texts": texts})
    }

    /// An attach sends the queue, an empty one too.
    async fn no_queue(tab: &mut Tab) {
        assert_eq!(tab.next().await, queue(&[]), "the queue as it is");
    }

    fn ended() -> Value {
        json!({"type": "result", "subtype": "success", "is_error": false})
    }

    /// The frames a tab gets up to the next turn's prompt, which it returns.
    async fn until_prompt(tab: &mut Tab) -> Value {
        let frames = through(tab, "content.delta").await;
        assert_eq!(frames[frames.len() - 2], queue(&[]), "{frames:?}");
        frames[frames.len() - 1]["payload"].clone()
    }

    /// Y-561, ADR-0041: a second turn is queued, and the turn's end sends it
    /// to the same keeper, which the tab that sent it and a second tab follow.
    #[tokio::test]
    async fn queue_a_second_claude_turn_starts_when_the_turn_ends() {
        let script = Arc::new(Script {
            threads: vec![place()],
            ..Script::default()
        });
        let (mut first, _a) = connect(Arc::clone(&script), None);
        first.send(json!({"type": "turn", "text": "fix the test"}));
        first.next().await;
        first.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        let (mut second, _b) = connect(Arc::clone(&script), Some(THREAD));
        assert_eq!(second.next().await["type"], "thread.started");
        second.next().await;
        no_queue(&mut second).await;

        first.send(json!({"type": "turn", "text": "and the docs"}));
        assert_eq!(first.next().await, queue(&["and the docs"]));
        assert_eq!(second.next().await, queue(&["and the docs"]));
        assert_eq!(
            lock(&script.modes).len(),
            1,
            "no second turn beside the first"
        );
        let (mut late, _c) = connect(Arc::clone(&script), Some(THREAD));
        let replayed = through(&mut late, "queue").await;
        assert_eq!(
            replayed.last(),
            Some(&queue(&["and the docs"])),
            "a late tab"
        );

        claude.say(ended()).await;
        let prompt =
            json!({"streamKind": "user_text", "delta": "and the docs", "itemId": "user:1:2"});
        assert_eq!(until_prompt(&mut first).await, prompt);
        assert_eq!(until_prompt(&mut second).await, prompt);
        assert_eq!(
            prompt_of(&claude.heard().await.expect("a line")),
            "and the docs"
        );
        claude
            .say(json!({"type": "system", "subtype": "init"}))
            .await;
        assert_eq!(first.next().await["type"], "turn.started");
        assert_eq!(second.next().await["type"], "turn.started");
    }

    #[tokio::test]
    async fn queue_two_turns_become_one_prompt_in_the_last_mode() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        tab.send(json!({"type": "turn", "text": "one"}));
        assert_eq!(tab.next().await, queue(&["one"]));
        tab.send(json!({"type": "turn", "text": "two", "mode": "full-access"}));
        assert_eq!(tab.next().await, queue(&["one", "two"]));

        claude.say(ended()).await;
        assert_eq!(until_prompt(&mut tab).await["delta"], "one\n\ntwo");
        // Full access asks Claude as Supervised does, so the process keeps its mode.
        assert_eq!(
            prompt_of(&claude.heard().await.expect("a line")),
            "one\n\ntwo"
        );
        assert_eq!(*lock(&script.modes), [PermissionMode::Supervised]);
        assert_eq!(
            script.registry.mode(&place().id),
            Some(PermissionMode::FullAccess)
        );
    }

    /// Y-565: a queued plan turn starts as a plan turn.
    #[tokio::test]
    async fn queue_a_plan_turn_keeps_plan() {
        let script = Arc::new(Script::default());
        let (mut tab, mut claude) = a_claude_turn_in(&script, Some("full-access")).await;
        tab.send(
            json!({"type": "turn", "text": "then plan", "mode": "full-access",
                        "interaction": "plan"}),
        );
        assert_eq!(tab.next().await, queue(&["then plan"]));

        claude.say(ended()).await;
        until_prompt(&mut tab).await;
        let mode = claude.heard().await.expect("a line");
        assert_eq!(mode["request"]["subtype"], "set_permission_mode");
        assert_eq!(mode["request"]["mode"], "plan");
        assert_eq!(
            prompt_of(&claude.heard().await.expect("a line")),
            "then plan"
        );
        let commands = lock(&script.commands);
        assert_eq!(commands.len(), 1, "one process");
        assert!(
            commands[0].contains("--permission-mode default -p"),
            "{}",
            commands[0]
        );
        assert_eq!(
            script.registry.mode(&place().id),
            Some(PermissionMode::Supervised),
            "plan relays every request"
        );
    }

    /// Y-564: a Claude keeper starts with the model and effort its first
    /// frame names.
    #[tokio::test]
    async fn a_claude_turn_starts_with_the_model_and_effort_it_names() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test",
                        "model": "opus", "effort": "max"}));
        tab.next().await;
        tab.next().await;
        assert_eq!(
            prompt_of(&script.claude().await.heard().await.expect("a line")),
            "fix the test"
        );
        let commands = lock(&script.commands);
        assert!(
            commands[0].contains("--permission-mode default --model 'opus' --effort max -p"),
            "{}",
            commands[0]
        );
    }

    /// Y-663: a Claude keeper starts with the context length its first frame
    /// names, and a later turn that changes it sets it on the live process.
    #[tokio::test]
    async fn a_claude_turn_compacts_at_the_context_length_it_names() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test", "contextLength": 256_000}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        assert!(
            lock(&script.commands)[0].contains("--autocompact 256000 -p"),
            "{}",
            lock(&script.commands)[0]
        );
        claude.say(ended()).await;
        through(&mut tab, "turn.completed").await;

        tab.send(json!({"type": "turn", "text": "and the docs", "contextLength": 1_000_000}));
        assert_eq!(
            claude.heard().await.expect("a line")["request"],
            json!({"subtype": "apply_flag_settings",
                "settings": {"autoCompactWindow": 1_000_000}})
        );
        assert_eq!(
            prompt_of(&claude.heard().await.expect("a line")),
            "and the docs"
        );
        assert_eq!(lock(&script.commands).len(), 1, "one process");
    }

    /// Y-564, ADR-0041 decision 5: a later turn in another model or effort
    /// sets it on the live process before its line, and starts no other.
    #[tokio::test]
    async fn a_new_model_goes_to_the_live_keeper() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test", "model": "opus"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        claude.say(ended()).await;
        through(&mut tab, "turn.completed").await;

        tab.send(json!({"type": "turn", "text": "and the docs", "model": "haiku"}));
        let model = claude.heard().await.expect("a line");
        assert_eq!(
            model["request"],
            json!({"subtype": "set_model", "model": "haiku"})
        );
        assert_eq!(
            prompt_of(&claude.heard().await.expect("a line")),
            "and the docs"
        );
        assert_eq!(lock(&script.commands).len(), 1, "one process");
    }

    /// Y-564, Y-663: a room's turn, queued behind the person's or on an idle
    /// thread, runs in the model, effort and context length the thread runs
    /// with, so it sends no change before its line.
    #[tokio::test]
    async fn a_room_prompt_keeps_the_picked_model_and_effort() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(
            json!({"type": "turn", "text": "fix the test", "mode": "full-access",
                        "model": "opus", "effort": "max", "contextLength": 400_000}),
        );
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        let waking = tokio::spawn(wake_on(
            Arc::clone(&script),
            "web".to_owned(),
            place(),
            "one".to_owned(),
        ));
        until_script(&script, |script| queued(script) == 1).await;
        claude.say(ended()).await;
        let mode = claude.heard().await.expect("a line");
        assert_eq!(mode["request"]["subtype"], "set_permission_mode");
        assert_eq!(prompt_of(&claude.heard().await.expect("a line")), "one");
        assert_eq!(waking.await.expect("no panic"), Woke::Started);
        claude.say(ended()).await;
        until_turn_over(&script).await;

        assert_eq!(
            wake_on(
                Arc::clone(&script),
                "web".to_owned(),
                place(),
                "two".to_owned()
            )
            .await,
            Woke::Started
        );
        assert_eq!(prompt_of(&claude.heard().await.expect("a line")), "two");
        assert_eq!(lock(&script.commands).len(), 1, "one process");
    }

    #[tokio::test]
    async fn queue_two_turns_run_in_the_last_ones_model_and_effort() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        tab.send(json!({"type": "turn", "text": "one", "model": "haiku", "effort": "low"}));
        assert_eq!(tab.next().await, queue(&["one"]));
        tab.send(json!({"type": "turn", "text": "two", "model": "sonnet", "effort": "high"}));
        assert_eq!(tab.next().await, queue(&["one", "two"]));

        claude.say(ended()).await;
        assert_eq!(until_prompt(&mut tab).await["delta"], "one\n\ntwo");
        assert_eq!(
            claude.heard().await.expect("a line")["request"],
            json!({"subtype": "set_model", "model": "sonnet"})
        );
        assert_eq!(
            claude.heard().await.expect("a line")["request"],
            json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": "high"}})
        );
        assert_eq!(
            prompt_of(&claude.heard().await.expect("a line")),
            "one\n\ntwo"
        );
        let commands = lock(&script.commands);
        assert_eq!(commands.len(), 1, "one process");
        assert!(
            commands[0].contains("--permission-mode default -p"),
            "{}",
            commands[0]
        );
    }

    /// An ACP agent takes no `--model`, so a frame that names one still runs.
    #[tokio::test]
    async fn an_acp_turn_with_a_model_and_effort_still_runs() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(
            json!({"type": "turn", "text": "list the files", "harness": "opencode",
                        "model": "opus", "effort": "max"}),
        );
        let mut agent = script.agent().await;
        agent.initialized().await;
        let new = agent.heard().await;
        agent
            .reply(&new, json!({"sessionId": SESSION, "configOptions": []}))
            .await;
        assert_eq!(tab.next().await["type"], "thread.started");
        assert_eq!(tab.next().await["payload"]["itemId"], "user:1:1");
        assert_eq!(agent.heard().await["method"], "session/prompt");
        assert_eq!(tab.next().await["type"], "turn.started");
        assert!(lock(&script.commands).is_empty(), "no Claude turn started");
    }

    /// Y-663: a Codex keeper starts with the context length of the turn that
    /// opens the thread.
    #[tokio::test]
    async fn a_codex_keeper_starts_with_the_context_length_of_the_first_turn() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(
            json!({"type": "turn", "text": "list the files", "harness": "codex",
                        "contextLength": 400_000}),
        );
        let mut agent = script.agent().await;
        agent.initialized().await;
        let new = agent.heard().await;
        agent
            .reply(&new, json!({"sessionId": SESSION, "configOptions": []}))
            .await;
        assert_eq!(tab.next().await["type"], "thread.started");
        assert_eq!(
            *lock(&script.contexts),
            [ContextLength::try_from(400_000).ok()]
        );
    }

    #[tokio::test]
    async fn queue_cancel_empties_it_and_no_turn_starts() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "fix the test"}));
        tab.next().await;
        tab.next().await;
        let mut claude = script.claude().await;
        claude.heard().await;
        tab.send(json!({"type": "turn", "text": "and the docs"}));
        assert_eq!(tab.next().await, queue(&["and the docs"]));

        assert_eq!(tab.next_after(json!({"type": "cancel"})).await, queue(&[]));
        assert_eq!(
            claude.heard().await.expect("an interrupt")["request"]["subtype"],
            "interrupt"
        );
        claude.say(ended()).await;
        until_turn_over(&script).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(300), claude.heard())
                .await
                .is_err(),
            "no turn started"
        );
        assert_eq!(lock(&script.modes).len(), 1);
    }

    #[tokio::test]
    async fn queue_an_acp_turn_is_prompted_on_the_same_agent() {
        let script = Arc::new(Script::default());
        let (mut tab, mut agent, prompt) = an_opencode_thread(&script).await;
        tab.send(json!({"type": "turn", "text": "and the docs"}));
        assert_eq!(tab.next().await, queue(&["and the docs"]));

        agent
            .reply(&prompt, json!({"stopReason": "end_turn"}))
            .await;
        assert_eq!(until_prompt(&mut tab).await["itemId"], "user:1:2");
        let again = agent.heard().await;
        assert_eq!(again["method"], "session/prompt");
        assert_eq!(again["params"]["prompt"][0]["text"], "and the docs");
        assert!(lock(&script.finished).is_empty(), "the same agent");
    }

    /// A keeper that closes past half its cap hands its queue to the next one.
    #[tokio::test]
    async fn queue_an_acp_turn_reaches_the_agent_after_a_half_cap_close() {
        let script = Arc::new(Script {
            out_bytes: Some(Limits::default().cap / 2 + 1),
            ..Script::default()
        });
        let (mut tab, mut agent, prompt) = an_opencode_thread(&script).await;
        tab.send(json!({"type": "turn", "text": "again"}));
        assert_eq!(tab.next().await, queue(&["again"]));
        agent
            .reply(&prompt, json!({"stopReason": "end_turn"}))
            .await;
        until_script(&script, |script| *lock(&script.stdin_closed) == 1).await;
        assert!(agent.closed().await, "its stdin closed");
        drop(agent);

        let mut next = script.agent().await;
        next.initialized().await;
        let load = next.heard().await;
        assert_eq!(load["method"], "session/load");
        assert_eq!(load["params"]["sessionId"], SESSION);
        next.reply(&load, json!({})).await;
        assert_eq!(until_prompt(&mut tab).await["itemId"], "user:2:1");
        let again = next.heard().await;
        assert_eq!(again["method"], "session/prompt");
        assert_eq!(again["params"]["prompt"][0]["text"], "again");
    }

    /// ADR-0038 §3 still holds behind a person's queued turn.
    #[tokio::test]
    async fn queue_a_room_prompt_wakes_after_the_persons_queued_turn() {
        let script = Arc::new(Script::default());
        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "work"}));
        tab.next().await;
        tab.next().await;
        let mut first = script.claude().await;
        first.heard().await;
        tab.send(json!({"type": "turn", "text": "mine"}));
        assert_eq!(tab.next().await, queue(&["mine"]));
        let wake = tokio::spawn(wake_on(
            Arc::clone(&script),
            "web".to_owned(),
            place(),
            ROOM_PROMPT.to_owned(),
        ));
        until_script(&script, |script| queued(script) == 1).await;

        first.say(ended()).await;
        assert_eq!(prompt_of(&first.heard().await.expect("a line")), "mine");
        until_script(&script, |script| queued(script) == 1).await;
        assert!(!wake.is_finished(), "the room waits behind the person");
        first.say(ended()).await;
        assert_eq!(
            prompt_of(&first.heard().await.expect("a line")),
            ROOM_PROMPT
        );
        assert_eq!(wake.await.expect("no panic"), Woke::Started);
    }

    /// The review's finding: a queued prompt whose turn never started was
    /// counted as delivered, so the room never gave its messages back.
    #[tokio::test]
    async fn a_queued_room_message_whose_turn_cannot_start_reaches_the_threads_next_read() {
        let script = Arc::new(Script::default());
        let waker = Arc::clone(&script);
        let wake: crate::room::Wake = Arc::new(move |_, prompt| {
            wake_on(Arc::clone(&waker), "web".to_owned(), place(), prompt)
        });
        let rooms = crate::room::Rooms::waking(wake, None);
        let me = room::Reader {
            node: "beta".to_owned(),
            thread: Some(room::Thread {
                workspace: "web".to_owned(),
                thread: thread::name(&place()).to_owned(),
            }),
            session: None,
        };
        let other = room::Reader {
            node: "alpha".to_owned(),
            thread: None,
            session: None,
        };
        let closing = watch::Sender::new(false);
        rooms
            .read(&me, "beta", "r1", Duration::ZERO, &closing)
            .await
            .expect("joins");

        let (mut tab, _served) = connect(Arc::clone(&script), None);
        tab.send(json!({"type": "turn", "text": "work"}));
        tab.next().await;
        tab.next().await;
        let mut first = script.claude().await;
        first.heard().await;
        rooms.send(&other, "alpha", "r1", "queued").expect("sent");
        until_script(&script, |script| queued(script) == 1).await;

        // A revert begins before the turn ends, so the queued turn cannot start.
        script.registry.lock().reverting.insert(place().id);
        first
            .say(json!({"type": "result", "subtype": "success", "is_error": false}))
            .await;
        let read = tokio::time::timeout(
            Duration::from_secs(5),
            rooms.read(&me, "beta", "r1", Duration::from_secs(50), &closing),
        )
        .await
        .expect("the give-back ends the wait")
        .expect("read")
        .expect("not closing");
        assert_eq!(read.len(), 1, "{read:?}");
        assert_eq!(read[0].text, "queued");
        assert_eq!(lock(&script.modes).len(), 1, "no second turn");
    }

    #[tokio::test(start_paused = true)]
    async fn wake_takes_no_checkpoint_of_a_thread_that_reverts() {
        let script = Arc::new(Script::default());
        script.registry.lock().reverting.insert(place().id);
        let woke = wake_on(
            Arc::clone(&script),
            "web".to_owned(),
            place(),
            ROOM_PROMPT.to_owned(),
        )
        .await;
        assert_eq!(woke, Woke::Failed);
        assert_eq!(*lock(&script.checkpoints), 0, "no checkpoint was taken");
        assert!(lock(&script.modes).is_empty());
    }

    #[tokio::test]
    async fn wake_leaves_an_acp_thread_alone() {
        let script = Arc::new(Script {
            kept: Some((Harness::Opencode, SESSION.to_owned())),
            ..Script::default()
        });
        let woke = wake_on(
            Arc::clone(&script),
            "web".to_owned(),
            place(),
            ROOM_PROMPT.to_owned(),
        )
        .await;
        assert_eq!(woke, Woke::Never, "so the room stops waking it");
        assert!(lock(&script.turns).is_empty());
        assert!(lock(&script.modes).is_empty());
    }

    /// Until the turn's checkpoint is kept.
    async fn until_turn_over(script: &Script) {
        until_script(script, |script| {
            script
                .registry
                .live(&place().id)
                .is_some_and(|live| !live.busy())
        })
        .await;
    }

    /// Y-542: a revert waits for the turn's checkpoint, or the capture would
    /// keep a tree the revert is changing. A commit waits too.
    #[tokio::test]
    async fn revert_while_a_turns_checkpoint_is_kept_is_refused_as_busy() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let script = Arc::new(Script {
            capture_gate: Some(Arc::clone(&gate)),
            ..Script::default()
        });
        let (mut tab, _claude) = a_claude_turn_that_ends(&script).await;
        until_turn_over(&script).await;
        let said = tab.next_after(json!({"type": "revert", "turn": 0})).await;
        assert_eq!(said["kind"], "busy", "{said}");
        assert!(lock(&script.reverted).is_empty());
        assert!(script.registry.occupied(&place().id));

        gate.notify_one();
        assert_eq!(tab.next().await["type"], "turn.diff.updated");
        assert_eq!(
            tab.next_after(json!({"type": "revert", "turn": 0})).await["type"],
            "thread.reverted"
        );
    }

    /// Y-542, Y-561: a turn sent while the last turn's checkpoint is kept is
    /// queued, and the turn it waits behind still sends its diff first.
    #[tokio::test]
    async fn a_turn_sent_while_the_last_is_kept_gets_the_last_diff_first() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let script = Arc::new(Script {
            capture_gate: Some(Arc::clone(&gate)),
            ..Script::default()
        });
        let (mut tab, mut claude) = a_claude_turn_that_ends(&script).await;
        until_turn_over(&script).await;
        assert_eq!(
            tab.next_after(json!({"type": "turn", "text": "and the docs"}))
                .await,
            queue(&["and the docs"])
        );
        gate.notify_one();
        let diff = tab.next().await;
        assert_eq!(diff["type"], "turn.diff.updated", "{diff}");
        assert_eq!(diff["payload"]["turn"], 1);
        assert_eq!(tab.next().await, queue(&[]));
        assert_eq!(tab.next().await["payload"]["itemId"], "user:1:2");
        assert_eq!(
            prompt_of(&claude.heard().await.expect("a line")),
            "and the docs"
        );
    }

    /// Y-542: a keeper whose `out` passed half its cap takes no turn while
    /// its agent ends, so the next turn loads the session in a new keeper.
    #[tokio::test]
    async fn a_turn_after_a_half_cap_close_reaches_a_new_agent() {
        let script = Arc::new(Script {
            out_bytes: Some(Limits::default().cap / 2 + 1),
            ..Script::default()
        });
        let (mut tab, mut agent, prompt) = an_opencode_thread(&script).await;
        agent
            .reply(&prompt, json!({"stopReason": "end_turn"}))
            .await;
        assert_eq!(tab.next().await["type"], "turn.completed");
        assert_eq!(tab.next().await["type"], "turn.diff.updated");
        until_script(&script, |script| *lock(&script.stdin_closed) == 1).await;
        assert!(agent.closed().await, "its stdin closed");

        // Y-561: the turn is queued while the old agent ends.
        assert_eq!(
            tab.next_after(json!({"type": "turn", "text": "again"}))
                .await,
            queue(&["again"])
        );
        drop(agent);
        let mut next = script.agent().await;
        next.initialized().await;
        let load = next.heard().await;
        assert_eq!(load["method"], "session/load");
        assert_eq!(load["params"]["sessionId"], SESSION);
        next.reply(&load, json!({})).await;
        assert_eq!(tab.next().await, queue(&[]));
        let said = tab.next().await;
        assert_eq!(said["payload"]["itemId"], "user:2:1", "{said}");
        assert_eq!(next.heard().await["method"], "session/prompt");
    }

    /// Y-542: a tab whose keeper ended sends its next turn to the keeper
    /// another tab started, and sees that turn.
    #[tokio::test]
    async fn a_tab_whose_keeper_ended_sees_its_turn_on_the_next_keeper() {
        let script = Arc::new(Script {
            threads: vec![place()],
            kept: Some((Harness::Opencode, SESSION.to_owned())),
            ..Script::default()
        });
        let (mut first, agent, prompt) = an_opencode_thread(&script).await;
        let mut agent = agent;
        agent
            .reply(&prompt, json!({"stopReason": "end_turn"}))
            .await;
        through(&mut first, "turn.diff.updated").await;
        let (mut second, _b) = connect(Arc::clone(&script), Some(THREAD));
        assert_eq!(second.next().await["type"], "thread.started");
        through(&mut second, "turn.diff.updated").await;
        no_queue(&mut second).await;
        drop(agent);
        until_script(&script, |script| {
            script.registry.live(&place().id).is_none()
        })
        .await;

        second.send(json!({"type": "turn", "text": "from the second tab"}));
        let mut next = script.agent().await;
        next.initialized().await;
        let load = next.heard().await;
        assert_eq!(load["method"], "session/load");
        next.reply(&load, json!({})).await;
        assert_eq!(second.next().await["payload"]["itemId"], "user:2:1");
        let prompt = next.heard().await;
        next.reply(&prompt, json!({"stopReason": "end_turn"})).await;
        through(&mut second, "turn.diff.updated").await;
        // Y-561: the first tab follows the next keeper too.
        let seen = through(&mut first, "turn.diff.updated").await;
        assert_eq!(seen[0]["payload"]["itemId"], "user:2:1", "{seen:?}");

        first.send(json!({"type": "turn", "text": "from the first tab"}));
        assert_eq!(first.next().await["payload"]["itemId"], "user:2:2");
        let prompt = next.heard().await;
        assert_eq!(prompt["method"], "session/prompt");
        next.reply(&prompt, json!({"stopReason": "end_turn"})).await;
        assert_eq!(first.next().await["type"], "turn.started");
        assert_eq!(first.next().await["type"], "turn.completed");
    }

    /// Y-542: a tab that found no keeper to read back, and then found the
    /// one another tab started meanwhile, gets the history that keeper
    /// already sent.
    #[tokio::test]
    async fn a_tab_that_finds_a_keeper_started_meanwhile_gets_its_history() {
        let script = Arc::new(Script {
            threads: vec![place()],
            kept: Some((Harness::Opencode, SESSION.to_owned())),
            ..Script::default()
        });
        let (reached, held) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let (mut late, _b) = connect_held(
            Arc::clone(&script),
            Some(THREAD),
            None,
            Some((reached, released)),
        );
        held.await
            .expect("the late tab read nothing back and waits");

        let (mut first, _a) = connect(Arc::clone(&script), Some(THREAD));
        let mut agent = script.agent().await;
        agent.initialized().await;
        let load = agent.heard().await;
        assert_eq!(load["method"], "session/load");
        agent
            .update(
                json!({"sessionUpdate": "user_message_chunk", "messageId": "m0",
                           "content": {"type": "text", "text": "list the files"}}),
            )
            .await;
        agent.reply(&load, json!({})).await;
        assert_eq!(first.next().await["type"], "thread.started");
        no_queue(&mut first).await;
        let history = first.next().await;
        assert_eq!(history["payload"]["delta"], "list the files", "{history}");

        release.send(()).expect("the late tab waits");
        assert_eq!(late.next().await["type"], "thread.started");
        assert_eq!(late.next().await, history, "the session/load history");
        assert_eq!(*lock(&script.adopted), 0, "one reader for the keeper");
    }

    /// Y-542: a keeper whose workspace is gone is warned about once, and the
    /// refresh pass still looks at it, so a workspace made again adopts it.
    #[tokio::test]
    async fn a_keeper_whose_workspace_is_gone_is_noted_once_and_not_hidden() {
        let registry = Registry::default();
        let gone = "y542-no-such-workspace";
        let session = Keeper::new(gone, THREAD).session();
        adopt(&registry, "m", gone, THREAD).await;
        assert!(registry.lock().gone.contains(&session), "warned once");
        assert!(!registry.holds(&session), "the next pass looks again");
    }

    /// ADR-0046 decision 1.5: a `yantra-home` keeper is a home thread's, so no
    /// workspace is loaded for it.
    #[tokio::test]
    async fn adopt_takes_a_home_keeper_for_a_home_thread() {
        let said = adopted(&Registry::default(), "m", keep::HOME, THREAD).await;
        assert_eq!(said, Err("a home chat needs the thread store".to_owned()));
    }

    /// Y-542: a keeper whose thread is gone is killed once its agent ended,
    /// and left while it runs.
    #[tokio::test]
    async fn a_keeper_whose_thread_is_gone_is_killed_once_its_agent_ends() {
        let ended = Arc::new(Script::default());
        assert_eq!(adopt_in(&ended, "web", THREAD).await, Ok(None));
        assert_eq!(*lock(&ended.orphans), [THREAD]);

        let running = Arc::new(Script {
            orphan_runs: true,
            ..Script::default()
        });
        assert!(matches!(
            adopt_in(&running, "web", THREAD).await,
            Ok(Some(_))
        ));
        assert!(lock(&running.orphans).is_empty());
    }

    /// Y-542: an agent that ignores its closed stdin is killed after the
    /// grace, so the next turn reaches a new keeper and is never busy.
    #[tokio::test(start_paused = true)]
    async fn an_agent_that_ignores_its_closed_stdin_is_killed_after_the_grace() {
        let script = Arc::new(Script {
            out_bytes: Some(Limits::default().cap / 2 + 1),
            ..Script::default()
        });
        let (mut tab, mut agent, prompt) = an_opencode_thread(&script).await;
        agent
            .reply(&prompt, json!({"stopReason": "end_turn"}))
            .await;
        assert_eq!(tab.next().await["type"], "turn.completed");
        assert_eq!(tab.next().await["type"], "turn.diff.updated");
        until_script(&script, |script| *lock(&script.stdin_closed) == 1).await;
        // The agent holds its end and never exits.
        tokio::time::sleep(STOP_GRACE + Duration::from_secs(1)).await;
        until_script(&script, |script| {
            script.registry.live(&place().id).is_none()
        })
        .await;
        assert_eq!(lock(&script.finished)[0], Duration::ZERO, "it was killed");

        tab.send(json!({"type": "turn", "text": "again"}));
        let mut next = script.agent().await;
        next.initialized().await;
        let load = next.heard().await;
        assert_eq!(load["method"], "session/load");
        next.reply(&load, json!({})).await;
        assert_eq!(tab.next().await["payload"]["itemId"], "user:2:1");
        drop(agent);
    }

    fn here() -> Here {
        Here {
            place: place(),
            harness: Some(Harness::Opencode),
            session: Some(SESSION.to_owned()),
        }
    }

    fn browser() -> (Browser, mpsc::UnboundedReceiver<String>) {
        let (to, heard) = mpsc::unbounded_channel();
        let (_, from) = mpsc::unbounded_channel();
        let browser = Browser {
            from,
            to,
            held: None,
            pings: Arc::default(),
            pong: None,
        };
        (browser, heard)
    }

    fn typed(text: &str) -> Next {
        Next {
            text: text.to_owned(),
            mode: PermissionMode::default(),
            interaction: Interaction::default(),
            model: None,
            effort: None,
            context: None,
            room: false,
        }
    }

    /// Y-542: a socket whose keeper ended before its loop saw the end still
    /// follows the keeper another tab reads.
    #[tokio::test]
    async fn a_turn_after_an_unseen_end_follows_the_next_keeper() {
        let script = Arc::new(Script::default());
        let (mut other, mut agent, prompt) = an_opencode_thread(&script).await;
        agent
            .reply(&prompt, json!({"stopReason": "end_turn"}))
            .await;
        through(&mut other, "turn.diff.updated").await;
        let (ended, _commands) = Live::new(&place(), "0".to_owned(), false);
        let mut sub = ended.subscribe().map(|(_, _, receiver)| Sub {
            receiver,
            seen: None,
        });
        ended.close();

        let (mut browser, _heard) = browser();
        let mut here = Some(here());
        let begun = begin(
            &script,
            "web",
            &mut here,
            &mut sub,
            &mut None,
            None,
            typed("again"),
            &mut browser,
        )
        .await;
        assert!(begun);
        let open = sub.expect("a subscription");
        assert!(!open.receiver.is_closed(), "it follows the live keeper");
        assert_eq!(agent.heard().await["method"], "session/prompt");
    }

    /// Y-542: a turn that waits while another tab starts the keeper gets the
    /// history that keeper sent meanwhile.
    #[tokio::test]
    async fn a_turn_that_waits_for_a_keeper_another_tab_starts_gets_its_history() {
        let script = Arc::new(Script {
            threads: vec![place()],
            kept: Some((Harness::Opencode, SESSION.to_owned())),
            ..Script::default()
        });
        let (mut first, _a) = connect(Arc::clone(&script), Some(THREAD));
        let mut agent = script.agent().await;

        let waiting = {
            let script = Arc::clone(&script);
            tokio::spawn(async move {
                let (mut browser, heard) = browser();
                let mut sub = None;
                let begun = begin(
                    &script,
                    "web",
                    &mut Some(here()),
                    &mut sub,
                    &mut None,
                    None,
                    typed("again"),
                    &mut browser,
                )
                .await;
                (begun, sub.is_some(), heard)
            })
        };
        // The turn waits on the claim the first tab holds.
        tokio::time::sleep(Duration::from_millis(300)).await;
        agent.initialized().await;
        let load = agent.heard().await;
        assert_eq!(load["method"], "session/load");
        agent
            .update(
                json!({"sessionUpdate": "user_message_chunk", "messageId": "m0",
                           "content": {"type": "text", "text": "list the files"}}),
            )
            .await;
        agent.reply(&load, json!({})).await;
        assert_eq!(first.next().await["type"], "thread.started");
        no_queue(&mut first).await;
        let history = first.next().await;
        assert_eq!(history["payload"]["delta"], "list the files", "{history}");

        let (begun, subscribed, mut heard) = waiting.await.expect("the turn ends");
        assert!(begun && subscribed);
        let said: Value =
            serde_json::from_str(&heard.recv().await.expect("a frame")).expect("JSON");
        assert_eq!(said, history, "the session/load history");
        assert_eq!(agent.heard().await["method"], "session/prompt");
    }

    /// Y-561, Y-542: a revert does not start while a turn waits, and no turn
    /// starts, waits or is marked busy while a revert runs.
    #[tokio::test]
    async fn a_revert_and_a_held_or_started_turn_exclude_each_other() {
        let registry = Registry::default();
        let id = place().id;
        let kind = |reverted: Result<(), Failure>| reverted.err().map(|refusal| refusal.kind);
        let (ending, _commands) = Live::new(&place(), "1".to_owned(), false);
        ending.lock().closing = true;
        assert!(registry.insert(&ending));
        assert!(
            registry.hold(&ending, typed("and the docs")).is_ok(),
            "a keeper that closes holds the turn"
        );
        assert_eq!(kind(registry.begin_revert(&id)), Some(Kind::Busy));
        let (_, held) = registry.forget(&ending);
        assert_eq!(held.len(), 1);

        assert_eq!(kind(registry.begin_revert(&id)), None);
        assert_eq!(
            kind(registry.begin_revert(&id)),
            Some(Kind::Busy),
            "one revert"
        );
        assert!(!registry.claim(&id), "no keeper starts");
        let (idle, _commands) = Live::new(&place(), "2".to_owned(), false);
        assert!(registry.insert(&idle));
        assert!(
            registry.hold(&idle, typed("later")).is_err(),
            "no turn waits"
        );
        idle.lock().closing = true;
        assert!(registry.hold(&idle, typed("later")).is_err());
        idle.lock().closing = false;
        assert_eq!(
            registry.mark_busy(&idle).err().map(|refusal| refusal.kind),
            Some(Kind::Busy),
            "no ACP turn is sent"
        );
        assert!(!idle.busy());

        registry.end_revert(&id);
        assert_eq!(registry.mark_busy(&idle).ok(), Some(true));
    }

    /// Y-561: a turn that loses the start to another task's waits behind it,
    /// and is never refused as busy.
    #[tokio::test]
    async fn a_turn_that_loses_the_start_is_held_behind_the_winner() {
        let script = Arc::new(Script {
            threads: vec![place()],
            ..Script::default()
        });
        assert!(
            script.registry.claim(&place().id),
            "another task starts a turn"
        );
        let claudes = Here {
            harness: None,
            session: None,
            ..here()
        };
        let starting = {
            let script = Arc::clone(&script);
            tokio::spawn(async move {
                start_or_hold(&script, "web", &claudes, typed("and the docs"), false)
                    .await
                    .map(|follow| follow.is_none())
                    .map_err(|refusal| refusal.said)
            })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (won, _commands) = Live::new(&place(), "1".to_owned(), true);
        assert!(script.registry.insert(&won));
        script.registry.release(&place().id);

        assert_eq!(starting.await.expect("it ends"), Ok(true), "held");
        assert_eq!(
            script.registry.queue_of(&place().id).texts,
            ["and the docs"]
        );
        assert!(lock(&script.modes).is_empty(), "no second turn");
    }

    /// Y-561: a tab that attaches, with a cursor or without, gets the queue
    /// even when it is empty, so one that was away while it drained clears it.
    #[tokio::test]
    async fn an_attach_with_no_keeper_sends_the_empty_queue() {
        let script = Arc::new(Script {
            threads: vec![place()],
            ..Script::default()
        });
        let (mut tab, _served) = connect_after(Arc::clone(&script), Some(THREAD), Some("1:9:0"));
        assert_eq!(tab.next().await["type"], "thread.started");
        no_queue(&mut tab).await;
        assert!(tab.quiet().await);
    }
}
