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
use std::net::{IpAddr, SocketAddr};
use yantra_core::heartbeat::{Heartbeat, Power};
use yantra_core::snapshot::{Reading, Snapshot};
use yantra_core::status::{MachineStatus, Verdict};
use yantra_core::{about, doctor, identity};

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
        .route("/about", get(about))
        .route("/ssh-identity", get(ssh_identity))
        .route("/notifications", get(notifications))
        .route("/github", get(connection))
        .route("/repos", get(repos))
        .fallback(no_such_route)
}

/// `yantra about` on the wire, plus what only a running daemon knows: how long
/// it has been up and where it listens. No ssh and no network — the tailnet
/// name is read off the machines look, for the node holding a bound address.
async fn about(State(fleet): State<Fleet>) -> Json<About> {
    let snapshot = fleet.model.read().await.clone();
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
    })
}

/// The tailnet is `DNSName` past this node's own label. Which node is this one
/// is answered by the addresses `listen_on` bound — the same join the
/// heartbeat makes, in the other direction.
fn tailnet(snapshot: &Snapshot, listening_on: &[SocketAddr]) -> Option<String> {
    let machines = snapshot.machines.as_deref()?.value().as_ref().ok()?;
    let bound: Vec<IpAddr> = listening_on
        .iter()
        .map(|address| address.ip().to_canonical())
        .collect();
    let me = machines.iter().find(|machine| {
        machine
            .addresses
            .iter()
            .any(|held| bound.contains(&held.to_canonical()))
    })?;
    let (_, tailnet) = me.dns_name.trim_end_matches('.').split_once('.')?;
    Some(tailnet.to_owned())
}

/// `yantra ssh-identity`'s read half. **A 404 and never a key**: the CLI verb
/// generates one when there is none, and a route a browser opens must not —
/// `identity.rs` says invoked, never automatic. The private half is not read.
async fn ssh_identity(State(fleet): State<Fleet>) -> Response {
    let dir = fleet.facts.ssh_dir.clone();
    // `ssh-keygen -l` is a subprocess, so off the worker (I-13).
    let described = tokio::task::spawn_blocking(move || identity::describe_in(&dir)).await;
    match described {
        Ok(Ok(Some(identity))) => Json(SshIdentity::of(&identity)).into_response(),
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            Json(Missing {
                error: "no ssh identity yet — `yantra ssh-identity` on the daemon's machine prepares one"
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
async fn machines(State(model): State<Model>, State(beats): State<Beats>) -> impl IntoResponse {
    let snapshot = model.read().await.clone();
    let beats = beats.read().await;
    Json(Answer::of(snapshot.machines.as_deref(), |machines| {
        machines
            .iter()
            .map(|machine| Machine::of(machine, &beats))
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
async fn readiness(State(model): State<Model>, State(beats): State<Beats>) -> impl IntoResponse {
    let snapshot = model.read().await.clone();
    let beats = beats.read().await;
    Json(Answer::of(snapshot.readiness.as_deref(), |reports| {
        reports
            .iter()
            .map(|report| answered(report, &snapshot, &beats))
            .collect::<Vec<_>>()
    }))
}

/// `yantra ls attention` on the wire. The reading is `refresh.rs`'s, and it is
/// polled slower than the fleet because the quota it spends is GitHub's — a
/// handler that ran `gh` would spend it once per browser instead.
async fn attention(State(model): State<Model>) -> impl IntoResponse {
    let snapshot = model.read().await.clone();
    Json(Answer::of(snapshot.attention.as_deref(), Attention::of))
}

/// The second route naming a resource, so it has [`workspace_status`]'s fourth
/// answer for the same reason: a machine the sweep did not cover is a **404**
/// rather than a 200 whose absence a client has to notice. The sweep asks the
/// machines workspaces name ([`yantra_core::doctor::fleet`]), which is not every
/// machine on the tailnet.
async fn machine_readiness(
    State(model): State<Model>,
    State(beats): State<Beats>,
    Path(name): Path<String>,
) -> Response {
    let snapshot = model.read().await.clone();
    let beats = beats.read().await;
    let Some(reading) = snapshot.readiness.as_deref() else {
        return Json(Answer::<doctor::Report>::Never).into_response();
    };
    let age_seconds = reading.age().as_secs();
    let reports = match reading.value() {
        Ok(reports) => reports,
        Err(error) => {
            return Json(Answer::<doctor::Report>::Failed {
                age_seconds,
                error: because(error),
            })
            .into_response();
        }
    };
    match reports.iter().find(|report| report.machine == name) {
        Some(report) => Json(Answer::Ok {
            age_seconds,
            data: answered(report, &snapshot, &beats),
        })
        .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(Missing {
                error: format!("no workspace names a machine called `{name}`, so none was asked"),
            }),
        )
            .into_response(),
    }
}

/// The readiness reading about **this** machine (Y-175). The sweep above asks
/// the machines workspaces name over ssh; the GitHub credential the work inbox
/// reads is the one where `yantrad` runs, because
/// [`yantra_core::attention`] spawns `gh` here. **A route rather than a tenth
/// check on every report**: a check copied onto each machine's card would claim
/// something no ssh session asked, which is the answer R-23 forbids.
///
/// There is no `failed`: the check carries a look it could not take as
/// *unknown*, so the only two answers are the reading and nobody having looked.
async fn github(State(model): State<Model>) -> impl IntoResponse {
    let snapshot = model.read().await.clone();
    Json(match snapshot.github.as_deref() {
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
/// login is the one thing about the account that is shown.
async fn connection(State(grant): State<Grant>) -> impl IntoResponse {
    Json(Connection::of(&grant.read().await))
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

/// The library answers `heartbeat` *unknown* from every caller it has, and that
/// is the architecture rather than a gap: the beats are in this process and
/// nothing persists them (Y-044), while ADR-0012 keeps the CLI out of it. This
/// is the daemon filling in its own check.
///
/// [`crate::write`]'s re-check calls it too, so a report a person asked for
/// carries the same nine answers as the swept one and not eight plus an
/// *unknown* the daemon could have filled in.
pub(crate) fn answered(
    report: &doctor::Report,
    snapshot: &Snapshot,
    beats: &BTreeMap<String, Reading<Heartbeat>>,
) -> doctor::Report {
    doctor::Report {
        machine: report.machine.clone(),
        checks: report
            .checks
            .iter()
            .map(|check| match check.check {
                doctor::HEARTBEAT => heard_from(&report.machine, snapshot, beats),
                _ => check.clone(),
            })
            .collect(),
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
fn heard_from(
    machine: &str,
    snapshot: &Snapshot,
    beats: &BTreeMap<String, Reading<Heartbeat>>,
) -> doctor::Check {
    let says = |state, detail: String| doctor::Check {
        check: doctor::HEARTBEAT,
        state,
        detail,
    };
    let Some(id) = node_id(machine, snapshot) else {
        return says(
            doctor::State::Unknown,
            "no tailnet node here answers to that name, so whether it has beaten is not known"
                .to_owned(),
        );
    };
    match beats.get(id) {
        Some(reading) => says(
            doctor::State::Present,
            format!("a beat arrived {}s ago", reading.age().as_secs()),
        ),
        None => says(
            doctor::State::Absent,
            "nothing has beaten from that machine since this daemon started — is `yantra-agent` \
             running there?"
                .to_owned(),
        ),
    }
}

fn node_id<'a>(machine: &str, snapshot: &'a Snapshot) -> Option<&'a str> {
    let machines = snapshot.machines.as_deref()?.value().as_ref().ok()?;
    machines
        .iter()
        .find(|one| one.name == machine)
        .map(|one| one.id.as_str())
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
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct SshIdentity {
    pub(crate) path: String,
    pub(crate) kind: String,
    pub(crate) public_key: String,
    pub(crate) fingerprint: String,
}

impl SshIdentity {
    fn of(identity: &identity::Identity) -> Self {
        Self {
            path: identity.path.display().to_string(),
            kind: identity.kind.clone(),
            public_key: identity.public_key.clone(),
            fingerprint: identity.fingerprint.clone(),
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
    /// I-39: an expired key is a third state. Such a machine can be powered on,
    /// listed, and still unreachable — which a green dot would erase.
    expired: bool,
    last_seen: Option<String>,
    /// **`null` is *never heard from*** — I-47 again, and the state a zeroed
    /// row would erase. `online` beside it is what tells the two explanations
    /// of a missing beat apart, and it never decides whether one arrived (R-8).
    heartbeat: Option<Beat>,
}

impl Machine {
    /// Keyed on the node id (I-5), which is the only stable key and is the one
    /// thing here a reader never sees.
    fn of(
        machine: &yantra_core::inventory::MachineInfo,
        beats: &BTreeMap<String, Reading<Heartbeat>>,
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
            expired: machine.expired,
            last_seen: machine.last_seen.clone(),
            heartbeat: beats.get(&machine.id).map(Beat::of),
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

/// The two answers on this seam that the router cannot render deterministically
/// — a build date and a key on the daemon's own disk — built for
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
/// `pending` is a device flow waiting for its code to be typed.
#[derive(Debug, serde::Serialize)]
struct Connection {
    connected: bool,
    login: Option<String>,
    scopes: Vec<String>,
    pending: bool,
}

impl Connection {
    fn of(held: &crate::github::Held) -> Self {
        Self {
            connected: held.token.is_some(),
            login: held.login.clone(),
            scopes: held.scopes.clone(),
            pending: held.pending,
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

    async fn get_json(fleet: Fleet, path: &str) -> Value {
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
            id: id.into(),
            name: name.into(),
            dns_name: format!("{name}.example.ts.net."),
            os: Os::Linux,
            online,
            last_seen: None,
            expired: false,
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
            "/repos",
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
                addresses: vec!["100.64.0.4".parse().expect("a v4 address")],
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
                },
                doctor::Check {
                    check: doctor::HEARTBEAT,
                    state: doctor::State::Unknown,
                    detail: "only the running daemon holds the beats".into(),
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
        let fleet = holding(Snapshot {
            machines: Some(Arc::new(Reading::new(Ok(machines)))),
            readiness: Some(Arc::new(Reading::new(Ok(reports)))),
            ..Snapshot::default()
        });
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
        let beating = &body["data"][0]["checks"][1];
        assert_eq!(beating["check"], "heartbeat", "{body}");
        assert_eq!(beating["state"], "present", "{beating}");
        let silent = &body["data"][1]["checks"][1];
        assert_eq!(silent["state"], "absent", "{silent}");
        assert!(
            silent["detail"]
                .as_str()
                .is_some_and(|d| d.contains("yantra-agent")),
            "{silent}"
        );
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

    /// The two shapes the page draws: nobody signed in, and a grant with its
    /// login. `null` for a login not yet learned is a state, not an absence
    /// — and the token is in neither.
    #[tokio::test]
    async fn the_connection_says_whether_a_grant_is_held_and_never_what_it_is() {
        let none = get_json(holding(Snapshot::default()), "/github").await;
        assert_eq!(
            none,
            json!({"connected": false, "login": null, "scopes": [], "pending": false})
        );

        let fleet = Fleet {
            github: Grant::holding(Some(yantra_core::github::Token::new(
                "gho_notarealtoken".into(),
            ))),
            ..holding(Snapshot::default())
        };
        fleet.github.learned("octocat".into()).await;

        let held = get_json(fleet, "/github").await;
        assert_eq!(held["connected"], true, "{held}");
        assert_eq!(held["login"], "octocat", "{held}");
        assert_eq!(held["pending"], false, "{held}");
        assert!(!held.to_string().contains("gho_"), "{held}");
    }

    /// The check that is about this host, served under its own name and its own
    /// age — it is nowhere in the per-machine reports, because no ssh session
    /// asked it.
    #[tokio::test]
    async fn the_daemons_own_github_credential_is_answered_apart_from_the_fleet() {
        let fleet = holding(Snapshot {
            github: Some(Arc::new(Reading::new(doctor::Check {
                check: doctor::GITHUB,
                state: doctor::State::Absent,
                detail: "`gh` here holds no credential".into(),
            }))),
            readiness: Some(Arc::new(Reading::new(Ok(vec![checked("cachyos-g14")])))),
            ..Snapshot::default()
        });

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

        let unlooked = get_json(holding(Snapshot::default()), "/about").await;
        assert_eq!(unlooked["tailnet"], Value::Null, "no look, no guess");
        assert_eq!(unlooked["listening_on"], json!([]));
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
                listening_on: Vec::new(),
                ssh_dir: dir.to_owned(),
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

    /// M4 reads and nothing else. A write route is where Q6's absent auth stops
    /// being free (R-22), so the refusal is the thing worth asserting.
    #[tokio::test]
    async fn nothing_here_accepts_a_write() {
        for path in [
            "/machines",
            "/workspaces/api/status",
            "/about",
            "/notifications",
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
}
