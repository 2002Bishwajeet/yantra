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
use yantra_core::inventory::{self, Caller, Inventory};
use yantra_core::notify;
use yantra_core::{
    agent, doctor, down, edit, logs, price, probe, remove, resume, sessions, status, terminfo,
    tmux, tokens, up, workspace,
};

use crate::api::Answer;
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
        .route("/relay", post(relay::<I>))
        .with_state(authoriser.clone());

    // `{name}` rather than `{machine}`, which the routes above prefer: the `GET`
    // on this path spells it `{name}`, and two spellings of one route are a
    // matchit conflict rather than two routes (measured — it panics at startup).
    let remembered: Router<S> = Router::new()
        .route("/machines/{name}/readiness", post(recheck::<I>))
        .route("/viewing", post(viewing::<I>))
        .with_state(Remembered { authoriser, fleet });

    acts.merge(remembered)
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

/// `yantra doctor <machine>`, asked now rather than read off the sweep.
///
/// **A read reached over a `POST`, for [`ask`]'s reason** ([ADR-0019]): the
/// `GET` beside it serves a reading up to 30 s old, and someone who has just
/// installed `tmux` by hand needs to know it took before the next sweep. A
/// person taps it and nothing polls it, which is both halves of the ADR's test.
///
/// **It costs an ssh round trip, and an asleep machine costs all ten seconds of
/// `ConnectTimeout` before it answers.** What it answers then is nine
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

async fn relay<I: Inventory + Clone + Send + Sync + 'static>(
    State(authoriser): State<Authoriser<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(publish): Json<Publish>,
) -> Result<StatusCode, Refused> {
    let caller = allowed(&authoriser, from.ip(), &headers).await?;
    tracing::info!("relay written for {}", caller.node);

    let file = std::path::Path::new(notify::RELAY_FILE);
    notify::write_to(file, &publish.url, publish.token.as_deref()).map_err(|error| {
        Refused::Verb {
            status: match error {
                notify::NotWritten::Write { .. } => StatusCode::INTERNAL_SERVER_ERROR,
                _ => StatusCode::BAD_REQUEST,
            },
            said: chain(&error),
        }
    })?;

    let relay = notify::Relay::new(publish.url, publish.token);
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
    ]
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

        for path in ["/machines/pi/readiness", "/workspaces/site/tokens"] {
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
}
