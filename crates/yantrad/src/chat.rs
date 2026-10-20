//! `GET /api/workspaces/{name}/chat?thread=<id>&after=<cursor>` — a chat
//! thread on a WebSocket ([ADR-0026] decision 3).
//!
//! A thread is a worktree of the workspace's repository ([`thread`]), and one
//! harness speaks in it, chosen by the turn that opens it. Claude's turns are
//! each one `claude -p` ([`yantra_core::claude`]). Every other harness is one
//! ACP agent ([`yantra_core::acp`], [ADR-0033] decision 2), whose session id
//! the thread's git config keeps. Without `?thread=` the first turn opens a
//! thread and the socket says so with `thread.started`; with it, the socket
//! says `thread.started` too, replays the conversation and continues there.
//! **There is no session-addressed form**: a bare session names no worktree.
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
//! The browser sends five frames, `turn`, `answer`, `cancel`, `revert` and
//! `diff`, and one turn runs at a time in a thread, across every tab and every
//! restart. The daemon sends [`ThreadEvent`]s and one typed [`Failure`].
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
//! **Each turn ends in a checkpoint** (Y-448, [`checkpoint`]): the first turn
//! keeps the tree before it, each turn's end keeps the tree after it and sends
//! `turn.diff.updated`, and `revert` puts the files back as a checkpoint kept
//! them. The conversation is not rewound.
//!
//! **`diff` gets one [`BranchDiffReply`]** (Y-490): everything the thread
//! changed since its branch left the repository's `HEAD`, read through a
//! private index, so it is answered while a turn runs.
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

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use axum::routing::get;
use serde::{Deserialize, Serialize};
use tokio::sync::{OnceCell, broadcast, mpsc, oneshot};
use yantra_core::acp::{self, Agent, Answer, Harness};
use yantra_core::chat::{
    ContentDelta, Decision, Event, PermissionMode, RequestOption, Scope, StopReason, StreamKind,
    ThreadEvent, TurnDiff, TurnState,
};
use yantra_core::checkpoint::{self, BranchDiff, Diff};
use yantra_core::claude::{self, Events, Said, Turn};
use yantra_core::image::{self, Images};
use yantra_core::inventory::Inventory;
use yantra_core::keep::{self, Cursor, File, Keeper, Limits};
use yantra_core::logs::{self, Who};
use yantra_core::notify::{self, Phase, Relay};
use yantra_core::ssh::{self, Ssh};
use yantra_core::thread::{self, Place};
use yantra_core::tmux::Tmux;
use yantra_core::workspace::{self, Workspace};

use crate::write::{Authoriser, Refused, allowed, chain};

/// How many transcript records an attach replays.
const HISTORY: usize = 200;
/// How long a cancelled turn has to end by itself before its keeper is
/// killed, and how long an ended Claude keeper has to exit before its session
/// is removed.
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
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
    uri: Uri,
    upgrade: WebSocketUpgrade,
) -> Result<Response, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    let query = read_query(&uri);
    tracing::info!("chat {name} for {}", caller.node);

    Ok(sized(upgrade).on_upgrade(move |mut socket| async move {
        match Fleet::of(&name, registry) {
            Ok(fleet) => converse(Arc::new(fleet), &name, query, &mut socket).await,
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
    }))
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
    },
    Answer {
        #[serde(rename = "requestId")]
        request_id: String,
        decision: Decision,
    },
    Cancel,
    /// Puts the thread's files back as checkpoint `turn` kept them.
    Revert {
        turn: u32,
    },
    /// Asks for the thread's whole-branch diff.
    Diff,
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
    /// git could not keep, diff or restore a checkpoint, or diff the
    /// thread's branch.
    Checkpoint,
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

fn harness_named(name: &str) -> Result<Option<Harness>, String> {
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

/// A Claude turn in a new keeper, and the run its cursors carry.
struct KeptTurn {
    turn: Turn,
    events: Events,
    run: String,
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
        turn: Turn,
        events: Events,
        run: String,
        replayed: Vec<ThreadEvent>,
        mode: PermissionMode,
        completed: bool,
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
    /// Starts a Claude turn in a keeper. `images` is the directory it may read.
    fn start(
        &self,
        place: &Place,
        text: &str,
        images: Option<&str>,
        mode: PermissionMode,
    ) -> impl Future<Output = Result<Started<KeptTurn>, String>> + Send;
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
    /// Starts `harness` in a keeper.
    fn start_acp(
        &self,
        place: &Place,
        harness: Harness,
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
    /// Closes the agent's stdin, which ends an ACP agent.
    fn close_stdin(&self, place: &Place) -> impl Future<Output = Result<(), String>> + Send;
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
        text: &str,
        images: Option<&str>,
        mode: PermissionMode,
    ) -> Result<Started<KeptTurn>, String> {
        let keeper = keeper_of(place)?;
        let tmux = self.tmux().await?;
        let run = keep::run_id().map_err(|error| chain(&error))?;
        let agent = claude::command(&place.worktree, images, mode);
        let started = keep::start(&self.ssh, tmux, &keeper, &agent, &run, Limits::default())
            .await
            .map_err(|error| chain(&error))?;
        let keep::Started::Running { pane } = started else {
            return Ok(Started::Busy);
        };
        if let Err(error) = keep::write_mode(&self.ssh, &keeper, &mode_name(mode)).await {
            // The lock goes with the start that failed; `keep::stale` catches a
            // kill that fails too.
            let _ = keep::kill(&self.ssh, tmux, &keeper).await;
            return Err(chain(&error));
        }
        let reader = keep::follow(self.ssh.clone(), tmux.clone(), keeper.clone(), pane, 0);
        let writer = keep::feed(self.ssh.clone(), tmux.clone(), keeper.clone(), 0);
        let said = self.said(&keeper);
        let (turn, events) = Turn::kept(reader, writer, thread::name(place), &run, text, said);
        Ok(Started::Running(KeptTurn { turn, events, run }))
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

    async fn start_acp(
        &self,
        place: &Place,
        harness: Harness,
    ) -> Result<Started<KeptAgent>, String> {
        let keeper = keeper_of(place)?;
        let tmux = self.tmux().await?;
        let run = keep::run_id().map_err(|error| chain(&error))?;
        let started = keep::start(
            &self.ssh,
            tmux,
            &keeper,
            &harness.kept_command(&place.worktree),
            &run,
            Limits::default(),
        )
        .await
        .map_err(|error| chain(&error))?;
        let keep::Started::Running { pane } = started else {
            return Ok(Started::Busy);
        };
        let reader = keep::follow(self.ssh.clone(), tmux.clone(), keeper.clone(), pane, 0);
        let writer = keep::feed(self.ssh.clone(), tmux.clone(), keeper.clone(), 0);
        let said = self.said(&keeper);
        let (agent, events) = Agent::kept(harness, reader, writer, &run, said);
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
                let (events, completed) = (replayed.events.clone(), replayed.completed());
                let reader = follow(replayed.offset);
                let (turn, live) = Turn::resume(reader, writer, replayed, said);
                Adopted::Claude {
                    turn,
                    events: live,
                    run,
                    replayed: events,
                    mode,
                    completed,
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

    async fn close_stdin(&self, place: &Place) -> Result<(), String> {
        keep::close_stdin(&self.ssh, &keeper_of(place)?)
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
}

/// A wait that nobody is attached to see (ADR-0035 decision 10). It names the
/// workspace and the thread, and no word of the request (Q5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wait {
    pub workspace: String,
    pub thread: String,
}

impl Wait {
    fn message(&self) -> notify::Message {
        notify::Message {
            body: format!(
                "{}: chat thread {} waits for an answer",
                self.workspace, self.thread
            ),
            title: Some(Phase::WaitingForApproval.headline().to_owned()),
            priority: None,
        }
    }
}

/// Sends each wait to the relay, one at a time, for the life of the daemon.
pub async fn tell(relay: Relay, mut waits: mpsc::UnboundedReceiver<Wait>) {
    while let Some(wait) = waits.recv().await {
        if let Err(error) = notify::post(&relay, wait.message()).await {
            tracing::warn!(
                "chat {}: the wait was not notified: {error}",
                wait.workspace
            );
        }
    }
}

/// Every live keeper this daemon reads, shared by every socket and by the
/// refresh pass that adopts keepers after a restart. It holds nothing on disk
/// (ADR-0035 decision 13).
#[derive(Clone, Default)]
pub struct Registry {
    held: Arc<Mutex<Held>>,
    waits: Option<mpsc::UnboundedSender<Wait>>,
}

#[derive(Default)]
struct Held {
    lives: HashMap<String, Arc<Live>>,
    /// Threads a revert runs in.
    reverting: HashSet<String>,
    /// Keepers a task is starting or reading back, so a refresh pass does not
    /// adopt a keeper between its start and its registration.
    claimed: HashSet<String>,
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
        }
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

    /// Adds `live` unless the thread already has one.
    fn insert(&self, live: &Arc<Live>) -> bool {
        let mut held = self.lock();
        if held.lives.contains_key(&live.id) {
            return false;
        }
        held.lives.insert(live.id.clone(), Arc::clone(live));
        true
    }

    /// Marks a thread's keeper as being started or read back. `false` is a
    /// thread another task already holds.
    fn claim(&self, id: &str) -> bool {
        let mut held = self.lock();
        !held.lives.contains_key(id) && held.claimed.insert(id.to_owned())
    }

    fn release(&self, id: &str) {
        self.lock().claimed.remove(id);
    }

    fn forget(&self, live: &Live) {
        let mut held = self.lock();
        if held
            .lives
            .get(&live.id)
            .is_some_and(|held| std::ptr::eq(held.as_ref(), live))
        {
            held.lives.remove(&live.id);
        }
    }

    fn wait(&self, workspace: &str, thread: &str) {
        if let Some(waits) = &self.waits {
            let _ = waits.send(Wait {
                workspace: workspace.to_owned(),
                thread: thread.to_owned(),
            });
        }
    }
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
    Turn {
        text: String,
        mode: PermissionMode,
    },
    Answer {
        request: String,
        decision: Decision,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Cancel,
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
    /// Set once the keeper's task is removing its session.
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
                closing: false,
                sender: Some(sender),
                prompts: 0,
                ended: None,
                diff: None,
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

    fn set_busy(&self, busy: bool) {
        self.lock().busy = busy;
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
                self.lock().ended = Some(event.clone());
            }
            Event::TurnStarted => {
                let mut state = self.lock();
                state.ended = None;
                state.diff = None;
            }
            Event::TurnCompleted(_) => self.lock().ended = None,
            Event::TurnDiffUpdated(_) => self.lock().diff = Some(event.clone()),
            _ => {}
        }
        self.publish(event, event.cursor.as_deref());
    }

    /// A subscription, the last cursor sent before it, and what the daemon
    /// made for the last turn that no replay of `out` makes again: its end,
    /// then its diff.
    fn subscribe(&self) -> Option<(Option<Cursor>, Vec<ThreadEvent>, broadcast::Receiver<Sent>)> {
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
            Ok(sent) => {
                let repeated = match (&sent.cursor, &open.seen) {
                    (Some(cursor), Some(seen)) => !cursor.after(seen) && cursor.run == seen.run,
                    _ => false,
                };
                if !repeated {
                    return News::Frame(sent.text);
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => return News::Behind,
            Err(broadcast::error::RecvError::Closed) => return News::Ended,
        }
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
    loop {
        let open = tokio::select! {
            heard = peer.hear() => match heard {
                None => false,
                Some(Heard::Binary(bytes)) => {
                    let reply = land(&machine, name, here.as_ref(), &mut early, &mut images, &bytes).await;
                    peer.say(&reply).await
                }
                Some(Heard::Text(text)) => {
                    heard_frame(&machine, name, &text, &mut here, &mut sub, &mut early, images.as_ref(), peer).await
                }
            },
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
    images: Option<&Images>,
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
        }) => {
            let asked = harness.as_deref().map(harness_named).transpose();
            let theirs = here.as_ref().map(|here| here.harness);
            match (asked, theirs) {
                _ if live.as_ref().is_some_and(|live| live.busy()) => peer.say(&busy()).await,
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
                (Ok(asked), _) => {
                    let turn = Typed {
                        text,
                        images: images.and_then(Images::dir),
                        mode,
                    };
                    begin(machine, name, here, sub, early, asked.flatten(), turn, peer).await
                }
            }
        }
        Ok(Frame::Answer {
            request_id,
            decision,
        }) => {
            let answered = match live {
                Some(live) => {
                    let (reply, replied) = oneshot::channel();
                    live.command(Command::Answer {
                        request: request_id,
                        decision,
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
                live.command(Command::Cancel);
            }
            true
        }
        Ok(Frame::Revert { turn }) => match here.as_ref() {
            None => {
                let said = "no thread is open, so there is nothing to revert";
                peer.say(&failure(Kind::BadFrame, said)).await
            }
            Some(_) if live.as_ref().is_some_and(|live| live.busy()) => peer.say(&busy()).await,
            Some(here) => {
                let place = here.place.clone();
                if !machine.registry().lock().reverting.insert(place.id.clone()) {
                    return peer.say(&elsewhere()).await;
                }
                let said =
                    revert(machine.as_ref(), name, &place, turn, live.as_deref(), peer).await;
                machine.registry().lock().reverting.remove(&place.id);
                said
            }
        },
        // Read-only through a private index, so a running turn does not refuse it.
        Ok(Frame::Diff) => match here.as_ref() {
            None => {
                let said = "no thread is open, so there is nothing to diff";
                peer.say(&failure(Kind::BadFrame, said)).await
            }
            Some(here) => branch_diff(machine.as_ref(), name, &here.place, peer).await,
        },
        Err(error) => {
            let said =
                format!("a frame is a turn, an answer, a cancel, a revert or a diff: {error}");
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

/// Keeps the tree a turn left and sends what the turn changed to every socket
/// of the thread. The diff is never logged (Q5). After a turn that failed, a
/// checkpoint failure is only logged, so the browser keeps the turn's own
/// error.
async fn checkpointed<M: Machine>(
    machine: &M,
    name: &str,
    place: &Place,
    failed: bool,
    live: &Live,
) {
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
            if !failed {
                live.publish(&failure(Kind::Checkpoint, said), None);
            }
        }
    }
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

/// Sends the thread's whole-branch diff. git's words are not logged either,
/// because they may name a path (Q5).
async fn branch_diff<M: Machine, P: Peer>(
    machine: &M,
    name: &str,
    place: &Place,
    peer: &mut P,
) -> bool {
    match within(machine.branch_diff(place)).await {
        Ok(diff) => {
            tracing::info!("chat {name}: branch diff sent");
            peer.say(&BranchDiffReply::of(place, diff)).await
        }
        Err(said) => {
            tracing::warn!("chat {name}: no branch diff");
            peer.say(&failure(Kind::Checkpoint, said)).await
        }
    }
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
    let kept = match machine.recall(&place).await {
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
            if !sent {
                return None;
            }
            None
        }
        (None, Some(harness)) => {
            match connect(machine, name, &here.place, harness, here.session.clone()).await {
                Ok((_, receiver)) => Some(Sub {
                    receiver,
                    seen: None,
                }),
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
    let (last, remade, receiver) = live.subscribe()?;
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
            (replayed.events, replayed.prompt)
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
            if here.harness.is_none() {
                if !replay(machine, &here.place, prompt.as_deref(), peer).await {
                    return None;
                }
                if let Some(prompt) = prompt
                    && !peer
                        .say(&delta(&here.place, StreamKind::UserText, prompt, &live.run))
                        .await
                {
                    return None;
                }
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

/// One turn the person sent: what they wrote, the directory of the images it
/// may read, and the thread's permission mode.
struct Typed<'a> {
    text: String,
    images: Option<&'a str>,
    mode: PermissionMode,
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
    said: Typed<'_>,
    peer: &mut P,
) -> bool {
    let here = match here {
        Some(here) => here,
        None => match open(machine, name, early, pick).await {
            Ok((opened, subscribed)) => {
                if !peer.say(&opened.started(None)).await {
                    return false;
                }
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
    match within(machine.base(&here.place)).await {
        Ok(Some(turn)) => tracing::info!("chat {name}: checkpoint {turn} kept"),
        Ok(None) => {}
        Err(said) => {
            tracing::warn!("chat {name}: no checkpoint: {said}");
            return peer.say(&failure(Kind::Checkpoint, said)).await;
        }
    }
    let started = match here.harness {
        None => claude_turn(machine, name, &here.place, said).await,
        Some(harness) => acp_turn(machine, name, here, harness, said).await,
    };
    match started {
        Ok(Some(receiver)) => {
            *sub = Some(Sub {
                receiver,
                seen: None,
            });
            true
        }
        Ok(None) => true,
        Err(refusal) => peer.say(&refusal).await,
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
    match connect(machine, name, &place, harness, None).await {
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
            Err(refusal)
        }
    }
}

/// Starts a Claude turn in a new keeper and subscribes the socket to it.
async fn claude_turn<M: Machine>(
    machine: &Arc<M>,
    name: &str,
    place: &Place,
    Typed { text, images, mode }: Typed<'_>,
) -> Result<Option<broadcast::Receiver<Sent>>, Failure> {
    // The last turn's keeper may still be exiting; its turn has ended.
    let deadline = tokio::time::Instant::now() + STOP_GRACE + STOP_GRACE;
    while let Some(live) = machine.registry().live(&place.id)
        && !live.busy()
        && tokio::time::Instant::now() < deadline
    {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let Some(mut claim) = Claim::take(machine, place) else {
        return Err(busy());
    };
    let started = machine.start(place, &text, images, mode).await;
    let KeptTurn { turn, events, run } = match started {
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
    let receiver = live.subscribe().map(|(_, _, receiver)| receiver);
    if !machine.registry().insert(&live) {
        return Err(busy());
    }
    claim.started = false;
    drop(claim);
    tracing::info!("chat {name}: a turn started");
    live.publish(&delta(place, StreamKind::UserText, text, &live.run), None);
    tokio::spawn(keep_claude(
        Arc::clone(machine),
        name.to_owned(),
        place.clone(),
        live,
        commands,
        ClaudeTurn {
            turn,
            events,
            mode,
            completed: false,
        },
    ));
    Ok(receiver)
}

/// Sends a turn to the thread's ACP keeper, starting a keeper that loads the
/// session when the last one has gone.
async fn acp_turn<M: Machine>(
    machine: &Arc<M>,
    name: &str,
    here: &Here,
    harness: Harness,
    Typed { text, mode, .. }: Typed<'_>,
) -> Result<Option<broadcast::Receiver<Sent>>, Failure> {
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
        Some(live) => live,
        None => {
            let (_, receiver) =
                connect(machine, name, &here.place, harness, here.session.clone()).await?;
            subscribed = Some(receiver);
            machine
                .registry()
                .live(&here.place.id)
                .ok_or_else(|| failure(Kind::Unreachable, "the agent went away"))?
        }
    };
    {
        let mut state = live.lock();
        if state.busy || state.closing {
            return Err(busy());
        }
        state.busy = true;
    }
    if let Err(said) = machine.write_mode(&here.place, mode).await {
        tracing::warn!("chat {name}: the mode was not written: {said}");
    }
    tracing::info!("chat {name}: a turn started");
    live.command(Command::Turn { text, mode });
    Ok(subscribed)
}

/// Starts `harness` in a keeper in the thread's worktree, and loads `session`
/// or makes one and keeps it. A keeper already there is read back instead.
/// Returns the session and a subscription taken before any event is sent.
async fn connect<M: Machine>(
    machine: &Arc<M>,
    name: &str,
    place: &Place,
    harness: Harness,
    session: Option<String>,
) -> Result<(String, broadcast::Receiver<Sent>), Failure> {
    let Some(mut claim) = Claim::wait(machine, place).await? else {
        return Ok((
            session.unwrap_or_default(),
            subscribed(machine.as_ref(), place)?,
        ));
    };
    let started = tokio::time::timeout(
        CONNECT_WITHIN,
        start_session(machine, name, place, harness, session, &mut claim),
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
    claim: &mut Claim<M>,
) -> Result<(String, broadcast::Receiver<Sent>), Failure> {
    match machine.start_acp(place, harness).await {
        Ok(Started::Running(kept)) => {
            claim.started = true;
            run_session(machine, name, place, harness, session, kept, claim).await
        }
        Ok(Started::Busy) => {
            adopt_claimed(machine, name, place.clone(), claim).await?;
            Ok((
                session.unwrap_or_default(),
                subscribed(machine.as_ref(), place)?,
            ))
        }
        Err(said) => Err(failure(Kind::Unreachable, said)),
    }
}

/// A subscription to the thread's live keeper.
fn subscribed<M: Machine>(
    machine: &M,
    place: &Place,
) -> Result<broadcast::Receiver<Sent>, Failure> {
    machine
        .registry()
        .live(&place.id)
        .and_then(|live| live.subscribe())
        .map(|(_, _, receiver)| receiver)
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
            machine
                .remember(place, harness, &session)
                .await
                .map_err(|said| failure(Kind::Unreachable, said))?;
            session
        }
    };
    Ok((session, login))
}

/// A Claude turn a keeper holds.
struct ClaudeTurn {
    turn: Turn,
    events: Events,
    mode: PermissionMode,
    /// An adopted turn whose `result` was already in `out`.
    completed: bool,
}

/// Reads one Claude keeper until its turn ends, then keeps the checkpoint,
/// removes the keeper's session and lets the thread go.
async fn keep_claude<M: Machine>(
    machine: Arc<M>,
    name: String,
    place: Place,
    live: Arc<Live>,
    mut commands: mpsc::UnboundedReceiver<Command>,
    ClaudeTurn {
        turn,
        mut events,
        mode,
        completed,
    }: ClaudeTurn,
) {
    let thread = thread::name(&place).to_owned();
    let mut kill_at: Option<tokio::time::Instant> = None;
    // The turn is held to the end: its writer closes stdin after `result`, and
    // that close is what lets claude exit.
    let mut failed = None;
    while !completed && failed.is_none() {
        tokio::select! {
            command = commands.recv() => match command {
                Some(Command::Answer { request, decision, reply }) => {
                    let _ = reply.send(turn.answer(&request, decision).map_err(|error| chain(&error)));
                }
                Some(Command::Cancel) => {
                    turn.cancel();
                    kill_at.get_or_insert(tokio::time::Instant::now() + STOP_GRACE);
                }
                Some(Command::Turn { .. }) | None => {}
            },
            event = events.recv() => {
                let Some(event) = event else {
                    failed = Some(true);
                    break;
                };
                if let Event::RequestOpened(opened) = &event.event {
                    if let Some(decision) = claude::answers(mode, opened.scope) {
                        match turn.answer(&opened.request_id, decision) {
                            Ok(()) => continue,
                            Err(error) => tracing::warn!("chat {name}: {mode:?} could not answer: {error}"),
                        }
                    }
                    if !live.watched() {
                        machine.registry().wait(&name, &thread);
                    }
                }
                live.event(&event);
                if let Event::TurnCompleted(done) = &event.event {
                    tracing::info!("chat {name}: the turn ended {:?}", done.state);
                    let lost = done.state == TurnState::Failed;
                    if let Some(said) = done.message.as_ref().filter(|said| {
                        lost && said.starts_with(CLAUDE_NOT_LOGGED_IN)
                    }) {
                        live.publish(&not_logged_in(None, machine.machine(), said.clone()), None);
                    }
                    failed = Some(lost);
                }
            },
            () = until(kill_at) => {
                tracing::info!("chat {name}: the turn did not stop, so its keeper is killed");
                kill_at = None;
                if let Err(said) = machine.finish(&place, Duration::ZERO).await {
                    tracing::warn!("chat {name}: {said}");
                }
            },
        }
    }
    live.set_busy(false);
    checkpointed(
        machine.as_ref(),
        &name,
        &place,
        failed.unwrap_or(false),
        &live,
    )
    .await;
    finish(machine.as_ref(), &name, &place, &live).await;
    drop(turn);
}

async fn until(at: Option<tokio::time::Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// Removes an ended keeper's session (I-30) and lets its thread go.
async fn finish<M: Machine>(machine: &M, name: &str, place: &Place, live: &Live) {
    live.lock().closing = true;
    match machine.finish(place, STOP_GRACE).await {
        Ok(Some(ended)) => tracing::info!("chat {name}: the keeper ended {ended}"),
        Ok(None) => {}
        Err(said) => tracing::warn!("chat {name}: the keeper's session stays: {said}"),
    }
    machine.registry().forget(live);
    live.close();
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
            Step::Command(Some(Command::Turn { text, mode })) => {
                acp.mode = mode;
                let n = {
                    let mut state = live.lock();
                    state.prompts += 1;
                    state.prompts
                };
                let item = format!("{}:{n}", live.run);
                live.publish(
                    &delta(&place, StreamKind::UserText, text.clone(), &item),
                    None,
                );
                let agent = Arc::clone(&acp.agent);
                let session = acp.session.clone();
                acp.prompt = Some(Box::pin(async move { agent.prompt(&session, &text).await }));
            }
            Step::Command(Some(Command::Answer {
                request,
                decision,
                reply,
            })) => {
                let _ = reply.send(answer(&acp, &request, decision));
            }
            Step::Command(Some(Command::Cancel)) => {
                if live.busy() {
                    // An agent that is gone has no turn left to stop.
                    let _ = acp.agent.cancel(&acp.session);
                    kill_at.get_or_insert(tokio::time::Instant::now() + STOP_GRACE);
                }
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
                            machine.registry().wait(&name, &thread);
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
                quiet_since = tokio::time::Instant::now();
            }
            Step::Kill => {
                kill_at = None;
                if live.busy() {
                    tracing::info!("chat {name}: the turn did not stop, so its keeper is killed");
                    if let Err(said) = machine.finish(&place, Duration::ZERO).await {
                        tracing::warn!("chat {name}: {said}");
                    }
                }
            }
            Step::Idle => {
                if !live.busy() && !live.watched() && quiet_since.elapsed() >= IDLE {
                    tracing::info!("chat {name}: the thread is idle, so its agent stops");
                    if let Err(said) = machine.close_stdin(&place).await {
                        tracing::warn!("chat {name}: {said}");
                    }
                    quiet_since = tokio::time::Instant::now();
                }
            }
        }
    }
    tracing::info!("chat {name}: the agent ended");
    finish(machine.as_ref(), &name, &place, &live).await;
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
    live.set_busy(false);
    checkpointed(machine, name, place, failed, live).await;
    if let Ok(size) = machine.out_size(place).await
        && size > Limits::default().cap / 2
    {
        tracing::info!("chat {name}: the keeper's out is past half its cap, so it is replaced");
        if let Err(said) = machine.close_stdin(place).await {
            tracing::warn!("chat {name}: {said}");
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

/// Reads back the keeper of the thread `thread` in workspace `workspace`,
/// which no task of this daemon holds (ADR-0035 decision 9). The refresh pass
/// calls it for each keeper session it finds.
pub async fn adopt(registry: &Registry, workspace: &str, thread: &str) {
    if registry.holds(&Keeper::new(workspace, thread).session()) {
        return;
    }
    let adopted = async {
        let fleet = Arc::new(Fleet::of(workspace, registry.clone())?);
        let place = fleet
            .find(thread)
            .await?
            .ok_or_else(|| format!("{workspace} has no chat thread {thread}"))?;
        // A pass never waits: a task that holds the thread reads its keeper.
        let Some(claim) = Claim::take(&fleet, &place) else {
            return Ok(());
        };
        adopt_claimed(&fleet, workspace, place, &claim)
            .await
            .map_err(|refusal| refusal.said)
    }
    .await;
    if let Err(said) = adopted {
        tracing::warn!("chat {workspace}: keeper {thread} was not adopted: {said}");
    }
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
    let kept = machine.recall(&place).await.map_err(unreachable)?;
    let harness = kept.as_ref().map(|(harness, _)| *harness);
    let Some(adopted) = machine.adopt(&place, harness).await.map_err(unreachable)? else {
        return Ok(());
    };
    let thread = thread::name(&place).to_owned();
    match adopted {
        Adopted::Claude {
            turn,
            events,
            run,
            replayed,
            mode,
            completed,
        } => {
            let (live, commands) = Live::new(&place, run, !completed);
            live.lock().last = last_cursor(&replayed);
            if !machine.registry().insert(&live) {
                return Ok(());
            }
            tracing::info!("chat {name}: adopted the keeper of thread {thread}");
            if !completed {
                for (request, scope, _) in waiting(&replayed) {
                    match claude::answers(mode, scope) {
                        Some(decision) => {
                            if let Err(error) = turn.answer(&request, decision) {
                                tracing::warn!("chat {name}: {mode:?} could not answer: {error}");
                            }
                        }
                        None => machine.registry().wait(name, &thread),
                    }
                }
            }
            tokio::spawn(keep_claude(
                Arc::clone(machine),
                name.to_owned(),
                place,
                live,
                commands,
                ClaudeTurn {
                    turn,
                    events,
                    mode,
                    completed,
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
                    None => machine.registry().wait(name, &thread),
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
        Item, ItemStatus, ItemType, RequestOpened, RequestResolved, RequestType, Scope, TokenUsage,
        TurnCompleted,
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
                }),
                frame(Frame::Turn {
                    text: "and the docs".to_owned(),
                    harness: None,
                    mode: PermissionMode::Supervised,
                }),
                frame(Frame::Answer {
                    request_id: "r1".to_owned(),
                    decision: Decision::AcceptAlways,
                }),
                frame(Frame::Cancel),
                frame(Frame::Revert { turn: 0 }),
                frame(Frame::Diff),
            ]),
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
        /// The permission mode each Claude turn was started with.
        modes: Mutex<Vec<PermissionMode>>,
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
        /// Holds a Claude start after its keeper exists, until notified.
        start_gate: Option<Arc<tokio::sync::Notify>>,
        /// How many keepers were read back.
        adopted: Mutex<usize>,
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

        async fn open(&self, _: &str) -> Result<Place, String> {
            if self.unreachable {
                return Err("ssh: connect to host m port 22: Connection refused".to_owned());
            }
            *lock(&self.opened) += 1;
            Ok(place())
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
            text: &str,
            images: Option<&str>,
            mode: PermissionMode,
        ) -> Result<Started<KeptTurn>, String> {
            let Some((run, reader, writer, end)) = self.begin(Some(mode)) else {
                return Ok(Started::Busy);
            };
            lock(&self.started_with).push(images.map(str::to_owned));
            lock(&self.modes).push(mode);
            lock(&self.turns).push(Claude(end));
            if let Some(gate) = &self.start_gate {
                gate.notified().await;
            }
            let (turn, events) =
                Turn::kept(reader, writer, thread::name(place), &run, text, said());
            Ok(Started::Running(KeptTurn { turn, events, run }))
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

        async fn start_acp(
            &self,
            _: &Place,
            harness: Harness,
        ) -> Result<Started<KeptAgent>, String> {
            if self.start_acp_fails {
                return Err("ssh: could not start the agent".to_owned());
            }
            let Some((run, reader, writer, end)) = self.begin(None) else {
                return Ok(Started::Busy);
            };
            lock(&self.agents).push(Acp(end));
            let (agent, events) = Agent::kept(harness, reader, writer, &run, said());
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
                    let (events, completed) = (replayed.events.clone(), replayed.completed());
                    let (turn, live) = Turn::resume(reader, writer, replayed, said());
                    Adopted::Claude {
                        turn,
                        events: live,
                        run,
                        replayed: events,
                        mode,
                        completed,
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

        async fn close_stdin(&self, _: &Place) -> Result<(), String> {
            *lock(&self.stdin_closed) += 1;
            if let Some(keep) = lock(&self.keep).as_ref() {
                keep.stdin.send_replace(true);
            }
            Ok(())
        }

        async fn out_size(&self, _: &Place) -> Result<u64, String> {
            Ok(self.journal().out.len() as u64)
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
        let (send, from) = mpsc::unbounded_channel();
        let (to, heard) = mpsc::unbounded_channel();
        let query = ChatQuery {
            thread: thread.map(str::to_owned),
            after: after.map(str::to_owned),
        };
        let served = tokio::spawn(async move {
            converse(script, "web", query, &mut Browser { from, to }).await;
        });
        (
            Tab {
                send: Some(send),
                heard,
            },
            served,
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
                {"streamKind": "user_text", "delta": "run the tests", "itemId": "user:1"}})
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

    #[tokio::test]
    async fn every_frame_the_browser_sends_parses() {
        for (text, frame) in [
            (
                r#"{"type":"turn","text":"hi"}"#,
                Frame::Turn {
                    text: "hi".to_owned(),
                    harness: None,
                    mode: PermissionMode::Supervised,
                },
            ),
            (
                r#"{"type":"turn","text":"hi","harness":"codex","mode":"full-access"}"#,
                Frame::Turn {
                    text: "hi".to_owned(),
                    harness: Some("codex".to_owned()),
                    mode: PermissionMode::FullAccess,
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
        assert_eq!(
            claude.heard().await,
            None,
            "no interrupt: stdin closes after the result"
        );
        until_script(&script, |script| !lock(&script.finished).is_empty()).await;
        assert_eq!(*lock(&script.finished), [STOP_GRACE]);
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
            router(Authoriser::new(fake, &[]), Registry::default()),
        );
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
    /// The daemon ends a socket it chose to end with a close frame, so the
    /// browser does not take it for a network that dropped.
    #[tokio::test]
    async fn a_socket_the_daemon_ends_gets_a_close_frame() {
        use crate::terminal::tests::{TEXT, connect_to, frame, tailnet};
        let api = router(
            Authoriser::new(tailnet(vec![(LOCAL, caller(ME, &[]))]), &[]),
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

    /// A Claude turn on a new thread, from the prompt to `turn.completed`.
    async fn a_claude_turn_that_ends(script: &Arc<Script>) -> (Tab, Claude) {
        let (mut tab, _served) = connect(Arc::clone(script), None);
        tab.send(json!({"type": "turn", "text": "fix the test"}));
        assert_eq!(tab.next().await["type"], "thread.started");
        assert_eq!(tab.next().await["payload"]["itemId"], "user:1");
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
        assert!(back.quiet().await, "once");
        back.send(json!({"type": "revert", "turn": 0}));
        assert_eq!(back.next().await["type"], "thread.reverted");
        back.close();

        let (mut again, _c) = connect_after(Arc::clone(&script), Some(THREAD), Some(&cursor));
        assert_eq!(again.next().await["type"], "thread.started");
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
            json!({"streamKind": "user_text", "delta": "fix the test", "itemId": "user:1"}),
            "the running turn's prompt"
        );
        let said = second
            .next_after(json!({"type": "revert", "turn": 0}))
            .await;
        assert_eq!(said["kind"], "busy", "{said}");
        let said = second
            .next_after(json!({"type": "turn", "text": "and the docs"}))
            .await;
        assert_eq!(said["kind"], "busy", "{said}");
        assert!(script.reverted.lock().expect("a lock").is_empty());

        claude
            .say(
                json!({"type": "result", "subtype": "success", "is_error": false,
                        "stop_reason": "end_turn"}),
            )
            .await;
        assert_eq!(first.next().await["type"], "turn.completed");
        assert_eq!(first.next().await["type"], "turn.diff.updated");
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
    async fn branch_diff_that_fails_is_a_checkpoint_failure_in_gits_words() {
        let script = Arc::new(Script {
            threads: vec![place()],
            branch_fails: true,
            ..Script::default()
        });
        let (mut tab, _served) = connect(Arc::clone(&script), Some(THREAD));
        tab.next().await;
        assert_eq!(
            tab.next_after(json!({"type": "diff"})).await,
            json!({"type": "error", "kind": "checkpoint",
                   "said": "git: fatal: the branch has no merge-base with HEAD"})
        );
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
        let (mut tab, _served) = connect(Arc::clone(script), None);
        let mut turn = json!({"type": "turn", "text": "fix it"});
        if let Some(mode) = mode {
            turn["mode"] = json!(mode);
        }
        tab.send(turn);
        assert_eq!(tab.next().await["type"], "thread.started");
        assert_eq!(tab.next().await["payload"]["itemId"], "user:1");
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
        assert_eq!(first.next().await["payload"]["itemId"], "user:1");
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
        assert_eq!(first.next().await["payload"]["itemId"], "user:1");
        assert_eq!(second.next().await["type"], "thread.started");
        assert_eq!(
            second.next().await["payload"]["delta"],
            "Run touch made.txt"
        );

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
        assert_eq!(claude.heard().await, None, "and no other");
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
        let wait = Wait {
            workspace: "web".to_owned(),
            thread: THREAD.to_owned(),
        };
        assert_eq!(heard.recv().await, Some(wait.clone()));
        assert_eq!(
            wait.message().body,
            "web: chat thread 1a2b3c4d waits for an answer"
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

    /// Only `cancel` stops a turn: it interrupts, and a turn that does not
    /// end within 10 s has its keeper killed.
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
        assert_eq!(claude.heard().await, None, "stdin closes");
        tokio::time::sleep(STOP_GRACE + Duration::from_secs(1)).await;
        let ended = tab.next().await;
        assert_eq!(ended["payload"]["state"], "cancelled", "{ended}");
        assert_eq!(*lock(&script.finished), [Duration::ZERO, STOP_GRACE]);
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
}
