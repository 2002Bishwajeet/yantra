//! What is waiting for the owner on GitHub, read through the `gh` CLI.
//!
//! **Yantra never holds a GitHub credential, and that is the whole design.**
//! `gh` already keeps an OAuth token in the machine's keyring and is already
//! registered as git's credential helper, so this module spawns a binary that
//! authenticates itself and reads its stdout. §B4 is satisfied by construction
//! rather than by policy — the same argument [ADR-0018] §4 used to keep
//! `claude`'s credential out of Yantra. See [R13] §2.1 for what the alternative
//! costs: a daemon holding a token supersedes ADR-0004's amendment and re-opens
//! Q5, and the better-designed GitHub credential is the one it cannot hold.
//!
//! This reads GitHub *as whoever is logged in where the daemon runs*. On the
//! appliance nobody is, which is [Q20] and not this module's to answer.
//!
//! [ADR-0018]: ../../../docs/adr/0018-the-tmux-server-carries-the-macos-login-session.md
//! [R13]: ../../../docs/research/13-dashboard-revamp-and-github.md
//! [Q20]: ../../../tracker.md

use std::process::Stdio;

/// `gh search` caps at 1000 and defaults to 30. A person triaging on a phone
/// does not scroll past thirty, and a larger page costs a slower poll.
const LIMIT: &str = "30";

/// The five fields this asks for, and deliberately no more. `gh search` will
/// return author, assignees, body and labels for the asking; naming only what
/// is drawn is how the rest never reaches a log line — the crate's rule for
/// talking to someone else's program.
const FIELDS: &str = "number,title,url,repository,updatedAt";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    /// `repository.nameWithOwner` — `owner/name`, the only spelling that is
    /// unique across GitHub.
    pub repo: String,
    pub number: u64,
    pub title: String,
    /// GitHub's own web URL, so the page links out rather than rebuilding it
    /// from the parts and getting `/issues` versus `/pull` wrong.
    pub url: String,
    /// RFC 3339, as GitHub sent it. Not parsed here: this crate does no layout
    /// (ADR-0005), and the age a reader wants is against *now*, not against the
    /// poll.
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Attention {
    /// Pull requests waiting on this account's review.
    pub reviews: Vec<Item>,
    /// Issues assigned to this account.
    pub issues: Vec<Item>,
    /// Unread notifications. A count rather than a list: the titles are the
    /// part that would land in a journal, and nothing draws them.
    pub notifications: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not spawn `gh` — is the GitHub CLI installed and on PATH?")]
    NotInstalled,

    #[error("`gh` is installed but not logged in — run `gh auth login`")]
    LoggedOut,

    #[error("`gh` could not reach GitHub")]
    Unreachable,

    #[error("`gh {argv}` failed: {stderr}")]
    Command { argv: String, stderr: String },

    #[error("could not parse `gh {argv}`")]
    Parse {
        argv: String,
        #[source]
        source: serde_json::Error,
    },
}

/// The seam the layers above are tested against (§B2). GitHub cannot be put in
/// a container, so like [`crate::inventory::Inventory`] and unlike
/// [`crate::ssh::Exec`] this one is faked above and proved against the real
/// binary below.
pub trait Forge {
    fn attention(&self) -> impl std::future::Future<Output = Result<Attention, Error>> + Send;
}

/// Reads the local `gh` binary (§B2). Yantra runs the CLI; it never speaks
/// GitHub's REST API itself, which is what keeps the token out of this process.
#[derive(Debug, Clone, Default)]
pub struct Gh;

impl Forge for Gh {
    async fn attention(&self) -> Result<Attention, Error> {
        // Three independent network calls. Sequential would triple the poll's
        // worst case for nothing.
        let (reviews, issues, notifications) = tokio::try_join!(
            search("prs", "--review-requested=@me"),
            search("issues", "--assignee=@me"),
            unread(),
        )?;

        Ok(Attention {
            reviews,
            issues,
            notifications,
        })
    }
}

async fn search(kind: &str, filter: &str) -> Result<Vec<Item>, Error> {
    let args = [
        "search",
        kind,
        filter,
        "--state=open",
        "--limit",
        LIMIT,
        "--json",
        FIELDS,
    ];
    parse_items(&run(&args).await?).map_err(|source| Error::Parse {
        argv: args.join(" "),
        source,
    })
}

async fn unread() -> Result<u32, Error> {
    let args = ["api", "/notifications", "--jq", "length"];
    // An empty inbox prints nothing rather than `0`, and a count that will not
    // parse is not worth failing a whole poll for.
    Ok(run(&args).await?.trim().parse().unwrap_or(0))
}

async fn run(args: &[&str]) -> Result<String, Error> {
    let out = tokio::process::Command::new("gh")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Error::NotInstalled,
            _ => Error::Command {
                argv: args.join(" "),
                stderr: e.to_string(),
            },
        })?;

    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    Err(classify(
        out.status.code(),
        &String::from_utf8_lossy(&out.stderr),
        args,
    ))
}

/// Measured against `gh` 2.96.0 on 2026-08-10, because none of this is
/// documented as an interface: logged out exits **4**; an unreachable host and
/// a rejected token both exit 1 and are told apart by the first line of stderr.
/// A 401 is folded into `LoggedOut` — the token exists and GitHub refused it,
/// and the remedy is the same `gh auth login` either way.
fn classify(code: Option<i32>, stderr: &str, args: &[&str]) -> Error {
    let stderr = stderr.trim();
    if code == Some(4) || stderr.contains("gh auth login") || stderr.contains("401") {
        Error::LoggedOut
    } else if stderr.contains("error connecting to") {
        Error::Unreachable
    } else {
        Error::Command {
            argv: args.join(" "),
            stderr: stderr.to_string(),
        }
    }
}

fn parse_items(stdout: &str) -> Result<Vec<Item>, serde_json::Error> {
    // `gh` prints nothing at all for some empty results, which is not JSON.
    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }
    let raw: Vec<RawItem> = serde_json::from_str(stdout)?;
    Ok(raw
        .into_iter()
        .map(|r| Item {
            repo: r.repository.name_with_owner,
            number: r.number,
            title: r.title,
            url: r.url,
            updated_at: r.updated_at,
        })
        .collect())
}

/// No `deny_unknown_fields`: this is someone else's output and an unknown key
/// is next week's release, not a typo.
#[derive(serde::Deserialize)]
struct RawItem {
    number: u64,
    title: String,
    url: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    repository: RawRepo,
}

#[derive(serde::Deserialize)]
struct RawRepo {
    #[serde(rename = "nameWithOwner")]
    name_with_owner: String,
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets library code, where the same call would take the daemon down.
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    /// Captured verbatim from `gh search prs --review-requested=@me` on
    /// 2026-08-10, trimmed to one element.
    const REAL: &str = r#"[{"number":54,"repository":{"name":"messaging","nameWithOwner":"utopia-php/messaging"},"title":"feat-6861-46elks-messaging-adapter","updatedAt":"2024-04-19T15:49:30Z","url":"https://github.com/utopia-php/messaging/pull/54"}]"#;

    #[test]
    fn reads_the_five_fields_it_names() {
        let items = parse_items(REAL).expect("real gh output parses");
        assert_eq!(
            items,
            vec![Item {
                repo: "utopia-php/messaging".into(),
                number: 54,
                title: "feat-6861-46elks-messaging-adapter".into(),
                url: "https://github.com/utopia-php/messaging/pull/54".into(),
                updated_at: "2024-04-19T15:49:30Z".into(),
            }]
        );
    }

    #[test]
    fn a_field_gh_adds_later_does_not_break_the_read() {
        let extra = r#"[{"number":1,"title":"t","url":"u","updatedAt":"d",
            "repository":{"name":"n","nameWithOwner":"o/n"},"somethingNew":{"a":1}}]"#;
        assert_eq!(parse_items(extra).expect("tolerates unknown keys").len(), 1);
    }

    #[test]
    fn empty_output_is_no_items_rather_than_a_parse_error() {
        assert!(parse_items("").expect("empty is not a failure").is_empty());
        assert!(
            parse_items("  \n")
                .expect("blank is not a failure")
                .is_empty()
        );
    }

    #[test]
    fn the_three_failures_are_told_apart() {
        let a = ["api", "/notifications"];
        assert!(matches!(
            classify(
                Some(4),
                "To get started with GitHub CLI, please run:  gh auth login",
                &a
            ),
            Error::LoggedOut
        ));
        assert!(matches!(
            classify(
                Some(1),
                "non-200 OK status code: 401 Unauthorized body: \"...\"",
                &a
            ),
            Error::LoggedOut
        ));
        assert!(matches!(
            classify(Some(1), "error connecting to nonexistent.invalid", &a),
            Error::Unreachable
        ));
    }

    #[test]
    fn an_unrecognised_failure_keeps_its_stderr_rather_than_guessing() {
        let e = classify(Some(1), "some new thing gh does", &["search", "prs"]);
        match e {
            Error::Command { argv, stderr } => {
                assert_eq!(argv, "search prs");
                assert_eq!(stderr, "some new thing gh does");
            }
            other => panic!("expected Command, got {other:?}"),
        }
    }
}
