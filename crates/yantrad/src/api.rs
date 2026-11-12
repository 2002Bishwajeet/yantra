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
//! local and persistent — `tailscale` missing, no config directory — so a
//! retained stale reading would hide a fault the operator has to fix, and go on
//! hiding it. The transient cases stay inside a successful reading rather than
//! being lost: a *machine* that did not answer (Y-054), and a workspace *file*
//! that did not load (Y-141).
//!
//! DTOs live here rather than as `Serialize` on `yantra_core`'s types: a JSON
//! body is rendering, and ADR-0005 put rendering in the caller. **`doctor` is
//! the exception**, for `Power`'s reason one route over: its check names and
//! three states are the JSON contract D2.2 already publishes to an installer and
//! an agent, so a DTO here would be a second spelling of a settled one.

use axum::Router;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::get;
use axum::{Json, response::IntoResponse};
use std::collections::BTreeMap;
use std::net::SocketAddr;
use yantra_core::heartbeat::{Heartbeat, Power};
use yantra_core::inventory::{MachineInfo, Os};
use yantra_core::snapshot::{Reading, Snapshot};
use yantra_core::status::{MachineStatus, Verdict};
use yantra_core::{about, doctor, github, identity, update};

use crate::events::{self, Event};
use crate::github::Grant;
use crate::heartbeat::{Beats, Fleet};
use crate::refresh::Model;

/// `get` only, and no route takes a body. M4 is a dashboard that reads; a
/// button that opens a session is the point at which Q6's missing auth
/// stops being free (R-22).
pub fn router() -> Router<Fleet> {
    Router::new()
        .route("/machines", get(machines))
        .route("/workspaces", get(workspaces))
        .route("/sessions", get(sessions))
        .route("/workspaces/{name}/status", get(workspace_status))
        .route("/readiness", get(readiness))
        .route("/machines/{name}/readiness", get(machine_readiness))
        .route("/attention", get(attention))
        .route("/readiness/github", get(github))
        .route("/readiness/proxy", get(proxy))
        .route("/about", get(about))
        .route("/ssh-identity", get(ssh_identity))
        .route("/notifications", get(notifications))
        .route("/pulls", get(pulls))
        .route("/github", get(connection))
        .route("/repos", get(repos))
        .route("/repos/hidden", get(hidden))
        .fallback(no_such_route)
}

/// `yantra about` on the wire, plus what only a running daemon knows: how long
/// it has been up and where it listens. No ssh and no network — the tailnet
/// name is read off the machines look, for the node holding a bound address.
async fn about(State(fleet): State<Fleet>) -> Json<About> {
    let snapshot = fleet.model.read().await.clone();
    let dir = fleet.facts.progress.clone();
    // A local file, read off the worker (I-13). A file this build cannot read
    // costs only the progress, and the journal says why.
    let update = match tokio::task::spawn_blocking(move || update::progress(&dir)).await {
        Ok(Ok(progress)) => progress,
        Ok(Err(error)) => {
            tracing::warn!("the update's progress is unreadable: {}", because(&error));
            None
        }
        Err(_) => None,
    };
    let channel = crate::refresh::read_channel(&fleet.facts.channel).await;
    // Y-735: another channel's release is not yet looked at, never this one's.
    let release = snapshot
        .release
        .as_ref()
        .filter(|(on, _)| *on == channel.unwrap_or_default())
        .map(|(_, reading)| reading.as_ref());
    Json(About {
        version: about::VERSION,
        target: about::TARGET,
        built: about::BUILT,
        uptime_seconds: fleet.facts.started.elapsed().as_secs(),
        listening_on: fleet
            .facts
            .listening_on
            .iter()
            .map(ToString::to_string)
            .collect(),
        tailnet: tailnet(&snapshot, &fleet.facts.listening_on),
        https: https(&snapshot, &fleet.facts.listening_on),
        relay: fleet.facts.relay,
        published: Answer::of(release, Published::of),
        channel,
        update,
    })
}

/// The tailnet is `DNSName` past this node's own label.
fn tailnet(snapshot: &Snapshot, listening_on: &[SocketAddr]) -> Option<String> {
    let (_, tailnet) = this_node_name(snapshot, listening_on)?.split_once('.')?;
    Some(tailnet.to_owned())
}

/// The port `tailscale serve` terminates TLS on; install.sh and `just https`
/// set it up, and the daemon cannot see whether they did (Y-652).
pub(crate) const HTTPS_PORT: u16 = 8443;

/// Where the microphone works: a browser needs a secure context (ADR-0031 §4).
fn https(snapshot: &Snapshot, listening_on: &[SocketAddr]) -> Option<String> {
    https_of(
        snapshot.machines.as_deref()?.value().as_ref().ok()?,
        listening_on,
    )
}

/// The dashboard's HTTPS origin, which a chat push links to (Y-669).
pub(crate) fn https_of(
    machines: &[yantra_core::inventory::MachineInfo],
    listening_on: &[SocketAddr],
) -> Option<String> {
    let name = node_name(machines, listening_on)?;
    Some(format!("https://{name}:{HTTPS_PORT}"))
}

pub(crate) fn this_node_name<'a>(
    snapshot: &'a Snapshot,
    listening_on: &[SocketAddr],
) -> Option<&'a str> {
    node_name(
        snapshot.machines.as_deref()?.value().as_ref().ok()?,
        listening_on,
    )
}

/// This node's `DNSName` without the trailing dot.
fn node_name<'a>(
    machines: &'a [yantra_core::inventory::MachineInfo],
    listening_on: &[SocketAddr],
) -> Option<&'a str> {
    let me = machines
        .iter()
        .find(|machine| is_this_node(machine, listening_on))?;
    Some(me.dns_name.trim_end_matches('.'))
}

/// Which node is this one is answered by the addresses `listen_on` bound — the
/// same join the heartbeat makes, in the other direction.
fn is_this_node(
    machine: &yantra_core::inventory::MachineInfo,
    listening_on: &[SocketAddr],
) -> bool {
    machine.addresses.iter().any(|held| {
        listening_on
            .iter()
            .any(|bound| bound.ip().to_canonical() == held.to_canonical())
    })
}

/// `yantra ssh-identity`'s read half. **A 404 and never a key**: a route a
/// browser polls must not make one. `GET /join` and the CLI verb do, on first
/// use (ADR-0029). The private half is not read.
async fn ssh_identity(State(fleet): State<Fleet>) -> Response {
    let dir = fleet.facts.ssh_dir.clone();
    // `ssh-keygen -l` is a subprocess, so off the worker (I-13).
    let described = tokio::task::spawn_blocking(move || identity::describe_in(&dir)).await;
    match described {
        Ok(Ok(Some(identity))) => {
            Json(SshIdentity::of(&identity, &fleet.facts.listening_on)).into_response()
        }
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            Json(Missing {
                error: "no ssh identity yet — the first join makes one, and so does `yantra ssh-identity` on the daemon's machine"
                    .to_owned(),
            }),
        )
            .into_response(),
        Ok(Err(error)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(Missing {
                error: because(&error),
            }),
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(Missing {
                error: "reading the identity did not finish".to_owned(),
            }),
        )
            .into_response(),
    }
}

/// ADR-0025: the last fifty events, newest first, in the same envelope as
/// every other read. It is in memory and asked for now, so the age is 0 — and
/// an empty list after a start is the answer, not a look that never happened.
async fn notifications(State(fleet): State<Fleet>) -> Json<Answer<Vec<Event>>> {
    Json(Answer::Ok {
        age_seconds: 0,
        data: events::newest_first(&fleet.events).await,
    })
}

/// Y-512: the PRs the watch holds, as its last look left them. Memory only,
/// so no GitHub or ssh call, and the age is 0 for the reason above.
async fn pulls(State(fleet): State<Fleet>) -> Json<Answer<Vec<Pull>>> {
    let held = fleet.pulls.read().await;
    Json(Answer::Ok {
        age_seconds: 0,
        data: held
            .iter()
            .map(|((_, _, number), tracked)| Pull::of(*number, tracked))
            .collect(),
    })
}

#[derive(Debug, serde::Serialize)]
struct Pull {
    workspace: String,
    url: String,
    number: u64,
    /// `None` until the watch's first look lands.
    head_sha: Option<String>,
    summary: crate::watch::Summary,
    checks: Vec<PullCheck>,
    reviews: Vec<PullReview>,
    comments: Vec<PullComment>,
}

#[derive(Debug, serde::Serialize)]
struct PullCheck {
    name: String,
    status: String,
    conclusion: Option<String>,
    output: Option<PullCheckOutput>,
}

#[derive(Debug, serde::Serialize)]
struct PullCheckOutput {
    title: String,
    summary: String,
}

#[derive(Debug, serde::Serialize)]
struct PullReview {
    id: u64,
    author: String,
    state: String,
    body: String,
}

#[derive(Debug, serde::Serialize)]
struct PullComment {
    id: u64,
    author: String,
    path: String,
    line: Option<u64>,
    body: String,
}

impl Pull {
    fn of(number: u64, tracked: &crate::watch::Tracked) -> Self {
        Self {
            workspace: tracked.workspace.clone(),
            url: tracked.url.clone(),
            number,
            head_sha: tracked.head.as_ref().map(|head| head.head_sha.clone()),
            summary: crate::watch::summary(&tracked.checks),
            checks: tracked
                .checks
                .iter()
                .map(|check| PullCheck {
                    name: check.name.clone(),
                    status: check.status.clone(),
                    conclusion: check.conclusion.clone(),
                    output: check.output.as_ref().map(|output| PullCheckOutput {
                        title: output.title.0.clone(),
                        summary: output.summary.0.clone(),
                    }),
                })
                .collect(),
            reviews: tracked
                .reviews
                .iter()
                .map(|review| PullReview {
                    id: review.id,
                    author: review.author.clone(),
                    state: review.state.clone(),
                    body: review.body.0.clone(),
                })
                .collect(),
            comments: tracked
                .comments
                .iter()
                .map(|comment| PullComment {
                    id: comment.id,
                    author: comment.author.clone(),
                    path: comment.path.clone(),
                    line: comment.line,
                    body: comment.body.0.clone(),
                })
                .collect(),
        }
    }
}

/// The `/api` nest answers its own misses (Y-169). Without this the miss falls
/// through to the dashboard's SPA fallback and returns `200 text/html`, so a
/// route the daemon does not have reads exactly like a route it does.
async fn no_such_route() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(Missing {
            error: "this daemon serves no such route under /api".to_string(),
        }),
    )
}

/// The one route that joins two memories: the look Tailscale answered and what
/// each machine last said about itself. Both are already in memory, so the join
/// is still a read (ADR-0013 §7).
async fn machines(State(fleet): State<Fleet>) -> impl IntoResponse {
    let snapshot = fleet.model.read().await.clone();
    let beats = fleet.beats.read().await;
    Json(Answer::of(snapshot.machines.as_deref(), |machines| {
        machines
            .iter()
            .map(|machine| Machine::of(machine, &beats, &fleet.facts.listening_on))
            .collect::<Vec<_>>()
    }))
}

/// The look succeeding and a file in it being unusable are different things
/// (Y-141), so a broken `.toml` is an entry of `data` rather than the whole
/// answer becoming `looked: "failed"`.
async fn workspaces(State(model): State<Model>) -> impl IntoResponse {
    let snapshot = model.read().await.clone();
    Json(Answer::of(snapshot.workspaces.as_deref(), |listing| {
        listing
            .workspaces
            .iter()
            .map(Listed::of)
            .chain(listing.unusable.iter().map(Listed::unusable))
            .collect::<Vec<_>>()
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
    match WorkspaceStatus::find(&fleet.machines, &name) {
        Some(data) => Json(Answer::Ok { age_seconds, data }).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(Missing {
                error: absent(fleet, &name),
            }),
        )
            .into_response(),
    }
}

/// `yantra doctor` on the wire, plus the one check it cannot answer — which is
/// the whole of what this route adds over the terminal (D2 §3.1).
///
/// It serves the kept checks. A failed sweep does not hide them, because each
/// one carries its own age. With none kept, the sweep says why.
async fn readiness(State(model): State<Model>, State(beats): State<Beats>) -> impl IntoResponse {
    let snapshot = model.read().await.clone();
    let beats = beats.read().await;
    let Some(youngest) = snapshot.checks.values().map(|kept| kept.age()).min() else {
        return Json(Answer::of(snapshot.readiness.as_deref(), |_| Vec::new()));
    };
    Json(Answer::Ok {
        age_seconds: youngest.as_secs(),
        data: snapshot
            .checks
            .values()
            .map(|kept| Checked::of(kept, &snapshot, &beats))
            .collect::<Vec<_>>(),
    })
}

/// `yantra ls attention` on the wire. The reading is `refresh.rs`'s, and it is
/// polled slower than the fleet because the quota it spends is GitHub's — a
/// handler that ran `gh` would spend it once per browser instead.
async fn attention(State(model): State<Model>) -> impl IntoResponse {
    let snapshot = model.read().await.clone();
    Json(Answer::of(snapshot.attention.as_deref(), Attention::of))
}

/// The second route naming a resource, so it has [`workspace_status`]'s fourth
/// answer for the same reason: a machine no check has reached is a **404**
/// rather than a 200 whose absence a client has to notice. A kept check answers
/// whatever the last sweep did, so a poll cannot turn a result into `never`.
async fn machine_readiness(
    State(model): State<Model>,
    State(beats): State<Beats>,
    Path(name): Path<String>,
) -> Response {
    let snapshot = model.read().await.clone();
    let beats = beats.read().await;
    if let Some(kept) = snapshot.checks.get(&name) {
        return Json(Answer::Ok {
            age_seconds: kept.age().as_secs(),
            data: Checked::of(kept, &snapshot, &beats),
        })
        .into_response();
    }
    let Some(reading) = snapshot.readiness.as_deref() else {
        return Json(Answer::<Checked>::Never).into_response();
    };
    if let Err(error) = reading.value() {
        return Json(Answer::<Checked>::Failed {
            age_seconds: reading.age().as_secs(),
            error: because(error),
        })
        .into_response();
    }
    (
        StatusCode::NOT_FOUND,
        Json(Missing {
            error: format!("no check has reached a machine called `{name}`"),
        }),
    )
        .into_response()
}

/// The readiness reading about **this** machine (Y-175). The sweep above asks
/// the fleet's machines over ssh; the GitHub credential the work inbox
/// reads is the one where `yantrad` runs, because
/// [`yantra_core::attention`] spawns `gh` here. **A route rather than a tenth
/// check on every report**: a check copied onto each machine's card would claim
/// something no ssh session asked, which is the answer R-23 forbids.
///
/// There is no `failed`: the check carries a look it could not take as
/// *unknown*, so the only two answers are the reading and nobody having looked.
async fn github(State(model): State<Model>) -> impl IntoResponse {
    let snapshot = model.read().await.clone();
    host_check(snapshot.github.as_deref())
}

/// The other reading about **this** machine (Y-777): whether the proxy's admin API is closed
/// while the daemon trusts a proxy account. The same two answers as [`github`].
async fn proxy(State(model): State<Model>) -> impl IntoResponse {
    let snapshot = model.read().await.clone();
    host_check(snapshot.proxy_admin.as_deref())
}

fn host_check(reading: Option<&Reading<doctor::Check>>) -> Json<Answer<doctor::Check>> {
    Json(match reading {
        Some(reading) => Answer::Ok {
            age_seconds: reading.age().as_secs(),
            data: reading.value().clone(),
        },
        None => Answer::Never,
    })
}

/// `yantra github status` on the wire (ADR-0023). A read of what the daemon
/// holds, so it awaits no network: whether `GET /user` still accepts the grant
/// is `/readiness/github`'s, on the sweep. **The token is not in it** — the
/// login and the profile image URL, both public, are what is shown of the
/// account.
///
/// `client_id` and `client_id_custom` are read fresh here rather than held:
/// they answer *which app is in use*, and a client id is not a secret
/// (ADR-0023), so nothing stops this route from saying so (Y-393).
async fn connection(State(grant): State<Grant>) -> impl IntoResponse {
    Json(Connection::of(
        &grant.read().await,
        github::client_id_and_source(),
    ))
}

/// `yantra ls repos` on the wire, without the filter: the search box filters
/// this list in the browser, because a typed box polls and a read handler never
/// awaits the network. No grant is `looked: "failed"` naming the login, for
/// `/attention`'s reason.
async fn repos(State(model): State<Model>) -> impl IntoResponse {
    let snapshot = model.read().await.clone();
    Json(Answer::of(snapshot.repos.as_deref(), |repos| {
        repos.iter().map(Repo::of).collect::<Vec<_>>()
    }))
}

/// The organisations that own none of `/repos`. The list is read first, so its
/// failure is this answer's failure too.
async fn hidden(State(model): State<Model>) -> impl IntoResponse {
    let snapshot = model.read().await.clone();
    Json(match snapshot.repos.as_deref() {
        Some(repos) if repos.value().is_err() => Answer::of(Some(repos), |_| Vec::new()),
        _ => Answer::of(snapshot.hidden.as_deref(), Vec::clone),
    })
}

/// The library answers `heartbeat` *unknown* from every caller it has, and that
/// is the architecture rather than a gap: the beats are in this process and
/// nothing persists them (Y-044), while ADR-0012 keeps the CLI out of it. This
/// is the daemon filling in its own check.
///
/// [`crate::write`]'s re-check calls it too, so a report a person asked for
/// carries the same fourteen answers as the swept one and not thirteen plus an
/// *unknown* the daemon could have filled in.
pub(crate) fn answered(
    report: &doctor::Report,
    snapshot: &Snapshot,
    beats: &BTreeMap<String, Reading<Heartbeat>>,
) -> doctor::Report {
    // A name Tailscale lists is one this host should resolve, so the fix is the resolver.
    let peer = node_id(&report.machine, snapshot).is_some();
    doctor::Report {
        machine: report.machine.clone(),
        checks: report
            .checks
            .iter()
            .map(|check| match check.check {
                doctor::HEARTBEAT => heard_from(&report.machine, snapshot, beats),
                _ if peer => doctor::on_tailnet(check),
                _ => check.clone(),
            })
            .collect(),
    }
}

/// A report and how old it is. A kept check can be much older than the sweep
/// beside it, and every reading carries its own age. It flattens, so the wire
/// shape is the report's with one more field.
#[derive(Debug, serde::Serialize)]
pub(crate) struct Checked {
    #[serde(flatten)]
    pub(crate) report: doctor::Report,
    pub(crate) age_seconds: u64,
}

impl Checked {
    fn of(
        kept: &Reading<doctor::Report>,
        snapshot: &Snapshot,
        beats: &BTreeMap<String, Reading<Heartbeat>>,
    ) -> Self {
        Self {
            report: answered(kept.value(), snapshot, beats),
            age_seconds: kept.age().as_secs(),
        }
    }
}

/// I-5 one route over: a report names a machine the way a workspace does
/// (ADR-0009) while a beat is keyed on the node id, so the join runs through the
/// look Tailscale answered — and a machine that look does not hold stays
/// *unknown*, because nothing here can tell *no beat* from *no node* (R-23).
///
/// **No age threshold.** A beat that arrived is *present* carrying how long ago;
/// which ages mean a dead agent is ADR-0013 §7's, and this daemon names none of
/// those states.
///
/// An agent older than this daemon, or one that sends no version, is *absent*
/// with the command that updates it (ADR-0013's 2026-11-11 amendment). The
/// check is a warning, so a session still starts there.
fn heard_from(
    machine: &str,
    snapshot: &Snapshot,
    beats: &BTreeMap<String, Reading<Heartbeat>>,
) -> doctor::Check {
    let says = |state, detail: String| doctor::Check {
        check: doctor::HEARTBEAT,
        state,
        detail,
        took_ms: None,
    };
    let Some(node) = node(machine, snapshot) else {
        return says(
            doctor::State::Unknown,
            "no tailnet node here answers to that name, so whether it has reported is not known"
                .to_owned(),
        );
    };
    let Some(reading) = beats.get(&node.id) else {
        return says(
            doctor::State::Absent,
            "no report since Yantra started. The join command offers Yantra's agent, which \
             reports CPU, memory and disk"
                .to_owned(),
        );
    };
    match behind(
        reading.value().version.as_deref(),
        about::VERSION,
        &node.os,
        machine,
    ) {
        Some(detail) => says(doctor::State::Absent, detail),
        None => says(
            doctor::State::Present,
            format!("last report {}s ago", reading.age().as_secs()),
        ),
    }
}

/// What readiness says of an agent that runs behind `daemon`, or `None` when
/// it does not. A Mac installs stable releases only, so under a nightly daemon
/// it is behind only when it is older than the release that nightly builds on.
fn behind(agent: Option<&str>, daemon: &str, os: &Os, machine: &str) -> Option<String> {
    let nightly = about::stable_below(daemon);
    let wanted = match (os, &nightly) {
        (Os::MacOs, Some(stable)) => stable.as_str(),
        _ => daemon,
    };
    let here = match agent {
        None => format!("sends no version, so it predates yantrad v{daemon}"),
        Some(version) if about::older(version, wanted) => {
            format!("is v{version} and yantrad is v{daemon}")
        }
        Some(_) => return None,
    };
    let update = match update_command(os, wanted, nightly.is_some()) {
        Some(command) => format!(": `{command}`"),
        None => ".".to_owned(),
    };
    Some(format!(
        "yantra-agent here {here}. Update it on {machine}{update}"
    ))
}

/// What updates the agent on a machine to `version`, pinned so it never
/// passes the daemon (ADR-0013: the daemon goes first). Linux takes `--agent`,
/// because a bare `install.sh` there installs the whole appliance. A nightly
/// has no tag of its own to pin, so Linux follows the nightly channel there.
/// A Mac has no nightly archive (ADR-0027), so under a nightly it takes the
/// latest stable, the release that nightly builds on.
fn update_command(os: &Os, version: &str, nightly: bool) -> Option<String> {
    const SCRIPT: &str =
        "curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh |";
    match os {
        Os::MacOs if nightly => Some(format!("{SCRIPT} bash")),
        Os::MacOs => Some(format!("{SCRIPT} YANTRA_VERSION={version} bash")),
        Os::Linux if nightly => Some(format!("{SCRIPT} bash -s -- --agent --channel nightly")),
        Os::Linux => Some(format!(
            "{SCRIPT} YANTRA_VERSION={version} bash -s -- --agent"
        )),
        _ => None,
    }
}

fn node<'a>(machine: &str, snapshot: &'a Snapshot) -> Option<&'a MachineInfo> {
    let machines = snapshot.machines.as_deref()?.value().as_ref().ok()?;
    machines.iter().find(|one| one.name == machine)
}

fn node_id<'a>(machine: &str, snapshot: &'a Snapshot) -> Option<&'a str> {
    node(machine, snapshot).map(|one| one.id.as_str())
}

/// A file that did not load is not a workspace that is not there, and saying it
/// is would send someone looking for a file sitting in the directory broken
/// (R-23). Still a 404: there is no workspace to report a state for either way.
fn absent(fleet: &yantra_core::status::Fleet, name: &str) -> String {
    match fleet.unusable.iter().find(|one| one.name == name) {
        Some(unusable) => because(&unusable.error),
        None => format!("no workspace named `{name}`"),
    }
}

/// I-47 one layer up: `never` is not an empty list, and neither is `failed`.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "looked", rename_all = "lowercase")]
pub(crate) enum Answer<T> {
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

/// `&'static str` because the contract fixture spells fixed values: the real
/// build date changes daily and the target per machine, and either would make
/// `just test` red on the next morning or the next box.
#[derive(Debug, serde::Serialize)]
pub(crate) struct About {
    pub(crate) version: &'static str,
    pub(crate) target: &'static str,
    pub(crate) built: &'static str,
    pub(crate) uptime_seconds: u64,
    pub(crate) listening_on: Vec<String>,
    /// `None` until the machines look has run, or when no node holds a bound
    /// address — never a guess.
    pub(crate) tailnet: Option<String>,
    /// Y-652: the `tailscale serve` origin on this node, `None` when `tailnet`
    /// is. It is not proof that serve runs, so the page probes it first.
    pub(crate) https: Option<String>,
    /// Whether this process holds a relay. Never the URL or the token (§B4).
    pub(crate) relay: bool,
    /// The newest release GitHub publishes, read hourly (ADR-0027 §2).
    pub(crate) published: Answer<Published>,
    /// Which release the update unit installs (Y-662). `None` is a channel
    /// file that names no channel; no file at all is stable.
    pub(crate) channel: Option<update::Channel>,
    /// How far `yantra-update.service` has got (Y-612). `None` when nothing
    /// runs and the last run did not fail.
    pub(crate) update: Option<update::Progress>,
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct Published {
    pub(crate) version: String,
    /// Decided by [`about::newer`], so the page and `yantra update --check`
    /// cannot disagree.
    pub(crate) newer: bool,
}

impl Published {
    fn of(release: &github::Release) -> Self {
        Self {
            version: release.version.clone(),
            newer: about::newer(release),
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct SshIdentity {
    pub(crate) path: String,
    pub(crate) kind: String,
    pub(crate) public_key: String,
    pub(crate) fingerprint: String,
    /// The `authorized_keys` line for an owner terminal (ADR-0046 §2.2).
    pub(crate) owner_line: String,
}

impl SshIdentity {
    fn of(identity: &identity::Identity, listening_on: &[SocketAddr]) -> Self {
        let hub: Vec<_> = listening_on.iter().map(SocketAddr::ip).collect();
        Self {
            path: identity.path.display().to_string(),
            kind: identity.kind.clone(),
            public_key: identity.public_key.clone(),
            fingerprint: identity.fingerprint.clone(),
            owner_line: identity::owner_line(&identity.public_key, &hub),
        }
    }
}

#[derive(Debug, serde::Serialize)]
struct Machine {
    name: String,
    dns_name: String,
    /// The first Tailscale IPv4, which is what an ssh config or a browser
    /// address bar wants; `null` is a node that reported none.
    address: Option<String>,
    os: String,
    online: bool,
    /// Y-626: online because the node answered a WireGuard handshake while
    /// Tailscale's control server cannot see it.
    control_lost: bool,
    /// I-39: an expired key is a third state. Such a machine can be powered on,
    /// listed, and still unreachable — which a green dot would erase.
    expired: bool,
    /// When the node key lapses, RFC 3339; `null` is key expiry off.
    key_expires: Option<String>,
    last_seen: Option<String>,
    /// **`null` is *never heard from*** — I-47 again, and the state a zeroed
    /// row would erase. `online` beside it is what tells the two explanations
    /// of a missing beat apart, and it never decides whether one arrived (R-8).
    heartbeat: Option<Beat>,
    /// Y-404: `yours`, `shared` or `tagged`. The owner's number and the tag
    /// names stay in the daemon, because the page needs only whose node it is.
    ownership: &'static str,
    /// Y-582: the node `yantrad` itself runs on, which setup never offers to add.
    hub: bool,
}

impl Machine {
    /// Keyed on the node id (I-5), which is the only stable key and is the one
    /// thing here a reader never sees.
    fn of(
        machine: &yantra_core::inventory::MachineInfo,
        beats: &BTreeMap<String, Reading<Heartbeat>>,
        listening_on: &[SocketAddr],
    ) -> Self {
        Self {
            name: machine.name.clone(),
            dns_name: machine.dns_name.clone(),
            address: machine
                .addresses
                .iter()
                .find(|address| address.is_ipv4())
                .map(ToString::to_string),
            os: machine.os.to_string(),
            online: machine.online,
            control_lost: machine.control_lost,
            expired: machine.expired,
            key_expires: machine.key_expires.clone(),
            last_seen: machine.last_seen.clone(),
            heartbeat: beats.get(&machine.id).map(Beat::of),
            ownership: match machine.ownership {
                yantra_core::inventory::Ownership::Yours => "yours",
                yantra_core::inventory::Ownership::Shared => "shared",
                yantra_core::inventory::Ownership::Tagged => "tagged",
            },
            hub: is_this_node(machine, listening_on),
        }
    }
}

/// What a machine last said about itself, with the age of the *arrival* — the
/// beat's own `sent_at` is diagnostic and never the freshness source
/// (ADR-0013 §1), so it is not what a display state reads.
///
/// `Power` is core's own type because ADR-0013 §2 fixes one wire shape for both
/// directions; a second spelling here would be a second thing to disagree with.
#[derive(Debug, serde::Serialize)]
struct Beat {
    age_seconds: u64,
    arch: String,
    labels: Vec<String>,
    free_ram_mb: u64,
    free_disk_mb: u64,
    cpu_busy_pct: u8,
    power: Power,
}

impl Beat {
    fn of(reading: &Reading<Heartbeat>) -> Self {
        let beat = reading.value();
        Self {
            age_seconds: reading.age().as_secs(),
            arch: beat.arch.clone(),
            labels: beat.labels.clone(),
            free_ram_mb: beat.free_ram_mb,
            free_disk_mb: beat.free_disk_mb,
            cpu_busy_pct: beat.cpu_busy_pct,
            power: beat.power,
        }
    }
}

#[derive(Debug, serde::Serialize)]
struct Listed {
    name: String,
    #[serde(flatten)]
    loaded: Loaded,
}

/// Y-054's rule applied to a file rather than a machine: one that did not load
/// stays in the list under its name carrying why, rather than becoming an
/// absence. The page names it below the table instead of drawing it as a row —
/// see `web/src/App.tsx` for what a row would have had nothing to put in.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "loaded", rename_all = "lowercase")]
enum Loaded {
    Yes {
        machine: String,
        repo: String,
        startup: Option<String>,
    },
    No {
        error: String,
    },
}

impl Listed {
    fn of(workspace: &yantra_core::workspace::Workspace) -> Self {
        Self {
            name: workspace.name.clone(),
            loaded: Loaded::Yes {
                machine: workspace.machine.clone(),
                repo: workspace.repo.display().to_string(),
                startup: workspace.startup.clone(),
            },
        }
    }

    fn unusable(unusable: &yantra_core::workspace::Unusable) -> Self {
        Self {
            name: unusable.name.clone(),
            loaded: Loaded::No {
                error: because(&unusable.error),
            },
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
    /// The same moment as Unix seconds, for a page to age.
    created_at: u64,
}

impl Session {
    fn of(session: &yantra_core::tmux::Summary) -> Self {
        Self {
            name: session.name.clone(),
            windows: session.windows,
            attached: session.attached,
            created: session.created.clone(),
            created_at: session.created_at,
        }
    }
}

/// The answers on this seam that the router cannot render deterministically
/// — a build date, a key and an update's progress on the daemon's own disk —
/// built for
/// [`crate::contract`] the way `write::answers` builds its own.
#[cfg(test)]
#[allow(clippy::expect_used)]
pub(crate) fn answers() -> Vec<(&'static str, &'static str, serde_json::Value)> {
    fn of<T: serde::Serialize>(value: &T) -> serde_json::Value {
        serde_json::to_value(value).expect("a DTO of owned strings and numbers")
    }
    vec![
        (
            "about",
            "About",
            of(&About {
                version: "0.1.0",
                target: "aarch64-unknown-linux-musl",
                built: "2026-09-06",
                uptime_seconds: 86_412,
                listening_on: vec![
                    "100.64.0.1:7717".to_owned(),
                    "[fd7a:115c:a1e0::1]:7717".to_owned(),
                ],
                tailnet: Some("<tailnet>.ts.net".to_owned()),
                https: Some("https://<node>.<tailnet>.ts.net:8443".to_owned()),
                relay: true,
                published: Answer::Ok {
                    age_seconds: 1_234,
                    data: Published {
                        version: "0.4.0".to_owned(),
                        newer: true,
                    },
                },
                channel: Some(update::Channel::Stable),
                update: None,
            }),
        ),
        // About's `update` while the unit runs, and after it failed (Y-612).
        (
            "updateDownloading",
            "UpdateProgress",
            of(&update::Progress::Downloading {
                version: "0.4.0".to_owned(),
                received: 3_100_000,
                total: Some(9_800_000),
            }),
        ),
        (
            "updateFailed",
            "UpdateProgress",
            of(&update::Progress::Failed {
                said: "install: yantra-0.4.0-aarch64-unknown-linux-musl.tar.gz does not match SHA256SUMS — nothing was installed".to_owned(),
            }),
        ),
        (
            "sshIdentity",
            "SshIdentity",
            of(&SshIdentity {
                path: "/home/<user>/.ssh/id_yantra".to_owned(),
                kind: "ed25519".to_owned(),
                public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB<key> yantra".to_owned(),
                fingerprint: "SHA256:<fingerprint>".to_owned(),
                owner_line: "from=\"100.64.0.1,fd7a:115c:a1e0::1\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB<key> yantra".to_owned(),
            }),
        ),
    ]
}

/// The two lists are kept apart because a review waiting on this account and an
/// issue assigned to it are different obligations, even though a page may draw
/// them as one queue. `notifications` is a count and not a list: the titles are
/// the part that would land in a journal, and nothing draws them.
#[derive(Debug, serde::Serialize)]
struct Attention {
    reviews: Vec<Item>,
    issues: Vec<Item>,
    notifications: u32,
}

impl Attention {
    fn of(attention: &yantra_core::attention::Attention) -> Self {
        Self {
            reviews: attention.reviews.iter().map(Item::of).collect(),
            issues: attention.issues.iter().map(Item::of).collect(),
            notifications: attention.notifications,
        }
    }
}

#[derive(Debug, serde::Serialize)]
struct Item {
    repo: String,
    number: u64,
    title: String,
    /// GitHub's own web URL, carried rather than rebuilt from the parts —
    /// `/issues` against `/pull` is the kind of thing a client gets wrong.
    url: String,
    /// RFC 3339 as GitHub sent it. The age a reader wants is against now rather
    /// than against the look, so this is not the envelope's `age_seconds`.
    updated_at: String,
}

impl Item {
    fn of(item: &yantra_core::attention::Item) -> Self {
        Self {
            repo: item.repo.clone(),
            number: item.number,
            title: item.title.clone(),
            url: item.url.clone(),
            updated_at: item.updated_at.clone(),
        }
    }
}

/// `scopes` is GitHub's own list from the grant that made it, and empty for a
/// grant read from the environment — nothing asks GitHub what a token may do.
/// `pending` is a device flow waiting for its code to be typed. `expiring`
/// says the last flow ended because GitHub issued a token that expires.
///
/// `client_id` and `client_id_custom` say which OAuth App a sign-in would use
/// — `null`/`false` is a deployment with none configured — and never what the
/// running daemon holds live: a value just written takes effect at the next
/// start (Y-393), same as the relay.
#[derive(Debug, serde::Serialize)]
struct Connection {
    connected: bool,
    login: Option<String>,
    /// GitHub's public profile image URL, learned with the login.
    avatar_url: Option<String>,
    scopes: Vec<String>,
    pending: bool,
    expiring: bool,
    client_id: Option<String>,
    client_id_custom: bool,
}

impl Connection {
    fn of(held: &crate::github::Held, client_id: Option<(String, github::ClientIdSource)>) -> Self {
        Self {
            connected: held.token.is_some(),
            login: held.login.clone(),
            avatar_url: held.avatar_url.clone(),
            scopes: held.scopes.clone(),
            pending: held.pending,
            expiring: held.expiring,
            client_id: client_id.as_ref().map(|(id, _)| id.clone()),
            client_id_custom: matches!(
                client_id.map(|(_, source)| source),
                Some(github::ClientIdSource::Env)
            ),
        }
    }
}

#[derive(Debug, serde::Serialize)]
struct Repo {
    full_name: String,
    private: bool,
    language: Option<String>,
    /// RFC 3339 as GitHub sent it, or `null` for a repository never pushed to.
    pushed_at: Option<String>,
    clone_url: String,
    default_branch: String,
}

impl Repo {
    fn of(repo: &yantra_core::github::Repo) -> Self {
        Self {
            full_name: repo.full_name.clone(),
            private: repo.private,
            language: repo.language.clone(),
            pushed_at: repo.pushed_at.clone(),
            clone_url: repo.clone_url.clone(),
            default_branch: repo.default_branch.clone(),
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
pub(crate) mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use serde_json::{Value, json};
    use std::sync::Arc;
    use std::time::Duration;
    use tower::ServiceExt as _;
    use yantra_core::sessions::{self, MachineSessions};
    use yantra_core::snapshot::Snapshot;
    use yantra_core::status::{self, Report};
    use yantra_core::tmux::Summary;
    use yantra_core::workspace::{Listing, Unusable};

    async fn get(fleet: Fleet, path: &str) -> (StatusCode, Value) {
        let response = router()
            .with_state(fleet)
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

    pub(crate) async fn get_json(fleet: Fleet, path: &str) -> Value {
        let (status, body) = get(fleet, path).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    fn holding(snapshot: Snapshot) -> Fleet {
        Fleet {
            model: Arc::new(tokio::sync::RwLock::new(snapshot)),
            beats: Beats::default(),
            ..Fleet::default()
        }
    }

    fn machine(id: &str, name: &str, online: bool) -> MachineInfo {
        MachineInfo {
            ownership: yantra_core::inventory::Ownership::Yours,
            id: id.into(),
            name: name.into(),
            dns_name: format!("{name}.example.ts.net."),
            os: Os::Linux,
            online,
            control_lost: false,
            last_seen: None,
            expired: false,
            key_expires: None,
            addresses: Vec::new(),
        }
    }

    fn beat(power: Power) -> Heartbeat {
        Heartbeat {
            sent_at: time::OffsetDateTime::from_unix_timestamp(1_785_522_600)
                .expect("a fixed, valid timestamp"),
            arch: "x86_64".into(),
            labels: vec!["gpu".into()],
            free_ram_mb: 19942,
            free_disk_mb: 214003,
            cpu_busy_pct: 15,
            power,
            version: Some(about::VERSION.to_owned()),
        }
    }

    /// The fleet as the daemon holds it: what Tailscale said, and what some of
    /// those machines have said about themselves.
    async fn beating(machines: Vec<MachineInfo>, beats: &[(&str, Heartbeat)]) -> Fleet {
        let fleet = holding(Snapshot {
            machines: Some(Arc::new(Reading::new(Ok(machines)))),
            ..Snapshot::default()
        });
        let mut held = fleet.beats.write().await;
        for (id, beat) in beats {
            held.insert((*id).to_owned(), Reading::new(beat.clone()));
        }
        drop(held);
        fleet
    }

    /// A browser that arrives in the first 30 seconds must be told nobody has
    /// looked. An empty `data` here would draw an empty fleet and be believed.
    #[tokio::test]
    async fn a_class_nobody_has_looked_at_says_so_and_carries_no_data() {
        for path in [
            "/machines",
            "/workspaces",
            "/sessions",
            "/readiness",
            "/machines/cachyos-g14/readiness",
            "/attention",
            "/readiness/github",
            "/readiness/proxy",
            "/repos",
            "/repos/hidden",
        ] {
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
                    path: "/home/<user>/.config/yantra/workspaces/has.dot.toml".into(),
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
            workspaces: Some(Arc::new(Reading::new(Ok(Listing {
                workspaces: Vec::new(),
                unusable: Vec::new(),
            })))),
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
                        created_at: 1_785_502_951,
                    }]),
                    keepers: Vec::new(),
                },
                MachineSessions {
                    machine: "pi".into(),
                    sessions: Err(sessions::Error::Interrupted {
                        machine: "pi".into(),
                        reason: "connection timed out".into(),
                    }),
                    keepers: Vec::new(),
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

    /// Y-141 on the wire, and the same assertion as the machine one above: the
    /// file that did not load is in the array carrying why, and the workspace
    /// beside it is still there — before this, one broken `.toml` made the whole
    /// answer `looked: "failed"` and emptied the page.
    #[tokio::test]
    async fn a_workspace_file_that_did_not_load_reaches_the_json_with_its_reason() {
        let model = holding(Snapshot {
            workspaces: Some(Arc::new(Reading::new(Ok(Listing {
                workspaces: vec![workspace("api", "cachyos-g14")],
                unusable: vec![Unusable {
                    name: "site".into(),
                    error: yantra_core::workspace::Error::Blank {
                        name: "site".into(),
                        path: "/home/<user>/.config/yantra/workspaces/site.toml".into(),
                        field: "machine",
                    },
                }],
            })))),
            ..Snapshot::default()
        });

        let body = get_json(model, "/workspaces").await;
        assert_eq!(body["looked"], "ok", "{body}");
        let listed = body["data"].as_array().expect("one entry per file");
        assert_eq!(listed.len(), 2, "{body}");
        assert_eq!(listed[0]["loaded"], "yes");
        assert_eq!(listed[0]["machine"], "cachyos-g14");
        assert_eq!(listed[1]["loaded"], "no");
        assert_eq!(listed[1]["name"], "site");
        assert!(listed[1].get("machine").is_none(), "{body}");
        assert!(
            listed[1]["error"]
                .as_str()
                .is_some_and(|e| e.contains("site.toml") && e.contains("machine")),
            "the file and the field, or nobody can fix it: {body}"
        );
    }

    /// A file sitting in the directory broken is not a name nobody has used, and
    /// answering the second sends someone looking for a file that is right
    /// there (R-23). The status is still 404 — there is no workspace either way.
    #[tokio::test]
    async fn a_status_asked_for_an_unusable_file_says_why_rather_than_no_such_workspace() {
        let model = looking_past(
            vec![on_machine(
                "bishwajeets-macbook-pro",
                Ok(vec![report("api", Verdict::Running)]),
            )],
            vec![Unusable {
                name: "site".into(),
                error: yantra_core::workspace::Error::Blank {
                    name: "site".into(),
                    path: "/home/<user>/.config/yantra/workspaces/site.toml".into(),
                    field: "repo",
                },
            }],
        );

        let (code, body) = get(model, "/workspaces/site/status").await;
        assert_eq!(code, StatusCode::NOT_FOUND, "{body}");
        assert!(
            body["error"]
                .as_str()
                .is_some_and(|e| e.contains("site.toml") && e.contains("repo")),
            "{body}"
        );
    }

    /// Y-477: key expiry off is `null` on the wire, not a missing key.
    #[tokio::test]
    async fn key_expiry_off_is_null() {
        let model = holding(Snapshot {
            machines: Some(Arc::new(Reading::new(Ok(vec![machine(
                "n-1", "mine", true,
            )])))),
            ..Snapshot::default()
        });

        let body = get_json(model, "/machines").await;
        assert_eq!(body["data"][0]["key_expires"], serde_json::Value::Null);
    }

    /// Y-404: whose node it is crosses the wire as one word, and the owner's
    /// number and the tag names never do.
    #[tokio::test]
    async fn ownership_is_one_word_and_no_account_id_or_tag_leaves() {
        let model = holding(Snapshot {
            machines: Some(Arc::new(Reading::new(Ok(vec![
                machine("n-1", "mine", true),
                MachineInfo {
                    ownership: yantra_core::inventory::Ownership::Shared,
                    ..machine("n-2", "friend", true)
                },
                MachineInfo {
                    ownership: yantra_core::inventory::Ownership::Tagged,
                    ..machine("n-3", "ci", true)
                },
            ])))),
            ..Snapshot::default()
        });

        let body = get_json(model, "/machines").await;
        let listed = body["data"].as_array().expect("a list");
        let words: Vec<_> = listed.iter().map(|m| m["ownership"].clone()).collect();
        assert_eq!(words, [json!("yours"), json!("shared"), json!("tagged")]);
        for machine in listed {
            for key in ["user", "user_id", "owner", "tags"] {
                assert!(machine.get(key).is_none(), "{key} leaked: {machine}");
            }
        }
    }

    fn bound_to(listening_on: &str, machines: Vec<MachineInfo>) -> Fleet {
        Fleet {
            facts: Arc::new(crate::heartbeat::Facts {
                started: std::time::Instant::now(),
                listening_on: vec![listening_on.parse().expect("an address")],
                ssh_dir: std::path::PathBuf::new(),
                ssh_state: std::path::PathBuf::new(),
                relay: false,
                trigger: std::path::PathBuf::new(),
                updater: std::path::PathBuf::new(),
                progress: std::path::PathBuf::new(),
                channel: std::path::PathBuf::new(),
            }),
            ..looking_at_machines(machines)
        }
    }

    fn at(address: &str, machine: MachineInfo) -> MachineInfo {
        MachineInfo {
            addresses: vec![address.parse().expect("an address")],
            ..machine
        }
    }

    async fn hubs(fleet: Fleet) -> Vec<Value> {
        let body = get_json(fleet, "/machines").await;
        let listed = body["data"].as_array().expect("a list");
        listed.iter().map(|m| m["hub"].clone()).collect()
    }

    /// Y-582: the node holding the address the daemon bound is the hub, and no
    /// other node is.
    #[tokio::test]
    async fn the_node_the_daemon_is_bound_to_is_the_hub() {
        let fleet = bound_to(
            "100.64.0.1:7717",
            vec![
                at("100.64.0.2", machine("n-2", "pi", true)),
                at("100.64.0.1", machine("n-1", "yantra-box", true)),
                at("100.64.0.3", machine("n-3", "mac", false)),
            ],
        );
        assert_eq!(hubs(fleet).await, [json!(false), json!(true), json!(false)]);
    }

    /// A dual-stack bind reports a v4 peer as `::ffff:a.b.c.d`; it is still the hub.
    #[tokio::test]
    async fn a_v4_mapped_bind_still_names_the_hub() {
        let fleet = bound_to(
            "[::ffff:100.64.0.1]:7717",
            vec![at("100.64.0.1", machine("n-1", "yantra-box", true))],
        );
        assert_eq!(hubs(fleet).await, [json!(true)]);
    }

    /// A daemon bound to an address no node holds names no hub, and never guesses.
    #[tokio::test]
    async fn no_bound_match_names_no_hub() {
        let fleet = bound_to(
            "127.0.0.1:7717",
            vec![
                at("100.64.0.1", machine("n-1", "yantra-box", true)),
                at("100.64.0.2", machine("n-2", "pi", true)),
            ],
        );
        assert_eq!(hubs(fleet).await, [json!(false), json!(false)]);
    }

    /// I-39 again: the dashboard's most actionable machine is the one that is
    /// listed, powered on and still unreachable, so `expired` is its own field.
    #[tokio::test]
    async fn an_expired_key_is_a_field_of_its_own_and_not_folded_into_offline() {
        let model = holding(Snapshot {
            machines: Some(Arc::new(Reading::new(Ok(vec![MachineInfo {
                ownership: yantra_core::inventory::Ownership::Yours,
                id: "n-1".into(),
                name: "laptop-9ml3d644".into(),
                dns_name: "laptop-9ml3d644.example.ts.net.".into(),
                os: Os::Linux,
                online: false,
                control_lost: false,
                last_seen: Some("2026-07-07T09:00:00Z".into()),
                expired: true,
                key_expires: Some("2027-01-18T10:11:44Z".into()),
                addresses: vec!["100.64.0.4".parse().expect("a v4 address")],
            }])))),
            ..Snapshot::default()
        });

        let body = get_json(model, "/machines").await;
        let machine = &body["data"][0];
        assert_eq!(machine["online"], false);
        assert_eq!(machine["expired"], true);
        assert_eq!(machine["key_expires"], "2027-01-18T10:11:44Z");
        assert_eq!(machine["os"], "linux");
        assert!(
            machine.get("id").is_none(),
            "the node id is not something a read-only page needs: {machine}"
        );
        // Same reason, and ADR-0009's: the address is the daemon's key for
        // attributing a heartbeat, while a reader reaches a machine by name.
        assert!(
            machine.get("addresses").is_none(),
            "a tailnet address is a key, not a column: {machine}"
        );
    }

    /// **Never heard from is `null`, and a beat that says zero is not it.** A
    /// machine with no row must not borrow the shape of one that reported an
    /// empty tank, because those two send a person to different places.
    #[tokio::test]
    async fn a_machine_that_has_never_beaten_carries_null_and_not_a_zeroed_row() {
        let fleet = beating(
            vec![
                machine("n-1", "cachyos-g14", true),
                machine("n-2", "bishwajeets-macbook-pro", true),
            ],
            &[("n-1", beat(Power::Ac))],
        )
        .await;

        let body = get_json(fleet, "/machines").await;
        let heard = &body["data"][0];
        assert_eq!(heard["heartbeat"]["free_ram_mb"], 19942, "{body}");
        assert_eq!(heard["heartbeat"]["power"], "ac", "{body}");
        assert_eq!(heard["heartbeat"]["labels"][0], "gpu", "{body}");

        let silent = &body["data"][1];
        assert!(silent["heartbeat"].is_null(), "{silent}");
        assert_eq!(
            silent["online"], true,
            "Tailscale's view survives beside an absent beat, because it is what
             tells `up, but not reporting` from `asleep or off`: {silent}"
        );
    }

    /// I-5: the key is the node id. A name is a display label that collides
    /// twice on this tailnet, and joining on one would attribute a machine's
    /// facts to its namesake.
    #[tokio::test]
    async fn a_beat_is_joined_on_the_node_id_and_never_on_the_name() {
        let fleet = beating(
            vec![machine("n-1", "cachyos-g14", true)],
            &[("cachyos-g14", beat(Power::Ac))],
        )
        .await;

        let body = get_json(fleet, "/machines").await;
        assert!(
            body["data"][0]["heartbeat"].is_null(),
            "a row keyed on the display name was served as this machine's: {body}"
        );
    }

    /// The beat ages on its own clock, not the look's: one is written every
    /// 10 s by the agent and the other every 30 s by the refresher, so a page
    /// that read the envelope's age would call a dead agent fresh.
    #[tokio::test]
    async fn a_beat_carries_its_own_age_beside_the_age_of_the_look() {
        let fleet = beating(
            vec![machine("n-1", "cachyos-g14", true)],
            &[("n-1", beat(Power::Battery { percent: 42 }))],
        )
        .await;
        tokio::time::sleep(Duration::from_millis(1_100)).await;

        let body = get_json(fleet, "/machines").await;
        assert!(
            body["data"][0]["heartbeat"]["age_seconds"]
                .as_u64()
                .is_some_and(|age| age >= 1),
            "{body}"
        );
        assert_eq!(
            body["data"][0]["heartbeat"]["power"],
            json!({"battery": {"percent": 42}}),
            "{body}"
        );
    }

    /// A report as the library produces one, `heartbeat` included: unknown,
    /// because no caller of it holds the beats.
    fn checked(machine: &str) -> doctor::Report {
        doctor::Report {
            machine: machine.into(),
            checks: vec![
                doctor::Check {
                    check: "reachable",
                    state: doctor::State::Present,
                    detail: "a command ran there and reported its own status".into(),
                    took_ms: None,
                },
                doctor::Check {
                    check: doctor::HEARTBEAT,
                    state: doctor::State::Unknown,
                    detail: "only the running daemon holds the beats".into(),
                    took_ms: None,
                },
            ],
        }
    }

    /// The three memories these routes join: the sweep, the tailnet's own list
    /// to key it against, and what has beaten.
    async fn swept(
        reports: Vec<doctor::Report>,
        machines: Vec<MachineInfo>,
        beats: &[(&str, Heartbeat)],
    ) -> Fleet {
        let mut snapshot = Snapshot {
            machines: Some(Arc::new(Reading::new(Ok(machines)))),
            ..Snapshot::default()
        };
        crate::refresh::settle(&mut snapshot, Reading::new(Ok(reports)));
        let fleet = holding(snapshot);
        let mut held = fleet.beats.write().await;
        for (id, beat) in beats {
            held.insert((*id).to_owned(), Reading::new(beat.clone()));
        }
        drop(held);
        fleet
    }

    /// One report per machine, every check under its own name — D2 §3.1's list
    /// is what an installer and a card both read, so nothing here is summarised
    /// into a verdict the daemon would then own.
    #[tokio::test]
    async fn the_fleet_carries_every_check_of_every_machine_under_its_own_name() {
        let fleet = swept(
            vec![checked("cachyos-g14"), checked("pi")],
            vec![machine("n-1", "cachyos-g14", true)],
            &[],
        )
        .await;

        let body = get_json(fleet, "/readiness").await;
        assert_eq!(body["looked"], "ok", "{body}");
        let reports = body["data"].as_array().expect("one report per machine");
        assert_eq!(reports.len(), 2, "{body}");
        assert_eq!(reports[0]["machine"], "cachyos-g14");
        assert_eq!(reports[0]["checks"][0]["check"], "reachable");
        assert_eq!(reports[0]["checks"][0]["state"], "present");
        assert!(
            reports[0]["checks"][0]["detail"].as_str().is_some(),
            "a state with no detail is a state nobody can act on: {body}"
        );
    }

    /// **The one thing this route adds over `yantra doctor`.** The library says
    /// *unknown* from every caller it has (Y-044, ADR-0012); the beats are in
    /// this process, so here the check is answered — and a machine that has
    /// never beaten is *absent*, which sends a reader to the agent rather than
    /// to the machine (R-23).
    #[tokio::test]
    async fn the_daemon_answers_the_one_check_the_library_leaves_unknown() {
        let fleet = swept(
            vec![checked("cachyos-g14"), checked("bishwajeets-macbook-pro")],
            vec![
                machine("n-1", "cachyos-g14", true),
                machine("n-2", "bishwajeets-macbook-pro", true),
            ],
            &[("n-1", beat(Power::Ac))],
        )
        .await;

        let body = get_json(fleet, "/readiness").await;
        let beating = &body["data"][1]["checks"][1];
        assert_eq!(beating["check"], "heartbeat", "{body}");
        assert_eq!(beating["state"], "present", "{beating}");
        let silent = &body["data"][0]["checks"][1];
        assert_eq!(silent["state"], "absent", "{silent}");
        assert!(
            silent["detail"]
                .as_str()
                .is_some_and(|d| d.contains("join command") && !d.contains("yantra-agent")),
            "{silent}"
        );
    }

    /// One machine with `os` that sent one beat carrying `version`, answered
    /// the way `/readiness` answers it.
    fn heartbeat_of(os: Os, version: Option<&str>) -> doctor::Check {
        let mut node = machine("n-1", "laptop", true);
        node.os = os;
        let snapshot = Snapshot {
            machines: Some(Arc::new(Reading::new(Ok(vec![node])))),
            ..Snapshot::default()
        };
        let beats = BTreeMap::from([(
            "n-1".to_owned(),
            Reading::new(Heartbeat {
                version: version.map(str::to_owned),
                ..beat(Power::Ac)
            }),
        )]);
        let report = answered(&checked("laptop"), &snapshot, &beats);
        report.checks[1].clone()
    }

    const SCRIPT: &str =
        "curl -fsSL https://raw.githubusercontent.com/2002Bishwajeet/yantra/main/install.sh |";

    #[test]
    fn an_older_mac_agent_is_absent_with_the_command_pinned_to_this_daemon() {
        let check = heartbeat_of(Os::MacOs, Some("0.0.1"));
        assert_eq!(check.state, doctor::State::Absent);
        assert_eq!(
            check.detail,
            format!(
                "yantra-agent here is v0.0.1 and yantrad is v{v}. Update it on laptop: \
                 `{SCRIPT} YANTRA_VERSION={v} bash`",
                v = about::VERSION
            )
        );
    }

    #[test]
    fn an_older_linux_agent_is_told_to_update_only_the_agent() {
        let check = heartbeat_of(Os::Linux, Some("0.0.1"));
        assert_eq!(check.state, doctor::State::Absent);
        assert!(
            check.detail.ends_with(&format!(
                "`{SCRIPT} YANTRA_VERSION={} bash -s -- --agent`",
                about::VERSION
            )),
            "{}",
            check.detail
        );
    }

    #[test]
    fn an_agent_that_sends_no_version_predates_this_daemon() {
        let check = heartbeat_of(Os::Linux, None);
        assert_eq!(check.state, doctor::State::Absent);
        assert!(
            check.detail.starts_with(&format!(
                "yantra-agent here sends no version, so it predates yantrad v{}. Update it on laptop: `",
                about::VERSION
            )),
            "{}",
            check.detail
        );
    }

    #[test]
    fn an_older_agent_on_another_os_gets_no_command() {
        let check = heartbeat_of(Os::Windows, Some("0.0.1"));
        assert_eq!(check.state, doctor::State::Absent);
        assert!(
            check.detail.ends_with("Update it on laptop."),
            "{}",
            check.detail
        );
    }

    /// A nightly has no macOS archive and no tag to pin. A Mac is held to the
    /// release the nightly builds on, and Linux follows the nightly channel.
    #[test]
    fn a_nightly_daemon_holds_a_mac_to_its_stable_release_and_linux_to_nightly() {
        const NIGHTLY: &str = "0.11.1-nightly.20261111000000.abc1234";
        assert_eq!(behind(Some("0.11.0"), NIGHTLY, &Os::MacOs, "mac"), None);
        assert_eq!(
            behind(Some("0.10.2"), NIGHTLY, &Os::MacOs, "mac").as_deref(),
            Some(
                format!(
                    "yantra-agent here is v0.10.2 and yantrad is v{NIGHTLY}. Update it on mac: \
                     `{SCRIPT} bash`"
                )
                .as_str()
            )
        );
        assert_eq!(
            behind(Some("0.11.0"), NIGHTLY, &Os::Linux, "box").as_deref(),
            Some(
                format!(
                    "yantra-agent here is v0.11.0 and yantrad is v{NIGHTLY}. Update it on box: \
                     `{SCRIPT} bash -s -- --agent --channel nightly`"
                )
                .as_str()
            )
        );
        assert_eq!(behind(Some(NIGHTLY), NIGHTLY, &Os::Linux, "box"), None);
    }

    #[test]
    fn an_equal_or_newer_agent_is_present() {
        for version in [
            about::VERSION,
            "999.0.0",
            "999.0.0-nightly.20261111000000.abc1234",
        ] {
            let check = heartbeat_of(Os::MacOs, Some(version));
            assert_eq!(check.state, doctor::State::Present, "{version}");
            assert!(check.detail.starts_with("last report "), "{}", check.detail);
        }
    }

    /// I-5 is why the join is on the node id, and this is what it costs: a
    /// report whose machine the tailnet list does not hold cannot be keyed, and
    /// *unknown* is the only honest answer — *absent* would send someone to
    /// restart an agent that is beating fine.
    #[tokio::test]
    async fn a_machine_the_tailnet_does_not_list_leaves_the_beat_unknown_rather_than_absent() {
        let fleet = swept(
            vec![checked("pi")],
            vec![machine("n-1", "cachyos-g14", true)],
            &[],
        )
        .await;

        let body = get_json(fleet, "/readiness").await;
        assert_eq!(body["data"][0]["checks"][1]["state"], "unknown", "{body}");
    }

    /// The card on `/m/{machine}` reads one machine, and reads the same answer
    /// the fleet carries for it — including the beat, which is the check that
    /// makes this route worth serving.
    #[tokio::test]
    async fn one_machine_answers_the_report_the_fleet_holds_for_it() {
        let fleet = swept(
            vec![checked("cachyos-g14"), checked("pi")],
            vec![machine("n-1", "cachyos-g14", true)],
            &[("n-1", beat(Power::Battery { percent: 42 }))],
        )
        .await;

        let body = get_json(fleet, "/machines/cachyos-g14/readiness").await;
        assert_eq!(body["looked"], "ok", "{body}");
        assert_eq!(body["data"]["machine"], "cachyos-g14", "{body}");
        assert_eq!(body["data"]["checks"][1]["state"], "present", "{body}");
    }

    /// [`workspace_status`]'s rule at machine granularity: a 200 with no `data`
    /// would make a client infer absence from a missing field, and the sweep
    /// asks the machines workspaces name rather than the whole tailnet.
    #[tokio::test]
    async fn a_machine_no_sweep_covered_is_not_found_rather_than_an_empty_answer() {
        let fleet = swept(
            vec![checked("cachyos-g14")],
            vec![machine("n-1", "cachyos-g14", true)],
            &[],
        )
        .await;

        let (code, body) = get(fleet, "/machines/nosuch/readiness").await;
        assert_eq!(code, StatusCode::NOT_FOUND, "{body}");
        assert!(
            body["error"].as_str().is_some_and(|e| e.contains("nosuch")),
            "{body}"
        );
    }

    pub(crate) fn sweep_that_failed() -> yantra_core::snapshot::Readiness {
        Reading::new(Err(doctor::Error::Interrupted {
            machine: "pi".into(),
            reason: "the task stopped".into(),
        }))
    }

    /// Y-579's done condition. No workspace names `pi`, a check reached it once,
    /// and each sweep after that says nothing about it. Every GET runs twice to
    /// stand for a browser reload.
    #[tokio::test]
    async fn a_check_survives_every_later_sweep_and_a_reload_with_no_workspace() {
        for later in [
            None,
            Some(Reading::new(Ok(Vec::new()))),
            Some(sweep_that_failed()),
        ] {
            let mut snapshot = Snapshot {
                machines: Some(Arc::new(Reading::new(Ok(vec![machine(
                    "n-1", "pi", false,
                )])))),
                ..Snapshot::default()
            };
            crate::refresh::settle(&mut snapshot, Reading::new(Ok(vec![checked("pi")])));
            if let Some(sweep) = later {
                crate::refresh::settle(&mut snapshot, sweep);
            }
            let fleet = holding(snapshot);

            for _ in 0..2 {
                let one = get_json(fleet.clone(), "/machines/pi/readiness").await;
                assert_eq!(one["looked"], "ok", "{one}");
                assert_eq!(one["data"]["machine"], "pi", "{one}");

                let list = get_json(fleet.clone(), "/readiness").await;
                assert_eq!(list["looked"], "ok", "{list}");
                assert_eq!(list["data"][0]["machine"], "pi", "{list}");
            }
        }
    }

    /// What Y-579 did not change: with nothing kept the sweep answers, and a
    /// machine no check reached is still a 404.
    #[tokio::test]
    async fn with_nothing_kept_the_sweep_still_says_why() {
        let empty = holding(Snapshot::default());
        let list = get_json(empty.clone(), "/readiness").await;
        assert_eq!(list["looked"], "never", "{list}");
        let one = get_json(empty, "/machines/pi/readiness").await;
        assert_eq!(one["looked"], "never", "{one}");

        let mut snapshot = Snapshot::default();
        crate::refresh::settle(&mut snapshot, sweep_that_failed());
        let failed = holding(snapshot);
        let list = get_json(failed.clone(), "/readiness").await;
        assert_eq!(list["looked"], "failed", "{list}");
        let one = get_json(failed, "/machines/pi/readiness").await;
        assert_eq!(one["looked"], "failed", "{one}");

        let mut snapshot = Snapshot::default();
        crate::refresh::settle(&mut snapshot, Reading::new(Ok(Vec::new())));
        let swept = holding(snapshot);
        let list = get_json(swept.clone(), "/readiness").await;
        assert_eq!(list["looked"], "ok", "{list}");
        assert_eq!(list["data"], serde_json::json!([]), "{list}");
        let (code, body) = get(swept, "/machines/pi/readiness").await;
        assert_eq!(code, StatusCode::NOT_FOUND, "{body}");
    }

    /// The per-report age is what makes a kept result honest. The envelope says
    /// how young the newest one is.
    #[tokio::test]
    async fn a_kept_report_carries_its_own_age() {
        let mut snapshot = Snapshot::default();
        snapshot.keep(checked("pi"));
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        snapshot.keep(checked("g14"));
        let fleet = holding(snapshot);

        let list = get_json(fleet.clone(), "/readiness").await;
        assert_eq!(list["age_seconds"], 0, "{list}");
        assert_eq!(list["data"][0]["machine"], "g14", "{list}");
        assert_eq!(list["data"][0]["age_seconds"], 0, "{list}");
        assert_eq!(list["data"][1]["age_seconds"], 1, "{list}");

        let one = get_json(fleet, "/machines/pi/readiness").await;
        assert_eq!(one["age_seconds"], 1, "{one}");
        assert_eq!(one["data"]["age_seconds"], 1, "{one}");
    }

    fn waiting(reading: yantra_core::snapshot::Attention) -> Fleet {
        holding(Snapshot {
            attention: Some(Arc::new(reading)),
            ..Snapshot::default()
        })
    }

    /// Two queues and a count, each under its own name. A page that had to tell
    /// a review from an issue by which array it came out of would be reading a
    /// position rather than a field.
    #[tokio::test]
    async fn the_two_queues_and_the_unread_count_each_reach_the_json_by_name() {
        let fleet = waiting(Reading::new(Ok(yantra_core::attention::Attention {
            reviews: vec![yantra_core::attention::Item {
                repo: "utopia-php/messaging".into(),
                number: 54,
                title: "feat-6861-46elks-messaging-adapter".into(),
                url: "https://github.com/utopia-php/messaging/pull/54".into(),
                updated_at: "2024-04-19T15:49:30Z".into(),
            }],
            issues: Vec::new(),
            notifications: 27,
        })));

        let body = get_json(fleet, "/attention").await;
        assert_eq!(body["looked"], "ok", "{body}");
        assert_eq!(body["data"]["notifications"], 27, "{body}");
        assert_eq!(body["data"]["issues"].as_array().map(Vec::len), Some(0));
        let review = &body["data"]["reviews"][0];
        assert_eq!(review["repo"], "utopia-php/messaging");
        assert_eq!(review["number"], 54);
        assert_eq!(
            review["url"], "https://github.com/utopia-php/messaging/pull/54",
            "the link is GitHub's own, so nothing here rebuilds it: {review}"
        );
        assert_eq!(
            review["updated_at"], "2024-04-19T15:49:30Z",
            "an item ages against now rather than against the look: {review}"
        );
    }

    /// **The state this route is likeliest to be in, and the one it must not
    /// draw as a quiet morning.** A daemon nobody has signed in has an empty
    /// inbox in exactly the way an unplugged sensor reads zero (R-23), and the
    /// remedy is a command the reader has to be told.
    #[tokio::test]
    async fn no_grant_is_a_failed_look_and_never_an_empty_inbox() {
        let fleet = waiting(Reading::new(Err(yantra_core::attention::Error::NoGrant)));

        let body = get_json(fleet, "/attention").await;
        assert_eq!(body["looked"], "failed", "{body}");
        assert!(body.get("data").is_none(), "{body}");
        assert!(
            body["error"]
                .as_str()
                .is_some_and(|e| e.contains("no grant") || e.contains("no GitHub grant")),
            "{body}"
        );
        assert!(
            body["error"]
                .as_str()
                .is_some_and(|e| e.contains("yantra github login")),
            "{body}"
        );
    }

    fn repo(full_name: &str) -> yantra_core::github::Repo {
        yantra_core::github::Repo {
            full_name: full_name.into(),
            private: true,
            language: Some("Rust".into()),
            pushed_at: Some("2026-09-01T00:00:00Z".into()),
            clone_url: format!("https://github.com/{full_name}.git"),
            default_branch: "main".into(),
        }
    }

    /// The list New session searches, whole: the filter is the browser's.
    #[tokio::test]
    async fn repos_reach_the_json_by_name_with_a_grant() {
        let fleet = holding(Snapshot {
            repos: Some(Arc::new(Reading::new(Ok(vec![repo(
                "2002Bishwajeet/yantra",
            )])))),
            ..Snapshot::default()
        });

        let body = get_json(fleet, "/repos").await;
        assert_eq!(body["looked"], "ok", "{body}");
        let first = &body["data"][0];
        assert_eq!(first["full_name"], "2002Bishwajeet/yantra");
        assert_eq!(first["private"], true);
        assert_eq!(first["language"], "Rust");
        assert_eq!(
            first["clone_url"],
            "https://github.com/2002Bishwajeet/yantra.git"
        );
        assert_eq!(first["default_branch"], "main");
    }

    /// `/attention`'s rule for the list: no grant is a failed look naming the
    /// login, never an owner with no repositories.
    #[tokio::test]
    async fn repos_without_a_grant_are_a_failed_look_and_never_an_empty_list() {
        let fleet = holding(Snapshot {
            repos: Some(Arc::new(Reading::new(Err(
                yantra_core::github::Error::NoGrant,
            )))),
            ..Snapshot::default()
        });

        let body = get_json(fleet, "/repos").await;
        assert_eq!(body["looked"], "failed", "{body}");
        assert!(body.get("data").is_none(), "{body}");
        assert!(
            body["error"]
                .as_str()
                .is_some_and(|e| e.contains("yantra github login")),
            "{body}"
        );
    }

    /// An organisation that owns none of the list reaches the JSON by name.
    #[tokio::test]
    async fn hidden_organisations_reach_the_json_by_name() {
        let fleet = holding(Snapshot {
            repos: Some(Arc::new(Reading::new(Ok(vec![repo("me/yantra")])))),
            hidden: Some(Arc::new(Reading::new(Ok(vec!["Org".to_owned()])))),
            ..Snapshot::default()
        });

        let body = get_json(fleet, "/repos/hidden").await;
        assert_eq!(body["looked"], "ok", "{body}");
        assert_eq!(body["data"], json!(["Org"]));
    }

    /// A failed organisation read, or a failed list, is a failed look and
    /// never "every organisation is visible".
    #[tokio::test]
    async fn hidden_organisations_fail_with_their_read_or_with_the_list() {
        let orgs_failed = holding(Snapshot {
            repos: Some(Arc::new(Reading::new(Ok(vec![repo("me/yantra")])))),
            hidden: Some(Arc::new(Reading::new(Err(
                yantra_core::github::Error::Refused,
            )))),
            ..Snapshot::default()
        });
        let list_failed = holding(Snapshot {
            repos: Some(Arc::new(Reading::new(Err(
                yantra_core::github::Error::NoGrant,
            )))),
            ..Snapshot::default()
        });

        for (fleet, said) in [
            (orgs_failed, "refused the grant"),
            (list_failed, "yantra github login"),
        ] {
            let body = get_json(fleet, "/repos/hidden").await;
            assert_eq!(body["looked"], "failed", "{body}");
            assert!(body.get("data").is_none(), "{body}");
            assert!(
                body["error"].as_str().is_some_and(|e| e.contains(said)),
                "{body}"
            );
        }
    }

    /// The two shapes the page draws: nobody signed in, and a grant with its
    /// login. `null` for a login not yet learned is a state, not an absence
    /// — and the token is in neither.
    #[tokio::test]
    async fn the_connection_says_whether_a_grant_is_held_and_never_what_it_is() {
        let none = get_json(holding(Snapshot::default()), "/github").await;
        assert_eq!(none["connected"], false, "{none}");
        assert_eq!(none["login"], Value::Null, "{none}");
        assert_eq!(none["avatar_url"], Value::Null, "{none}");
        assert_eq!(none["scopes"], json!([]), "{none}");
        assert_eq!(none["pending"], false, "{none}");
        assert_eq!(none["expiring"], false, "{none}");
        // `client_id` mirrors this process's own environment (Y-393), which a
        // test does not control — so it is compared to itself, not a fixed
        // value, to stay green on a machine that happens to export it.
        let expected = match yantra_core::github::client_id() {
            Some(id) => Value::String(id),
            None => Value::Null,
        };
        assert_eq!(none["client_id"], expected, "{none}");

        let fleet = Fleet {
            github: Grant::holding(Some(yantra_core::github::Token::new(
                "gho_notarealtoken".into(),
            ))),
            ..holding(Snapshot::default())
        };
        fleet
            .github
            .learned(yantra_core::github::Account {
                login: "octocat".into(),
                avatar_url: Some("https://avatars.githubusercontent.com/u/1?v=4".into()),
            })
            .await;

        let held = get_json(fleet, "/github").await;
        assert_eq!(held["connected"], true, "{held}");
        assert_eq!(held["login"], "octocat", "{held}");
        assert_eq!(
            held["avatar_url"], "https://avatars.githubusercontent.com/u/1?v=4",
            "{held}"
        );
        assert_eq!(held["pending"], false, "{held}");
        assert!(!held.to_string().contains("gho_"), "{held}");
    }

    /// Settings reads why the last sign-in ended (Y-695).
    #[test]
    fn the_connection_says_the_last_sign_in_got_an_expiring_token() {
        let held = crate::github::Held {
            expiring: true,
            ..crate::github::Held::default()
        };
        let served = serde_json::to_value(Connection::of(&held, None)).expect("serialises");
        assert_eq!(served["expiring"], true, "{served}");
        assert_eq!(served["pending"], false, "{served}");
    }

    /// A check that is about this host, served under its own name and its own
    /// age — it is nowhere in the per-machine reports, because no ssh session
    /// asked it.
    #[tokio::test]
    async fn the_daemons_own_github_credential_is_answered_apart_from_the_fleet() {
        let mut snapshot = Snapshot {
            github: Some(Arc::new(Reading::new(doctor::Check {
                check: doctor::GITHUB,
                state: doctor::State::Absent,
                detail: "`gh` here holds no credential".into(),
                took_ms: None,
            }))),
            ..Snapshot::default()
        };
        snapshot.keep(checked("cachyos-g14"));
        let fleet = holding(snapshot);

        let body = get_json(fleet.clone(), "/readiness/github").await;
        assert_eq!(body["looked"], "ok", "{body}");
        assert_eq!(body["data"]["check"], "github", "{body}");
        assert_eq!(body["data"]["state"], "absent", "{body}");
        assert!(body["age_seconds"].as_u64().is_some(), "{body}");

        let fleet_body = get_json(fleet, "/readiness").await;
        let checks = fleet_body["data"][0]["checks"]
            .as_array()
            .expect("a report carries its checks");
        assert!(
            checks.iter().all(|check| check["check"] != "github"),
            "a fact about this host is not a fact about that machine: {fleet_body}"
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

    fn looking_at(machines: Vec<MachineStatus>) -> Fleet {
        looking_past(machines, Vec::new())
    }

    fn looking_past(machines: Vec<MachineStatus>, unusable: Vec<Unusable>) -> Fleet {
        holding(Snapshot {
            agents: Some(Arc::new(Reading::new(Ok(status::Fleet {
                machines,
                unusable,
            })))),
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
                    path: "/home/<user>/.config/yantra/workspaces/has.dot.toml".into(),
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

    /// Y-343: what a settings page draws about the daemon itself. The build
    /// facts are whatever this build is, so they are asserted present rather
    /// than equal; the tailnet is read off the node holding a bound address.
    #[tokio::test]
    async fn about_names_the_build_the_uptime_and_the_tailnet_of_the_bound_node() {
        let fleet = Fleet {
            facts: Arc::new(crate::heartbeat::Facts {
                started: std::time::Instant::now(),
                listening_on: vec!["100.64.0.1:7717".parse().expect("an address")],
                ssh_dir: std::path::PathBuf::new(),
                ssh_state: std::path::PathBuf::new(),
                relay: true,
                trigger: std::path::PathBuf::new(),
                updater: std::path::PathBuf::new(),
                progress: std::path::PathBuf::new(),
                channel: std::path::PathBuf::new(),
            }),
            ..looking_at_machines(vec![
                MachineInfo {
                    addresses: vec!["100.64.0.2".parse().expect("an address")],
                    ..machine("n-2", "pi", true)
                },
                MachineInfo {
                    addresses: vec!["100.64.0.1".parse().expect("an address")],
                    ..machine("n-1", "cachyos-g14", true)
                },
            ])
        };

        let body = get_json(fleet, "/about").await;
        assert_eq!(body["version"], json!(env!("CARGO_PKG_VERSION")));
        assert!(
            body["target"].as_str().is_some_and(|t| t.contains('-')),
            "{body}"
        );
        assert_eq!(body["built"].as_str().map(str::len), Some(10), "{body}");
        assert!(body["uptime_seconds"].as_u64().is_some(), "{body}");
        assert_eq!(body["listening_on"], json!(["100.64.0.1:7717"]));
        assert_eq!(body["tailnet"], json!("example.ts.net"));
        assert_eq!(
            body["https"],
            json!("https://cachyos-g14.example.ts.net:8443")
        );
        assert_eq!(body["relay"], json!(true));

        let unlooked = get_json(holding(Snapshot::default()), "/about").await;
        assert_eq!(unlooked["tailnet"], Value::Null, "no look, no guess");
        assert_eq!(unlooked["https"], Value::Null, "no look, no guess");
        assert_eq!(unlooked["published"], json!({"looked": "never"}));
        assert_eq!(unlooked["listening_on"], json!([]));
        assert_eq!(
            unlooked["relay"],
            json!(false),
            "no relay at start is false, never absent"
        );
    }

    /// Y-652: a look that lists no node holding a bound address names no HTTPS
    /// origin, because a browser sent to a guess lands on a dead page.
    #[tokio::test]
    async fn about_names_no_https_origin_when_no_node_holds_a_bound_address() {
        let fleet = Fleet {
            facts: Arc::new(crate::heartbeat::Facts {
                started: std::time::Instant::now(),
                listening_on: vec!["100.64.0.1:7717".parse().expect("an address")],
                ssh_dir: std::path::PathBuf::new(),
                ssh_state: std::path::PathBuf::new(),
                relay: false,
                trigger: std::path::PathBuf::new(),
                updater: std::path::PathBuf::new(),
                progress: std::path::PathBuf::new(),
                channel: std::path::PathBuf::new(),
            }),
            ..looking_at_machines(vec![MachineInfo {
                addresses: vec!["100.64.0.2".parse().expect("an address")],
                ..machine("n-2", "pi", true)
            }])
        };

        let body = get_json(fleet, "/about").await;
        assert_eq!(body["tailnet"], Value::Null, "{body}");
        assert_eq!(body["https"], Value::Null, "{body}");
    }

    /// ADR-0027 §2 on the wire: the published version is one of the three
    /// states every read has, and a failed read carries its reason rather
    /// than folding into *current*.
    #[tokio::test]
    async fn about_names_the_published_release_and_whether_it_is_newer() {
        let published = |release: Result<github::Release, github::Error>| {
            holding(Snapshot {
                release: Some((update::Channel::Stable, Arc::new(Reading::new(release)))),
                ..Snapshot::default()
            })
        };
        let parsed = |tag: &str| Ok(github::Release::parse(tag).expect("a version"));

        let newer = get_json(published(parsed("999.0.0")), "/about").await;
        assert_eq!(newer["published"]["looked"], json!("ok"), "{newer}");
        assert_eq!(
            newer["published"]["data"],
            json!({"version": "999.0.0", "newer": true})
        );

        let current = get_json(published(parsed(about::VERSION)), "/about").await;
        assert_eq!(
            current["published"]["data"],
            json!({"version": about::VERSION, "newer": false})
        );

        let failed = get_json(
            published(Err(github::Error::Status {
                status: 403,
                what: "/releases/latest",
            })),
            "/about",
        )
        .await;
        assert_eq!(failed["published"]["looked"], json!("failed"), "{failed}");
        assert!(
            failed["published"]["error"]
                .as_str()
                .is_some_and(|e| e.contains("403")),
            "{failed}"
        );
        assert_eq!(failed["published"].get("data"), None, "never current");
    }

    /// Y-735: the owner switched to nightly and the look still holds stable's
    /// release. About must not offer that release under the nightly channel.
    #[tokio::test]
    async fn about_never_pairs_a_release_with_another_channel() {
        let dir = std::env::temp_dir().join(format!("yantra-api-channel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let file = dir.join("channel");
        std::fs::write(&file, "nightly\n").expect("a channel");
        let release = github::Release::parse("999.0.0").expect("a version");
        let fleet = Fleet {
            facts: Arc::new(crate::heartbeat::Facts {
                started: std::time::Instant::now(),
                listening_on: Vec::new(),
                ssh_dir: std::path::PathBuf::new(),
                ssh_state: std::path::PathBuf::new(),
                relay: false,
                trigger: std::path::PathBuf::new(),
                updater: std::path::PathBuf::new(),
                progress: std::path::PathBuf::new(),
                channel: file,
            }),
            ..holding(Snapshot {
                release: Some((update::Channel::Stable, Arc::new(Reading::new(Ok(release))))),
                ..Snapshot::default()
            })
        };

        let body = get_json(fleet, "/about").await;
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(body["channel"], json!("nightly"), "{body}");
        assert_eq!(body["published"]["looked"], json!("never"), "{body}");
    }

    /// Y-612: the unit's progress file, read on each request.
    #[tokio::test]
    async fn about_says_how_far_an_update_has_got() {
        let dir = std::env::temp_dir().join(format!("yantra-api-progress-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let reading = |dir: &std::path::Path| Fleet {
            facts: Arc::new(crate::heartbeat::Facts {
                started: std::time::Instant::now(),
                listening_on: Vec::new(),
                ssh_dir: std::path::PathBuf::new(),
                ssh_state: std::path::PathBuf::new(),
                relay: false,
                trigger: std::path::PathBuf::new(),
                updater: std::path::PathBuf::new(),
                progress: dir.to_owned(),
                channel: std::path::PathBuf::new(),
            }),
            ..Fleet::default()
        };

        let idle = get_json(reading(&dir.join("gone")), "/about").await;
        assert_eq!(idle["update"], Value::Null, "{idle}");

        std::fs::write(
            dir.join("status"),
            "step=downloading\nversion=0.10.0\narchive=a.tar.gz\ntotal=9800000\n",
        )
        .expect("a status");
        std::fs::write(dir.join("a.tar.gz"), [0u8; 3_100]).expect("some bytes");
        let downloading = get_json(reading(&dir), "/about").await;
        assert_eq!(
            downloading["update"],
            json!({"step": "downloading", "version": "0.10.0", "received": 3_100, "total": 9_800_000})
        );

        std::fs::write(dir.join("status"), "step=failed\n").expect("a status");
        std::fs::write(
            dir.join("said"),
            "install: a.tar.gz does not match SHA256SUMS — nothing was installed\n",
        )
        .expect("said");
        let failed = get_json(reading(&dir), "/about").await;
        assert_eq!(
            failed["update"],
            json!({"step": "failed", "said": "install: a.tar.gz does not match SHA256SUMS — nothing was installed"})
        );

        std::fs::write(dir.join("status"), "step=rebooting\n").expect("a status");
        let unknown = get_json(reading(&dir), "/about").await;
        assert_eq!(
            unknown["update"],
            Value::Null,
            "an unknown step is not a guess"
        );
    }

    fn looking_at_machines(machines: Vec<MachineInfo>) -> Fleet {
        holding(Snapshot {
            machines: Some(Arc::new(Reading::new(Ok(machines)))),
            ..Snapshot::default()
        })
    }

    /// The route reads and never generates: before `yantra ssh-identity` has
    /// run it is a 404 naming that verb, and afterwards it is the public half
    /// with the fingerprint `ssh-keygen` prints. The private key is not in the
    /// answer, and the directory it would read is a parameter of the fleet.
    #[tokio::test]
    async fn the_identity_is_read_and_never_made_by_a_get() {
        let dir = std::env::temp_dir().join("yantra-api-identity");
        let _ = std::fs::remove_dir_all(&dir);
        let with_dir = |dir: &std::path::Path| Fleet {
            facts: Arc::new(crate::heartbeat::Facts {
                started: std::time::Instant::now(),
                listening_on: vec![
                    "100.64.0.1:7717".parse().expect("an address"),
                    "[fd7a:115c:a1e0::1]:7717".parse().expect("an address"),
                ],
                ssh_dir: dir.to_owned(),
                ssh_state: std::path::PathBuf::new(),
                relay: false,
                trigger: std::path::PathBuf::new(),
                updater: std::path::PathBuf::new(),
                progress: std::path::PathBuf::new(),
                channel: std::path::PathBuf::new(),
            }),
            ..Fleet::default()
        };

        let (status, body) = get(with_dir(&dir), "/ssh-identity").await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert!(
            body["error"]
                .as_str()
                .is_some_and(|e| e.contains("yantra ssh-identity")),
            "{body}"
        );
        assert!(!dir.exists(), "a GET made a key");

        let prepared = yantra_core::identity::prepare_in(&dir, &[]).expect("a key");
        let body = get_json(with_dir(&dir), "/ssh-identity").await;
        assert_eq!(body["path"], json!(prepared.key.display().to_string()));
        assert_eq!(body["kind"], json!("ed25519"));
        assert_eq!(body["public_key"], json!(prepared.public_key));
        assert!(
            body["fingerprint"]
                .as_str()
                .is_some_and(|f| f.starts_with("SHA256:")),
            "{body}"
        );
        assert_eq!(
            body["owner_line"],
            json!(format!(
                "from=\"100.64.0.1,fd7a:115c:a1e0::1\" {}",
                prepared.public_key
            ))
        );
        assert!(!body.to_string().contains("PRIVATE"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ADR-0025 §3 on the wire: a fresh daemon answers an empty list under
    /// `ok`, which is the state stated rather than hidden, and what is
    /// remembered comes back newest first.
    #[tokio::test]
    async fn notifications_are_empty_after_a_start_and_newest_first_after_that() {
        let fleet = Fleet::default();
        let body = get_json(fleet.clone(), "/notifications").await;
        assert_eq!(body, json!({"looked": "ok", "age_seconds": 0, "data": []}));

        events::remember(&fleet.events, Event::unreachable("pi")).await;
        events::remember(&fleet.events, Event::relay_test()).await;

        let body = get_json(fleet, "/notifications").await;
        assert_eq!(body["data"][0]["kind"], json!("relay-test"));
        assert_eq!(body["data"][1]["kind"], json!("unreachable"));
        assert_eq!(body["data"][1]["machine"], json!("pi"));
        assert_eq!(body["data"][1]["workspace"], Value::Null);
        assert!(body["data"][1]["at"].as_u64().is_some());
        assert!(body["data"][1]["said"].as_str().is_some());
    }

    /// Y-512: the watch's memory on the wire, with what each check and
    /// reviewer wrote, and an empty list when nothing is watched.
    #[tokio::test]
    async fn pulls_serve_what_the_watch_holds() {
        let body = get_json(Fleet::default(), "/pulls").await;
        assert_eq!(body, json!({"looked": "ok", "age_seconds": 0, "data": []}));

        let fleet = Fleet {
            pulls: crate::watch::tests::watching_one().await,
            ..Fleet::default()
        };
        let body = get_json(fleet, "/pulls").await;
        assert_eq!(
            body["data"][0],
            json!({
                "workspace": "api",
                "url": "https://github.com/o/r/pull/21",
                "number": 21,
                "head_sha": "aaa111",
                "summary": "failed",
                "checks": [
                    {"name": "test", "status": "completed", "conclusion": "failure",
                     "output": {"title": "1 failed", "summary": "`watch::look` panicked"}},
                    {"name": "lint", "status": "completed", "conclusion": "success",
                     "output": {"title": "Clean", "summary": ""}},
                ],
                "reviews": [
                    {"id": 7, "author": "friend", "state": "CHANGES_REQUESTED",
                     "body": "Please add a test."},
                ],
                "comments": [
                    {"id": 31, "author": "friend", "path": "src/watch.rs", "line": 12,
                     "body": "This drops the etag."},
                ],
            })
        );
    }

    /// M4 reads and nothing else. A write route is where Q6's absent auth stops
    /// being free (R-22), so the refusal is the thing worth asserting.
    #[tokio::test]
    async fn nothing_here_accepts_a_write() {
        for path in [
            "/machines",
            "/workspaces/api/status",
            "/about",
            "/notifications",
            "/pulls",
        ] {
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

    /// Y-710: only a tailnet peer's unresolved name is the resolver's fault.
    #[test]
    fn an_unresolved_tailnet_peer_names_the_resolver_fix() {
        let snapshot = Snapshot {
            machines: Some(Arc::new(Reading::new(Ok(vec![machine(
                "n1",
                "yantra-box",
                true,
            )])))),
            ..Snapshot::default()
        };
        let report = |name: &str| doctor::Report {
            machine: name.to_owned(),
            checks: vec![doctor::Check {
                check: "reachable",
                state: doctor::State::Absent,
                detail: format!(
                    "this host could not resolve the machine's name: ssh: Could not resolve \
                     hostname {name}: Name or service not known"
                ),
                took_ms: None,
            }],
        };
        let detail = |name: &str| {
            answered(&report(name), &snapshot, &BTreeMap::new()).checks[0]
                .detail
                .clone()
        };

        let peer = detail("yantra-box");
        assert!(
            peer.starts_with("this host cannot resolve tailnet names"),
            "{peer}"
        );
        assert!(peer.contains("100.100.100.100"), "{peer}");

        assert_eq!(detail("elsewhere"), report("elsewhere").checks[0].detail);
    }
}
