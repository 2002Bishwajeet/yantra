//! `/api/tasks`: the work the main agent delegates (ADR-0033 decisions 4, 5).
//! `yantra mcp` is the client.
//!
//! **The tasks live in this daemon's memory**, so a restart forgets them and
//! leaves their worktrees on the machines (decision 7).
//!
//! **No `GET` here awaits ssh** ([ADR-0019]), because the main agent polls
//! them. A task takes its diff summary itself when its turn ends, and again on
//! `stop`. The wait awaits that in memory, and ends when the daemon begins to
//! shut down. Starting, stopping and removing await ssh, because each is a
//! write that a caller sends once. A steer only queues the prompt in memory.
//!
//! [ADR-0019]: ../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md

use std::collections::BTreeMap;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::extract::{ConnectInfo, Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use tokio::sync::watch;
use yantra_core::acp::Harness;
use yantra_core::delegate::{self, Progress, Task};
use yantra_core::install;
use yantra_core::inventory::Inventory;
use yantra_core::ssh::{self, Machine, Ssh};

use crate::write::{Authoriser, Refused, allowed, chain};

struct Entry {
    machine: String,
    harness: &'static str,
    task: Arc<Task>,
}

type Tasks = Arc<Mutex<BTreeMap<String, Arc<Entry>>>>;
/// Turns a machine's name into where ssh goes. A test points it at its fixture.
type Locate = Arc<dyn Fn(&str) -> Option<Machine> + Send + Sync>;

#[derive(Clone)]
struct Delegates<I> {
    authoriser: Authoriser<I>,
    tasks: Tasks,
    locate: Locate,
    /// [`crate::heartbeat::Fleet::closing`].
    closing: watch::Sender<bool>,
}

pub fn router<I, S>(authoriser: Authoriser<I>, closing: watch::Sender<bool>) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    routes(authoriser, Arc::new(ssh::machine_at), closing)
}

fn routes<I, S>(
    authoriser: Authoriser<I>,
    locate: Locate,
    closing: watch::Sender<bool>,
) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/tasks", post(start::<I>).get(list::<I>))
        .route("/tasks/{id}", get(read::<I>).delete(remove::<I>))
        .route("/tasks/{id}/stop", post(stop::<I>))
        .route("/tasks/{id}/steer", post(steer::<I>))
        .route("/tasks/{id}/wait", get(wait::<I>))
        .with_state(Delegates {
            authoriser,
            tasks: Tasks::default(),
            locate,
            closing,
        })
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    machine: String,
    harness: String,
    repo: String,
    prompt: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Steer {
    prompt: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    id: String,
    machine: String,
    harness: &'static str,
    repo: String,
    worktree: String,
    branch: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Listed {
    #[serde(flatten)]
    task: Started,
    state: &'static str,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Read {
    #[serde(flatten)]
    task: Started,
    state: &'static str,
    /// Why a `failed` task failed.
    error: Option<String>,
    last_message: Option<String>,
    summary: Option<Summary>,
    /// A steer was answered 200 but the task ended before its agent got it.
    steer_dropped: bool,
}

/// T3 Code's wait answer: the task, and whether the wait ran out first.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Waited {
    #[serde(flatten)]
    task: Read,
    wait_timed_out: bool,
}

#[derive(Debug, serde::Serialize)]
struct Summary {
    changed: Vec<String>,
    shortstat: String,
}

#[derive(Debug, serde::Serialize)]
struct Removed {
    removed: bool,
}

fn started(id: &str, entry: &Entry) -> Started {
    let place = entry.task.place();
    Started {
        id: id.to_owned(),
        machine: entry.machine.clone(),
        harness: entry.harness,
        repo: place.repo.clone(),
        worktree: place.worktree.clone(),
        branch: place.branch.clone(),
    }
}

fn state(progress: &Progress) -> (&'static str, Option<String>) {
    match &progress.state {
        delegate::State::Starting => ("starting", None),
        delegate::State::Running => ("running", None),
        delegate::State::Completed => ("completed", None),
        delegate::State::Cancelled => ("cancelled", None),
        delegate::State::Failed(error) => ("failed", Some(error.clone())),
    }
}

fn read_out(id: &str, entry: &Entry) -> Read {
    let progress = entry.task.progress();
    let (state, error) = state(&progress);
    Read {
        task: started(id, entry),
        state,
        error,
        last_message: progress.last_message,
        summary: progress.summary.map(|summary| Summary {
            changed: summary.changed,
            shortstat: summary.shortstat,
        }),
        steer_dropped: progress.steer_dropped,
    }
}

fn find(tasks: &Tasks, id: &str) -> Result<Arc<Entry>, Refused> {
    tasks
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(id)
        .cloned()
        .ok_or_else(|| Refused::Verb {
            status: StatusCode::NOT_FOUND,
            said: format!("no task `{id}`: it was removed, or the daemon has restarted since"),
        })
}

fn bad(said: String) -> Refused {
    Refused::Verb {
        status: StatusCode::BAD_REQUEST,
        said,
    }
}

/// The caller named a directory that is not a repository; git or ssh failing
/// on a machine the caller named correctly is not the caller's fault.
fn from_delegate(error: &delegate::Error) -> StatusCode {
    match error {
        delegate::Error::NotARepo { .. } | delegate::Error::RepoPath { .. } => {
            StatusCode::BAD_REQUEST
        }
        delegate::Error::Worktree { .. } | delegate::Error::Ended => StatusCode::CONFLICT,
        delegate::Error::Ssh(_) | delegate::Error::Acp(_) => StatusCode::SERVICE_UNAVAILABLE,
        delegate::Error::Random(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn refused(error: &delegate::Error) -> Refused {
    Refused::Verb {
        status: from_delegate(error),
        said: chain(error),
    }
}

async fn start<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Delegates<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(asked): Json<Start>,
) -> Result<(StatusCode, Json<Started>), Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    // The name reaches `ssh`'s argv (ADR-0009).
    install::check_machine(&asked.machine).map_err(|error| bad(error.to_string()))?;
    let harness: Harness = asked.harness.parse().map_err(bad)?;
    let harness_name = harness.name();
    let machine = (state.locate)(&asked.machine).ok_or_else(|| Refused::Verb {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        said: "this daemon has no directory for its ssh sockets".to_owned(),
    })?;
    let ssh = Ssh::new(machine).map_err(|error| refused(&error.into()))?;
    tracing::info!(
        "delegate to {harness_name} on {} for {}",
        asked.machine,
        caller.node
    );

    // Spawned, so a caller that hangs up mid-prepare still leaves a task that
    // `DELETE` can find, rather than a worktree no task records.
    let tasks = Arc::clone(&state.tasks);
    let recorded = tokio::spawn(async move {
        let task = Task::start(ssh, harness, &asked.repo, &asked.prompt).await?;
        let id = task.place().id.clone();
        let entry = Arc::new(Entry {
            machine: asked.machine,
            harness: harness_name,
            task: Arc::new(task),
        });
        let answer = started(&id, &entry);
        tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, entry);
        Ok::<_, delegate::Error>(answer)
    })
    .await
    .map_err(|error| Refused::Verb {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        said: format!("starting the task failed: {error}"),
    })?;
    let answer = recorded.map_err(|error| refused(&error))?;
    Ok((StatusCode::CREATED, Json(answer)))
}

async fn list<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Delegates<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Vec<Listed>>, Refused> {
    allowed(&state.authoriser, from.ip(), &headers).await?;
    let tasks = state.tasks.lock().unwrap_or_else(PoisonError::into_inner);
    Ok(Json(
        tasks
            .iter()
            .map(|(id, entry)| Listed {
                task: started(id, entry),
                state: self::state(&entry.task.progress()).0,
            })
            .collect(),
    ))
}

async fn read<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Delegates<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Read>, Refused> {
    allowed(&state.authoriser, from.ip(), &headers).await?;
    let entry = find(&state.tasks, &id)?;
    Ok(Json(read_out(&id, &entry)))
}

async fn stop<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Delegates<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Read>, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    let entry = find(&state.tasks, &id)?;
    tracing::info!("stop task {id} for {}", caller.node);
    if let Err(error) = entry.task.stop().await {
        tracing::warn!("task {id} has no fresh summary: {}", chain(&error));
    }
    Ok(Json(read_out(&id, &entry)))
}

async fn steer<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Delegates<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(asked): Json<Steer>,
) -> Result<Json<Read>, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    if asked.prompt.trim().is_empty() {
        return Err(bad("a steer needs a prompt".to_owned()));
    }
    let entry = find(&state.tasks, &id)?;
    tracing::info!("steer task {id} for {}", caller.node);
    entry
        .task
        .steer(&asked.prompt)
        .map_err(|error| refused(&error))?;
    Ok(Json(read_out(&id, &entry)))
}

async fn wait<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Delegates<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Result<Json<Waited>, Refused> {
    allowed(&state.authoriser, from.ip(), &headers).await?;
    let limit = limit(query.as_deref()).map_err(bad)?;
    let entry = find(&state.tasks, &id)?;
    let settled = until_closing(&state.closing, entry.task.wait(limit))
        .await
        .ok_or_else(|| Refused::Verb {
            status: StatusCode::SERVICE_UNAVAILABLE,
            said: "yantrad is shutting down; wait again once it is back".to_owned(),
        })?;
    Ok(Json(Waited {
        task: read_out(&id, &entry),
        wait_timed_out: !settled,
    }))
}

/// `None` once the daemon begins to shut down, because axum's graceful
/// shutdown waits for every request in flight and systemd would kill it.
async fn until_closing<F: Future>(closing: &watch::Sender<bool>, wait: F) -> Option<F::Output> {
    let mut closing = closing.subscribe();
    tokio::select! {
        biased;
        done = wait => Some(done),
        _ = closing.wait_for(|closing| *closing) => None,
    }
}

/// `timeoutMs` and nothing else, capped at [`delegate::WAIT_LIMIT`].
fn limit(query: Option<&str>) -> Result<Duration, String> {
    let mut asked = None;
    for pair in query
        .unwrap_or_default()
        .split('&')
        .filter(|pair| !pair.is_empty())
    {
        match pair.split_once('=') {
            Some(("timeoutMs", ms)) if asked.is_none() => {
                asked = Some(ms.parse::<u64>().map_err(|_| {
                    format!("timeoutMs is a whole number of milliseconds, not `{ms}`")
                })?);
            }
            _ => {
                return Err(format!(
                    "a wait takes one `timeoutMs` and nothing else, not `{pair}`"
                ));
            }
        }
    }
    Ok(asked.map_or(delegate::WAIT, |ms| {
        Duration::from_millis(ms).min(delegate::WAIT_LIMIT)
    }))
}

async fn remove<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Delegates<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Removed>, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    let entry = find(&state.tasks, &id)?;
    tracing::info!("remove task {id} for {}", caller.node);
    // Kept on failure, so the caller can try the removal again.
    entry.task.remove().await.map_err(|error| refused(&error))?;
    state
        .tasks
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&id);
    Ok(Json(Removed { removed: true }))
}

/// The sshd fixture `yantra-core`'s own tests use, for the end-to-end test below.
#[cfg(test)]
#[path = "../../yantra-core/tests/common/mod.rs"]
mod common;

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::common;
    use super::*;
    use axum::body::Body;
    use axum::http::{Method, Request, header};
    use std::net::IpAddr;
    use tower::ServiceExt as _;
    use yantra_core::inventory::{Caller, Fake};

    const ME: u64 = 1;
    const MINE: [u8; 4] = [100, 64, 0, 2];

    fn app() -> Router {
        app_at(Arc::new(ssh::machine_at))
    }

    fn app_at(locate: Locate) -> Router {
        let caller = Caller {
            node: "nSOME000000011CNTRL".to_owned(),
            user: ME,
            tags: Vec::new(),
        };
        let fake = Fake {
            machines: Vec::new(),
            addresses: Vec::new(),
            callers: [(IpAddr::from(MINE), caller)].into_iter().collect(),
            owner: ME,
        };
        routes(
            Authoriser::new(fake, &[]),
            locate,
            watch::Sender::new(false),
        )
    }

    async fn send(
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
        from: [u8; 4],
    ) -> (StatusCode, String) {
        send_to(app(), method, path, body, from).await
    }

    async fn send_to(
        app: Router,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
        from: [u8; 4],
    ) -> (StatusCode, String) {
        let mut request = Request::builder().method(method).uri(path);
        if body.is_some() {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        let mut request = request
            .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
            .expect("a request");
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from((from, 61620))));
        let response = app
            .oneshot(request)
            .await
            .expect("the router is infallible");
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("the body is in memory");
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    fn body(machine: &str, harness: &str) -> serde_json::Value {
        serde_json::json!({"machine": machine, "harness": harness,
                           "repo": "/srv/r", "prompt": "fix it"})
    }

    #[tokio::test]
    async fn tasks_refuse_a_caller_who_is_not_the_owner() {
        for (method, path, body) in [
            (Method::POST, "/tasks", Some(body("pi", "opencode"))),
            (Method::GET, "/tasks", None),
            (Method::GET, "/tasks/ab12cd34", None),
            (Method::POST, "/tasks/ab12cd34/stop", None),
            (Method::POST, "/tasks/ab12cd34/steer", Some(steered())),
            (Method::GET, "/tasks/ab12cd34/wait?timeoutMs=1", None),
            (Method::DELETE, "/tasks/ab12cd34", None),
        ] {
            let (status, _) = send(method.clone(), path, body, [100, 64, 0, 9]).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
        }
    }

    #[tokio::test]
    async fn tasks_answer_404_for_an_id_this_daemon_does_not_hold() {
        for (method, path, body) in [
            (Method::GET, "/tasks/ab12cd34", None),
            (Method::POST, "/tasks/ab12cd34/stop", None),
            (Method::POST, "/tasks/ab12cd34/steer", Some(steered())),
            (Method::GET, "/tasks/ab12cd34/wait", None),
            (Method::DELETE, "/tasks/ab12cd34", None),
        ] {
            let (status, said) = send(method.clone(), path, body, MINE).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
            assert!(said.contains("no task `ab12cd34`"), "{said}");
        }
        let (status, said) = send(Method::GET, "/tasks", None, MINE).await;
        assert_eq!((status, said.as_str()), (StatusCode::OK, "[]"));
    }

    fn steered() -> serde_json::Value {
        serde_json::json!({"prompt": "and the docs"})
    }

    #[tokio::test]
    async fn tasks_refuse_an_empty_steer_and_a_bad_wait_with_400() {
        let (status, said) = send(
            Method::POST,
            "/tasks/ab12cd34/steer",
            Some(serde_json::json!({"prompt": " \n"})),
            MINE,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
        assert_eq!(said, "a steer needs a prompt");
        for query in [
            "timeoutMs=-1",
            "timeoutMs=soon",
            "timeout=5",
            "timeoutMs=1&timeoutMs=2",
        ] {
            let (status, said) = send(
                Method::GET,
                &format!("/tasks/ab12cd34/wait?{query}"),
                None,
                MINE,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {said}");
        }
    }

    #[test]
    fn a_wait_defaults_to_a_minute_and_stops_at_ten() {
        assert_eq!(limit(None), Ok(Duration::from_secs(60)));
        assert_eq!(limit(Some("")), Ok(Duration::from_secs(60)));
        assert_eq!(limit(Some("timeoutMs=0")), Ok(Duration::ZERO));
        assert_eq!(
            limit(Some("timeoutMs=1500")),
            Ok(Duration::from_millis(1500))
        );
        assert_eq!(
            limit(Some("timeoutMs=99999999999")),
            Ok(Duration::from_secs(600))
        );
    }

    #[tokio::test]
    async fn a_wait_in_flight_ends_when_the_daemon_begins_to_shut_down() {
        let closing = watch::Sender::new(false);
        let waiting = tokio::spawn({
            let closing = closing.clone();
            async move { until_closing(&closing, std::future::pending::<bool>()).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiting.is_finished());
        closing.send_replace(true);
        let ended = tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("the wait ends at once")
            .expect("the wait does not panic");
        assert_eq!(ended, None);
        assert_eq!(
            until_closing(&closing, std::future::ready(true)).await,
            Some(true),
            "a wait that is already done is not lost to the race"
        );
        let open = watch::Sender::new(false);
        assert_eq!(
            until_closing(&open, std::future::ready(true)).await,
            Some(true)
        );
    }

    /// Each refusal arrives before any machine is asked, which is also the only
    /// way the test can end: a body that passed would ssh to `pi`.
    #[tokio::test]
    async fn tasks_refuse_a_bad_harness_or_machine_before_ssh() {
        let (status, said) = send(Method::POST, "/tasks", Some(body("pi", "claude")), MINE).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(said.contains("codex, gemini, grok or opencode"), "{said}");

        for hostile in ["-oProxyCommand=id", "pi;id", "user@pi", ""] {
            let (status, said) = send(
                Method::POST,
                "/tasks",
                Some(body(hostile, "opencode")),
                MINE,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{hostile}: {said}");
        }
    }

    #[test]
    fn tasks_map_a_directory_that_is_not_a_repo_to_400_and_ssh_to_503() {
        let not = delegate::Error::NotARepo {
            repo: "/tmp".to_owned(),
        };
        assert_eq!(from_delegate(&not), StatusCode::BAD_REQUEST);
        let relative = delegate::Error::RepoPath {
            repo: "repo".to_owned(),
        };
        assert_eq!(from_delegate(&relative), StatusCode::BAD_REQUEST);
        let random = delegate::Error::Random(std::io::Error::other("no entropy"));
        assert_eq!(from_delegate(&random), StatusCode::INTERNAL_SERVER_ERROR);
        let ssh = delegate::Error::Ssh(ssh::Error::Transport {
            host: "pi".to_owned(),
            diagnosis: "timed out".to_owned(),
        });
        assert_eq!(from_delegate(&ssh), StatusCode::SERVICE_UNAVAILABLE);
        let git = delegate::Error::Worktree {
            stderr: "fatal: invalid reference: HEAD".to_owned(),
        };
        assert_eq!(from_delegate(&git), StatusCode::CONFLICT);
        assert_eq!(from_delegate(&delegate::Error::Ended), StatusCode::CONFLICT);
    }

    /// The routes `yantra mcp` calls, end to end against a real sshd, git and
    /// `opencode acp` (§B3). The fixture has no model login, so the turn may
    /// fail; what matters is the worktree, the fields and the cleanup.
    #[tokio::test]
    async fn a_task_starts_reads_stops_and_removes_through_the_routes() {
        const REPO: &str = "/home/yantra/repo";
        let patience = std::time::Duration::from_secs(120);
        let Some(fixture) = common::SshFixture::start().expect("the fixture starts") else {
            return;
        };
        // Short on purpose: `%C` adds 40 characters and the socket path budget is 90.
        let dir = std::path::PathBuf::from(format!("/tmp/yx-tsk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a state directory");
        let machine = Machine {
            host: fixture.host().to_owned(),
            user: Some(common::USER.to_owned()),
            port: Some(fixture.port()),
            identity: Some(fixture.key_path()),
            state_dir: dir.clone(),
        };
        let app = app_at(Arc::new(move |name: &str| {
            (name == "fixture").then(|| machine.clone())
        }));
        fixture
            .run(&format!(
                "mkdir -p {REPO} && cd {REPO} && git init -q && echo one > README \
                 && git add README && git -c user.name=t -c user.email=t@example.com \
                 commit -qm one"
            ))
            .expect("a repository");
        let json = |said: &str| -> serde_json::Value {
            serde_json::from_str(said).expect("the daemon answers JSON")
        };

        let asked = serde_json::json!({"machine": "fixture", "harness": "opencode",
                                       "repo": REPO, "prompt": "Say hello."});
        let (status, said) = tokio::time::timeout(
            patience,
            send_to(app.clone(), Method::POST, "/tasks", Some(asked), MINE),
        )
        .await
        .expect("start answers in time");
        assert_eq!(status, StatusCode::CREATED, "{said}");
        let started = json(&said);
        let id = started["id"].as_str().expect("an id").to_owned();
        let worktree = started["worktree"].as_str().expect("a worktree").to_owned();
        assert_eq!(started["branch"], format!("yantra/{id}"));
        assert_eq!(started["repo"], REPO);

        let begun = std::time::Instant::now();
        loop {
            let (status, said) = send_to(
                app.clone(),
                Method::GET,
                &format!("/tasks/{id}"),
                None,
                MINE,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{said}");
            let read = json(&said);
            for field in ["state", "lastMessage", "summary", "error"] {
                assert!(read.get(field).is_some(), "{field}: {said}");
            }
            if read["state"] != "starting" {
                break;
            }
            assert!(
                begun.elapsed() < patience,
                "the task stayed starting: {said}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }

        fixture
            .run(&format!(
                "cd {worktree} && echo two > 'left out.txt' && echo three > kept.md \
                 && git add kept.md \
                 && git -c user.name=t -c user.email=t@example.com commit -qm three"
            ))
            .expect("the work lands");
        let (status, said) = tokio::time::timeout(
            patience,
            send_to(
                app.clone(),
                Method::POST,
                &format!("/tasks/{id}/stop"),
                None,
                MINE,
            ),
        )
        .await
        .expect("stop answers in time");
        assert_eq!(status, StatusCode::OK, "{said}");
        let stopped = json(&said);
        assert!(
            ["completed", "cancelled", "failed"].contains(&stopped["state"].as_str().unwrap_or("")),
            "{said}"
        );
        let changed = &stopped["summary"]["changed"];
        for written in ["left out.txt", "kept.md"] {
            assert!(
                changed
                    .as_array()
                    .is_some_and(|all| all.iter().any(|p| p == written)),
                "{written}: {said}"
            );
        }
        assert!(
            stopped["summary"]["shortstat"]
                .as_str()
                .is_some_and(|s| !s.is_empty()),
            "{said}"
        );

        let (status, said) = send_to(app.clone(), Method::GET, "/tasks", None, MINE).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&said)[0]["id"], id.as_str(), "{said}");

        let (status, said) = tokio::time::timeout(
            patience,
            send_to(
                app.clone(),
                Method::DELETE,
                &format!("/tasks/{id}"),
                None,
                MINE,
            ),
        )
        .await
        .expect("remove answers in time");
        assert_eq!(
            (status, said.as_str()),
            (StatusCode::OK, r#"{"removed":true}"#)
        );
        let (status, _) = send_to(
            app.clone(),
            Method::GET,
            &format!("/tasks/{id}"),
            None,
            MINE,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let left = |worktree: &str| {
            fixture
                .run(&format!(
                    "test -e {worktree} && echo there; git -C {REPO} branch --list 'yantra/*'"
                ))
                .expect("the machine answers")
        };
        let after = left(&worktree);
        assert!(after.trim().is_empty(), "{after}");

        // A caller that hangs up while the worktree is made still leaves a
        // task to find and remove.
        let asked = serde_json::json!({"machine": "fixture", "harness": "opencode",
                                       "repo": REPO, "prompt": "Say hello."});
        let dropped = tokio::time::timeout(
            std::time::Duration::ZERO,
            send_to(app.clone(), Method::POST, "/tasks", Some(asked), MINE),
        )
        .await;
        assert!(dropped.is_err(), "the request was dropped mid-prepare");
        let begun = std::time::Instant::now();
        let listed = loop {
            let (status, said) = send_to(app.clone(), Method::GET, "/tasks", None, MINE).await;
            assert_eq!(status, StatusCode::OK, "{said}");
            let listed = json(&said);
            if listed.as_array().is_some_and(|all| !all.is_empty()) {
                break listed;
            }
            assert!(begun.elapsed() < patience, "no task was recorded");
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        };
        let id = listed[0]["id"].as_str().expect("an id").to_owned();
        let worktree = listed[0]["worktree"]
            .as_str()
            .expect("a worktree")
            .to_owned();
        let (status, said) = tokio::time::timeout(
            patience,
            send_to(
                app.clone(),
                Method::DELETE,
                &format!("/tasks/{id}"),
                None,
                MINE,
            ),
        )
        .await
        .expect("remove answers in time");
        assert_eq!(status, StatusCode::OK, "{said}");
        let after = left(&worktree);
        assert!(after.trim().is_empty(), "{after}");

        drop(fixture);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Steer, wait and cancel, end to end against a real sshd and a real
    /// `opencode acp` (§B3). The fixture has no model login, so how the turns
    /// end is not asserted; the answers, the states and the cleanup are.
    #[tokio::test]
    async fn a_task_is_steered_waited_for_and_cancelled_through_the_routes() {
        const REPO: &str = "/home/yantra/steered";
        let patience = std::time::Duration::from_secs(120);
        let Some(fixture) = common::SshFixture::start().expect("the fixture starts") else {
            return;
        };
        let dir = std::path::PathBuf::from(format!("/tmp/yx-str-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a state directory");
        let machine = Machine {
            host: fixture.host().to_owned(),
            user: Some(common::USER.to_owned()),
            port: Some(fixture.port()),
            identity: Some(fixture.key_path()),
            state_dir: dir.clone(),
        };
        let app = app_at(Arc::new(move |name: &str| {
            (name == "fixture").then(|| machine.clone())
        }));
        fixture
            .run(&format!(
                "mkdir -p {REPO} && cd {REPO} && git init -q && echo one > README \
                 && git add README && git -c user.name=t -c user.email=t@example.com \
                 commit -qm one"
            ))
            .expect("a repository");
        let json = |said: &str| -> serde_json::Value {
            serde_json::from_str(said).expect("the daemon answers JSON")
        };
        let call = |method: Method, path: String, body: Option<serde_json::Value>| {
            let app = app.clone();
            async move {
                tokio::time::timeout(patience, send_to(app, method, &path, body, MINE))
                    .await
                    .expect("the daemon answers in time")
            }
        };
        let terminal = ["completed", "cancelled", "failed"];

        let asked = serde_json::json!({"machine": "fixture", "harness": "opencode",
                                       "repo": REPO, "prompt": "Say hello."});
        let (status, said) = call(Method::POST, "/tasks".to_owned(), Some(asked)).await;
        assert_eq!(status, StatusCode::CREATED, "{said}");
        let started = json(&said);
        let id = started["id"].as_str().expect("an id").to_owned();
        let worktree = started["worktree"].as_str().expect("a worktree").to_owned();

        // opencode takes seconds to open a session, so the task is still starting.
        let steer = serde_json::json!({"prompt": format!("Also say yantra-steer-{id}.")});
        let (status, said) = call(
            Method::POST,
            format!("/tasks/{id}/steer"),
            Some(steer.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{said}");
        assert_eq!(json(&said)["id"], id.as_str(), "{said}");

        for ms in [1, 30_000] {
            let (status, said) = call(
                Method::GET,
                format!("/tasks/{id}/wait?timeoutMs={ms}"),
                None,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{said}");
            let waited = json(&said);
            let timed_out = waited["waitTimedOut"].as_bool().expect("waitTimedOut");
            let state = waited["state"].as_str().expect("a state");
            assert!(
                timed_out || terminal.contains(&state),
                "a wait that did not time out ends on a settled task: {said}"
            );
        }

        let (status, said) = call(Method::POST, format!("/tasks/{id}/stop"), None).await;
        assert_eq!(status, StatusCode::OK, "{said}");
        let stopped = json(&said);
        assert!(
            terminal.contains(&stopped["state"].as_str().unwrap_or("")),
            "{said}"
        );
        assert!(stopped["summary"].is_object(), "{said}");

        let (status, said) = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            send_to(
                app.clone(),
                Method::GET,
                &format!("/tasks/{id}/wait?timeoutMs=600000"),
                None,
                MINE,
            ),
        )
        .await
        .expect("a cancelled task's wait answers at once");
        assert_eq!(status, StatusCode::OK, "{said}");
        assert_eq!(json(&said)["waitTimedOut"], false, "{said}");

        let (status, said) = call(Method::POST, format!("/tasks/{id}/steer"), Some(steer)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{said}");

        let (status, said) = call(Method::DELETE, format!("/tasks/{id}"), None).await;
        assert_eq!(
            (status, said.as_str()),
            (StatusCode::OK, r#"{"removed":true}"#)
        );
        let after = fixture
            .run(&format!(
                "test -e {worktree} && echo there; git -C {REPO} branch --list 'yantra/*'"
            ))
            .expect("the machine answers");
        assert!(after.trim().is_empty(), "{after}");

        drop(fixture);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
