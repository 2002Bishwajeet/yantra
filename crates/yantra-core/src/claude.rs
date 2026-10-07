//! A chat turn with Claude Code over its `stream-json` (ADR-0026 decision 2),
//! as [`chat`] events.
//!
//! **This is the one module that knows stream-json's shapes**, as
//! [`crate::acp`] is for ACP v1. A turn is one `claude -p` over `ssh`, in a
//! thread's worktree ([`crate::thread`]). `--resume` continues the conversation
//! that the newest transcript there holds, so the daemon remembers nothing
//! between turns.
//!
//! Measured on claude 2.1.291 (R20): with `--permission-prompt-tool stdio` a
//! permission arrives on stdout as a `control_request`, and the answer on stdin
//! runs or refuses the tool. The process exits once stdin closes after
//! `result`. No prompt, output or file content is ever logged.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::chat::{self, Event, ThreadEvent};
use crate::delegate::Place;
use crate::ssh::{self, Ssh};
use crate::tmux::sq;
use crate::{acp, agent, logs, thread};

/// How long a closed stdout waits for stderr's last words.
const STDERR_GRACE: Duration = Duration::from_secs(5);
/// How much of a tool's output reaches the browser, in characters.
const OUTPUT: usize = 4000;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    #[error("the turn has ended, so it takes no more answers")]
    Ended,

    #[error("no permission request `{0}` is waiting for an answer")]
    NotPending(String),
}

/// Every event of the turn, in order, ending with `turn.completed`.
pub type Events = mpsc::UnboundedReceiver<ThreadEvent>;

/// One running `claude -p`. Dropping it kills the local `ssh` and leaves the
/// remote `claude` to end when its stdin closes (I-27); [`Turn::cancel`] is
/// what ends it on purpose.
#[derive(Debug)]
pub struct Turn {
    shared: Arc<Shared>,
    tasks: [JoinHandle<()>; 2],
    // Held for `kill_on_drop`.
    _child: Option<tokio::process::Child>,
}

impl Drop for Turn {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl Turn {
    /// Sends `text` to Claude in the thread's worktree on the machine `ssh`
    /// reaches. `images` is the directory the chat's images landed in, which
    /// Claude may then read without asking.
    pub fn start(
        ssh: &Ssh,
        place: &Place,
        text: &str,
        images: Option<&str>,
        mode: chat::PermissionMode,
    ) -> Result<(Self, Events), Error> {
        let ssh::Piped {
            child,
            stdin,
            stdout,
            stderr,
            log,
        } = ssh.stdio(&command(&place.worktree, images, mode))?;
        let diagnosis = acp::diagnosis(stderr, log);
        let (turn, events) = Self::wire(
            stdout,
            stdin,
            thread::name(place),
            Some(diagnosis),
            Some(child),
        );
        turn.shared.send(&prompt(text))?;
        Ok((turn, events))
    }

    /// The generic half: a turn on any pair of streams.
    pub fn over<R, W>(reader: R, writer: W, thread: &str, text: &str) -> (Self, Events)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (turn, events) = Self::wire(reader, writer, thread, None, None);
        // The writer is fresh, so the line is queued.
        let _ = turn.shared.send(&prompt(text));
        (turn, events)
    }

    fn wire<R, W>(
        reader: R,
        writer: W,
        thread: &str,
        stderr: Option<JoinHandle<String>>,
        child: Option<tokio::process::Child>,
    ) -> (Self, Events)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (out, lines) = mpsc::unbounded_channel();
        let (events, received) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            thread: thread.to_owned(),
            out: Mutex::new(Some(out)),
            events,
            state: Mutex::default(),
        });
        let tasks = [
            tokio::spawn(read(reader, stderr, Arc::clone(&shared))),
            tokio::spawn(write(writer, lines)),
        ];
        (
            Self {
                shared,
                tasks,
                _child: child,
            },
            received,
        )
    }

    /// Answers the permission request `request` and runs or refuses its tool.
    pub fn answer(&self, request: &str, decision: chat::Decision) -> Result<(), Error> {
        let pending = self
            .shared
            .lock()
            .pending
            .remove(request)
            .ok_or_else(|| Error::NotPending(request.to_owned()))?;
        self.shared.resolve(request, pending, decision)
    }

    /// Refuses whatever is waiting, asks Claude to stop, and closes stdin so the
    /// remote process ends by itself.
    pub fn cancel(&self) {
        let waiting: Vec<(String, Pending)> = {
            let mut state = self.shared.lock();
            state.cancelled = true;
            state.pending.drain().collect()
        };
        for (request, pending) in waiting {
            let _ = self
                .shared
                .resolve(&request, pending, chat::Decision::Cancel);
        }
        let _ = self.shared.send(&json!({
            "type": "control_request",
            "request_id": "yantra-interrupt",
            "request": {"subtype": "interrupt"},
        }));
        self.shared.close();
    }
}

/// `cd` because `claude` has no cwd flag, and the transcript directory is
/// derived from the cwd. `claude` is searched for as I-34 requires, and a musl
/// machine gets the ripgrep variable `agent::launch_command` gives the TUI.
/// `--add-dir` lets Claude read the chat's images without a prompt (Y-424).
/// `Auto` and `AutoAcceptEdits` run in Claude's own mode (Y-453); see [`answers`].
fn command(worktree: &str, images: Option<&str>, mode: chat::PermissionMode) -> String {
    format!(
        "cd {worktree} || exit 1\n\
         c=$({probe}) || {{ echo 'claude was not found on PATH or in any of: {searched}' >&2; exit 127; }}\n\
         ls /lib/ld-musl-* >/dev/null 2>&1 && export USE_BUILTIN_RIPGREP=0\n\
         {newest}\
         [ -n \"$f\" ] && set -- --resume \"$(basename \"$f\" .jsonl)\"\n\
         exec \"$c\" {add}{mode}-p --input-format stream-json --output-format stream-json --verbose \
         --include-partial-messages --permission-prompt-tool stdio \"$@\"\n",
        worktree = sq(worktree),
        add = images.map_or_else(String::new, |dir| format!("--add-dir {} ", sq(dir))),
        mode = flag(mode).map_or_else(String::new, |flag| format!("--permission-mode {flag} ")),
        probe = agent::probe("claude"),
        searched = agent::CANDIDATES.join(", "),
        newest = logs::newest(worktree),
    )
}

/// T3 Code maps the same two modes to Claude's own (`ClaudeAdapter.ts`).
fn flag(mode: chat::PermissionMode) -> Option<&'static str> {
    match mode {
        chat::PermissionMode::Auto => Some("auto"),
        chat::PermissionMode::AutoAcceptEdits => Some("acceptEdits"),
        chat::PermissionMode::Supervised | chat::PermissionMode::FullAccess => None,
    }
}

/// The daemon's answer to a Claude request in `mode`. In a mode Claude runs
/// itself, a request that reaches the daemon is one Claude still asks about,
/// such as an edit outside the worktree, so the person sees it.
#[must_use]
pub fn answers(mode: chat::PermissionMode, request: chat::RequestType) -> Option<chat::Decision> {
    if flag(mode).is_some() {
        None
    } else {
        mode.answers(request)
    }
}

fn prompt(text: &str) -> Value {
    json!({
        "type": "user",
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    })
}

#[derive(Debug, Default)]
struct State {
    pending: HashMap<String, Pending>,
    /// The assistant message the deltas belong to.
    message: Option<String>,
    /// The context the last assistant message was sent with, in tokens.
    used: Option<u64>,
    cancelled: bool,
    completed: bool,
}

/// A `can_use_tool` request Claude is waiting on.
#[derive(Debug)]
struct Pending {
    input: Value,
    suggestions: Vec<Value>,
    request_type: chat::RequestType,
}

#[derive(Debug)]
struct Shared {
    thread: String,
    /// `None` once stdin is closed.
    out: Mutex<Option<mpsc::UnboundedSender<String>>>,
    events: mpsc::UnboundedSender<ThreadEvent>,
    state: Mutex<State>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn emit(&self, event: Event) {
        // Nobody listening is not this turn's failure.
        let _ = self.events.send(ThreadEvent {
            thread_id: self.thread.clone(),
            event,
        });
    }

    fn send(&self, line: &Value) -> Result<(), Error> {
        self.out
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .ok_or(Error::Ended)?
            .send(line.to_string())
            .map_err(|_| Error::Ended)
    }

    fn close(&self) {
        self.out
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }

    fn resolve(
        &self,
        request: &str,
        pending: Pending,
        decision: chat::Decision,
    ) -> Result<(), Error> {
        let response = match decision {
            chat::Decision::Accept => json!({"behavior": "allow", "updatedInput": pending.input}),
            chat::Decision::AcceptAlways => json!({
                "behavior": "allow",
                "updatedInput": pending.input,
                "updatedPermissions": for_this_session(pending.suggestions),
            }),
            chat::Decision::Decline | chat::Decision::Cancel => {
                json!({"behavior": "deny", "message": "The person declined in Yantra."})
            }
        };
        self.send(&json!({
            "type": "control_response",
            "response": {"subtype": "success", "request_id": request, "response": response},
        }))?;
        self.emit(Event::RequestResolved(chat::RequestResolved {
            request_id: request.to_owned(),
            request_type: pending.request_type,
            decision,
        }));
        Ok(())
    }

    fn dispatch(&self, line: &[u8]) {
        // A line that is not stream-json is noise, such as a login script's echo.
        let Ok(line) = serde_json::from_slice::<Line>(line) else {
            return;
        };
        match line {
            Line::System { subtype } if subtype == "init" => self.emit(Event::TurnStarted),
            Line::StreamEvent { event } => self.stream(event),
            Line::Assistant { message } => {
                if let Some(usage) = &message.usage {
                    self.lock().used = Some(usage.context());
                }
                for block in message.content.blocks() {
                    if let Block::ToolUse { id, name, input } = block {
                        self.emit(Event::ItemStarted(chat::Item {
                            item_id: id,
                            item_type: Some(item_type(&name)),
                            status: Some(chat::ItemStatus::InProgress),
                            title: logs::target_in(&input),
                            output: None,
                            changes: Vec::new(),
                        }));
                    }
                }
            }
            Line::User { message } => {
                for block in message.content.blocks() {
                    if let Block::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } = block
                    {
                        self.emit(Event::ItemCompleted(chat::Item {
                            item_id: tool_use_id,
                            item_type: None,
                            status: Some(if is_error {
                                chat::ItemStatus::Failed
                            } else {
                                chat::ItemStatus::Completed
                            }),
                            title: None,
                            output: Some(output(&content)),
                            changes: Vec::new(),
                        }));
                    }
                }
            }
            Line::ControlRequest {
                request_id,
                request,
            } => self.ask(request_id, request),
            Line::Result(outcome) => self.finish(*outcome),
            Line::System { .. } | Line::Other => {}
        }
    }

    fn stream(&self, event: StreamEvent) {
        match event {
            StreamEvent::MessageStart { message } => self.lock().message = Some(message.id),
            StreamEvent::ContentBlockDelta { index, delta } => {
                let (stream_kind, delta) = match delta {
                    Delta::Text { text } => (chat::StreamKind::AssistantText, text),
                    Delta::Thinking { thinking } => (chat::StreamKind::ReasoningText, thinking),
                    Delta::Other => return,
                };
                // A redacted thought streams as empty deltas.
                if delta.is_empty() {
                    return;
                }
                let item_id = self
                    .lock()
                    .message
                    .as_ref()
                    .map(|message| format!("{message}:{index}"));
                self.emit(Event::ContentDelta(chat::ContentDelta {
                    stream_kind,
                    delta,
                    item_id,
                }));
            }
            StreamEvent::Other => {}
        }
    }

    fn ask(&self, request_id: String, request: ControlRequest) {
        if request.subtype != "can_use_tool" {
            let _ = self.send(&json!({
                "type": "control_response",
                "response": {"subtype": "error", "request_id": request_id,
                             "error": format!("Yantra does not answer `{}`", request.subtype)},
            }));
            return;
        }
        let tool = request.tool_name.unwrap_or_default();
        let request_type = request_type(&tool);
        let title = logs::target_in(&request.input);
        self.lock().pending.insert(
            request_id.clone(),
            Pending {
                input: request.input,
                suggestions: request.permission_suggestions,
                request_type,
            },
        );
        self.emit(Event::RequestOpened(chat::RequestOpened {
            request_id,
            request_type,
            item_id: request.tool_use_id,
            title,
            detail: request.description,
            options: options(),
        }));
    }

    fn finish(&self, outcome: Outcome) {
        let (cancelled, used) = {
            let mut state = self.lock();
            state.completed = true;
            state.pending.clear();
            (state.cancelled, state.used)
        };
        let max = outcome
            .model_usage
            .values()
            .filter_map(|usage| usage.context_window)
            .max();
        if let (Some(used_tokens), Some(max_tokens)) = (used, max) {
            self.emit(Event::TokenUsageUpdated(chat::TokenUsage {
                used_tokens,
                max_tokens,
            }));
        }
        let completed = if cancelled {
            cancelled_turn()
        } else if outcome.is_error {
            let said = outcome
                .result
                .filter(|result| !result.is_empty())
                .unwrap_or_else(|| outcome.errors.join("\n"));
            chat::TurnCompleted {
                state: chat::TurnState::Failed,
                stop_reason: None,
                message: Some(said),
            }
        } else {
            chat::TurnCompleted {
                state: chat::TurnState::Completed,
                stop_reason: Some(match outcome.stop_reason.as_deref() {
                    Some("max_tokens") => chat::StopReason::MaxTokens,
                    Some("refusal") => chat::StopReason::Refusal,
                    _ => chat::StopReason::EndTurn,
                }),
                message: None,
            }
        };
        self.emit(Event::TurnCompleted(completed));
        self.close();
    }

    /// stdout ended. A turn with no `result` failed, and what `claude` and
    /// `ssh` said last is why.
    fn ended(&self, said: String) {
        let (completed, cancelled) = {
            let state = self.lock();
            (state.completed, state.cancelled)
        };
        self.close();
        if completed {
            return;
        }
        self.emit(Event::TurnCompleted(if cancelled {
            cancelled_turn()
        } else {
            chat::TurnCompleted {
                state: chat::TurnState::Failed,
                stop_reason: None,
                message: Some(if said.is_empty() {
                    "claude ended without a result".to_owned()
                } else {
                    said
                }),
            }
        }));
    }
}

fn cancelled_turn() -> chat::TurnCompleted {
    chat::TurnCompleted {
        state: chat::TurnState::Cancelled,
        stop_reason: Some(chat::StopReason::Cancelled),
        message: None,
    }
}

fn options() -> Vec<chat::RequestOption> {
    [
        ("accept", "Accept", chat::Decision::Accept),
        (
            "accept_always",
            "Accept always",
            chat::Decision::AcceptAlways,
        ),
        ("decline", "Decline", chat::Decision::Decline),
    ]
    .into_iter()
    .map(|(id, label, decision)| chat::RequestOption {
        option_id: id.to_owned(),
        label: label.to_owned(),
        decision,
    })
    .collect()
}

/// Claude's own suggestions, kept for this session only. `setMode` is left
/// out: "accept always" for one command must not accept every edit.
fn for_this_session(suggestions: Vec<Value>) -> Vec<Value> {
    suggestions
        .into_iter()
        .filter(|suggestion| suggestion["type"] != "setMode")
        .map(|mut suggestion| {
            suggestion["destination"] = json!("session");
            suggestion
        })
        .collect()
}

fn item_type(tool: &str) -> chat::ItemType {
    match tool {
        "Bash" => chat::ItemType::CommandExecution,
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => chat::ItemType::FileChange,
        "WebSearch" | "WebFetch" => chat::ItemType::WebSearch,
        _ => chat::ItemType::DynamicToolCall,
    }
}

fn request_type(tool: &str) -> chat::RequestType {
    match tool {
        "Bash" => chat::RequestType::ExecCommandApproval,
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => chat::RequestType::FileChangeApproval,
        "Read" | "Glob" | "Grep" => chat::RequestType::FileReadApproval,
        _ => chat::RequestType::DynamicToolCall,
    }
}

/// A tool result's text, cut to [`OUTPUT`] characters.
fn output(content: &Value) -> String {
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block.get("text")?.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    let mut cut: String = text.chars().take(OUTPUT).collect();
    if text.chars().nth(OUTPUT).is_some() {
        cut.push('…');
    }
    cut
}

async fn read<R: AsyncRead + Unpin>(
    reader: R,
    stderr: Option<JoinHandle<String>>,
    shared: Arc<Shared>,
) {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => shared.dispatch(&line),
        }
    }
    let said = match stderr {
        Some(task) => tokio::time::timeout(STDERR_GRACE, task)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default(),
        None => String::new(),
    };
    shared.ended(said);
}

/// Ends when every sender is gone, which drops stdin and is Claude's EOF.
async fn write<W: AsyncWrite + Unpin>(mut writer: W, mut lines: mpsc::UnboundedReceiver<String>) {
    while let Some(mut line) = lines.recv().await {
        line.push('\n');
        if writer.write_all(line.as_bytes()).await.is_err() || writer.flush().await.is_err() {
            return;
        }
    }
    let _ = writer.shutdown().await;
}

// The stream-json shapes. Only the fields acted on are named; a tool's input is
// read for its target alone.

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Line {
    System {
        #[serde(default)]
        subtype: String,
    },
    StreamEvent {
        event: StreamEvent,
    },
    Assistant {
        message: Message,
    },
    User {
        message: Message,
    },
    ControlRequest {
        request_id: String,
        request: ControlRequest,
    },
    Result(Box<Outcome>),
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum StreamEvent {
    MessageStart {
        message: Started,
    },
    ContentBlockDelta {
        index: u64,
        delta: Delta,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct Started {
    id: String,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Delta {
    #[serde(rename = "text_delta")]
    Text { text: String },
    #[serde(rename = "thinking_delta")]
    Thinking { thinking: String },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    content: Content,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Content {
    Blocks(Vec<Block>),
    // A typed prompt is a bare string, and it carries no tool.
    Text(#[allow(dead_code)] String),
}

impl Default for Content {
    fn default() -> Self {
        Self::Blocks(Vec::new())
    }
}

impl Content {
    fn blocks(self) -> Vec<Block> {
        match self {
            Self::Blocks(blocks) => blocks,
            Self::Text(_) => Vec::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Block {
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: Value,
        #[serde(default)]
        is_error: bool,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
}

impl Usage {
    fn context(&self) -> u64 {
        self.input_tokens
            + self.cache_creation_input_tokens
            + self.cache_read_input_tokens
            + self.output_tokens
    }
}

#[derive(Deserialize)]
struct ControlRequest {
    subtype: String,
    tool_name: Option<String>,
    #[serde(default)]
    input: Value,
    description: Option<String>,
    #[serde(default)]
    permission_suggestions: Vec<Value>,
    tool_use_id: Option<String>,
}

#[derive(Deserialize)]
struct Outcome {
    #[serde(default)]
    is_error: bool,
    result: Option<String>,
    stop_reason: Option<String>,
    #[serde(default)]
    errors: Vec<String>,
    #[serde(rename = "modelUsage", default)]
    model_usage: HashMap<String, ModelUsage>,
}

#[derive(Deserialize)]
struct ModelUsage {
    #[serde(rename = "contextWindow")]
    context_window: Option<u64>,
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use chat::{
        ContentDelta, Decision, Item, ItemStatus, ItemType, PermissionMode, RequestOpened,
        RequestResolved, RequestType, StopReason, StreamKind, TokenUsage, TurnCompleted, TurnState,
    };
    use tokio::io::{DuplexStream, ReadHalf, WriteHalf};

    const ACCEPT: &str = include_str!("../tests/recordings/claude-2.1.291-accept.jsonl");
    const DECLINE: &str = include_str!("../tests/recordings/claude-2.1.291-decline.jsonl");
    const INTERRUPT: &str = include_str!("../tests/recordings/claude-2.1.291-interrupt.jsonl");
    const NOT_LOGGED_IN: &str =
        include_str!("../tests/recordings/claude-2.1.291-not-logged-in.jsonl");

    const THREAD: &str = "11111111";
    const TOOL: &str = "toolu_01Q6EvdCE9kmjKPWys5J1s9S";
    const REQUEST: &str = "753d160f-0942-4e84-8132-00f27cf1ce2b";

    /// Claude's end of the pipe, scripted by the test.
    struct Fake {
        from_turn: BufReader<ReadHalf<DuplexStream>>,
        to_turn: WriteHalf<DuplexStream>,
    }

    impl Fake {
        async fn receive(&mut self) -> Option<Value> {
            let mut line = String::new();
            let read =
                tokio::time::timeout(Duration::from_secs(5), self.from_turn.read_line(&mut line))
                    .await
                    .expect("the turn writes or closes within 5 s")
                    .expect("the pipe reads");
            (read > 0).then(|| serde_json::from_str(&line).expect("one JSON value per line"))
        }

        async fn play(&mut self, recording: &str) {
            self.to_turn
                .write_all(recording.as_bytes())
                .await
                .expect("the pipe writes");
        }
    }

    fn pair(stderr: Option<JoinHandle<String>>) -> (Turn, Events, Fake) {
        let (ours, theirs) = tokio::io::duplex(1 << 20);
        let (our_read, our_write) = tokio::io::split(ours);
        let (their_read, their_write) = tokio::io::split(theirs);
        let (turn, events) = Turn::wire(our_read, our_write, THREAD, stderr, None);
        let _ = turn.shared.send(&prompt("Run touch made.txt"));
        let fake = Fake {
            from_turn: BufReader::new(their_read),
            to_turn: their_write,
        };
        (turn, events, fake)
    }

    /// Every event up to and including `turn.completed`.
    async fn until_completed(events: &mut Events) -> Vec<Event> {
        let mut seen = Vec::new();
        loop {
            let next = tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .expect("an event within 5 s")
                .expect("the channel is open");
            assert_eq!(next.thread_id, THREAD);
            let done = matches!(next.event, Event::TurnCompleted(_));
            seen.push(next.event);
            if done {
                return seen;
            }
        }
    }

    #[tokio::test]
    async fn a_turn_writes_one_user_line_and_maps_the_recorded_stream() {
        let (turn, mut events, mut fake) = pair(None);
        assert_eq!(
            fake.receive().await,
            Some(json!({"type": "user", "message": {"role": "user",
                "content": [{"type": "text", "text": "Run touch made.txt"}]}}))
        );
        fake.play(ACCEPT).await;
        let seen = until_completed(&mut events).await;

        assert_eq!(seen[0], Event::TurnStarted);
        assert!(seen.contains(&Event::ItemStarted(Item {
            item_id: TOOL.to_owned(),
            item_type: Some(ItemType::CommandExecution),
            status: Some(ItemStatus::InProgress),
            title: Some("touch made.txt".to_owned()),
            output: None,
            changes: vec![],
        })));
        assert!(seen.contains(&Event::RequestOpened(RequestOpened {
            request_id: REQUEST.to_owned(),
            request_type: RequestType::ExecCommandApproval,
            item_id: Some(TOOL.to_owned()),
            title: Some("touch made.txt".to_owned()),
            detail: Some("Create a file named made.txt".to_owned()),
            options: options(),
        })));
        assert!(seen.contains(&Event::ItemCompleted(Item {
            item_id: TOOL.to_owned(),
            item_type: None,
            status: Some(ItemStatus::Completed),
            title: None,
            output: Some("(Bash completed with no output)".to_owned()),
            changes: vec![],
        })));
        assert!(seen.contains(&Event::ContentDelta(ContentDelta {
            stream_kind: StreamKind::AssistantText,
            delta: "done".to_owned(),
            item_id: Some("msg_011CfmKAToCdENVBU4pNDeSd:1".to_owned()),
        })));
        // The redacted thoughts stream as empty deltas, and none is drawn.
        assert!(!seen.iter().any(|event| matches!(event,
            Event::ContentDelta(delta) if delta.stream_kind == StreamKind::ReasoningText)));
        let n = seen.len();
        assert_eq!(
            seen[n - 2],
            Event::TokenUsageUpdated(TokenUsage {
                used_tokens: 8 + 207 + 28_058 + 2,
                max_tokens: 200_000,
            })
        );
        assert_eq!(
            seen[n - 1],
            Event::TurnCompleted(TurnCompleted {
                state: TurnState::Completed,
                stop_reason: Some(StopReason::EndTurn),
                message: None,
            })
        );
        // `result` closes stdin, which is what lets claude exit.
        assert_eq!(fake.receive().await, None);
        assert!(matches!(
            turn.answer(REQUEST, Decision::Accept),
            Err(Error::NotPending(_))
        ));
    }

    /// The request's lines alone, so the answer is written before the result.
    fn up_to_the_request(recording: &str) -> String {
        recording
            .lines()
            .take_while(|line| !line.contains("\"type\":\"control_request\""))
            .chain(
                recording
                    .lines()
                    .filter(|line| line.contains("\"type\":\"control_request\"")),
            )
            .map(|line| format!("{line}\n"))
            .collect()
    }

    async fn opened(events: &mut Events) -> RequestOpened {
        loop {
            let next = tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .expect("an event within 5 s")
                .expect("the channel is open");
            if let Event::RequestOpened(opened) = next.event {
                return opened;
            }
        }
    }

    #[tokio::test]
    async fn accept_runs_the_tool_with_its_own_input() {
        let (turn, mut events, mut fake) = pair(None);
        fake.receive().await;
        fake.play(&up_to_the_request(ACCEPT)).await;
        let asked = opened(&mut events).await;

        turn.answer(&asked.request_id, Decision::Accept)
            .expect("the request is pending");
        assert_eq!(
            fake.receive().await,
            Some(json!({"type": "control_response", "response": {
                "subtype": "success", "request_id": REQUEST,
                "response": {"behavior": "allow", "updatedInput":
                    {"command": "touch made.txt", "description": "Create a file named made.txt"}}}}))
        );
        assert_eq!(
            events.recv().await.expect("an event").event,
            Event::RequestResolved(RequestResolved {
                request_id: REQUEST.to_owned(),
                request_type: RequestType::ExecCommandApproval,
                decision: Decision::Accept,
            })
        );
        assert!(matches!(
            turn.answer(REQUEST, Decision::Accept),
            Err(Error::NotPending(_))
        ));
    }

    #[tokio::test]
    async fn accept_always_keeps_claudes_rules_for_this_session_and_no_mode() {
        let (turn, mut events, mut fake) = pair(None);
        fake.receive().await;
        fake.play(&up_to_the_request(ACCEPT)).await;
        let asked = opened(&mut events).await;

        turn.answer(&asked.request_id, Decision::AcceptAlways)
            .expect("the request is pending");
        let sent = fake.receive().await.expect("an answer");
        assert_eq!(
            sent["response"]["response"]["updatedPermissions"],
            json!([
                {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "touch made.txt"}],
                 "behavior": "allow", "destination": "session"},
                {"type": "addDirectories",
                 "directories": ["/home/yantra/.yantra/worktrees/chat/w/11111111"],
                 "destination": "session"},
            ])
        );
        assert_eq!(sent["response"]["response"]["behavior"], "allow");
    }

    #[tokio::test]
    async fn decline_refuses_the_tool_and_its_item_fails() {
        let (turn, mut events, mut fake) = pair(None);
        fake.receive().await;
        fake.play(&up_to_the_request(DECLINE)).await;
        let asked = opened(&mut events).await;

        turn.answer(&asked.request_id, Decision::Decline)
            .expect("the request is pending");
        let sent = fake.receive().await.expect("an answer");
        assert_eq!(
            sent["response"]["response"],
            json!({"behavior": "deny", "message": "The person declined in Yantra."})
        );

        let rest: String = DECLINE
            .lines()
            .skip_while(|line| !line.contains("\"type\":\"control_request\""))
            .skip(1)
            .map(|line| format!("{line}\n"))
            .collect();
        fake.play(&rest).await;
        let seen = until_completed(&mut events).await;
        assert!(seen.iter().any(|event| matches!(event,
            Event::ItemCompleted(item) if item.status == Some(ItemStatus::Failed)
                && item.output.as_deref() == Some("The person declined."))));
        assert!(matches!(
            seen.last(),
            Some(Event::TurnCompleted(TurnCompleted {
                state: TurnState::Completed,
                ..
            }))
        ));
    }

    #[tokio::test]
    async fn cancel_interrupts_closes_stdin_and_the_turn_ends_cancelled() {
        let (turn, mut events, mut fake) = pair(None);
        fake.receive().await;
        let (before, after) = INTERRUPT.lines().partition::<Vec<_>, _>(|line| {
            !line.contains("\"type\":\"control_response\"") && !line.contains("\"type\":\"result\"")
        });
        fake.play(&format!("{}\n", before.join("\n"))).await;
        let deltas = loop {
            let next = events.recv().await.expect("an event");
            if let Event::ContentDelta(delta) = next.event {
                break delta;
            }
        };
        assert_eq!(deltas.stream_kind, StreamKind::AssistantText);

        turn.cancel();
        assert_eq!(
            fake.receive().await,
            Some(
                json!({"type": "control_request", "request_id": "yantra-interrupt",
                        "request": {"subtype": "interrupt"}})
            )
        );
        assert_eq!(
            fake.receive().await,
            None,
            "stdin closes after the interrupt"
        );
        fake.play(&format!("{}\n", after.join("\n"))).await;
        assert_eq!(
            until_completed(&mut events).await.last(),
            Some(&Event::TurnCompleted(TurnCompleted {
                state: TurnState::Cancelled,
                stop_reason: Some(StopReason::Cancelled),
                message: None,
            }))
        );
    }

    #[tokio::test]
    async fn cancel_refuses_a_request_that_is_still_waiting() {
        let (turn, mut events, mut fake) = pair(None);
        fake.receive().await;
        fake.play(&up_to_the_request(ACCEPT)).await;
        opened(&mut events).await;

        turn.cancel();
        let refused = fake.receive().await.expect("a refusal");
        assert_eq!(refused["response"]["response"]["behavior"], "deny");
        assert_eq!(
            fake.receive().await.expect("an interrupt")["request"]["subtype"],
            "interrupt"
        );
        assert!(matches!(
            events.recv().await.expect("an event").event,
            Event::RequestResolved(RequestResolved {
                decision: Decision::Cancel,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn a_result_that_is_an_error_fails_the_turn_in_claudes_words() {
        let (_turn, mut events, mut fake) = pair(None);
        fake.receive().await;
        fake.play(NOT_LOGGED_IN).await;
        assert_eq!(
            until_completed(&mut events).await.last(),
            Some(&Event::TurnCompleted(TurnCompleted {
                state: TurnState::Failed,
                stop_reason: None,
                message: Some("Not logged in · Please run /login".to_owned()),
            }))
        );
    }

    /// A junk line is skipped, and an exit with no `result` names what `ssh`
    /// and `claude` said on the way out.
    #[tokio::test]
    async fn an_exit_without_a_result_fails_with_the_stderr_tail() {
        let stderr = tokio::spawn(async { "sh: claude: not found".to_owned() });
        let (_turn, mut events, mut fake) = pair(Some(stderr));
        fake.receive().await;
        fake.play("Welcome to the machine!\n{\"type\":\"system\",\"subtype\":\"init\"}\n")
            .await;
        drop(fake);
        assert_eq!(
            until_completed(&mut events).await,
            [
                Event::TurnStarted,
                Event::TurnCompleted(TurnCompleted {
                    state: TurnState::Failed,
                    stop_reason: None,
                    message: Some("sh: claude: not found".to_owned()),
                })
            ]
        );
    }

    #[tokio::test]
    async fn a_control_request_it_does_not_handle_is_answered_with_an_error() {
        let (_turn, _events, mut fake) = pair(None);
        fake.receive().await;
        fake.play(
            "{\"type\":\"control_request\",\"request_id\":\"h1\",\"request\":{\"subtype\":\"hook_callback\"}}\n",
        )
        .await;
        assert_eq!(
            fake.receive().await,
            Some(
                json!({"type": "control_response", "response": {"subtype": "error",
                "request_id": "h1", "error": "Yantra does not answer `hook_callback`"}})
            )
        );
    }

    #[test]
    fn the_tool_names_the_item_and_the_request_type() {
        assert_eq!(item_type("Write"), ItemType::FileChange);
        assert_eq!(item_type("WebFetch"), ItemType::WebSearch);
        assert_eq!(item_type("Task"), ItemType::DynamicToolCall);
        assert_eq!(request_type("Grep"), RequestType::FileReadApproval);
        assert_eq!(request_type("MultiEdit"), RequestType::FileChangeApproval);
        assert_eq!(request_type("WebSearch"), RequestType::DynamicToolCall);
    }

    #[test]
    fn a_long_output_is_cut_and_blocks_are_joined() {
        let long = "x".repeat(OUTPUT + 10);
        assert_eq!(output(&json!(long)).chars().count(), OUTPUT + 1);
        assert_eq!(
            output(
                &json!([{"type": "text", "text": "a"}, {"type": "image"}, {"type": "text", "text": "b"}])
            ),
            "a\nb"
        );
    }

    /// The worktree reaches the shell quoted, and the transcript directory is
    /// the slug, which holds nothing a shell acts on.
    #[test]
    fn the_command_cds_into_the_worktree_and_resumes_the_newest_transcript() {
        let script = command(
            "/home/u/.yantra/worktrees/chat/w/11111111",
            None,
            PermissionMode::Supervised,
        );
        assert!(
            script.starts_with("cd '/home/u/.yantra/worktrees/chat/w/11111111' || exit 1\nc=$("),
            "{script}"
        );
        assert!(script.contains(
            "d=$HOME/.claude/projects/-home-u--yantra-worktrees-chat-w-11111111\n\
             f=$(ls -t \"$d\"/*.jsonl 2>/dev/null | head -n 1)\n\
             [ -n \"$f\" ] && set -- --resume \"$(basename \"$f\" .jsonl)\"\n"
        ));
        assert!(script.ends_with(
            "exec \"$c\" -p --input-format stream-json --output-format stream-json --verbose \
             --include-partial-messages --permission-prompt-tool stdio \"$@\"\n"
        ));

        let hostile = command(
            "/tmp/x'; touch /tmp/pwned; '",
            None,
            PermissionMode::Supervised,
        );
        assert!(hostile.starts_with(r"cd '/tmp/x'\''; touch /tmp/pwned; '\''' || exit 1"));
    }

    /// Y-424: Claude reads the chat's images without asking, and the
    /// directory reaches the shell quoted.
    #[test]
    fn the_images_directory_is_added_before_the_other_flags() {
        let script = command(
            "/w",
            Some("/tmp/yantra-chat-Y01"),
            PermissionMode::Supervised,
        );
        assert!(
            script.contains("exec \"$c\" --add-dir '/tmp/yantra-chat-Y01' -p --input-format"),
            "{script}"
        );
        let hostile = command(
            "/w",
            Some("/tmp/a'; touch /tmp/pwned; '"),
            PermissionMode::Supervised,
        );
        assert!(
            hostile.contains(r"--add-dir '/tmp/a'\''; touch /tmp/pwned; '\''' -p "),
            "{hostile}"
        );
    }

    /// Y-453: Auto and Auto-accept edits run in Claude's own mode.
    #[test]
    fn the_auto_permission_modes_add_claudes_flag() {
        for (mode, flag) in [
            (PermissionMode::Auto, "auto"),
            (PermissionMode::AutoAcceptEdits, "acceptEdits"),
        ] {
            let script = command("/w", Some("/tmp/i"), mode);
            assert!(
                script.contains(&format!(
                    "exec \"$c\" --add-dir '/tmp/i' --permission-mode {flag} -p --input-format"
                )),
                "{script}"
            );
        }
        for mode in [PermissionMode::Supervised, PermissionMode::FullAccess] {
            let script = command("/w", None, mode);
            assert!(!script.contains("--permission-mode"), "{mode:?}: {script}");
        }
    }

    /// Claude's acceptEdits still asks about an edit outside its directories,
    /// so the daemon must not accept that edit for it.
    #[test]
    fn the_daemon_answers_claude_only_in_a_mode_claude_does_not_run() {
        assert_eq!(
            answers(
                PermissionMode::AutoAcceptEdits,
                RequestType::FileChangeApproval
            ),
            None
        );
        assert_eq!(
            answers(PermissionMode::Auto, RequestType::FileChangeApproval),
            None
        );
        assert_eq!(
            answers(PermissionMode::FullAccess, RequestType::ExecCommandApproval),
            Some(Decision::Accept)
        );
        assert_eq!(
            answers(PermissionMode::Supervised, RequestType::FileChangeApproval),
            None
        );
    }
}
