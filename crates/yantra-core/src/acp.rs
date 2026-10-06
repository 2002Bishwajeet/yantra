//! An Agent Client Protocol v1 client (ADR-0033 decision 2). Codex, Gemini,
//! Grok and opencode run as `ssh <machine> <acp command>`, and what they say
//! comes out as [`chat`] events.
//!
//! **This is the one module that knows ACP's wire.** v2 removes
//! `session/load`, makes `session/prompt` return before the turn ends and
//! reshapes diffs (R19 §2), so no method name or ACP shape leaves this file.
//!
//! JSON-RPC 2.0, one message per line, by hand: the surface a chat needs is
//! six calls. The client offers no `fs` and no `terminal`, so the agent uses
//! its own tools on its own machine, and a request for either is refused.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::chat::{self, Event, ThreadEvent};
use crate::ssh::{self, Ssh};

/// Enough of the end of stderr to hold "command not found".
const STDERR_TAIL: usize = 2048;
/// How long a closed stdout waits for stderr's last words.
const STDERR_GRACE: Duration = Duration::from_secs(5);
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

/// The harnesses Yantra drives over ACP. Claude is not one (ADR-0033 §1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Harness {
    Codex,
    Gemini,
    Grok,
    Opencode,
}

impl Harness {
    /// R19 §1. Codex needs an adapter, which bundles its own `codex`.
    pub fn command(self) -> &'static str {
        match self {
            Self::Codex => "codex-acp",
            Self::Gemini => "gemini --acp",
            Self::Grok => "grok agent stdio",
            Self::Opencode => "opencode acp",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    /// The agent's stdout ended. `stderr` is the end of what it and `ssh`
    /// said, which is where "not found" and a refused connection show.
    #[error("the agent closed the connection{}", said(.stderr))]
    Closed { stderr: String },

    /// The agent answered with an error, such as -32000 "Authentication required".
    #[error("the agent refused: {message} ({code})")]
    Rpc { code: i64, message: String },

    #[error("the agent speaks ACP version {offered}, and Yantra speaks only version 1")]
    Version { offered: String },

    #[error("the agent's answer to `{method}` could not be read")]
    Malformed { method: &'static str },

    #[error("no permission request `{0}` is waiting for an answer")]
    NotPending(String),

    #[error("permission request `{request}` did not offer `{option}`")]
    NotOffered { request: String, option: String },
}

fn said(stderr: &str) -> String {
    if stderr.is_empty() {
        String::new()
    } else {
        format!(": {stderr}")
    }
}

/// What `initialize` learned that a caller acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub load_session: bool,
}

/// The answer to a permission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    Selected(String),
    Cancelled,
}

/// Every event the agent produces, in order, until it closes.
pub type Events = mpsc::UnboundedReceiver<ThreadEvent>;

/// One running agent. Dropping it closes its stdin and kills the local `ssh`.
#[derive(Debug)]
pub struct Agent {
    shared: Arc<Shared>,
    tasks: [JoinHandle<()>; 2],
    child: Option<tokio::process::Child>,
}

impl Drop for Agent {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl Agent {
    /// Runs `harness` on the machine `ssh` reaches.
    pub fn start(ssh: &Ssh, harness: Harness) -> Result<(Self, Events), Error> {
        let ssh::Piped {
            child,
            stdin,
            stdout,
            stderr,
            log,
        } = ssh.stdio(harness.command())?;
        let diagnosis = tokio::spawn(async move {
            let tail = tail(stderr).await;
            [String::from_utf8_lossy(&tail).trim(), log.read().trim()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        });
        Ok(Self::wire(stdout, stdin, Some(diagnosis), Some(child)))
    }

    /// The generic half: an agent on any pair of streams.
    pub fn over<R, W>(reader: R, writer: W) -> (Self, Events)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::wire(reader, writer, None, None)
    }

    fn wire<R, W>(
        reader: R,
        writer: W,
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
            state: Mutex::default(),
            out,
            events,
        });
        let tasks = [
            tokio::spawn(read(reader, stderr, Arc::clone(&shared))),
            tokio::spawn(write(writer, lines)),
        ];
        (
            Self {
                shared,
                tasks,
                child,
            },
            received,
        )
    }

    /// The local `ssh`'s process id, while it has one.
    pub fn pid(&self) -> Option<u32> {
        self.child.as_ref().and_then(tokio::process::Child::id)
    }

    pub async fn initialize(&self) -> Result<Capabilities, Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Initialized {
            protocol_version: Value,
            #[serde(default)]
            agent_capabilities: AgentCapabilities,
        }
        #[derive(Default, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AgentCapabilities {
            #[serde(default)]
            load_session: bool,
        }

        let params = json!({
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": {"readTextFile": false, "writeTextFile": false},
                "terminal": false,
            },
            "clientInfo": {"name": "yantra", "version": env!("CARGO_PKG_VERSION")},
        });
        let answer: Initialized = self.call("initialize", params).await?;
        if answer.protocol_version != json!(1) {
            return Err(Error::Version {
                offered: answer.protocol_version.to_string(),
            });
        }
        Ok(Capabilities {
            load_session: answer.agent_capabilities.load_session,
        })
    }

    /// Starts a conversation in `cwd` on the agent's machine, and returns its id.
    pub async fn new_session(&self, cwd: &str) -> Result<String, Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Created {
            session_id: String,
        }

        let params = json!({"cwd": cwd, "mcpServers": []});
        let created: Created = self.call("session/new", params).await?;
        self.shared.emit(&created.session_id, Event::ThreadStarted);
        Ok(created.session_id)
    }

    /// Reopens a conversation. Its history arrives on [`Events`] before this
    /// returns.
    pub async fn load_session(&self, session: &str, cwd: &str) -> Result<(), Error> {
        let params = json!({"sessionId": session, "cwd": cwd, "mcpServers": []});
        let _: Value = self.call("session/load", params).await?;
        Ok(())
    }

    /// One turn. Returns when the agent has finished it, however it ended.
    pub async fn prompt(&self, session: &str, text: &str) -> Result<chat::StopReason, Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Prompted {
            stop_reason: chat::StopReason,
        }

        self.shared.emit(session, Event::TurnStarted);
        let params = json!({"sessionId": session, "prompt": [{"type": "text", "text": text}]});
        let result = self
            .call::<Prompted>("session/prompt", params)
            .await
            .map(|prompted| prompted.stop_reason);
        let completed = match result {
            Ok(chat::StopReason::Cancelled) => chat::TurnCompleted {
                state: chat::TurnState::Cancelled,
                stop_reason: Some(chat::StopReason::Cancelled),
            },
            Ok(reason) => chat::TurnCompleted {
                state: chat::TurnState::Completed,
                stop_reason: Some(reason),
            },
            Err(_) => chat::TurnCompleted {
                state: chat::TurnState::Failed,
                stop_reason: None,
            },
        };
        self.shared.emit(session, Event::TurnCompleted(completed));
        result
    }

    /// Asks the agent to stop the turn, and withdraws every permission request
    /// it is waiting on, as ACP requires of the client.
    pub fn cancel(&self, session: &str) -> Result<(), Error> {
        self.shared
            .send(json!({"jsonrpc": "2.0", "method": "session/cancel",
                         "params": {"sessionId": session}}))?;
        let waiting: Vec<(String, Permission)> = self
            .shared
            .lock()
            .permissions
            .extract_if(|_, permission| permission.session == session)
            .collect();
        for (request, permission) in waiting {
            self.shared.resolve(
                &request,
                permission,
                &Answer::Cancelled,
                chat::Decision::Cancel,
            )?;
        }
        Ok(())
    }

    /// Answers the permission request `request`, by the id
    /// [`chat::RequestOpened`] gave it.
    pub fn answer(&self, request: &str, answer: Answer) -> Result<(), Error> {
        let mut state = self.shared.lock();
        let permission = state
            .permissions
            .remove(request)
            .ok_or_else(|| Error::NotPending(request.to_owned()))?;
        let decision = match &answer {
            Answer::Cancelled => chat::Decision::Cancel,
            Answer::Selected(option) => {
                let offered = permission
                    .options
                    .iter()
                    .find(|offered| offered.option_id == *option);
                match offered {
                    Some(offered) => offered.decision,
                    None => {
                        state.permissions.insert(request.to_owned(), permission);
                        return Err(Error::NotOffered {
                            request: request.to_owned(),
                            option: option.clone(),
                        });
                    }
                }
            }
        };
        drop(state);
        self.shared.resolve(request, permission, &answer, decision)
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<T, Error> {
        let (reply, answered) = oneshot::channel();
        let id = {
            let mut state = self.shared.lock();
            if let Some(stderr) = &state.closed {
                return Err(Error::Closed {
                    stderr: stderr.clone(),
                });
            }
            state.next_id += 1;
            let id = state.next_id;
            state.pending.insert(id, reply);
            id
        };
        let sent = self
            .shared
            .send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        if let Err(error) = sent {
            self.shared.lock().pending.remove(&id);
            return Err(error);
        }
        let result = answered
            .await
            .unwrap_or_else(|_| Err(self.shared.closed()))?;
        serde_json::from_value(result).map_err(|_| Error::Malformed { method })
    }
}

#[derive(Debug, Default)]
struct State {
    next_id: u64,
    pending: HashMap<u64, oneshot::Sender<Result<Value, Error>>>,
    next_request: u64,
    permissions: HashMap<String, Permission>,
    /// Set once stdout ends, to what the agent said on the way out.
    closed: Option<String>,
}

/// A `session/request_permission` the agent is waiting on.
#[derive(Debug)]
struct Permission {
    rpc_id: Value,
    session: String,
    request_type: chat::RequestType,
    options: Vec<chat::RequestOption>,
}

#[derive(Debug)]
struct Shared {
    state: Mutex<State>,
    out: mpsc::UnboundedSender<String>,
    events: mpsc::UnboundedSender<ThreadEvent>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn emit(&self, session: &str, event: Event) {
        // Nobody listening is not this client's failure.
        let _ = self.events.send(ThreadEvent {
            thread_id: session.to_owned(),
            event,
        });
    }

    fn send(&self, message: Value) -> Result<(), Error> {
        self.out
            .send(message.to_string())
            .map_err(|_| self.closed())
    }

    fn closed(&self) -> Error {
        Error::Closed {
            stderr: self.lock().closed.clone().unwrap_or_default(),
        }
    }

    fn resolve(
        &self,
        request: &str,
        permission: Permission,
        answer: &Answer,
        decision: chat::Decision,
    ) -> Result<(), Error> {
        let outcome = match answer {
            Answer::Selected(option) => json!({"outcome": "selected", "optionId": option}),
            Answer::Cancelled => json!({"outcome": "cancelled"}),
        };
        self.send(json!({"jsonrpc": "2.0", "id": permission.rpc_id,
                         "result": {"outcome": outcome}}))?;
        self.emit(
            &permission.session,
            Event::RequestResolved(chat::RequestResolved {
                request_id: request.to_owned(),
                request_type: permission.request_type,
                decision,
            }),
        );
        Ok(())
    }

    fn dispatch(&self, line: &[u8]) {
        #[derive(Deserialize)]
        struct Incoming {
            id: Option<Value>,
            method: Option<String>,
            #[serde(default)]
            params: Value,
            result: Option<Value>,
            error: Option<RpcError>,
        }
        #[derive(Deserialize)]
        struct RpcError {
            code: i64,
            message: String,
        }

        // A line that is not JSON-RPC is noise, such as a login script's echo.
        let Ok(message) = serde_json::from_slice::<Incoming>(line) else {
            return;
        };
        match (message.id, message.method) {
            (Some(id), None) => {
                let Some(reply) = id.as_u64().and_then(|id| self.lock().pending.remove(&id)) else {
                    return;
                };
                let _ = reply.send(match message.error {
                    Some(error) => Err(Error::Rpc {
                        code: error.code,
                        message: error.message,
                    }),
                    None => Ok(message.result.unwrap_or(Value::Null)),
                });
            }
            (Some(id), Some(method)) if method == "session/request_permission" => {
                match serde_json::from_value(message.params) {
                    Ok(asked) => self.open(id, asked),
                    Err(_) => self.refuse(id, INVALID_PARAMS, "Invalid params"),
                }
            }
            (Some(id), Some(_)) => self.refuse(id, METHOD_NOT_FOUND, "Method not found"),
            (None, Some(method)) if method == "session/update" => {
                if let Ok(updated) = serde_json::from_value::<Updated>(message.params)
                    && let Some(event) = event(updated.update)
                {
                    self.emit(&updated.session_id, event);
                }
            }
            // `_`-prefixed extensions and anything newer.
            _ => {}
        }
    }

    fn refuse(&self, id: Value, code: i64, message: &str) {
        let _ = self.send(json!({"jsonrpc": "2.0", "id": id,
                                 "error": {"code": code, "message": message}}));
    }

    fn open(&self, rpc_id: Value, asked: Asked) {
        let options: Vec<chat::RequestOption> = asked
            .options
            .into_iter()
            .map(|option| chat::RequestOption {
                option_id: option.option_id,
                label: option.name,
                decision: match option.kind {
                    OptionKind::AllowOnce => chat::Decision::Accept,
                    OptionKind::AllowAlways => chat::Decision::AcceptAlways,
                    OptionKind::RejectOnce | OptionKind::RejectAlways => chat::Decision::Decline,
                },
            })
            .collect();
        let request_type = match asked.tool_call.kind {
            Some(ToolKind::Execute) => chat::RequestType::ExecCommandApproval,
            Some(ToolKind::Read) => chat::RequestType::FileReadApproval,
            Some(ToolKind::Edit | ToolKind::Delete | ToolKind::Move) => {
                chat::RequestType::FileChangeApproval
            }
            _ => chat::RequestType::DynamicToolCall,
        };
        let request_id = {
            let mut state = self.lock();
            state.next_request += 1;
            let request_id = state.next_request.to_string();
            state.permissions.insert(
                request_id.clone(),
                Permission {
                    rpc_id,
                    session: asked.session_id.clone(),
                    request_type,
                    options: options.clone(),
                },
            );
            request_id
        };
        self.emit(
            &asked.session_id,
            Event::RequestOpened(chat::RequestOpened {
                request_id,
                request_type,
                item_id: Some(asked.tool_call.tool_call_id),
                detail: asked.tool_call.title,
                options,
            }),
        );
    }

    /// Fails every call still waiting, now and later, with `stderr`.
    fn close(&self, stderr: String) {
        let mut state = self.lock();
        for (_, reply) in state.pending.drain() {
            let _ = reply.send(Err(Error::Closed {
                stderr: stderr.clone(),
            }));
        }
        state.permissions.clear();
        state.closed = Some(stderr);
    }
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
    shared.close(said);
}

async fn write<W: AsyncWrite + Unpin>(mut writer: W, mut lines: mpsc::UnboundedReceiver<String>) {
    while let Some(mut line) = lines.recv().await {
        line.push('\n');
        if writer.write_all(line.as_bytes()).await.is_err() || writer.flush().await.is_err() {
            return;
        }
    }
}

/// Drains `stderr` so the agent never blocks on it, keeping only the end.
pub(crate) async fn tail<R: AsyncRead + Unpin>(mut stderr: R) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut chunk = [0u8; 1024];
    while let Ok(read) = stderr.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        kept.extend_from_slice(&chunk[..read]);
        let over = kept.len().saturating_sub(STDERR_TAIL);
        kept.drain(..over);
    }
    kept
}

// The ACP v1 shapes. Only the fields acted on are named: `rawInput` and
// `rawOutput` carry file contents and are never read.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Updated {
    session_id: String,
    update: SessionUpdate,
}

#[derive(Deserialize)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
enum SessionUpdate {
    AgentMessageChunk(Chunk),
    AgentThoughtChunk(Chunk),
    UserMessageChunk(Chunk),
    ToolCall(ToolCall),
    ToolCallUpdate(ToolCall),
    Plan {
        entries: Vec<PlanEntry>,
    },
    UsageUpdate {
        used: u64,
        size: u64,
    },
    SessionInfoUpdate {
        title: Option<String>,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    content: ContentBlock,
    message_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentBlock {
    Text {
        text: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolCall {
    tool_call_id: String,
    title: Option<String>,
    kind: Option<ToolKind>,
    status: Option<ToolStatus>,
    content: Option<Vec<ToolContent>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Fetch,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ToolStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ToolContent {
    Content {
        content: ContentBlock,
    },
    Diff {
        path: String,
        #[serde(rename = "oldText")]
        old_text: Option<String>,
        #[serde(rename = "newText")]
        new_text: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct PlanEntry {
    content: String,
    status: PlanStatus,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum PlanStatus {
    Pending,
    InProgress,
    Completed,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asked {
    session_id: String,
    tool_call: AskedAbout,
    options: Vec<AskedOption>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskedAbout {
    tool_call_id: String,
    title: Option<String>,
    kind: Option<ToolKind>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskedOption {
    option_id: String,
    name: String,
    kind: OptionKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum OptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

/// One update as the chat sees it, or `None` for what the chat does not draw.
fn event(update: SessionUpdate) -> Option<Event> {
    let delta = |kind, chunk: Chunk| match chunk.content {
        ContentBlock::Text { text } => Some(Event::ContentDelta(chat::ContentDelta {
            stream_kind: kind,
            delta: text,
            item_id: chunk.message_id,
        })),
        ContentBlock::Other => None,
    };
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => delta(chat::StreamKind::AssistantText, chunk),
        SessionUpdate::AgentThoughtChunk(chunk) => delta(chat::StreamKind::ReasoningText, chunk),
        SessionUpdate::UserMessageChunk(chunk) => delta(chat::StreamKind::UserText, chunk),
        SessionUpdate::ToolCall(call) => {
            let mut item = item(call);
            item.item_type
                .get_or_insert(chat::ItemType::DynamicToolCall);
            Some(Event::ItemStarted(item))
        }
        SessionUpdate::ToolCallUpdate(call) => {
            let item = item(call);
            Some(match item.status {
                Some(chat::ItemStatus::Completed | chat::ItemStatus::Failed) => {
                    Event::ItemCompleted(item)
                }
                _ => Event::ItemUpdated(item),
            })
        }
        SessionUpdate::Plan { entries } => Some(Event::PlanUpdated {
            plan: entries
                .into_iter()
                .map(|entry| chat::PlanStep {
                    step: entry.content,
                    status: match entry.status {
                        PlanStatus::InProgress => chat::PlanStepStatus::InProgress,
                        PlanStatus::Completed => chat::PlanStepStatus::Completed,
                        PlanStatus::Pending | PlanStatus::Other => chat::PlanStepStatus::Pending,
                    },
                })
                .collect(),
        }),
        SessionUpdate::UsageUpdate { used, size } => {
            Some(Event::TokenUsageUpdated(chat::TokenUsage {
                used_tokens: used,
                max_tokens: size,
            }))
        }
        SessionUpdate::SessionInfoUpdate { title } => {
            title.map(|name| Event::ThreadMetadataUpdated { name })
        }
        SessionUpdate::Other => None,
    }
}

fn item(call: ToolCall) -> chat::Item {
    let mut output = Vec::new();
    let mut changes = Vec::new();
    for content in call.content.into_iter().flatten() {
        match content {
            ToolContent::Content {
                content: ContentBlock::Text { text },
            } => output.push(text),
            ToolContent::Diff {
                path,
                old_text,
                new_text,
            } => changes.push(chat::FileChange {
                path,
                old_text,
                new_text,
            }),
            ToolContent::Content { .. } | ToolContent::Other => {}
        }
    }
    chat::Item {
        item_id: call.tool_call_id,
        item_type: call.kind.map(|kind| match kind {
            ToolKind::Execute => chat::ItemType::CommandExecution,
            ToolKind::Edit | ToolKind::Delete | ToolKind::Move => chat::ItemType::FileChange,
            ToolKind::Search | ToolKind::Fetch => chat::ItemType::WebSearch,
            ToolKind::Read | ToolKind::Other => chat::ItemType::DynamicToolCall,
        }),
        status: call.status.and_then(|status| match status {
            ToolStatus::Pending | ToolStatus::InProgress => Some(chat::ItemStatus::InProgress),
            ToolStatus::Completed => Some(chat::ItemStatus::Completed),
            ToolStatus::Failed => Some(chat::ItemStatus::Failed),
            ToolStatus::Other => None,
        }),
        title: call.title,
        output: (!output.is_empty()).then(|| output.join("\n")),
        changes,
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use chat::{
        ContentDelta, Decision, FileChange, Item, ItemStatus, ItemType, PlanStep, PlanStepStatus,
        RequestOpened, RequestOption, RequestResolved, RequestType, StopReason, StreamKind,
        TokenUsage, TurnCompleted, TurnState,
    };
    use tokio::io::{DuplexStream, ReadHalf, WriteHalf};

    const SESSION: &str = "ses_eeed4274bffeTYit4oOoDcmsRY";

    /// The agent's end of the pipe, scripted by the test.
    struct Fake {
        from_client: BufReader<ReadHalf<DuplexStream>>,
        to_client: WriteHalf<DuplexStream>,
    }

    impl Fake {
        async fn receive(&mut self) -> Value {
            let mut line = String::new();
            tokio::time::timeout(
                Duration::from_secs(5),
                self.from_client.read_line(&mut line),
            )
            .await
            .expect("the client sends within 5 s")
            .expect("the pipe reads");
            serde_json::from_str(&line).expect("the client sends one JSON message per line")
        }

        async fn send_line(&mut self, line: &str) {
            self.to_client
                .write_all(format!("{line}\n").as_bytes())
                .await
                .expect("the pipe writes");
        }

        async fn send(&mut self, message: Value) {
            self.send_line(&message.to_string()).await;
        }

        async fn reply(&mut self, request: &Value, result: Value) {
            self.send(json!({"jsonrpc": "2.0", "id": request["id"], "result": result}))
                .await;
        }
    }

    fn pair() -> (Agent, Events, Fake) {
        pair_with_stderr(None)
    }

    fn pair_with_stderr(stderr: Option<JoinHandle<String>>) -> (Agent, Events, Fake) {
        let (client, agent) = tokio::io::duplex(1 << 16);
        let (client_read, client_write) = tokio::io::split(client);
        let (agent_read, agent_write) = tokio::io::split(agent);
        let (client, events) = Agent::wire(client_read, client_write, stderr, None);
        let fake = Fake {
            from_client: BufReader::new(agent_read),
            to_client: agent_write,
        };
        (client, events, fake)
    }

    async fn next(events: &mut Events) -> ThreadEvent {
        tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("an event within 5 s")
            .expect("the channel is open")
    }

    fn parse(update: Value) -> Option<Event> {
        event(serde_json::from_value(update).expect("an update parses"))
    }

    /// R19 §1's handshake, as opencode 1.18.34 answered it.
    fn initialized(version: Value) -> Value {
        json!({"protocolVersion": version,
               "agentCapabilities": {"loadSession": true,
                   "mcpCapabilities": {"http": true, "sse": true},
                   "promptCapabilities": {"embeddedContext": true, "image": true},
                   "sessionCapabilities": {"close": {}, "fork": {}, "list": {}, "resume": {}}},
               "authMethods": [{"description": "Run `opencode auth login` in the terminal",
                                "name": "Login with opencode", "id": "opencode-login"}],
               "agentInfo": {"name": "OpenCode", "version": "1.18.34"}})
    }

    #[tokio::test]
    async fn initialize_offers_no_files_and_no_terminal_and_reads_load_session() {
        let (agent, _events, mut fake) = pair();
        let (answer, ()) = tokio::join!(agent.initialize(), async {
            let request = fake.receive().await;
            assert_eq!(request["method"], "initialize");
            assert_eq!(request["params"]["protocolVersion"], 1);
            assert_eq!(
                request["params"]["clientCapabilities"],
                json!({"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false})
            );
            fake.reply(&request, initialized(json!(1))).await;
        });
        assert_eq!(
            answer.expect("version 1 is accepted"),
            Capabilities { load_session: true }
        );
    }

    /// R19 negative finding 9: v2 breaks the parts a chat touches.
    #[tokio::test]
    async fn a_version_other_than_1_is_refused() {
        let (agent, _events, mut fake) = pair();
        let (answer, ()) = tokio::join!(agent.initialize(), async {
            let request = fake.receive().await;
            fake.reply(&request, initialized(json!(2))).await;
        });
        assert!(
            matches!(&answer, Err(Error::Version { offered }) if offered == "2"),
            "{answer:?}"
        );
    }

    /// R19 §1: what codex-acp answers with no login.
    #[tokio::test]
    async fn an_error_reply_is_the_agents_own_words() {
        let (agent, _events, mut fake) = pair();
        let (answer, ()) = tokio::join!(agent.new_session("/home/yantra/w"), async {
            let request = fake.receive().await;
            assert_eq!(request["method"], "session/new");
            assert_eq!(
                request["params"],
                json!({"cwd": "/home/yantra/w", "mcpServers": []})
            );
            fake.send(json!({"jsonrpc": "2.0", "id": request["id"],
                             "error": {"code": -32000, "message": "Authentication required"}}))
                .await;
        });
        assert!(
            matches!(&answer, Err(Error::Rpc { code: -32000, message })
                if message == "Authentication required"),
            "{answer:?}"
        );
    }

    #[tokio::test]
    async fn an_agent_that_exits_mid_request_fails_this_call_and_every_later_one() {
        let (agent, _events, mut fake) = pair();
        let (answer, ()) = tokio::join!(agent.initialize(), async {
            fake.receive().await;
            drop(fake);
        });
        assert!(matches!(answer, Err(Error::Closed { .. })), "{answer:?}");
        let again = agent.new_session("/").await;
        assert!(matches!(again, Err(Error::Closed { .. })), "{again:?}");
    }

    /// A harness that is not installed exits at once, and stderr says why.
    #[tokio::test]
    async fn closed_carries_what_the_agent_said_on_stderr() {
        let stderr = tokio::spawn(async { "sh: opencode: not found".to_owned() });
        let (agent, _events, fake) = pair_with_stderr(Some(stderr));
        drop(fake);
        let answer = agent.initialize().await;
        assert!(
            matches!(&answer, Err(Error::Closed { stderr }) if stderr == "sh: opencode: not found"),
            "{answer:?}"
        );
        assert_eq!(
            answer.expect_err("closed").to_string(),
            "the agent closed the connection: sh: opencode: not found"
        );
    }

    #[tokio::test]
    async fn a_line_that_is_not_json_rpc_is_skipped_and_a_bad_result_is_malformed() {
        let (agent, _events, mut fake) = pair();
        let (answer, ()) = tokio::join!(agent.initialize(), async {
            let request = fake.receive().await;
            fake.send_line("Welcome to the machine!").await;
            fake.reply(&request, json!({"agentCapabilities": {}})).await;
        });
        assert!(
            matches!(
                answer,
                Err(Error::Malformed {
                    method: "initialize"
                })
            ),
            "{answer:?}"
        );
    }

    #[tokio::test]
    async fn requests_the_client_did_not_advertise_get_method_not_found() {
        let (_agent, mut events, mut fake) = pair();
        for (id, method) in [
            (7, "fs/read_text_file"),
            (8, "terminal/create"),
            (9, "x/what"),
        ] {
            fake.send(json!({"jsonrpc": "2.0", "id": id, "method": method,
                             "params": {"sessionId": SESSION, "path": "/etc/passwd"}}))
                .await;
            assert_eq!(
                fake.receive().await,
                json!({"jsonrpc": "2.0", "id": id,
                       "error": {"code": -32601, "message": "Method not found"}})
            );
        }

        // An extension notification is ignored; the next real update arrives.
        fake.send(json!({"jsonrpc": "2.0", "method": "_auth/status_update",
                         "params": {"authStatus": {"kind": "account"}}}))
            .await;
        fake.send(json!({"jsonrpc": "2.0", "method": "session/update",
                         "params": {"sessionId": SESSION, "update":
                            {"sessionUpdate": "usage_update", "used": 1, "size": 2}}}))
            .await;
        assert_eq!(
            next(&mut events).await,
            ThreadEvent {
                thread_id: SESSION.to_owned(),
                event: Event::TokenUsageUpdated(TokenUsage {
                    used_tokens: 1,
                    max_tokens: 2
                }),
            }
        );
    }

    /// R19 §2's captured request, `rawInput` and its file contents included.
    fn asked(id: u64) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": "session/request_permission",
               "params": {"sessionId": SESSION,
                   "toolCall": {"toolCallId": "toolu_1", "name": "Write",
                       "title": "Write hello.txt", "kind": "edit", "status": "pending",
                       "rawInput": {"file_path": "/w/hello.txt", "content": "secret"},
                       "content": [{"type": "diff", "path": "/w/hello.txt",
                                    "oldText": null, "newText": "secret"}],
                       "locations": [{"path": "/w/hello.txt"}]},
                   "options": [
                       {"optionId": "allow-once", "name": "Yes", "kind": "allow_once"},
                       {"optionId": "allow-with-updates",
                        "name": "Yes, allow all edits during this session",
                        "kind": "allow_always"},
                       {"optionId": "reject", "name": "No", "kind": "reject_once"}]}})
    }

    #[tokio::test]
    async fn a_permission_request_opens_and_its_answer_resolves_it() {
        let (agent, mut events, mut fake) = pair();
        fake.send(asked(0)).await;

        let opened = next(&mut events).await;
        assert_eq!(
            opened.event,
            Event::RequestOpened(RequestOpened {
                request_id: "1".to_owned(),
                request_type: RequestType::FileChangeApproval,
                item_id: Some("toolu_1".to_owned()),
                detail: Some("Write hello.txt".to_owned()),
                options: vec![
                    RequestOption {
                        option_id: "allow-once".to_owned(),
                        label: "Yes".to_owned(),
                        decision: Decision::Accept,
                    },
                    RequestOption {
                        option_id: "allow-with-updates".to_owned(),
                        label: "Yes, allow all edits during this session".to_owned(),
                        decision: Decision::AcceptAlways,
                    },
                    RequestOption {
                        option_id: "reject".to_owned(),
                        label: "No".to_owned(),
                        decision: Decision::Decline,
                    },
                ],
            })
        );
        let wire = serde_json::to_string(&opened).expect("serialises");
        assert!(!wire.contains("secret"), "file contents stay out: {wire}");

        assert!(matches!(
            agent.answer("1", Answer::Selected("always-and-forever".to_owned())),
            Err(Error::NotOffered { .. })
        ));
        agent
            .answer("1", Answer::Selected("allow-once".to_owned()))
            .expect("the request is pending");
        assert_eq!(
            fake.receive().await,
            json!({"jsonrpc": "2.0", "id": 0,
                   "result": {"outcome": {"outcome": "selected", "optionId": "allow-once"}}})
        );
        assert_eq!(
            next(&mut events).await.event,
            Event::RequestResolved(RequestResolved {
                request_id: "1".to_owned(),
                request_type: RequestType::FileChangeApproval,
                decision: Decision::Accept,
            })
        );
        assert!(matches!(
            agent.answer("1", Answer::Cancelled),
            Err(Error::NotPending(_))
        ));
    }

    /// R19 §2: cancel, then the prompt returns `cancelled`. A question the
    /// agent was waiting on is withdrawn with it.
    #[tokio::test]
    async fn cancel_ends_the_turn_and_withdraws_its_question() {
        let (agent, mut events, mut fake) = pair();
        let (stopped, ()) = tokio::join!(agent.prompt(SESSION, "count to 200"), async {
            let prompt = fake.receive().await;
            assert_eq!(prompt["method"], "session/prompt");
            assert_eq!(
                prompt["params"],
                json!({"sessionId": SESSION,
                       "prompt": [{"type": "text", "text": "count to 200"}]})
            );
            assert_eq!(next(&mut events).await.event, Event::TurnStarted);

            fake.send(asked(41)).await;
            assert!(matches!(
                next(&mut events).await.event,
                Event::RequestOpened(_)
            ));
            agent.cancel(SESSION).expect("the pipe is open");
            assert_eq!(
                fake.receive().await,
                json!({"jsonrpc": "2.0", "method": "session/cancel",
                       "params": {"sessionId": SESSION}})
            );
            assert_eq!(
                fake.receive().await,
                json!({"jsonrpc": "2.0", "id": 41,
                       "result": {"outcome": {"outcome": "cancelled"}}})
            );
            fake.reply(
                &prompt,
                json!({"stopReason": "cancelled",
                       "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
                       "_meta": {}}),
            )
            .await;
        });

        assert_eq!(stopped.expect("the turn ended"), StopReason::Cancelled);
        assert!(matches!(
            next(&mut events).await.event,
            Event::RequestResolved(RequestResolved {
                decision: Decision::Cancel,
                ..
            })
        ));
        assert_eq!(
            next(&mut events).await.event,
            Event::TurnCompleted(TurnCompleted {
                state: TurnState::Cancelled,
                stop_reason: Some(StopReason::Cancelled),
            })
        );
    }

    #[tokio::test]
    async fn a_failed_turn_completes_as_failed() {
        let (agent, mut events, mut fake) = pair();
        let (stopped, ()) = tokio::join!(agent.prompt(SESSION, "hi"), async {
            let prompt = fake.receive().await;
            fake.send(json!({"jsonrpc": "2.0", "id": prompt["id"],
                             "error": {"code": -32603, "message": "Internal error"}}))
                .await;
        });
        assert!(matches!(stopped, Err(Error::Rpc { code: -32603, .. })));
        assert_eq!(next(&mut events).await.event, Event::TurnStarted);
        assert_eq!(
            next(&mut events).await.event,
            Event::TurnCompleted(TurnCompleted {
                state: TurnState::Failed,
                stop_reason: None,
            })
        );
    }

    #[tokio::test]
    async fn a_new_session_starts_a_thread() {
        let (agent, mut events, mut fake) = pair();
        let (session, ()) = tokio::join!(agent.new_session("/home/yantra/w"), async {
            let request = fake.receive().await;
            fake.reply(&request, json!({"sessionId": SESSION, "configOptions": []}))
                .await;
        });
        assert_eq!(session.expect("a session"), SESSION);
        assert_eq!(
            next(&mut events).await,
            ThreadEvent {
                thread_id: SESSION.to_owned(),
                event: Event::ThreadStarted
            }
        );
    }

    /// opencode replays the history before it answers `session/load`.
    #[tokio::test]
    async fn load_delivers_the_replayed_history_before_it_returns() {
        let (agent, mut events, mut fake) = pair();
        let (loaded, ()) = tokio::join!(agent.load_session(SESSION, "/home/yantra/w"), async {
            let request = fake.receive().await;
            assert_eq!(request["method"], "session/load");
            assert_eq!(
                request["params"],
                json!({"sessionId": SESSION, "cwd": "/home/yantra/w", "mcpServers": []})
            );
            fake.send(json!({"jsonrpc": "2.0", "method": "session/update",
                "params": {"sessionId": SESSION, "update": {
                    "sessionUpdate": "user_message_chunk", "messageId": "msg_1",
                    "content": {"type": "text", "text": "Run `ls`."}}}}))
                .await;
            fake.reply(&request, json!({"configOptions": []})).await;
        });
        loaded.expect("the session loads");
        assert_eq!(
            events
                .try_recv()
                .expect("the replay is already there")
                .event,
            Event::ContentDelta(ContentDelta {
                stream_kind: StreamKind::UserText,
                delta: "Run `ls`.".to_owned(),
                item_id: Some("msg_1".to_owned()),
            })
        );
    }

    #[test]
    fn message_thought_and_replayed_user_chunks_are_deltas() {
        for (kind, stream) in [
            ("agent_message_chunk", StreamKind::AssistantText),
            ("agent_thought_chunk", StreamKind::ReasoningText),
            ("user_message_chunk", StreamKind::UserText),
        ] {
            assert_eq!(
                parse(json!({"sessionUpdate": kind, "messageId": "prt_1",
                             "content": {"type": "text", "text": "The"}})),
                Some(Event::ContentDelta(ContentDelta {
                    stream_kind: stream,
                    delta: "The".to_owned(),
                    item_id: Some("prt_1".to_owned()),
                }))
            );
        }
        assert_eq!(
            parse(json!({"sessionUpdate": "agent_message_chunk",
                         "content": {"type": "image", "data": "", "mimeType": "image/png"}})),
            None,
            "a content block the chat cannot draw is dropped"
        );
    }

    /// The three updates opencode 1.18.34 sent for one `ls`.
    #[test]
    fn a_tool_call_starts_updates_and_completes_an_item() {
        assert_eq!(
            parse(
                json!({"sessionUpdate": "tool_call", "toolCallId": "call_b3",
                "title": "bash", "kind": "execute", "status": "pending",
                "locations": [{"path": "/w"}], "rawInput": {"cwd": "/w"}})
            ),
            Some(Event::ItemStarted(Item {
                item_id: "call_b3".to_owned(),
                item_type: Some(ItemType::CommandExecution),
                status: Some(ItemStatus::InProgress),
                title: Some("bash".to_owned()),
                output: None,
                changes: vec![],
            }))
        );
        assert_eq!(
            parse(
                json!({"sessionUpdate": "tool_call_update", "toolCallId": "call_b3",
                "status": "in_progress", "kind": "execute", "title": "ls",
                "rawInput": {"command": "ls", "cwd": "/w"}})
            ),
            Some(Event::ItemUpdated(Item {
                item_id: "call_b3".to_owned(),
                item_type: Some(ItemType::CommandExecution),
                status: Some(ItemStatus::InProgress),
                title: Some("ls".to_owned()),
                output: None,
                changes: vec![],
            }))
        );
        assert_eq!(
            parse(
                json!({"sessionUpdate": "tool_call_update", "toolCallId": "call_b3",
                "status": "completed", "title": "ls",
                "content": [{"type": "content", "content": {"type": "text", "text": "(no output)"}}],
                "rawOutput": {"output": "(no output)"}})
            ),
            Some(Event::ItemCompleted(Item {
                item_id: "call_b3".to_owned(),
                item_type: None,
                status: Some(ItemStatus::Completed),
                title: Some("ls".to_owned()),
                output: Some("(no output)".to_owned()),
                changes: vec![],
            }))
        );
    }

    #[test]
    fn a_diff_becomes_a_file_change_and_a_failure_completes_the_item() {
        assert_eq!(
            parse(
                json!({"sessionUpdate": "tool_call_update", "toolCallId": "t",
                "kind": "edit", "status": "failed",
                "content": [{"type": "diff", "path": "/w/a", "oldText": null, "newText": "x"},
                            {"type": "terminal", "terminalId": "term_1"}]})
            ),
            Some(Event::ItemCompleted(Item {
                item_id: "t".to_owned(),
                item_type: Some(ItemType::FileChange),
                status: Some(ItemStatus::Failed),
                title: None,
                output: None,
                changes: vec![FileChange {
                    path: "/w/a".to_owned(),
                    old_text: None,
                    new_text: "x".to_owned(),
                }],
            }))
        );
    }

    #[test]
    fn a_tool_call_with_no_kind_is_a_dynamic_tool_call() {
        let Some(Event::ItemStarted(item)) = parse(json!({"sessionUpdate": "tool_call",
            "toolCallId": "t", "title": "think hard", "kind": "think"}))
        else {
            panic!("a tool call starts an item");
        };
        assert_eq!(item.item_type, Some(ItemType::DynamicToolCall));
        let Some(Event::ItemStarted(item)) =
            parse(json!({"sessionUpdate": "tool_call", "toolCallId": "t", "title": "?"}))
        else {
            panic!("a tool call starts an item");
        };
        assert_eq!(item.item_type, Some(ItemType::DynamicToolCall));
    }

    #[test]
    fn plan_usage_and_title_updates_map() {
        assert_eq!(
            parse(json!({"sessionUpdate": "plan", "entries": [
                {"content": "read", "priority": "high", "status": "completed"},
                {"content": "edit", "priority": "medium", "status": "in_progress"},
                {"content": "test", "priority": "low", "status": "pending"}]})),
            Some(Event::PlanUpdated {
                plan: vec![
                    PlanStep {
                        step: "read".to_owned(),
                        status: PlanStepStatus::Completed
                    },
                    PlanStep {
                        step: "edit".to_owned(),
                        status: PlanStepStatus::InProgress
                    },
                    PlanStep {
                        step: "test".to_owned(),
                        status: PlanStepStatus::Pending
                    },
                ],
            })
        );
        assert_eq!(
            parse(
                json!({"sessionUpdate": "usage_update", "used": 7840, "size": 200000,
                         "cost": {"amount": 0, "currency": "USD"}})
            ),
            Some(Event::TokenUsageUpdated(TokenUsage {
                used_tokens: 7840,
                max_tokens: 200_000
            }))
        );
        assert_eq!(
            parse(json!({"sessionUpdate": "session_info_update", "title": "List files"})),
            Some(Event::ThreadMetadataUpdated {
                name: "List files".to_owned()
            })
        );
    }

    #[test]
    fn updates_the_chat_does_not_draw_are_dropped() {
        for update in [
            json!({"sessionUpdate": "available_commands_update", "availableCommands": []}),
            json!({"sessionUpdate": "current_mode_update", "currentModeId": "plan"}),
            json!({"sessionUpdate": "state_update", "state": "idle"}),
        ] {
            assert_eq!(parse(update), None);
        }
    }
}
