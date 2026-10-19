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

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::agent;
use crate::chat::{self, Event, ThreadEvent};
use crate::claude::Said;
use crate::keep;
use crate::ssh::{self, Ssh};
use crate::tmux::sq;

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

    /// The command a keeper runs ([`crate::keep`]): the binary searched for
    /// as I-34 requires, since a tmux pane's `PATH` is the server's, then its
    /// arguments. The `cd` matters: the keeper runs it in its journal
    /// directory, where a relative write would land beside `in` and `out`.
    pub fn kept_command(self, worktree: &str) -> String {
        let (binary, args) = self
            .command()
            .split_once(' ')
            .unwrap_or((self.command(), ""));
        format!(
            "cd {} || exit 1\n\
             c=$({}) || {{ echo '{binary} was not found on PATH or in any of: {}' >&2; exit 127; }}\n\
             exec \"$c\" {args}\n",
            sq(worktree),
            agent::probe(binary),
            agent::CANDIDATES.join(", ")
        )
    }

    /// The name a caller sends and a thread's git config keeps.
    pub fn name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::Grok => "grok",
            Self::Opencode => "opencode",
        }
    }
}

impl std::str::FromStr for Harness {
    type Err = String;

    fn from_str(name: &str) -> Result<Self, Self::Err> {
        [Self::Codex, Self::Gemini, Self::Grok, Self::Opencode]
            .into_iter()
            .find(|harness| harness.name() == name)
            .ok_or_else(|| {
                format!(
                    "`{name}` is not a harness Yantra drives over ACP: codex, gemini, grok or opencode"
                )
            })
    }
}

/// What a person runs on the machine to log a harness in (R19 §1). `None` is
/// Claude, which is not an ACP harness.
pub fn login_command(harness: Option<Harness>) -> &'static str {
    match harness {
        None => "run claude and type /login",
        Some(Harness::Codex) => "codex login",
        Some(Harness::Gemini) => "run gemini and sign in",
        Some(Harness::Grok) => "run grok and sign in",
        Some(Harness::Opencode) => "opencode auth login",
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

impl Error {
    /// The agent refused because nobody is logged in. These are the spellings
    /// R19 §1 saw: codex-acp and Grok send -32000, Gemini names the key.
    pub fn is_auth(&self) -> bool {
        match self {
            Self::Rpc { code, message } => {
                *code == -32000
                    || message.contains("Authentication required")
                    || message.contains("API key is missing")
            }
            _ => false,
        }
    }
}

fn said(stderr: &str) -> String {
    if stderr.is_empty() {
        String::new()
    } else {
        format!(": {stderr}")
    }
}

/// What `initialize` learned that a caller acts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capabilities {
    pub load_session: bool,
    /// The first auth method's description, such as opencode's "Run
    /// `opencode auth login` in the terminal".
    pub login: Option<String>,
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
    harness: Harness,
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
        let diagnosis = diagnosis(stderr, log);
        let said: Said = Box::pin(async move { diagnosis.await.unwrap_or_default() });
        Ok(Self::wire(
            harness,
            stdout,
            stdin,
            (None, None, State::default()),
            Some(said),
            Some(child),
        ))
    }

    /// The generic half: an agent on any pair of streams.
    pub fn over<R, W>(harness: Harness, reader: R, writer: W) -> (Self, Events)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::wire(
            harness,
            reader,
            writer,
            (None, None, State::default()),
            None,
            None,
        )
    }

    /// An agent held by a keeper ([`keep`]): `reader` follows its `out` from
    /// byte 0 and `writer` appends to its `in`. Each event read carries a
    /// cursor in `run`, and `said` is what the keeper's `err` holds.
    pub fn kept<R, W>(
        harness: Harness,
        reader: R,
        writer: W,
        run: &str,
        said: Said,
    ) -> (Self, Events)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let parse = (Some(run.to_owned()), Some(0), State::default());
        Self::wire(harness, reader, writer, parse, Some(said), None)
    }

    /// A kept agent this daemon did not start, continued where [`replay`]
    /// stopped. A call the last daemon made and the agent has not answered
    /// still ends its turn when the answer comes.
    pub fn resume<R, W>(
        harness: Harness,
        reader: R,
        writer: W,
        replayed: Replayed,
        said: Said,
    ) -> (Self, Events)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let parse = (Some(replayed.run), Some(replayed.offset), replayed.state);
        Self::wire(harness, reader, writer, parse, Some(said), None)
    }

    fn wire<R, W>(
        harness: Harness,
        reader: R,
        writer: W,
        (run, from, state): (Option<String>, Option<u64>, State),
        stderr: Option<Said>,
        child: Option<tokio::process::Child>,
    ) -> (Self, Events)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (out, lines) = mpsc::unbounded_channel();
        let (events, received) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            run,
            state: Mutex::new(state),
            out,
            events: Mutex::new(Some(events)),
        });
        let tasks = [
            tokio::spawn(read(reader, from, stderr, Arc::clone(&shared))),
            tokio::spawn(write(writer, lines)),
        ];
        (
            Self {
                harness,
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
            #[serde(default)]
            auth_methods: Vec<AuthMethod>,
        }
        #[derive(Deserialize)]
        struct AuthMethod {
            description: Option<String>,
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
            login: answer
                .auth_methods
                .into_iter()
                .find_map(|method| method.description.filter(|said| !said.is_empty())),
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
        self.shared.emit_made(
            &created.session_id,
            Event::ThreadStarted {
                thread: created.session_id.clone(),
                harness: self.harness.name().to_owned(),
            },
        );
        Ok(created.session_id)
    }

    /// Reopens a conversation. Its history arrives on [`Events`] before this
    /// returns.
    pub async fn load_session(&self, session: &str, cwd: &str) -> Result<(), Error> {
        self.shared
            .lock()
            .worktrees
            .insert(session.to_owned(), cwd.to_owned());
        let params = json!({"sessionId": session, "cwd": cwd, "mcpServers": []});
        let _: Value = self.call("session/load", params).await?;
        Ok(())
    }

    /// One turn. Returns when the agent has finished it, however it ended.
    pub async fn prompt(&self, session: &str, text: &str) -> Result<chat::StopReason, Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Prompted {
            stop_reason: StopReason,
        }

        // Its own sender, so a turn that could not be sent still ends.
        let events = self.shared.sender();
        let emit = |event| emit(events.as_ref(), session, None, event);
        emit(Event::TurnStarted);
        let params = json!({"sessionId": session, "prompt": [{"type": "text", "text": text}]});
        // Once the call is sent, the answer or the agent's end makes
        // `turn.completed`, so a turn another daemon sent ends the same way.
        let answered = match self.shared.register("session/prompt", params) {
            Ok(answered) => answered,
            Err(error) => {
                emit(Event::TurnCompleted(failed(&error)));
                return Err(error);
            }
        };
        let result = answered
            .await
            .unwrap_or_else(|_| Err(self.shared.closed()))?;
        serde_json::from_value::<Prompted>(result)
            .map(|prompted| prompted.stop_reason.into())
            .map_err(|_| Error::Malformed {
                method: "session/prompt",
            })
    }

    /// Asks the agent to stop the turn, and withdraws every permission request
    /// it is waiting on, as ACP requires of the client.
    /// Every request is resolved even when a send fails, and the first
    /// failure is returned.
    pub fn cancel(&self, session: &str) -> Result<(), Error> {
        let mut failed = self
            .shared
            .send(json!({"jsonrpc": "2.0", "method": "session/cancel",
                         "params": {"sessionId": session}}))
            .err();
        let waiting: Vec<(String, Permission)> = self
            .shared
            .lock()
            .permissions
            .extract_if(|_, permission| permission.session == session)
            .collect();
        for (request, permission) in waiting {
            let resolved = self.shared.resolve(
                &request,
                permission,
                &Answer::Cancelled,
                chat::Decision::Cancel,
            );
            if let Err(error) = resolved {
                failed.get_or_insert(error);
            }
        }
        failed.map_or(Ok(()), Err)
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
        let answered = self.shared.register(method, params)?;
        let result = answered
            .await
            .unwrap_or_else(|_| Err(self.shared.closed()))?;
        serde_json::from_value(result).map_err(|_| Error::Malformed { method })
    }
}

/// This daemon's JSON-RPC ids start with a random prefix, so they never meet
/// the ids an earlier daemon wrote to a keeper's `in` (ADR-0035 decision 9).
fn prefix() -> &'static str {
    static PREFIX: OnceLock<String> = OnceLock::new();
    PREFIX.get_or_init(|| ssh::nonce().unwrap_or_else(|_| "Y0".to_owned()))
}

/// A JSON-RPC id as a key: this daemon's are strings, and an agent's may be
/// numbers.
fn key(id: &Value) -> String {
    match id {
        Value::String(id) => id.clone(),
        other => other.to_string(),
    }
}

fn failed(error: &Error) -> chat::TurnCompleted {
    chat::TurnCompleted {
        state: chat::TurnState::Failed,
        stop_reason: None,
        message: Some(error.to_string()),
    }
}

/// How the answer to a `session/prompt` ends its turn.
fn completed(answer: &Result<Value, Error>) -> chat::TurnCompleted {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Prompted {
        stop_reason: StopReason,
    }
    let reason = match answer {
        Ok(result) => serde_json::from_value::<Prompted>(result.clone())
            .map(|prompted| chat::StopReason::from(prompted.stop_reason))
            .map_err(|_| Error::Malformed {
                method: "session/prompt",
            }),
        Err(Error::Rpc { code, message }) => Err(Error::Rpc {
            code: *code,
            message: message.clone(),
        }),
        Err(error) => Err(Error::Closed {
            stderr: error.to_string(),
        }),
    };
    match reason {
        Ok(chat::StopReason::Cancelled) => chat::TurnCompleted {
            state: chat::TurnState::Cancelled,
            stop_reason: Some(chat::StopReason::Cancelled),
            message: None,
        },
        Ok(reason) => chat::TurnCompleted {
            state: chat::TurnState::Completed,
            stop_reason: Some(reason),
            message: None,
        },
        Err(error) => failed(&error),
    }
}

#[derive(Debug, Default)]
struct State {
    next_id: u64,
    /// The calls this client made and the agent has not answered.
    calls: HashMap<String, Call>,
    next_request: u64,
    permissions: HashMap<String, Permission>,
    /// Each session's `cwd`, the thread's worktree.
    worktrees: HashMap<String, String>,
    /// Set once stdout ends, to what the agent said on the way out.
    closed: Option<String>,
    /// What a keeper's `in` already answered, by the agent's id.
    answered: HashMap<String, Value>,
    /// The end of the line being read and the number of events made from it.
    line: Option<(u64, u32)>,
}

/// A call this client made. `reply` is `None` for a call an earlier daemon
/// made, found in a keeper's `in`.
#[derive(Debug)]
struct Call {
    method: String,
    session: Option<String>,
    cwd: Option<String>,
    reply: Option<oneshot::Sender<Result<Value, Error>>>,
}

impl Call {
    fn of(method: &str, params: &Value) -> Self {
        let text = |name: &str| params.get(name).and_then(Value::as_str).map(str::to_owned);
        Self {
            method: method.to_owned(),
            session: text("sessionId"),
            cwd: text("cwd"),
            reply: None,
        }
    }
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
    /// The keeper's run, when the agent is read from one.
    run: Option<String>,
    state: Mutex<State>,
    out: mpsc::UnboundedSender<String>,
    /// Taken by `close`, so [`Events`] ends once the last turn has.
    events: Mutex<Option<mpsc::UnboundedSender<ThreadEvent>>>,
}

fn emit(
    events: Option<&mpsc::UnboundedSender<ThreadEvent>>,
    session: &str,
    cursor: Option<String>,
    event: Event,
) {
    // Nobody listening is not this client's failure.
    if let Some(events) = events {
        let _ = events.send(ThreadEvent {
            thread_id: session.to_owned(),
            cursor,
            event,
        });
    }
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn sender(&self) -> Option<mpsc::UnboundedSender<ThreadEvent>> {
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// An event read from the line being read, with its cursor when the
    /// agent is kept.
    fn emit(&self, session: &str, event: Event) {
        let cursor = self.run.as_ref().and_then(|run| {
            let mut state = self.lock();
            let (end, part) = state.line.as_mut()?;
            let cursor = keep::Cursor {
                run: run.clone(),
                end: *end,
                part: *part,
            };
            *part += 1;
            Some(cursor.to_string())
        });
        emit(self.sender().as_ref(), session, cursor, event);
    }

    /// An event the daemon made itself, which carries no cursor.
    fn emit_made(&self, session: &str, event: Event) {
        emit(self.sender().as_ref(), session, None, event);
    }

    /// Sends a call and returns where its answer arrives.
    fn register(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<oneshot::Receiver<Result<Value, Error>>, Error> {
        let (reply, answered) = oneshot::channel();
        let id = {
            let mut state = self.lock();
            if let Some(stderr) = &state.closed {
                return Err(Error::Closed {
                    stderr: stderr.clone(),
                });
            }
            state.next_id += 1;
            let id = format!("{}-{}", prefix(), state.next_id);
            let mut call = Call::of(method, &params);
            call.reply = Some(reply);
            state.calls.insert(id.clone(), call);
            id
        };
        let sent =
            self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        if let Err(error) = sent {
            self.lock().calls.remove(&id);
            return Err(error);
        }
        Ok(answered)
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
        let sent = self.send(json!({"jsonrpc": "2.0", "id": permission.rpc_id,
                                    "result": {"outcome": outcome}}));
        // A send that failed means the agent has gone, which cancels the request.
        let decision = if sent.is_ok() {
            decision
        } else {
            chat::Decision::Cancel
        };
        self.emit_resolved(request, &permission, decision);
        sent
    }

    fn emit_resolved(&self, request: &str, permission: &Permission, decision: chat::Decision) {
        self.emit_made(
            &permission.session,
            Event::RequestResolved(chat::RequestResolved {
                request_id: request.to_owned(),
                request_type: permission.request_type,
                decision,
            }),
        );
    }

    /// One line of stdout. `end` is where it ends in a keeper's `out`.
    fn dispatch(&self, line: &[u8], end: Option<u64>) {
        self.lock().line = end.map(|end| (end, 0));
        self.dispatch_line(line);
        self.lock().line = None;
    }

    fn dispatch_line(&self, line: &[u8]) {
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
                let Some(call) = self.lock().calls.remove(&key(&id)) else {
                    return;
                };
                let answer = match message.error {
                    Some(error) => Err(Error::Rpc {
                        code: error.code,
                        message: error.message,
                    }),
                    None => Ok(message.result.unwrap_or(Value::Null)),
                };
                match (call.method.as_str(), &call.session, &call.cwd, &answer) {
                    ("session/new", _, Some(cwd), Ok(result)) => {
                        if let Some(session) = result.get("sessionId").and_then(Value::as_str) {
                            self.lock()
                                .worktrees
                                .insert(session.to_owned(), cwd.clone());
                        }
                    }
                    ("session/prompt", Some(session), _, answer) => {
                        self.emit(session, Event::TurnCompleted(completed(answer)));
                    }
                    _ => {}
                }
                if let Some(reply) = call.reply {
                    let _ = reply.send(answer);
                }
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
        let (request_id, scope, answered) = {
            let mut state = self.lock();
            let worktree = state.worktrees.get(&asked.session_id);
            let paths = (asked.tool_call.locations.iter().flatten())
                .chain(asked.tool_call.content.iter().flatten())
                .filter_map(|pathed| pathed.path.as_deref());
            // Auto-accept edits may not delete, move, or write outside the worktree.
            let scope = match (&asked.tool_call.kind, worktree) {
                (Some(ToolKind::Edit), Some(worktree)) if inside(worktree, paths) => {
                    chat::Scope::WorktreeEdit
                }
                _ => chat::Scope::Other,
            };
            state.next_request += 1;
            let request_id = state.next_request.to_string();
            let answered = state.answered.remove(&key(&rpc_id));
            if answered.is_none() {
                state.permissions.insert(
                    request_id.clone(),
                    Permission {
                        rpc_id,
                        session: asked.session_id.clone(),
                        request_type,
                        options: options.clone(),
                    },
                );
            }
            (request_id, scope, answered)
        };
        let decision = answered.map(|answer| {
            let picked = answer["outcome"]["optionId"].as_str();
            options
                .iter()
                .find(|option| Some(option.option_id.as_str()) == picked)
                .map_or(chat::Decision::Cancel, |option| option.decision)
        });
        self.emit(
            &asked.session_id,
            Event::RequestOpened(chat::RequestOpened {
                request_id: request_id.clone(),
                request_type,
                item_id: Some(asked.tool_call.tool_call_id),
                title: None,
                detail: asked.tool_call.title,
                options,
                scope,
            }),
        );
        if let Some(decision) = decision {
            self.emit_made(
                &asked.session_id,
                Event::RequestResolved(chat::RequestResolved {
                    request_id,
                    request_type,
                    decision,
                }),
            );
        }
    }

    /// Cancels every waiting request, ends [`Events`] and fails every call
    /// still waiting, now and later, with `stderr`.
    fn close(&self, stderr: String) {
        let (calls, permissions) = {
            let mut state = self.lock();
            state.closed = Some(stderr.clone());
            (
                std::mem::take(&mut state.calls),
                std::mem::take(&mut state.permissions),
            )
        };
        // A turn's failure follows its requests, and ends the events.
        for (request, permission) in permissions {
            self.emit_resolved(&request, &permission, chat::Decision::Cancel);
        }
        let closed = Error::Closed {
            stderr: stderr.clone(),
        };
        for call in calls.values() {
            if let ("session/prompt", Some(session)) = (call.method.as_str(), &call.session) {
                self.emit_made(session, Event::TurnCompleted(failed(&closed)));
            }
        }
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        for call in calls.into_values() {
            if let Some(reply) = call.reply {
                let _ = reply.send(Err(Error::Closed {
                    stderr: stderr.clone(),
                }));
            }
        }
    }
}

async fn read<R: AsyncRead + Unpin>(
    reader: R,
    from: Option<u64>,
    stderr: Option<Said>,
    shared: Arc<Shared>,
) {
    keep::read_lines(reader, from, |line, end| shared.dispatch(line, end)).await;
    let said = match stderr {
        Some(said) => tokio::time::timeout(STDERR_GRACE, said)
            .await
            .unwrap_or_default(),
        None => String::new(),
    };
    shared.close(said);
}

/// A kept agent's events so far, parsed again from its journals: `out` from
/// byte 0, and `input`, the `in` the daemons wrote, for the calls they made
/// and the requests they answered. The same bytes always give the same
/// events with the same cursors.
#[derive(Debug)]
pub struct Replayed {
    run: String,
    /// Every event `out`'s whole lines make, in order. A prompt's text and
    /// `turn.started` carry no cursor and stand before the first line that
    /// followed the prompt.
    pub events: Vec<ThreadEvent>,
    /// The offset after the last whole line, where a reader carries on.
    pub offset: u64,
    /// How many prompts `in` holds.
    pub prompts: usize,
    state: State,
}

impl Replayed {
    /// Whether a prompt is still waiting for the agent's answer.
    pub fn prompting(&self) -> bool {
        self.state
            .calls
            .values()
            .any(|call| call.method == "session/prompt")
    }
}

pub fn replay(run: &str, out: &[u8], input: &[u8]) -> Replayed {
    #[derive(Deserialize)]
    struct Sent {
        id: Option<Value>,
        method: Option<String>,
        #[serde(default)]
        params: Value,
        result: Option<Value>,
    }

    let mut state = State::default();
    let mut prompts = VecDeque::new();
    let (sent, _) = keep::lines(input);
    for (line, _) in sent {
        let Ok(sent) = serde_json::from_slice::<Sent>(line) else {
            continue;
        };
        match (sent.id, sent.method) {
            (Some(id), Some(method)) => {
                let call = Call::of(&method, &sent.params);
                if let ("session/load", Some(session), Some(cwd)) =
                    (method.as_str(), &call.session, &call.cwd)
                {
                    state.worktrees.insert(session.clone(), cwd.clone());
                }
                if method == "session/prompt" {
                    let text = sent.params["prompt"][0]["text"]
                        .as_str()
                        .unwrap_or_default();
                    prompts.push_back((key(&id), call.session.clone(), text.to_owned()));
                }
                state.calls.insert(key(&id), call);
            }
            (Some(id), None) => {
                state
                    .answered
                    .insert(key(&id), sent.result.unwrap_or(Value::Null));
            }
            _ => {}
        }
    }
    let total = prompts.len();

    let (out_tx, _) = mpsc::unbounded_channel();
    let (events, mut received) = mpsc::unbounded_channel();
    let shared = Shared {
        run: Some(run.to_owned()),
        state: Mutex::new(state),
        out: out_tx,
        events: Mutex::new(Some(events)),
    };
    let mut set_up = false;
    let mut turn: Option<String> = None;
    let mut n = 0;
    let mut begin = |shared: &Shared, turn: &mut Option<String>| {
        if let Some((id, session, text)) = prompts.pop_front() {
            n += 1;
            let session = session.unwrap_or_default();
            shared.emit_made(
                &session,
                Event::ContentDelta(chat::ContentDelta {
                    stream_kind: chat::StreamKind::UserText,
                    delta: text,
                    item_id: Some(format!("user:{run}:{n}")),
                }),
            );
            shared.emit_made(&session, Event::TurnStarted);
            *turn = Some(id);
        }
    };
    let (found, offset) = keep::lines(out);
    for (line, end) in found {
        if set_up && turn.is_none() {
            begin(&shared, &mut turn);
        }
        let answers = serde_json::from_slice::<Sent>(line)
            .ok()
            .filter(|sent| sent.method.is_none())
            .and_then(|sent| sent.id)
            .map(|id| key(&id));
        let method = answers
            .as_ref()
            .and_then(|id| shared.lock().calls.get(id).map(|call| call.method.clone()));
        shared.dispatch(line, Some(end));
        match method.as_deref() {
            Some("session/new" | "session/load") => set_up = true,
            Some("session/prompt") if turn == answers => turn = None,
            _ => {}
        }
    }
    if set_up && turn.is_none() {
        begin(&shared, &mut turn);
    }
    let mut replayed = Vec::new();
    while let Ok(event) = received.try_recv() {
        replayed.push(event);
    }
    let state = std::mem::take(&mut *shared.lock());
    Replayed {
        run: run.to_owned(),
        events: replayed,
        offset,
        prompts: total,
        state,
    }
}

async fn write<W: AsyncWrite + Unpin>(mut writer: W, mut lines: mpsc::UnboundedReceiver<String>) {
    while let Some(mut line) = lines.recv().await {
        line.push('\n');
        if writer.write_all(line.as_bytes()).await.is_err() || writer.flush().await.is_err() {
            return;
        }
    }
}

/// The end of what the agent and `ssh` said on the way out, once stderr closes.
/// [`crate::claude`] reads a turn's failure the same way.
pub(crate) fn diagnosis(
    stderr: tokio::process::ChildStderr,
    log: ssh::LogFile,
) -> JoinHandle<String> {
    tokio::spawn(async move {
        let tail = tail(stderr).await;
        [String::from_utf8_lossy(&tail).trim(), log.read().trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    })
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
#[serde(rename_all = "snake_case")]
enum StopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
    #[serde(other)]
    Other,
}

impl From<StopReason> for chat::StopReason {
    fn from(reason: StopReason) -> Self {
        match reason {
            StopReason::EndTurn | StopReason::Other => Self::EndTurn,
            StopReason::MaxTokens => Self::MaxTokens,
            StopReason::MaxTurnRequests => Self::MaxTurnRequests,
            StopReason::Refusal => Self::Refusal,
            StopReason::Cancelled => Self::Cancelled,
        }
    }
}

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
    locations: Option<Vec<Pathed>>,
    content: Option<Vec<Pathed>>,
}

/// A location, or a content block, of which only a diff names a path.
#[derive(Deserialize)]
struct Pathed {
    path: Option<String>,
}

/// Whether there is a path, and every one lies below `worktree`. Lexical,
/// since the machine is not asked: a `..` above the root, or a relative
/// path, is outside.
fn inside<'a>(worktree: &str, paths: impl Iterator<Item = &'a str>) -> bool {
    fn parts(path: &str) -> Option<Vec<&str>> {
        let mut parts = Vec::new();
        for part in path.strip_prefix('/')?.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop()?;
                }
                part => parts.push(part),
            }
        }
        Some(parts)
    }
    let Some(root) = parts(worktree) else {
        return false;
    };
    let mut any = false;
    for path in paths {
        match parts(path) {
            Some(path) if path.len() > root.len() && path.starts_with(&root) => any = true,
            _ => return false,
        }
    }
    any
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
        RequestOpened, RequestOption, RequestResolved, RequestType, Scope, StopReason, StreamKind,
        TokenUsage, TurnCompleted, TurnState,
    };
    use tokio::io::{AsyncBufReadExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

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

    fn pair_with_stderr(stderr: Option<Said>) -> (Agent, Events, Fake) {
        let (client, agent) = tokio::io::duplex(1 << 16);
        let (client_read, client_write) = tokio::io::split(client);
        let (agent_read, agent_write) = tokio::io::split(agent);
        let parse = (None, None, State::default());
        let (client, events) = Agent::wire(
            Harness::Opencode,
            client_read,
            client_write,
            parse,
            stderr,
            None,
        );
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
            Capabilities {
                load_session: true,
                login: Some("Run `opencode auth login` in the terminal".to_owned()),
            }
        );
    }

    #[tokio::test]
    async fn an_auth_method_without_a_description_names_no_login() {
        let (agent, _events, mut fake) = pair();
        let (answer, ()) = tokio::join!(agent.initialize(), async {
            let request = fake.receive().await;
            fake.reply(
                &request,
                json!({"protocolVersion": 1, "agentCapabilities": {},
                       "authMethods": [{"id": "api-key", "name": "API key"},
                                       {"id": "chat-gpt", "name": "ChatGPT", "description": ""}]}),
            )
            .await;
        });
        assert_eq!(answer.expect("read").login, None);
    }

    #[test]
    fn a_harness_is_named_and_read_back_and_an_unknown_one_is_refused() {
        for harness in [
            Harness::Codex,
            Harness::Gemini,
            Harness::Grok,
            Harness::Opencode,
        ] {
            assert_eq!(harness.name().parse::<Harness>(), Ok(harness));
        }
        assert!("claude".parse::<Harness>().is_err());
        assert!("Codex".parse::<Harness>().is_err());
    }

    #[test]
    fn each_harness_names_its_login() {
        assert_eq!(
            login_command(Some(Harness::Opencode)),
            "opencode auth login"
        );
        assert_eq!(login_command(Some(Harness::Codex)), "codex login");
        assert_eq!(login_command(None), "run claude and type /login");
    }

    /// R19 §1's verified refusals, and two that are not about a login.
    #[test]
    fn an_auth_refusal_is_told_apart() {
        let rpc = |code, message: &str| Error::Rpc {
            code,
            message: message.to_owned(),
        };
        assert!(rpc(-32000, "Authentication required").is_auth());
        assert!(rpc(-32603, "Gemini API key is missing or not configured.").is_auth());
        assert!(rpc(-32603, "Authentication required").is_auth());
        assert!(!rpc(-32603, "Internal error").is_auth());
        assert!(
            !Error::Closed {
                stderr: "sh: opencode: not found".to_owned()
            }
            .is_auth()
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
        let stderr: Said = Box::pin(async { "sh: opencode: not found".to_owned() });
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
                cursor: None,
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
                title: None,
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
                scope: Scope::Other,
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

    #[test]
    fn inside_holds_only_when_every_path_is_below_the_worktree() {
        let inside = |paths: &[&str]| super::inside("/w/t", paths.iter().copied());
        assert!(inside(&["/w/t/a.txt", "/w/t/./src/../b.txt"]));
        assert!(!inside(&[]), "no path");
        assert!(!inside(&["/w/t/a.txt", "/w/u/a.txt"]), "one outside");
        assert!(!inside(&["/w/t/../u/a.txt"]), "climbs out");
        assert!(!inside(&["/w/t2/a.txt"]), "a sibling sharing a prefix");
        assert!(!inside(&["/w/t"]), "the worktree itself");
        assert!(!inside(&["/../../w/t/a.txt"]), "a `..` above the root");
        assert!(!inside(&["w/t/a.txt"]), "relative");
    }

    /// Y-453: Auto-accept edits may skip the person only for an edit whose
    /// every path is inside the session's worktree.
    #[tokio::test]
    async fn only_an_edit_inside_the_worktree_is_a_worktree_edit() {
        let (agent, mut events, mut fake) = pair();
        let ((), ()) = tokio::join!(
            async {
                agent.load_session(SESSION, "/w").await.expect("loads");
            },
            async {
                let request = fake.receive().await;
                fake.send(json!({"jsonrpc": "2.0", "id": request["id"], "result": null}))
                    .await;
            }
        );
        let ask = |id: u64, kind: &str, path: &str| {
            let mut asked = asked(id);
            asked["params"]["toolCall"]["kind"] = json!(kind);
            asked["params"]["toolCall"]["locations"] = json!([{"path": path}]);
            asked
        };
        for (id, kind, path, scope) in [
            (0, "edit", "/w/hello.txt", Scope::WorktreeEdit),
            (1, "delete", "/w/hello.txt", Scope::Other),
            (2, "move", "/w/hello.txt", Scope::Other),
            (3, "edit", "/w/../etc/hosts", Scope::Other),
            (4, "edit", "/etc/hosts", Scope::Other),
        ] {
            fake.send(ask(id, kind, path)).await;
            let Event::RequestOpened(opened) = next(&mut events).await.event else {
                panic!("a request opens");
            };
            assert_eq!(opened.scope, scope, "{kind} {path}");
        }

        // A diff names a path too, and one outside is enough to ask.
        let mut asked = ask(5, "edit", "/w/hello.txt");
        asked["params"]["toolCall"]["content"][0]["path"] = json!("/home/u/.bashrc");
        fake.send(asked).await;
        let Event::RequestOpened(opened) = next(&mut events).await.event else {
            panic!("a request opens");
        };
        assert_eq!(opened.scope, Scope::Other);
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
                message: None,
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
                message: Some("the agent refused: Internal error (-32603)".to_owned()),
            })
        );
    }

    /// A newer agent's stop reason is not a malformed answer.
    #[tokio::test]
    async fn an_unknown_stop_reason_completes_the_turn() {
        let (agent, mut events, mut fake) = pair();
        let (stopped, ()) = tokio::join!(agent.prompt(SESSION, "hi"), async {
            let prompt = fake.receive().await;
            fake.reply(&prompt, json!({"stopReason": "paused_for_coffee"}))
                .await;
        });
        assert_eq!(stopped.expect("the turn ended"), StopReason::EndTurn);
        assert_eq!(next(&mut events).await.event, Event::TurnStarted);
        assert_eq!(
            next(&mut events).await.event,
            Event::TurnCompleted(TurnCompleted {
                state: TurnState::Completed,
                stop_reason: Some(StopReason::EndTurn),
                message: None,
            })
        );
    }

    fn cancelled(event: &Event) -> bool {
        matches!(
            event,
            Event::RequestResolved(RequestResolved {
                decision: Decision::Cancel,
                ..
            })
        )
    }

    async fn ended(events: &mut Events) {
        let end = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("the channel ends within 5 s");
        assert_eq!(end, None);
    }

    #[tokio::test]
    async fn an_agent_that_dies_idle_cancels_its_requests_and_ends_the_events() {
        let (_agent, mut events, mut fake) = pair();
        fake.send(asked(3)).await;
        assert!(matches!(
            next(&mut events).await.event,
            Event::RequestOpened(_)
        ));
        drop(fake);
        assert!(cancelled(&next(&mut events).await.event));
        ended(&mut events).await;
    }

    #[tokio::test]
    async fn an_agent_that_dies_mid_turn_cancels_then_fails_the_turn_then_ends() {
        let (agent, mut events, mut fake) = pair();
        let (stopped, ()) = tokio::join!(agent.prompt(SESSION, "hi"), async {
            fake.receive().await;
            assert_eq!(next(&mut events).await.event, Event::TurnStarted);
            fake.send(asked(4)).await;
            assert!(matches!(
                next(&mut events).await.event,
                Event::RequestOpened(_)
            ));
            drop(fake);
        });
        assert!(matches!(stopped, Err(Error::Closed { .. })), "{stopped:?}");
        assert!(cancelled(&next(&mut events).await.event));
        assert!(matches!(
            next(&mut events).await.event,
            Event::TurnCompleted(TurnCompleted {
                state: TurnState::Failed,
                ..
            })
        ));
        ended(&mut events).await;
    }

    #[tokio::test]
    async fn cancel_resolves_every_request_when_the_writer_has_gone() {
        let (mut agent, mut events, mut fake) = pair();
        fake.send(asked(5)).await;
        fake.send(asked(6)).await;
        for _ in 0..2 {
            assert!(matches!(
                next(&mut events).await.event,
                Event::RequestOpened(_)
            ));
        }
        agent.tasks[1].abort();
        let _ = (&mut agent.tasks[1]).await;

        let cancel = agent.cancel(SESSION);
        assert!(matches!(cancel, Err(Error::Closed { .. })), "{cancel:?}");
        for _ in 0..2 {
            assert!(cancelled(&next(&mut events).await.event));
        }
        assert!(agent.shared.lock().permissions.is_empty());
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
                cursor: None,
                event: Event::ThreadStarted {
                    thread: SESSION.to_owned(),
                    harness: "opencode".to_owned(),
                }
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

    const RUN: &str = "Y0123456789abcdef";

    #[test]
    fn a_kept_agent_starts_in_its_worktree_and_is_searched_for() {
        let command = Harness::Opencode.kept_command("/w/it's");
        assert!(
            command.starts_with("cd '/w/it'\\''s' || exit 1\nc=$("),
            "{command}"
        );
        assert!(command.ends_with("exec \"$c\" acp\n"), "{command}");
        assert!(
            Harness::Codex
                .kept_command("/w")
                .ends_with("exec \"$c\" \n")
        );
    }

    /// A kept agent over pipes: the agent's stdout is `out`, and what the
    /// client writes is what `in` would get.
    fn kept() -> (Agent, Events, Fake) {
        let (client, agent) = tokio::io::duplex(1 << 16);
        let (client_read, client_write) = tokio::io::split(client);
        let (agent_read, agent_write) = tokio::io::split(agent);
        let said: Said = Box::pin(async { String::new() });
        let (client, events) = Agent::kept(Harness::Opencode, client_read, client_write, RUN, said);
        let fake = Fake {
            from_client: BufReader::new(agent_read),
            to_client: agent_write,
        };
        (client, events, fake)
    }

    fn line(message: &Value) -> String {
        format!("{message}\n")
    }

    /// ADR-0035 decision 9: this daemon's ids carry a prefix of its own, so
    /// they never meet an earlier daemon's in `in`.
    #[tokio::test]
    async fn a_call_id_carries_this_daemons_prefix() {
        let (agent, _events, mut fake) = pair();
        let (_, request) = tokio::join!(agent.new_session("/w"), async {
            let request = fake.receive().await;
            fake.reply(&request, json!({"sessionId": SESSION})).await;
            request
        });
        assert_eq!(request["id"], json!(format!("{}-1", prefix())));
        assert!(prefix().starts_with('Y'), "{}", prefix());
    }

    /// The answer to `session/prompt` ends the turn with a cursor, and a
    /// replay of the same journals gives the same events, with the prompt's
    /// text and `turn.started` before the turn's first line.
    #[tokio::test]
    async fn a_kept_prompt_ends_on_its_answer_and_replays_the_same() {
        let (agent, mut events, mut fake) = kept();
        let mut input = String::new();
        let mut out = String::new();
        let (session, ()) = tokio::join!(agent.new_session("/w"), async {
            let request = fake.receive().await;
            input.push_str(&line(&request));
            let answer = json!({"jsonrpc": "2.0", "id": request["id"],
                                "result": {"sessionId": SESSION}});
            out.push_str(&line(&answer));
            fake.send(answer).await;
        });
        let session = session.expect("a session");
        let (stopped, ()) = tokio::join!(agent.prompt(&session, "hello"), async {
            let request = fake.receive().await;
            input.push_str(&line(&request));
            for message in [
                json!({"jsonrpc": "2.0", "method": "session/update", "params": {
                    "sessionId": SESSION, "update": {"sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "hi"}, "messageId": "m1"}}}),
                json!({"jsonrpc": "2.0", "id": request["id"],
                       "result": {"stopReason": "end_turn"}}),
            ] {
                out.push_str(&line(&message));
                fake.send(message).await;
            }
        });
        assert_eq!(stopped.expect("the turn ends"), StopReason::EndTurn);
        let mut live = Vec::new();
        loop {
            let event = next(&mut events).await;
            let done = matches!(event.event, Event::TurnCompleted(_));
            live.push(event);
            if done {
                break;
            }
        }
        let completed = live.last().expect("turn.completed");
        assert_eq!(
            completed.cursor.as_deref(),
            Some(format!("{RUN}:{}:0", out.len()).as_str())
        );

        let replayed = replay(RUN, out.as_bytes(), input.as_bytes());
        assert_eq!(replayed.offset, out.len() as u64);
        assert_eq!(replayed.prompts, 1);
        assert!(!replayed.prompting());
        let cursored = |events: &[ThreadEvent]| -> Vec<ThreadEvent> {
            events
                .iter()
                .filter(|event| event.cursor.is_some())
                .cloned()
                .collect()
        };
        assert_eq!(cursored(&replayed.events), cursored(&live));
        let kinds: Vec<&Event> = replayed.events.iter().map(|event| &event.event).collect();
        assert_eq!(
            kinds[..2],
            [
                &Event::ContentDelta(ContentDelta {
                    stream_kind: StreamKind::UserText,
                    delta: "hello".to_owned(),
                    item_id: Some(format!("user:{RUN}:1")),
                }),
                &Event::TurnStarted,
            ]
        );
        assert!(
            replayed.events[..2]
                .iter()
                .all(|event| event.cursor.is_none())
        );
    }

    /// ADR-0035 decision 9: a prompt an earlier daemon sent, with no answer
    /// in `out`, is still running, and its answer ends the turn here.
    #[tokio::test]
    async fn an_adopted_agent_ends_the_turn_an_earlier_daemon_sent() {
        let input = [
            line(
                &json!({"jsonrpc": "2.0", "id": "Yold-1", "method": "session/new",
                         "params": {"cwd": "/w", "mcpServers": []}}),
            ),
            line(
                &json!({"jsonrpc": "2.0", "id": "Yold-2", "method": "session/prompt",
                         "params": {"sessionId": SESSION,
                                    "prompt": [{"type": "text", "text": "hello"}]}}),
            ),
        ]
        .concat();
        let out = line(&json!({"jsonrpc": "2.0", "id": "Yold-1",
                               "result": {"sessionId": SESSION}}));
        let replayed = replay(RUN, out.as_bytes(), input.as_bytes());
        assert!(replayed.prompting());
        assert!(matches!(
            replayed.events.last().map(|event| &event.event),
            Some(Event::TurnStarted)
        ));

        let (client, agent) = tokio::io::duplex(1 << 16);
        let (client_read, client_write) = tokio::io::split(client);
        let (_agent_read, mut agent_write) = tokio::io::split(agent);
        let said: Said = Box::pin(async { String::new() });
        let (_agent, mut events) =
            Agent::resume(Harness::Opencode, client_read, client_write, replayed, said);
        let answer = line(&json!({"jsonrpc": "2.0", "id": "Yold-2",
                                  "result": {"stopReason": "end_turn"}}));
        agent_write
            .write_all(answer.as_bytes())
            .await
            .expect("written");
        let ended = next(&mut events).await;
        assert_eq!(
            ended,
            ThreadEvent {
                thread_id: SESSION.to_owned(),
                cursor: Some(format!("{RUN}:{}:0", out.len() + answer.len())),
                event: Event::TurnCompleted(TurnCompleted {
                    state: TurnState::Completed,
                    stop_reason: Some(StopReason::EndTurn),
                    message: None,
                }),
            }
        );
    }

    /// A permission `in` already answered is opened and resolved on a replay,
    /// and an adopting daemon cannot answer it again.
    #[tokio::test]
    async fn a_replayed_permission_already_answered_is_not_answered_again() {
        let out = line(&asked(7));
        let input = line(&json!({"jsonrpc": "2.0", "id": 7,
            "result": {"outcome": {"outcome": "selected", "optionId": "allow-once"}}}));
        let replayed = replay(RUN, out.as_bytes(), input.as_bytes());
        let kinds: Vec<(&Option<String>, &Event)> = replayed
            .events
            .iter()
            .map(|event| (&event.cursor, &event.event))
            .collect();
        assert!(matches!(kinds[0], (Some(_), Event::RequestOpened(_))));
        assert_eq!(
            kinds[1],
            (
                &None,
                &Event::RequestResolved(RequestResolved {
                    request_id: "1".to_owned(),
                    request_type: RequestType::FileChangeApproval,
                    decision: Decision::Accept,
                })
            )
        );

        let (client, _agent) = tokio::io::duplex(1 << 16);
        let (client_read, client_write) = tokio::io::split(client);
        let said: Said = Box::pin(async { String::new() });
        let (agent, _events) =
            Agent::resume(Harness::Opencode, client_read, client_write, replayed, said);
        assert!(matches!(
            agent.answer("1", Answer::Selected("allow-once".to_owned())),
            Err(Error::NotPending(_))
        ));
    }

    /// An open permission is still open after a replay, and the request id
    /// the browser saw still names it.
    #[tokio::test]
    async fn a_replayed_permission_with_no_answer_is_still_open() {
        let out = line(&asked(7));
        let replayed = replay(RUN, out.as_bytes(), b"");
        let (client, agent_end) = tokio::io::duplex(1 << 16);
        let (client_read, client_write) = tokio::io::split(client);
        let (agent_read, _agent_write) = tokio::io::split(agent_end);
        let said: Said = Box::pin(async { String::new() });
        let (agent, _events) =
            Agent::resume(Harness::Opencode, client_read, client_write, replayed, said);
        agent
            .answer("1", Answer::Selected("allow-once".to_owned()))
            .expect("still open");
        let mut sent = String::new();
        BufReader::new(agent_read)
            .read_line(&mut sent)
            .await
            .expect("a line");
        let sent: Value = serde_json::from_str(&sent).expect("JSON");
        assert_eq!(sent["id"], json!(7));
        assert_eq!(sent["result"]["outcome"]["optionId"], json!("allow-once"));
    }
}
