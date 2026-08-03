//! The routes that **act**, and the identity that authorises them
//! ([ADR-0016](../../../docs/adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)).
//!
//! Until Y-112 the API answered 405 to every write and the dashboard handed
//! over a command to paste into a terminal, which from a phone is worth
//! nothing. These three are the CLI's own verbs and nothing more: the daemon
//! may do what `yantra` can already do, and the library decides how
//! ([ADR-0005](../../../docs/adr/0005-core-logic-in-a-library-crate.md)).
//!
//! **These handlers await ssh, and that is not a violation of this crate's
//! rule.** The rule exists because a browser polls reads whether or not anyone
//! is looking; a write happens when a person taps a button, once.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use axum::Json;
use axum::Router;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use yantra_core::inventory::{self, Caller, Inventory};
use yantra_core::{down, resume, terminfo, tmux, up, workspace};

/// Generic in `S` so it merges into a router whose own state is something
/// else: `with_state` decides the *resulting* state type, and a concrete
/// `Router<()>` here would pin the whole tree to `()`.
pub fn router<I, S>(inventory: I) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/workspaces", post(make::<I>))
        .route("/workspaces/{name}/up", post(open::<I>))
        .route("/workspaces/{name}/down", post(stop::<I>))
        .route("/workspaces/{name}/resume", post(again::<I>))
        .with_state(inventory)
}

/// ADR-0016 §2. Every branch that cannot *prove* the caller is this owner's own
/// untagged node refuses, which is the same shape `listen_on` already has: the
/// only default available is the permissive one.
async fn allowed<I: Inventory>(inventory: &I, from: IpAddr) -> Result<Caller, Refused> {
    let caller = inventory
        .whois(from)
        .await
        .map_err(Refused::CannotAsk)?
        .ok_or(Refused::NotAPeer(from))?;

    if !caller.tags.is_empty() {
        return Err(Refused::Tagged(caller.tags));
    }
    let owner = inventory.owner().await.map_err(Refused::CannotAsk)?;
    if caller.user != owner {
        return Err(Refused::NotYours(caller.node));
    }
    Ok(caller)
}

/// `up` and `resume` want the terminal the session should assume, and a browser
/// has none. `terminfo::FALLBACK` is the entry chosen precisely for far sides
/// that may know nothing better (I-36), and `Chosen` reports what was used.
fn term() -> &'static str {
    terminfo::FALLBACK
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    /// Absent is a plain shell, which is `yantra up` with no `--agent`.
    #[serde(default)]
    agent: Option<Agent>,
}

/// Spelled out rather than a bool for the same reason `AgentArg` is in the CLI:
/// a second agent becomes a variant, not a second field.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum Agent {
    Claude,
}

impl From<Agent> for up::Agent {
    fn from(agent: Agent) -> Self {
        match agent {
            Agent::Claude => Self::Claude,
        }
    }
}

/// The dashboard's half of `yantra new`. `startup` is a command and not a place
/// for values: the schema has no secrets field at all (ADR-0007), so §B4 is kept
/// by there being nowhere to put one rather than by a check here.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    name: String,
    machine: String,
    repo: PathBuf,
    #[serde(default)]
    startup: Option<String>,
}

async fn make<I: Inventory + Clone + Send + Sync + 'static>(
    State(inventory): State<I>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    Json(create): Json<Create>,
) -> Result<(StatusCode, Json<Made>), Refused> {
    let caller = allowed(&inventory, from.ip()).await?;
    tracing::info!("new {} for {}", create.name, caller.node);

    let workspace = workspace::create(
        &create.name,
        &create.machine,
        &create.repo,
        create.startup.as_deref(),
    )
    .map_err(|error| Refused::Verb {
        status: from_create(&error),
        said: chain(&error),
    })?;

    Ok((
        StatusCode::CREATED,
        Json(Made {
            name: workspace.name,
            machine: workspace.machine,
            repo: workspace.repo.display().to_string(),
            startup: workspace.startup,
        }),
    ))
}

/// Distinct from [`from_workspace`] because the errors that matter here are the
/// ones `load` cannot raise: a name already taken is a **409**, since the caller
/// asked for something reasonable that the world already answers.
fn from_create(error: &workspace::Error) -> StatusCode {
    match error {
        workspace::Error::Exists { .. } => StatusCode::CONFLICT,
        workspace::Error::InvalidName { .. } | workspace::Error::Empty { .. } => {
            StatusCode::BAD_REQUEST
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn open<I: Inventory + Clone + Send + Sync + 'static>(
    State(inventory): State<I>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    Path(name): Path<String>,
    body: Option<Json<Start>>,
) -> Result<Json<Opened>, Refused> {
    let caller = allowed(&inventory, from.ip()).await?;
    let agent = body
        .and_then(|Json(start)| start.agent)
        .map(up::Agent::from);
    tracing::info!("up {name} for {}", caller.node);

    let report = up::up(&name, term(), agent)
        .await
        .map_err(|error| Refused::Verb {
            status: from_workspace(up_workspace(&error)),
            said: chain(&error),
        })?;

    Ok(Json(Opened {
        machine: report.workspace.machine,
        session: match &report.opened {
            tmux::Opened::Created(_) => Session::Created,
            tmux::Opened::Attached(_) => Session::Attached,
        },
        // I-30 and §B4: `up` twice attaches, so "nothing launched" is the
        // idempotent success and not a failure to report.
        launched: report.launched.is_some(),
        term: chosen(&report.term),
    }))
}

async fn stop<I: Inventory + Clone + Send + Sync + 'static>(
    State(inventory): State<I>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    Path(name): Path<String>,
) -> Result<Json<Stopped>, Refused> {
    let caller = allowed(&inventory, from.ip()).await?;
    tracing::info!("down {name} for {}", caller.node);

    let report = down::down(&name).await.map_err(|error| Refused::Verb {
        status: from_workspace(match &error {
            down::Error::Workspace(workspace) => Some(workspace),
            _ => None,
        }),
        said: chain(&error),
    })?;

    Ok(Json(Stopped {
        machine: report.workspace.machine,
        stopped: report.stopped,
        // Y-099: a session opened as a shell never had an ending, and saying it
        // was "killed" says something untrue about a shell.
        ending: report.ending.map(|verdict| format!("{verdict:?}")),
    }))
}

async fn again<I: Inventory + Clone + Send + Sync + 'static>(
    State(inventory): State<I>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    Path(name): Path<String>,
) -> Result<Json<Resumed>, Refused> {
    let caller = allowed(&inventory, from.ip()).await?;
    tracing::info!("resume {name} for {}", caller.node);

    let report = resume::resume(&name, term())
        .await
        .map_err(|error| Refused::Verb {
            status: from_workspace(match &error {
                resume::Error::Workspace(workspace) => Some(workspace),
                resume::Error::Up(up) => up_workspace(up),
                _ => None,
            }),
            said: chain(&error),
        })?;

    Ok(Json(Resumed {
        machine: report.workspace.machine,
        resumed: matches!(report.outcome, resume::Outcome::Resumed(_)),
        term: chosen(&report.term),
    }))
}

fn up_workspace(error: &up::Error) -> Option<&workspace::Error> {
    match error {
        up::Error::Workspace(workspace) => Some(workspace),
        _ => None,
    }
}

/// A workspace that is not there is the caller's mistake and the likeliest one
/// by far, since a fresh install has none at all. Everything else is the
/// daemon's to explain.
fn from_workspace(error: Option<&workspace::Error>) -> StatusCode {
    match error {
        Some(workspace::Error::NotFound { .. }) => StatusCode::NOT_FOUND,
        Some(workspace::Error::InvalidName { .. }) => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// `thiserror`'s `Display` is one line and the cause is the useful half, so the
/// chain is walked rather than shown as a bare summary the operator must guess
/// behind.
fn chain(error: &dyn std::error::Error) -> String {
    let mut said = error.to_string();
    let mut source = error.source();
    while let Some(next) = source {
        said.push_str(": ");
        said.push_str(&next.to_string());
        source = next.source();
    }
    said
}

fn chosen(term: &terminfo::Chosen) -> String {
    match term {
        terminfo::Chosen::Known(name) => name.clone(),
        terminfo::Chosen::Substituted { .. } => terminfo::FALLBACK.to_string(),
    }
}

#[derive(Debug, serde::Serialize)]
struct Made {
    name: String,
    machine: String,
    repo: String,
    startup: Option<String>,
}

#[derive(Debug, serde::Serialize)]
struct Opened {
    machine: String,
    session: Session,
    launched: bool,
    term: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum Session {
    Created,
    Attached,
}

#[derive(Debug, serde::Serialize)]
struct Stopped {
    machine: String,
    stopped: bool,
    ending: Option<String>,
}

#[derive(Debug, serde::Serialize)]
struct Resumed {
    machine: String,
    resumed: bool,
    term: String,
}

/// What these four routes put on the wire, for the seam check in
/// [`crate::contract`] — built rather than fetched, because every handler here
/// authorises a real tailnet caller and then awaits ssh.
#[cfg(test)]
#[allow(clippy::expect_used)]
pub(crate) fn answers() -> Vec<(&'static str, &'static str, serde_json::Value)> {
    fn of<T: serde::Serialize>(value: &T) -> serde_json::Value {
        serde_json::to_value(value).expect("a DTO of owned strings and numbers")
    }
    vec![
        (
            "made",
            "Workspace",
            of(&Made {
                name: "site".to_owned(),
                machine: "cachyos-g14".to_owned(),
                repo: "/home/<user>/Github/site".to_owned(),
                startup: Some("npm run dev".to_owned()),
            }),
        ),
        (
            "opened",
            "Opened",
            of(&Opened {
                machine: "cachyos-g14".to_owned(),
                session: Session::Created,
                launched: true,
                term: terminfo::FALLBACK.to_owned(),
            }),
        ),
        (
            "stopped",
            "Stopped",
            of(&Stopped {
                machine: "cachyos-g14".to_owned(),
                stopped: true,
                ending: Some("Finished".to_owned()),
            }),
        ),
        (
            "resumed",
            "Resumed",
            of(&Resumed {
                machine: "cachyos-g14".to_owned(),
                resumed: false,
                term: terminfo::FALLBACK.to_owned(),
            }),
        ),
    ]
}

#[derive(Debug)]
enum Refused {
    NotAPeer(IpAddr),
    NotYours(String),
    Tagged(Vec<String>),
    CannotAsk(inventory::Error),
    Verb { status: StatusCode, said: String },
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        let (status, said) = match self {
            // Named rather than logged only, because the operator reading this
            // is the same person who can fix it.
            Self::NotAPeer(from) => (
                StatusCode::FORBIDDEN,
                format!("{from} is not a peer of this tailnet"),
            ),
            Self::NotYours(node) => (
                StatusCode::FORBIDDEN,
                format!("node {node} is on this tailnet but is not yours"),
            ),
            Self::Tagged(tags) => (
                StatusCode::FORBIDDEN,
                format!(
                    "a tagged node has no person accountable for it, so it may not drive Yantra ({})",
                    tags.join(", ")
                ),
            ),
            // 503 and not 403: nothing was decided about the caller, and an
            // authoriser that cannot answer must not read as a refusal of *them*.
            Self::CannotAsk(error) => (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("could not establish who is calling: {}", chain(&error)),
            ),
            Self::Verb { status, said } => (status, said),
        };
        tracing::warn!("refused: {said}");
        (status, said).into_response()
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use yantra_core::inventory::Fake;

    const ME: u64 = 1;

    fn caller(user: u64, tags: &[&str]) -> Caller {
        Caller {
            node: "nSOME000000011CNTRL".to_string(),
            user,
            tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
        }
    }

    fn address(last: u8) -> IpAddr {
        IpAddr::from([100, 64, 0, last])
    }

    fn tailnet(entries: Vec<(IpAddr, Caller)>) -> Fake {
        Fake {
            machines: Vec::new(),
            addresses: Vec::new(),
            callers: entries.into_iter().collect::<BTreeMap<_, _>>(),
            owner: ME,
        }
    }

    #[tokio::test]
    async fn this_owners_untagged_node_is_allowed() {
        let fake = tailnet(vec![(address(2), caller(ME, &[]))]);

        let allowed = allowed(&fake, address(2)).await.expect("my own node");

        assert_eq!(allowed.user, ME);
    }

    /// The case that made ADR-0016 worth writing: a node on the tailnet that
    /// the bind address admits and the owner never added.
    #[tokio::test]
    async fn a_node_belonging_to_someone_else_is_refused() {
        let fake = tailnet(vec![(address(3), caller(ME + 1, &[]))]);

        let refused = allowed(&fake, address(3))
            .await
            .expect_err("not this owner");

        assert!(matches!(refused, Refused::NotYours(_)), "{refused:?}");
        assert_eq!(refused.into_response().status(), StatusCode::FORBIDDEN);
    }

    /// Tags beat ownership: a tagged node is *owned* by the tailnet, so the
    /// user check alone would let a CI runner through.
    #[tokio::test]
    async fn a_tagged_node_is_refused_even_though_the_owner_matches() {
        let fake = tailnet(vec![(address(4), caller(ME, &["tag:ci"]))]);

        let refused = allowed(&fake, address(4)).await.expect_err("tagged");

        assert!(matches!(refused, Refused::Tagged(_)), "{refused:?}");
    }

    #[tokio::test]
    async fn an_address_belonging_to_no_peer_is_refused() {
        let refused = allowed(&tailnet(vec![]), address(9))
            .await
            .expect_err("nobody holds it");

        assert!(matches!(refused, Refused::NotAPeer(_)), "{refused:?}");
        assert_eq!(refused.into_response().status(), StatusCode::FORBIDDEN);
    }

    /// Fails closed, and says 503 rather than 403 — nothing was decided about
    /// the caller, so refusing *them* would be a lie about which thing broke.
    #[tokio::test]
    async fn a_tailscale_that_cannot_answer_refuses_and_does_not_blame_the_caller() {
        struct Down;
        impl Inventory for Down {
            async fn machines(
                &self,
            ) -> Result<Vec<yantra_core::inventory::MachineInfo>, inventory::Error> {
                unreachable!("authorisation does not list machines")
            }
            async fn addresses(&self) -> Result<Vec<IpAddr>, inventory::Error> {
                unreachable!("authorisation does not ask for addresses")
            }
            async fn whois(&self, _address: IpAddr) -> Result<Option<Caller>, inventory::Error> {
                Err(inventory::Error::Whois {
                    stderr: "failed to connect to local tailscaled".to_string(),
                })
            }
            async fn owner(&self) -> Result<u64, inventory::Error> {
                unreachable!("it never gets this far")
            }
        }

        let refused = allowed(&Down, address(2)).await.expect_err("cannot ask");

        assert!(matches!(refused, Refused::CannotAsk(_)), "{refused:?}");
        assert_eq!(
            refused.into_response().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[test]
    fn a_workspace_that_is_not_there_is_the_callers_mistake() {
        assert_eq!(
            from_workspace(Some(&workspace::Error::NotFound {
                name: "personal-website".to_string(),
                path: "/nowhere".into(),
            })),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            from_workspace(None),
            StatusCode::INTERNAL_SERVER_ERROR,
            "an ssh failure is not the caller's mistake"
        );
    }

    /// A name already taken is the one create error that is neither the
    /// caller's typo nor the daemon's fault, and 409 is the only code that says
    /// *try another name* rather than *fix your request* or *something broke*.
    #[test]
    fn a_name_already_taken_is_a_conflict_and_not_a_bad_request() {
        assert_eq!(
            from_create(&workspace::Error::Exists {
                name: "personal-website".to_string(),
                path: "/nowhere".into(),
            }),
            StatusCode::CONFLICT
        );
        assert_eq!(
            from_create(&workspace::Error::InvalidName {
                name: "../etc/passwd".to_string(),
            }),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            from_create(&workspace::Error::Empty { field: "machine" }),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            from_create(&workspace::Error::NoConfigDir),
            StatusCode::INTERNAL_SERVER_ERROR,
            "a user with no config directory did not make a bad request"
        );
    }

    #[test]
    fn the_create_body_needs_a_name_a_machine_and_a_repo() {
        let full: Create = serde_json::from_str(
            r#"{"name":"site","machine":"mac","repo":"/code/site","startup":"npm run dev"}"#,
        )
        .expect("every field");
        assert_eq!(full.repo, std::path::Path::new("/code/site"));
        assert_eq!(full.startup.as_deref(), Some("npm run dev"));

        let shell: Create =
            serde_json::from_str(r#"{"name":"site","machine":"mac","repo":"/code/site"}"#)
                .expect("startup is optional");
        assert!(shell.startup.is_none());

        serde_json::from_str::<Create>(r#"{"machine":"mac","repo":"/code/site"}"#)
            .expect_err("a workspace with no name has nowhere to be written");
        serde_json::from_str::<Create>(
            r#"{"name":"site","machine":"mac","repo":"/code/site","secrets":{"k":"v"}}"#,
        )
        .expect_err("the schema has no secrets field, and silently dropping one would be worse");
    }

    /// `GET /workspaces` is `api.rs`'s and `POST /workspaces` is this module's,
    /// on one path in two routers. Recorded because merging them *reads* like a
    /// conflict: axum merges the method routers, and only two handlers for the
    /// same method would panic.
    #[tokio::test]
    async fn reading_and_creating_share_one_path_and_neither_shadows_the_other() {
        use axum::body::Body;
        use axum::http::{Request, header};
        use tower::ServiceExt as _;

        let app = crate::api::router()
            .with_state(crate::heartbeat::Fleet::default())
            .merge(router(tailnet(vec![])));

        let read = app
            .clone()
            .oneshot(
                Request::get("/workspaces")
                    .body(Body::empty())
                    .expect("a GET"),
            )
            .await
            .expect("the router is infallible");
        assert_eq!(read.status(), StatusCode::OK);

        let mut write = Request::post("/workspaces")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"name":"site","machine":"mac","repo":"/code/site"}"#,
            ))
            .expect("a POST with a JSON body");
        write
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([100, 64, 0, 9], 61620))));

        let made = app.oneshot(write).await.expect("the router is infallible");
        assert_eq!(
            made.status(),
            StatusCode::FORBIDDEN,
            "the POST reached authorisation rather than a 405, and this tailnet holds nobody"
        );
    }

    /// A body is optional, and an unknown field is a typo the caller should
    /// hear about rather than a silently ignored intent (ADR-0007's shape).
    #[test]
    fn the_start_body_accepts_an_agent_and_refuses_a_typo() {
        let none: Start = serde_json::from_str("{}").expect("an empty body is a shell");
        assert!(none.agent.is_none());

        let claude: Start = serde_json::from_str(r#"{"agent":"claude"}"#).expect("an agent");
        assert!(matches!(claude.agent, Some(Agent::Claude)));

        serde_json::from_str::<Start>(r#"{"agentt":"claude"}"#).expect_err("a typo is refused");
    }
}
