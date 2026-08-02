//! The read model as JSON. Handlers read memory and return; `refresh.rs` owns
//! the ssh.
//!
//! Every answer names which of three states it is in — nobody has looked, a
//! look succeeded, a look failed — because a client that cannot tell a failure
//! from an empty fleet will draw the empty one (R-23), and drawing it is worse
//! than drawing nothing.
//!
//! **A failed look replaces the previous good one**, which is `refresh.rs`'s
//! behaviour and is kept deliberately: every error a class can raise here is
//! local and persistent — `tailscale` missing, a malformed workspace file, no
//! config directory — so a retained stale reading would hide a fault the
//! operator has to fix, and go on hiding it. The transient case that would
//! justify staleness is a *machine* that did not answer, and Y-054 already
//! keeps that inside a successful reading rather than losing it.
//!
//! DTOs live here rather than as `Serialize` on `yantra_core`'s types: a JSON
//! body is rendering, and ADR-0005 put rendering in the caller.

use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::get;
use axum::{Json, response::IntoResponse};
use yantra_core::snapshot::Reading;
use yantra_core::status::{MachineStatus, Verdict};

use crate::refresh::Model;

/// `get` only, and no route takes a body. M4 is a dashboard that reads; a
/// button that opens a session is the point at which Q6's missing auth
/// stops being free (R-22).
pub fn router() -> Router<Model> {
    Router::new()
        .route("/machines", get(machines))
        .route("/workspaces", get(workspaces))
        .route("/sessions", get(sessions))
        .route("/workspaces/{name}/status", get(workspace_status))
}

async fn machines(State(model): State<Model>) -> impl IntoResponse {
    let snapshot = model.read().await.clone();
    Json(Answer::of(snapshot.machines.as_deref(), |machines| {
        machines.iter().map(Machine::of).collect::<Vec<_>>()
    }))
}

async fn workspaces(State(model): State<Model>) -> impl IntoResponse {
    let snapshot = model.read().await.clone();
    Json(Answer::of(snapshot.workspaces.as_deref(), |workspaces| {
        workspaces.iter().map(Workspace::of).collect::<Vec<_>>()
    }))
}

async fn sessions(State(model): State<Model>) -> impl IntoResponse {
    let snapshot = model.read().await.clone();
    Json(Answer::of(snapshot.sessions.as_deref(), |answers| {
        answers.iter().map(MachineSessions::of).collect::<Vec<_>>()
    }))
}

/// The one route naming a resource rather than a class, so it has a fourth
/// answer the others cannot need: **404 for a workspace that does not exist**.
/// A 200 carrying no data would make absence inferable only from a missing
/// field, which is the inference this module exists to prevent. It is not
/// reachable before the first look — a daemon that has not looked cannot know
/// whether the name is real, and says `never` instead.
async fn workspace_status(State(model): State<Model>, Path(name): Path<String>) -> Response {
    let snapshot = model.read().await.clone();
    let Some(reading) = snapshot.agents.as_deref() else {
        return Json(Answer::<WorkspaceStatus>::Never).into_response();
    };
    let age_seconds = reading.age().as_secs();
    let fleet = match reading.value() {
        Ok(fleet) => fleet,
        Err(error) => {
            return Json(Answer::<WorkspaceStatus>::Failed {
                age_seconds,
                error: because(error),
            })
            .into_response();
        }
    };
    match WorkspaceStatus::find(fleet, &name) {
        Some(data) => Json(Answer::Ok { age_seconds, data }).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(Missing {
                error: format!("no workspace named `{name}`"),
            }),
        )
            .into_response(),
    }
}

/// I-47 one layer up: `never` is not an empty list, and neither is `failed`.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "looked", rename_all = "lowercase")]
enum Answer<T> {
    Ok { age_seconds: u64, data: T },
    Failed { age_seconds: u64, error: String },
    Never,
}

impl<T> Answer<T> {
    fn of<V, E: std::error::Error>(
        reading: Option<&Reading<Result<V, E>>>,
        render: impl FnOnce(&V) -> T,
    ) -> Self {
        let Some(reading) = reading else {
            return Self::Never;
        };
        let age_seconds = reading.age().as_secs();
        match reading.value() {
            Ok(value) => Self::Ok {
                age_seconds,
                data: render(value),
            },
            Err(error) => Self::Failed {
                age_seconds,
                error: because(error),
            },
        }
    }
}

/// The CLI's `report_error` walks the `source()` chain because the useful
/// detail is usually a level down; an API that flattens it says less than the
/// terminal does.
fn because(error: &dyn std::error::Error) -> String {
    let mut out = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        out.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    out
}

#[derive(Debug, serde::Serialize)]
struct Machine {
    name: String,
    dns_name: String,
    os: String,
    online: bool,
    /// I-39: an expired key is a third state. Such a machine can be powered on,
    /// listed, and still unreachable — which a green dot would erase.
    expired: bool,
    last_seen: Option<String>,
}

impl Machine {
    fn of(machine: &yantra_core::inventory::MachineInfo) -> Self {
        Self {
            name: machine.name.clone(),
            dns_name: machine.dns_name.clone(),
            os: machine.os.to_string(),
            online: machine.online,
            expired: machine.expired,
            last_seen: machine.last_seen.clone(),
        }
    }
}

#[derive(Debug, serde::Serialize)]
struct Workspace {
    name: String,
    machine: String,
    repo: String,
    startup: Option<String>,
}

impl Workspace {
    fn of(workspace: &yantra_core::workspace::Workspace) -> Self {
        Self {
            name: workspace.name.clone(),
            machine: workspace.machine.clone(),
            repo: workspace.repo.display().to_string(),
            startup: workspace.startup.clone(),
        }
    }
}

#[derive(Debug, serde::Serialize)]
struct MachineSessions {
    machine: String,
    #[serde(flatten)]
    answered: Answered,
}

/// Y-054's rule on the wire: a machine that did not answer stays in the list
/// carrying why, rather than becoming an absence or an empty array.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "reached", rename_all = "lowercase")]
enum Answered {
    Yes { sessions: Vec<Session> },
    No { error: String },
}

impl MachineSessions {
    fn of(answer: &yantra_core::sessions::MachineSessions) -> Self {
        Self {
            machine: answer.machine.clone(),
            answered: match &answer.sessions {
                Ok(sessions) => Answered::Yes {
                    sessions: sessions.iter().map(Session::of).collect(),
                },
                Err(error) => Answered::No {
                    error: because(error),
                },
            },
        }
    }
}

#[derive(Debug, serde::Serialize)]
struct Session {
    name: String,
    windows: u32,
    attached: u32,
    /// tmux formatted this on the machine that owns the session, so it is that
    /// machine's clock and timezone.
    created: String,
}

impl Session {
    fn of(session: &yantra_core::tmux::Summary) -> Self {
        Self {
            name: session.name.clone(),
            windows: session.windows,
            attached: session.attached,
            created: session.created.clone(),
        }
    }
}

#[derive(Debug, serde::Serialize)]
struct Missing {
    error: String,
}

/// `yantra status <name>` on the wire — the CLI expressed it first, so this
/// route adds no verb the terminal cannot reach (ADR-0012).
#[derive(Debug, serde::Serialize)]
struct WorkspaceStatus {
    workspace: String,
    machine: String,
    #[serde(flatten)]
    reached: Reached,
}

/// The same distinction `/sessions` draws, at workspace granularity: a machine
/// that did not answer leaves the workspace in the answer carrying why, rather
/// than reading as a workspace with nothing running.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "reached", rename_all = "lowercase")]
enum Reached {
    Yes {
        status: AgentState,
        /// What `claude`'s own registry holds for this repo. Present without
        /// `running` when the pane died under a live agent process.
        session: Option<AgentSession>,
    },
    No {
        error: String,
    },
}

impl WorkspaceStatus {
    fn find(fleet: &[MachineStatus], name: &str) -> Option<Self> {
        fleet.iter().find_map(|machine| {
            let of = |reached| Self {
                workspace: name.to_owned(),
                machine: machine.machine.clone(),
                reached,
            };
            match &machine.reports {
                Ok(reports) => reports
                    .iter()
                    .find(|report| report.workspace.name == name)
                    .map(|report| {
                        of(Reached::Yes {
                            status: AgentState::of(&report.verdict),
                            session: report.agent.as_ref().map(AgentSession::of),
                        })
                    }),
                Err(error) => machine
                    .workspaces
                    .iter()
                    .any(|workspace| workspace.name == name)
                    .then(|| {
                        of(Reached::No {
                            error: because(error),
                        })
                    }),
            }
        })
    }
}

#[derive(Debug, serde::Serialize)]
struct AgentSession {
    id: String,
    pid: u32,
}

impl AgentSession {
    fn of(running: &yantra_core::agent::Running) -> Self {
        Self {
            id: running.session_id.clone(),
            pid: running.pid,
        }
    }
}

/// Every [`Verdict`] by name, so a renderer never infers one state from the
/// absence of another. Two of them carry the weight: `no_agent` is a session
/// opened as a plain shell and is **ordinary** rather than a failure (Y-091),
/// while `unclear` beside it is R-2's genuine contradiction; `awaiting_trust`
/// is the one state in the system where the machine has stopped and is waiting
/// for a person (I-49).
#[derive(Debug, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum AgentState {
    NoSession,
    Running,
    Finished,
    Stopped,
    Crashed { exit_status: i32 },
    Killed { signal: String },
    NoAgent,
    AwaitingTrust,
    Unclear { because: String },
}

impl AgentState {
    fn of(verdict: &Verdict) -> Self {
        match verdict {
            Verdict::NoSession => Self::NoSession,
            Verdict::Running => Self::Running,
            Verdict::Finished => Self::Finished,
            Verdict::Stopped => Self::Stopped,
            Verdict::Crashed { status } => Self::Crashed {
                exit_status: *status,
            },
            Verdict::Killed { signal } => Self::Killed {
                signal: signal.clone(),
            },
            Verdict::NoAgent => Self::NoAgent,
            Verdict::AwaitingTrust => Self::AwaitingTrust,
            Verdict::Unclear { because } => Self::Unclear {
                because: (*because).to_owned(),
            },
        }
    }
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets the daemon, where the same call would take it down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use serde_json::{Value, json};
    use std::sync::Arc;
    use std::time::Duration;
    use tower::ServiceExt as _;
    use yantra_core::inventory::{MachineInfo, Os};
    use yantra_core::sessions::{self, MachineSessions};
    use yantra_core::snapshot::Snapshot;
    use yantra_core::status::{self, Report};
    use yantra_core::tmux::Summary;

    async fn get(model: Model, path: &str) -> (StatusCode, Value) {
        let response = router()
            .with_state(model)
            .oneshot(
                Request::get(path)
                    .body(Body::empty())
                    .expect("a GET with no body is a valid request"),
            )
            .await
            .expect("the router is infallible");
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("the body is in memory");
        (
            status,
            serde_json::from_slice(&body).expect("every answer is JSON"),
        )
    }

    async fn get_json(model: Model, path: &str) -> Value {
        let (status, body) = get(model, path).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    fn holding(snapshot: Snapshot) -> Model {
        Arc::new(tokio::sync::RwLock::new(snapshot))
    }

    /// A browser that arrives in the first 30 seconds must be told nobody has
    /// looked. An empty `data` here would draw an empty fleet and be believed.
    #[tokio::test]
    async fn a_class_nobody_has_looked_at_says_so_and_carries_no_data() {
        for path in ["/machines", "/workspaces", "/sessions"] {
            let body = get_json(holding(Snapshot::default()), path).await;
            assert_eq!(body, json!({"looked": "never"}), "{path}");
        }
    }

    /// The fourth state from Y-070, on the wire. Flattening it into an empty
    /// list is the Y-081 class of bug: a failure reported as a success.
    #[tokio::test]
    async fn a_look_that_failed_is_a_failure_and_never_an_empty_list() {
        let model = holding(Snapshot {
            machines: Some(Arc::new(Reading::new(Err(
                yantra_core::inventory::Error::Command {
                    stderr: "failed to connect to local tailscaled".into(),
                },
            )))),
            ..Snapshot::default()
        });

        let body = get_json(model, "/machines").await;
        assert_eq!(body["looked"], "failed", "{body}");
        assert!(body.get("data").is_none(), "{body}");
        assert!(
            body["error"]
                .as_str()
                .is_some_and(|e| e.contains("tailscaled")),
            "a failure a page cannot name is a failure nobody can act on: {body}"
        );
    }

    /// The chain, not just its top line — `sessions::Error::Workspace` is
    /// transparent, so the top line alone would say nothing at all.
    #[tokio::test]
    async fn a_failure_carries_the_cause_and_not_only_the_headline() {
        let model = holding(Snapshot {
            sessions: Some(Arc::new(Reading::new(Err(sessions::Error::Workspace(
                yantra_core::workspace::Error::InvalidName {
                    name: "has.dot".into(),
                },
            ))))),
            ..Snapshot::default()
        });

        let body = get_json(model, "/sessions").await;
        assert!(
            body["error"]
                .as_str()
                .is_some_and(|e| e.contains("has.dot")),
            "{body}"
        );
    }

    /// Serving a 90-second-old list as though it were live is the lie R-23
    /// names, and the fix is a field rather than a faster poll.
    #[tokio::test]
    async fn a_stale_reading_is_served_with_its_age_rather_than_as_live() {
        let model = holding(Snapshot {
            workspaces: Some(Arc::new(Reading::new(Ok(Vec::new())))),
            ..Snapshot::default()
        });
        tokio::time::sleep(Duration::from_millis(1_100)).await;

        let body = get_json(model, "/workspaces").await;
        assert_eq!(body["looked"], "ok", "{body}");
        assert!(
            body["age_seconds"].as_u64().is_some_and(|age| age >= 1),
            "{body}"
        );
    }

    /// Y-054's partial answer has to survive serialisation: the machine that
    /// timed out is in the array, and it is not holding an empty session list.
    #[tokio::test]
    async fn a_machine_that_did_not_answer_reaches_the_json_with_its_reason() {
        let model = holding(Snapshot {
            sessions: Some(Arc::new(Reading::new(Ok(vec![
                MachineSessions {
                    machine: "cachyos-g14".into(),
                    sessions: Ok(vec![Summary {
                        name: "yantra".into(),
                        windows: 2,
                        attached: 1,
                        created: "Thu Jul 30 13:02:31 2026".into(),
                    }]),
                },
                MachineSessions {
                    machine: "pi".into(),
                    sessions: Err(sessions::Error::Interrupted {
                        machine: "pi".into(),
                        reason: "connection timed out".into(),
                    }),
                },
            ])))),
            ..Snapshot::default()
        });

        let body = get_json(model, "/sessions").await;
        let answers = body["data"].as_array().expect("one entry per machine");
        assert_eq!(answers.len(), 2, "{body}");
        assert_eq!(answers[0]["reached"], "yes");
        assert_eq!(answers[0]["sessions"][0]["name"], "yantra");
        assert_eq!(answers[1]["reached"], "no");
        assert!(answers[1].get("sessions").is_none(), "{body}");
        assert!(
            answers[1]["error"]
                .as_str()
                .is_some_and(|e| e.contains("connection timed out")),
            "{body}"
        );
    }

    /// I-39 again: the dashboard's most actionable machine is the one that is
    /// listed, powered on and still unreachable, so `expired` is its own field.
    #[tokio::test]
    async fn an_expired_key_is_a_field_of_its_own_and_not_folded_into_offline() {
        let model = holding(Snapshot {
            machines: Some(Arc::new(Reading::new(Ok(vec![MachineInfo {
                id: "n-1".into(),
                name: "laptop-9ml3d644".into(),
                dns_name: "laptop-9ml3d644.example.ts.net.".into(),
                os: Os::Linux,
                online: false,
                last_seen: Some("2026-07-07T09:00:00Z".into()),
                expired: true,
            }])))),
            ..Snapshot::default()
        });

        let body = get_json(model, "/machines").await;
        let machine = &body["data"][0];
        assert_eq!(machine["online"], false);
        assert_eq!(machine["expired"], true);
        assert_eq!(machine["os"], "linux");
        assert!(
            machine.get("id").is_none(),
            "the node id is not something a read-only page needs: {machine}"
        );
    }

    fn on_machine(machine: &str, reports: Result<Vec<Report>, status::Error>) -> MachineStatus {
        MachineStatus {
            machine: machine.into(),
            workspaces: match &reports {
                Ok(reports) => reports.iter().map(|r| r.workspace.clone()).collect(),
                Err(_) => vec![workspace("api", machine)],
            },
            reports,
        }
    }

    fn workspace(name: &str, machine: &str) -> yantra_core::workspace::Workspace {
        yantra_core::workspace::Workspace {
            name: name.into(),
            machine: machine.into(),
            repo: "/srv/repo".into(),
            startup: None,
        }
    }

    fn report(name: &str, verdict: Verdict) -> Report {
        Report {
            workspace: workspace(name, "bishwajeets-macbook-pro"),
            pane: None,
            agent: None,
            verdict,
        }
    }

    fn looking_at(fleet: Vec<MachineStatus>) -> Model {
        holding(Snapshot {
            agents: Some(Arc::new(Reading::new(Ok(fleet)))),
            ..Snapshot::default()
        })
    }

    /// Before the first look the daemon cannot know whether the name is real,
    /// so this is the one place a 404 would be a lie rather than an answer.
    #[tokio::test]
    async fn a_workspace_nobody_has_looked_at_says_never_rather_than_not_found() {
        let (status, body) = get(holding(Snapshot::default()), "/workspaces/api/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, json!({"looked": "never"}));
    }

    /// `status::Error::Workspace` is `#[transparent]`, so the headline alone is
    /// the empty string — the chain is the whole message.
    #[tokio::test]
    async fn a_failed_look_carries_the_cause_and_never_reads_as_no_such_workspace() {
        let model = holding(Snapshot {
            agents: Some(Arc::new(Reading::new(Err(status::Error::Workspace(
                yantra_core::workspace::Error::InvalidName {
                    name: "has.dot".into(),
                },
            ))))),
            ..Snapshot::default()
        });

        let (code, body) = get(model, "/workspaces/api/status").await;
        assert_eq!(code, StatusCode::OK, "{body}");
        assert_eq!(body["looked"], "failed", "{body}");
        assert!(body.get("data").is_none(), "{body}");
        assert!(
            body["error"]
                .as_str()
                .is_some_and(|e| e.contains("has.dot")),
            "{body}"
        );
    }

    /// Serving a minute-old verdict as though it were live is the lie R-23
    /// names, and it is worse here than anywhere: this is the page's only
    /// actionable state.
    #[tokio::test]
    async fn an_ageing_verdict_is_served_with_its_age_rather_than_as_live() {
        let model = looking_at(vec![on_machine(
            "bishwajeets-macbook-pro",
            Ok(vec![report("api", Verdict::Running)]),
        )]);
        tokio::time::sleep(Duration::from_millis(1_100)).await;

        let body = get_json(model, "/workspaces/api/status").await;
        assert_eq!(body["looked"], "ok", "{body}");
        assert!(
            body["age_seconds"].as_u64().is_some_and(|age| age >= 1),
            "{body}"
        );
    }

    /// Y-054's rule at workspace granularity. A workspace on a sleeping machine
    /// must not read as a workspace with nothing running — that is the answer
    /// that would send someone to look for a crash that never happened.
    #[tokio::test]
    async fn a_workspace_whose_machine_did_not_answer_says_so_and_stays_findable() {
        let model = looking_at(vec![on_machine(
            "bishwajeets-macbook-pro",
            Err(status::Error::Ssh(yantra_core::ssh::Error::Transport {
                host: "bishwajeets-macbook-pro".into(),
                diagnosis: "connect to host bishwajeets-macbook-pro port 22: Connection refused"
                    .into(),
            })),
        )]);

        let body = get_json(model, "/workspaces/api/status").await;
        let data = &body["data"];
        assert_eq!(data["reached"], "no", "{body}");
        assert_eq!(data["machine"], "bishwajeets-macbook-pro");
        assert!(data.get("status").is_none(), "{body}");
        assert!(
            data["error"]
                .as_str()
                .is_some_and(|e| e.contains("Connection refused")),
            "{body}"
        );
    }

    /// **Y-091 on the wire.** A session opened as a plain shell is the most
    /// common thing on this page and is not a failure, so it has to be its own
    /// name rather than R-2's contradiction — and `awaiting_trust` beside it is
    /// the one state where a person is being waited for (I-49).
    #[tokio::test]
    async fn a_shell_session_the_trust_prompt_and_a_contradiction_are_three_names() {
        let model = looking_at(vec![on_machine(
            "bishwajeets-macbook-pro",
            Ok(vec![
                report("shell", Verdict::NoAgent),
                report("waiting", Verdict::AwaitingTrust),
                report(
                    "ghost",
                    Verdict::Unclear {
                        because: "the pane is alive but claude knows of no agent in that directory",
                    },
                ),
            ]),
        )]);

        let mut seen = Vec::new();
        for name in ["shell", "waiting", "ghost"] {
            let body = get_json(model.clone(), &format!("/workspaces/{name}/status")).await;
            assert_eq!(body["data"]["reached"], "yes", "{body}");
            seen.push(
                body["data"]["status"]["state"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
            );
        }
        assert_eq!(seen, ["no_agent", "awaiting_trust", "unclear"]);
    }

    /// Y-096 renders every one of these, so a verdict that arrives as a bare
    /// word when it carries a number would be a rewrite rather than a case.
    #[tokio::test]
    async fn every_ending_reaches_the_json_carrying_whatever_told_it_apart() {
        let model = looking_at(vec![on_machine(
            "bishwajeets-macbook-pro",
            Ok(vec![
                report("gone", Verdict::NoSession),
                report("broke", Verdict::Crashed { status: 1 }),
                report(
                    "shot",
                    Verdict::Killed {
                        signal: "KILL".into(),
                    },
                ),
            ]),
        )]);

        let gone = get_json(model.clone(), "/workspaces/gone/status").await;
        assert_eq!(gone["data"]["status"], json!({"state": "no_session"}));
        let broke = get_json(model.clone(), "/workspaces/broke/status").await;
        assert_eq!(
            broke["data"]["status"],
            json!({"state": "crashed", "exit_status": 1})
        );
        let shot = get_json(model, "/workspaces/shot/status").await;
        assert_eq!(
            shot["data"]["status"],
            json!({"state": "killed", "signal": "KILL"})
        );
    }

    /// The one route naming a resource. A 200 with an absent `data` would make
    /// a client infer non-existence from a missing field, which is the
    /// inference this whole shape exists to prevent.
    #[tokio::test]
    async fn a_workspace_that_does_not_exist_is_not_found_rather_than_an_empty_answer() {
        let model = looking_at(vec![on_machine(
            "bishwajeets-macbook-pro",
            Ok(vec![report("api", Verdict::Running)]),
        )]);

        let (code, body) = get(model, "/workspaces/nosuch/status").await;
        assert_eq!(code, StatusCode::NOT_FOUND, "{body}");
        assert!(
            body["error"].as_str().is_some_and(|e| e.contains("nosuch")),
            "{body}"
        );
    }

    /// M4 reads and nothing else. A write route is where Q6's absent auth stops
    /// being free (R-22), so the refusal is the thing worth asserting.
    #[tokio::test]
    async fn nothing_here_accepts_a_write() {
        for path in ["/machines", "/workspaces/api/status"] {
            for method in ["POST", "PUT", "DELETE", "PATCH"] {
                let response = router()
                    .with_state(holding(Snapshot::default()))
                    .oneshot(
                        Request::builder()
                            .method(method)
                            .uri(path)
                            .body(Body::empty())
                            .expect("a request with no body is valid"),
                    )
                    .await
                    .expect("the router is infallible");
                assert_eq!(
                    response.status(),
                    StatusCode::METHOD_NOT_ALLOWED,
                    "{method} {path} reached a handler"
                );
            }
        }
    }
}
