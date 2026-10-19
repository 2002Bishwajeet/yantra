//! `POST /api/placement`: which of the owner's machines a new session should
//! open on, and why (Y-517).
//!
//! **A read reached over a `POST`, on [ADR-0019]'s licence**: a person picked
//! the repository or folder, and nothing polls it. It asks over ssh only the
//! machines whose beat is fresh, each for at most [`ASK`]. A machine that does
//! not answer in time is [`Here::Unknown`], which scores 0 and filters nothing.
//!
//! The daemon persists nothing (Y-044), so "where it ran" is a workspace in the
//! read model on that machine that names the same repository or folder.
//!
//! [ADR-0019]: ../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md

use std::collections::BTreeMap;
use std::future::Future;
use std::net::SocketAddr;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use tokio::task::JoinSet;
use yantra_core::dirs::{self, Kind, Listing};
use yantra_core::inventory::{Inventory, Ownership};
use yantra_core::placement::{self, Beat, Candidate, Here, Ranking, Scored, Why};
use yantra_core::probe;
use yantra_core::workspace::Workspace;

use crate::heartbeat::Fleet;
use crate::write::{Authoriser, Refused, allowed, chain};

/// How long one machine has to answer. A slow machine is `Unknown`, never a wait.
const ASK: Duration = Duration::from_secs(5);

/// What a session will open, as one machine is asked about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// `owner/name`, and the folder this browser remembers for the machine.
    Repo {
        slug: String,
        folder: Option<String>,
    },
    Path(String),
}

/// Asks one machine whether it holds the target. A test fakes it.
pub type Find =
    Arc<dyn Fn(String, Target) -> Pin<Box<dyn Future<Output = Here> + Send>> + Send + Sync>;

#[derive(Clone)]
struct Placer<I> {
    authoriser: Authoriser<I>,
    fleet: Fleet,
    find: Find,
}

pub fn router<I, S>(authoriser: Authoriser<I>, fleet: Fleet) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    routes(
        authoriser,
        fleet,
        Arc::new(|machine, target| Box::pin(async move { look(&machine, &target).await })),
    )
}

fn routes<I, S>(authoriser: Authoriser<I>, fleet: Fleet, find: Find) -> Router<S>
where
    I: Inventory + Clone + Send + Sync + 'static,
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/placement", post(place::<I>))
        .with_state(Placer {
            authoriser,
            fleet,
            find,
        })
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Asked {
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    path: Option<String>,
    /// Machine to clone folder, as the browser remembers them. These win.
    #[serde(default)]
    folders: BTreeMap<String, String>,
}

/// Neither field is a valid request, ranked on the heartbeat terms alone.
enum Wanted {
    Nothing,
    Repo(String),
    Path(String),
}

impl Asked {
    fn wanted(&self) -> Result<Wanted, Refused> {
        let bad = |said: &str| Refused::Verb {
            status: StatusCode::BAD_REQUEST,
            said: said.to_owned(),
        };
        match (&self.repo, &self.path) {
            (Some(_), Some(_)) => Err(bad("ask about a repository or a folder, not both")),
            (Some(repo), None) => match repo.split_once('/') {
                Some((owner, name))
                    if !owner.is_empty() && !name.is_empty() && !name.contains('/') =>
                {
                    Ok(Wanted::Repo(repo.clone()))
                }
                _ => Err(bad("`repo` is `owner/name`")),
            },
            (None, Some(path)) if path.trim().is_empty() => Err(bad("`path` is empty")),
            (None, Some(path)) => Ok(Wanted::Path(path.clone())),
            (None, None) => Ok(Wanted::Nothing),
        }
    }

    fn target(&self, wanted: &Wanted, machine: &str) -> Option<Target> {
        match wanted {
            Wanted::Nothing => None,
            Wanted::Repo(slug) => Some(Target::Repo {
                slug: slug.clone(),
                folder: self.folders.get(machine).cloned(),
            }),
            Wanted::Path(path) => Some(Target::Path(path.clone())),
        }
    }
}

async fn place<I: Inventory + Clone + Send + Sync + 'static>(
    State(placer): State<Placer<I>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Option<Json<Asked>>,
) -> Result<Json<Placed>, Refused> {
    allowed(&placer.authoriser, from.ip(), &headers).await?;
    let asked = body.map(|Json(asked)| asked).unwrap_or_default();
    let wanted = asked.wanted()?;

    let snapshot = placer.fleet.model.read().await.clone();
    let unavailable = |said: String| Refused::Verb {
        status: StatusCode::SERVICE_UNAVAILABLE,
        said,
    };
    let machines = match snapshot.machines.as_deref().map(|reading| reading.value()) {
        None => {
            return Err(unavailable(
                "yantrad has not looked at the tailnet yet; try again in a few seconds".to_owned(),
            ));
        }
        Some(Err(error)) => return Err(unavailable(chain(error))),
        Some(Ok(machines)) => machines,
    };
    let workspaces: &[Workspace] = match snapshot.workspaces.as_deref().map(|r| r.value()) {
        Some(Ok(listing)) => &listing.workspaces,
        _ => &[],
    };

    let beats = placer.fleet.beats.read().await;
    let mut candidates: Vec<Candidate> = machines
        .iter()
        .filter(|machine| machine.ownership == Ownership::Yours)
        .map(|machine| Candidate {
            machine: machine.name.clone(),
            online: machine.online,
            beat: beats
                .get(&machine.id)
                .map(|reading| Beat::of(reading.value(), reading.age())),
            repo: Here::Unknown,
            ran_here: ran_here(workspaces, &machine.name, &wanted),
        })
        .collect();
    drop(beats);

    let mut asking = JoinSet::new();
    for candidate in &candidates {
        let fresh = candidate
            .beat
            .is_some_and(|beat| beat.age <= placement::FRESH);
        if let (true, Some(target)) = (fresh, asked.target(&wanted, &candidate.machine)) {
            let machine = candidate.machine.clone();
            let find = (placer.find)(machine.clone(), target);
            asking.spawn(async move {
                let here = tokio::time::timeout(ASK, find)
                    .await
                    .unwrap_or(Here::Unknown);
                (machine, here)
            });
        }
    }
    let mut found: BTreeMap<String, Here> = asking.join_all().await.into_iter().collect();
    for candidate in &mut candidates {
        if let Some(here) = found.remove(&candidate.machine) {
            candidate.repo = here;
        }
    }

    Ok(Json(Placed::of(&placement::rank(candidates))))
}

/// A repository matches on the path's last segment, a folder on the whole path.
fn ran_here(workspaces: &[Workspace], machine: &str, wanted: &Wanted) -> bool {
    workspaces
        .iter()
        .filter(|one| one.machine.eq_ignore_ascii_case(machine))
        .any(|one| match wanted {
            Wanted::Nothing => false,
            Wanted::Repo(slug) => {
                let name = slug.rsplit('/').next().unwrap_or_default();
                one.repo
                    .file_name()
                    .and_then(|last| last.to_str())
                    .is_some_and(|last| last.eq_ignore_ascii_case(name))
            }
            Wanted::Path(path) => one.repo == Path::new(path.trim_end_matches('/')),
        })
}

/// The real [`Find`]: a probe for a folder, and for a repository a listing of
/// the clone folder, found as `web/src/screens/new-session/clonePath.ts` finds it.
async fn look(machine: &str, target: &Target) -> Here {
    match target {
        Target::Path(path) => match probe::probe(machine, path).await {
            Ok(found) if found.exists => Here::Yes(found.path),
            Ok(_) => Here::No,
            Err(_) => Here::Unknown,
        },
        Target::Repo { slug, folder } => {
            let folder = match folder {
                Some(folder) => Some(folder.clone()),
                None => match clone_folder(machine).await {
                    Ok(folder) => folder,
                    Err(_) => return Here::Unknown,
                },
            };
            let Some(folder) = folder else {
                return Here::No;
            };
            match dirs::list(machine, Some(&folder)).await {
                Ok(listing) => holding(&listing, slug).map_or(Here::No, Here::Yes),
                Err(dirs::Error::NotADirectory { .. }) => Here::No,
                Err(_) => Here::Unknown,
            }
        }
    }
}

/// `~/Github` before `~/Documents/Github`, in any letter case.
async fn clone_folder(machine: &str) -> Result<Option<String>, dirs::Error> {
    let home = dirs::list(machine, None).await?;
    if let Some(folder) = folder_named(&home, "github") {
        return Ok(Some(folder));
    }
    let Some(documents) = folder_named(&home, "documents") else {
        return Ok(None);
    };
    Ok(folder_named(
        &dirs::list(machine, Some(&documents)).await?,
        "github",
    ))
}

fn folder_named(listing: &Listing, name: &str) -> Option<String> {
    listing
        .entries
        .iter()
        .find(|one| one.kind == Kind::Dir && one.access && one.name.eq_ignore_ascii_case(name))
        .map(|one| one.path.clone())
}

/// The entry whose origin is `slug`, in any letter case.
fn holding(listing: &Listing, slug: &str) -> Option<String> {
    listing
        .entries
        .iter()
        .find(|one| {
            one.origin
                .as_deref()
                .is_some_and(|origin| slug_of(origin).eq_ignore_ascii_case(slug))
        })
        .map(|one| one.path.clone())
}

/// `git@github.com:o/n.git` and `https://github.com/o/n` are both `o/n`, as in
/// `web/src/screens/new-session/form.ts`.
fn slug_of(origin: &str) -> String {
    let tail = origin.trim_end_matches('/');
    let tail = tail.strip_suffix(".git").unwrap_or(tail);
    let parts: Vec<&str> = tail.split(['/', ':']).collect();
    parts[parts.len().saturating_sub(2)..].join("/")
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct Placed {
    ranked: Vec<Ranked>,
    rejected: Vec<Rejected>,
}

#[derive(Debug, serde::Serialize)]
struct Ranked {
    machine: String,
    score: f64,
    terms: Terms,
    reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

/// I-10: every term that moves the rank, so the page can show each one.
#[derive(Debug, serde::Serialize)]
struct Terms {
    ram: f64,
    cpu: f64,
    power: f64,
    repo: f64,
    affinity: f64,
}

#[derive(Debug, serde::Serialize)]
struct Rejected {
    machine: String,
    why: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    age_seconds: Option<u64>,
}

impl Placed {
    fn of(ranking: &Ranking) -> Self {
        Self {
            ranked: ranking.ranked.iter().map(Ranked::of).collect(),
            rejected: ranking
                .rejected
                .iter()
                .map(|one| {
                    let (why, age) = match one.why {
                        Why::NeverHeard => ("never_heard", None),
                        Why::NotReporting { age } => ("not_reporting", Some(age)),
                        Why::AsleepOrOff { age } => ("asleep_or_off", age),
                    };
                    Rejected {
                        machine: one.machine.clone(),
                        why,
                        age_seconds: age.map(|age| age.as_secs()),
                    }
                })
                .collect(),
        }
    }
}

impl Ranked {
    fn of(scored: &Scored) -> Self {
        let t = &scored.terms;
        Self {
            machine: scored.machine.clone(),
            score: scored.score,
            terms: Terms {
                ram: t.ram,
                cpu: t.cpu,
                power: t.power,
                repo: t.repo,
                affinity: t.affinity,
            },
            reason: placement::reason(scored),
            path: scored.path.clone(),
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
pub(crate) fn answers() -> Vec<(&'static str, &'static str, serde_json::Value)> {
    use yantra_core::heartbeat::Power;
    let beat = |free_ram_mb, cpu_busy_pct| {
        Some(Beat {
            age: Duration::from_secs(3),
            free_ram_mb,
            cpu_busy_pct,
            power: Power::Ac,
        })
    };
    let ranking = placement::rank(vec![
        Candidate {
            machine: "cachyos-g14".to_owned(),
            online: true,
            beat: beat(19_968, 15),
            repo: Here::Yes("/home/<user>/Github/yantra".to_owned()),
            ran_here: true,
        },
        Candidate {
            machine: "pi".to_owned(),
            online: true,
            beat: beat(2_048, 60),
            repo: Here::No,
            ran_here: false,
        },
        Candidate {
            machine: "bishwajeets-macbook-pro".to_owned(),
            online: false,
            beat: None,
            repo: Here::Unknown,
            ran_here: false,
        },
        Candidate {
            machine: "winbox".to_owned(),
            online: true,
            beat: Some(Beat {
                age: Duration::from_secs(45),
                free_ram_mb: 8_192,
                cpu_busy_pct: 5,
                power: Power::Ac,
            }),
            repo: Here::Unknown,
            ran_here: false,
        },
    ]);
    vec![(
        "placement",
        "Placement",
        serde_json::to_value(Placed::of(&ranking)).expect("a DTO of owned strings and numbers"),
    )]
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, header};
    use std::net::IpAddr;
    use std::sync::Mutex;
    use tower::ServiceExt as _;
    use yantra_core::heartbeat::{Heartbeat, Power};
    use yantra_core::inventory::{Caller, Fake, MachineInfo, Os};
    use yantra_core::snapshot::{Reading, Snapshot};
    use yantra_core::workspace::Listing as Workspaces;

    const ME: u64 = 1;
    const MINE: [u8; 4] = [100, 64, 0, 2];
    const STRANGER: [u8; 4] = [100, 64, 0, 3];

    fn machine(id: &str, name: &str, online: bool, ownership: Ownership) -> MachineInfo {
        MachineInfo {
            id: id.to_owned(),
            name: name.to_owned(),
            dns_name: format!("{name}.ts.net."),
            os: Os::Linux,
            online,
            last_seen: None,
            expired: false,
            key_expires: None,
            addresses: Vec::new(),
            ownership,
        }
    }

    fn heartbeat(free_ram_mb: u64, cpu_busy_pct: u8) -> Heartbeat {
        Heartbeat {
            sent_at: time::OffsetDateTime::now_utc(),
            arch: "x86_64".to_owned(),
            labels: Vec::new(),
            free_ram_mb,
            free_disk_mb: 1,
            cpu_busy_pct,
            power: Power::Ac,
        }
    }

    /// `beats` maps node ids to (free RAM, CPU busy); a node absent from it has never beaten.
    async fn fleet(
        machines: Vec<MachineInfo>,
        beats: &[(&str, u64, u8)],
        workspaces: Vec<Workspace>,
    ) -> Fleet {
        let fleet = Fleet {
            model: Arc::new(tokio::sync::RwLock::new(Snapshot {
                machines: Some(Arc::new(Reading::new(Ok(machines)))),
                workspaces: Some(Arc::new(Reading::new(Ok(Workspaces {
                    workspaces,
                    unusable: Vec::new(),
                })))),
                ..Snapshot::default()
            })),
            ..Fleet::default()
        };
        let mut held = fleet.beats.write().await;
        for (id, ram, cpu) in beats {
            held.insert((*id).to_owned(), Reading::new(heartbeat(*ram, *cpu)));
        }
        drop(held);
        fleet
    }

    type Asks = Arc<Mutex<Vec<(String, Target)>>>;

    /// Answers `Yes` for the machines in `holders` and records every ask.
    fn finder(holders: &'static [(&'static str, &'static str)]) -> (Find, Asks) {
        let asks = Asks::default();
        let seen = asks.clone();
        let find: Find = Arc::new(move |machine, target| {
            seen.lock()
                .expect("not poisoned")
                .push((machine.clone(), target));
            Box::pin(async move {
                holders
                    .iter()
                    .find(|(name, _)| *name == machine)
                    .map_or(Here::No, |(_, path)| Here::Yes((*path).to_owned()))
            })
        });
        (find, asks)
    }

    async fn send(
        fleet: Fleet,
        find: Find,
        body: Option<serde_json::Value>,
        from: [u8; 4],
    ) -> (StatusCode, serde_json::Value) {
        let me = Caller {
            node: "nSOME000000011CNTRL".to_owned(),
            user: ME,
            tags: Vec::new(),
        };
        let stranger = Caller {
            node: "nOTHER00000011CNTRL".to_owned(),
            user: ME + 1,
            tags: Vec::new(),
        };
        let fake = Fake {
            machines: Vec::new(),
            addresses: Vec::new(),
            callers: [(IpAddr::from(MINE), me), (IpAddr::from(STRANGER), stranger)]
                .into_iter()
                .collect(),
            owner: ME,
        };
        let app: Router = routes(Authoriser::new(fake, &[]), fleet, find);
        let mut request = Request::post("/placement");
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
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("the body is in memory");
        let value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(&bytes).into()));
        (status, value)
    }

    fn names(placed: &serde_json::Value) -> Vec<&str> {
        placed["ranked"]
            .as_array()
            .expect("a ranked list")
            .iter()
            .map(|one| one["machine"].as_str().expect("a name"))
            .collect()
    }

    #[tokio::test]
    async fn with_no_target_a_tie_goes_to_the_name_and_no_machine_is_asked() {
        let fleet = fleet(
            vec![
                machine("n-2", "zeta", true, Ownership::Yours),
                machine("n-1", "alpha", true, Ownership::Yours),
            ],
            &[("n-1", 8_192, 50), ("n-2", 8_192, 50)],
            Vec::new(),
        )
        .await;
        let (find, asks) = finder(&[]);
        let (status, placed) = send(fleet, find, None, MINE).await;
        assert_eq!(status, StatusCode::OK, "{placed}");
        assert_eq!(names(&placed), ["alpha", "zeta"]);
        assert_eq!(placed["ranked"][0]["score"], 27.5);
        assert_eq!(placed["ranked"][0]["terms"]["repo"], 0.0);
        assert!(placed["ranked"][0].get("path").is_none());
        assert!(asks.lock().expect("not poisoned").is_empty());
    }

    #[tokio::test]
    async fn an_asleep_machine_and_a_silent_one_are_rejected_and_never_asked() {
        let fleet = fleet(
            vec![
                machine("n-1", "awake", true, Ownership::Yours),
                machine("n-2", "asleep", false, Ownership::Yours),
                machine("n-3", "silent", true, Ownership::Yours),
                machine("n-4", "theirs", true, Ownership::Shared),
            ],
            &[("n-1", 8_192, 0), ("n-4", 32_768, 0)],
            Vec::new(),
        )
        .await;
        let (find, asks) = finder(&[]);
        let (status, placed) = send(
            fleet,
            find,
            Some(serde_json::json!({"repo": "o/yantra"})),
            MINE,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{placed}");
        assert_eq!(names(&placed), ["awake"]);
        assert_eq!(
            placed["rejected"],
            serde_json::json!([
                {"machine": "asleep", "why": "asleep_or_off"},
                {"machine": "silent", "why": "never_heard"},
            ])
        );
        let asked: Vec<String> = asks
            .lock()
            .expect("not poisoned")
            .iter()
            .map(|(machine, _)| machine.clone())
            .collect();
        assert_eq!(asked, ["awake"]);
    }

    #[tokio::test]
    async fn the_machine_holding_the_repo_ranks_first_with_its_path() {
        let fleet = fleet(
            vec![
                machine("n-1", "strong", true, Ownership::Yours),
                machine("n-2", "holder", true, Ownership::Yours),
            ],
            &[("n-1", 32_768, 0), ("n-2", 8_192, 0)],
            vec![Workspace {
                name: "y".to_owned(),
                machine: "holder".to_owned(),
                repo: "/home/b/Github/Yantra".into(),
                startup: None,
            }],
        )
        .await;
        let (find, asks) = finder(&[("holder", "/home/b/Github/Yantra")]);
        let (status, placed) = send(
            fleet,
            find,
            Some(serde_json::json!({"repo": "o/yantra", "folders": {"holder": "/home/b/Github"}})),
            MINE,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{placed}");
        assert_eq!(names(&placed), ["holder", "strong"]);
        let top = &placed["ranked"][0];
        assert_eq!(top["path"], "/home/b/Github/Yantra");
        assert_eq!(top["terms"]["repo"], 30.0);
        assert_eq!(top["terms"]["affinity"], 20.0);
        assert_eq!(
            top["reason"],
            "the repo is there and a workspace ran it there"
        );
        let asks = asks.lock().expect("not poisoned");
        assert!(
            asks.contains(&(
                "holder".to_owned(),
                Target::Repo {
                    slug: "o/yantra".to_owned(),
                    folder: Some("/home/b/Github".to_owned())
                }
            )),
            "{asks:?}"
        );
        assert!(
            asks.contains(&(
                "strong".to_owned(),
                Target::Repo {
                    slug: "o/yantra".to_owned(),
                    folder: None
                }
            )),
            "{asks:?}"
        );
    }

    #[tokio::test]
    async fn a_folder_matches_a_workspace_on_the_whole_path() {
        let fleet = fleet(
            vec![machine("n-1", "box", true, Ownership::Yours)],
            &[("n-1", 0, 100)],
            vec![Workspace {
                name: "w".to_owned(),
                machine: "BOX".to_owned(),
                repo: "/srv/app".into(),
                startup: None,
            }],
        )
        .await;
        let (find, _) = finder(&[]);
        let (_, placed) = send(
            fleet.clone(),
            find.clone(),
            Some(serde_json::json!({"path": "/srv/app/"})),
            MINE,
        )
        .await;
        assert_eq!(placed["ranked"][0]["terms"]["affinity"], 20.0);
        let (_, placed) = send(
            fleet,
            find,
            Some(serde_json::json!({"path": "/srv/other/app"})),
            MINE,
        )
        .await;
        assert_eq!(placed["ranked"][0]["terms"]["affinity"], 0.0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_machine_that_does_not_answer_in_time_is_unknown() {
        let fleet = fleet(
            vec![machine("n-1", "slow", true, Ownership::Yours)],
            &[("n-1", 8_192, 0)],
            Vec::new(),
        )
        .await;
        let find: Find = Arc::new(|_, _| {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                Here::Yes("/never".to_owned())
            })
        });
        let (status, placed) = send(
            fleet,
            find,
            Some(serde_json::json!({"path": "/srv/app"})),
            MINE,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{placed}");
        assert_eq!(names(&placed), ["slow"]);
        assert_eq!(placed["ranked"][0]["terms"]["repo"], 0.0);
    }

    #[tokio::test]
    async fn the_body_is_checked_before_anything_is_asked() {
        let fleet = fleet(Vec::new(), &[], Vec::new()).await;
        for body in [
            serde_json::json!({"repo": "o/n", "path": "/srv"}),
            serde_json::json!({"repo": "yantra"}),
            serde_json::json!({"path": " "}),
            serde_json::json!({"machine": "pi"}),
        ] {
            let (find, asks) = finder(&[]);
            let (status, said) = send(fleet.clone(), find, Some(body.clone()), MINE).await;
            assert!(status.is_client_error(), "{body} → {status} {said}");
            assert!(asks.lock().expect("not poisoned").is_empty());
        }
        let (find, _) = finder(&[]);
        let (status, said) = send(
            fleet,
            find,
            Some(serde_json::json!({"repo": "o/n", "path": "/srv"})),
            MINE,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(said, "ask about a repository or a folder, not both");
    }

    #[tokio::test]
    async fn a_caller_who_is_not_the_owner_is_refused() {
        let fleet = fleet(
            vec![machine("n-1", "box", true, Ownership::Yours)],
            &[("n-1", 8_192, 0)],
            Vec::new(),
        )
        .await;
        let (find, asks) = finder(&[]);
        let (status, _) = send(fleet, find, None, STRANGER).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(asks.lock().expect("not poisoned").is_empty());
    }

    #[tokio::test]
    async fn a_daemon_that_has_not_looked_says_so() {
        let (find, _) = finder(&[]);
        let (status, said) = send(Fleet::default(), find, None, MINE).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            said.as_str().expect("text").contains("has not looked"),
            "{said}"
        );
    }

    fn entry(path: &str, origin: Option<&str>) -> dirs::Entry {
        dirs::Entry {
            path: path.to_owned(),
            name: path.rsplit('/').next().unwrap_or_default().to_owned(),
            kind: Kind::Dir,
            access: true,
            repo: origin.is_some(),
            origin: origin.map(str::to_owned),
        }
    }

    fn listing(entries: Vec<dirs::Entry>) -> Listing {
        Listing {
            machine: "m".to_owned(),
            path: "/home/b".to_owned(),
            access: true,
            entries,
            truncated: false,
        }
    }

    #[test]
    fn the_clone_folder_and_the_repo_are_found_in_any_letter_case() {
        let home = listing(vec![
            entry("/home/b/Documents", None),
            entry("/home/b/GitHub", None),
        ]);
        assert_eq!(
            folder_named(&home, "github").as_deref(),
            Some("/home/b/GitHub")
        );
        assert_eq!(folder_named(&home, "missing"), None);

        let clones = listing(vec![
            entry("/home/b/GitHub/notes", None),
            entry("/home/b/GitHub/site", Some("https://github.com/o/site")),
            entry("/home/b/GitHub/y", Some("git@github.com:O/Yantra.git")),
        ]);
        assert_eq!(
            holding(&clones, "o/yantra").as_deref(),
            Some("/home/b/GitHub/y")
        );
        assert_eq!(
            holding(&clones, "o/site").as_deref(),
            Some("/home/b/GitHub/site")
        );
        assert_eq!(holding(&clones, "o/notes"), None);
    }

    #[test]
    fn an_origin_is_its_last_two_segments() {
        assert_eq!(slug_of("https://github.com/o/n.git"), "o/n");
        assert_eq!(slug_of("git@github.com:o/n"), "o/n");
        assert_eq!(slug_of("https://github.com/o/n/"), "o/n");
        assert_eq!(slug_of("n"), "n");
    }
}
