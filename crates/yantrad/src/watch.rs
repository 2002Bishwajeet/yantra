//! The PR watch (Y-494): each thread's open PR, read from GitHub on
//! `refresh::PULLS` and told through [`crate::notify`].
//!
//! **It keeps its state in memory and rebuilds it at start** (ADR-0034
//! decision 3). Discovery finds the open PR of every thread's upstream. The
//! first look at a PR the start-up rebuild found records a baseline and says
//! nothing, so a restart does not repeat what was already said (I-59). A PR
//! added later starts with nothing told, so its first look is said. Each look is three conditional
//! reads, so a PR that did not change costs no rate limit. A PR leaves the
//! watch when it merges, when it closes, or after [`FAILURES`] failed looks in
//! a row, as T3 Code's watch does; discovery adds an open one back.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use tokio::sync::RwLock;
use yantra_core::github::{self, Check, Conditional, Github, PullHead, PullState, Review, Token};
use yantra_core::thread::{self, Watched};
use yantra_core::workspace;

use crate::events::Events;
use crate::notify::{PrNote, PrPhase, Teller, Viewers};

/// `(owner, repo, number)`.
pub type Key = (String, String, u64);

/// Beside the beats, where `GET` routes can read it later (Y-512).
pub type Pulls = Arc<RwLock<BTreeMap<Key, Tracked>>>;

/// T3 Code's limit: a PR that cannot be read eight times running is gone.
pub const FAILURES: u32 = 8;

const FAILED: [&str; 4] = ["failure", "timed_out", "cancelled", "action_required"];
const PASSED: [&str; 3] = ["success", "neutral", "skipped"];

#[derive(Debug, Clone)]
pub struct Tracked {
    pub workspace: String,
    pub url: String,
    /// The last pull read, which a 304 reuses. `None` until the first look.
    head: Option<PullHead>,
    pull_etag: Option<String>,
    /// For the head sha's check runs only; a new head drops it.
    checks_etag: Option<String>,
    reviews_etag: Option<String>,
    /// What was already said about the head sha's checks.
    told_failed: bool,
    told_passed: bool,
    reviews: BTreeSet<u64>,
    failures: u32,
    /// The start-up rebuild found it, so its first look says nothing.
    baseline: bool,
}

impl Tracked {
    pub fn new(workspace: String, url: String, baseline: bool) -> Self {
        Self {
            workspace,
            url,
            head: None,
            pull_etag: None,
            checks_etag: None,
            reviews_etag: None,
            told_failed: false,
            told_passed: false,
            reviews: BTreeSet::new(),
            failures: 0,
            baseline,
        }
    }
}

/// One look's three answers.
#[derive(Debug)]
pub struct Read {
    pub pull: Conditional<PullHead>,
    pub checks: Conditional<Vec<Check>>,
    pub reviews: Conditional<Vec<Review>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Look {
    Keep(Vec<PrPhase>),
    /// Merged, closed, or [`FAILURES`] failed looks in a row.
    Stop,
}

#[derive(Debug, PartialEq, Eq)]
enum Summary {
    Pending,
    Failed,
    Passed,
}

/// Failed as soon as one run fails, so the phone hears before the slowest run
/// ends.
fn summary(checks: &[Check]) -> Summary {
    let concluded = |check: &Check, set: &[&str]| {
        check.status == "completed"
            && check
                .conclusion
                .as_deref()
                .is_some_and(|conclusion| set.contains(&conclusion))
    };
    if checks.iter().any(|check| concluded(check, &FAILED)) {
        Summary::Failed
    } else if !checks.is_empty() && checks.iter().all(|check| concluded(check, &PASSED)) {
        Summary::Passed
    } else {
        Summary::Pending
    }
}

/// What changed since the last look. It decides and reads nothing.
pub fn look(tracked: &mut Tracked, read: Result<Read, github::Error>) -> Look {
    let Ok(read) = read else {
        tracked.failures += 1;
        return if tracked.failures >= FAILURES {
            Look::Stop
        } else {
            Look::Keep(Vec::new())
        };
    };
    tracked.failures = 0;
    if let Conditional::Fresh { etag, value } = read.pull {
        if value.state != PullState::Open {
            return Look::Stop;
        }
        if tracked
            .head
            .as_ref()
            .is_none_or(|head| head.head_sha != value.head_sha)
        {
            tracked.checks_etag = None;
            tracked.told_failed = false;
            tracked.told_passed = false;
        }
        tracked.pull_etag = etag;
        tracked.head = Some(value);
    }
    let Some(head) = &tracked.head else {
        return Look::Keep(Vec::new());
    };

    let mut said = Vec::new();
    if let Conditional::Fresh { etag, value } = read.checks {
        tracked.checks_etag = etag;
        match summary(&value) {
            Summary::Failed if !tracked.told_failed => {
                tracked.told_failed = true;
                said.push(PrPhase::CheckFailed);
            }
            Summary::Passed if !tracked.told_passed => {
                tracked.told_passed = true;
                said.push(PrPhase::ChecksPassed);
            }
            _ => {}
        }
    }
    if let Conditional::Fresh { etag, value } = read.reviews {
        tracked.reviews_etag = etag;
        // A pending review keeps its id when it is submitted, so it is not
        // counted as seen.
        let mut reviewed = false;
        for review in value.iter().filter(|review| review.state != "PENDING") {
            reviewed |= tracked.reviews.insert(review.id) && review.author != head.author;
        }
        if reviewed {
            said.push(PrPhase::Reviewed);
        }
    }
    if std::mem::take(&mut tracked.baseline) {
        said.clear();
    }
    Look::Keep(said)
}

/// The three reads. A PR no longer open needs only the first.
async fn read(
    github: &Github,
    token: &Token,
    (owner, repo, number): &Key,
    tracked: &Tracked,
) -> Result<Read, github::Error> {
    let pull = github
        .pull(token, owner, repo, *number, tracked.pull_etag.as_deref())
        .await?;
    let head = match &pull {
        Conditional::Fresh { value, .. } => Some(value),
        Conditional::NotModified => tracked.head.as_ref(),
    };
    let Some(head) = head.filter(|head| head.state == PullState::Open) else {
        return Ok(Read {
            pull,
            checks: Conditional::NotModified,
            reviews: Conditional::NotModified,
        });
    };
    let sha = head.head_sha.clone();
    let same = tracked
        .head
        .as_ref()
        .is_some_and(|head| head.head_sha == sha);
    let checks_etag = tracked.checks_etag.as_deref().filter(|_| same);
    let checks = github
        .check_runs(token, owner, repo, &sha, checks_etag)
        .await?;
    let reviews = github
        .reviews(token, owner, repo, *number, tracked.reviews_etag.as_deref())
        .await?;
    Ok(Read {
        pull,
        checks,
        reviews,
    })
}

/// One pass over every watched PR. No grant is no pass.
pub async fn poll(
    pulls: &Pulls,
    github: &Github,
    token: Option<Token>,
    teller: &mut Teller,
    viewers: &Viewers,
    events: &Events,
) {
    let Some(token) = token else {
        return;
    };
    let watching: Vec<(Key, Tracked)> = pulls
        .read()
        .await
        .iter()
        .map(|(key, tracked)| (key.clone(), tracked.clone()))
        .collect();
    let mut notes = Vec::new();
    for (key, mut tracked) in watching {
        let read = read(github, &token, &key, &tracked).await;
        if let Err(error) = &read {
            tracing::debug!("PR #{} of {}: {error}", key.2, tracked.workspace);
        }
        let looked = look(&mut tracked, read);
        let mut held = pulls.write().await;
        match looked {
            Look::Stop => {
                held.remove(&key);
            }
            Look::Keep(phases) => {
                notes.extend(phases.into_iter().map(|phase| PrNote {
                    phase,
                    workspace: tracked.workspace.clone(),
                    number: key.2,
                }));
                held.insert(key, tracked);
            }
        }
    }
    let watched = crate::notify::watched(viewers).await;
    teller.tell_pulls(&notes, watched, events).await;
}

/// Adds the open PRs of every workspace's threads. It removes nothing: a
/// machine asleep or a look that failed tells nobody anything. `baseline`
/// marks the start-up rebuild; it answers whether the pass ran.
pub async fn discover(
    pulls: &Pulls,
    github: &Github,
    token: Option<Token>,
    baseline: bool,
) -> bool {
    let Some(token) = token else {
        return false;
    };
    let Ok(listing) = workspace::list() else {
        return false;
    };
    for workspace in listing.workspaces {
        match thread::open_pulls(&workspace.name, github, &token).await {
            Ok(found) => {
                for watched in found {
                    track(pulls, watched, baseline).await;
                }
            }
            Err(error) => tracing::debug!("no PRs read for {}: {error}", workspace.name),
        }
    }
    true
}

/// Starts watching a PR, and leaves one already watched as it is.
pub async fn track(pulls: &Pulls, watched: Watched, baseline: bool) {
    pulls
        .write()
        .await
        .entry((watched.owner, watched.repo, watched.number))
        .or_insert_with(|| Tracked::new(watched.workspace, watched.url, baseline));
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn tracked() -> Tracked {
        Tracked::new(
            "web".to_owned(),
            "https://github.com/o/r/pull/21".to_owned(),
            true,
        )
    }

    fn head(sha: &str, state: PullState) -> Conditional<PullHead> {
        Conditional::Fresh {
            etag: Some(format!("\"{sha}\"")),
            value: PullHead {
                state,
                head_sha: sha.to_owned(),
                author: "owner".to_owned(),
            },
        }
    }

    fn run(status: &str, conclusion: Option<&str>) -> Check {
        Check {
            name: "test".to_owned(),
            status: status.to_owned(),
            conclusion: conclusion.map(str::to_owned),
        }
    }

    fn checks(runs: Vec<Check>) -> Conditional<Vec<Check>> {
        Conditional::Fresh {
            etag: None,
            value: runs,
        }
    }

    fn review(id: u64, author: &str, state: &str) -> Review {
        Review {
            id,
            author: author.to_owned(),
            state: state.to_owned(),
        }
    }

    fn reviews(found: Vec<Review>) -> Conditional<Vec<Review>> {
        Conditional::Fresh {
            etag: None,
            value: found,
        }
    }

    fn read(
        pull: Conditional<PullHead>,
        checks: Conditional<Vec<Check>>,
        reviews: Conditional<Vec<Review>>,
    ) -> Result<Read, github::Error> {
        Ok(Read {
            pull,
            checks,
            reviews,
        })
    }

    fn unchanged() -> Result<Read, github::Error> {
        read(
            Conditional::NotModified,
            Conditional::NotModified,
            Conditional::NotModified,
        )
    }

    fn failed() -> Vec<Check> {
        vec![run("completed", Some("failure")), run("in_progress", None)]
    }

    #[test]
    fn the_first_look_at_a_rebuilt_pr_records_a_baseline_and_says_nothing() {
        let mut watched = tracked();
        let first = look(
            &mut watched,
            read(
                head("a", PullState::Open),
                checks(failed()),
                reviews(vec![review(1, "friend", "APPROVED")]),
            ),
        );
        assert_eq!(first, Look::Keep(Vec::new()));
        // The same answer again is no change.
        let second = look(
            &mut watched,
            read(
                head("a", PullState::Open),
                checks(failed()),
                reviews(vec![review(1, "friend", "APPROVED")]),
            ),
        );
        assert_eq!(second, Look::Keep(Vec::new()));
    }

    /// A PR `pr open` or a later discover pass added: checks and a review that
    /// ended before its first look are still said, and said once.
    #[test]
    fn a_pr_added_after_start_says_what_ended_before_its_first_look() {
        let mut watched = Tracked::new(
            "web".to_owned(),
            "https://github.com/o/r/pull/21".to_owned(),
            false,
        );
        let answer = || {
            read(
                head("a", PullState::Open),
                checks(failed()),
                reviews(vec![review(1, "friend", "APPROVED")]),
            )
        };
        assert_eq!(
            look(&mut watched, answer()),
            Look::Keep(vec![PrPhase::CheckFailed, PrPhase::Reviewed])
        );
        assert_eq!(look(&mut watched, answer()), Look::Keep(Vec::new()));
    }

    /// A failed first look leaves the baseline for the first look that lands.
    #[test]
    fn a_baseline_waits_for_a_look_that_lands() {
        let mut watched = tracked();
        look(&mut watched, Err(github::Error::Refused));
        assert_eq!(
            look(
                &mut watched,
                read(
                    head("a", PullState::Open),
                    checks(failed()),
                    reviews(vec![])
                )
            ),
            Look::Keep(Vec::new())
        );
    }

    #[test]
    fn a_check_fails_once_per_sha_and_a_new_sha_that_passes_is_said() {
        let mut watched = tracked();
        let pending = vec![run("queued", None)];
        look(
            &mut watched,
            read(head("a", PullState::Open), checks(pending), reviews(vec![])),
        );

        let failing = look(
            &mut watched,
            read(
                Conditional::NotModified,
                checks(failed()),
                Conditional::NotModified,
            ),
        );
        let again = look(
            &mut watched,
            read(
                Conditional::NotModified,
                checks(vec![run("completed", Some("timed_out"))]),
                Conditional::NotModified,
            ),
        );
        let passed = look(
            &mut watched,
            read(
                head("b", PullState::Open),
                checks(vec![
                    run("completed", Some("success")),
                    run("completed", Some("skipped")),
                ]),
                Conditional::NotModified,
            ),
        );
        let still = look(
            &mut watched,
            read(
                Conditional::NotModified,
                checks(vec![run("completed", Some("neutral"))]),
                Conditional::NotModified,
            ),
        );

        assert_eq!(failing, Look::Keep(vec![PrPhase::CheckFailed]));
        assert_eq!(again, Look::Keep(Vec::new()));
        assert_eq!(passed, Look::Keep(vec![PrPhase::ChecksPassed]));
        assert_eq!(still, Look::Keep(Vec::new()));
    }

    #[test]
    fn no_runs_or_one_still_running_is_not_passed() {
        assert_eq!(summary(&[]), Summary::Pending);
        assert_eq!(
            summary(&[run("completed", Some("success")), run("queued", None)]),
            Summary::Pending
        );
        for conclusion in FAILED {
            assert_eq!(
                summary(&[run("completed", Some(conclusion))]),
                Summary::Failed
            );
        }
    }

    #[test]
    fn a_review_by_the_author_or_still_pending_is_not_said() {
        let mut watched = tracked();
        look(
            &mut watched,
            read(head("a", PullState::Open), checks(vec![]), reviews(vec![])),
        );

        let own = look(
            &mut watched,
            read(
                Conditional::NotModified,
                Conditional::NotModified,
                reviews(vec![
                    review(1, "owner", "COMMENTED"),
                    review(2, "friend", "PENDING"),
                ]),
            ),
        );
        let submitted = look(
            &mut watched,
            read(
                Conditional::NotModified,
                Conditional::NotModified,
                reviews(vec![
                    review(1, "owner", "COMMENTED"),
                    review(2, "friend", "CHANGES_REQUESTED"),
                ]),
            ),
        );
        let seen = look(
            &mut watched,
            read(
                Conditional::NotModified,
                Conditional::NotModified,
                reviews(vec![review(2, "friend", "CHANGES_REQUESTED")]),
            ),
        );

        assert_eq!(own, Look::Keep(Vec::new()));
        assert_eq!(submitted, Look::Keep(vec![PrPhase::Reviewed]));
        assert_eq!(seen, Look::Keep(Vec::new()));
    }

    #[test]
    fn a_304_keeps_the_cached_head_and_etags() {
        let mut watched = tracked();
        look(
            &mut watched,
            read(head("a", PullState::Open), checks(vec![]), reviews(vec![])),
        );
        assert_eq!(look(&mut watched, unchanged()), Look::Keep(Vec::new()));
        assert_eq!(
            watched.head.as_ref().map(|head| head.head_sha.as_str()),
            Some("a")
        );
        assert_eq!(watched.pull_etag.as_deref(), Some("\"a\""));
    }

    #[test]
    fn a_merged_or_closed_pr_stops_the_watch() {
        for state in [PullState::Merged, PullState::Closed] {
            let mut watched = tracked();
            look(
                &mut watched,
                read(head("a", PullState::Open), checks(vec![]), reviews(vec![])),
            );
            assert_eq!(
                look(
                    &mut watched,
                    read(
                        head("a", state),
                        Conditional::NotModified,
                        Conditional::NotModified
                    )
                ),
                Look::Stop
            );
        }
    }

    #[test]
    fn eight_failed_looks_in_a_row_stop_the_watch() {
        let mut watched = tracked();
        let refused = || Err(github::Error::Refused);
        for _ in 0..FAILURES - 1 {
            assert_eq!(look(&mut watched, refused()), Look::Keep(Vec::new()));
        }
        // A look that lands starts the count again.
        look(
            &mut watched,
            read(head("a", PullState::Open), checks(vec![]), reviews(vec![])),
        );
        for _ in 0..FAILURES - 1 {
            look(&mut watched, refused());
        }
        assert_eq!(look(&mut watched, refused()), Look::Stop);
    }

    /// A GitHub that cannot be reached drops the entry on the eighth pass, and
    /// no grant reads nothing at all.
    #[tokio::test]
    async fn poll_drops_a_pr_it_cannot_read_and_does_nothing_without_a_grant() {
        let pulls = Pulls::default();
        let found = Watched {
            workspace: "web".to_owned(),
            owner: "o".to_owned(),
            repo: "r".to_owned(),
            number: 21,
            url: "https://github.com/o/r/pull/21".to_owned(),
        };
        track(&pulls, found.clone(), false).await;
        track(&pulls, found, true).await;
        assert_eq!(pulls.read().await.len(), 1, "tracked once");

        let gone = Github::at("http://127.0.0.1:9", "http://127.0.0.1:9");
        let mut teller = Teller::new(None);
        let (viewers, events) = (Viewers::default(), Events::default());
        for _ in 0..FAILURES * 2 {
            poll(&pulls, &gone, None, &mut teller, &viewers, &events).await;
        }
        assert_eq!(pulls.read().await.len(), 1, "no grant, no look");

        let token = Some(Token::new("t".to_owned()));
        for _ in 0..FAILURES - 1 {
            poll(&pulls, &gone, token.clone(), &mut teller, &viewers, &events).await;
        }
        assert_eq!(pulls.read().await.len(), 1);
        poll(&pulls, &gone, token, &mut teller, &viewers, &events).await;
        assert!(pulls.read().await.is_empty());
        assert!(events.read().await.is_empty());
    }
}
