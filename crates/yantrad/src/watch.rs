//! The PR watch (Y-494): each thread's open PR, read from GitHub on
//! `refresh::PULLS` and told through [`crate::notify`].
//!
//! **It keeps its state in memory and rebuilds it at start** (ADR-0034
//! decision 3). Discovery finds the open PR of every thread's upstream. The
//! first look at a PR the start-up rebuild found records a baseline and says
//! nothing, so a restart does not repeat what was already said (I-59). A PR
//! added later starts with nothing told, so its first look is said. Each look is four conditional
//! reads, so a PR that did not change costs no rate limit. The last fresh
//! checks, reviews and line comments stay in memory for `GET /api/pulls`. A PR leaves the
//! watch when it merges, when it closes, or after [`FAILURES`] failed looks in
//! a row, as T3 Code's watch does; discovery adds an open one back.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use tokio::sync::RwLock;
use yantra_core::github::{
    self, Check, Conditional, Github, PullHead, PullState, Review, ReviewComment, Token,
};
use yantra_core::thread::{self, Watched};
use yantra_core::workspace;

use crate::events::Events;
use crate::notify::{PrNote, PrPhase, Teller, Viewers};

/// `(owner, repo, number)`.
pub type Key = (String, String, u64);

/// Beside the beats, where `GET /api/pulls` reads it.
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
    pub head: Option<PullHead>,
    /// The last fresh answers, which a 304 keeps. A new head drops the checks.
    pub checks: Vec<Check>,
    pub reviews: Vec<Review>,
    pub comments: Vec<ReviewComment>,
    pull_etag: Option<String>,
    /// For the head sha's check runs only; a new head drops it.
    checks_etag: Option<String>,
    reviews_etag: Option<String>,
    comments_etag: Option<String>,
    /// What was already said about the head sha's checks.
    told_failed: bool,
    told_passed: bool,
    told_reviews: BTreeSet<u64>,
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
            checks: Vec::new(),
            reviews: Vec::new(),
            comments: Vec::new(),
            pull_etag: None,
            checks_etag: None,
            reviews_etag: None,
            comments_etag: None,
            told_failed: false,
            told_passed: false,
            told_reviews: BTreeSet::new(),
            failures: 0,
            baseline,
        }
    }
}

/// One look's four answers.
#[derive(Debug)]
pub struct Read {
    pub pull: Conditional<PullHead>,
    pub checks: Conditional<Vec<Check>>,
    pub reviews: Conditional<Vec<Review>>,
    pub comments: Conditional<Vec<ReviewComment>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Look {
    Keep(Vec<PrPhase>),
    /// Merged, closed, or [`FAILURES`] failed looks in a row.
    Stop,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Summary {
    Pending,
    Failed,
    Passed,
}

/// Failed as soon as one run fails, so the phone hears before the slowest run
/// ends.
pub fn summary(checks: &[Check]) -> Summary {
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
            tracked.checks.clear();
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
        tracked.checks = value;
        match summary(&tracked.checks) {
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
            reviewed |= tracked.told_reviews.insert(review.id) && review.author != head.author;
        }
        if reviewed {
            said.push(PrPhase::Reviewed);
        }
        tracked.reviews = value;
    }
    if let Conditional::Fresh { etag, value } = read.comments {
        tracked.comments_etag = etag;
        tracked.comments = value;
    }
    if std::mem::take(&mut tracked.baseline) {
        said.clear();
    }
    Look::Keep(said)
}

/// The four reads. A PR no longer open needs only the first.
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
            comments: Conditional::NotModified,
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
    let comments = github
        .review_comments(
            token,
            owner,
            repo,
            *number,
            tracked.comments_etag.as_deref(),
        )
        .await?;
    Ok(Read {
        pull,
        checks,
        reviews,
        comments,
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

/// What a [`discover`] pass did.
#[derive(Debug, Default)]
pub struct Discovered {
    pub ran: bool,
    /// GitHub could not be asked for some workspace's PRs (Y-731).
    pub unreachable: bool,
}

impl Discovered {
    /// A pass that could not reach GitHub has not seen every PR open at
    /// start, so the next pass is still the baseline (I-59).
    pub fn ends_the_baseline(&self) -> bool {
        self.ran && !self.unreachable
    }
}

/// Adds the open PRs of every workspace's threads. It removes nothing: a
/// machine asleep or a look that failed tells nobody anything. `baseline`
/// marks the start-up rebuild.
pub async fn discover(
    pulls: &Pulls,
    github: &Github,
    token: Option<Token>,
    baseline: bool,
) -> Discovered {
    let Some(token) = token else {
        return Discovered::default();
    };
    let Ok(listing) = workspace::list() else {
        return Discovered::default();
    };
    let mut unreachable = false;
    for workspace in listing.workspaces {
        match thread::open_pulls(&workspace.name, github, &token).await {
            Ok(found) => {
                for watched in found {
                    track(pulls, watched, baseline).await;
                }
            }
            Err(error) => {
                unreachable |= matches!(
                    error,
                    thread::Failed::Github(github::Error::Unreachable { .. })
                );
                tracing::debug!("no PRs read for {}: {error}", workspace.name);
            }
        }
    }
    Discovered {
        ran: true,
        unreachable,
    }
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
pub(crate) mod tests {
    use super::*;
    use yantra_core::github::Unlogged;

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
            output: None,
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
            body: Unlogged::default(),
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
            comments: Conditional::NotModified,
        })
    }

    fn unchanged() -> Result<Read, github::Error> {
        read(
            Conditional::NotModified,
            Conditional::NotModified,
            Conditional::NotModified,
        )
    }

    /// One PR after a look that found a failed and a passed check, a review
    /// and a line comment, for `GET /api/pulls` and its contract.
    pub(crate) async fn watching_one() -> Pulls {
        let mut watched = Tracked::new(
            "api".to_owned(),
            "https://github.com/o/r/pull/21".to_owned(),
            true,
        );
        let output = |title: &str, summary: &str| {
            Some(github::CheckOutput {
                title: Unlogged(title.to_owned()),
                summary: Unlogged(summary.to_owned()),
            })
        };
        look(
            &mut watched,
            Ok(Read {
                pull: head("aaa111", PullState::Open),
                checks: checks(vec![
                    Check {
                        name: "test".to_owned(),
                        output: output("1 failed", "`watch::look` panicked"),
                        ..run("completed", Some("failure"))
                    },
                    Check {
                        name: "lint".to_owned(),
                        output: output("Clean", ""),
                        ..run("completed", Some("success"))
                    },
                ]),
                reviews: reviews(vec![Review {
                    body: Unlogged("Please add a test.".to_owned()),
                    ..review(7, "friend", "CHANGES_REQUESTED")
                }]),
                comments: Conditional::Fresh {
                    etag: None,
                    value: vec![ReviewComment {
                        id: 31,
                        author: "friend".to_owned(),
                        path: "src/watch.rs".to_owned(),
                        line: Some(12),
                        body: Unlogged("This drops the etag.".to_owned()),
                    }],
                },
            }),
        );
        let pulls = Pulls::default();
        pulls
            .write()
            .await
            .insert(("o".to_owned(), "r".to_owned(), 21), watched);
        pulls
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

    /// Y-731: a rebuild GitHub did not answer keeps the baseline, and a second
    /// baseline pass leaves a PR it already tracks as it is.
    #[tokio::test]
    async fn an_unreachable_rebuild_keeps_the_baseline_for_the_next_pass() {
        let unreachable = Discovered {
            ran: true,
            unreachable: true,
        };
        assert!(!unreachable.ends_the_baseline());
        assert!(
            !Discovered::default().ends_the_baseline(),
            "no grant, no pass"
        );
        let answered = Discovered {
            ran: true,
            unreachable: false,
        };
        assert!(answered.ends_the_baseline());

        let pulls = Pulls::default();
        let pr = |number| Watched {
            workspace: "web".to_owned(),
            owner: "o".to_owned(),
            repo: "r".to_owned(),
            number,
            url: format!("https://github.com/o/r/pull/{number}"),
        };
        track(&pulls, pr(1), true).await;
        track(&pulls, pr(1), false).await;
        track(&pulls, pr(2), true).await;
        let held = pulls.read().await;
        assert!(held.values().all(|tracked| tracked.baseline));
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

    /// `GET /api/pulls` reads what the last fresh answers said, and a 304
    /// changes none of it.
    #[test]
    fn a_304_keeps_the_checks_reviews_and_comments() {
        let mut watched = tracked();
        let comment = ReviewComment {
            id: 31,
            author: "friend".to_owned(),
            path: "src/main.rs".to_owned(),
            line: Some(12),
            body: Unlogged("Rename this".to_owned()),
        };
        look(
            &mut watched,
            Ok(Read {
                pull: head("a", PullState::Open),
                checks: checks(failed()),
                reviews: reviews(vec![review(1, "friend", "COMMENTED")]),
                comments: Conditional::Fresh {
                    etag: Some("\"rc\"".to_owned()),
                    value: vec![comment.clone()],
                },
            }),
        );
        look(&mut watched, unchanged());

        assert_eq!(watched.checks, failed());
        assert_eq!(watched.reviews, [review(1, "friend", "COMMENTED")]);
        assert_eq!(watched.comments, [comment]);
        assert_eq!(watched.comments_etag.as_deref(), Some("\"rc\""));
    }

    /// A new head's checks are not the old head's, even before they are read.
    #[test]
    fn a_new_head_drops_the_old_checks() {
        let mut watched = tracked();
        look(
            &mut watched,
            read(
                head("a", PullState::Open),
                checks(failed()),
                reviews(vec![]),
            ),
        );
        look(
            &mut watched,
            read(
                head("b", PullState::Open),
                Conditional::NotModified,
                Conditional::NotModified,
            ),
        );
        assert!(watched.checks.is_empty());
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

    /// Q5: a look keeps what checks and reviewers wrote, for the Chat, and no
    /// log line carries any of it.
    #[tokio::test]
    async fn a_look_keeps_the_text_and_logs_none_of_it() {
        use std::io::{Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let base = format!("http://{}", listener.local_addr().expect("its address"));
        let answers = [
            r#"{"state":"open","merged_at":null,"head":{"sha":"aaa"},"user":{"login":"owner"}}"#,
            r#"{"check_runs":[{"name":"test","status":"completed","conclusion":"failure","output":{"title":"CHECK_TITLE","summary":"CHECK_SUMMARY"}}]}"#,
            r#"[{"id":7,"user":{"login":"friend"},"state":"COMMENTED","body":"REVIEW_BODY"}]"#,
            r#"[{"id":31,"user":{"login":"friend"},"path":"a.rs","line":3,"body":"COMMENT_BODY"}]"#,
        ];
        let served = std::thread::spawn(move || {
            for body in answers {
                let (mut stream, _) = listener.accept().expect("the look connects");
                let mut request = Vec::new();
                let mut byte = [0u8; 1];
                while !request.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                    request.push(byte[0]);
                }
                let answer = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream
                    .write_all(answer.as_bytes())
                    .expect("the fake answers");
            }
        });
        let capture = crate::terminal::tests::Capture::default();
        let writer = capture.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .with_writer(move || writer.clone())
            .finish();
        let _logged = tracing::subscriber::set_default(subscriber);
        let pulls = Pulls::default();
        track(
            &pulls,
            Watched {
                workspace: "web".to_owned(),
                owner: "o".to_owned(),
                repo: "r".to_owned(),
                number: 21,
                url: "https://github.com/o/r/pull/21".to_owned(),
            },
            false,
        )
        .await;
        let mut teller = Teller::new(None);
        let (viewers, events) = (Viewers::default(), Events::default());

        poll(
            &pulls,
            &Github::at(&base, &base),
            Some(Token::new("t".to_owned())),
            &mut teller,
            &viewers,
            &events,
        )
        .await;
        served.join().expect("the fake GitHub");

        let held = pulls.read().await;
        let tracked = held.values().next().expect("still watched");
        let output = tracked.checks[0].output.as_ref().expect("an output");
        assert_eq!(output.summary.0, "CHECK_SUMMARY");
        assert_eq!(tracked.reviews[0].body.0, "REVIEW_BODY");
        assert_eq!(tracked.comments[0].body.0, "COMMENT_BODY");
        let log = String::from_utf8_lossy(&capture.0.lock().expect("the log")).into_owned();
        for text in [
            "CHECK_TITLE",
            "CHECK_SUMMARY",
            "REVIEW_BODY",
            "COMMENT_BODY",
        ] {
            assert!(!log.contains(text), "{text} reached the log: {log}");
        }
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
