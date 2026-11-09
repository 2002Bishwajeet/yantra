//! A chat thread's Claude Code over its `stream-json` (ADR-0026 decision 2),
//! as [`chat`] events.
//!
//! **This is the one module that knows stream-json's shapes**, as
//! [`crate::acp`] is for ACP v1. A [`Session`] is one `claude -p` in a
//! thread's worktree ([`crate::thread`]), held by a keeper ([`keep`]), and it
//! lives across turns (ADR-0041). Each turn is one user line on stdin, and
//! nothing closes stdin after its `result`. Claude opens every turn with
//! `system/init`, so an `init` that follows a `result` opens the next one. An
//! `init` with no user line waiting is a wake turn: Claude starts it when a
//! background task ends.
//!
//! Measured on claude 2.1.291 (R20) and 2.1.319 (ADR-0041): with
//! `--permission-prompt-tool stdio` a permission arrives on stdout as a
//! `control_request`, and the answer on stdin runs or refuses the tool.
//! `set_permission_mode`, `set_model`, `apply_flag_settings` and `stop_task`
//! are answered on stdin too. The process exits once stdin closes. No prompt,
//! output or file content is ever logged.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::chat::{self, Event, ThreadEvent};
use crate::delegate::Place;
use crate::keep::{self, Keeper};
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

    #[error("claude has ended, so it takes no more lines")]
    Ended,

    #[error("no permission request `{0}` is waiting for an answer")]
    NotPending(String),

    #[error("no background task `{0}` is running")]
    NoTask(String),

    #[error("{0} is not a chat thread")]
    NotAThread(String),
}

/// Every event of the session, in order. It ends once Claude's stdout has.
pub type Events = mpsc::UnboundedReceiver<ThreadEvent>;

/// What the agent said on stderr, read once its stdout has ended.
pub type Said = Pin<Box<dyn Future<Output = String> + Send>>;

/// One turn the person sent, and the modes it runs in.
#[derive(Debug, Clone, Copy)]
pub struct Prompt<'a> {
    pub text: &'a str,
    pub mode: chat::PermissionMode,
    pub interaction: chat::Interaction,
    pub model: Option<&'a chat::Model>,
    pub effort: Option<chat::Effort>,
}

/// One running `claude -p`. Dropping it kills the local `ssh` and leaves the
/// remote `claude` to end when its stdin closes (I-27); [`Session::close`] is
/// what ends it on purpose.
#[derive(Debug)]
pub struct Session {
    shared: Arc<Shared>,
    tasks: [JoinHandle<()>; 2],
    // Held for `kill_on_drop`.
    _child: Option<tokio::process::Child>,
}

impl Drop for Session {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl Session {
    /// Starts Claude in the thread's worktree on the machine `ssh` reaches,
    /// over the `ssh` pipe itself, and sends it `first`.
    pub fn start(ssh: &Ssh, place: &Place, first: &Prompt) -> Result<(Self, Events), Error> {
        let keeper = Keeper::of(place).ok_or_else(|| Error::NotAThread(place.id.clone()))?;
        let ssh::Piped {
            child,
            stdin,
            stdout,
            stderr,
            log,
        } = ssh.stdio(&command(
            &place.worktree,
            &keeper,
            first.mode,
            first.interaction,
            first.model,
            first.effort,
            None,
            None,
        ))?;
        let diagnosis = acp::diagnosis(stderr, log);
        let said: Said = Box::pin(async move { diagnosis.await.unwrap_or_default() });
        let (session, events) = Self::wire(
            stdout,
            stdin,
            Parse::new(thread::name(place), None, State::default()),
            Some(said),
            Some(child),
        );
        session.first(first)?;
        Ok((session, events))
    }

    /// A session held by a keeper ([`keep`]) that [`command`] started with
    /// `first`'s modes: `reader` follows its `out` from byte 0 and `writer`
    /// appends to its `in`. Each event read carries a cursor in `run`, and
    /// `said` is what the keeper's `err` holds.
    pub fn kept<R, W>(
        reader: R,
        writer: W,
        thread: &str,
        run: &str,
        first: &Prompt,
        said: Said,
    ) -> (Self, Events)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let parse = Parse::new(thread, Some((run, 0)), State::default());
        let (session, events) = Self::wire(reader, writer, parse, Some(said), None);
        // The writer is fresh, so the line is queued.
        let _ = session.first(first);
        (session, events)
    }

    /// A kept session this daemon did not start, continued where [`replay`]
    /// stopped: `reader` follows `out` from [`Replayed::offset`]. The events
    /// already replayed are not sent again.
    pub fn resume<R, W>(reader: R, writer: W, replayed: Replayed, said: Said) -> (Self, Events)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let Replayed {
            thread,
            run,
            offset,
            state,
            ..
        } = replayed;
        let parse = Parse::new(&thread, Some((&run, offset)), state);
        Self::wire(reader, writer, parse, Some(said), None)
    }

    /// The generic half: a session on any pair of streams.
    pub fn over<R, W>(reader: R, writer: W, thread: &str, text: &str) -> (Self, Events)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let parse = Parse::new(thread, None, State::default());
        let (session, events) = Self::wire(reader, writer, parse, None, None);
        // The writer is fresh, so the line is queued.
        let _ = session.prompt(text);
        (session, events)
    }

    fn wire<R, W>(
        reader: R,
        writer: W,
        parse: Parse,
        stderr: Option<Said>,
        child: Option<tokio::process::Child>,
    ) -> (Self, Events)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (out, lines) = mpsc::unbounded_channel();
        let (events, received) = mpsc::unbounded_channel();
        let from = parse.from;
        let shared = Arc::new(Shared {
            thread: parse.thread,
            run: parse.run,
            out: Mutex::new(Some(out)),
            events: Mutex::new(Some(events)),
            state: Mutex::new(parse.state),
            requests: AtomicU64::new(0),
        });
        let tasks = [
            tokio::spawn(read(reader, from, stderr, Arc::clone(&shared))),
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

    /// The first prompt, in the mode the command line already set.
    fn first(&self, first: &Prompt) -> Result<(), Error> {
        let mut state = self.shared.lock();
        state.flag = Some(flag(first.mode, first.interaction).to_owned());
        state.picked = (first.model.cloned(), first.effort);
        drop(state);
        self.prompt(first.text)
    }

    fn prompt(&self, text: &str) -> Result<(), Error> {
        self.shared.lock().waiting += 1;
        self.shared.send(&user(text))
    }

    /// Sends the next turn. A mode, model or effort other than the one Claude
    /// runs with is set first, on the live process (ADR-0041 decision 5,
    /// Y-564); `null` is Claude's default.
    pub fn send_turn(&self, prompt: &Prompt) -> Result<(), Error> {
        let flag = flag(prompt.mode, prompt.interaction);
        let (model, effort) = (prompt.model.cloned(), prompt.effort);
        let (mode_changed, (was_model, was_effort)) = {
            let mut state = self.shared.lock();
            let mode_changed = state.flag.as_deref() != Some(flag);
            state.flag = Some(flag.to_owned());
            let was = std::mem::replace(&mut state.picked, (model.clone(), effort));
            (mode_changed, was)
        };
        if mode_changed {
            self.shared.request(
                "mode",
                json!({"subtype": "set_permission_mode", "mode": flag}),
            )?;
        }
        if was_model != model {
            self.shared
                .request("model", json!({"subtype": "set_model", "model": model}))?;
        }
        if was_effort != effort {
            self.shared.request(
                "effort",
                json!({"subtype": "apply_flag_settings",
                    "settings": {"effortLevel": effort}}),
            )?;
        }
        self.prompt(prompt.text)
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

    /// Refuses whatever is waiting and asks Claude to stop the turn. Stdin
    /// stays open, so the background tasks run on (ADR-0041 decision 6).
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
    }

    /// Asks Claude to stop the background task `task`.
    pub fn stop_task(&self, task: &str) -> Result<(), Error> {
        if !self
            .shared
            .lock()
            .background
            .iter()
            .any(|running| running.task_id == task)
        {
            return Err(Error::NoTask(task.to_owned()));
        }
        self.shared
            .request("stop", json!({"subtype": "stop_task", "task_id": task}))
    }

    /// Closes stdin once every line before it is written, which ends Claude.
    pub fn close(&self) {
        self.shared.close();
    }

    /// The ids of the background tasks that still run.
    pub fn background(&self) -> Vec<String> {
        background_ids(&self.shared.lock())
    }

    /// Claude's own id of the conversation, from the last `init`.
    pub fn session_id(&self) -> Option<String> {
        self.shared.lock().session.clone()
    }

    /// The `--model` and `--effort` Claude runs with now; `None` is Claude's default.
    pub fn picked(&self) -> (Option<chat::Model>, Option<chat::Effort>) {
        self.shared.lock().picked.clone()
    }

    /// When Claude last wrote any line, an event or not.
    pub fn heard(&self) -> Option<tokio::time::Instant> {
        self.shared.lock().heard
    }
}

/// `cd` because `claude` has no cwd flag, and the transcript directory is
/// derived from the cwd. `claude` is searched for as I-34 requires, and a musl
/// machine gets the ripgrep variable `agent::launch_command` gives the TUI.
/// `--add-dir` names the thread's images directory, made here, so Claude reads
/// an image pasted in any later turn without a prompt or a new process
/// (Y-424, ADR-0041 decision 5). `--resume` names `session`, and a thread
/// older than its id resumes the newest transcript in the worktree.
/// `Auto` and `AutoAcceptEdits` run in Claude's own mode (Y-453); see [`answers`].
/// The other two name `default`, so a machine's `permissions.defaultMode`
/// cannot turn approval off. `Plan` is Claude's own `plan` whatever the mode
/// (Y-565). `model` and `effort` reach Claude only when the person picked them
/// (Y-564). `mcp` adds the room server and lets a woken turn
/// use its tools without a prompt (ADR-0038 decision 2). The task tools are
/// Claude's plan, and `-p` has them only when asked for (`Tasks`).
#[allow(clippy::too_many_arguments)]
pub fn command(
    worktree: &str,
    keeper: &Keeper,
    mode: chat::PermissionMode,
    interaction: chat::Interaction,
    model: Option<&chat::Model>,
    effort: Option<chat::Effort>,
    mcp: Option<&Mcp>,
    session: Option<&str>,
) -> String {
    let resume = match session {
        Some(session) => format!("set -- --resume {}\n", sq(session)),
        None => format!(
            "{}[ -n \"$f\" ] && set -- --resume \"$(basename \"$f\" .jsonl)\"\n",
            logs::newest(worktree)
        ),
    };
    format!(
        "cd {worktree} || exit 1\n\
         c=$({probe}) || {{ echo 'claude was not found on PATH or in any of: {searched}' >&2; exit 127; }}\n\
         ls /lib/ld-musl-* >/dev/null 2>&1 && export USE_BUILTIN_RIPGREP=0\n\
         export CLAUDE_CODE_ENABLE_TODO_TOOLS=1\n\
         mkdir -p -m 700 {images} || exit 1\n\
         {resume}\
         exec \"$c\" --add-dir {images} {rooms}--permission-mode {mode} {model}{effort}-p --input-format stream-json --output-format stream-json --verbose \
         --include-partial-messages --permission-prompt-tool stdio \"$@\"\n",
        worktree = sq(worktree),
        images = keeper.images(),
        rooms = mcp.map_or_else(String::new, |mcp| format!(
            "--mcp-config {} --allowedTools {ROOM_TOOLS} ",
            sq(&mcp.config())
        )),
        mode = flag(mode, interaction),
        model = model.map_or_else(String::new, |model| format!(
            "--model {} ",
            sq(model.as_str())
        )),
        effort = effort.map_or_else(String::new, |effort| format!("--effort {} ", effort.name())),
        probe = agent::probe("claude"),
        searched = agent::CANDIDATES.join(", "),
    )
}

/// The prompt of turn `n` of keeper run `run`, as the browser draws it. The
/// daemon sends it as it writes the line, and [`replay`] makes it again.
pub fn prompted(thread: &str, run: &str, n: usize, text: String) -> ThreadEvent {
    ThreadEvent {
        thread_id: thread.to_owned(),
        cursor: None,
        event: Event::ContentDelta(chat::ContentDelta {
            stream_kind: chat::StreamKind::UserText,
            delta: text,
            item_id: Some(format!("user:{run}:{n}")),
        }),
    }
}

const EXIT_PLAN_MODE: &str = "ExitPlanMode";

/*
 * T3 Code's answer to `ExitPlanMode`, at commit 72d5c32:
 * https://github.com/pingdotgg/t3code/blob/72d5c32ba67953805feb6fe9ad3b70b632a64c47/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
const PLAN_CAPTURED: &str = "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.";

/// Named apart from a `yantra` stdio server a person may have added by hand.
const ROOM_SERVER: &str = "yantra-room";
const ROOM_TOOLS: &str = "mcp__yantra-room__room_send,mcp__yantra-room__room_read";

/// Where a Chat turn reaches `yantrad`'s room tools, and the thread it names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mcp {
    /// `http://<daemon>:7717/api/mcp`.
    pub url: String,
    /// `<workspace>/<thread>`, sent as `X-Yantra-Thread`.
    pub thread: String,
}

impl Mcp {
    fn config(&self) -> String {
        json!({"mcpServers": {ROOM_SERVER: {
            "type": "http",
            "url": self.url,
            "headers": {"X-Yantra-Thread": self.thread},
        }}})
        .to_string()
    }
}

/// T3 Code maps the same two modes to Claude's own (`ClaudeAdapter.ts`).
fn flag(mode: chat::PermissionMode, interaction: chat::Interaction) -> &'static str {
    if interaction == chat::Interaction::Plan {
        return "plan";
    }
    match mode {
        chat::PermissionMode::Auto => "auto",
        chat::PermissionMode::AutoAcceptEdits => "acceptEdits",
        chat::PermissionMode::Supervised | chat::PermissionMode::FullAccess => "default",
    }
}

/// The daemon's answer to a Claude request in `mode`. In a mode Claude runs
/// itself, a request that reaches the daemon is one Claude still asks about,
/// such as an edit outside the worktree, so the person sees it.
#[must_use]
pub fn answers(mode: chat::PermissionMode, scope: chat::Scope) -> Option<chat::Decision> {
    match mode {
        chat::PermissionMode::Auto | chat::PermissionMode::AutoAcceptEdits => None,
        chat::PermissionMode::Supervised | chat::PermissionMode::FullAccess => mode.answers(scope),
    }
}

fn user(text: &str) -> Value {
    json!({
        "type": "user",
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    })
}

fn background_ids(state: &State) -> Vec<String> {
    state
        .background
        .iter()
        .map(|running| running.task_id.clone())
        .collect()
}

#[derive(Debug, Default)]
struct State {
    pending: HashMap<String, Pending>,
    /// The assistant message the deltas belong to.
    message: Option<String>,
    /// The context the last assistant message was sent with, in tokens.
    used: Option<u64>,
    /// The person cancelled the open turn.
    cancelled: bool,
    /// A turn's `init` came and its `result` has not.
    open: bool,
    /// The user lines written whose turn has not opened yet.
    waiting: usize,
    /// One for each turn opened, `true` for a wake turn. A turn opened while a
    /// line waits is taken for that line's, until a `result` from another
    /// origin says Claude started it (ADR-0041 decision 7).
    wakes: Vec<bool>,
    /// What a keeper's `in` already answered, so a replay or an adopted turn
    /// never answers it again (ADR-0035 decision 9).
    answered: HashMap<String, chat::Decision>,
    /// The end of the line being read and the number of events made from it.
    line: Option<(u64, u32)>,
    tasks: Tasks,
    /// The `ExitPlanMode` calls, whose item shows the plan.
    plans: HashSet<String>,
    /// Claude's id of the conversation, from `init`.
    session: Option<String>,
    /// The `--permission-mode` Claude runs in now.
    flag: Option<String>,
    /// The `--model` and `--effort` Claude runs with now. A session this
    /// daemon did not start is taken to run with neither.
    picked: (Option<chat::Model>, Option<chat::Effort>),
    /// The background tasks that still run, in the order they started.
    background: Vec<chat::BackgroundTask>,
    /// When Claude last wrote a line, which pins a keeper with background work.
    heard: Option<tokio::time::Instant>,
}

/// A `can_use_tool` request Claude is waiting on.
#[derive(Debug)]
struct Pending {
    input: Value,
    suggestions: Vec<Value>,
    request_type: chat::RequestType,
}

/// How a session's events are made: for which thread, from which offset of a
/// keeper's `out` in which run, and from what state.
struct Parse {
    thread: String,
    run: Option<String>,
    from: Option<u64>,
    state: State,
}

impl Parse {
    fn new(thread: &str, journal: Option<(&str, u64)>, state: State) -> Self {
        Self {
            thread: thread.to_owned(),
            run: journal.map(|(run, _)| run.to_owned()),
            from: journal.map(|(_, from)| from),
            state,
        }
    }
}

#[derive(Debug)]
struct Shared {
    thread: String,
    /// The keeper's run, when the session is read from one.
    run: Option<String>,
    /// `None` once stdin is closed.
    out: Mutex<Option<mpsc::UnboundedSender<String>>>,
    /// `None` once stdout has ended, which ends [`Events`].
    events: Mutex<Option<mpsc::UnboundedSender<ThreadEvent>>>,
    state: Mutex<State>,
    /// Numbers the control requests the daemon sends.
    requests: AtomicU64,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// An event read from the line being read, with its cursor when the
    /// session is kept.
    fn emit(&self, event: Event) {
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
        self.send_event(cursor, event);
    }

    /// An event the daemon made itself, which carries no cursor.
    fn emit_made(&self, event: Event) {
        self.send_event(None, event);
    }

    fn send_event(&self, cursor: Option<String>, event: Event) {
        if let Some(events) = self
            .events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            // Nobody listening is not this session's failure.
            let _ = events.send(ThreadEvent {
                thread_id: self.thread.clone(),
                cursor,
                event,
            });
        }
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

    /// A control request of the daemon's own, numbered so no two share an id.
    fn request(&self, kind: &str, request: Value) -> Result<(), Error> {
        let n = self.requests.fetch_add(1, Ordering::Relaxed) + 1;
        self.send(&json!({
            "type": "control_request",
            "request_id": format!("yantra-{kind}-{n}"),
            "request": request,
        }))
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
        self.emit_made(Event::RequestResolved(chat::RequestResolved {
            request_id: request.to_owned(),
            request_type: pending.request_type,
            decision,
        }));
        Ok(())
    }

    /// One line of stdout. `end` is where it ends in a keeper's `out`.
    fn dispatch(&self, line: &[u8], end: Option<u64>) {
        {
            let mut state = self.lock();
            state.line = end.map(|end| (end, 0));
            state.heard = Some(tokio::time::Instant::now());
        }
        self.dispatch_line(line);
        self.lock().line = None;
    }

    fn dispatch_line(&self, line: &[u8]) {
        // A line that is not stream-json is noise, such as a login script's echo.
        let Ok(line) = serde_json::from_slice::<Line>(line) else {
            return;
        };
        match line {
            Line::System(system) => self.system(system),
            Line::StreamEvent { event } => self.stream(event),
            Line::Assistant { message } => {
                if let Some(usage) = &message.usage {
                    self.lock().used = Some(usage.context());
                }
                for block in message.content.blocks() {
                    if let Block::ToolUse { id, name, input } = block {
                        if let Some(call) = Task::call(&name, &input) {
                            self.lock().tasks.calls.insert(id.clone(), call);
                        }
                        let plan = input["plan"]
                            .as_str()
                            .filter(|_| name == EXIT_PLAN_MODE)
                            .map(str::to_owned);
                        if plan.is_some() {
                            self.lock().plans.insert(id.clone());
                        }
                        self.emit(Event::ItemStarted(chat::Item {
                            item_id: id,
                            item_type: Some(item_type(&name)),
                            status: Some(chat::ItemStatus::InProgress),
                            title: logs::target_in(&input),
                            output: plan,
                            changes: Vec::new(),
                        }));
                    }
                }
            }
            Line::User {
                message,
                tool_use_result,
            } => {
                for block in message.content.blocks() {
                    if let Block::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } = block
                    {
                        let (plan, proposed) = {
                            let mut state = self.lock();
                            let plan = state.tasks.result(&tool_use_id, is_error, &tool_use_result);
                            (plan, state.plans.remove(&tool_use_id))
                        };
                        if let Some(plan) = plan {
                            self.emit(Event::PlanUpdated { plan });
                        }
                        // A proposed plan was denied on purpose, and its item keeps the plan.
                        self.emit(Event::ItemCompleted(chat::Item {
                            item_id: tool_use_id,
                            item_type: None,
                            status: Some(if is_error && !proposed {
                                chat::ItemStatus::Failed
                            } else {
                                chat::ItemStatus::Completed
                            }),
                            title: None,
                            output: (!proposed).then(|| output(&content)),
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
            Line::Other => {}
        }
    }

    fn system(&self, system: System) {
        match system.subtype.as_str() {
            "init" => {
                let opened = {
                    let mut state = self.lock();
                    if system.session_id.is_some() {
                        state.session = system.session_id;
                    }
                    if system.permission_mode.is_some() {
                        state.flag = system.permission_mode;
                    }
                    let opened = !state.open;
                    if opened {
                        state.open = true;
                        state.message = None;
                        let wake = state.waiting == 0;
                        state.waiting = state.waiting.saturating_sub(1);
                        state.wakes.push(wake);
                    }
                    opened
                };
                if opened {
                    self.emit(Event::TurnStarted);
                }
            }
            "status" => {
                if system.permission_mode.is_some() {
                    self.lock().flag = system.permission_mode;
                }
            }
            // The roster as Claude has it now, in whatever order the start and
            // end events come (2.1.281 sends it before the notification).
            "background_tasks_changed" => {
                let tasks = system.tasks.unwrap_or_default();
                self.roster(|roster| *roster = tasks.into_iter().map(Running::task).collect());
            }
            "task_started" if system.is_backgrounded != Some(false) => {
                let Some(task_id) = system.task_id else {
                    return;
                };
                self.roster(|roster| {
                    if !roster.iter().any(|running| running.task_id == task_id) {
                        roster.push(chat::BackgroundTask {
                            task_id,
                            kind: system.task_type.unwrap_or_default(),
                            description: system.description.unwrap_or_default(),
                        });
                    }
                });
            }
            "task_notification" => {
                if let Some(task_id) = system.task_id {
                    self.roster(|roster| roster.retain(|running| running.task_id != task_id));
                }
            }
            _ => {}
        }
    }

    /// Changes the roster and sends it when it changed.
    fn roster(&self, change: impl FnOnce(&mut Vec<chat::BackgroundTask>)) {
        let changed = {
            let mut state = self.lock();
            let before = state.background.clone();
            change(&mut state.background);
            (state.background != before).then(|| state.background.clone())
        };
        if let Some(tasks) = changed {
            self.emit(Event::BackgroundUpdated { tasks });
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
        // Only plan mode offers the tool. Its item already shows the plan.
        if tool == EXIT_PLAN_MODE {
            let _ = self.send(&json!({
                "type": "control_response",
                "response": {"subtype": "success", "request_id": request_id,
                             "response": {"behavior": "deny", "message": PLAN_CAPTURED}},
            }));
            return;
        }
        let request_type = request_type(&tool);
        let title = logs::target_in(&request.input);
        let answered = {
            let mut state = self.lock();
            let answered = state.answered.remove(&request_id);
            if answered.is_none() {
                state.pending.insert(
                    request_id.clone(),
                    Pending {
                        input: request.input,
                        suggestions: request.permission_suggestions,
                        request_type,
                    },
                );
            }
            answered
        };
        self.emit(Event::RequestOpened(chat::RequestOpened {
            request_id: request_id.clone(),
            request_type,
            item_id: request.tool_use_id,
            title,
            detail: request.description,
            options: options(),
            scope: if tool == "AskUserQuestion" {
                chat::Scope::Question
            } else {
                chat::Scope::Other
            },
        }));
        if let Some(decision) = answered {
            self.emit_made(Event::RequestResolved(chat::RequestResolved {
                request_id,
                request_type,
                decision,
            }));
        }
    }

    /// The turn's `result`. Stdin stays open for the next turn.
    fn finish(&self, outcome: Outcome) {
        let (cancelled, used) = {
            let mut state = self.lock();
            if state.open {
                // A wake turn that opened while a line waited leaves it waiting.
                if outcome
                    .origin
                    .as_ref()
                    .is_some_and(|origin| origin.kind != "human")
                    && let Some(wake @ false) = state.wakes.last_mut()
                {
                    *wake = true;
                    state.waiting += 1;
                }
            } else {
                // A turn that failed before its `init`.
                state.waiting = state.waiting.saturating_sub(1);
            }
            let cancelled = state.cancelled || outcome.terminal_reason.starts_with("aborted");
            state.open = false;
            state.cancelled = false;
            state.pending.clear();
            (cancelled, state.used)
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
    }

    /// stdout ended. A turn that is open or still waits to open failed, and
    /// what `claude` and `ssh` said last is why. No task outlives the process,
    /// so a roster that was not empty empties. The events end here.
    fn ended(&self, said: String) {
        let (unfinished_turn, ran) = {
            let mut state = self.lock();
            let ran = !std::mem::take(&mut state.background).is_empty();
            (
                (state.open || state.waiting > 0).then_some(state.cancelled),
                ran,
            )
        };
        self.close();
        if let Some(cancelled) = unfinished_turn {
            self.emit_made(Event::TurnCompleted(unfinished(cancelled, said)));
        }
        if ran {
            self.emit_made(Event::BackgroundUpdated { tasks: Vec::new() });
        }
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }
}

/// How a turn whose stdout ended with no `result` ended.
fn unfinished(cancelled: bool, said: String) -> chat::TurnCompleted {
    if cancelled {
        return cancelled_turn();
    }
    chat::TurnCompleted {
        state: chat::TurnState::Failed,
        stop_reason: None,
        message: Some(if said.is_empty() {
            "claude ended without a result".to_owned()
        } else {
            said
        }),
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
    shared.ended(said);
}

/// A kept session's events so far, parsed again from its journals: `out` from
/// byte 0, and `input`, the `in` the daemon wrote, for the prompts and what
/// was answered. The same bytes always give the same events with the same
/// cursors.
#[derive(Debug)]
pub struct Replayed {
    thread: String,
    run: String,
    /// Every event `out`'s whole lines make, in order, with each prompt the
    /// daemon sent made again before the turn it opened.
    pub events: Vec<ThreadEvent>,
    /// The offset after the last whole line, where a reader carries on.
    pub offset: u64,
    /// The prompts written to `in`, in order.
    pub prompts: Vec<String>,
    state: State,
}

impl Replayed {
    /// Whether a turn is open, or a prompt waits for its turn to open.
    pub fn running(&self) -> bool {
        self.state.open || self.state.waiting > 0
    }

    /// The ids of the background tasks that still ran when `out` was read.
    pub fn background(&self) -> Vec<String> {
        background_ids(&self.state)
    }

    /// The events the daemon made when this ended keeper's `out` stopped,
    /// made again for a replay (ADR-0035 decision 8): the `turn.completed` of
    /// a turn it stopped inside, and the emptied roster of tasks that still ran.
    /// `said` is what the keeper's `err` says.
    pub fn end(&self, said: String) -> Vec<ThreadEvent> {
        let made = |event| ThreadEvent {
            thread_id: self.thread.clone(),
            cursor: None,
            event,
        };
        let turn = self
            .running()
            .then(|| made(Event::TurnCompleted(unfinished(self.state.cancelled, said))));
        let roster = (!self.state.background.is_empty())
            .then(|| made(Event::BackgroundUpdated { tasks: Vec::new() }));
        turn.into_iter().chain(roster).collect()
    }
}

pub fn replay(thread: &str, run: &str, out: &[u8], input: &[u8]) -> Replayed {
    let (sent, _) = keep::lines(input);
    let mut state = State::default();
    let mut prompts = Vec::new();
    // An interrupt after the last prompt is the last turn's.
    let mut interrupted = false;
    for (line, _) in sent {
        match serde_json::from_slice::<Sent>(line) {
            Ok(Sent::User { message }) => {
                prompts.push(message.content.text().unwrap_or_default());
                interrupted = false;
            }
            Ok(Sent::ControlRequest { request }) if request.subtype == "interrupt" => {
                interrupted = true;
            }
            Ok(Sent::ControlResponse { response }) => {
                if let Some(answer) = response.response {
                    state
                        .answered
                        .insert(response.request_id, answer.decision());
                }
            }
            _ => {}
        }
    }
    state.waiting = prompts.len();
    let (out_tx, _) = mpsc::unbounded_channel();
    let (events, mut received) = mpsc::unbounded_channel();
    let shared = Shared {
        thread: thread.to_owned(),
        run: Some(run.to_owned()),
        out: Mutex::new(Some(out_tx)),
        events: Mutex::new(Some(events)),
        state: Mutex::new(state),
        requests: AtomicU64::new(0),
    };
    // A replay answers nothing: what it would send was sent when it was read.
    shared.close();
    let (found, offset) = keep::lines(out);
    for (line, end) in found {
        shared.dispatch(line, Some(end));
    }
    let mut state = std::mem::take(&mut *shared.lock());
    state.cancelled = (state.open || state.waiting > 0) && interrupted;
    let mut replayed = Vec::new();
    let mut unsent = prompts.iter().cloned().enumerate();
    let mut turn = 0;
    while let Ok(event) = received.try_recv() {
        if event.event == Event::TurnStarted {
            let wake = state.wakes.get(turn).copied().unwrap_or(true);
            turn += 1;
            if !wake && let Some((n, text)) = unsent.next() {
                replayed.push(prompted(thread, run, n + 1, text));
            }
        }
        replayed.push(event);
    }
    replayed.extend(unsent.map(|(n, text)| prompted(thread, run, n + 1, text)));
    Replayed {
        thread: thread.to_owned(),
        run: run.to_owned(),
        events: replayed,
        offset,
        prompts,
        state,
    }
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
    System(System),
    StreamEvent {
        event: StreamEvent,
    },
    Assistant {
        message: Message,
    },
    User {
        message: Message,
        /// Claude's own record of a tool's result; read for a `TaskCreate`'s id.
        #[serde(default)]
        tool_use_result: Value,
    },
    ControlRequest {
        request_id: String,
        request: ControlRequest,
    },
    Result(Box<Outcome>),
    #[serde(other)]
    Other,
}

/// A `system` line: a turn's `init`, a mode change, or a background task's
/// start, end or roster.
#[derive(Deserialize)]
struct System {
    #[serde(default)]
    subtype: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default, rename = "permissionMode")]
    permission_mode: Option<String>,
    #[serde(default)]
    tasks: Option<Vec<Running>>,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    task_type: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    is_backgrounded: Option<bool>,
}

#[derive(Deserialize)]
struct Running {
    task_id: String,
    #[serde(default)]
    task_type: String,
    #[serde(default)]
    description: String,
}

impl Running {
    fn task(self) -> chat::BackgroundTask {
        chat::BackgroundTask {
            task_id: self.task_id,
            kind: self.task_type,
            description: self.description,
        }
    }
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
    Text(String),
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

    /// A prompt's text, as [`prompt`] writes it.
    fn text(self) -> Option<String> {
        match self {
            Self::Text(text) => Some(text),
            Self::Blocks(blocks) => blocks.into_iter().find_map(|block| match block {
                Block::Text { text } => Some(text),
                _ => None,
            }),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Block {
    Text {
        text: String,
    },
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

/// Claude's plan is its task list. `-p` offers `TaskCreate` and `TaskUpdate`
/// only under `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, and never `TodoWrite` (Y-568).
/// A task is planned once its result says it was made, so a refused call is not.
#[derive(Debug, Default)]
struct Tasks {
    /// The task calls whose results have not arrived, by tool use id.
    calls: HashMap<String, Task>,
    /// The tasks this turn made, by Claude's task id, in the order made.
    steps: Vec<(String, chat::PlanStep)>,
}

#[derive(Debug)]
enum Task {
    Create,
    Update(TaskUpdate),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskUpdate {
    task_id: String,
    subject: Option<String>,
    status: Option<TaskStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Deleted,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct Created {
    task: CreatedTask,
}

#[derive(Deserialize)]
struct CreatedTask {
    id: String,
    subject: String,
}

impl Task {
    fn call(name: &str, input: &Value) -> Option<Self> {
        match name {
            "TaskCreate" => Some(Self::Create),
            "TaskUpdate" => TaskUpdate::deserialize(input).ok().map(Self::Update),
            _ => None,
        }
    }
}

impl Tasks {
    /// The plan after a tool's result, when that result changed it.
    fn result(&mut self, id: &str, failed: bool, record: &Value) -> Option<Vec<chat::PlanStep>> {
        let call = self.calls.remove(id)?;
        if failed {
            return None;
        }
        match call {
            Task::Create => {
                let Created { task } = Created::deserialize(record).ok()?;
                let step = chat::PlanStep {
                    step: task.subject,
                    status: chat::PlanStepStatus::Pending,
                };
                self.steps.push((task.id, step));
            }
            // A task made in an earlier turn has no subject here, so it is not shown.
            Task::Update(update) => {
                let at = self
                    .steps
                    .iter()
                    .position(|(id, _)| *id == update.task_id)?;
                let step = &mut self.steps[at].1;
                if let Some(subject) = update.subject {
                    step.step = subject;
                }
                match update.status {
                    Some(TaskStatus::Pending) => step.status = chat::PlanStepStatus::Pending,
                    Some(TaskStatus::InProgress) => step.status = chat::PlanStepStatus::InProgress,
                    Some(TaskStatus::Completed) => step.status = chat::PlanStepStatus::Completed,
                    Some(TaskStatus::Deleted) => {
                        self.steps.remove(at);
                    }
                    Some(TaskStatus::Other) | None => {}
                }
            }
        }
        Some(self.steps.iter().map(|(_, step)| step.clone()).collect())
    }
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
    /// `aborted_streaming` and the like for an interrupted turn.
    #[serde(default)]
    terminal_reason: String,
    /// Who started the turn; a wake turn's is `task-notification`.
    origin: Option<Origin>,
}

#[derive(Deserialize)]
struct Origin {
    kind: String,
}

#[derive(Deserialize)]
struct ModelUsage {
    #[serde(rename = "contextWindow")]
    context_window: Option<u64>,
}

/// The lines a daemon writes to `in`, read back on a replay.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Sent {
    User {
        message: Message,
    },
    ControlRequest {
        request: Interrupt,
    },
    ControlResponse {
        response: Responded,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct Interrupt {
    subtype: String,
}

#[derive(Deserialize)]
struct Responded {
    request_id: String,
    response: Option<Behaviour>,
}

#[derive(Deserialize)]
struct Behaviour {
    behavior: String,
    #[serde(rename = "updatedPermissions")]
    updated_permissions: Option<Value>,
}

impl Behaviour {
    fn decision(&self) -> chat::Decision {
        match (self.behavior.as_str(), &self.updated_permissions) {
            ("allow", Some(_)) => chat::Decision::AcceptAlways,
            ("allow", None) => chat::Decision::Accept,
            _ => chat::Decision::Decline,
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use chat::{
        ContentDelta, Decision, Effort, Interaction, Item, ItemStatus, ItemType, Model,
        PermissionMode, PlanStep, PlanStepStatus, RequestOpened, RequestResolved, RequestType,
        Scope, StopReason, StreamKind, TokenUsage, TurnCompleted, TurnState,
    };
    use tokio::io::{AsyncBufReadExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

    const WAKE: &str = include_str!("../tests/recordings/claude-2.1.319-background-wake.jsonl");
    const STOP: &str = include_str!("../tests/recordings/claude-2.1.319-stop-task.jsonl");
    const MODEL_EFFORT: &str =
        include_str!("../tests/recordings/claude-2.1.319-set-model-effort.jsonl");

    const ACCEPT: &str = include_str!("../tests/recordings/claude-2.1.291-accept.jsonl");
    const DECLINE: &str = include_str!("../tests/recordings/claude-2.1.291-decline.jsonl");
    const INTERRUPT: &str = include_str!("../tests/recordings/claude-2.1.291-interrupt.jsonl");
    const NOT_LOGGED_IN: &str =
        include_str!("../tests/recordings/claude-2.1.291-not-logged-in.jsonl");
    const TASKS: &str = include_str!("../tests/recordings/claude-2.1.317-tasks.jsonl");

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

        /// Whether nothing reaches Claude, and stdin stays open, for a moment.
        async fn silent(&mut self) -> bool {
            let mut line = String::new();
            tokio::time::timeout(
                Duration::from_millis(200),
                self.from_turn.read_line(&mut line),
            )
            .await
            .is_err()
        }

        async fn play(&mut self, recording: &str) {
            self.to_turn
                .write_all(recording.as_bytes())
                .await
                .expect("the pipe writes");
        }
    }

    fn pair(stderr: Option<Said>) -> (Session, Events, Fake) {
        let (ours, theirs) = tokio::io::duplex(1 << 20);
        let (our_read, our_write) = tokio::io::split(ours);
        let (their_read, their_write) = tokio::io::split(theirs);
        let parse = Parse::new(THREAD, None, State::default());
        let (turn, events) = Session::wire(our_read, our_write, parse, stderr, None);
        turn.first(&build("Run touch made.txt"))
            .expect("the writer is fresh");
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
            scope: Scope::Other,
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
        // Stdin stays open after `result`, for the next turn (ADR-0041).
        assert!(fake.silent().await);
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

    /// Y-565: Claude proposes a plan with `ExitPlanMode`. The daemon denies it
    /// at once with T3 Code's words, asks nobody, and the item keeps the plan.
    #[tokio::test]
    async fn exit_plan_mode_is_denied_at_once_and_its_item_keeps_the_plan() {
        let (_turn, mut events, mut fake) = pair(None);
        fake.receive().await;
        let plan = "# Plan\n\n1. Write plan-proof.txt";
        let tool_use = json!({"type": "assistant", "message": {"id": "m1", "content": [
            {"type": "tool_use", "id": "toolu_plan", "name": "ExitPlanMode", "input": {"plan": plan}}]}});
        let request = json!({"type": "control_request", "request_id": "r-plan", "request": {
            "subtype": "can_use_tool", "tool_name": "ExitPlanMode", "input": {"plan": plan},
            "tool_use_id": "toolu_plan"}});
        fake.play(&format!(
            "{}\n{tool_use}\n{request}\n",
            json!({"type": "system", "subtype": "init"})
        ))
        .await;
        assert_eq!(
            fake.receive().await,
            Some(json!({"type": "control_response", "response": {
                "subtype": "success", "request_id": "r-plan",
                "response": {"behavior": "deny", "message": PLAN_CAPTURED}}}))
        );
        let result = json!({"type": "user", "message": {"content": [{"type": "tool_result",
            "tool_use_id": "toolu_plan", "content": PLAN_CAPTURED, "is_error": true}]}});
        let done = json!({"type": "result", "subtype": "success", "is_error": false,
            "stop_reason": "end_turn", "modelUsage": {}});
        fake.play(&format!("{result}\n{done}\n")).await;
        let seen = until_completed(&mut events).await;

        assert!(
            !seen
                .iter()
                .any(|event| matches!(event, Event::RequestOpened(_))),
            "{seen:?}"
        );
        assert!(seen.contains(&Event::ItemStarted(Item {
            item_id: "toolu_plan".to_owned(),
            item_type: Some(ItemType::DynamicToolCall),
            status: Some(ItemStatus::InProgress),
            title: None,
            output: Some(plan.to_owned()),
            changes: vec![],
        })));
        assert!(seen.contains(&Event::ItemCompleted(Item {
            item_id: "toolu_plan".to_owned(),
            item_type: None,
            status: Some(ItemStatus::Completed),
            title: None,
            output: None,
            changes: vec![],
        })));
        assert_eq!(
            seen.last(),
            Some(&Event::TurnCompleted(TurnCompleted {
                state: TurnState::Completed,
                stop_reason: Some(StopReason::EndTurn),
                message: None,
            }))
        );
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
    async fn a_question_to_the_person_is_no_mode_answers() {
        let (_turn, mut events, mut fake) = pair(None);
        fake.receive().await;
        fake.play(&up_to_the_request(ACCEPT).replace(
            r#""tool_name":"Bash","display_name":"Bash""#,
            r#""tool_name":"AskUserQuestion","display_name":"AskUserQuestion""#,
        ))
        .await;
        let asked = opened(&mut events).await;

        assert_eq!(asked.scope, Scope::Question);
        assert_eq!(answers(PermissionMode::FullAccess, asked.scope), None);
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
        assert!(fake.silent().await, "stdin stays open after the interrupt");
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
        let stderr: Said = Box::pin(async { "sh: claude: not found".to_owned() });
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

    const IMAGES: &str = "\"$HOME\"/.yantra/keep/'w'/'11111111'/images";

    fn keeper() -> Keeper {
        Keeper::new("w", "11111111")
    }

    /// The worktree reaches the shell quoted, and the transcript directory is
    /// the slug, which holds nothing a shell acts on. A thread with no session
    /// id resumes the newest transcript there.
    #[test]
    fn the_command_cds_into_the_worktree_and_resumes_the_newest_transcript() {
        let script = command(
            "/home/u/.yantra/worktrees/chat/w/11111111",
            &keeper(),
            PermissionMode::Supervised,
            Interaction::Build,
            None,
            None,
            None,
            None,
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
        assert!(script.contains("\nexport CLAUDE_CODE_ENABLE_TODO_TOOLS=1\n"));
        assert!(script.ends_with(&format!(
            "exec \"$c\" --add-dir {IMAGES} --permission-mode default -p --input-format stream-json \
             --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio \"$@\"\n"
        )));

        let hostile = command(
            "/tmp/x'; touch /tmp/pwned; '",
            &keeper(),
            PermissionMode::Supervised,
            Interaction::Build,
            None,
            None,
            None,
            None,
        );
        assert!(hostile.starts_with(r"cd '/tmp/x'\''; touch /tmp/pwned; '\''' || exit 1"));
    }

    /// ADR-0041 decision 8: a thread that keeps its session id resumes that
    /// one, never the newest transcript, and the id reaches the shell quoted.
    #[test]
    fn a_kept_session_id_is_resumed_by_name() {
        let script = command(
            "/w",
            &keeper(),
            PermissionMode::Supervised,
            Interaction::Build,
            None,
            None,
            None,
            Some("9a11f727-ba24"),
        );
        assert!(
            script.contains("\nset -- --resume '9a11f727-ba24'\nexec "),
            "{script}"
        );
        assert!(!script.contains("ls -t"), "{script}");
        let hostile = command(
            "/w",
            &keeper(),
            PermissionMode::Supervised,
            Interaction::Build,
            None,
            None,
            None,
            Some("x'; touch /tmp/pwned; '"),
        );
        assert!(
            hostile.contains(r"set -- --resume 'x'\''; touch /tmp/pwned; '\'''"),
            "{hostile}"
        );
    }

    /// Y-424, ADR-0041 decision 5: every session may read the thread's images
    /// directory, made before Claude starts, so an image pasted in a later
    /// turn needs no new process.
    #[test]
    fn the_images_directory_is_made_and_added_before_the_other_flags() {
        let script = command(
            "/w",
            &keeper(),
            PermissionMode::Supervised,
            Interaction::Build,
            None,
            None,
            None,
            None,
        );
        assert!(
            script.contains(&format!("\nmkdir -p -m 700 {IMAGES} || exit 1\n")),
            "{script}"
        );
        assert!(
            script.contains(&format!(
                "exec \"$c\" --add-dir {IMAGES} --permission-mode default -p"
            )),
            "{script}"
        );
    }

    /// Y-453: Auto and Auto-accept edits run in Claude's own mode, and the
    /// other two name `default`, so `permissions.defaultMode` in a machine's
    /// settings cannot turn approval off.
    #[test]
    fn every_permission_mode_names_claudes_flag() {
        for (mode, flag) in [
            (PermissionMode::Auto, "auto"),
            (PermissionMode::AutoAcceptEdits, "acceptEdits"),
            (PermissionMode::Supervised, "default"),
            (PermissionMode::FullAccess, "default"),
        ] {
            let script = command(
                "/w",
                &keeper(),
                mode,
                Interaction::Build,
                None,
                None,
                None,
                None,
            );
            assert!(
                script.contains(&format!(
                    "exec \"$c\" --add-dir {IMAGES} --permission-mode {flag} -p --input-format"
                )),
                "{script}"
            );
            assert_eq!(script.matches("--permission-mode").count(), 1, "{script}");
        }
    }

    /// Y-565: a plan turn runs in Claude's own plan mode, whatever the
    /// permission mode, so no mode lets it write.
    #[test]
    fn a_plan_turn_names_claudes_plan_mode_once_in_every_permission_mode() {
        for mode in [
            PermissionMode::Supervised,
            PermissionMode::AutoAcceptEdits,
            PermissionMode::Auto,
            PermissionMode::FullAccess,
        ] {
            let script = command(
                "/w",
                &keeper(),
                mode,
                Interaction::Plan,
                None,
                None,
                None,
                None,
            );
            assert!(
                script.contains(&format!(
                    "exec \"$c\" --add-dir {IMAGES} --permission-mode plan -p"
                )),
                "{script}"
            );
            assert_eq!(script.matches("--permission-mode").count(), 1, "{script}");
        }
    }

    /// Y-564: the model and the effort follow the mode, each only when picked.
    #[test]
    fn a_picked_model_and_effort_follow_the_mode() {
        let model = Model::try_from("claude-opus-5-5[1m]".to_owned()).expect("a model");
        let both = command(
            "/w",
            &keeper(),
            PermissionMode::Supervised,
            Interaction::Build,
            Some(&model),
            Some(Effort::Xhigh),
            None,
            None,
        );
        assert!(
            both.contains(
                "--permission-mode default --model 'claude-opus-5-5[1m]' --effort xhigh -p --input-format"
            ),
            "{both}"
        );
        let model_only = command(
            "/w",
            &keeper(),
            PermissionMode::Supervised,
            Interaction::Build,
            Some(&model),
            None,
            None,
            None,
        );
        assert!(
            model_only.contains("--model 'claude-opus-5-5[1m]' -p "),
            "{model_only}"
        );
        assert!(!model_only.contains("--effort"), "{model_only}");
        let effort_only = command(
            "/w",
            &keeper(),
            PermissionMode::Auto,
            Interaction::Build,
            None,
            Some(Effort::Low),
            None,
            None,
        );
        assert!(
            effort_only.contains("--permission-mode auto --effort low -p "),
            "{effort_only}"
        );
        assert!(!effort_only.contains("--model"), "{effort_only}");
        let neither = command(
            "/w",
            &keeper(),
            PermissionMode::Auto,
            Interaction::Build,
            None,
            None,
            None,
            None,
        );
        assert!(neither.contains("--permission-mode auto -p "), "{neither}");
        assert!(
            !neither.contains("--model") && !neither.contains("--effort"),
            "{neither}"
        );
    }

    /// ADR-0038 decision 2: a Chat turn reaches the room tools over HTTP,
    /// names its thread in a header, and may use them without a prompt.
    #[test]
    fn the_room_server_and_its_tools_are_added_before_the_mode() {
        let mcp = Mcp {
            url: "http://100.64.0.1:7717/api/mcp".to_owned(),
            thread: "web/1a2b3c4d".to_owned(),
        };
        let script = command(
            "/w",
            &keeper(),
            PermissionMode::FullAccess,
            Interaction::Build,
            None,
            None,
            Some(&mcp),
            None,
        );
        assert!(
            script.contains(&format!(
                "exec \"$c\" --add-dir {IMAGES} --mcp-config '{{\"mcpServers\":{{\"yantra-room\":\
                 {{\"headers\":{{\"X-Yantra-Thread\":\"web/1a2b3c4d\"}},\"type\":\"http\",\
                 \"url\":\"http://100.64.0.1:7717/api/mcp\"}}}}}}' \
                 --allowedTools mcp__yantra-room__room_send,mcp__yantra-room__room_read \
                 --permission-mode default -p"
            )),
            "{script}"
        );

        let hostile = Mcp {
            url: mcp.url.clone(),
            thread: "web/x'; touch /tmp/pwned; '\"".to_owned(),
        };
        let script = command(
            "/w",
            &keeper(),
            PermissionMode::Supervised,
            Interaction::Build,
            None,
            None,
            Some(&hostile),
            None,
        );
        assert!(
            script.contains(
                r#"--mcp-config '{"mcpServers":{"yantra-room":{"headers":{"X-Yantra-Thread":"web/x'\''; touch /tmp/pwned; '\''\""},"#
            ),
            "the quote ends nothing and the JSON stays one string: {script}"
        );
        assert_eq!(script.matches("--mcp-config").count(), 1, "{script}");
    }

    /// Claude's acceptEdits still asks about an edit outside its directories,
    /// so the daemon must not accept that edit for it.
    #[test]
    fn the_daemon_answers_claude_only_in_a_mode_claude_does_not_run() {
        assert_eq!(
            answers(PermissionMode::AutoAcceptEdits, Scope::WorktreeEdit),
            None
        );
        assert_eq!(answers(PermissionMode::Auto, Scope::WorktreeEdit), None);
        assert_eq!(
            answers(PermissionMode::FullAccess, Scope::Other),
            Some(Decision::Accept)
        );
        assert_eq!(answers(PermissionMode::FullAccess, Scope::Question), None);
        assert_eq!(answers(PermissionMode::Supervised, Scope::Other), None);
    }

    const RUN: &str = "Y0123456789abcdef";

    /// What a daemon writes to `in` for the accept recording: the prompt,
    /// then, when `answered`, the answer.
    fn sent(answered: bool) -> String {
        let mut lines = format!("{}\n", user("Run touch made.txt"));
        if answered {
            lines.push_str(&format!(
                "{}\n",
                json!({"type": "control_response", "response": {"subtype": "success",
                    "request_id": REQUEST, "response": {"behavior": "allow",
                    "updatedInput": {"command": "touch made.txt"}}}})
            ));
        }
        lines
    }

    /// A kept turn over pipes: Claude's stdout is `out` and the line the turn
    /// writes is what `in` would get.
    fn kept() -> (Session, Events, Fake) {
        let (ours, theirs) = tokio::io::duplex(1 << 20);
        let (our_read, our_write) = tokio::io::split(ours);
        let (their_read, their_write) = tokio::io::split(theirs);
        let said: Said = Box::pin(async { String::new() });
        let (turn, events) = Session::kept(
            our_read,
            our_write,
            THREAD,
            RUN,
            &build("Run touch made.txt"),
            said,
        );
        let fake = Fake {
            from_turn: BufReader::new(their_read),
            to_turn: their_write,
        };
        (turn, events, fake)
    }

    /// Every event up to and including the first that `last` picks.
    async fn through(events: &mut Events, last: impl Fn(&Event) -> bool) -> Vec<ThreadEvent> {
        let mut seen = Vec::new();
        loop {
            let next = tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .expect("an event within 5 s")
                .expect("the channel is open");
            let done = last(&next.event);
            seen.push(next);
            if done {
                return seen;
            }
        }
    }

    fn is_completed(event: &Event) -> bool {
        matches!(event, Event::TurnCompleted(_))
    }

    /// ADR-0035 decision 8: each event read from `out` carries
    /// `<run>:<line end>:<part>`, and a replay of the same bytes gives the
    /// same events with the same cursors.
    #[tokio::test]
    async fn a_kept_turn_cursors_each_event_and_a_replay_gives_the_same() {
        let (turn, mut events, mut fake) = kept();
        assert!(fake.receive().await.is_some(), "the prompt");
        fake.play(&up_to_the_request(ACCEPT)).await;
        let mut live = through(&mut events, |event| {
            matches!(event, Event::RequestOpened(_))
        })
        .await;
        turn.answer(REQUEST, Decision::Accept).expect("answered");
        let rest: String = ACCEPT
            .lines()
            .skip_while(|line| !line.contains("\"type\":\"control_request\""))
            .skip(1)
            .map(|line| format!("{line}\n"))
            .collect();
        fake.play(&rest).await;
        live.extend(through(&mut events, is_completed).await);

        let replayed = replay(THREAD, RUN, ACCEPT.as_bytes(), sent(true).as_bytes());
        assert_eq!(replayed.offset, ACCEPT.len() as u64);
        assert!(!replayed.running());
        assert_eq!(replayed.prompts, ["Run touch made.txt"]);
        let cursored = |events: &[ThreadEvent]| -> Vec<ThreadEvent> {
            events
                .iter()
                .filter(|event| event.cursor.is_some())
                .cloned()
                .collect()
        };
        assert_eq!(cursored(&replayed.events), cursored(&live));
        assert_eq!(
            live[0].cursor.as_deref(),
            Some(format!("{RUN}:{}:0", ACCEPT.lines().next().map_or(0, str::len) + 1).as_str()),
            "turn.started comes from the first line"
        );
        let result = live
            .iter()
            .filter(|event| event.cursor.is_some())
            .map(|event| event.cursor.clone().unwrap_or_default())
            .collect::<Vec<_>>();
        let end = ACCEPT.len();
        assert_eq!(
            result[result.len() - 2..],
            [format!("{RUN}:{end}:0"), format!("{RUN}:{end}:1")],
            "one `result` line gives two events"
        );
        // The answer the daemon made carries no cursor, live and replayed.
        let resolved = |events: &[ThreadEvent]| {
            events
                .iter()
                .filter(|event| matches!(event.event, Event::RequestResolved(_)))
                .map(|event| event.cursor.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(resolved(&live), [None]);
        assert_eq!(resolved(&replayed.events), [None]);
    }

    /// ADR-0035 decision 9: a request still open is one `out` holds and `in`
    /// has not answered, and an adopted turn answers it once.
    #[tokio::test]
    async fn an_adopted_turn_waits_on_an_open_request_and_answers_it_once() {
        let head = up_to_the_request(ACCEPT);
        let replayed = replay(THREAD, RUN, head.as_bytes(), sent(false).as_bytes());
        assert!(replayed.running());
        assert!(matches!(
            replayed.events.last().map(|event| &event.event),
            Some(Event::RequestOpened(_))
        ));
        let offset = replayed.offset;
        assert_eq!(offset, head.len() as u64);

        let (ours, theirs) = tokio::io::duplex(1 << 20);
        let (our_read, our_write) = tokio::io::split(ours);
        let (their_read, mut their_write) = tokio::io::split(theirs);
        let said: Said = Box::pin(async { String::new() });
        let (turn, mut events) = Session::resume(our_read, our_write, replayed, said);
        turn.answer(REQUEST, Decision::Accept)
            .expect("the open request is still open");
        assert!(matches!(
            turn.answer(REQUEST, Decision::Accept),
            Err(Error::NotPending(_))
        ));
        let mut from_turn = BufReader::new(their_read);
        let mut line = String::new();
        from_turn.read_line(&mut line).await.expect("a line");
        assert!(line.contains("\"control_response\""), "{line}");

        let after = &ACCEPT[head.len()..];
        let rest: String = ACCEPT
            .lines()
            .skip_while(|line| !line.contains("\"type\":\"control_request\""))
            .skip(1)
            .map(|line| format!("{line}\n"))
            .collect();
        assert_eq!(after, rest, "the recording ends with the request's line");
        their_write
            .write_all(rest.as_bytes())
            .await
            .expect("written");
        let seen = through(&mut events, is_completed).await;
        assert!(matches!(seen[0].event, Event::RequestResolved(_)));
        let first = seen
            .iter()
            .find_map(|event| event.cursor.as_deref().and_then(keep::Cursor::parse))
            .expect("a cursored event");
        assert!(
            first.end > offset,
            "nothing before the offset is sent again"
        );
        assert!(seen.iter().any(|event| matches!(&event.event,
            Event::TurnCompleted(done) if done.state == TurnState::Completed)));
    }

    /// A request `in` already answered is opened and resolved on a replay, and
    /// an adopting daemon has nothing left to answer.
    #[test]
    fn a_replay_resolves_a_request_in_already_answered() {
        let head = up_to_the_request(ACCEPT);
        let replayed = replay(THREAD, RUN, head.as_bytes(), sent(true).as_bytes());
        let n = replayed.events.len();
        assert!(matches!(
            &replayed.events[n - 2].event,
            Event::RequestOpened(_)
        ));
        assert_eq!(
            replayed.events[n - 1],
            ThreadEvent {
                thread_id: THREAD.to_owned(),
                cursor: None,
                event: Event::RequestResolved(RequestResolved {
                    request_id: REQUEST.to_owned(),
                    request_type: RequestType::ExecCommandApproval,
                    decision: Decision::Accept,
                }),
            }
        );
        assert!(replayed.state.pending.is_empty());
    }

    fn plans(recording: &str) -> Vec<Vec<PlanStep>> {
        replay(THREAD, RUN, recording.as_bytes(), b"")
            .events
            .into_iter()
            .filter_map(|event| match event.event {
                Event::PlanUpdated { plan } => Some(plan),
                _ => None,
            })
            .collect()
    }

    fn step(step: &str, status: PlanStepStatus) -> PlanStep {
        PlanStep {
            step: step.to_owned(),
            status,
        }
    }

    /// A real 2.1.317 turn: three `TaskCreate`s, then two `TaskUpdate`s.
    #[test]
    fn the_task_tools_update_the_plan() {
        use PlanStepStatus::{Completed, InProgress, Pending};
        let seen = plans(TASKS);
        assert_eq!(seen.len(), 5);
        assert_eq!(seen[0], vec![step("Read", Pending)]);
        assert_eq!(
            seen[4],
            vec![
                step("Read", Completed),
                step("Write", InProgress),
                step("Test", Pending),
            ]
        );
    }

    #[test]
    fn a_failed_or_unknown_task_call_sends_no_plan() {
        let lines = [
            json!({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "a", "name": "TaskCreate", "input": {"subject": "Read"}},
                {"type": "tool_use", "id": "b", "name": "TaskUpdate",
                 "input": {"taskId": "9", "status": "completed"}}]}}),
            json!({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "a", "content": "denied", "is_error": true}]}}),
            json!({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "b", "content": "Updated task #9 status"}]},
                "tool_use_result": {"success": true, "taskId": "9"}}),
        ];
        let out: String = lines.iter().map(|line| format!("{line}\n")).collect();
        assert!(plans(&out).is_empty());
    }

    #[test]
    fn a_deleted_task_leaves_the_plan() {
        let lines = [
            json!({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "a", "name": "TaskCreate", "input": {"subject": "Read"}}]}}),
            json!({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "a", "content": "Task #1 created successfully: Read"}]},
                "tool_use_result": {"task": {"id": "1", "subject": "Read"}}}),
            json!({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "b", "name": "TaskUpdate",
                 "input": {"taskId": "1", "status": "deleted"}}]}}),
            json!({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "b", "content": "Updated task #1 deleted"}]}}),
        ];
        let out: String = lines.iter().map(|line| format!("{line}\n")).collect();
        assert_eq!(
            plans(&out),
            vec![vec![step("Read", PlanStepStatus::Pending)], Vec::new()]
        );
    }

    fn build(text: &str) -> Prompt<'_> {
        Prompt {
            text,
            mode: PermissionMode::Supervised,
            interaction: Interaction::Build,
            model: None,
            effort: None,
        }
    }

    fn line(value: &Value) -> String {
        format!("{value}\n")
    }

    fn init() -> Value {
        json!({"type": "system", "subtype": "init", "session_id": "s-1", "permissionMode": "default"})
    }

    /// A turn's `result`; `origin` names who started a turn the person did not.
    fn result(origin: Option<&str>) -> Value {
        let mut done = json!({"type": "result", "subtype": "success", "is_error": false,
            "stop_reason": "end_turn", "modelUsage": {}});
        if let Some(kind) = origin {
            done["origin"] = json!({"kind": kind});
        }
        done
    }

    fn rosters(seen: &[Event]) -> Vec<Vec<String>> {
        seen.iter()
            .filter_map(|event| match event {
                Event::BackgroundUpdated { tasks } => {
                    Some(tasks.iter().map(|task| task.task_id.clone()).collect())
                }
                _ => None,
            })
            .collect()
    }

    /// The shape of a replay: each prompt, turn start and turn end, in order.
    fn shape(events: &[ThreadEvent]) -> Vec<&'static str> {
        events
            .iter()
            .filter_map(|event| match &event.event {
                Event::ContentDelta(delta) if delta.stream_kind == StreamKind::UserText => {
                    Some("prompt")
                }
                Event::TurnStarted => Some("turn"),
                Event::TurnCompleted(_) => Some("end"),
                _ => None,
            })
            .collect()
    }

    /// ADR-0041 decision 1: one process runs turn after turn, each one user
    /// line, and only `close` ends its stdin.
    #[tokio::test]
    async fn one_session_runs_turn_after_turn_on_one_stdin() {
        let (session, mut events, mut fake) = pair(None);
        fake.receive().await;
        fake.play(&(line(&init()) + &line(&result(None)))).await;
        assert_eq!(until_completed(&mut events).await[0], Event::TurnStarted);
        assert!(fake.silent().await);

        session
            .send_turn(&build("and again"))
            .expect("stdin is open");
        assert_eq!(fake.receive().await, Some(user("and again")));
        fake.play(&(line(&init()) + &line(&result(None)))).await;
        let second = until_completed(&mut events).await;
        assert_eq!(second[0], Event::TurnStarted);
        assert_eq!(session.session_id().as_deref(), Some("s-1"));

        session.close();
        assert_eq!(fake.receive().await, None, "close ends stdin");
    }

    /// The recorded 2.1.319 run: a background Bash task outlives the turn that
    /// started it, and its end opens a wake turn that nothing was written for.
    #[tokio::test]
    async fn a_background_task_outlives_its_turn_and_wakes_a_turn_of_its_own() {
        let (session, mut events, mut fake) = pair(None);
        fake.receive().await;
        fake.play(WAKE).await;
        let first = until_completed(&mut events).await;
        assert!(first.contains(&Event::BackgroundUpdated {
            tasks: vec![chat::BackgroundTask {
                task_id: "b561loltj".to_owned(),
                kind: "local_bash".to_owned(),
                description: "Background sleep then echo completion marker".to_owned(),
            }],
        }));
        assert_eq!(rosters(&first), [vec!["b561loltj".to_owned()]]);

        let wake = until_completed(&mut events).await;
        assert_eq!(rosters(&wake), [Vec::<String>::new()]);
        assert_eq!(
            wake.iter()
                .filter(|event| **event == Event::TurnStarted)
                .count(),
            1
        );
        assert!(matches!(
            wake.last(),
            Some(Event::TurnCompleted(TurnCompleted {
                state: TurnState::Completed,
                ..
            }))
        ));
        assert!(session.background().is_empty());
        assert!(fake.silent().await, "nothing is written for a wake turn");
    }

    /// T3 Code's `claude_background_wake_before_queued_prompt`: Claude runs a
    /// wake it already had before the line written after the last `result`.
    /// That line keeps its own turn, live and in a replay.
    #[tokio::test]
    async fn a_wake_that_opens_before_a_written_prompt_leaves_the_prompt_its_own_turn() {
        let (session, mut events, mut fake) = pair(None);
        fake.receive().await;
        fake.play(&(line(&init()) + &line(&result(None)))).await;
        until_completed(&mut events).await;
        session.send_turn(&build("next")).expect("stdin is open");
        fake.receive().await;
        fake.play(&(line(&init()) + &line(&result(Some("task-notification")))))
            .await;
        until_completed(&mut events).await;
        fake.play(&line(&init())).await;
        assert_eq!(
            events.recv().await.expect("an event").event,
            Event::TurnStarted,
            "the prompt's own turn opens"
        );
        drop(fake);
        assert!(matches!(
            events.recv().await.expect("an event").event,
            Event::TurnCompleted(TurnCompleted {
                state: TurnState::Failed,
                ..
            })
        ));
        assert!(events.recv().await.is_none(), "the events end with stdout");

        let out = [
            init(),
            result(None),
            init(),
            result(Some("task-notification")),
            init(),
        ]
        .iter()
        .map(line)
        .collect::<String>();
        let input = line(&user("first")) + &line(&user("next"));
        let replayed = replay(THREAD, RUN, out.as_bytes(), input.as_bytes());
        assert!(replayed.running());
        assert_eq!(
            shape(&replayed.events),
            ["prompt", "turn", "end", "turn", "end", "prompt", "turn"]
        );
        assert_eq!(
            replayed.events[5].event,
            Event::ContentDelta(chat::ContentDelta {
                stream_kind: StreamKind::UserText,
                delta: "next".to_owned(),
                item_id: Some(format!("user:{RUN}:2")),
            })
        );
    }

    /// The roster is Claude's own list. A task's start adds it when no list
    /// came first, its end removes it, and a foreground task is not one.
    #[test]
    fn the_roster_follows_claudes_list_and_each_task_start_and_end() {
        let task = |id: &str| json!({"task_id": id, "task_type": "local_bash", "description": id});
        let lines = [
            init(),
            json!({"type": "system", "subtype": "task_started", "task_id": "a",
                   "task_type": "local_agent", "description": "Agent A"}),
            json!({"type": "system", "subtype": "background_tasks_changed",
                   "tasks": [task("a"), task("b")]}),
            // 2.1.281 sends the list before the notification.
            json!({"type": "system", "subtype": "background_tasks_changed", "tasks": [task("b")]}),
            json!({"type": "system", "subtype": "task_notification", "task_id": "a",
                   "status": "completed"}),
            json!({"type": "system", "subtype": "task_started", "task_id": "f",
                   "is_backgrounded": false}),
        ];
        let out: String = lines.iter().map(line).collect();
        let replayed = replay(THREAD, RUN, out.as_bytes(), b"");
        let seen: Vec<Event> = replayed.events.into_iter().map(|e| e.event).collect();
        assert_eq!(
            rosters(&seen),
            [
                vec!["a".to_owned()],
                vec!["a".to_owned(), "b".to_owned()],
                vec!["b".to_owned()]
            ]
        );
        assert_eq!(replayed.state.background.len(), 1);
    }

    /// ADR-0041 decision 5: a turn in another mode sets it on the live
    /// process first, and only when it changed.
    #[tokio::test]
    async fn a_new_mode_is_set_on_the_live_process_once() {
        let (session, _events, mut fake) = pair(None);
        fake.receive().await;
        let edits = |text| Prompt {
            text,
            mode: PermissionMode::AutoAcceptEdits,
            interaction: Interaction::Build,
            model: None,
            effort: None,
        };
        session.send_turn(&edits("edit")).expect("stdin is open");
        assert_eq!(
            fake.receive().await,
            Some(
                json!({"type": "control_request", "request_id": "yantra-mode-1",
                "request": {"subtype": "set_permission_mode", "mode": "acceptEdits"}})
            )
        );
        assert_eq!(fake.receive().await, Some(user("edit")));
        session.send_turn(&edits("again")).expect("stdin is open");
        assert_eq!(fake.receive().await, Some(user("again")));
        session
            .send_turn(&Prompt {
                text: "plan it",
                mode: PermissionMode::Supervised,
                interaction: Interaction::Plan,
                model: None,
                effort: None,
            })
            .expect("stdin is open");
        assert_eq!(
            fake.receive().await.expect("a line")["request"],
            json!({"subtype": "set_permission_mode", "mode": "plan"})
        );
        assert_eq!(fake.receive().await, Some(user("plan it")));
    }

    /// Y-564, ADR-0041 decision 5: a turn with another model or effort sets
    /// it on the live process before its line, and an unchanged pair sends
    /// nothing. `None` goes back to Claude's default.
    #[tokio::test]
    async fn a_new_model_or_effort_is_set_on_the_live_process_once() {
        let (session, _events, mut fake) = pair(None);
        fake.receive().await;
        let opus = Model::try_from("opus".to_owned()).expect("a model");
        let turn = |text, model, effort| Prompt {
            model,
            effort,
            ..build(text)
        };
        session
            .send_turn(&turn("same", None, None))
            .expect("stdin is open");
        assert_eq!(fake.receive().await, Some(user("same")));

        session
            .send_turn(&turn("opus", Some(&opus), None))
            .expect("stdin is open");
        assert_eq!(
            fake.receive().await,
            Some(
                json!({"type": "control_request", "request_id": "yantra-model-1",
                "request": {"subtype": "set_model", "model": "opus"}})
            )
        );
        assert_eq!(fake.receive().await, Some(user("opus")));

        session
            .send_turn(&turn("think", Some(&opus), Some(Effort::Max)))
            .expect("stdin is open");
        assert_eq!(
            fake.receive().await.expect("a line")["request"],
            json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": "max"}})
        );
        assert_eq!(fake.receive().await, Some(user("think")));

        session
            .send_turn(&turn("again", Some(&opus), Some(Effort::Max)))
            .expect("stdin is open");
        assert_eq!(fake.receive().await, Some(user("again")));

        session
            .send_turn(&turn("default", None, None))
            .expect("stdin is open");
        assert_eq!(
            fake.receive().await.expect("a line")["request"],
            json!({"subtype": "set_model", "model": null})
        );
        assert_eq!(
            fake.receive().await.expect("a line")["request"],
            json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": null}})
        );
        assert_eq!(fake.receive().await, Some(user("default")));
    }

    /// Recorded on 2.1.319 with no user turn: Claude answers `set_model` and
    /// `apply_flag_settings` with success, `null` included, and the session
    /// reads those answers as no event.
    #[tokio::test]
    async fn claudes_answers_to_a_model_or_effort_change_make_no_event() {
        assert_eq!(MODEL_EFFORT.matches("\"subtype\":\"success\"").count(), 4);
        assert!(!MODEL_EFFORT.contains("not supported"));
        let (_session, mut events, mut fake) = pair(None);
        fake.receive().await;
        fake.play(MODEL_EFFORT).await;
        fake.play(&(line(&init()) + &line(&result(None)))).await;
        let seen = until_completed(&mut events).await;
        assert!(matches!(seen.first(), Some(Event::TurnStarted)), "{seen:?}");
    }

    /// ADR-0041 decision 6, recorded on 2.1.319: `stop_task` stops a task
    /// that runs, the roster empties, and no wake turn opens.
    #[tokio::test]
    async fn stop_task_stops_a_running_task_and_refuses_one_that_does_not_run() {
        let (session, mut events, mut fake) = pair(None);
        fake.receive().await;
        let at = STOP
            .lines()
            .position(|line| line.contains("\"type\":\"result\""))
            .expect("a result");
        let lines: Vec<&str> = STOP.lines().collect();
        fake.play(&(lines[..=at].join("\n") + "\n")).await;
        until_completed(&mut events).await;
        assert_eq!(session.background(), ["b5cnjn3f7"]);

        assert!(matches!(
            session.stop_task("b0000000"),
            Err(Error::NoTask(task)) if task == "b0000000"
        ));
        session.stop_task("b5cnjn3f7").expect("it runs");
        assert_eq!(
            fake.receive().await,
            Some(
                json!({"type": "control_request", "request_id": "yantra-stop-1",
                "request": {"subtype": "stop_task", "task_id": "b5cnjn3f7"}})
            )
        );
        fake.play(&(lines[at + 1..].join("\n") + "\n")).await;
        assert_eq!(
            events.recv().await.expect("an event").event,
            Event::BackgroundUpdated { tasks: vec![] }
        );
        assert!(session.background().is_empty());
        drop(fake);
        assert!(events.recv().await.is_none(), "no turn opened");
    }

    /// A process that ends takes its tasks with it, so the roster empties
    /// whether Claude said so or not.
    #[tokio::test]
    async fn an_end_with_tasks_running_empties_the_roster() {
        let (session, mut events, mut fake) = pair(None);
        fake.receive().await;
        let at = STOP
            .lines()
            .position(|line| line.contains("\"type\":\"result\""))
            .expect("a result");
        let lines: Vec<&str> = STOP.lines().collect();
        fake.play(&(lines[..=at].join("\n") + "\n")).await;
        until_completed(&mut events).await;
        assert_eq!(session.background(), ["b5cnjn3f7"]);

        drop(fake);
        let made = events.recv().await.expect("an event");
        assert_eq!(made.event, Event::BackgroundUpdated { tasks: vec![] });
        assert_eq!(made.cursor, None, "the daemon made it");
        assert!(session.background().is_empty());
        assert!(events.recv().await.is_none(), "no turn was open");
    }

    /// A replay of many turns draws each prompt before its turn, none before
    /// a wake, and says what still runs at the point `out` was cut.
    #[test]
    fn a_replay_across_turns_places_each_prompt_and_knows_the_tasks() {
        let input = line(&user("Run it"));
        let all = replay(THREAD, RUN, WAKE.as_bytes(), input.as_bytes());
        assert!(!all.running());
        assert!(all.background().is_empty());
        assert_eq!(shape(&all.events), ["prompt", "turn", "end", "turn", "end"]);
        assert_eq!(all.events[0], prompted(THREAD, RUN, 1, "Run it".to_owned()));

        let cut = |lines: usize| -> String {
            WAKE.lines()
                .take(lines)
                .map(|line| format!("{line}\n"))
                .collect()
        };
        let after_the_turn = replay(THREAD, RUN, cut(7).as_bytes(), input.as_bytes());
        assert!(!after_the_turn.running());
        assert_eq!(after_the_turn.background(), ["b561loltj"]);
        let in_the_wake = replay(THREAD, RUN, cut(12).as_bytes(), input.as_bytes());
        assert!(in_the_wake.running());
        let made = |replayed: &Replayed| -> Vec<Event> {
            replayed
                .end(String::new())
                .into_iter()
                .map(|made| made.event)
                .collect()
        };
        assert!(
            matches!(&made(&in_the_wake)[..], [Event::TurnCompleted(_)]),
            "the wake turn was open, and its task had ended"
        );
        assert_eq!(
            made(&after_the_turn),
            [Event::BackgroundUpdated { tasks: vec![] }],
            "no turn was open, and the task still ran"
        );
        assert_eq!(
            shape(&in_the_wake.events),
            ["prompt", "turn", "end", "turn"]
        );
    }

    /// A line cut off mid-way is not read, so the reader that carries on
    /// starts at that line and no event is made twice.
    #[test]
    fn a_replay_stops_at_the_last_whole_line() {
        let cut = &ACCEPT[..ACCEPT.len() - 10];
        let replayed = replay(THREAD, RUN, cut.as_bytes(), sent(true).as_bytes());
        let last_line = ACCEPT.lines().last().map_or(0, str::len) + 1;
        assert_eq!(replayed.offset, (ACCEPT.len() - last_line) as u64);
        assert!(replayed.running());
    }
}
