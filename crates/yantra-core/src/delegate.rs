//! A delegated task (ADR-0033 decisions 4 and 5): one ACP agent that works
//! alone in a new git worktree on a machine, and what it leaves there.
//!
//! Nobody answers the agent's questions while it works. Each permission request
//! gets the agent's own "allow once", because the worktree is the isolation and
//! the main agent reviews the diff before anything merges.
//!
//! ACP cannot steer a running turn, so a steer cancels the turn and sends its
//! prompt as the next turn of the same session, as T3 Code does for an ACP agent.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::acp::{self, Agent, Answer, Events, Harness};
use crate::chat::{self, Event};
use crate::clone::destination;
use crate::ssh::{self, Exec, Ssh};
use crate::tmux::sq;

/// How long `stop` lets a cancelled turn end by itself before it cuts it off.
const STOP_GRACE: Duration = Duration::from_secs(10);
/// The exit status the worktree script gives a path that is not a work tree.
pub(crate) const NOT_A_REPO: i32 = 3;
/// How long a wait lasts when its caller names no limit.
pub const WAIT: Duration = Duration::from_secs(60);
/// The longest wait anyone gets, so a waiter cannot hold a connection for ever.
pub const WAIT_LIMIT: Duration = Duration::from_secs(600);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("`{repo}` is not a git work tree on that machine")]
    NotARepo { repo: String },

    /// Not `/…` or `~/…`: git would read anything else from the home directory.
    #[error("`{repo}` is not a path from `/` or from `~/`")]
    RepoPath { repo: String },

    #[error("the operating system gave no random bytes for an id")]
    Random(#[source] std::io::Error),

    #[error("git could not prepare or remove the task's worktree: {stderr}")]
    Worktree { stderr: String },

    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    #[error(transparent)]
    Acp(#[from] acp::Error),

    #[error("the task has ended or is stopping, so it takes no more prompts")]
    Ended,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Starting,
    Running,
    Completed,
    Cancelled,
    Failed(String),
}

impl State {
    pub fn is_terminal(&self) -> bool {
        !matches!(self, Self::Starting | Self::Running)
    }
}

/// What the agent changed in its worktree, as git reports it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Summary {
    /// Every changed path, untracked files included.
    pub changed: Vec<String>,
    /// `git diff --shortstat` against [`Place::base`], which counts tracked files only.
    pub shortstat: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub state: State,
    /// The agent's last message of the turn: the text after its last tool call.
    pub last_message: Option<String>,
    /// Taken when the turn ends and on each [`Task::summary`], never on a read.
    pub summary: Option<Summary>,
}

/// Where a task works.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    pub id: String,
    /// The repository's top level, as the machine spells it.
    pub repo: String,
    pub worktree: String,
    pub branch: String,
    /// The commit the worktree started at. The summary diffs against it, so
    /// work the agent commits on its branch still shows.
    pub base: String,
}

#[derive(Debug)]
struct Inner {
    progress: Progress,
    session: Option<String>,
    /// Set by `stop`, which takes the summary, so the runner does not.
    stopping: bool,
    /// Prompts for the turn after this one, joined by a blank line.
    steer: Option<String>,
    /// The agent message being written now, and whether a tool call ended it.
    message: String,
    message_open: bool,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            progress: Progress {
                state: State::Starting,
                last_message: None,
                summary: None,
            },
            session: None,
            stopping: false,
            steer: None,
            message: String::new(),
            message_open: false,
        }
    }
}

type Shared = Arc<Mutex<Inner>>;

fn lock(shared: &Shared) -> MutexGuard<'_, Inner> {
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Debug)]
struct Running {
    // Weak, so the agent and its `ssh` end when the last turn ends rather than at `stop`.
    agent: Weak<Agent>,
    runner: JoinHandle<()>,
}

/// One delegated task. The daemon keeps it in memory, so a restart forgets it
/// and leaves its worktree on the machine (ADR-0033 decision 7).
#[derive(Debug)]
pub struct Task {
    place: Place,
    ssh: Ssh,
    shared: Shared,
    running: Mutex<Option<Running>>,
    /// True once the task has ended and taken its last summary.
    settled: watch::Sender<bool>,
}

impl Drop for Task {
    fn drop(&mut self) {
        if let Some(running) = self
            .running
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            running.runner.abort();
        }
    }
}

impl Task {
    /// Makes a worktree of `repo` on a new branch, starts `harness` in it and
    /// sends it `prompt`. Returns once the agent has started; the turn runs on.
    pub async fn start(
        ssh: Ssh,
        harness: Harness,
        repo: &str,
        prompt: &str,
    ) -> Result<Self, Error> {
        let place = prepare(&ssh, repo, &id()?).await?;
        let (agent, events) = match Agent::start(&ssh, harness) {
            Ok(started) => started,
            Err(error) => {
                // A worktree with no agent in it is litter.
                let _ = ssh.exec(&removal(&place)).await;
                return Err(error.into());
            }
        };
        Ok(Self::spawn(
            place,
            ssh.clone(),
            Arc::new(agent),
            events,
            prompt,
            ssh,
        ))
    }

    /// Runs `agent` in `place`. The runner asks `machine` for its git, so a
    /// test can script it.
    fn spawn<E: Exec + Send + Sync + 'static>(
        place: Place,
        ssh: Ssh,
        agent: Arc<Agent>,
        events: Events,
        prompt: &str,
        machine: E,
    ) -> Self {
        let shared = Shared::default();
        let settled = watch::Sender::new(false);
        let runner = {
            let (agent, shared, settled) =
                (Arc::clone(&agent), Arc::clone(&shared), settled.clone());
            let (place, prompt) = (place.clone(), prompt.to_owned());
            tokio::spawn(async move {
                drive(agent, events, &place.worktree, &prompt, &shared).await;
                let (opened, stopping) = {
                    let inner = lock(&shared);
                    (inner.session.is_some(), inner.stopping)
                };
                if !opened {
                    // ADR-0033 decision 4: the agent never started, so the worktree goes.
                    let removed = machine.exec(&removal(&place)).await;
                    if matches!(&removed, Ok(out) if out.success())
                        && let State::Failed(said) = &mut lock(&shared).progress.state
                    {
                        said.push_str("; its worktree and branch were removed");
                    }
                } else if !stopping
                    && let Ok(summary) = summarise(&machine, &place.worktree, &place.base).await
                {
                    lock(&shared).progress.summary = Some(summary);
                }
                if !stopping {
                    settled.send_replace(true);
                }
            })
        };
        Self {
            place,
            ssh,
            shared,
            running: Mutex::new(Some(Running {
                agent: Arc::downgrade(&agent),
                runner,
            })),
            settled,
        }
    }

    pub fn place(&self) -> &Place {
        &self.place
    }

    /// Reads memory and nothing else.
    pub fn progress(&self) -> Progress {
        lock(&self.shared).progress.clone()
    }

    /// Asks the machine what changed in the worktree, and keeps the answer.
    pub async fn summary(&self) -> Result<Summary, Error> {
        let summary = summarise(&self.ssh, &self.place.worktree, &self.place.base).await?;
        lock(&self.shared).progress.summary = Some(summary.clone());
        Ok(summary)
    }

    /// Sends `prompt` to the agent as its next turn, in the same session. A
    /// running turn is cancelled for it; a turn not yet begun runs first.
    pub fn steer(&self, prompt: &str) -> Result<(), Error> {
        let agent = self
            .running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .and_then(|running| running.agent.upgrade());
        let mut inner = lock(&self.shared);
        if inner.stopping || inner.progress.state.is_terminal() {
            return Err(Error::Ended);
        }
        match &mut inner.steer {
            Some(queued) => {
                queued.push_str("\n\n");
                queued.push_str(prompt);
            }
            None => inner.steer = Some(prompt.to_owned()),
        }
        // Sent under the lock, so it reaches the agent before the runner can
        // send the steer, and never cancels the steered turn instead.
        if inner.progress.state == State::Running
            && let (Some(agent), Some(session)) = (agent, &inner.session)
        {
            // A failed send means the agent has gone, and its turn says so.
            let _ = agent.cancel(session);
        }
        Ok(())
    }

    /// Waits up to `limit` for the task to end and take its last summary.
    /// Reads memory only. True when the task has settled.
    pub async fn wait(&self, limit: Duration) -> bool {
        let mut settled = self.settled.subscribe();
        tokio::time::timeout(limit, settled.wait_for(|settled| *settled))
            .await
            .is_ok_and(|seen| seen.is_ok())
    }

    /// Cancels the turn, ends the agent and takes the worktree's summary. The
    /// worktree stays for review. A summary the machine cannot give leaves the
    /// one the turn took, and the error says why.
    pub async fn stop(&self) -> Result<Summary, Error> {
        self.halt().await;
        let summary = self.summary().await;
        self.settled.send_replace(true);
        summary
    }

    async fn halt(&self) {
        let running = self
            .running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(Running { agent, mut runner }) = running {
            let session = {
                let mut inner = lock(&self.shared);
                inner.stopping = true;
                inner.session.clone()
            };
            let cancelled = match (agent.upgrade(), session) {
                (Some(agent), Some(session)) => agent.cancel(&session).is_ok(),
                // No turn has begun, or the agent has already gone.
                _ => false,
            };
            if !cancelled || tokio::time::timeout(STOP_GRACE, &mut runner).await.is_err() {
                runner.abort();
            }
        }
        let mut inner = lock(&self.shared);
        if !inner.progress.state.is_terminal() {
            inner.progress.state = State::Cancelled;
        }
    }

    /// Stops the task, then removes its worktree and its branch.
    pub async fn remove(&self) -> Result<(), Error> {
        self.halt().await;
        self.settled.send_replace(true);
        let out = self.ssh.exec(&removal(&self.place)).await?;
        if !out.success() {
            return Err(Error::Worktree {
                stderr: said(&out.stderr),
            });
        }
        Ok(())
    }
}

/// 64 random bits, so two live tasks never share an id.
pub(crate) fn id() -> Result<String, Error> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|error| Error::Random(std::io::Error::other(error)))?;
    Ok(format!("{:016x}", u64::from_ne_bytes(bytes)))
}

pub(crate) fn said(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr).trim().to_owned()
}

/// `repo` may name any directory inside a repository; the worktree is made from
/// its top level, at that repository's `HEAD`.
fn worktree_command(repo: &str, id: &str) -> String {
    format!(
        "top=$(git -C {repo} rev-parse --show-toplevel 2>/dev/null) || exit {NOT_A_REPO}\n\
         wt=\"$HOME\"/.yantra/worktrees/{id}\n\
         mkdir -p \"$HOME/.yantra/worktrees\" \
         && git -C \"$top\" worktree add -q -b {branch} \"$wt\" HEAD >&2 \
         && printf '%s\\n%s\\n' \"$top\" \"$wt\" && git -C \"$wt\" rev-parse HEAD",
        repo = destination(repo),
        id = sq(id),
        branch = sq(&branch(id)),
    )
}

pub(crate) fn branch(id: &str) -> String {
    format!("yantra/{id}")
}

pub(crate) async fn prepare<E: Exec>(exec: &E, repo: &str, id: &str) -> Result<Place, Error> {
    if !(repo.starts_with('/') || repo.starts_with("~/")) {
        return Err(Error::RepoPath {
            repo: repo.to_owned(),
        });
    }
    let out = exec.exec(&worktree_command(repo, id)).await?;
    if out.status == NOT_A_REPO {
        return Err(Error::NotARepo {
            repo: repo.to_owned(),
        });
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut lines = stdout.lines();
    match (out.success(), lines.next(), lines.next(), lines.next()) {
        (true, Some(top), Some(worktree), Some(base)) => Ok(Place {
            id: id.to_owned(),
            repo: top.to_owned(),
            worktree: worktree.to_owned(),
            branch: branch(id),
            base: base.to_owned(),
        }),
        _ => Err(Error::Worktree {
            stderr: said(&out.stderr),
        }),
    }
}

/// Succeeds when the worktree or the branch is already gone, so a removal
/// that runs twice, or after someone deleted the folder, still ends clean.
pub(crate) fn removal(place: &Place) -> String {
    let (repo, worktree, branch) = (sq(&place.repo), sq(&place.worktree), sq(&place.branch));
    let head = sq(&format!("refs/heads/{}", place.branch));
    format!(
        "{{ [ ! -e {worktree} ] || git -C {repo} worktree remove --force {worktree}; }} \
         && git -C {repo} worktree prune \
         && {{ ! git -C {repo} rev-parse -q --verify {head} >/dev/null \
         || git -C {repo} branch -D {branch} >/dev/null; }}"
    )
}

/// Diffs the working tree against `base`, so committed and uncommitted work
/// both count, in one round trip: the shortstat, a NUL, then the paths.
pub(crate) async fn summarise<E: Exec>(
    exec: &E,
    worktree: &str,
    base: &str,
) -> Result<Summary, Error> {
    let (worktree, base) = (sq(worktree), sq(base));
    let out = exec
        .exec(&format!(
            "git -C {worktree} diff --shortstat {base} && printf '\\0' \
             && git -C {worktree} diff --name-only -z {base} \
             && git -C {worktree} ls-files -z --others --exclude-standard"
        ))
        .await?;
    if !out.success() {
        return Err(Error::Worktree {
            stderr: said(&out.stderr),
        });
    }
    Ok(summary(&out.stdout))
}

/// `-z` keeps git from quoting a path with a space or non-ASCII, so a path is
/// whatever lies between two NULs. A rename gives its new side only.
fn summary(said: &[u8]) -> Summary {
    let (stat, names) = said
        .iter()
        .position(|&byte| byte == 0)
        .map_or((said, &[][..]), |at| (&said[..at], &said[at + 1..]));
    Summary {
        changed: names
            .split(|&byte| byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| String::from_utf8_lossy(path).into_owned())
            .collect(),
        shortstat: String::from_utf8_lossy(stat).trim().to_owned(),
    }
}

/// Runs the first prompt, then each steer, and sets the state the last turn
/// ended in.
async fn drive(agent: Arc<Agent>, mut events: Events, cwd: &str, prompt: &str, shared: &Shared) {
    let session = match open(&agent, cwd, shared).await {
        Ok(session) => session,
        Err(error) => return settle(&mut lock(shared), Err(error)),
    };
    let mut prompt = prompt.to_owned();
    loop {
        let ended = turn(&agent, &mut events, &session, &prompt, shared).await;
        // One lock for the steer and the end, so a steer `steer` took is sent.
        let mut inner = lock(shared);
        match inner.steer.take() {
            Some(next) if ended.is_ok() && !inner.stopping => prompt = next,
            _ => return settle(&mut inner, ended),
        }
    }
}

fn settle(inner: &mut Inner, ended: Result<chat::StopReason, acp::Error>) {
    inner.steer = None;
    inner.progress.state = match ended {
        Ok(chat::StopReason::Cancelled) => State::Cancelled,
        Ok(_) => State::Completed,
        Err(error) => State::Failed(error.to_string()),
    };
}

async fn open(agent: &Agent, cwd: &str, shared: &Shared) -> Result<String, acp::Error> {
    agent.initialize().await?;
    let session = agent.new_session(cwd).await?;
    lock(shared).session = Some(session.clone());
    Ok(session)
}

async fn turn(
    agent: &Agent,
    events: &mut Events,
    session: &str,
    prompt: &str,
    shared: &Shared,
) -> Result<chat::StopReason, acp::Error> {
    let watch = async {
        while let Some(update) = events.recv().await {
            if let Event::RequestOpened(opened) = &update.event {
                // An answer that cannot be sent means the agent has gone, and
                // the prompt's own result says so.
                let _ = agent.answer(&opened.request_id, choose(opened));
            }
            let ended = matches!(update.event, Event::TurnCompleted(_));
            fold(&mut lock(shared), &update.event);
            if ended {
                return;
            }
        }
    };
    let (stopped, ()) = tokio::join!(agent.prompt(session, prompt), watch);
    stopped
}

fn choose(opened: &chat::RequestOpened) -> Answer {
    opened
        .options
        .iter()
        .find(|option| option.decision == chat::Decision::Accept)
        .map_or(Answer::Cancelled, |option| {
            Answer::Selected(option.option_id.clone())
        })
}

fn fold(inner: &mut Inner, event: &Event) {
    match event {
        Event::TurnStarted => {
            inner.progress.state = State::Running;
            inner.progress.last_message = None;
            inner.message.clear();
            inner.message_open = false;
        }
        Event::ContentDelta(delta) if delta.stream_kind == chat::StreamKind::AssistantText => {
            if !inner.message_open {
                inner.message.clear();
                inner.message_open = true;
            }
            inner.message.push_str(&delta.delta);
            inner.progress.last_message = Some(inner.message.clone());
        }
        Event::ItemStarted(_) | Event::ItemUpdated(_) | Event::ItemCompleted(_) => {
            inner.message_open = false;
        }
        _ => {}
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader, DuplexStream};
    use tokio::io::{ReadHalf, WriteHalf};

    const SESSION: &str = "ses_1";

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
            serde_json::from_str(&line).expect("one JSON message per line")
        }

        async fn send(&mut self, message: Value) {
            self.to_client
                .write_all(format!("{message}\n").as_bytes())
                .await
                .expect("the pipe writes");
        }

        async fn reply(&mut self, request: &Value, result: Value) {
            self.send(json!({"jsonrpc": "2.0", "id": request["id"], "result": result}))
                .await;
        }

        async fn update(&mut self, update: Value) {
            self.send(json!({"jsonrpc": "2.0", "method": "session/update",
                             "params": {"sessionId": SESSION, "update": update}}))
                .await;
        }

        /// Answers `initialize` and `session/new`, and returns the prompt.
        async fn open(&mut self) -> Value {
            let initialize = self.receive().await;
            assert_eq!(initialize["method"], "initialize");
            self.reply(&initialize, json!({"protocolVersion": 1})).await;
            let new = self.receive().await;
            assert_eq!(new["method"], "session/new");
            assert_eq!(new["params"]["cwd"], "/w");
            self.reply(&new, json!({"sessionId": SESSION})).await;
            let prompt = self.receive().await;
            assert_eq!(prompt["method"], "session/prompt");
            assert_eq!(prompt["params"]["prompt"][0]["text"], "fix it");
            prompt
        }
    }

    fn pair() -> (Arc<Agent>, Events, Fake) {
        let (client, agent) = tokio::io::duplex(1 << 16);
        let (client_read, client_write) = tokio::io::split(client);
        let (agent_read, agent_write) = tokio::io::split(agent);
        let (client, events) = Agent::over(Harness::Opencode, client_read, client_write);
        let fake = Fake {
            from_client: BufReader::new(agent_read),
            to_client: agent_write,
        };
        (Arc::new(client), events, fake)
    }

    fn chunk(text: &str) -> Value {
        json!({"sessionUpdate": "agent_message_chunk", "messageId": "m",
               "content": {"type": "text", "text": text}})
    }

    fn asked(id: u64, options: &Value) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": "session/request_permission",
               "params": {"sessionId": SESSION,
                   "toolCall": {"toolCallId": "t1", "title": "Write a.txt", "kind": "edit"},
                   "options": options}})
    }

    #[tokio::test]
    async fn a_turn_keeps_the_text_after_the_last_tool_call_and_completes() {
        let (agent, events, mut fake) = pair();
        let shared = Shared::default();
        let ((), ()) = tokio::join!(drive(agent, events, "/w", "fix it", &shared), async {
            let prompt = fake.open().await;
            fake.update(chunk("I will look ")).await;
            fake.update(chunk("first.")).await;
            fake.update(json!({"sessionUpdate": "tool_call", "toolCallId": "t1",
                               "title": "ls", "kind": "execute", "status": "pending"}))
                .await;
            fake.update(chunk("Fixed ")).await;
            fake.update(chunk("the bug.")).await;
            fake.reply(&prompt, json!({"stopReason": "end_turn"})).await;
        });
        let progress = lock(&shared).progress.clone();
        assert_eq!(progress.state, State::Completed);
        assert_eq!(progress.last_message.as_deref(), Some("Fixed the bug."));
        assert_eq!(lock(&shared).session.as_deref(), Some(SESSION));
    }

    fn place() -> Place {
        Place {
            id: "ab12cd34".to_owned(),
            repo: "/r".to_owned(),
            worktree: "/w".to_owned(),
            branch: "yantra/ab12cd34".to_owned(),
            base: "0123abcd".to_owned(),
        }
    }

    /// A task on the scripted agent, whose runner takes its summary from a
    /// scripted machine. Its `ssh` goes nowhere and these tests never use it.
    fn task(agent: Arc<Agent>, events: Events) -> Task {
        let ssh = Ssh::new(ssh::Machine {
            host: "nowhere.invalid".to_owned(),
            user: None,
            port: None,
            identity: None,
            state_dir: "/nonexistent".into(),
        })
        .expect("a short control path");
        let machine = scripted(vec![out(0, " 1 file changed\n\0a.txt\0", "")]);
        Task::spawn(place(), ssh, agent, events, "fix it", machine)
    }

    async fn until_running(task: &Task) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while task.progress().state != State::Running {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("the turn starts within 5 s");
    }

    fn prompted(message: &Value) -> &Value {
        assert_eq!(message["method"], "session/prompt", "{message}");
        assert_eq!(message["params"]["sessionId"], SESSION, "{message}");
        &message["params"]["prompt"][0]["text"]
    }

    #[tokio::test]
    async fn a_steer_cancels_the_running_turn_and_prompts_again() {
        let (agent, events, mut fake) = pair();
        let task = task(agent, events);
        let first = fake.open().await;
        until_running(&task).await;
        task.steer("and the docs")
            .expect("a running task takes a steer");
        let cancel = fake.receive().await;
        assert_eq!(cancel["method"], "session/cancel", "{cancel}");
        assert_eq!(cancel["params"]["sessionId"], SESSION);
        fake.reply(&first, json!({"stopReason": "cancelled"})).await;
        let second = fake.receive().await;
        assert_eq!(prompted(&second), "and the docs");
        assert_eq!(
            task.progress().state,
            State::Running,
            "the steer's cancel never shows as Cancelled"
        );
        fake.update(chunk("Docs done.")).await;
        fake.reply(&second, json!({"stopReason": "end_turn"})).await;
        assert!(task.wait(Duration::from_secs(5)).await);
        let progress = task.progress();
        assert_eq!(progress.state, State::Completed);
        assert_eq!(progress.last_message.as_deref(), Some("Docs done."));
    }

    #[tokio::test]
    async fn a_steer_before_the_turn_begins_waits_for_it() {
        let (agent, events, mut fake) = pair();
        let task = task(agent, events);
        assert_eq!(task.progress().state, State::Starting);
        task.steer("and the docs")
            .expect("a starting task takes a steer");
        let first = fake.open().await;
        fake.reply(&first, json!({"stopReason": "end_turn"})).await;
        let second = fake.receive().await;
        assert_eq!(prompted(&second), "and the docs", "no cancel came first");
        fake.reply(&second, json!({"stopReason": "end_turn"})).await;
        assert!(task.wait(Duration::from_secs(5)).await);
        assert_eq!(task.progress().state, State::Completed);
    }

    #[tokio::test]
    async fn two_steers_reach_the_agent_as_one_prompt() {
        let (agent, events, mut fake) = pair();
        let task = task(agent, events);
        task.steer("and the docs").expect("taken");
        task.steer("and the tests").expect("taken");
        let first = fake.open().await;
        fake.reply(&first, json!({"stopReason": "end_turn"})).await;
        let second = fake.receive().await;
        assert_eq!(prompted(&second), "and the docs\n\nand the tests");
        fake.reply(&second, json!({"stopReason": "end_turn"})).await;
        assert!(task.wait(Duration::from_secs(5)).await);
        assert_eq!(task.progress().state, State::Completed);
    }

    #[tokio::test]
    async fn a_steer_after_the_turn_has_ended_is_refused() {
        let (agent, events, mut fake) = pair();
        let task = task(agent, events);
        let first = fake.open().await;
        fake.reply(&first, json!({"stopReason": "end_turn"})).await;
        assert!(task.wait(Duration::from_secs(5)).await);
        assert!(matches!(task.steer("more"), Err(Error::Ended)));

        let (agent, events, mut fake) = pair();
        let stopping = self::task(agent, events);
        let first = fake.open().await;
        lock(&stopping.shared).stopping = true;
        assert!(
            matches!(stopping.steer("more"), Err(Error::Ended)),
            "a task being stopped takes no steer"
        );
        fake.reply(&first, json!({"stopReason": "end_turn"})).await;
    }

    /// The runner's summary lands before the wait returns, so a read after
    /// it has the diff.
    #[tokio::test]
    async fn wait_returns_when_the_task_settles_and_times_out_otherwise() {
        let (agent, events, mut fake) = pair();
        let task = task(agent, events);
        let first = fake.open().await;
        assert!(!task.wait(Duration::from_millis(20)).await, "the turn runs");
        assert_eq!(task.progress().summary, None);
        fake.reply(&first, json!({"stopReason": "end_turn"})).await;
        assert!(task.wait(Duration::from_secs(5)).await);
        assert_eq!(
            task.progress().summary,
            Some(Summary {
                changed: vec!["a.txt".to_owned()],
                shortstat: "1 file changed".to_owned(),
            })
        );
        assert!(
            task.wait(Duration::ZERO).await,
            "a settled task answers at once"
        );
    }

    #[tokio::test]
    async fn a_permission_request_is_allowed_once() {
        let (agent, events, mut fake) = pair();
        let shared = Shared::default();
        let ((), ()) = tokio::join!(drive(agent, events, "/w", "fix it", &shared), async {
            let prompt = fake.open().await;
            fake.send(asked(
                40,
                &json!([
                    {"optionId": "always", "name": "Always", "kind": "allow_always"},
                    {"optionId": "once", "name": "Yes", "kind": "allow_once"},
                    {"optionId": "no", "name": "No", "kind": "reject_once"}]),
            ))
            .await;
            assert_eq!(
                fake.receive().await,
                json!({"jsonrpc": "2.0", "id": 40,
                       "result": {"outcome": {"outcome": "selected", "optionId": "once"}}})
            );
            fake.reply(&prompt, json!({"stopReason": "end_turn"})).await;
        });
        assert_eq!(lock(&shared).progress.state, State::Completed);
    }

    #[tokio::test]
    async fn a_permission_request_with_no_allow_once_is_cancelled() {
        let (agent, events, mut fake) = pair();
        let shared = Shared::default();
        let ((), ()) = tokio::join!(drive(agent, events, "/w", "fix it", &shared), async {
            let prompt = fake.open().await;
            fake.send(asked(
                41,
                &json!([{"optionId": "no", "name": "No", "kind": "reject_once"}]),
            ))
            .await;
            assert_eq!(
                fake.receive().await,
                json!({"jsonrpc": "2.0", "id": 41,
                       "result": {"outcome": {"outcome": "cancelled"}}})
            );
            fake.reply(&prompt, json!({"stopReason": "cancelled"}))
                .await;
        });
        assert_eq!(lock(&shared).progress.state, State::Cancelled);
    }

    #[tokio::test]
    async fn a_refused_prompt_fails_with_the_agents_words() {
        let (agent, events, mut fake) = pair();
        let shared = Shared::default();
        let ((), ()) = tokio::join!(drive(agent, events, "/w", "fix it", &shared), async {
            let prompt = fake.open().await;
            fake.send(json!({"jsonrpc": "2.0", "id": prompt["id"],
                             "error": {"code": -32000, "message": "Authentication required"}}))
                .await;
        });
        assert_eq!(
            lock(&shared).progress.state,
            State::Failed("the agent refused: Authentication required (-32000)".to_owned())
        );
    }

    #[tokio::test]
    async fn an_agent_that_exits_before_the_session_fails_the_task() {
        let (agent, events, fake) = pair();
        drop(fake);
        let shared = Shared::default();
        drive(agent, events, "/w", "fix it", &shared).await;
        assert!(
            matches!(&lock(&shared).progress.state, State::Failed(said)
                if said.starts_with("the agent closed the connection")),
            "{:?}",
            lock(&shared).progress.state
        );
    }

    #[test]
    fn the_state_leaves_starting_when_the_turn_starts_and_a_new_turn_clears_the_message() {
        let mut inner = Inner::default();
        assert_eq!(inner.progress.state, State::Starting);
        assert!(!inner.progress.state.is_terminal());
        fold(
            &mut inner,
            &Event::ThreadStarted {
                thread: "t".to_owned(),
                harness: "opencode".to_owned(),
            },
        );
        assert_eq!(inner.progress.state, State::Starting);
        fold(&mut inner, &Event::TurnStarted);
        assert_eq!(inner.progress.state, State::Running);
        fold(
            &mut inner,
            &Event::ContentDelta(chat::ContentDelta {
                stream_kind: chat::StreamKind::ReasoningText,
                delta: "thinking".to_owned(),
                item_id: None,
            }),
        );
        assert_eq!(
            inner.progress.last_message, None,
            "a thought is not a message"
        );
        fold(
            &mut inner,
            &Event::ContentDelta(chat::ContentDelta {
                stream_kind: chat::StreamKind::AssistantText,
                delta: "hi".to_owned(),
                item_id: None,
            }),
        );
        assert_eq!(inner.progress.last_message.as_deref(), Some("hi"));
        fold(&mut inner, &Event::TurnStarted);
        assert_eq!(inner.progress.last_message, None);
        for done in [
            State::Completed,
            State::Cancelled,
            State::Failed(String::new()),
        ] {
            assert!(done.is_terminal());
        }
    }

    #[test]
    fn the_summary_reads_the_shortstat_then_every_path_unquoted() {
        let said = " 2 files changed, 3 insertions(+)\n\0src/lib.rs\0notes/new file.md\0\
                    untracked \u{fc}.txt\0"
            .as_bytes();
        assert_eq!(
            summary(said),
            Summary {
                changed: vec![
                    "src/lib.rs".to_owned(),
                    "notes/new file.md".to_owned(),
                    "untracked \u{fc}.txt".to_owned(),
                ],
                shortstat: "2 files changed, 3 insertions(+)".to_owned(),
            }
        );
        assert_eq!(summary(b"\0"), Summary::default(), "an empty diff");
        assert_eq!(
            summary(b"\0new.txt\0"),
            Summary {
                changed: vec!["new.txt".to_owned()],
                shortstat: String::new(),
            },
            "an untracked file alone has no shortstat"
        );
    }

    /// A scripted machine, so the parsing of each answer is tested here and
    /// the git behind it in tests/delegate.rs. It counts what it was asked.
    struct Said(Vec<ssh::Output>, usize);

    impl Exec for Mutex<Said> {
        async fn exec(&self, _command: &str) -> Result<ssh::Output, ssh::Error> {
            let mut said = lock_said(self);
            said.1 += 1;
            Ok(said.0.remove(0))
        }
    }

    fn scripted(replies: Vec<ssh::Output>) -> Mutex<Said> {
        Mutex::new(Said(replies, 0))
    }

    fn count(said: &Mutex<Said>) -> usize {
        lock_said(said).1
    }

    fn lock_said(said: &Mutex<Said>) -> MutexGuard<'_, Said> {
        said.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn out(status: i32, stdout: &str, stderr: &str) -> ssh::Output {
        ssh::Output {
            status,
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[tokio::test]
    async fn prepare_reads_the_top_level_and_the_worktree_or_names_the_refusal() {
        let made = scripted(vec![out(
            0,
            "/home/u/repo\n/home/u/.yantra/worktrees/ab12cd34\n0123abcd\n",
            "",
        )]);
        assert_eq!(
            prepare(&made, "~/repo/src", "ab12cd34")
                .await
                .expect("prepared"),
            Place {
                id: "ab12cd34".to_owned(),
                repo: "/home/u/repo".to_owned(),
                worktree: "/home/u/.yantra/worktrees/ab12cd34".to_owned(),
                branch: "yantra/ab12cd34".to_owned(),
                base: "0123abcd".to_owned(),
            }
        );

        let not = scripted(vec![out(NOT_A_REPO, "", "")]);
        assert!(matches!(
            prepare(&not, "/tmp", "x").await,
            Err(Error::NotARepo { repo }) if repo == "/tmp"
        ));

        let empty = scripted(vec![out(128, "", "fatal: invalid reference: HEAD\n")]);
        assert!(matches!(
            prepare(&empty, "/srv/r", "x").await,
            Err(Error::Worktree { stderr }) if stderr == "fatal: invalid reference: HEAD"
        ));
    }

    /// `git -C ''` is the home directory, so a path git would read from there
    /// is refused before the machine is asked.
    #[tokio::test]
    async fn prepare_refuses_a_repo_that_is_not_from_the_root_or_home() {
        for repo in ["", "repo", "~", "./repo", "~user/repo"] {
            let machine = scripted(vec![]);
            assert!(
                matches!(
                    prepare(&machine, repo, "x").await,
                    Err(Error::RepoPath { repo: refused }) if refused == repo
                ),
                "{repo:?}"
            );
            assert_eq!(count(&machine), 0, "{repo:?} reached the machine");
        }
    }

    #[tokio::test]
    async fn summarise_asks_once_and_a_failed_git_is_a_worktree_error() {
        let said = scripted(vec![out(
            0,
            " 1 file changed, 2 insertions(+)\n\0a.txt\0",
            "",
        )]);
        assert_eq!(
            summarise(&said, "/w", "0123abcd")
                .await
                .expect("summarised"),
            Summary {
                changed: vec!["a.txt".to_owned()],
                shortstat: "1 file changed, 2 insertions(+)".to_owned(),
            }
        );
        assert_eq!(count(&said), 1, "one round trip");
        let gone = scripted(vec![out(128, "", "fatal: cannot change to '/w'\n")]);
        assert!(matches!(
            summarise(&gone, "/w", "0123abcd").await,
            Err(Error::Worktree { stderr }) if stderr == "fatal: cannot change to '/w'"
        ));
        assert_eq!(count(&gone), 1);
    }

    #[test]
    fn every_path_reaches_the_shell_quoted() {
        let made = worktree_command("/srv/it's; id", "ab12cd34");
        assert!(
            made.contains(r"git -C '/srv/it'\''s; id' rev-parse"),
            "{made}"
        );
        assert!(made.contains("-b 'yantra/ab12cd34'"), "{made}");
        assert!(
            made.contains(r#"wt="$HOME"/.yantra/worktrees/'ab12cd34'"#),
            "{made}"
        );
        let nested = worktree_command("/srv/r", "chat/web/ab12cd34");
        assert!(
            nested.contains(r#"wt="$HOME"/.yantra/worktrees/'chat/web/ab12cd34'"#),
            "{nested}"
        );
        assert!(nested.contains("-b 'yantra/chat/web/ab12cd34'"), "{nested}");
        assert!(worktree_command("~/src/r", "x").contains(r#"git -C "$HOME"/'src/r' rev-parse"#));
        let removed = removal(&Place {
            id: "x".to_owned(),
            repo: "/srv/a b".to_owned(),
            worktree: "/h/.yantra/worktrees/x".to_owned(),
            branch: "yantra/x".to_owned(),
            base: "0123abcd".to_owned(),
        });
        assert_eq!(
            removed,
            "{ [ ! -e '/h/.yantra/worktrees/x' ] \
             || git -C '/srv/a b' worktree remove --force '/h/.yantra/worktrees/x'; } \
             && git -C '/srv/a b' worktree prune \
             && { ! git -C '/srv/a b' rev-parse -q --verify 'refs/heads/yantra/x' >/dev/null \
             || git -C '/srv/a b' branch -D 'yantra/x' >/dev/null; }"
        );
    }

    #[test]
    fn ids_are_sixteen_hex_digits_and_differ() {
        let (a, b) = (id().expect("an id"), id().expect("an id"));
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
