/*
 * The shape below is T3 Code's, at commit 72d5c32:
 * https://github.com/pingdotgg/t3code/blob/main/packages/client-runtime/src/load-balancing.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 *
 * Kept: a pure function over candidates, and freshness judged by receipt age, never by the
 * sender's clock. Changed: ADR-0013 collects no CPU count and no total RAM, so the score is
 * R5's RAM headroom (20), CPU idle (15) and power (10) over ADR-0013's fields, and there is
 * no CPU or RAM filter. Y-517 adds R5's session affinity (20) and a repo term (30) that
 * stands in the preference rank's place.
 */
//! Ranks the machines whose heartbeat is fresh, and says why each one won or lost (Y-452).
//!
//! I-10: every term that moves the rank is in [`Terms`], and a score is the sum of
//! its terms. Power is a score term and never a filter (ADR-0013 §2). The only
//! filter is a beat within [`FRESH`], and a rejection carries ADR-0013 §7's reason.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinSet;

use crate::dirs::{self, Kind, Listing};
use crate::heartbeat::{Heartbeat, Power};
use crate::probe;
use crate::workspace::Workspace;

/// Three heartbeat intervals, so one lost POST never makes a machine stale (ADR-0013 §7).
pub const FRESH: Duration = Duration::from_secs(30);
const RAM_WEIGHT: f64 = 20.0;
const CPU_WEIGHT: f64 = 15.0;
const POWER_WEIGHT: f64 = 10.0;
const REPO_WEIGHT: f64 = 30.0;
const AFFINITY_WEIGHT: f64 = 20.0;
/// R5 divides headroom by 16 GB, so 16 GB free or more earns the whole RAM weight.
const RAM_FULL_MB: u64 = 16_384;

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub machine: String,
    /// Tailscale's view. It explains a missing beat and never decides feasibility.
    pub online: bool,
    /// `None` is "never heard from".
    pub beat: Option<Beat>,
    /// Whether the repository or folder the session will open is on this machine.
    pub repo: Here,
    /// A workspace on this machine already names that repository or folder.
    pub ran_here: bool,
}

/// `Unknown` is a machine that could not be asked. It scores 0 and never filters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Here {
    /// The path where the machine holds it.
    Yes(String),
    No,
    Unknown,
}

/// The fields of a heartbeat that the score reads, with the age of its *arrival*.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Beat {
    pub age: Duration,
    pub free_ram_mb: u64,
    pub cpu_busy_pct: u8,
    pub power: Power,
}

impl Beat {
    /// `age` is how long ago the daemon received `heartbeat`; its `sent_at` is not read.
    pub fn of(heartbeat: &Heartbeat, age: Duration) -> Self {
        Self {
            age,
            free_ram_mb: heartbeat.free_ram_mb,
            cpu_busy_pct: heartbeat.cpu_busy_pct,
            power: heartbeat.power,
        }
    }
}

/// Each term is its weight times its signal, rounded to one decimal.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Terms {
    pub ram: f64,
    pub cpu: f64,
    pub power: f64,
    pub repo: f64,
    pub affinity: f64,
}

impl Terms {
    fn sum(&self) -> f64 {
        self.ram + self.cpu + self.power + self.repo + self.affinity
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Scored {
    pub machine: String,
    pub score: f64,
    pub terms: Terms,
    /// The raw readings, so a reader can see what each term was made from.
    pub beat: Beat,
    /// Where the machine holds the repository, when [`Here::Yes`].
    pub path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    NeverHeard,
    /// Tailscale sees the machine, but its beat is stale: an agent or install problem.
    NotReporting {
        age: Duration,
    },
    /// `age` is `None` when no beat ever arrived.
    AsleepOrOff {
        age: Option<Duration>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejected {
    pub machine: String,
    pub why: Why,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Ranking {
    /// Best first: score descending, then name ascending.
    pub ranked: Vec<Scored>,
    /// By name.
    pub rejected: Vec<Rejected>,
}

pub fn rank(candidates: Vec<Candidate>) -> Ranking {
    let mut ranking = Ranking::default();
    for Candidate {
        machine,
        online,
        beat,
        repo,
        ran_here,
    } in candidates
    {
        match (beat, online) {
            (Some(beat), _) if beat.age <= FRESH => {
                let terms = terms(&beat, &repo, ran_here);
                let path = match repo {
                    Here::Yes(path) => Some(path),
                    Here::No | Here::Unknown => None,
                };
                ranking.ranked.push(Scored {
                    machine,
                    score: round1(terms.sum()),
                    terms,
                    beat,
                    path,
                });
            }
            (Some(beat), true) => ranking.rejected.push(Rejected {
                machine,
                why: Why::NotReporting { age: beat.age },
            }),
            (beat, false) => ranking.rejected.push(Rejected {
                machine,
                why: Why::AsleepOrOff {
                    age: beat.map(|beat| beat.age),
                },
            }),
            (None, true) => ranking.rejected.push(Rejected {
                machine,
                why: Why::NeverHeard,
            }),
        }
    }
    ranking.ranked.sort_by(order);
    ranking.rejected.sort_by(|a, b| a.machine.cmp(&b.machine));
    ranking
}

fn terms(beat: &Beat, repo: &Here, ran_here: bool) -> Terms {
    let ram = (beat.free_ram_mb as f64 / RAM_FULL_MB as f64).clamp(0.0, 1.0);
    let cpu = 1.0 - f64::from(beat.cpu_busy_pct.min(100)) / 100.0;
    Terms {
        ram: round1(RAM_WEIGHT * ram),
        cpu: round1(CPU_WEIGHT * cpu),
        power: round1(POWER_WEIGHT * power(beat.power)),
        repo: REPO_WEIGHT * f64::from(matches!(repo, Here::Yes(_))),
        affinity: AFFINITY_WEIGHT * f64::from(ran_here),
    }
}

/// A short phrase from the terms that fired, strongest first and at most two:
/// "the repo is there and it is idle".
pub fn reason(scored: &Scored) -> String {
    let t = &scored.terms;
    let said: Vec<&str> = [
        (t.repo > 0.0, "the repo is there"),
        (t.affinity > 0.0, "a workspace ran it there"),
        (t.cpu >= 0.8 * CPU_WEIGHT, "it is idle"),
        (t.ram >= 0.5 * RAM_WEIGHT, "it has RAM to spare"),
        (t.power >= POWER_WEIGHT, "it is on AC power"),
    ]
    .into_iter()
    .filter_map(|(fired, phrase)| fired.then_some(phrase))
    .take(2)
    .collect();
    match said.as_slice() {
        [] => "its beat is fresh".to_owned(),
        phrases => phrases.join(" and "),
    }
}

/// R5's table: AC 1.0; battery above 60 % 0.5; 21–60 % 0.2; 20 % or less 0.0.
fn power(power: Power) -> f64 {
    match power {
        Power::Ac => 1.0,
        Power::Battery { percent } if percent > 60 => 0.5,
        Power::Battery { percent } if percent > 20 => 0.2,
        Power::Battery { .. } => 0.0,
    }
}

/// R5 rounds before any comparison, so float noise cannot reorder two runs.
fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// R5's order with its static priority left out: score descending, then name ascending.
fn order(a: &Scored, b: &Scored) -> Ordering {
    b.score
        .total_cmp(&a.score)
        .then_with(|| a.machine.cmp(&b.machine))
}

/// How long one machine has to answer. A slow machine is `Unknown`, never a wait.
pub const ASK: Duration = Duration::from_secs(5);

/// What a new session will open (Y-517).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wanted {
    /// `owner/name`.
    Repo(String),
    Path(String),
}

impl Wanted {
    pub fn repo(slug: &str) -> Result<Self, &'static str> {
        match slug.split_once('/') {
            Some((owner, name)) if !owner.is_empty() && !name.is_empty() && !name.contains('/') => {
                Ok(Self::Repo(slug.to_owned()))
            }
            _ => Err("`repo` is `owner/name`"),
        }
    }

    pub fn path(path: &str) -> Result<Self, &'static str> {
        if path.trim().is_empty() {
            return Err("`path` is empty");
        }
        Ok(Self::Path(path.to_owned()))
    }
}

/// What one machine is asked about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// `owner/name`, and the machine's clone folder when the caller knows it.
    Repo {
        slug: String,
        folder: Option<String>,
    },
    Path(String),
}

/// Asks one machine whether it holds the target. A test fakes it.
pub type Find =
    Arc<dyn Fn(String, Target) -> Pin<Box<dyn Future<Output = Here> + Send>> + Send + Sync>;

/// The real [`Find`], over ssh.
pub fn find() -> Find {
    Arc::new(|machine, target| Box::pin(async move { look(&machine, &target).await }))
}

/// Fills `repo` and `ran_here` on every candidate. Only a machine with a fresh
/// beat is asked, each for at most [`ASK`]; `folders` maps a machine to its
/// clone folder and wins over the one found on the machine.
pub async fn ask(
    candidates: &mut [Candidate],
    wanted: &Wanted,
    folders: &BTreeMap<String, String>,
    workspaces: &[Workspace],
    find: &Find,
) {
    let mut asking = JoinSet::new();
    for candidate in candidates.iter_mut() {
        candidate.ran_here = ran_here(workspaces, &candidate.machine, wanted);
        if !candidate.beat.is_some_and(|beat| beat.age <= FRESH) {
            continue;
        }
        let target = match wanted {
            Wanted::Repo(slug) => Target::Repo {
                slug: slug.clone(),
                folder: folders.get(&candidate.machine).cloned(),
            },
            Wanted::Path(path) => Target::Path(path.clone()),
        };
        let machine = candidate.machine.clone();
        let found = find(machine.clone(), target);
        asking.spawn(async move {
            let here = tokio::time::timeout(ASK, found)
                .await
                .unwrap_or(Here::Unknown);
            (machine, here)
        });
    }
    let mut found: BTreeMap<String, Here> = asking.join_all().await.into_iter().collect();
    for candidate in candidates {
        if let Some(here) = found.remove(&candidate.machine) {
            candidate.repo = here;
        }
    }
}

/// A repository matches on the path's last segment, a folder on the whole path.
fn ran_here(workspaces: &[Workspace], machine: &str, wanted: &Wanted) -> bool {
    workspaces
        .iter()
        .filter(|one| one.machine.eq_ignore_ascii_case(machine))
        .any(|one| match wanted {
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

/// A probe for a folder, and for a repository a listing of the clone folder,
/// found as `web/src/screens/new-session/clonePath.ts` finds it.
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

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use time::OffsetDateTime;

    fn beat(age: u64, free_ram_mb: u64, cpu_busy_pct: u8, power: Power) -> Option<Beat> {
        Some(Beat {
            age: Duration::from_secs(age),
            free_ram_mb,
            cpu_busy_pct,
            power,
        })
    }

    fn fresh(machine: &str, free_ram_mb: u64, cpu_busy_pct: u8, power: Power) -> Candidate {
        Candidate {
            machine: machine.to_owned(),
            online: true,
            beat: beat(5, free_ram_mb, cpu_busy_pct, power),
            repo: Here::Unknown,
            ran_here: false,
        }
    }

    fn names(ranking: &Ranking) -> Vec<&str> {
        ranking.ranked.iter().map(|s| s.machine.as_str()).collect()
    }

    #[test]
    fn the_highest_score_ranks_first() {
        let ranking = rank(vec![
            fresh("mba", 2_150, 40, Power::Battery { percent: 50 }),
            fresh("zenith", 19_968, 15, Power::Ac),
            fresh("pi5", 4_096, 10, Power::Ac),
        ]);
        assert_eq!(names(&ranking), ["zenith", "pi5", "mba"]);
        let zenith = &ranking.ranked[0];
        assert_eq!(
            zenith.terms,
            Terms {
                ram: 20.0,
                cpu: 12.8,
                power: 10.0,
                repo: 0.0,
                affinity: 0.0,
            }
        );
        assert_eq!(zenith.score, 42.8);
        assert!(ranking.rejected.is_empty());
    }

    #[test]
    fn a_tie_goes_to_the_name_that_sorts_first() {
        let ranking = rank(vec![
            fresh("zeta", 8_192, 50, Power::Ac),
            fresh("alpha", 8_192, 50, Power::Ac),
            fresh("mid", 8_192, 50, Power::Ac),
        ]);
        assert_eq!(names(&ranking), ["alpha", "mid", "zeta"]);
    }

    /// 0.1 + 0.2 is 0.30000000000000004; rounded, both machines are 30.0 and
    /// the name decides, not the noise.
    #[test]
    fn rounding_stops_float_noise_from_reordering() {
        // RAM 20 * 1638/16384 = 1.99951… → 2.0; RAM 20 * 1647/16384 = 2.0105… → 2.0.
        let ranking = rank(vec![
            fresh("b", 1_647, 100, Power::Ac),
            fresh("a", 1_638, 100, Power::Ac),
        ]);
        assert_eq!(ranking.ranked[0].score, ranking.ranked[1].score);
        assert_eq!(names(&ranking), ["a", "b"]);
    }

    #[test]
    fn a_beat_thirty_seconds_old_is_fresh_and_thirty_one_is_not() {
        let at = |age| Candidate {
            machine: format!("m{age}"),
            online: true,
            beat: beat(age, 8_192, 0, Power::Ac),
            repo: Here::Unknown,
            ran_here: false,
        };
        let ranking = rank(vec![at(30), at(31)]);
        assert_eq!(names(&ranking), ["m30"]);
        assert_eq!(
            ranking.rejected,
            [Rejected {
                machine: "m31".to_owned(),
                why: Why::NotReporting {
                    age: Duration::from_secs(31)
                }
            }]
        );
    }

    #[test]
    fn the_power_table_has_its_edges_where_r5_puts_them() {
        assert_eq!(power(Power::Ac), 1.0);
        for (percent, factor) in [
            (100, 0.5),
            (61, 0.5),
            (60, 0.2),
            (21, 0.2),
            (20, 0.0),
            (0, 0.0),
        ] {
            assert_eq!(power(Power::Battery { percent }), factor, "{percent} %");
        }
    }

    /// ADR-0013 §2: a nearly flat laptop is still placed, only lower.
    #[test]
    fn power_is_never_a_filter() {
        let ranking = rank(vec![fresh("flat", 0, 100, Power::Battery { percent: 0 })]);
        assert_eq!(names(&ranking), ["flat"]);
        assert_eq!(ranking.ranked[0].score, 0.0);
    }

    #[test]
    fn each_rejection_carries_adr_0013s_reason() {
        let ranking = rank(vec![
            Candidate {
                machine: "stale-online".to_owned(),
                online: true,
                beat: beat(45, 8_192, 0, Power::Ac),
                repo: Here::Unknown,
                ran_here: false,
            },
            Candidate {
                machine: "stale-offline".to_owned(),
                online: false,
                beat: beat(412, 8_192, 0, Power::Ac),
                repo: Here::Unknown,
                ran_here: false,
            },
            Candidate {
                machine: "silent-offline".to_owned(),
                online: false,
                beat: None,
                repo: Here::Unknown,
                ran_here: false,
            },
            Candidate {
                machine: "silent-online".to_owned(),
                online: true,
                beat: None,
                repo: Here::Unknown,
                ran_here: false,
            },
        ]);
        assert!(ranking.ranked.is_empty());
        let whys: Vec<(&str, Why)> = ranking
            .rejected
            .iter()
            .map(|r| (r.machine.as_str(), r.why))
            .collect();
        assert_eq!(
            whys,
            [
                ("silent-offline", Why::AsleepOrOff { age: None }),
                ("silent-online", Why::NeverHeard),
                (
                    "stale-offline",
                    Why::AsleepOrOff {
                        age: Some(Duration::from_secs(412))
                    }
                ),
                (
                    "stale-online",
                    Why::NotReporting {
                        age: Duration::from_secs(45)
                    }
                ),
            ]
        );
    }

    /// `online: false` with a fresh beat still ranks: Tailscale's view explains
    /// a missing beat and never overrides one that arrived (ADR-0013 §7, R-8).
    #[test]
    fn a_fresh_beat_ranks_whatever_tailscale_says() {
        let ranking = rank(vec![Candidate {
            machine: "m".to_owned(),
            online: false,
            beat: beat(1, 8_192, 0, Power::Ac),
            repo: Here::Unknown,
            ran_here: false,
        }]);
        assert_eq!(names(&ranking), ["m"]);
    }

    #[test]
    fn an_empty_fleet_ranks_nothing_and_rejects_nothing() {
        assert_eq!(rank(Vec::new()), Ranking::default());
    }

    /// A beat sent "an hour ago" by a skewed clock but received now is fresh,
    /// and one sent "now" but received a minute ago is not.
    #[test]
    fn freshness_reads_the_receipt_age_never_sent_at() {
        let now = OffsetDateTime::now_utc();
        let heartbeat = |sent_at| Heartbeat {
            sent_at,
            arch: "x86_64".to_owned(),
            labels: Vec::new(),
            free_ram_mb: 8_192,
            free_disk_mb: 1,
            cpu_busy_pct: 0,
            power: Power::Ac,
        };
        let skewed = Candidate {
            machine: "skewed".to_owned(),
            online: true,
            beat: Some(Beat::of(
                &heartbeat(now - time::Duration::hours(1)),
                Duration::from_secs(2),
            )),
            repo: Here::Unknown,
            ran_here: false,
        };
        let slow = Candidate {
            machine: "slow".to_owned(),
            online: true,
            beat: Some(Beat::of(&heartbeat(now), Duration::from_secs(60))),
            repo: Here::Unknown,
            ran_here: false,
        };
        let ranking = rank(vec![skewed, slow]);
        assert_eq!(names(&ranking), ["skewed"]);
        assert_eq!(ranking.rejected[0].machine, "slow");
    }

    #[test]
    fn an_asleep_machine_is_rejected_and_never_ranks() {
        let ranking = rank(vec![
            Candidate {
                machine: "asleep".to_owned(),
                online: false,
                beat: beat(300, 32_768, 0, Power::Ac),
                repo: Here::Yes("/r".to_owned()),
                ran_here: true,
            },
            fresh("awake", 0, 100, Power::Ac),
        ]);
        assert_eq!(names(&ranking), ["awake"]);
        assert_eq!(
            ranking.rejected[0].why,
            Why::AsleepOrOff {
                age: Some(Duration::from_secs(300))
            }
        );
    }

    #[test]
    fn no_heartbeat_is_never_heard() {
        let ranking = rank(vec![Candidate {
            machine: "new".to_owned(),
            online: true,
            beat: None,
            repo: Here::Unknown,
            ran_here: false,
        }]);
        assert!(ranking.ranked.is_empty());
        assert_eq!(ranking.rejected[0].why, Why::NeverHeard);
    }

    #[test]
    fn the_repo_outranks_a_stronger_machine_without_it() {
        let mut weak = fresh("weak", 4_096, 60, Power::Battery { percent: 50 });
        weak.repo = Here::Yes("/home/b/Github/yantra".to_owned());
        let mut strong = fresh("strong", 32_768, 20, Power::Ac);
        strong.repo = Here::No;
        let ranking = rank(vec![strong, weak]);
        assert_eq!(names(&ranking), ["weak", "strong"]);
        assert_eq!(ranking.ranked[0].terms.repo, 30.0);
        assert_eq!(
            ranking.ranked[0].path.as_deref(),
            Some("/home/b/Github/yantra")
        );
        assert_eq!(ranking.ranked[1].terms.repo, 0.0);
        assert_eq!(ranking.ranked[1].path, None);
    }

    #[test]
    fn affinity_adds_twenty() {
        let mut here = fresh("here", 8_192, 50, Power::Ac);
        here.ran_here = true;
        let ranking = rank(vec![fresh("there", 8_192, 50, Power::Ac), here]);
        assert_eq!(names(&ranking), ["here", "there"]);
        assert_eq!(ranking.ranked[0].terms.affinity, 20.0);
        assert_eq!(ranking.ranked[0].score - ranking.ranked[1].score, 20.0);
    }

    #[test]
    fn an_unknown_repo_adds_nothing_and_filters_nothing() {
        let mut unknown = fresh("unknown", 8_192, 50, Power::Ac);
        unknown.repo = Here::Unknown;
        let mut absent = fresh("absent", 8_192, 50, Power::Ac);
        absent.repo = Here::No;
        let ranking = rank(vec![unknown, absent]);
        assert_eq!(names(&ranking), ["absent", "unknown"]);
        assert_eq!(ranking.ranked[0].score, ranking.ranked[1].score);
        assert_eq!(ranking.ranked[1].terms.repo, 0.0);
    }

    #[test]
    fn the_reason_names_the_strongest_terms_that_fired() {
        let mut idle = fresh("idle", 0, 0, Power::Battery { percent: 10 });
        idle.repo = Here::Yes("/r".to_owned());
        let mut ran = fresh("ran", 32_768, 0, Power::Ac);
        ran.ran_here = true;
        let ranking = rank(vec![
            idle,
            ran,
            fresh("busy", 0, 100, Power::Battery { percent: 10 }),
            fresh("roomy", 32_768, 100, Power::Ac),
        ]);
        let said: Vec<(&str, String)> = ranking
            .ranked
            .iter()
            .map(|s| (s.machine.as_str(), reason(s)))
            .collect();
        assert_eq!(
            said,
            [
                ("ran", "a workspace ran it there and it is idle".to_owned()),
                ("idle", "the repo is there and it is idle".to_owned()),
                (
                    "roomy",
                    "it has RAM to spare and it is on AC power".to_owned()
                ),
                ("busy", "its beat is fresh".to_owned()),
            ]
        );
    }

    /// I-10: the printed terms are the whole score.
    #[test]
    fn every_score_is_the_sum_of_its_terms() {
        let mut fleet = Vec::new();
        for (i, ram) in [0, 1_000, 3_333, 7_777, 16_384, 40_000]
            .into_iter()
            .enumerate()
        {
            for cpu in [0, 7, 33, 66, 99, 100, 255] {
                for power in [
                    Power::Ac,
                    Power::Battery { percent: 75 },
                    Power::Battery { percent: 40 },
                    Power::Battery { percent: 3 },
                ] {
                    for (j, repo) in [Here::Yes("/r".to_owned()), Here::No, Here::Unknown]
                        .into_iter()
                        .enumerate()
                    {
                        for ran_here in [false, true] {
                            let mut one = fresh(
                                &format!("m{i}-{cpu}-{power:?}-{j}-{ran_here}"),
                                ram,
                                cpu,
                                power,
                            );
                            one.repo = repo.clone();
                            one.ran_here = ran_here;
                            fleet.push(one);
                        }
                    }
                }
            }
        }
        let ranking = rank(fleet);
        for scored in &ranking.ranked {
            let Terms {
                ram,
                cpu,
                power,
                repo,
                affinity,
            } = scored.terms;
            let sum = ram + cpu + power + repo + affinity;
            assert_eq!(scored.score, round1(sum), "{scored:?}");
            assert!((scored.score - sum).abs() < 1e-9, "{scored:?}");
        }
        assert!(
            ranking
                .ranked
                .windows(2)
                .all(|pair| order(&pair[0], &pair[1]) != Ordering::Greater)
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

    fn workspace(machine: &str, repo: &str) -> Workspace {
        Workspace {
            name: "w".to_owned(),
            machine: machine.to_owned(),
            repo: repo.into(),
            startup: None,
        }
    }

    type Asks = Arc<std::sync::Mutex<Vec<(String, Target)>>>;

    /// Answers `Yes` for `holder` and records which machines were asked about what.
    fn finder(holder: &'static str) -> (Find, Asks) {
        let asks = Asks::default();
        let seen = asks.clone();
        let find: Find = Arc::new(move |machine, target| {
            seen.lock()
                .expect("not poisoned")
                .push((machine.clone(), target));
            Box::pin(async move {
                if machine == holder {
                    Here::Yes("/home/b/Github/yantra".to_owned())
                } else {
                    Here::No
                }
            })
        });
        (find, asks)
    }

    #[test]
    fn a_wanted_repo_is_owner_slash_name_and_a_path_is_not_blank() {
        assert_eq!(Wanted::repo("o/n"), Ok(Wanted::Repo("o/n".to_owned())));
        for bad in ["n", "/n", "o/", "o/n/x"] {
            assert_eq!(Wanted::repo(bad), Err("`repo` is `owner/name`"), "{bad}");
        }
        assert_eq!(Wanted::path(" "), Err("`path` is empty"));
    }

    #[tokio::test]
    async fn only_a_fresh_machine_is_asked_and_its_folder_is_passed() {
        let mut stale = fresh("stale", 0, 0, Power::Ac);
        stale.beat = beat(31, 0, 0, Power::Ac);
        let mut candidates = vec![
            fresh("holder", 0, 0, Power::Ac),
            fresh("other", 0, 0, Power::Ac),
            stale,
        ];
        let (find, asks) = finder("holder");
        let folders = BTreeMap::from([("holder".to_owned(), "/home/b/Github".to_owned())]);
        let workspaces = [
            workspace("OTHER", "/srv/Yantra"),
            workspace("stale", "/srv/notes"),
        ];
        let wanted = Wanted::Repo("o/yantra".to_owned());
        ask(&mut candidates, &wanted, &folders, &workspaces, &find).await;

        assert_eq!(
            candidates[0].repo,
            Here::Yes("/home/b/Github/yantra".to_owned())
        );
        assert_eq!(candidates[1].repo, Here::No);
        assert_eq!(candidates[2].repo, Here::Unknown);
        let ran: Vec<bool> = candidates.iter().map(|one| one.ran_here).collect();
        assert_eq!(ran, [false, true, false]);
        let mut asks = asks.lock().expect("not poisoned").clone();
        asks.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            asks,
            [
                (
                    "holder".to_owned(),
                    Target::Repo {
                        slug: "o/yantra".to_owned(),
                        folder: Some("/home/b/Github".to_owned())
                    }
                ),
                (
                    "other".to_owned(),
                    Target::Repo {
                        slug: "o/yantra".to_owned(),
                        folder: None
                    }
                ),
            ]
        );
    }

    #[tokio::test]
    async fn a_folder_matches_a_workspace_on_the_whole_path() {
        let (find, _) = finder("none");
        let workspaces = [workspace("box", "/srv/app")];
        for (path, ran) in [("/srv/app/", true), ("/srv/other/app", false)] {
            let mut candidates = vec![fresh("box", 0, 0, Power::Ac)];
            let wanted = Wanted::Path(path.to_owned());
            ask(
                &mut candidates,
                &wanted,
                &BTreeMap::new(),
                &workspaces,
                &find,
            )
            .await;
            assert_eq!(candidates[0].ran_here, ran, "{path}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_machine_that_does_not_answer_in_time_is_unknown() {
        let find: Find = Arc::new(|_, _| {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                Here::Yes("/never".to_owned())
            })
        });
        let mut candidates = vec![fresh("slow", 0, 0, Power::Ac)];
        let wanted = Wanted::Path("/srv/app".to_owned());
        ask(&mut candidates, &wanted, &BTreeMap::new(), &[], &find).await;
        assert_eq!(candidates[0].repo, Here::Unknown);
    }
}
