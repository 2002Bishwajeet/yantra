//! A delegated task (ADR-0033 decisions 4 and 5): one ACP agent that works
//! alone in a new git worktree on a machine, and what it leaves there.
//!
//! Nobody answers the agent's questions while it works. Each permission request
//! gets the agent's own "allow once", because the worktree is the isolation and
//! the main agent reviews the diff before anything merges.

use std::hash::{BuildHasher as _, Hasher as _};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

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

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("`{repo}` is not a git work tree on that machine")]
    NotARepo { repo: String },

    #[error("git could not prepare or remove the task's worktree: {stderr}")]
    Worktree { stderr: String },

    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    #[error(transparent)]
    Acp(#[from] acp::Error),
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
    // Weak, so the agent and its `ssh` end when the turn ends rather than at `stop`.
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
        let place = prepare(&ssh, repo, &id()).await?;
        let (agent, events) = match Agent::start(&ssh, harness) {
            Ok(started) => started,
            Err(error) => {
                // A worktree with no agent in it is litter.
                let _ = ssh.exec(&removal(&place)).await;
                return Err(error.into());
            }
        };
        let agent = Arc::new(agent);
        let shared = Shared::default();
        let runner = {
            let (agent, shared, ssh) = (Arc::clone(&agent), Arc::clone(&shared), ssh.clone());
            let (worktree, base) = (place.worktree.clone(), place.base.clone());
            let prompt = prompt.to_owned();
            tokio::spawn(async move {
                drive(agent, events, &worktree, &prompt, &shared).await;
                if let Ok(summary) = summarise(&ssh, &worktree, &base).await {
                    lock(&shared).progress.summary = Some(summary);
                }
            })
        };
        Ok(Self {
            place,
            ssh,
            shared,
            running: Mutex::new(Some(Running {
                agent: Arc::downgrade(&agent),
                runner,
            })),
        })
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

    /// Cancels the turn and ends the agent. The worktree stays for review.
    pub async fn stop(&self) {
        let running = self
            .running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(Running { agent, mut runner }) = running {
            let session = lock(&self.shared).session.clone();
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
        self.stop().await;
        let out = self.ssh.exec(&removal(&self.place)).await?;
        if !out.success() {
            return Err(Error::Worktree {
                stderr: said(&out.stderr),
            });
        }
        Ok(())
    }
}

/// Short and unguessable enough for a branch name. `RandomState` is seeded
/// from the OS once and then advanced, so two calls never repeat.
pub(crate) fn id() -> String {
    let bits = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    format!("{:08x}", bits >> 32)
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

fn branch(id: &str) -> String {
    format!("yantra/{id}")
}

pub(crate) async fn prepare<E: Exec>(exec: &E, repo: &str, id: &str) -> Result<Place, Error> {
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

pub(crate) fn removal(place: &Place) -> String {
    let repo = sq(&place.repo);
    format!(
        "git -C {repo} worktree remove --force {} && git -C {repo} branch -D {} >/dev/null \
         && git -C {repo} worktree prune",
        sq(&place.worktree),
        sq(&place.branch),
    )
}

/// Diffs the working tree against `base`, so committed and uncommitted work
/// both count. `-z` keeps git from quoting a path with a space or non-ASCII.
pub(crate) async fn summarise<E: Exec>(
    exec: &E,
    worktree: &str,
    base: &str,
) -> Result<Summary, Error> {
    let (worktree, base) = (sq(worktree), sq(base));
    let names = exec
        .exec(&format!(
            "git -C {worktree} diff --name-only -z {base} \
             && git -C {worktree} ls-files -z --others --exclude-standard"
        ))
        .await?;
    let stat = exec
        .exec(&format!("git -C {worktree} diff --shortstat {base}"))
        .await?;
    for out in [&names, &stat] {
        if !out.success() {
            return Err(Error::Worktree {
                stderr: said(&out.stderr),
            });
        }
    }
    Ok(Summary {
        changed: changed(&names.stdout),
        shortstat: String::from_utf8_lossy(&stat.stdout).trim().to_owned(),
    })
}

/// One path per NUL; a rename gives its new side only.
fn changed(names: &[u8]) -> Vec<String> {
    names
        .split(|&byte| byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect()
}

/// Runs the agent's one turn and sets the state it ended in.
async fn drive(agent: Arc<Agent>, mut events: Events, cwd: &str, prompt: &str, shared: &Shared) {
    let state = match turn(&agent, &mut events, cwd, prompt, shared).await {
        Ok(chat::StopReason::Cancelled) => State::Cancelled,
        Ok(_) => State::Completed,
        Err(error) => State::Failed(error.to_string()),
    };
    lock(shared).progress.state = state;
}

async fn turn(
    agent: &Agent,
    events: &mut Events,
    cwd: &str,
    prompt: &str,
    shared: &Shared,
) -> Result<chat::StopReason, acp::Error> {
    agent.initialize().await?;
    let session = agent.new_session(cwd).await?;
    lock(shared).session = Some(session.clone());
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
    let (stopped, ()) = tokio::join!(agent.prompt(&session, prompt), watch);
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
        let (client, events) = Agent::over(client_read, client_write);
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
        fold(&mut inner, &Event::ThreadStarted);
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
    fn the_summary_names_every_path_unquoted() {
        let names = "src/lib.rs\0notes/new file.md\0\u{fc}.txt\0".as_bytes();
        assert_eq!(
            changed(names),
            ["src/lib.rs", "notes/new file.md", "\u{fc}.txt"]
        );
        assert!(changed(b"").is_empty());
    }

    /// A scripted machine, so the parsing of each answer is tested here and
    /// the git behind it in tests/delegate.rs.
    struct Said(Vec<ssh::Output>);

    impl Exec for Mutex<Said> {
        async fn exec(&self, _command: &str) -> Result<ssh::Output, ssh::Error> {
            Ok(lock_said(self).0.remove(0))
        }
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
        let made = Mutex::new(Said(vec![out(
            0,
            "/home/u/repo\n/home/u/.yantra/worktrees/ab12cd34\n0123abcd\n",
            "",
        )]));
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

        let not = Mutex::new(Said(vec![out(NOT_A_REPO, "", "")]));
        assert!(matches!(
            prepare(&not, "/tmp", "x").await,
            Err(Error::NotARepo { repo }) if repo == "/tmp"
        ));

        let empty = Mutex::new(Said(vec![out(128, "", "fatal: invalid reference: HEAD\n")]));
        assert!(matches!(
            prepare(&empty, "/srv/r", "x").await,
            Err(Error::Worktree { stderr }) if stderr == "fatal: invalid reference: HEAD"
        ));
    }

    #[tokio::test]
    async fn summarise_reads_both_answers_and_a_failed_git_is_a_worktree_error() {
        let said = Mutex::new(Said(vec![
            out(0, "a.txt\0", ""),
            out(0, " 1 file changed, 2 insertions(+)\n", ""),
        ]));
        assert_eq!(
            summarise(&said, "/w", "0123abcd")
                .await
                .expect("summarised"),
            Summary {
                changed: vec!["a.txt".to_owned()],
                shortstat: "1 file changed, 2 insertions(+)".to_owned(),
            }
        );
        let gone = Mutex::new(Said(vec![
            out(128, "", "fatal: cannot change to '/w'\n"),
            out(128, "", "fatal: cannot change to '/w'\n"),
        ]));
        assert!(matches!(
            summarise(&gone, "/w", "0123abcd").await,
            Err(Error::Worktree { .. })
        ));
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
            "git -C '/srv/a b' worktree remove --force '/h/.yantra/worktrees/x' \
             && git -C '/srv/a b' branch -D 'yantra/x' >/dev/null \
             && git -C '/srv/a b' worktree prune"
        );
    }

    #[test]
    fn ids_are_eight_hex_digits_and_differ() {
        let (a, b) = (id(), id());
        assert_eq!(a.len(), 8);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
