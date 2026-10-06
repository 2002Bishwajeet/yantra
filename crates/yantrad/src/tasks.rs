//! `/api/tasks`: the work the main agent delegates (ADR-0033 decisions 4, 5).
//! `yantra mcp` is the client.
//!
//! **The tasks live in this daemon's memory**, so a restart forgets them and
//! leaves their worktrees on the machines (decision 7).
//!
//! **No `GET` here awaits ssh** ([ADR-0019]), because the main agent polls
//! them. A task takes its diff summary itself when its turn ends, and again on
//! `stop`. Starting, stopping and removing await ssh, because each is a write
//! that a caller sends once.
//!
//! [ADR-0019]: ../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, PoisonError};

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use yantra_core::acp::Harness;
use yantra_core::delegate::{self, Progress, Task};
use yantra_core::install;
use yantra_core::inventory::Inventory;
use yantra_core::ssh::{self, Ssh};

use crate::write::{Authoriser, Refused, allowed, chain};

/// The harness names a caller may send, as R19 §1 lists them.
const HARNESSES: [(&str, Harness); 4] = [
    ("codex", Harness::Codex),
    ("gemini", Harness::Gemini),
    ("grok", Harness::Grok),
    ("opencode", Harness::Opencode),
];

struct Entry {
    machine: String,
    harness: &'static str,
    task: Arc<Task>,
}

type Tasks = Arc<Mutex<BTreeMap<String, Arc<Entry>>>>;

#[derive(Clone)]
struct Delegates<I> {
    authoriser: Authoriser<I>,
    tasks: Tasks,
}

pub fn router<I, S>(authoriser: Authoriser<I>) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/tasks", post(start::<I>).get(list::<I>))
        .route("/tasks/{id}", get(read::<I>).delete(remove::<I>))
        .route("/tasks/{id}/stop", post(stop::<I>))
        .with_state(Delegates {
            authoriser,
            tasks: Tasks::default(),
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
        delegate::Error::NotARepo { .. } => StatusCode::BAD_REQUEST,
        delegate::Error::Worktree { .. } => StatusCode::CONFLICT,
        delegate::Error::Ssh(_) | delegate::Error::Acp(_) => StatusCode::SERVICE_UNAVAILABLE,
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
    let (harness_name, harness) = HARNESSES
        .into_iter()
        .find(|(name, _)| *name == asked.harness)
        .ok_or_else(|| {
            bad(format!(
                "`{}` is not a harness Yantra drives over ACP: codex, gemini, grok or opencode",
                asked.harness
            ))
        })?;
    let machine = ssh::machine_at(&asked.machine).ok_or_else(|| Refused::Verb {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        said: "this daemon has no directory for its ssh sockets".to_owned(),
    })?;
    let ssh = Ssh::new(machine).map_err(|error| refused(&error.into()))?;
    tracing::info!(
        "delegate to {harness_name} on {} for {}",
        asked.machine,
        caller.node
    );

    let task = Task::start(ssh, harness, &asked.repo, &asked.prompt)
        .await
        .map_err(|error| refused(&error))?;
    let id = task.place().id.clone();
    let entry = Arc::new(Entry {
        machine: asked.machine,
        harness: harness_name,
        task: Arc::new(task),
    });
    let answer = started(&id, &entry);
    state
        .tasks
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(id, entry);
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
    entry.task.stop().await;
    // A summary the machine cannot give now leaves the one the turn took.
    if let Err(error) = entry.task.summary().await {
        tracing::warn!("task {id} has no fresh summary: {}", chain(&error));
    }
    Ok(Json(read_out(&id, &entry)))
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

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Method, Request, header};
    use std::net::IpAddr;
    use tower::ServiceExt as _;
    use yantra_core::inventory::{Caller, Fake};

    const ME: u64 = 1;
    const MINE: [u8; 4] = [100, 64, 0, 2];

    fn app() -> Router {
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
        router(Authoriser::new(fake, &[]))
    }

    async fn send(
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
        let response = app()
            .oneshot(request)
            .await
            .expect("the router is infallible");
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 1 << 16)
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
            (Method::DELETE, "/tasks/ab12cd34", None),
        ] {
            let (status, _) = send(method.clone(), path, body, [100, 64, 0, 9]).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
        }
    }

    #[tokio::test]
    async fn tasks_answer_404_for_an_id_this_daemon_does_not_hold() {
        for (method, path) in [
            (Method::GET, "/tasks/ab12cd34"),
            (Method::POST, "/tasks/ab12cd34/stop"),
            (Method::DELETE, "/tasks/ab12cd34"),
        ] {
            let (status, said) = send(method.clone(), path, None, MINE).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
            assert!(said.contains("no task `ab12cd34`"), "{said}");
        }
        let (status, said) = send(Method::GET, "/tasks", None, MINE).await;
        assert_eq!((status, said.as_str()), (StatusCode::OK, "[]"));
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
        let ssh = delegate::Error::Ssh(ssh::Error::Transport {
            host: "pi".to_owned(),
            diagnosis: "timed out".to_owned(),
        });
        assert_eq!(from_delegate(&ssh), StatusCode::SERVICE_UNAVAILABLE);
        let git = delegate::Error::Worktree {
            stderr: "fatal: invalid reference: HEAD".to_owned(),
        };
        assert_eq!(from_delegate(&git), StatusCode::CONFLICT);
    }
}
