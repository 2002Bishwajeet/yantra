//! The routes that **act**, and the identity that authorises them
//! ([ADR-0016](../../../docs/adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md)).
//!
//! **The caller's address is not always the TCP peer**
//! ([ADR-0017](../../../docs/adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md)):
//! when the peer is one of this daemon's own bind addresses the connection was
//! opened here by a proxy, and `X-Forwarded-For` is the caller. That condition
//! and nothing else — reaching 7717 directly, a caller can write the header,
//! and there the peer is its own address rather than ours.
//!
//! Until Y-112 the API answered 405 to every write and the dashboard handed
//! over a command to paste into a terminal, which from a phone is worth
//! nothing. These routes are the CLI's own verbs and nothing more: the daemon
//! may do what `yantra` can already do, and the library decides how
//! ([ADR-0005](../../../docs/adr/0005-core-logic-in-a-library-crate.md)).
//!
//! **These handlers await ssh, and that is not a violation of this crate's
//! rule.** The rule exists because a browser polls reads whether or not anyone
//! is looking; a write happens when a person taps a button, once.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{patch, post};
use yantra_core::inventory::{self, Caller, Inventory};
use yantra_core::{agent, down, edit, resume, status, terminfo, tmux, up, workspace};

/// `tailscaled` writes this with `Set` from the connection it terminated, so it
/// carries one address and never a list ([ADR-0017]).
///
/// [ADR-0017]: ../../../docs/adr/0017-the-forwarded-address-is-the-caller-when-the-hop-is-ours.md
const FORWARDED_FOR: &str = "x-forwarded-for";

/// Who to ask about a caller, and the addresses this daemon bound.
///
/// The second is ADR-0017 §2's whole test for whether a forwarded address may
/// be believed, and it is `listen_on`'s set exactly — not "a private address",
/// not any local interface, and never loopback, which is never bound.
#[derive(Clone)]
pub struct Authoriser<I> {
    inventory: I,
    bound: Arc<[IpAddr]>,
}

impl<I: Inventory> Authoriser<I> {
    pub fn new(inventory: I, bound: &[SocketAddr]) -> Self {
        Self {
            inventory,
            bound: bound.iter().map(SocketAddr::ip).collect(),
        }
    }

    /// ADR-0017 §1. The TCP peer is the caller, unless the peer is one of our
    /// own bind addresses: nothing off this machine can open a connection that
    /// appears to come from one, so a request that does was opened here by a
    /// proxy that terminated the caller's and wrote its address down.
    ///
    /// §3: one address or refuse. An absent header is not a refusal — it means
    /// nothing proxied this, and the peer stands as it does on 7717.
    fn caller_address(&self, peer: IpAddr, headers: &HeaderMap) -> Result<IpAddr, Refused> {
        if !self.bound.contains(&peer) {
            return Ok(peer);
        }
        let mut forwarded = headers.get_all(FORWARDED_FOR).iter();
        let Some(only) = forwarded.next() else {
            return Ok(peer);
        };
        if forwarded.next().is_some() {
            return Err(Refused::Forwarded(
                "a proxy on this machine forwarded more than one address, and `tailscale serve` writes exactly one",
            ));
        }
        only.to_str()
            .ok()
            .and_then(|address| address.trim().parse().ok())
            .ok_or(Refused::Forwarded(
                "a proxy on this machine forwarded something that is not one address, and `tailscale serve` writes exactly one",
            ))
    }
}

/// Generic in `S` so it merges into a router whose own state is something
/// else: `with_state` decides the *resulting* state type, and a concrete
/// `Router<()>` here would pin the whole tree to `()`.
pub fn router<I, S>(authoriser: Authoriser<I>) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/workspaces", post(make::<I>))
        .route("/workspaces/{name}", patch(change::<I>))
        .route("/workspaces/{name}/up", post(open::<I>))
        .route("/workspaces/{name}/down", post(stop::<I>))
        .route("/workspaces/{name}/resume", post(again::<I>))
        .with_state(authoriser)
}

/// ADR-0016 §2, on the address ADR-0017 §1 picks. Every branch that cannot
/// *prove* the caller is this owner's own untagged node refuses, which is the
/// same shape `listen_on` already has: the only default available is the
/// permissive one.
pub(crate) async fn allowed<I: Inventory>(
    authoriser: &Authoriser<I>,
    peer: IpAddr,
    headers: &HeaderMap,
) -> Result<Caller, Refused> {
    let from = authoriser.caller_address(peer, headers)?;
    let caller = authoriser
        .inventory
        .whois(from)
        .await
        .map_err(Refused::CannotAsk)?
        .ok_or(Refused::NotAPeer(from))?;

    if !caller.tags.is_empty() {
        return Err(Refused::Tagged(caller.tags));
    }
    let owner = authoriser
        .inventory
        .owner()
        .await
        .map_err(Refused::CannotAsk)?;
    if caller.user != owner {
        return Err(Refused::NotYours(caller.node));
    }
    Ok(caller)
}

/// `up` and `resume` open a session nobody is yet sitting at, so there is no
/// client terminal to name — the browser names its own when it attaches
/// ([`crate::terminal`]). `terminfo::FALLBACK` is the entry chosen precisely for
/// far sides that may know nothing better (I-36), and `Chosen` reports what was
/// used.
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
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(create): Json<Create>,
) -> Result<(StatusCode, Json<Made>), Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
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

    Ok((StatusCode::CREATED, Json(Made::from(workspace))))
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

/// The dashboard's half of `yantra edit`. Only the fields named are rewritten,
/// so absent and `null` may not mean the same thing: `"startup": null` is
/// `--no-startup`, and no `startup` key at all leaves the command alone.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    #[serde(default)]
    machine: Option<String>,
    #[serde(default)]
    repo: Option<PathBuf>,
    #[serde(default, deserialize_with = "sent")]
    startup: Option<Option<String>>,
}

/// Serde reads an absent key and a `null` value alike, which for a PATCH is how
/// a field nobody mentioned gets blanked. Wrapping what the key held keeps the
/// outer `Option` meaning *the caller named this field*.
fn sent<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    serde::Deserialize::deserialize(deserializer).map(Some)
}

impl Change {
    /// `yantra edit` needs at least one field (clap's own group), for the reason
    /// that binds here too: a request that asks for nothing would answer as one
    /// that did something.
    fn names_a_field(&self) -> bool {
        self.machine.is_some() || self.repo.is_some() || self.startup.is_some()
    }
}

impl From<Change> for workspace::Changes {
    fn from(change: Change) -> Self {
        Self {
            machine: change.machine,
            repo: change.repo,
            startup: change.startup,
        }
    }
}

async fn change<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(change): Json<Change>,
) -> Result<Json<Made>, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    if !change.names_a_field() {
        return Err(Refused::Verb {
            status: StatusCode::BAD_REQUEST,
            said: "an edit that names no field has nothing to do".to_owned(),
        });
    }
    tracing::info!("edit {name} for {}", caller.node);

    let edited = edit::edit(&name, &change.into())
        .await
        .map_err(|error| Refused::Verb {
            status: from_edit(&error),
            said: chain(&error),
        })?;

    Ok(Json(Made::from(edited.workspace)))
}

/// The refusal Y-126 is about has to reach the client as something it can act
/// on. A session still open on the machine being left is **409**: the request is
/// reasonable and the world already answers, and `yantra down` is what changes
/// that. A machine that could not be asked is **503** for [`Refused::CannotAsk`]'s
/// reason — nothing was decided, so blaming the request names the wrong thing.
fn from_edit(error: &edit::Error) -> StatusCode {
    match error {
        edit::Error::SessionOpen { .. } => StatusCode::CONFLICT,
        edit::Error::CannotTell { .. } => StatusCode::SERVICE_UNAVAILABLE,
        edit::Error::Workspace(workspace::Error::Empty { .. }) => StatusCode::BAD_REQUEST,
        edit::Error::Workspace(error) => from_workspace(error),
        edit::Error::NoStateDir => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn open<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
    body: Option<Json<Start>>,
) -> Result<Json<Opened>, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    let agent = body
        .and_then(|Json(start)| start.agent)
        .map(up::Agent::from);
    tracing::info!("up {name} for {}", caller.node);

    let report = up::up(&name, term(), agent)
        .await
        .map_err(|error| Refused::Verb {
            status: from_up(&error),
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
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Stopped>, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    tracing::info!("down {name} for {}", caller.node);

    let report = down::down(&name).await.map_err(|error| Refused::Verb {
        status: from_down(&error),
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
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Resumed>, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    tracing::info!("resume {name} for {}", caller.node);

    let report = resume::resume(&name, term())
        .await
        .map_err(|error| Refused::Verb {
            status: from_resume(&error),
            said: chain(&error),
        })?;

    Ok(Json(Resumed {
        machine: report.workspace.machine,
        resumed: matches!(report.outcome, resume::Outcome::Resumed(_)),
        term: chosen(&report.term),
    }))
}

/// A workspace that is not there is the caller's mistake and the likeliest one
/// by far, since a fresh install has none at all. Everything else is the
/// daemon's to explain — and everything else here really is this daemon reading
/// its own files, which is what the mappers below took an `Option` away to keep
/// true (Y-135).
fn from_workspace(error: &workspace::Error) -> StatusCode {
    match error {
        workspace::Error::NotFound { .. } => StatusCode::NOT_FOUND,
        workspace::Error::InvalidName { .. } => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// `up`'s refusals, one variant at a time and **no wildcard**: a variant added
/// later must be given a status here rather than defaulting into a 500 the
/// operator cannot act on (Y-135).
fn from_up(error: &up::Error) -> StatusCode {
    match error {
        up::Error::Workspace(workspace) => from_workspace(workspace),
        up::Error::Ssh(_) | up::Error::Tmux(_) | up::Error::Terminfo(_) => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        up::Error::Agent(agent) => from_agent(agent),
        // `Exists` one verb along: the request is reasonable, the world already
        // answers, and `yantra edit --no-startup` is what changes the answer.
        up::Error::StartupConflict { .. } => StatusCode::CONFLICT,
        // The machine answered, and what it said is that the directory is not
        // there — which a `git clone` or an edit to `repo` changes.
        up::Error::NoRepo { .. } => StatusCode::CONFLICT,
        // ADR-0018 §1: a refusal about state, and the person at that Mac is who
        // changes it by starting a tmux server from their own login session.
        up::Error::NoLoginServer { .. } => StatusCode::CONFLICT,
        up::Error::NoStateDir => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// **`NotLoggedIn` is a 409**, and it is the commonest instance of what Y-135 is
/// about: on macOS an agent launched over ssh cannot read the login keychain
/// (I-44), so the machine answered clearly and the answer is *not yet*. A person
/// logging in at that machine is what changes it. `Unreadable` is the opposite —
/// the check could not know, so it may not claim (R-23).
fn from_agent(error: &agent::Error) -> StatusCode {
    match error {
        agent::Error::NotFound { .. } | agent::Error::NotLoggedIn { .. } => StatusCode::CONFLICT,
        agent::Error::Unreadable | agent::Error::Ssh(_) => StatusCode::SERVICE_UNAVAILABLE,
        agent::Error::Random(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn from_status(error: &status::Error) -> StatusCode {
    match error {
        status::Error::Workspace(workspace) => from_workspace(workspace),
        status::Error::Ssh(_) | status::Error::Tmux(_) | status::Error::Interrupted { .. } => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        status::Error::NoStateDir => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn from_down(error: &down::Error) -> StatusCode {
    match error {
        down::Error::Workspace(workspace) => from_workspace(workspace),
        down::Error::Ssh(_) | down::Error::Tmux(_) => StatusCode::SERVICE_UNAVAILABLE,
        down::Error::Status(status) => from_status(status),
        down::Error::NoStateDir => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn from_resume(error: &resume::Error) -> StatusCode {
    match error {
        resume::Error::Workspace(workspace) => from_workspace(workspace),
        resume::Error::Ssh(_) | resume::Error::Tmux(_) | resume::Error::Terminfo(_) => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        resume::Error::Agent(agent) => from_agent(agent),
        resume::Error::Status(status) => from_status(status),
        resume::Error::Up(up) => from_up(up),
        // Three states the world already answers and a person can change: I-49's
        // agent holding at the trust dialog, which ADR-0011 leaves to whoever is
        // at that machine; a session opened as a shell; a workspace that runs
        // something of its own.
        resume::Error::AwaitingTrust { .. }
        | resume::Error::NoAgent { .. }
        | resume::Error::Startup { .. } => StatusCode::CONFLICT,
        // The two sources disagree, so nothing was decided about that pane and
        // naming either the caller or this daemon would be a guess (R-23).
        resume::Error::Unclear { .. } => StatusCode::SERVICE_UNAVAILABLE,
        resume::Error::NoStateDir => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// `thiserror`'s `Display` is one line and the cause is the useful half, so the
/// chain is walked rather than shown as a bare summary the operator must guess
/// behind.
pub(crate) fn chain(error: &dyn std::error::Error) -> String {
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

/// What both routes that write a workspace file answer with. The whole of it,
/// because `refresh.rs` looks every 30 s and a client that re-read the list to
/// see what it just wrote would draw what it replaced.
#[derive(Debug, serde::Serialize)]
struct Made {
    name: String,
    machine: String,
    repo: String,
    startup: Option<String>,
}

impl From<workspace::Workspace> for Made {
    fn from(workspace: workspace::Workspace) -> Self {
        Self {
            name: workspace.name,
            machine: workspace.machine,
            repo: workspace.repo.display().to_string(),
            startup: workspace.startup,
        }
    }
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
pub(crate) enum Refused {
    NotAPeer(IpAddr),
    NotYours(String),
    Tagged(Vec<String>),
    CannotAsk(inventory::Error),
    /// ADR-0017 §3, kept apart from [`Self::CannotAsk`] because nothing broke:
    /// something unmeasured is in the local path, and a guess repaired out of
    /// it would be the confident lie R-23 is about.
    Forwarded(&'static str),
    Verb {
        status: StatusCode,
        said: String,
    },
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
            // 503 for the same reason: the caller did not write this header and
            // is not what went wrong, so a 4xx would name them.
            Self::Forwarded(said) => (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("could not establish who is calling: {said}"),
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

    /// Bound to nothing, so no peer is ever ours and every test below reads the
    /// address exactly as ADR-0016 wrote it.
    fn direct(fake: Fake) -> Authoriser<Fake> {
        Authoriser::new(fake, &[])
    }

    /// Bound to [`address(1)`], which is where `tailscale serve` proxies to and
    /// therefore the peer a proxied request arrives from.
    fn behind_the_proxy(fake: Fake) -> Authoriser<Fake> {
        Authoriser::new(fake, &[SocketAddr::new(address(1), 7717)])
    }

    fn forwarded(values: &[&str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for value in values {
            headers.append(
                FORWARDED_FOR,
                value.parse().expect("a header value of ASCII"),
            );
        }
        headers
    }

    #[tokio::test]
    async fn this_owners_untagged_node_is_allowed() {
        let fake = tailnet(vec![(address(2), caller(ME, &[]))]);

        let allowed = allowed(&direct(fake), address(2), &HeaderMap::new())
            .await
            .expect("my own node");

        assert_eq!(allowed.user, ME);
    }

    /// The case that made ADR-0016 worth writing: a node on the tailnet that
    /// the bind address admits and the owner never added.
    #[tokio::test]
    async fn a_node_belonging_to_someone_else_is_refused() {
        let fake = tailnet(vec![(address(3), caller(ME + 1, &[]))]);

        let refused = allowed(&direct(fake), address(3), &HeaderMap::new())
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

        let refused = allowed(&direct(fake), address(4), &HeaderMap::new())
            .await
            .expect_err("tagged");

        assert!(matches!(refused, Refused::Tagged(_)), "{refused:?}");
    }

    #[tokio::test]
    async fn an_address_belonging_to_no_peer_is_refused() {
        let refused = allowed(&direct(tailnet(vec![])), address(9), &HeaderMap::new())
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

        let refused = allowed(&Authoriser::new(Down, &[]), address(2), &HeaderMap::new())
            .await
            .expect_err("cannot ask");

        assert!(matches!(refused, Refused::CannotAsk(_)), "{refused:?}");
        assert_eq!(
            refused.into_response().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    /// ADR-0017 §1, the half that keeps the direct port as ADR-0016 wrote it: a
    /// caller reaching 7717 can put anything in the header, and its own address
    /// is the peer rather than ours, so the header is not read. A tagged node
    /// that could launder itself through one would be the hole widened, not
    /// closed.
    #[tokio::test]
    async fn a_forwarded_address_from_a_peer_that_is_not_ours_is_not_the_caller() {
        let fake = tailnet(vec![
            (address(2), caller(ME, &[])),
            (address(4), caller(ME, &["tag:ci"])),
        ]);

        let refused = allowed(
            &behind_the_proxy(fake),
            address(4),
            &forwarded(&["100.64.0.2"]),
        )
        .await
        .expect_err("the peer is the caller here");

        assert!(matches!(refused, Refused::Tagged(_)), "{refused:?}");
    }

    /// **The acceptance criterion ADR-0017 names**, and the case the proxy
    /// would otherwise authorise in silence: the peer *is* ours, so the
    /// forwarded address is the caller — and it resolves to a tagged node.
    #[tokio::test]
    async fn a_forwarded_address_from_one_of_our_own_bind_addresses_is_the_caller() {
        let fake = tailnet(vec![
            (address(1), caller(ME, &[])),
            (address(4), caller(ME, &["tag:ci"])),
        ]);

        let refused = allowed(
            &behind_the_proxy(fake),
            address(1),
            &forwarded(&["100.64.0.4"]),
        )
        .await
        .expect_err("the proxy is not the caller");

        assert!(matches!(refused, Refused::Tagged(_)), "{refused:?}");

        // Named in the refusal, so the address that was judged is the forwarded
        // one and not the peer this daemon would otherwise have believed.
        let stranger = allowed(
            &behind_the_proxy(tailnet(vec![(address(1), caller(ME, &[]))])),
            address(1),
            &forwarded(&["100.64.0.9"]),
        )
        .await
        .expect_err("nobody holds it");
        assert!(
            matches!(stranger, Refused::NotAPeer(judged) if judged == address(9)),
            "{stranger:?}"
        );
    }

    /// ADR-0017 §3. An absent header is not a refusal — it says nothing proxied
    /// this, which is every request on 7717.
    #[tokio::test]
    async fn a_request_from_our_own_bind_address_with_no_header_is_the_peer() {
        let fake = tailnet(vec![(address(1), caller(ME, &[]))]);

        let allowed = allowed(&behind_the_proxy(fake), address(1), &HeaderMap::new())
            .await
            .expect("the local hop, unproxied");

        assert_eq!(allowed.user, ME);
    }

    /// ADR-0017 §3's other half: `tailscaled` writes exactly one address with
    /// `Set`, so a list, a second line or a value that is not an address means
    /// something unmeasured is in the path — refused rather than repaired, and
    /// **not** by taking one entry out of a list.
    #[tokio::test]
    async fn a_forwarded_header_that_is_not_one_address_is_refused() {
        let fleet = || {
            tailnet(vec![
                (address(1), caller(ME, &[])),
                (address(2), caller(ME, &[])),
            ])
        };

        for header in [
            forwarded(&["100.64.0.2, 100.64.0.9"]),
            forwarded(&["100.64.0.2", "100.64.0.9"]),
            forwarded(&[""]),
            forwarded(&["cachyos-g14"]),
        ] {
            let refused = allowed(&behind_the_proxy(fleet()), address(1), &header)
                .await
                .expect_err("one address or refuse");

            assert!(matches!(refused, Refused::Forwarded(_)), "{refused:?}");
            assert_eq!(
                refused.into_response().status(),
                StatusCode::SERVICE_UNAVAILABLE,
                "the caller did not write this header, so refusing them names the wrong thing"
            );
        }
    }

    #[test]
    fn a_workspace_that_is_not_there_is_the_callers_mistake() {
        assert_eq!(
            from_workspace(&workspace::Error::NotFound {
                name: "personal-website".to_string(),
                path: "/nowhere".into(),
            }),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            from_workspace(&workspace::Error::NoConfigDir),
            StatusCode::INTERNAL_SERVER_ERROR,
            "a user with no config directory did not make a bad request"
        );
        assert_eq!(
            from_up(&up::Error::Workspace(workspace::Error::NotFound {
                name: "personal-website".to_string(),
                path: "/nowhere".into(),
            })),
            StatusCode::NOT_FOUND,
            "the verbs reach it through their own errors, which is all this takes now"
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
                path: "/srv/workspaces/../etc/passwd.toml".into(),
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

    /// **The refusal Y-126 is about, as the client receives it.** The detection
    /// is proved against a real tmux in
    /// [`yantra-core/tests/edit.rs`](../../yantra-core/tests/edit.rs); what is
    /// proved here is that it arrives as something to act on rather than a 500,
    /// since no test in this crate can reach the handler itself — `edit::edit`
    /// reads the operator's own config directory and ssh's to the machine it
    /// names.
    #[tokio::test]
    async fn a_session_open_on_the_machine_being_left_is_a_conflict_and_not_a_failure() {
        let refused = edit::Error::SessionOpen {
            workspace: "personal-website".to_string(),
            machine: "cachyos-g14".to_string(),
        };

        let response = Refused::Verb {
            status: from_edit(&refused),
            said: chain(&refused),
        }
        .into_response();

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("the body is in memory");
        let said = String::from_utf8_lossy(&body);
        assert!(said.contains("personal-website"), "{said}");
        assert!(said.contains("cachyos-g14"), "{said}");
        assert!(said.contains("yantra down personal-website"), "{said}");
    }

    /// R-23 over HTTP: a machine that could not be asked has decided nothing, so
    /// it is neither the caller's mistake nor a success — and the cause travels
    /// with it, because *ssh failed* alone sends the operator nowhere.
    #[tokio::test]
    async fn a_machine_that_could_not_be_asked_refuses_without_blaming_the_request() {
        let refused = edit::Error::CannotTell {
            workspace: "personal-website".to_string(),
            machine: "pi".to_string(),
            source: Box::new(yantra_core::ssh::Error::Transport {
                host: "pi".to_string(),
                diagnosis: "connect to host pi port 22: Connection refused".to_string(),
            }),
        };

        let response = Refused::Verb {
            status: from_edit(&refused),
            said: chain(&refused),
        }
        .into_response();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("the body is in memory");
        let said = String::from_utf8_lossy(&body);
        assert!(said.contains("Connection refused"), "{said}");
    }

    /// What the browser receives, built the only way this crate can: `up`,
    /// `down` and `resume` each load the operator's own config directory and
    /// ssh to the machine it names, so no test here reaches a handler.
    async fn answered(status: StatusCode, error: &dyn std::error::Error) -> (StatusCode, String) {
        let response = Refused::Verb {
            status,
            said: chain(error),
        }
        .into_response();

        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("the body is in memory");
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    /// **Y-135's own case.** I-49: an agent holding at the trust dialog is inert
    /// rather than broken — nothing has failed, a human has not answered a dialog
    /// on their own machine, and ADR-0011 says that human is the only one who
    /// may. A 500 draws that as *the verb ran and failed*.
    #[tokio::test]
    async fn an_agent_holding_at_the_trust_prompt_is_a_conflict_and_not_a_failure() {
        let waiting = resume::Error::AwaitingTrust {
            workspace: "personal-website".to_string(),
        };

        let (status, said) = answered(from_resume(&waiting), &waiting).await;

        assert_eq!(status, StatusCode::CONFLICT);
        assert!(said.contains("personal-website"), "{said}");
        assert!(said.contains("trust prompt"), "{said}");
    }

    /// The commoner instance of the same bug, and the whole of I-44 as it arrives
    /// at the dashboard: the Mac answered, and what it said is *not logged in*.
    /// `up` reaches it directly and `resume` through both of its own paths, which
    /// must agree — one 500 among them is the bug back.
    #[tokio::test]
    async fn an_agent_that_is_not_logged_in_is_a_conflict_and_not_a_failure() {
        let keychain = || agent::Error::NotLoggedIn {
            method: "none".to_string(),
        };

        let (status, said) = answered(from_up(&up::Error::Agent(keychain())), &keychain()).await;

        assert_eq!(status, StatusCode::CONFLICT);
        assert!(said.contains("not logged in"), "{said}");
        assert_eq!(
            from_resume(&resume::Error::Agent(keychain())),
            StatusCode::CONFLICT
        );
        assert_eq!(
            from_resume(&resume::Error::Up(up::Error::Agent(keychain()))),
            StatusCode::CONFLICT
        );
    }

    /// Both directions, so this is not read as *stop answering 500*: a directory
    /// this daemon could not work out is still its own fault, and a machine that
    /// could not be asked is neither that nor the caller's.
    #[test]
    fn what_is_this_daemons_fault_still_says_so_and_what_is_unknown_still_does_not() {
        assert_eq!(
            from_up(&up::Error::NoStateDir),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            from_resume(&resume::Error::NoStateDir),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            from_down(&down::Error::NoStateDir),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            from_up(&up::Error::Agent(agent::Error::Random(
                std::io::Error::other("no entropy")
            ))),
            StatusCode::INTERNAL_SERVER_ERROR
        );

        assert_eq!(
            from_down(&down::Error::Ssh(yantra_core::ssh::Error::Transport {
                host: "pi".to_string(),
                diagnosis: "connect to host pi port 22: Connection refused".to_string(),
            })),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            from_resume(&resume::Error::Unclear {
                workspace: "personal-website".to_string(),
                because: "the pane is alive but claude knows of no agent in that directory",
            }),
            StatusCode::SERVICE_UNAVAILABLE,
            "a resume that could not tell what is in the pane decided nothing"
        );
    }

    /// The move nothing is holding: `edit` reaches the machine only when
    /// `machine` really changes, so a workspace nothing runs on comes back whole
    /// — which is what a form redraws from, the read model being up to 30 s old.
    #[test]
    fn an_edit_that_went_through_answers_the_workspace_as_it_now_reads() {
        let answered = serde_json::to_value(Made::from(workspace::Workspace {
            name: "personal-website".to_string(),
            machine: "bishwajeets-macbook-pro".to_string(),
            repo: "/home/<user>/Github/site".into(),
            startup: None,
        }))
        .expect("a DTO of owned strings");

        assert_eq!(
            answered,
            serde_json::json!({
                "name": "personal-website",
                "machine": "bishwajeets-macbook-pro",
                "repo": "/home/<user>/Github/site",
                "startup": null,
            })
        );
    }

    #[test]
    fn an_edit_fails_the_way_the_verbs_beside_it_do() {
        assert_eq!(
            from_edit(&edit::Error::Workspace(workspace::Error::NotFound {
                name: "nosuch".to_string(),
                path: "/nowhere".into(),
            })),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            from_edit(&edit::Error::Workspace(workspace::Error::InvalidName {
                name: "../etc/passwd".to_string(),
                path: "/srv/workspaces/../etc/passwd.toml".into(),
            })),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            from_edit(&edit::Error::Workspace(workspace::Error::Empty {
                field: "machine"
            })),
            StatusCode::BAD_REQUEST,
            "a field emptied by the request is the request's fault"
        );
        assert_eq!(
            from_edit(&edit::Error::NoStateDir),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    /// The distinction a PATCH is silently wrong without: `"startup": null`
    /// clears the command and an absent `startup` leaves it, and serde folds
    /// both into `None` on its own.
    #[test]
    fn the_edit_body_tells_a_field_left_alone_from_one_cleared() {
        let one: Change = serde_json::from_str(r#"{"repo":"/code/site"}"#).expect("one field");
        assert_eq!(
            one.repo.as_deref(),
            Some(std::path::Path::new("/code/site"))
        );
        assert!(one.startup.is_none(), "an absent startup is not an edit");

        let cleared: Change = serde_json::from_str(r#"{"startup":null}"#).expect("a shell again");
        assert_eq!(cleared.startup, Some(None));
        assert!(cleared.names_a_field(), "clearing a field is naming it");

        let set: Change = serde_json::from_str(r#"{"startup":"npm run dev"}"#).expect("a command");
        assert_eq!(
            workspace::Changes::from(set).startup,
            Some(Some("npm run dev".to_string()))
        );

        assert!(
            !serde_json::from_str::<Change>("{}")
                .expect("an empty body parses")
                .names_a_field(),
            "an edit that names no field has nothing to do"
        );
        serde_json::from_str::<Change>(r#"{"name":"renamed"}"#)
            .expect_err("the filename is the identity, and a typo must not read as a rename");
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
            .merge(router(direct(tailnet(vec![]))));

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

    /// `PATCH /workspaces/{name}` sits one segment above `{name}/status`, which
    /// `api.rs` owns on the same merged router. A 405 here would say the method
    /// never reached a handler; the read below it says the new path did not
    /// swallow the old one.
    #[tokio::test]
    async fn editing_is_authorised_and_does_not_shadow_the_route_below_it() {
        use axum::body::Body;
        use axum::http::{Request, header};
        use tower::ServiceExt as _;

        let app = crate::api::router()
            .with_state(crate::heartbeat::Fleet::default())
            .merge(router(direct(tailnet(vec![]))));

        let mut edit = Request::patch("/workspaces/site")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"repo":"/code/site"}"#))
            .expect("a PATCH with a JSON body");
        edit.extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([100, 64, 0, 9], 61620))));

        let refused = app
            .clone()
            .oneshot(edit)
            .await
            .expect("the router is infallible");
        assert_eq!(
            refused.status(),
            StatusCode::FORBIDDEN,
            "the PATCH reached authorisation rather than a 405, and this tailnet holds nobody"
        );

        let status = app
            .oneshot(
                Request::get("/workspaces/site/status")
                    .body(Body::empty())
                    .expect("a GET"),
            )
            .await
            .expect("the router is infallible");
        assert_eq!(
            status.status(),
            StatusCode::OK,
            "the read one segment below still answers for itself"
        );
    }
}
