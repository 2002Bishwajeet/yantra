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
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use yantra_core::github;
use yantra_core::install;
use yantra_core::inventory::{self, Caller, Inventory};
use yantra_core::notify;
use yantra_core::{
    agent, clone, dirs, doctor, down, edit, logs, price, probe, remove, resume, sessions, status,
    terminfo, tmux, tokens, up, workspace,
};
use yantra_core::{identity, join};

use crate::api::Answer;
use crate::events::{self, Event};
use crate::heartbeat::Fleet;

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
///
/// The re-check is a second sub-router because it is the one authorised route
/// that also reads this daemon's own memory, and a handler takes one state.
pub fn router<I, S>(authoriser: Authoriser<I>, fleet: Fleet) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    let acts: Router<S> = Router::new()
        .route("/workspaces", post(make::<I>))
        .route("/workspaces/{name}", patch(change::<I>).delete(erase::<I>))
        .route("/workspaces/{name}/up", post(open::<I>))
        .route("/workspaces/{name}/down", post(stop::<I>))
        .route("/workspaces/{name}/resume", post(again::<I>))
        .route("/workspaces/{name}/tokens", post(spent::<I>))
        .route("/workspaces/{name}/logs", post(said::<I>))
        // The `GET` is here rather than in `api.rs` on purpose (ADR-0020): it
        // serves a file's bytes, which is the one thing the read model does not
        // publish, and it asks the same question the `POST` answers.
        .route(
            "/workspaces/{name}/repair",
            get(unusable::<I>).post(mend::<I>),
        )
        .route(
            "/machines/{machine}/sessions/{session}",
            axum::routing::delete(end::<I>),
        )
        .route("/machines/{machine}/probe", post(ask::<I>))
        .route("/machines/{machine}/dirs", post(walk::<I>))
        .route("/machines/{machine}/clone", post(fetch::<I>))
        .with_state(authoriser.clone());

    // `{name}` rather than `{machine}`, which the routes above prefer: the `GET`
    // on this path spells it `{name}`, and two spellings of one route are a
    // matchit conflict rather than two routes (measured — it panics at startup).
    // `/relay` is here since Y-343 because its test send is an event (ADR-0025).
    let remembered: Router<S> = Router::new()
        .route("/machines/{name}/readiness", post(recheck::<I>))
        .route("/viewing", post(viewing::<I>))
        .route("/relay", post(relay::<I>))
        .route("/github/login", post(login::<I>))
        .route("/github", axum::routing::delete(logout::<I>))
        .route(
            "/github/client-id",
            post(set_client_id::<I>).delete(clear_client_id::<I>),
        )
        .route("/join", post(join_as::<I>))
        .with_state(Remembered {
            authoriser: authoriser.clone(),
            fleet: fleet.clone(),
        });

    let installs: Router<S> = Router::new()
        .route("/machines/{machine}/install", post(put_basics::<I>))
        .with_state(Installer {
            authoriser,
            fleet,
            running: Running::default(),
        });

    acts.merge(remembered).merge(installs)
}

/// `GET /join`, the script a person pipes into `sh` on a new machine (Y-387).
/// Apart from [`router`] because it is not under `/api`.
pub fn script<I, S>(authoriser: Authoriser<I>, fleet: Fleet) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/join", get(serve_script::<I>))
        .with_state(Remembered { authoriser, fleet })
}

/// The state these two need: who the caller is, and what this daemon holds in
/// memory — the re-check reads it, the beacon writes to it, and a handler takes
/// one state.
#[derive(Clone)]
struct Remembered<I> {
    authoriser: Authoriser<I>,
    fleet: Fleet,
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

/// `up` and `resume` open a session nobody is yet sitting at, and the readiness
/// sweep asks on nobody's behalf at all, so there is no client terminal to name
/// — the browser names its own when it attaches ([`crate::terminal`]).
/// `terminfo::FALLBACK` is the entry chosen precisely for far sides that may
/// know nothing better (I-36), and `Chosen` reports what was used.
pub(crate) fn term() -> &'static str {
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

/// The bytes of a workspace file that will not load, and the reason it will not
/// — what `/w/{name}/repair` draws (D3 §7.5).
///
/// **A file that loads is a 409**, which is [ADR-0020]'s first bound answered on
/// the read as well as the write: a caller may not be shown a file it may not
/// send back. That makes opening this the whole question *is this broken*.
///
/// **Authorised like a write, though it reads** ([ADR-0016]). A file's raw bytes
/// are the one thing `GET /api/workspaces` does not publish, and the page that
/// asks for them already needs the gate for the `POST` beside it.
///
/// [ADR-0016]: ../../../docs/adr/0016-the-dashboard-writes-and-tailscale-identity-authorises-it.md
/// [ADR-0020]: ../../../docs/adr/0020-a-raw-write-only-from-broken-to-valid.md
async fn unusable<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Broken>, Refused> {
    allowed(&authoriser, from.ip(), &headers).await?;

    let broken = workspace::broken(&name).map_err(|error| Refused::Verb {
        status: from_repair(&error),
        said: chain(&error),
    })?;

    Ok(Json(Broken {
        name: broken.name,
        path: broken.path.display().to_string(),
        text: broken.text,
        error: chain(&broken.error),
    }))
}

/// `yantra repair` on the wire, and the only route that writes a workspace file
/// this daemon did not compose ([ADR-0020]).
///
/// Two refusals and nothing else between the bytes and the disk: **409** for a
/// file that already loads, **400** for bytes that still will not, naming the
/// next error. Together they mean this can move a file from broken to valid and
/// nowhere else.
///
/// [ADR-0020]: ../../../docs/adr/0020-a-raw-write-only-from-broken-to-valid.md
async fn mend<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(sent): Json<Repair>,
) -> Result<Json<Made>, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    tracing::info!("repair {name} for {}", caller.node);

    let repaired = workspace::repair(&name, &sent.text).map_err(|error| Refused::Verb {
        status: from_repair(&error),
        said: chain(&error),
    })?;

    Ok(Json(Made::from(repaired)))
}

/// **Where this differs from [`from_workspace`], and why it is a separate
/// mapper**: there, `Malformed` and `Blank` are this daemon reading its own
/// files and so a 500. Here they are the bytes the caller sent, so the caller is
/// who can fix them.
fn from_repair(error: &workspace::Error) -> StatusCode {
    match error {
        // The request is reasonable and the world already answers: the file
        // works, and `PATCH /api/workspaces/{name}` is what changes one.
        workspace::Error::Loads { .. } => StatusCode::CONFLICT,
        workspace::Error::Malformed { .. } | workspace::Error::Blank { .. } => {
            StatusCode::BAD_REQUEST
        }
        error => from_workspace(error),
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

/// Asks a machine whether a directory is there and what git origin it holds,
/// so a form can offer a choice instead of a blank field.
///
/// **A read reached over a `POST`, and that is [ADR-0019]** rather than a
/// mislabelled verb: the answer depends on a path nobody has typed yet, so no
/// snapshot can hold it, and a `GET` awaiting ssh is the bug the rule above
/// exists to prevent. It qualifies because a person typed it and nothing polls
/// it — both halves, which is the test the ADR sets for the next candidate.
///
/// [ADR-0019]: ../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md
async fn ask<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(machine): Path<String>,
    Json(asked): Json<Asked>,
) -> Result<Json<Found>, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    tracing::info!("probe {machine} for {}", caller.node);

    let found = probe::probe(&machine, &asked.path)
        .await
        .map_err(|error| Refused::Verb {
            status: match error {
                probe::Error::Ssh(_) => StatusCode::SERVICE_UNAVAILABLE,
                probe::Error::NoStateDir => StatusCode::INTERNAL_SERVER_ERROR,
            },
            said: chain(&error),
        })?;

    Ok(Json(Found {
        machine: found.machine,
        path: found.path,
        exists: found.exists,
        // Absent for three different reasons, which `exists` separates. The
        // route does not flatten them into one.
        origin: found.origin,
    }))
}

/// Asks a machine what one directory holds, so a form can walk to a path
/// instead of trusting one that was typed — `yantra ls dirs <machine> [path]`
/// on the wire.
///
/// **The sixth thing in this crate that holds ssh, and the fourth read on
/// [`ask`]'s licence** ([ADR-0019]): a person is walking a directory and
/// nothing polls it. It is **one level** and stays that way — D4 §2 measured a
/// whole-home `find` at 8.5 s against this listing's 0.23 s, and eight seconds
/// inside a handler would be a different decision from a probe's.
///
/// **A body is optional and so is its `path`**, because the machine's own
/// `$HOME` is the only directory this daemon can name without asking, and
/// composing one here would be the placement decision ADR-0009 declined.
///
/// **`make` beside `path` is `yantra ls dirs --make`** (Y-344): one directory
/// under `path`, and then the listing a picker was already drawing. A field
/// rather than a sibling route because the answer is this route's answer and
/// the picker has one call to make either way.
///
/// [ADR-0019]: ../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md
async fn walk<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(machine): Path<String>,
    body: Option<Json<Walked>>,
) -> Result<Json<Listing>, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    let Walked { path, make } = body.map(|Json(walked)| walked).unwrap_or_default();

    let listing = match make {
        Some(name) => {
            tracing::info!("mkdir on {machine} for {}", caller.node);
            dirs::make(&machine, path.as_deref(), &name).await
        }
        None => {
            tracing::info!("dirs {machine} for {}", caller.node);
            dirs::list(&machine, path.as_deref()).await
        }
    }
    .map_err(|error| Refused::Verb {
        status: from_dirs(&error),
        said: chain(&error),
    })?;

    Ok(Json(Listing::from(listing)))
}

/// **A path that is not there is a 409**, which is `up::Error::NoRepo`'s own
/// reading: the machine answered clearly, and a `mkdir` on that machine is what
/// changes the answer. An empty directory is none of this — it is a `200` with
/// no entries, and the two are different answers (R-23). A directory the
/// machine would not make is the same 409; a name it was never asked about,
/// because it is not one segment, is the caller's `400`.
fn from_dirs(error: &dirs::Error) -> StatusCode {
    match error {
        dirs::Error::Ssh(_) => StatusCode::SERVICE_UNAVAILABLE,
        dirs::Error::NotADirectory { .. } | dirs::Error::NotMade { .. } => StatusCode::CONFLICT,
        dirs::Error::InvalidName { .. } => StatusCode::BAD_REQUEST,
        // An answer this build cannot parse is this build's problem, and so is
        // having nowhere to keep a control socket.
        dirs::Error::Unreadable { .. } | dirs::Error::NoStateDir => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

/// `yantra clone <url> --machine <m> --into <path>` on the wire (Y-344).
///
/// **It answers before the clone has done anything but start**, which is the
/// whole design: `git clone` runs inside a tmux session on the machine, the
/// `202` names the session, progress is that session's terminal socket
/// ([ADR-0022]) and completion is [`ask`]. Nothing here awaits the clone, and
/// a handler that did would hold a request for as long as a repository takes.
///
/// **No token goes with it** ([ADR-0023] §4): the machine's own git credential
/// fetches, and a URL carrying one is a `400` before any machine is asked.
///
/// [ADR-0022]: ../../../docs/adr/0022-a-socket-may-address-a-session-rather-than-a-workspace.md
/// [ADR-0023]: ../../../docs/adr/0023-the-github-grant-lives-beside-the-relay.md
async fn fetch<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(machine): Path<String>,
    Json(asked): Json<Fetch>,
) -> Result<(StatusCode, Json<Cloning>), Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    let plan = clone::plan(&asked.url, &asked.path).map_err(|error| Refused::Verb {
        status: from_clone(&error),
        said: chain(&error),
    })?;
    tracing::info!("clone into {machine}:{} for {}", plan.path, caller.node);

    let cloning = clone::clone(&machine, &plan)
        .await
        .map_err(|error| Refused::Verb {
            status: from_clone(&error),
            said: chain(&error),
        })?;

    Ok((
        StatusCode::ACCEPTED,
        Json(Cloning {
            machine: cloning.machine,
            session: cloning.session,
        }),
    ))
}

/// The two refusals are the caller's; a macOS machine with no tmux server is
/// the world's answer a person changes (`up`'s 409); ssh and tmux decided
/// nothing (R-23).
fn from_clone(error: &clone::Error) -> StatusCode {
    match error {
        clone::Error::InvalidUrl { .. } | clone::Error::InvalidPath { .. } => {
            StatusCode::BAD_REQUEST
        }
        clone::Error::NoLoginServer { .. } => StatusCode::CONFLICT,
        clone::Error::Ssh(_) | clone::Error::Tmux(_) => StatusCode::SERVICE_UNAVAILABLE,
        clone::Error::NoStateDir => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// The machines an install is running on now, lowercased: ssh reads a name
/// without regard to case, so `pi` and `PI` are one machine.
type Running = Arc<std::sync::Mutex<std::collections::BTreeSet<String>>>;

/// A machine's place in [`Running`], given back when this drops — on every
/// path out of the task that holds it, a panic included.
struct Claim {
    running: Running,
    key: String,
}

impl Claim {
    fn take(running: &Running, machine: &str) -> Option<Self> {
        let key = machine.to_lowercase();
        let mut held = running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        held.insert(key.clone()).then(|| Self {
            running: running.clone(),
            key,
        })
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.key);
    }
}

#[derive(Clone)]
struct Installer<I> {
    authoriser: Authoriser<I>,
    fleet: Fleet,
    running: Running,
}

/// Yantra stops waiting after this. Dropping the future kills only the local
/// `ssh`; the far side's installer can go on (I-27), so the event says so.
const INSTALL_BUDGET: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// `yantra install <machine>` on the wire ([ADR-0028] §4). **202, and nothing
/// here awaits the install**, which can take minutes: a task the daemon owns
/// runs it, puts the result in the ring (ADR-0025) and then runs the readiness
/// sweep. **One install per machine at a time**, so a second `POST` while one
/// runs is a **409**.
///
/// [ADR-0028]: ../../../docs/adr/0028-yantra-installs-the-bare-minimum-on-a-machine.md
async fn put_basics<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Installer<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(machine): Path<String>,
) -> Result<StatusCode, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    // The name is a request value, and it reaches `ssh`'s argv (ADR-0009).
    install::check_machine(&machine).map_err(|error| Refused::Verb {
        status: StatusCode::BAD_REQUEST,
        said: error.to_string(),
    })?;
    let Some(claim) = Claim::take(&state.running, &machine) else {
        return Err(Refused::Verb {
            status: StatusCode::CONFLICT,
            said: format!("an install is already running on {machine}"),
        });
    };
    tracing::info!("install on {machine} for {}", caller.node);
    tokio::spawn(install_in_background(state.fleet, claim, machine));
    Ok(StatusCode::ACCEPTED)
}

/// [ADR-0030]: the commands the latest install on each machine left for a
/// person, keyed as [`Running`] is. The one-off terminal runs these by index
/// and nothing else. Memory only, so a restart forgets them.
///
/// [ADR-0030]: ../../../docs/adr/0030-a-one-off-terminal-runs-only-a-command-an-install-left.md
pub type Left = Arc<std::sync::Mutex<std::collections::BTreeMap<String, Vec<String>>>>;

/// The next result on a machine replaces its list, and one that left nothing
/// empties it.
fn remember_left(left: &Left, machine: &str, commands: &[String]) {
    left.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(machine.to_lowercase(), commands.to_vec());
}

/// The command at `index` in what the latest install on `machine` left.
pub(crate) fn left_command(left: &Left, machine: &str, index: usize) -> Option<String> {
    left.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&machine.to_lowercase())
        .and_then(|commands| commands.get(index))
        .cloned()
}

async fn install_in_background(fleet: Fleet, claim: Claim, machine: String) {
    let event = match tokio::time::timeout(INSTALL_BUDGET, install::install(&machine)).await {
        Ok(Ok(report)) => Event::install(&report),
        Ok(Err(error)) => Event::install_failed(
            &machine,
            &format!("{}: {}", from_install(&error), chain(&error)),
        ),
        Err(_) => Event::install_waited(&machine, INSTALL_BUDGET.as_secs() / 60),
    };
    // Before the event, so a page that reads it can open any step it names.
    remember_left(&fleet.left, &machine, &event.commands);
    events::remember(&fleet.events, event).await;
    drop(claim);
    crate::refresh::look_at_readiness(&fleet.model).await;
}

/// No wildcard, per Y-135: ssh, tmux and a lookup decided nothing about the
/// machine (R-23), and a missing state directory is this daemon's own fault.
fn from_install(error: &install::Error) -> &'static str {
    match error {
        install::Error::Ssh(_) | install::Error::Tmux(_) | install::Error::Agent(_) => {
            "the machine could not be asked, so what it has is not known"
        }
        install::Error::NoStateDir => "this daemon has no directory for ssh control sockets",
        // `put_basics` refuses it with a 400 first; this arm keeps the map whole.
        install::Error::InvalidMachine { .. } => "the name is not one Yantra passes to ssh",
    }
}

/// `yantra doctor <machine>`, asked now rather than read off the sweep.
///
/// **A read reached over a `POST`, for [`ask`]'s reason** ([ADR-0019]): the
/// `GET` beside it serves a reading up to 30 s old, and someone who has just
/// installed `tmux` by hand needs to know it took before the next sweep. A
/// person taps it and nothing polls it, which is both halves of the ADR's test.
///
/// **It costs an ssh round trip, and an asleep machine costs all ten seconds of
/// `ConnectTimeout` before it answers.** What it answers then is ten
/// *unknown* checks and never a 500: [`doctor::machine`] cannot fail, because a
/// machine that could not be asked is not a machine that failed (R-23). A name
/// nothing answers to reads the same way, and deliberately — ADR-0009 leaves
/// this daemon no register of ssh destinations to refuse one against, which is
/// why [`ask`] takes any machine too.
///
/// [ADR-0019]: ../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md
async fn recheck<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Remembered<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Answer<doctor::Report>>, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    tracing::info!("doctor {name} for {}", caller.node);

    let report = doctor::machine(&name, term()).await;
    let snapshot = state.fleet.model.read().await.clone();
    let beats = state.fleet.beats.read().await;
    Ok(Json(Answer::Ok {
        // Asked on this request, so there is no staleness to report — and the
        // envelope is the sweep's so the browser needs no second type.
        age_seconds: 0,
        data: crate::api::answered(&report, &snapshot, &beats),
    }))
}

/// `/settings`' whole surface, and `yantra relay` on the wire.
///
/// **The token is written to disk in plain text**, which §B4 forbids for a
/// workspace and [ADR-0021] permits for this one file. The read path is
/// untouched: `yantrad` still takes both values out of its environment, and
/// `systemd` is what puts them there at the next start — so what this route
/// changes is the *next* daemon and never the running one.
///
/// **It sends after it writes**, and reports both. A relay written down and
/// never reached is the failure a headless box has no other way to show, so the
/// test message is the answer rather than a second button — and a send that
/// fails does not un-write the file, which is what the 502 has to say.
///
/// Nothing is logged but the caller: the topic is a password on a public relay,
/// and the token is one everywhere.
///
/// [ADR-0021]: ../../../docs/adr/0021-the-relay-is-written-to-an-environment-file.md
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Publish {
    url: String,
    /// Absent is an open topic, which is one of the two states ntfy has.
    #[serde(default)]
    token: Option<String>,
}

/// [`notify::NotWritten`] named exhaustively, so a variant added there will
/// not compile here until it is given one: `relay` and `set_client_id`
/// share it rather than each carrying a wildcard that would quietly send a
/// new fault — a failed pre-read of `daemon.env`, say — to the wrong side of
/// the 400/500 line (Y-393's review).
fn status_of(error: &notify::NotWritten) -> StatusCode {
    match error {
        notify::NotWritten::NotAUrl
        | notify::NotWritten::Unholdable { .. }
        | notify::NotWritten::InvalidClientId => StatusCode::BAD_REQUEST,
        notify::NotWritten::Read { .. } | notify::NotWritten::Write { .. } => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

async fn relay<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Remembered<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(publish): Json<Publish>,
) -> Result<StatusCode, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    tracing::info!("relay written for {}", caller.node);

    let file = std::path::Path::new(notify::RELAY_FILE);
    {
        // Held for the whole read-modify-write: three routes in this daemon
        // reach this file, and `notify::rewrite`'s own `flock` only keeps a
        // contending writer from clobbering another — it does not stop a
        // tokio worker blocking on the syscall while it waits (Y-393's
        // review).
        let _write = state.fleet.env.lock().await;
        notify::write_relay(file, &publish.url, publish.token.as_deref()).map_err(|error| {
            Refused::Verb {
                status: status_of(&error),
                said: chain(&error),
            }
        })?;
    }

    let relay = notify::Relay::new(publish.url, publish.token);
    // ADR-0025 §2: remembered before the send, so a 502 is still an event.
    events::remember(&state.fleet.events, Event::relay_test()).await;
    notify::post(&relay, notify::test_message())
        .await
        .map_err(|error| Refused::Verb {
            status: StatusCode::BAD_GATEWAY,
            said: format!(
                "the relay is written down in {}, and the test message did not arrive: {}",
                notify::RELAY_FILE,
                chain(&error)
            ),
        })?;

    Ok(StatusCode::NO_CONTENT)
}

/// Step 1 of the device flow, as the page draws it: the code to type and where
/// to type it. **`device_code` is not in it** — with the client id it is
/// enough to collect the token, so it stays in the task that polls.
#[derive(Debug, serde::Serialize)]
struct Device {
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

impl Device {
    fn of(device: &github::Device) -> Self {
        Self {
            user_code: device.user_code.clone(),
            verification_uri: device.verification_uri.clone(),
            expires_in: device.expires_in,
            interval: device.interval,
        }
    }
}

/// `yantra github login` on the wire ([ADR-0023] §5). It answers as soon as
/// GitHub has issued a code, and the rest of the flow — the poll, the write,
/// the grant going live — runs in a task the daemon owns, because the person
/// is now on their phone at github.com and nothing here should wait on them.
/// `GET /api/github` says when it is done.
///
/// **One flow at a time**: a second `POST` while a code is waiting is a
/// **409**, since two would race for one file. A daemon with no client id is
/// a **500** naming the variable — that is this deployment's own fault — and
/// a GitHub that refused or could not be reached is a **502**.
///
/// [ADR-0023]: ../../../docs/adr/0023-the-github-grant-lives-beside-the-relay.md
async fn login<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Remembered<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Device>, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    let client_id = github::client_id().ok_or_else(|| Refused::Verb {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        said: github::Error::NoClientId.to_string(),
    })?;
    let grant = &state.fleet.github;
    if !grant.begin().await {
        return Err(Refused::Verb {
            status: StatusCode::CONFLICT,
            said: "a sign-in is already waiting for its code to be entered at github.com"
                .to_owned(),
        });
    }
    let device = match github::Github::default().begin(&client_id).await {
        Ok(device) => device,
        Err(error) => {
            grant.clear().await;
            return Err(Refused::Verb {
                status: match error {
                    github::Error::Rejected { .. } => StatusCode::INTERNAL_SERVER_ERROR,
                    _ => StatusCode::BAD_GATEWAY,
                },
                said: chain(&error),
            });
        }
    };
    tracing::info!("github sign-in begun for {}", caller.node);
    tokio::spawn(crate::github::sign_in(
        grant.clone(),
        client_id,
        device.clone(),
        state.fleet.env.clone(),
    ));
    Ok(Json(Device::of(&device)))
}

/// `yantra github logout` on the wire: the line leaves the file, then the
/// grant leaves memory. In that order, so a file that could not be written
/// answers **500** naming it while the daemon still holds what the file does
/// — the two never disagree in the direction that brings a revoked grant back
/// at the next start.
async fn logout<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Remembered<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<StatusCode, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    {
        let _write = state.fleet.env.lock().await;
        notify::write_github(std::path::Path::new(notify::RELAY_FILE), None).map_err(|error| {
            Refused::Verb {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                said: chain(&error),
            }
        })?;
    }
    state.fleet.github.clear().await;
    tracing::info!("github grant removed by {}", caller.node);
    Ok(StatusCode::NO_CONTENT)
}

/// `yantra github client-id <id>` on the wire (Y-393): a self-hoster's own
/// OAuth App instead of the one this build carries. Same file, same writer
/// ADR-0021 built — the id is not a secret (ADR-0023), so it goes down beside
/// the two that are.
///
/// **This takes effect at `yantrad`'s next start**, exactly like the relay:
/// [`github::client_id`] rereads the process environment, and nothing here
/// holds a value live in between.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientId {
    id: String,
}

async fn set_client_id<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Remembered<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(sent): Json<ClientId>,
) -> Result<StatusCode, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    let file = std::path::Path::new(notify::RELAY_FILE);
    {
        let _write = state.fleet.env.lock().await;
        notify::write_client_id(file, Some(&sent.id)).map_err(|error| Refused::Verb {
            status: status_of(&error),
            said: chain(&error),
        })?;
    }
    tracing::info!("github client id written for {}", caller.node);
    Ok(StatusCode::NO_CONTENT)
}

/// `yantra github client-id --clear`: the line leaves the file. Absence is
/// the state asked for (I-30), so this succeeds whether or not one was there.
async fn clear_client_id<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Remembered<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<StatusCode, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    let file = std::path::Path::new(notify::RELAY_FILE);
    {
        let _write = state.fleet.env.lock().await;
        notify::write_client_id(file, None).map_err(|error| Refused::Verb {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            said: chain(&error),
        })?;
    }
    tracing::info!("github client id cleared by {}", caller.node);
    Ok(StatusCode::NO_CONTENT)
}

/// The dashboard saying it is on screen (D3 §13), so the notifier stops pushing
/// what the page is already showing.
///
/// **It is a write and it is authorised like one**: silencing someone's phone
/// is an act, and `whois` costs one subprocess per beacon — the page beacons
/// once every `BEACON_MS` and only while the tab is visible, which is the same
/// order as the sweep this daemon already runs.
///
/// **The state is one timestamp in memory** and a restart forgets it, which is
/// what Y-044 means here. It is not the exception ADR-0021 carved: nothing
/// about a viewer needs to survive anything.
async fn viewing<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Remembered<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<StatusCode, Refused> {
    allowed(&state.authoriser, from.ip(), &headers).await?;
    *state.fleet.viewers.write().await = Some(std::time::Instant::now());
    Ok(StatusCode::NO_CONTENT)
}

/// `yantra join-script` on the wire ([ADR-0029]). **A `GET` that may write**,
/// once: the owner ruled that the daemon makes its key on the first join, and
/// the script is where the key is first needed. Authorised like a write for
/// that reason, though what it serves is a public key and an address.
///
/// [ADR-0029]: ../../../docs/adr/0029-a-machine-joins-itself.md
async fn serve_script<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Remembered<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Response, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    let dir = state.fleet.facts.ssh_dir.clone();
    let one_at_a_time = state.fleet.joins.lock().await;
    // `ssh-keygen` is a subprocess, so off the worker (I-13).
    let prepared = tokio::task::spawn_blocking(move || identity::prepare_in(&dir, &[]))
        .await
        .map_err(|_| Refused::Verb {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            said: "making the ssh key did not finish".to_owned(),
        })?
        .map_err(|error| Refused::Verb {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            said: chain(&error),
        })?;
    drop(one_at_a_time);
    let bound: Vec<IpAddr> = state
        .fleet
        .facts
        .listening_on
        .iter()
        .map(SocketAddr::ip)
        .collect();
    let script = join::daemon_address(&bound)
        .and_then(|daemon| join::script(daemon, &prepared.public_key))
        .map_err(|error| Refused::Verb {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            said: chain(&error),
        })?;
    if prepared.generated {
        tracing::info!("made {} for the first join", prepared.key.display());
    }
    tracing::info!("join script served to {}", caller.node);
    // Plain text, so a person who opens the URL in a browser reads it first.
    Ok((
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        script,
    )
        .into_response())
}

/// What the join command reports: the account it ran as, and nothing else.
/// **There is no `machine` field** and `deny_unknown_fields` makes one a
/// refusal — the machine is the caller, named by the tailnet (ADR-0016 §2).
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Join {
    user: String,
}

/// `yantra ssh-identity --machine <m> --user <u>` on the wire, with the
/// machine taken from the caller's address rather than typed (ADR-0029). A
/// machine can therefore only join itself.
async fn join_as<I: Inventory + Clone + Send + Sync + 'static>(
    State(state): State<Remembered<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(join): Json<Join>,
) -> Result<Json<Joined>, Refused> {
    let caller = allowed(&state.authoriser, from.ip(), &headers).await?;
    if !identity::usable_user(&join.user) {
        return Err(Refused::Verb {
            status: StatusCode::BAD_REQUEST,
            said: identity::Error::UnusableUser { user: join.user }.to_string(),
        });
    }
    // I-5 and I-52: `whois` spells the stable id `StableID`, which is what
    // `status` calls `ID`, so the two join on it.
    let machine = state
        .authoriser
        .inventory
        .machines()
        .await
        .map_err(Refused::CannotAsk)?
        .into_iter()
        .find(|machine| machine.id == caller.node)
        .map(|machine| machine.name)
        .ok_or_else(|| Refused::Verb {
            status: StatusCode::SERVICE_UNAVAILABLE,
            said: format!(
                "tailscale knows the caller as {} but does not list it, so there is no machine name to write",
                caller.node
            ),
        })?;

    let dir = state.fleet.facts.ssh_dir.clone();
    let (named, user) = (machine.clone(), join.user.clone());
    let one_at_a_time = state.fleet.joins.lock().await;
    let joined = tokio::task::spawn_blocking(move || identity::join_in(&dir, &named, &user))
        .await
        .map_err(|_| Refused::Verb {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            said: "writing the ssh config did not finish".to_owned(),
        })?
        .map_err(|error| Refused::Verb {
            status: from_identity(&error),
            said: chain(&error),
        })?;
    drop(one_at_a_time);
    tracing::info!("{machine} joined as {} for {}", joined.user, caller.node);

    events::remember(
        &state.fleet.events,
        Event::joined(
            &joined.machine,
            &joined.user,
            joined.kept,
            joined.logs_in_as.as_deref(),
        ),
    )
    .await;
    // The re-check runs after the answer: the script is still on the person's
    // screen, and ssh back into that machine can take `ConnectTimeout`.
    tokio::spawn(check_joined(state.fleet.events.clone(), machine));

    Ok(Json(Joined {
        machine: joined.machine,
        user: joined.user,
        kept: joined.kept,
        logs_in_as: joined.logs_in_as,
    }))
}

/// `doctor` on the machine that just joined. Only a *refused* reach is an
/// event: an unknown one decided nothing (R-23), and a reached one is what the
/// `joined` event already implied.
async fn check_joined(events: events::Events, machine: String) {
    let report = doctor::machine(&machine, term()).await;
    if let Some(check) = report
        .checks
        .iter()
        .find(|check| check.check == "reachable" && check.state == doctor::State::Absent)
    {
        events::remember(&events, Event::not_reached(&machine, &check.detail)).await;
    }
}

/// No wildcard, per Y-135. A tailnet name that cannot be one `Host` pattern is
/// a **409**: the person renames the machine in Tailscale, and nothing here can.
fn from_identity(error: &identity::Error) -> StatusCode {
    match error {
        identity::Error::UnusableUser { .. } => StatusCode::BAD_REQUEST,
        identity::Error::UnusableMachine { .. } => StatusCode::CONFLICT,
        identity::Error::Workspaces(_)
        | identity::Error::NoHome
        | identity::Error::Write { .. }
        | identity::Error::Read { .. }
        | identity::Error::Spawn(_)
        | identity::Error::Keygen(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// What the join command reads back (owner, 2026-09-12: *"dashboard should
/// say it"*). `kept` is a config that already named the machine and was left as
/// it was. `logs_in_as` is what `ssh -G` resolves, which can differ from `user`
/// — a kept block, or an owner's `Host *` above the new one — and `null` is a
/// config ssh could not read.
#[derive(Debug, serde::Serialize)]
struct Joined {
    machine: String,
    user: String,
    kept: bool,
    logs_in_as: Option<String>,
}

/// What the agent in this workspace has spent — `yantra tokens <workspace>` on
/// the wire.
///
/// **On request only, and a `POST` for [`recheck`]'s reason** ([ADR-0019]). It
/// opens a transcript over ssh and reads a file that grows all session, which
/// makes it the dearest read this crate has. Nothing may sweep it and nothing
/// may poll it: a `$` on a row the fleet page refreshes every few seconds would
/// put that read back into the loop, which is why D3 §11.4 keeps money on a tab
/// somebody opens.
///
/// **Numbers, never records.** [`tokens::spent`] sums on the far machine and
/// ships back counts, so no conversation crosses the wire (Y-181), and [`Spend`]
/// has nowhere to put one.
///
/// [ADR-0019]: ../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md
async fn spent<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Spend>, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    tracing::info!("tokens {name} for {}", caller.node);

    let spend = tokens::tokens(&name).await.map_err(|error| Refused::Verb {
        status: from_logs(&error),
        said: chain(&error),
    })?;

    Ok(Json(Spend::of(&spend)))
}

/// What the agent in this workspace has been saying — `yantra logs
/// <workspace>` on the wire, a window at a time.
///
/// **A `POST` for [`spent`]'s reason** ([ADR-0019]), and it opens the same file:
/// a transcript grows all session, so nothing may sweep this and nothing may
/// poll it. Landing on the transcript tab is the request (D5 §4.3).
///
/// **The two empty cases are 409 rather than 404** — a workspace whose agent
/// has written no turn is the world's answer and not a mistake, and its first
/// message changes it (I-49). [`from_logs`] is the mapper [`spent`] already
/// uses, because both routes read one file and fail in one set of ways.
///
/// [ADR-0019]: ../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md
async fn said<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
    body: Option<Json<Window>>,
) -> Result<Json<Transcript>, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    let Json(window) = body.unwrap_or_default();
    tracing::info!("logs {name} for {}", caller.node);

    let read = logs::logs(&name, window.lines, window.before)
        .await
        .map_err(|error| Refused::Verb {
            status: from_logs(&error),
            said: chain(&error),
        })?;

    Ok(Json(Transcript::of(&read)))
}

/// Stops a session by machine and name — the sessions `ls sessions` finds that
/// no workspace claims, so `POST /workspaces/{name}/down` cannot reach them.
///
/// A **write**, and it awaits ssh for the reason the exception exists: a person
/// tapped a button once. Nothing polls this.
async fn end<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path((machine, session)): Path<(String, String)>,
) -> Result<Json<Ended>, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    tracing::info!("kill {session} on {machine} for {}", caller.node);

    let report = sessions::kill(&machine, &session)
        .await
        .map_err(|error| Refused::Verb {
            status: from_sessions(&error),
            said: chain(&error),
        })?;

    Ok(Json(Ended {
        machine: report.machine,
        session: report.session,
        // False is "nothing was there", which is the state asked for and never
        // a failure (I-30).
        killed: report.killed,
    }))
}

/// `DELETE` rather than a `POST /delete`, because the verb HTTP already has
/// means this and nothing here needs a body. `?force=true` is the CLI's
/// `--force`: it skips asking the machine rather than ignoring its answer.
async fn erase<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(name): Path<String>,
    uri: Uri,
) -> Result<Json<Removed>, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    tracing::info!("rm {name} for {}", caller.node);

    match remove::remove(&name, forced(&uri)).await {
        Ok(report) => Ok(Json(Removed {
            // `None` is a file that was deleted without ever parsing, so there
            // is nothing true to say about where it pointed.
            machine: report.workspace.map(|workspace| workspace.machine),
            removed: true,
        })),
        // Absence is the state asked for, so a second delete succeeds — the
        // shape `down` already uses for a session that was not running. A `404`
        // here would make two tabs deleting one workspace show a failure for
        // something that worked.
        Err(remove::Error::Workspace(workspace::Error::NotFound { .. })) => Ok(Json(Removed {
            machine: None,
            removed: false,
        })),
        Err(error) => Err(Refused::Verb {
            status: from_remove(&error),
            said: chain(&error),
        }),
    }
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
/// Read from the URI rather than through `Query`, whose axum feature this
/// workspace does not enable — one flag is a real cost on a binary this repo
/// measures, and the whole requirement is a single boolean.
fn forced(uri: &Uri) -> bool {
    uri.query()
        .is_some_and(|query| query.split('&').any(|pair| pair == "force=true"))
}

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

/// No wildcard, for Y-135's reason: a variant added later must be given a
/// status rather than defaulting into a 500 nobody can act on.
fn from_remove(error: &remove::Error) -> StatusCode {
    match error {
        remove::Error::Workspace(workspace) => from_workspace(workspace),
        // The session is still open, so the request conflicts with the state of
        // the thing it names. `force` is how a caller means it anyway.
        remove::Error::SessionOpen { .. } => StatusCode::CONFLICT,
        remove::Error::CannotTell { .. } => StatusCode::SERVICE_UNAVAILABLE,
        remove::Error::NoStateDir => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// No wildcard, per Y-135. **A transcript that is not there yet is a 409**: the
/// machine answered clearly and what it said is that this agent has written no
/// turn, which its first message changes and nothing here can (I-46, I-49).
fn from_logs(error: &logs::Error) -> StatusCode {
    match error {
        logs::Error::Workspace(workspace) => from_workspace(workspace),
        logs::Error::Ssh(_) => StatusCode::SERVICE_UNAVAILABLE,
        logs::Error::NoTranscript { .. } | logs::Error::NoTurnYet { .. } => StatusCode::CONFLICT,
        // The far side's shell answered, and what it said was that it could not
        // look — so nothing was decided and the caller is not to blame (R-23).
        logs::Error::Probe { .. } => StatusCode::SERVICE_UNAVAILABLE,
        // An answer this build cannot parse is this build's problem, and so is
        // having nowhere to keep a control socket.
        logs::Error::Unreadable | logs::Error::NoStateDir => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// No wildcard, per Y-135.
fn from_sessions(error: &sessions::Error) -> StatusCode {
    match error {
        sessions::Error::Workspace(workspace) => from_workspace(workspace),
        sessions::Error::Ssh(_) | sessions::Error::Tmux(_) => StatusCode::SERVICE_UNAVAILABLE,
        sessions::Error::NoStateDir | sessions::Error::Interrupted { .. } => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
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

#[derive(Debug, serde::Deserialize)]
struct Asked {
    path: String,
}

#[derive(Debug, serde::Serialize)]
struct Found {
    machine: String,
    path: String,
    exists: bool,
    origin: Option<String>,
}

/// Absent, and an absent `path` inside it, both mean the machine's `$HOME`.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Walked {
    #[serde(default)]
    path: Option<String>,
    /// One directory to make under `path` before listing it (Y-344).
    #[serde(default)]
    make: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Fetch {
    url: String,
    path: String,
}

/// What a `202` carries: where to watch. The session is
/// `GET /api/machines/{machine}/sessions/{session}/terminal`'s address.
#[derive(Debug, serde::Serialize)]
struct Cloning {
    machine: String,
    session: String,
}

/// One level of a machine's filesystem. **No entry is a file and none begins
/// with a dot** — the glob that lists directories skips both (D4 §3.1), so a
/// browser that draws this list draws directories or nothing.
#[derive(Debug, serde::Serialize)]
struct Listing {
    machine: String,
    /// The directory that was listed, as the far side spells it: a caller that
    /// sent no path reads its `$HOME` off this and nowhere else.
    path: String,
    entries: Vec<Dir>,
}

#[derive(Debug, serde::Serialize)]
struct Dir {
    path: String,
    name: String,
    repo: bool,
    /// Absent for two different reasons — not a repository, and a repository
    /// with no origin — which the route leaves together exactly as [`ask`]
    /// does.
    origin: Option<String>,
}

impl From<dirs::Listing> for Listing {
    fn from(listing: dirs::Listing) -> Self {
        Self {
            machine: listing.machine,
            path: listing.path,
            entries: listing
                .entries
                .into_iter()
                .map(|entry| Dir {
                    path: entry.path,
                    name: entry.name,
                    repo: entry.repo,
                    origin: entry.origin,
                })
                .collect(),
        }
    }
}

#[derive(Debug, serde::Serialize)]
struct Ended {
    machine: String,
    session: String,
    killed: bool,
}

#[derive(Debug, serde::Serialize)]
struct Removed {
    machine: Option<String>,
    removed: bool,
}

/// A workspace file that will not load. `error` is the whole `source()` chain,
/// because the sentence the page draws beside the bytes is what a repair
/// answers.
#[derive(Debug, serde::Serialize)]
struct Broken {
    name: String,
    /// On the machine running this daemon, which is the other way to fix it.
    path: String,
    text: String,
    error: String,
}

/// The whole file, never a patch: [ADR-0020] refuses bytes that do not parse,
/// and a fragment of TOML never does.
///
/// [ADR-0020]: ../../../docs/adr/0020-a-raw-write-only-from-broken-to-valid.md
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Repair {
    text: String,
}

#[derive(Debug, serde::Serialize)]
struct Resumed {
    machine: String,
    resumed: bool,
    term: String,
}

/// What a session spent, and the day the prices it was charged at were true.
///
/// Counts and dollars and nothing else. [`tokens::Spend`] is summed on the far
/// machine (Y-181), and this shape has no field a conversation could arrive in.
#[derive(Debug, serde::Serialize)]
struct Spend {
    /// The transcript that was read, on the machine that wrote it.
    path: String,
    total: Counts,
    /// One entry per model the transcript named, because models do not share a
    /// rate.
    models: Vec<ModelSpend>,
    /// Responses Claude Code recorded as fast mode, billed at twice base input
    /// and twice output. One is enough to withhold every figure below rather
    /// than understate it.
    fast: usize,
    /// Dollars for the models the table prices. `null` is *no figure to give* —
    /// fast mode, or a session that has spent nothing yet — and never zero
    /// dollars.
    cost: Option<f64>,
    /// [`price::AS_OF`], beside the figure rather than in a release note: a
    /// table written into a binary reports wrong money the day a rate changes,
    /// and this date is the only thing that says so.
    as_of: &'static str,
}

/// Deliberately no total across the four: they are not the same unit of
/// anything, and money is the one figure that adds them.
#[derive(Debug, serde::Serialize)]
struct Counts {
    /// API responses rather than transcript records, which are not the same
    /// number (I-61).
    responses: usize,
    input: u64,
    output: u64,
    cache_write: u64,
    cache_read: u64,
}

#[derive(Debug, serde::Serialize)]
struct ModelSpend {
    model: String,
    responses: usize,
    /// `null` is a model the price table does not carry — **unpriced**, which
    /// is a different thing from free. Its tokens are still in `total`, and its
    /// dollars are in nobody's figure.
    cost: Option<f64>,
}

impl Spend {
    /// The CLI's `render_tokens`, as JSON: the same three refusals to price, so
    /// the browser can draw neither more nor less than the terminal does.
    fn of(spend: &tokens::Spend) -> Self {
        let total = spend.total();
        // Fast mode is billed at a premium the table does not carry, so nothing
        // is priced — per model or in total.
        let priced = spend.fast == 0;
        let models: Vec<ModelSpend> = spend
            .by_model
            .iter()
            .map(|(model, counts)| ModelSpend {
                model: model.clone(),
                responses: counts.responses,
                cost: priced
                    .then(|| price::rate(model))
                    .flatten()
                    .map(|rate| rate.charge(counts)),
            })
            .collect();
        // R-23: a sum over an empty list is `0.0`, and `$0.00` for a session the
        // table priced none of is a figure a reader would act on. Found while
        // building `/usage` (Y-199); `render_tokens` had the same arithmetic.
        let charged = (priced && total.responses > 0)
            .then(|| {
                let costs: Vec<f64> = models.iter().filter_map(|model| model.cost).collect();
                (!costs.is_empty()).then(|| costs.iter().sum())
            })
            .flatten();

        Self {
            path: spend.path.clone(),
            total: Counts {
                responses: total.responses,
                input: total.input,
                output: total.output,
                cache_write: total.cache_write,
                cache_read: total.cache_read,
            },
            models,
            fast: spend.fast,
            cost: charged,
            as_of: price::AS_OF,
        }
    }
}

/// Which records to read. A caller that sends no body gets the first window,
/// which is what landing on the transcript tab asks for.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Window {
    /// **Records, not turns** — the far side counts what it selected, and nine
    /// of the last fifty measured as tool results the parse drops (D5 §2.3).
    #[serde(default = "records")]
    lines: usize,
    /// How many newer records to skip, which is what `Older` asks for.
    #[serde(default)]
    before: usize,
}

/// D5 §4.4's window: fifty records, measured as forty-one turns.
const fn records() -> usize {
    50
}

impl Default for Window {
    fn default() -> Self {
        Self {
            lines: records(),
            before: 0,
        }
    }
}

/// One window of the conversation, projected to who spoke and what they said.
///
/// **The tool *results* are not here and never cross the wire** — they are the
/// bulk of the file and the agent's input rather than its output (I-46).
#[derive(Debug, serde::Serialize)]
struct Transcript {
    /// The file that was read, on the machine that wrote it — [`Spend`]'s field
    /// of the same name, for the same reason.
    path: String,
    /// Every record the far side selected, counted before the window cut it
    /// down. A caller that pages backwards compares this against its first read
    /// to see that the conversation moved on (D5 §4.4).
    total: usize,
    turns: Vec<Turn>,
}

#[derive(Debug, serde::Serialize)]
struct Turn {
    who: Speaker,
    /// The record's own ISO-8601 instant. `null` on the few records that carry
    /// none, which a reader draws as no time rather than as *unknown*.
    at: Option<String>,
    text: String,
    tools: Vec<ToolCall>,
}

/// `you` and `claude`, which are `render_logs`'s own two words — there is no
/// reason for the browser to invent two more (D5 §4.1).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum Speaker {
    You,
    Claude,
}

#[derive(Debug, serde::Serialize)]
struct ToolCall {
    name: String,
    /// The one string the call acted on, capped on the far side. `null` for a
    /// tool whose input names none of the eight keys, which renders as the
    /// name alone (D5 §4.2).
    target: Option<String>,
}

impl Transcript {
    fn of(read: &logs::Transcript) -> Self {
        Self {
            path: read.path.clone(),
            total: read.total,
            turns: read
                .entries
                .iter()
                .map(|entry| Turn {
                    who: match entry.who {
                        logs::Who::User => Speaker::You,
                        logs::Who::Assistant => Speaker::Claude,
                    },
                    at: entry.at.clone(),
                    text: entry.text.clone(),
                    tools: entry
                        .tools
                        .iter()
                        .map(|call| ToolCall {
                            name: call.name.clone(),
                            target: call.target.clone(),
                        })
                        .collect(),
                })
                .collect(),
        }
    }
}

/// What these routes put on the wire, for the seam check in
/// [`crate::contract`] — built rather than fetched, because every handler here
/// authorises a real tailnet caller and then awaits ssh.
///
/// Spend appears twice because the nulls are the interesting half: a state
/// nothing generates is a state nothing checks.
#[cfg(test)]
#[allow(clippy::expect_used)]
pub(crate) fn answers() -> Vec<(&'static str, &'static str, serde_json::Value)> {
    fn of<T: serde::Serialize>(value: &T) -> serde_json::Value {
        serde_json::to_value(value).expect("a DTO of owned strings and numbers")
    }
    vec![
        (
            "device",
            "Device",
            of(&Device {
                user_code: "WDJB-MJHT".to_owned(),
                verification_uri: "https://github.com/login/device".to_owned(),
                expires_in: 900,
                interval: 5,
            }),
        ),
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
        (
            "broken",
            "Broken",
            of(&Broken {
                name: "site".to_owned(),
                path: "/home/<user>/.config/yantra/workspaces/site.toml".to_owned(),
                text: "machine = \"cachyos-g14\"\nrepo =\n".to_owned(),
                error: "workspace `site` at /home/<user>/.config/yantra/workspaces/site.toml is \
                        not valid TOML: TOML parse error at line 2, column 7"
                    .to_owned(),
            }),
        ),
        ("spend", "Spend", of(&Spend::of(&transcript(0)))),
        ("spendFast", "Spend", of(&Spend::of(&transcript(3)))),
        ("logs", "Transcript", of(&Transcript::of(&conversation()))),
        (
            "joined",
            "Joined",
            of(&Joined {
                machine: "cachyos-g14".to_owned(),
                user: "<user>".to_owned(),
                kept: false,
                logs_in_as: Some("<user>".to_owned()),
            }),
        ),
        // The owner's re-join ruling: a kept block that logs in as someone
        // else, which the page has to be able to say.
        (
            "joinedKept",
            "Joined",
            of(&Joined {
                machine: "cachyos-g14".to_owned(),
                user: "<user>".to_owned(),
                kept: true,
                logs_in_as: Some("yantra".to_owned()),
            }),
        ),
        (
            "cloning",
            "Cloning",
            of(&Cloning {
                machine: "cachyos-g14".to_owned(),
                session: "clone-yantra".to_owned(),
            }),
        ),
        (
            "listing",
            "Listing",
            of(&Listing::from(dirs::Listing {
                machine: "cachyos-g14".to_owned(),
                path: "/home/<user>/Github".to_owned(),
                entries: vec![
                    dirs::Dir {
                        path: "/home/<user>/Github/yantra".to_owned(),
                        name: "yantra".to_owned(),
                        repo: true,
                        origin: Some("https://github.com/2002Bishwajeet/yantra.git".to_owned()),
                    },
                    // Both `null`s the browser has to draw: a repository whose
                    // origin nothing answered for, and a plain directory.
                    dirs::Dir {
                        path: "/home/<user>/Github/scratch".to_owned(),
                        name: "scratch".to_owned(),
                        repo: false,
                        origin: None,
                    },
                ],
            })),
        ),
    ]
}

/// Both turns a reader can meet, and every `null` under them: a stamp the
/// record did not carry, and a call whose input names none of the eight keys.
#[cfg(test)]
fn conversation() -> logs::Transcript {
    logs::Transcript {
        path: "/home/<user>/.claude/projects/-home-<user>-Github-site/1f0c1a2e.jsonl".to_owned(),
        modified: 1_785_522_600,
        now: 1_785_522_642,
        total: 1_944,
        entries: vec![
            logs::Entry {
                who: logs::Who::User,
                at: Some("2026-08-11T18:09:33.178Z".to_owned()),
                text: "run the tests".to_owned(),
                tools: Vec::new(),
            },
            logs::Entry {
                who: logs::Who::Assistant,
                at: None,
                text: "Running them now.".to_owned(),
                tools: vec![
                    logs::Call {
                        name: "Bash".to_owned(),
                        target: Some("cargo nextest run --workspace".to_owned()),
                    },
                    logs::Call {
                        name: "SendUserFile".to_owned(),
                        target: None,
                    },
                ],
            },
        ],
    }
}

/// A session on two models, one of which the price table does not carry, so the
/// fixture holds a `cost` of both kinds. `fast` above zero withholds all three.
#[cfg(test)]
fn transcript(fast: usize) -> tokens::Spend {
    let counts = |responses, input, output| tokens::Counts {
        responses,
        input,
        output,
        cache_write: 120_400,
        cache_write_1h: 40_000,
        cache_read: 4_812_003,
    };
    tokens::Spend {
        path: "/home/<user>/.claude/projects/-home-<user>-Github-site/1f0c1a2e.jsonl".to_owned(),
        by_model: [
            (
                "claude-opus-5-20260115".to_owned(),
                counts(66, 9_412, 84_310),
            ),
            (tokens::UNKNOWN_MODEL.to_owned(), counts(2, 118, 640)),
        ]
        .into(),
        fast,
    }
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
            .merge(router(direct(tailnet(vec![])), Fleet::default()));

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

    /// D3 §13's beacon reaching the one timestamp the notifier reads, and
    /// nothing else: the daemon knows a viewer is there and knows nothing about
    /// who or where.
    #[tokio::test]
    async fn a_beacon_from_this_owner_is_what_the_notifier_reads() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt as _;

        let fleet = Fleet::default();
        let app = router::<_, ()>(
            direct(tailnet(vec![(address(2), caller(ME, &[]))])),
            fleet.clone(),
        );
        let mut beacon = Request::post("/viewing")
            .body(Body::empty())
            .expect("a POST");
        beacon
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::new(address(2), 61620)));

        let answered = app.oneshot(beacon).await.expect("the router is infallible");

        assert_eq!(answered.status(), StatusCode::NO_CONTENT);
        assert!(crate::notify::watched(&fleet.viewers).await);
    }

    /// ADR-0016 covers it like every other write, and the reason is what it
    /// does: a beacon stops this daemon pushing to somebody's phone.
    #[tokio::test]
    async fn a_beacon_from_a_node_that_is_not_this_owners_silences_nothing() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt as _;

        let fleet = Fleet::default();
        let app = router::<_, ()>(
            direct(tailnet(vec![(address(3), caller(ME + 1, &[]))])),
            fleet.clone(),
        );
        let mut beacon = Request::post("/viewing")
            .body(Body::empty())
            .expect("a POST");
        beacon
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::new(address(3), 61620)));

        let answered = app.oneshot(beacon).await.expect("the router is infallible");

        assert_eq!(answered.status(), StatusCode::FORBIDDEN);
        assert!(!crate::notify::watched(&fleet.viewers).await);
    }

    /// The route that writes a secret to disk is behind the same gate as the
    /// rest, and refuses before it opens the file: this tailnet holds nobody,
    /// and `/etc/yantra/daemon.env` is not something a test may touch.
    #[tokio::test]
    async fn writing_the_relay_is_authorised_before_anything_is_written() {
        use axum::body::Body;
        use axum::http::{Request, header};
        use tower::ServiceExt as _;

        let app = router::<_, ()>(direct(tailnet(vec![])), Fleet::default());
        let mut set = Request::post("/relay")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"url":"https://ntfy.sh/a-topic"}"#))
            .expect("a POST with a JSON body");
        set.extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([100, 64, 0, 9], 61620))));

        let answered = app.oneshot(set).await.expect("the router is infallible");

        assert_eq!(answered.status(), StatusCode::FORBIDDEN);
    }

    /// A name that is not a hostname never reaches ssh: an allowed caller gets
    /// a 400 before the machine is claimed or anything is spawned.
    #[tokio::test]
    async fn a_hostile_machine_name_is_refused_before_ssh() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt as _;

        let fleet = Fleet::default();
        let running = Running::default();
        let app = Router::new()
            .route("/machines/{machine}/install", post(put_basics::<Fake>))
            .with_state(Installer {
                authoriser: direct(tailnet(vec![(address(9), caller(ME, &[]))])),
                fleet: fleet.clone(),
                running: running.clone(),
            });
        // Percent-encoded where a path cannot carry the byte: a space, a newline.
        for hostile in [
            "-oProxyCommand=id",
            "a%20b",
            "pi%0Aid",
            "pi;id",
            "user@pi",
            "%2A",
        ] {
            let mut request = Request::post(format!("/machines/{hostile}/install"))
                .body(Body::empty())
                .expect("a request with no body");
            request
                .extensions_mut()
                .insert(ConnectInfo(SocketAddr::from(([100, 64, 0, 9], 61620))));
            let answered = app
                .clone()
                .oneshot(request)
                .await
                .expect("the router is infallible");
            assert_eq!(answered.status(), StatusCode::BAD_REQUEST, "{hostile}");
        }
        assert!(
            running.lock().expect("unpoisoned").is_empty(),
            "nothing was claimed"
        );
        assert!(fleet.events.read().await.is_empty(), "nothing ran");
    }

    /// The lock an install holds is given back when its task ends, and on a
    /// panic too, so a machine is never left refusing installs for good.
    #[tokio::test]
    #[allow(clippy::panic)]
    async fn a_claim_is_given_back_on_every_path() {
        let running = Running::default();
        let claim = Claim::take(&running, "pi").expect("free");
        assert!(
            Claim::take(&running, "Pi").is_none(),
            "one machine, whatever its case"
        );
        drop(claim);

        let held = Claim::take(&running, "pi").expect("given back after a run");
        let panicked = tokio::spawn(async move {
            let _held = held;
            panic!("an install that panics");
        })
        .await;
        assert!(panicked.is_err());
        assert!(
            Claim::take(&running, "pi").is_some(),
            "given back after a panic"
        );
    }

    /// Y-386: the install route is behind the gate like every write, and a
    /// machine whose install still runs is a 409 before anything is spawned.
    #[tokio::test]
    async fn an_install_is_authorised_and_runs_once_per_machine() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt as _;

        let request = || {
            let mut request = Request::post("/machines/pi/install")
                .body(Body::empty())
                .expect("a request with no body");
            request
                .extensions_mut()
                .insert(ConnectInfo(SocketAddr::from(([100, 64, 0, 9], 61620))));
            request
        };

        let fleet = Fleet::default();
        let refused = router::<Fake, ()>(direct(tailnet(vec![])), fleet.clone())
            .oneshot(request())
            .await
            .expect("the router is infallible");
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);

        let running = Running::default();
        // Another case of the same name: ssh would reach one machine.
        let _held = Claim::take(&running, "PI").expect("nothing holds it yet");
        let busy = Router::new()
            .route("/machines/{machine}/install", post(put_basics::<Fake>))
            .with_state(Installer {
                authoriser: direct(tailnet(vec![(address(9), caller(ME, &[]))])),
                fleet: fleet.clone(),
                running,
            })
            .oneshot(request())
            .await
            .expect("the router is infallible");
        assert_eq!(busy.status(), StatusCode::CONFLICT);
        assert!(
            fleet.events.read().await.is_empty(),
            "nothing ran, so nothing is remembered"
        );
    }

    /// Both halves of the grant are behind the gate and refuse before anything
    /// is asked of GitHub or written: this tailnet holds nobody. The `DELETE`
    /// shares its path with `api.rs`'s `GET`, so the 403 also says the merge
    /// kept both methods. The client id's own `POST`/`DELETE` share that gate
    /// too (Y-393) — refused before `/etc/yantra/daemon.env` is opened.
    #[tokio::test]
    async fn signing_in_and_out_are_authorised_before_anything_happens() {
        use axum::body::Body;
        use axum::http::{Request, header};
        use tower::ServiceExt as _;

        let fleet = Fleet::default();
        let app = crate::api::router()
            .with_state(fleet.clone())
            .merge(router(direct(tailnet(vec![])), fleet.clone()));

        for request in [
            Request::post("/github/login").body(Body::empty()),
            Request::delete("/github").body(Body::empty()),
            Request::post("/github/client-id")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"id":"Iv1.abc"}"#)),
            Request::delete("/github/client-id").body(Body::empty()),
        ] {
            let mut request = request.expect("a request with no body");
            request
                .extensions_mut()
                .insert(ConnectInfo(SocketAddr::from(([100, 64, 0, 9], 61620))));
            let answered = app
                .clone()
                .oneshot(request)
                .await
                .expect("the router is infallible");
            assert_eq!(answered.status(), StatusCode::FORBIDDEN);
        }
        assert!(
            !fleet.github.read().await.pending,
            "a refused caller starts no flow"
        );
    }

    /// The code a page draws, and never the one the poll presents.
    #[test]
    fn the_device_answer_carries_no_device_code() {
        let device: github::Device = serde_json::from_str(
            r#"{"device_code":"3584d83530557fdd1f46af8289938c8ef79f9dc5","user_code":"WDJB-MJHT","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#,
        )
        .expect("GitHub's own example parses");

        let json = serde_json::to_value(Device::of(&device)).expect("a DTO");

        assert_eq!(
            json,
            serde_json::json!({
                "user_code": "WDJB-MJHT",
                "verification_uri": "https://github.com/login/device",
                "expires_in": 900,
                "interval": 5
            })
        );
    }

    /// A token nobody meant to send is worse here than anywhere: it would be
    /// written to disk. So the body denies what it does not name, and an open
    /// topic is an absent field rather than an empty string.
    #[test]
    fn the_relay_body_takes_a_topic_with_or_without_a_token_and_refuses_a_typo() {
        let open: Publish =
            serde_json::from_str(r#"{"url":"https://ntfy.sh/a-topic"}"#).expect("an open topic");
        assert!(open.token.is_none());

        let protected: Publish =
            serde_json::from_str(r#"{"url":"https://ntfy.sh/a-topic","token":"tk_x"}"#)
                .expect("a protected topic");
        assert_eq!(protected.token.as_deref(), Some("tk_x"));

        serde_json::from_str::<Publish>(r#"{"url":"https://ntfy.sh/a","tokken":"tk_x"}"#)
            .expect_err("a typo is refused");
    }

    /// The client id's body denies what it does not name, same as the relay's.
    #[test]
    fn the_client_id_body_takes_one_field_and_refuses_a_typo() {
        let sent: ClientId = serde_json::from_str(r#"{"id":"Iv1.abc"}"#).expect("an id");
        assert_eq!(sent.id, "Iv1.abc");

        serde_json::from_str::<ClientId>(r#"{"idd":"Iv1.abc"}"#).expect_err("a typo is refused");
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
            .merge(router(direct(tailnet(vec![])), Fleet::default()));

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

    /// **The refusal that proves both new routes are gated**, and it proves it
    /// twice over: a 403 is also the only outcome that could arrive quickly,
    /// since a handler reached without one would ssh to `pi` and wait out
    /// `ConnectTimeout`. `GET /machines/{name}/readiness` answers beside the
    /// `POST` on the same path, which is the merge worth asserting: axum joins
    /// the method routers, and matchit would panic on a second spelling of the
    /// segment.
    #[tokio::test]
    async fn asking_a_machine_and_reading_a_spend_are_authorised_like_every_other_write() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt as _;

        let app = crate::api::router()
            .with_state(Fleet::default())
            .merge(router(direct(tailnet(vec![])), Fleet::default()));

        for path in [
            "/machines/pi/readiness",
            "/machines/pi/dirs",
            "/workspaces/site/tokens",
            "/workspaces/site/logs",
        ] {
            let mut asked = Request::post(path).body(Body::empty()).expect("a POST");
            asked
                .extensions_mut()
                .insert(ConnectInfo(SocketAddr::from(([100, 64, 0, 9], 61620))));

            let refused = app
                .clone()
                .oneshot(asked)
                .await
                .expect("the router is infallible");
            assert_eq!(
                refused.status(),
                StatusCode::FORBIDDEN,
                "{path} reached authorisation rather than a 405, and this tailnet holds nobody"
            );
        }

        let swept = app
            .oneshot(
                Request::get("/machines/pi/readiness")
                    .body(Body::empty())
                    .expect("a GET"),
            )
            .await
            .expect("the router is infallible");
        assert_eq!(
            swept.status(),
            StatusCode::OK,
            "the sweep's own answer still reaches the same path"
        );
    }

    /// An authorised caller and a body the verb refuses: every refusal here is
    /// a `400` that arrives before any machine is asked, which is also the
    /// only way the test can end — a body that passed would ssh to `pi` and
    /// wait out `ConnectTimeout`.
    async fn refused_body(path: &str, body: serde_json::Value) -> (StatusCode, String) {
        use axum::body::Body;
        use axum::http::{Request, header};
        use tower::ServiceExt as _;

        let fake = tailnet(vec![(address(2), caller(ME, &[]))]);
        let app: Router<()> = router(direct(fake), Fleet::default());
        let mut asked = Request::post(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .expect("a POST");
        asked
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::new(address(2), 61620)));
        let response = app.oneshot(asked).await.expect("the router is infallible");
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("the body is in memory");
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    /// Y-344, I-24: a URL that is not one of git's three spellings, one that
    /// carries a credential, and a destination that is relative, climbs or
    /// holds a shell character are each refused by name before ssh.
    #[tokio::test]
    async fn a_clone_refuses_a_bad_url_or_destination_before_any_machine_is_asked() {
        for (url, path, about) in [
            ("github.com/o/r", "/srv/r", "clone URL"),
            ("http://github.com/o/r", "/srv/r", "clone URL"),
            ("file:///etc", "/srv/r", "clone URL"),
            ("https://user:token@github.com/o/r", "/srv/r", "clone URL"),
            ("https://github.com/o/r; id", "/srv/r", "clone URL"),
            ("--upload-pack=id@host:o/r", "/srv/r", "clone URL"),
            ("https://github.com/o/r", "srv/r", "destination"),
            ("https://github.com/o/r", "/srv/../etc/r", "destination"),
            ("https://github.com/o/r", "~/x;id", "destination"),
            ("https://github.com/o/r", "/srv/$HOME", "destination"),
            ("https://github.com/o/r", "", "destination"),
        ] {
            let (status, said) = refused_body(
                "/machines/pi/clone",
                serde_json::json!({"url": url, "path": path}),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{url} {path}: {said}");
            assert!(said.contains(about), "{url} {path}: {said}");
        }

        let (status, _) = refused_body(
            "/machines/pi/clone",
            serde_json::json!({"url": "https://github.com/o/r", "path": "/srv/r", "token": "x"}),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "no field carries a token"
        );
    }

    /// Y-344: `make` is one segment or a `400`, and a directory the machine
    /// would not make is the same `409` as a path that is not there.
    #[tokio::test]
    async fn a_directory_name_that_is_not_one_segment_is_refused_before_ssh() {
        for name in [
            "", ".", "..", ".hidden", "a/b", "/abs", "a b", "a;b", "$HOME", "-x",
        ] {
            let (status, said) = refused_body(
                "/machines/pi/dirs",
                serde_json::json!({"path": "/home/u", "make": name}),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{name:?}: {said}");
            assert!(said.contains("directory name"), "{name:?}: {said}");
        }

        let not_made = dirs::Error::NotMade {
            machine: "pi".to_owned(),
            path: "/home/u/new".to_owned(),
            reason: "mkdir: can't create directory '/home/u/new': File exists".to_owned(),
        };
        let (status, said) = answered(from_dirs(&not_made), &not_made).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(said.contains("File exists"), "{said}");
    }

    /// The clone route is gated like every other write, and the mapper sends
    /// each of the library's answers where the verbs beside it send theirs.
    #[tokio::test]
    async fn a_clone_is_authorised_and_fails_the_way_the_verbs_beside_it_do() {
        use axum::body::Body;
        use axum::http::{Request, header};
        use tower::ServiceExt as _;

        let app: Router<()> = router(direct(tailnet(vec![])), Fleet::default());
        let mut asked = Request::post("/machines/pi/clone")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"url":"https://github.com/o/r","path":"/srv/r"}"#,
            ))
            .expect("a POST");
        asked
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::new(address(9), 61620)));
        let refused = app.oneshot(asked).await.expect("the router is infallible");
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);

        let asleep = clone::Error::Ssh(yantra_core::ssh::Error::Transport {
            host: "pi".to_string(),
            diagnosis: "connect to host pi port 22: Connection refused".to_string(),
        });
        let (status, said) = answered(from_clone(&asleep), &asleep).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(said.contains("Connection refused"), "{said}");
        assert_eq!(
            from_clone(&clone::Error::NoLoginServer {
                machine: "mac".to_owned()
            }),
            StatusCode::CONFLICT
        );
        assert_eq!(
            from_clone(&clone::Error::NoStateDir),
            StatusCode::INTERNAL_SERVER_ERROR
        );

        let answered = serde_json::to_value(Cloning {
            machine: "pi".to_owned(),
            session: "clone-r".to_owned(),
        })
        .expect("a DTO");
        assert_eq!(
            answered,
            serde_json::json!({"machine": "pi", "session": "clone-r"})
        );
    }

    /// A workspace that is not there is the caller's mistake; a transcript that
    /// is not there yet is the world's answer and a person's first message
    /// changes it; a machine that could not be asked decided nothing.
    #[tokio::test]
    async fn a_spend_fails_the_way_the_verbs_beside_it_do() {
        assert_eq!(
            from_logs(&logs::Error::Workspace(workspace::Error::NotFound {
                name: "nosuch".to_string(),
                path: "/nowhere".into(),
            })),
            StatusCode::NOT_FOUND
        );

        let waiting = logs::Error::NoTurnYet {
            repo: "/home/<user>/Github/site".to_string(),
            session: "1f0c1a2e".to_string(),
        };
        let (status, said) = answered(from_logs(&waiting), &waiting).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(said.contains("written no turn yet"), "{said}");

        let asleep = logs::Error::Ssh(yantra_core::ssh::Error::Transport {
            host: "pi".to_string(),
            diagnosis: "connect to host pi port 22: Connection refused".to_string(),
        });
        let (status, said) = answered(from_logs(&asleep), &asleep).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(said.contains("Connection refused"), "{said}");

        assert_eq!(
            from_logs(&logs::Error::Unreadable),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            from_logs(&logs::Error::NoStateDir),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    /// **The row's real content is the 503**, so it is asserted whole rather
    /// than by a substring: a machine that could not be asked must reach the
    /// page naming the machine, the command it never reported on, and what ssh
    /// itself said. A body that says *error* tells a reader nothing to act on.
    ///
    /// The two 409s beside it are the states D5 §4.5 draws as sentences rather
    /// than as failures, and each carries the library's own words.
    #[tokio::test]
    async fn a_transcript_read_says_which_machine_could_not_be_asked() {
        let absent = logs::Error::NoTranscript {
            repo: "/home/<user>/Github/site".to_owned(),
        };
        let (status, said) = answered(from_logs(&absent), &absent).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(said.contains("no agent transcript"), "{said}");

        let turnless = logs::Error::NoTurnYet {
            repo: "/home/<user>/Github/site".to_owned(),
            session: "1f0c1a2e".to_owned(),
        };
        let (status, said) = answered(from_logs(&turnless), &turnless).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(said.contains("session 1f0c1a2e"), "{said}");

        let asleep = logs::Error::Ssh(yantra_core::ssh::Error::Transport {
            host: "bishwajeets-macbook-pro".to_owned(),
            diagnosis: "ssh: connect to host bishwajeets-macbook-pro port 22: No route to host"
                .to_owned(),
        });
        let (status, said) = answered(from_logs(&asleep), &asleep).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            said,
            "ssh to bishwajeets-macbook-pro failed before the command reported a status: \
             ssh: connect to host bishwajeets-macbook-pro port 22: No route to host"
        );
    }

    /// Landing on the transcript tab sends no body, and that is the first
    /// window rather than a 400. A typo is refused, because a `lines` the
    /// daemon silently ignored would draw the wrong window with no way to tell.
    #[test]
    fn a_transcript_read_with_no_body_asks_for_the_first_window() {
        let landed = Window::default();
        assert_eq!(landed.lines, 50);
        assert_eq!(landed.before, 0);

        let older: Window =
            serde_json::from_str(r#"{"before":50}"#).expect("Older names only what it moves");
        assert_eq!(older.lines, 50);
        assert_eq!(older.before, 50);

        serde_json::from_str::<Window>(r#"{"lnies":50}"#).expect_err("a typo is refused");
    }

    /// `you` and `claude` are the CLI's words and the browser reads the same
    /// two. The nulls are the half worth pinning: a record with no stamp, and a
    /// call whose input names none of the eight keys.
    #[test]
    fn the_projection_names_who_spoke_in_the_words_the_terminal_uses() {
        let json = serde_json::to_value(Transcript::of(&conversation()))
            .expect("a DTO of owned strings and numbers");

        assert_eq!(json["total"], 1944, "records, and never turns");
        assert_eq!(json["turns"][0]["who"], "you");
        assert_eq!(json["turns"][1]["who"], "claude");
        assert!(
            json["turns"][1]["at"].is_null(),
            "a record with no stamp draws no time"
        );
        assert_eq!(
            json["turns"][1]["tools"][0]["target"],
            "cargo nextest run --workspace"
        );
        assert!(
            json["turns"][1]["tools"][1]["target"].is_null(),
            "a call with no target renders as its name alone"
        );
        assert!(
            !json.to_string().contains("toolUseResult"),
            "the results are the bulk of the file and never cross the wire (I-46)"
        );
    }

    /// D4 §3: the daemon composes no path, so a body that names none is how a
    /// caller asks for the machine's own `$HOME` — and a typo is refused rather
    /// than silently listing somewhere else.
    #[test]
    fn a_listing_may_name_no_path_at_all() {
        let home: Walked = serde_json::from_str("{}").expect("an empty body is $HOME");
        assert!(home.path.is_none());

        let named: Walked = serde_json::from_str(r#"{"path":"/code"}"#).expect("a path");
        assert_eq!(named.path.as_deref(), Some("/code"));

        serde_json::from_str::<Walked>(r#"{"paht":"/code"}"#).expect_err("a typo is refused");
    }

    /// **A path that is not there and an empty directory are different
    /// answers**, and the browser must be able to tell them apart: one is a
    /// refusal a `mkdir` changes, and the other is a `200` with no entries.
    /// A machine that could not be asked is neither (R-23).
    #[tokio::test]
    async fn a_listing_that_found_nothing_there_is_not_a_listing_of_nothing() {
        let missing = dirs::Error::NotADirectory {
            machine: "cachyos-g14".to_string(),
            path: "/home/<user>/typo".to_string(),
        };
        let (status, said) = answered(from_dirs(&missing), &missing).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(said.contains("cachyos-g14"), "{said}");
        assert!(said.contains("/home/<user>/typo"), "{said}");

        let asleep = dirs::Error::Ssh(yantra_core::ssh::Error::Transport {
            host: "pi".to_string(),
            diagnosis: "connect to host pi port 22: Connection refused".to_string(),
        });
        let (status, said) = answered(from_dirs(&asleep), &asleep).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(said.contains("Connection refused"), "{said}");

        assert_eq!(
            from_dirs(&dirs::Error::Unreadable {
                machine: "pi".to_string()
            }),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            from_dirs(&dirs::Error::NoStateDir),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    /// A listing carries paths and git origins and nothing else (§B4), and the
    /// `null` origin is the one the picker has to draw for two different
    /// reasons.
    #[test]
    fn a_listing_puts_paths_and_origins_on_the_wire_and_nothing_else() {
        let answered = serde_json::to_value(Listing::from(dirs::Listing {
            machine: "cachyos-g14".to_owned(),
            path: "/home/<user>".to_owned(),
            entries: vec![dirs::Dir {
                path: "/home/<user>/scratch".to_owned(),
                name: "scratch".to_owned(),
                repo: false,
                origin: None,
            }],
        }))
        .expect("a DTO of owned strings and booleans");

        assert_eq!(
            answered,
            serde_json::json!({
                "machine": "cachyos-g14",
                "path": "/home/<user>",
                "entries": [{
                    "path": "/home/<user>/scratch",
                    "name": "scratch",
                    "repo": false,
                    "origin": null,
                }],
            })
        );
    }

    /// The property Y-181 was built for, asserted on the shape rather than on a
    /// promise: every key the browser can read is a name, a number or a date,
    /// so there is nowhere for a conversation to arrive. Serialised keys come
    /// back sorted, which is why these lists are.
    #[test]
    fn a_spend_puts_counts_and_dollars_on_the_wire_and_nothing_else() {
        let answered = serde_json::to_value(Spend::of(&transcript(0))).expect("a DTO of numbers");
        let keys = |value: &serde_json::Value| {
            value
                .as_object()
                .expect("an object")
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        };

        assert_eq!(
            keys(&answered),
            ["as_of", "cost", "fast", "models", "path", "total"]
        );
        assert_eq!(
            keys(&answered["total"]),
            ["cache_read", "cache_write", "input", "output", "responses"]
        );
        assert_eq!(keys(&answered["models"][0]), ["cost", "model", "responses"]);
    }

    /// **The three the price table refuses to price**, each a different thing
    /// from free, and the date that says when the table was true. Losing any of
    /// them would make the dashboard claim what the terminal declines to.
    #[test]
    fn an_unpriced_model_a_fast_session_and_an_idle_one_are_each_not_free() {
        let priced = Spend::of(&transcript(0));
        let opus = &priced.models[0];
        let unknown = &priced.models[1];
        assert_eq!(opus.model, "claude-opus-5-20260115");
        assert!(opus.cost.is_some(), "the table carries opus 5");
        assert_eq!(
            unknown.cost, None,
            "a model the table does not carry is unpriced, not free"
        );
        assert_eq!(
            priced.cost, opus.cost,
            "the total is what was priced, and the unpriced model's tokens are in nobody's figure"
        );
        assert_eq!(priced.as_of, price::AS_OF);
        assert_eq!(
            priced.total.responses, 68,
            "tokens add across models even though dollars do not"
        );

        let fast = Spend::of(&transcript(3));
        assert_eq!(fast.fast, 3);
        assert_eq!(fast.cost, None, "fast mode is billed at a rate not carried");
        assert!(
            fast.models.iter().all(|model| model.cost.is_none()),
            "and not per model either"
        );
        assert_eq!(
            fast.total.input, priced.total.input,
            "the tokens are still reported"
        );

        // Y-199: `.sum()` over an empty list is `0.0`, so a session the table
        // priced none of published `$0.00` — the exact thing every line above
        // is written to prevent, one layer further in.
        let nothing_priced = Spend::of(&tokens::Spend {
            path: "/home/<user>/.claude/projects/site/1f0c1a2e.jsonl".to_string(),
            by_model: [(
                "claude-opus-9".to_owned(),
                tokens::Counts {
                    responses: 2,
                    output: 1_000_000,
                    ..tokens::Counts::default()
                },
            )]
            .into_iter()
            .collect(),
            fast: 0,
        });
        assert_eq!(
            nothing_priced.cost, None,
            "no model was priced, so there is no figure — and never $0.00"
        );
        assert_eq!(nothing_priced.total.responses, 2, "the tokens still report");

        let idle = Spend::of(&tokens::Spend {
            path: "/home/<user>/.claude/projects/site/1f0c1a2e.jsonl".to_string(),
            ..tokens::Spend::default()
        });
        assert_eq!(idle.total.responses, 0);
        assert_eq!(
            idle.cost, None,
            "a session that has spent nothing has no figure, which is not $0.00"
        );
    }

    const JOINING: &str = "nJOIN0000000CNTRL";

    fn join_scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yantra-write-join-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn join_fleet(dir: &std::path::Path) -> Fleet {
        Fleet {
            facts: Arc::new(crate::heartbeat::Facts {
                started: std::time::Instant::now(),
                listening_on: vec![SocketAddr::new(address(1), 7717)],
                ssh_dir: dir.to_owned(),
                relay: false,
            }),
            ..Fleet::default()
        }
    }

    /// `address(7)` is the owner's node the tailnet calls `joining-box`, and
    /// `address(8)` is a node that belongs to somebody else.
    fn joining_tailnet() -> Fake {
        Fake {
            machines: vec![yantra_core::inventory::MachineInfo {
                id: JOINING.to_owned(),
                name: "joining-box".to_owned(),
                dns_name: "joining-box.example.ts.net.".to_owned(),
                os: yantra_core::inventory::Os::Linux,
                online: true,
                last_seen: None,
                expired: false,
                addresses: vec![address(7)],
            }],
            addresses: vec![address(1)],
            callers: [
                (
                    address(7),
                    Caller {
                        node: JOINING.to_owned(),
                        user: ME,
                        tags: Vec::new(),
                    },
                ),
                (address(8), caller(ME + 1, &[])),
            ]
            .into_iter()
            .collect(),
            owner: ME,
        }
    }

    async fn join_send(
        router: Router,
        method: &str,
        path: &str,
        from: IpAddr,
        body: &str,
    ) -> (StatusCode, String, String) {
        use tower::ServiceExt as _;
        let request = axum::http::Request::builder()
            .method(method)
            .uri(path)
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .extension(ConnectInfo(SocketAddr::new(from, 50_000)))
            .body(axum::body::Body::from(body.to_owned()))
            .expect("a request");
        let response = router.oneshot(request).await.expect("infallible");
        let status = response.status();
        let kind = response
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("a body");
        (status, kind, String::from_utf8_lossy(&body).into_owned())
    }

    fn joins(fleet: &Fleet) -> Router {
        router::<Fake, ()>(direct(joining_tailnet()), fleet.clone())
    }

    /// Y-387's row, in one request: the body carries the account, the tailnet
    /// supplies the machine, and the block carries both.
    #[tokio::test]
    async fn a_machine_joins_itself_under_the_name_the_tailnet_gives_it() {
        let dir = join_scratch("itself");
        let fleet = join_fleet(&dir);

        let (status, _, body) = join_send(
            joins(&fleet),
            "POST",
            "/join",
            address(7),
            r#"{"user":"biswa"}"#,
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).expect("JSON"),
            serde_json::json!({
                "machine": "joining-box",
                "user": "biswa",
                "kept": false,
                "logs_in_as": "biswa"
            })
        );
        let config = std::fs::read_to_string(dir.join("config")).expect("written");
        assert!(
            config.starts_with("Host joining-box\n    User biswa\n    IdentityFile "),
            "{config}"
        );
        let events = events::newest_first(&fleet.events).await;
        assert!(
            events
                .iter()
                .any(|event| event.kind == "joined"
                    && event.machine.as_deref() == Some("joining-box")),
            "{events:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ADR-0016 §2 again: a body that names a machine could name someone
    /// else's, so the field does not exist and sending it is refused.
    #[tokio::test]
    async fn a_body_that_names_a_machine_is_refused_and_nothing_is_written() {
        let dir = join_scratch("named");
        let fleet = join_fleet(&dir);

        let (status, _, body) = join_send(
            joins(&fleet),
            "POST",
            "/join",
            address(7),
            r#"{"user":"biswa","machine":"someone-elses-box"}"#,
        )
        .await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert!(!dir.exists(), "refused before anything was written");
    }

    #[tokio::test]
    async fn an_account_that_would_write_its_own_config_lines_is_refused() {
        let dir = join_scratch("hostile");
        let fleet = join_fleet(&dir);

        let (status, _, body) = join_send(
            joins(&fleet),
            "POST",
            "/join",
            address(7),
            r#"{"user":"biswa\nHost *\n    ProxyCommand touch /tmp/pwned"}"#,
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(!dir.exists(), "refused before anything was written");
        assert!(events::newest_first(&fleet.events).await.is_empty());
    }

    #[tokio::test]
    async fn a_node_that_is_not_the_owners_cannot_join_or_fetch_the_script() {
        let dir = join_scratch("stranger");
        let fleet = join_fleet(&dir);

        let (status, _, _) = join_send(
            joins(&fleet),
            "POST",
            "/join",
            address(8),
            r#"{"user":"biswa"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let script = script::<Fake, ()>(direct(joining_tailnet()), fleet.clone());
        let (status, _, _) = join_send(script, "GET", "/join", address(8), "").await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!dir.exists(), "a refused caller made no key");
    }

    /// The owner's ruling that the key is made on first use: the first `GET`
    /// makes it, and the script carries its public half and this daemon's
    /// own address.
    #[tokio::test]
    async fn the_script_makes_the_key_and_names_this_daemon() {
        let dir = join_scratch("script");
        let fleet = join_fleet(&dir);

        let script = script::<Fake, ()>(direct(joining_tailnet()), fleet.clone());
        let (status, kind, body) = join_send(script, "GET", "/join", address(7), "").await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(kind.starts_with("text/plain"), "{kind}");
        let public = std::fs::read_to_string(dir.join("id_yantra.pub")).expect("the key was made");
        assert!(body.contains(&format!("KEY='{}'", public.trim())), "{body}");
        assert!(body.contains("DAEMON='100.64.0.1:7717'"), "{body}");
        assert!(body.starts_with("#!/bin/sh"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two first fetches at once: without the lock both can see no key and
    /// both run `ssh-keygen` on one path, or one reads a `.pub` not yet there.
    #[tokio::test]
    async fn two_first_fetches_at_once_make_one_key() {
        let dir = join_scratch("race");
        let fleet = join_fleet(&dir);
        let script = script::<Fake, ()>(direct(joining_tailnet()), fleet.clone());

        let (first, second) = tokio::join!(
            join_send(script.clone(), "GET", "/join", address(7), ""),
            join_send(script, "GET", "/join", address(7), ""),
        );

        assert_eq!(first.0, StatusCode::OK, "{}", first.2);
        assert_eq!(second.0, StatusCode::OK, "{}", second.2);
        let public = std::fs::read_to_string(dir.join("id_yantra.pub")).expect("one key");
        let carried = format!("KEY='{}'", public.trim());
        assert!(first.2.contains(&carried) && second.2.contains(&carried));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// I-5: an address can move between nodes, so the name is the node whose
    /// id `whois` answered — never the first node listed at that address.
    #[tokio::test]
    async fn the_machine_is_found_by_its_node_id_and_never_by_its_address() {
        let dir = join_scratch("impostor");
        let fleet = join_fleet(&dir);
        let mut tailnet = joining_tailnet();
        tailnet.machines.insert(
            0,
            yantra_core::inventory::MachineInfo {
                id: "nIMPOSTOR000CNTRL".to_owned(),
                name: "impostor-box".to_owned(),
                dns_name: "impostor-box.example.ts.net.".to_owned(),
                os: yantra_core::inventory::Os::Linux,
                online: false,
                last_seen: None,
                expired: false,
                addresses: vec![address(7)],
            },
        );

        let (status, _, body) = join_send(
            router::<Fake, ()>(direct(tailnet), fleet.clone()),
            "POST",
            "/join",
            address(7),
            r#"{"user":"biswa"}"#,
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains(r#""machine":"joining-box""#), "{body}");
        let config = std::fs::read_to_string(dir.join("config")).expect("written");
        assert!(!config.contains("impostor-box"), "{config}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The owner's ruling, 2026-09-12: a re-join that keeps a block logging in
    /// as another account says so, in the reply and in the event, and the
    /// block is not rewritten (ADR-0009).
    #[tokio::test]
    async fn a_rejoin_says_which_account_the_kept_block_logs_in_as() {
        let dir = join_scratch("kept");
        std::fs::create_dir_all(&dir).expect("scratch");
        let owners = "Host joining-box\n    User someone-else\n";
        std::fs::write(dir.join("config"), owners).expect("an owner's block");
        let fleet = join_fleet(&dir);

        let (status, _, body) = join_send(
            joins(&fleet),
            "POST",
            "/join",
            address(7),
            r#"{"user":"biswa"}"#,
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).expect("JSON"),
            serde_json::json!({
                "machine": "joining-box",
                "user": "biswa",
                "kept": true,
                "logs_in_as": "someone-else"
            })
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("config")).expect("readable"),
            owners
        );
        let events = events::newest_first(&fleet.events).await;
        assert!(
            events
                .iter()
                .any(|event| event.kind == "joined" && event.said.contains("as someone-else")),
            "{events:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
