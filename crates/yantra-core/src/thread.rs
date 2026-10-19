//! A chat session's own git worktree (Y-359, the isolate answer in ADR-0026's
//! 2026-10-06 amendment). "Thread" is T3 Code's word, as in [`crate::chat`].
//!
//! A thread works on the branch `yantra/chat/<workspace>/<id>`, in
//! `~/.yantra/worktrees/chat/<workspace>/<id>`, so its edits never reach the
//! repository the workspace's TUI runs in. Ending a session deletes nothing:
//! the branch and any uncommitted work stay until [`remove`] is called.
//!
//! Claude Code files a transcript under the directory it ran in, so the
//! transcript and the spend of a thread are read from the worktree's path.
//!
//! An ACP thread's harness and session id live in the repository's git config,
//! under the thread's branch, so the daemon keeps nothing and `branch -D`
//! forgets them. A thread with neither is a Claude thread. A thread opened from
//! an issue keeps the issue there too (Y-488), and its PR is read from its
//! upstream branch rather than kept (ADR-0034 decision 3).

use time::OffsetDateTime;

use crate::acp::Harness;
use crate::agent::Running;
use crate::checkpoint;
use crate::clone::destination;
use crate::delegate::{self, NOT_A_REPO, branch, said};
pub use crate::delegate::{Error, Place, Summary};
use crate::github::{self, Github, Issue, IssueRef, PullState, Token};
use crate::logs::{self, Transcript};
use crate::ssh::{self, Exec, Ssh};
use crate::tmux::sq;
use crate::tokens::{self, Spend};
use crate::workspace::{self, Workspace};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    /// The registry entry whose `cwd` is the thread's worktree.
    pub agent: Option<Running>,
    pub summary: Summary,
}

/// Makes a new worktree of the workspace's repository, at its `HEAD`. A live
/// session in the repository does not stop it.
pub async fn open<E: Exec>(exec: &E, workspace: &Workspace) -> Result<Place, Error> {
    let id = format!("chat/{}/{}", workspace.name, delegate::id()?);
    delegate::prepare(exec, &workspace.repo.to_string_lossy(), &id).await
}

/// The short id a caller names the thread by: the last part of [`Place::id`].
pub fn name(place: &Place) -> &str {
    place.id.rsplit('/').next().unwrap_or(&place.id)
}

/// Every thread of the workspace that git still knows, so a thread outlives the
/// daemon that opened it.
pub async fn list<E: Exec>(exec: &E, workspace: &Workspace) -> Result<Vec<Place>, Error> {
    let repo = workspace.repo.to_string_lossy();
    let out = exec
        .exec(&format!(
            "top=$(git -C {} rev-parse --show-toplevel 2>/dev/null) || exit {NOT_A_REPO}\n\
             printf '%s\\n' \"$top\" && git -C \"$top\" worktree list --porcelain -z",
            destination(&repo)
        ))
        .await?;
    if out.status == NOT_A_REPO {
        return Err(Error::NotARepo {
            repo: repo.into_owned(),
        });
    }
    let listed = out
        .stdout
        .iter()
        .position(|&byte| byte == b'\n')
        .filter(|_| out.success());
    let Some(newline) = listed else {
        return Err(Error::Worktree {
            stderr: said(&out.stderr),
        });
    };
    let top = String::from_utf8_lossy(&out.stdout[..newline]).into_owned();
    let found = worktrees(&out.stdout[newline + 1..], &workspace.name);
    if found.is_empty() {
        return Ok(Vec::new());
    }

    let asks: Vec<String> = found
        .iter()
        .map(|(_, id)| format!("git -C {} merge-base {} HEAD", sq(&top), sq(&branch(id))))
        .collect();
    let out = exec.exec(&asks.join(" && ")).await?;
    if !out.success() {
        return Err(Error::Worktree {
            stderr: said(&out.stderr),
        });
    }
    let bases = String::from_utf8_lossy(&out.stdout);
    Ok(found
        .into_iter()
        .zip(bases.lines())
        .map(|((worktree, id), base)| Place {
            branch: branch(&id),
            id,
            repo: top.clone(),
            worktree,
            base: base.trim().to_owned(),
        })
        .collect())
}

/// Opens a thread as [`open`] does and keeps the issue under its branch. A
/// thread whose issue could not be kept is removed, so none is left unnamed.
pub async fn open_for_issue<E: Exec>(
    exec: &E,
    workspace: &Workspace,
    issue: &IssueRef,
) -> Result<Place, Error> {
    let place = open(exec, workspace).await?;
    let kept = exec
        .exec(&format!(
            "git -C {} config {} {}",
            sq(&place.repo),
            key(&place, "yantraIssue"),
            sq(&issue.to_string())
        ))
        .await;
    let failed = match kept {
        Ok(out) if out.success() => return Ok(place),
        Ok(out) => Error::Worktree {
            stderr: said(&out.stderr),
        },
        Err(error) => Error::Ssh(error),
    };
    // The write's own error is the one worth reporting.
    let _ = remove(exec, &place).await;
    Err(failed)
}

/// A thread with what git keeps about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub place: Place,
    /// `owner/repo#n`, as [`open_for_issue`] kept it.
    pub issue: Option<String>,
    /// The remote's URL and the branch on it, from `branch.<b>.remote` and
    /// `branch.<b>.merge`.
    pub upstream: Option<(String, String)>,
}

/// [`list`], and each thread's issue and upstream. One more round trip, and
/// none when the workspace has no thread.
pub async fn listed<E: Exec>(exec: &E, workspace: &Workspace) -> Result<Vec<Listed>, Error> {
    let places = list(exec, workspace).await?;
    let Some(first) = places.first() else {
        return Ok(Vec::new());
    };
    let out = exec
        .exec(&format!(
            "git -C {} config -z --get-regexp {}",
            sq(&first.repo),
            sq(&format!(
                "^branch\\.yantra/chat/{}/.*\\.(yantraissue|remote|merge)$|^remote\\..*\\.url$",
                workspace.name
            ))
        ))
        .await?;
    // `--get-regexp` exits 1 when no key matches.
    if !out.success() && !(out.status == 1 && out.stderr.is_empty()) {
        return Err(Error::Worktree {
            stderr: said(&out.stderr),
        });
    }
    let config = Config::parse(&out.stdout);
    Ok(places
        .into_iter()
        .map(|place| Listed {
            issue: config.get(&place.branch, "yantraissue").map(str::to_owned),
            upstream: config.upstream(&place.branch),
            place,
        })
        .collect())
}

/// `git config -z` output: `key\nvalue` records, each ended by a NUL. git
/// lowercases the section and the variable and keeps the subsection's case.
struct Config(Vec<(String, String)>);

impl Config {
    fn parse(raw: &[u8]) -> Self {
        Self(
            raw.split(|&byte| byte == 0)
                .filter(|record| !record.is_empty())
                .map(|record| {
                    let record = String::from_utf8_lossy(record);
                    let (key, value) = record.split_once('\n').unwrap_or((&record, ""));
                    (key.to_owned(), value.to_owned())
                })
                .collect(),
        )
    }

    fn value(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, value)| value.as_str())
    }

    fn get(&self, branch: &str, variable: &str) -> Option<&str> {
        self.value(&format!("branch.{branch}.{variable}"))
    }

    fn upstream(&self, branch: &str) -> Option<(String, String)> {
        let remote = self.get(branch, "remote")?;
        let merge = self.get(branch, "merge")?;
        let url = self.value(&format!("remote.{remote}.url"))?;
        let merge = merge.strip_prefix("refs/heads/").unwrap_or(merge);
        Some((url.to_owned(), merge.to_owned()))
    }
}

/// The composer's first text for a thread opened from `issue`.
pub fn draft(issue: &IssueRef, read: &Issue) -> String {
    let first = format!("Work on {issue}: {}", read.title);
    if read.body.trim().is_empty() {
        first
    } else {
        format!("{first}\n\n{}", read.body)
    }
}

/// A thread as `yantra chat ls` and `POST /api/workspaces/{name}/threads`
/// show it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thread {
    /// [`name`]: the short id.
    pub id: String,
    pub branch: String,
    pub worktree: String,
    pub issue: Option<String>,
    pub pr: Pr,
}

/// A thread's PR, read from its upstream each time it is asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pr {
    /// No upstream, or no PR from it.
    None,
    Open {
        number: u64,
        url: String,
    },
    Closed {
        number: u64,
        url: String,
    },
    Merged {
        number: u64,
        url: String,
    },
    /// No grant, an upstream not on github.com, or a GitHub that failed.
    Unknown {
        said: String,
    },
}

/// What [`start`] opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub thread: String,
    pub branch: String,
    pub worktree: String,
    pub issue: String,
    pub draft: String,
}

#[derive(Debug, thiserror::Error)]
pub enum Failed {
    #[error(transparent)]
    Workspace(#[from] workspace::Error),

    #[error(transparent)]
    Thread(#[from] Error),

    #[error(transparent)]
    Github(#[from] github::Error),

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

fn reach(workspace: &Workspace) -> Result<Ssh, Failed> {
    let machine = ssh::machine_at(&workspace.machine).ok_or(Failed::NoStateDir)?;
    Ok(Ssh::new(machine).map_err(Error::Ssh)?)
}

/// Every thread of workspace `name`, with its issue and PR. Without a grant
/// a thread with an upstream says its PR is unknown.
pub async fn threads(name: &str, github: Option<(&Github, &Token)>) -> Result<Vec<Thread>, Failed> {
    let workspace = workspace::load(name)?;
    let ssh = reach(&workspace)?;
    let mut threads = Vec::new();
    for found in listed(&ssh, &workspace).await? {
        let pr = match &found.upstream {
            None => Pr::None,
            Some((url, branch)) => pr_of(github, url, branch).await,
        };
        threads.push(Thread {
            id: self::name(&found.place).to_owned(),
            branch: found.place.branch,
            worktree: found.place.worktree,
            issue: found.issue,
            pr,
        });
    }
    Ok(threads)
}

async fn pr_of(github: Option<(&Github, &Token)>, url: &str, branch: &str) -> Pr {
    let Some((github, token)) = github else {
        return Pr::Unknown {
            said: github::Error::NoGrant.to_string(),
        };
    };
    // The URL is not repeated: a remote can carry a credential in it.
    let Some((owner, repo)) = github::repo_of(url) else {
        return Pr::Unknown {
            said: "the upstream is not a github.com repository".to_owned(),
        };
    };
    match github.pull_for_head(token, &owner, &repo, branch).await {
        Ok(None) => Pr::None,
        Ok(Some(pull)) => {
            let (number, url) = (pull.number, pull.url);
            match pull.state {
                PullState::Open => Pr::Open { number, url },
                PullState::Closed => Pr::Closed { number, url },
                PullState::Merged => Pr::Merged { number, url },
            }
        }
        Err(error) => Pr::Unknown {
            said: error.to_string(),
        },
    }
}

/// Opens a thread of workspace `name` from `issue`. The issue is read before
/// any worktree is made, so an issue that cannot be read opens nothing.
pub async fn start(
    name: &str,
    issue: &IssueRef,
    github: &Github,
    token: &Token,
) -> Result<Opened, Failed> {
    let workspace = workspace::load(name)?;
    let read = github.issue(token, issue).await?;
    let ssh = reach(&workspace)?;
    let place = open_for_issue(&ssh, &workspace, issue).await?;
    Ok(Opened {
        thread: self::name(&place).to_owned(),
        branch: place.branch,
        worktree: place.worktree,
        issue: issue.to_string(),
        draft: draft(issue, &read),
    })
}

/// The worktree path and id of each entry of `git worktree list --porcelain -z`
/// whose branch is one of `name`'s threads.
fn worktrees(porcelain: &[u8], name: &str) -> Vec<(String, String)> {
    let prefix = format!("refs/heads/yantra/chat/{name}/");
    let mut found = Vec::new();
    let mut worktree = None;
    for field in porcelain.split(|&byte| byte == 0) {
        let field = String::from_utf8_lossy(field);
        if let Some(path) = field.strip_prefix("worktree ") {
            worktree = Some(path.to_owned());
        } else if let Some(branch) = field.strip_prefix("branch ")
            && branch.starts_with(&prefix)
            && let Some(path) = worktree.take()
        {
            found.push((path, branch["refs/heads/yantra/".len()..].to_owned()));
        }
    }
    found
}

fn key(place: &Place, name: &str) -> String {
    sq(&format!("branch.{}.{name}", place.branch))
}

/// Keeps an ACP thread's harness and session. The session is written first,
/// so a thread that names a harness always names its session too.
pub async fn remember<E: Exec>(
    exec: &E,
    place: &Place,
    harness: Harness,
    session: &str,
) -> Result<(), Error> {
    let repo = sq(&place.repo);
    let out = exec
        .exec(&format!(
            "git -C {repo} config {} {} && git -C {repo} config {} {}",
            key(place, "yantraSession"),
            sq(session),
            key(place, "yantraHarness"),
            sq(harness.name()),
        ))
        .await?;
    if !out.success() {
        return Err(Error::Worktree {
            stderr: said(&out.stderr),
        });
    }
    Ok(())
}

/// The harness and session [`remember`] kept, or `None` for a Claude thread.
pub async fn recall<E: Exec>(exec: &E, place: &Place) -> Result<Option<(Harness, String)>, Error> {
    let repo = sq(&place.repo);
    let out = exec
        .exec(&format!(
            "git -C {repo} config --get {} && git -C {repo} config --get {}",
            key(place, "yantraHarness"),
            key(place, "yantraSession"),
        ))
        .await?;
    // `config --get` exits 1 for a key that is not set.
    if out.status == 1 && out.stderr.is_empty() {
        return Ok(None);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut lines = stdout.lines();
    match (out.success(), lines.next(), lines.next()) {
        (true, Some(harness), Some(session)) => harness
            .parse()
            .map(|harness| Some((harness, session.to_owned())))
            .map_err(|stderr| Error::Worktree { stderr }),
        _ => Err(Error::Worktree {
            stderr: said(&out.stderr),
        }),
    }
}

/// Removes the worktree, the branch and the checkpoints, uncommitted work
/// included. The only path that deletes a thread.
pub async fn remove<E: Exec>(exec: &E, place: &Place) -> Result<(), Error> {
    let out = exec
        .exec(&format!(
            "{} && {}",
            delegate::removal(place),
            checkpoint::forget(place)
        ))
        .await?;
    if !out.success() {
        return Err(Error::Worktree {
            stderr: said(&out.stderr),
        });
    }
    Ok(())
}

pub async fn logs<E: Exec>(
    exec: &E,
    place: &Place,
    session: Option<&str>,
    lines: usize,
    before: usize,
) -> Result<Transcript, logs::Error> {
    logs::read(exec, &place.worktree, session, lines, before).await
}

pub async fn spent<E: Exec>(
    exec: &E,
    place: &Place,
    session: Option<&str>,
    since: Option<OffsetDateTime>,
) -> Result<Spend, logs::Error> {
    tokens::spent(exec, &place.worktree, session, since).await
}

pub async fn status<E: Exec>(exec: &E, place: &Place) -> Result<Status, Error> {
    let agent = crate::status::registry(exec)
        .await
        .into_iter()
        .find(|running| running.cwd == place.worktree);
    let summary = delegate::summarise(exec, &place.worktree, &place.base).await?;
    Ok(Status { agent, summary })
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::ssh;
    use std::path::PathBuf;
    use std::sync::{Mutex, PoisonError};

    const REPO: &str = "/home/u/repo";
    const WORKTREE: &str = "/home/u/.yantra/worktrees/chat/web/11111111";
    const REPO_SLUG: &str = "-home-u-repo";
    const WORKTREE_SLUG: &str = "-home-u--yantra-worktrees-chat-web-11111111";

    /// A scripted machine that keeps every command it was sent.
    #[derive(Default)]
    struct Machine {
        replies: Mutex<Vec<ssh::Output>>,
        asked: Mutex<Vec<String>>,
    }

    impl Machine {
        fn answering(replies: Vec<ssh::Output>) -> Self {
            Self {
                replies: Mutex::new(replies),
                asked: Mutex::default(),
            }
        }

        fn asked(&self) -> Vec<String> {
            self.asked
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        }
    }

    impl Exec for Machine {
        async fn exec(&self, command: &str) -> Result<ssh::Output, ssh::Error> {
            self.asked
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(command.to_owned());
            Ok(self
                .replies
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(0))
        }
    }

    fn out(status: i32, stdout: &[u8], stderr: &str) -> ssh::Output {
        ssh::Output {
            status,
            stdout: stdout.to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    fn workspace(name: &str) -> Workspace {
        Workspace {
            name: name.to_owned(),
            machine: "m".to_owned(),
            repo: PathBuf::from(REPO),
            startup: None,
        }
    }

    fn place() -> Place {
        Place {
            id: "chat/web/11111111".to_owned(),
            repo: REPO.to_owned(),
            worktree: WORKTREE.to_owned(),
            branch: "yantra/chat/web/11111111".to_owned(),
            base: "0123abcd".to_owned(),
        }
    }

    #[tokio::test]
    async fn open_makes_a_nested_branch_and_worktree_for_the_workspace() {
        let machine = Machine::answering(vec![out(0, b"", "")]);
        let _ = open(&machine, &workspace("web")).await;
        let asked = machine.asked();
        let id = asked[0]
            .split("worktrees/'chat/web/")
            .nth(1)
            .and_then(|rest| rest.get(..16))
            .expect("the worktree is under chat/<workspace>/")
            .to_owned();
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()), "{id}");
        assert_eq!(
            asked[0],
            format!(
                "top=$(git -C '{REPO}' rev-parse --show-toplevel 2>/dev/null) || exit 3\n\
                 wt=\"$HOME\"/.yantra/worktrees/'chat/web/{id}'\n\
                 mkdir -p \"$HOME/.yantra/worktrees\" \
                 && git -C \"$top\" worktree add -q -b 'yantra/chat/web/{id}' \"$wt\" HEAD >&2 \
                 && printf '%s\\n%s\\n' \"$top\" \"$wt\" && git -C \"$wt\" rev-parse HEAD"
            )
        );

        let made = Machine::answering(vec![out(
            0,
            format!("{REPO}\n{WORKTREE}\n0123abcd\n").as_bytes(),
            "",
        )]);
        let place = open(&made, &workspace("web")).await.expect("opened");
        assert!(place.id.starts_with("chat/web/"), "{place:?}");
        assert_eq!(place.branch, format!("yantra/{}", place.id));
        assert_eq!(place.repo, REPO);
        assert_eq!(place.worktree, WORKTREE);
        assert_eq!(place.base, "0123abcd");
    }

    #[test]
    fn a_thread_is_named_by_the_last_part_of_its_id() {
        assert_eq!(name(&place()), "11111111");
    }

    #[tokio::test]
    async fn open_names_a_path_that_is_not_a_repo_and_a_git_that_failed() {
        let not = Machine::answering(vec![out(NOT_A_REPO, b"", "")]);
        assert!(matches!(
            open(&not, &workspace("web")).await,
            Err(Error::NotARepo { repo }) if repo == REPO
        ));
        let failed = Machine::answering(vec![out(
            128,
            b"",
            "fatal: a branch named 'x' already exists\n",
        )]);
        assert!(matches!(
            open(&failed, &workspace("web")).await,
            Err(Error::Worktree { stderr }) if stderr == "fatal: a branch named 'x' already exists"
        ));
    }

    const PORCELAIN: &[u8] = b"/home/u/repo\n\
        worktree /home/u/repo\0HEAD 0123abcd\0branch refs/heads/main\0\0\
        worktree /home/u/.yantra/worktrees/chat/a/11111111\0HEAD 1111\0\
        branch refs/heads/yantra/chat/a/11111111\0\0\
        worktree /home/u/.yantra/worktrees/chat/a-b/22222222\0HEAD 2222\0\
        branch refs/heads/yantra/chat/a-b/22222222\0\0\
        worktree /home/u/.yantra/worktrees/33333333\0HEAD 3333\0\
        branch refs/heads/yantra/33333333\0\0\
        worktree /tmp/detached\0HEAD 4444\0detached\0\0\
        worktree /home/u/.yantra/worktrees/chat/a/55555555\0HEAD 5555\0\
        branch refs/heads/yantra/chat/a/55555555\0locked\0\0";

    #[tokio::test]
    async fn list_keeps_only_this_workspaces_threads_and_asks_each_base() {
        let machine = Machine::answering(vec![out(0, PORCELAIN, ""), out(0, b"aaaa\nbbbb\n", "")]);
        let found = list(&machine, &workspace("a")).await.expect("listed");
        assert_eq!(
            machine.asked(),
            [
                format!(
                    "top=$(git -C '{REPO}' rev-parse --show-toplevel 2>/dev/null) || exit 3\n\
                     printf '%s\\n' \"$top\" && git -C \"$top\" worktree list --porcelain -z"
                ),
                format!(
                    "git -C '{REPO}' merge-base 'yantra/chat/a/11111111' HEAD \
                     && git -C '{REPO}' merge-base 'yantra/chat/a/55555555' HEAD"
                ),
            ]
        );
        let thread = |id: &str, base: &str| Place {
            id: format!("chat/a/{id}"),
            repo: REPO.to_owned(),
            worktree: format!("/home/u/.yantra/worktrees/chat/a/{id}"),
            branch: format!("yantra/chat/a/{id}"),
            base: base.to_owned(),
        };
        assert_eq!(
            found,
            [thread("11111111", "aaaa"), thread("55555555", "bbbb")]
        );
    }

    #[tokio::test]
    async fn a_workspace_with_no_threads_asks_once() {
        let machine = Machine::answering(vec![out(0, PORCELAIN, "")]);
        assert_eq!(list(&machine, &workspace("web")).await.expect("listed"), []);
        assert_eq!(machine.asked().len(), 1);
    }

    #[tokio::test]
    async fn a_tilde_repo_reaches_the_shell_through_home() {
        let machine = Machine::answering(vec![out(0, b"/home/u/r\n", "")]);
        let mut tilde = workspace("a");
        tilde.repo = PathBuf::from("~/r");
        assert_eq!(list(&machine, &tilde).await.expect("listed"), []);
        assert!(
            machine.asked()[0].starts_with(r#"top=$(git -C "$HOME"/'r' rev-parse"#),
            "{:?}",
            machine.asked()
        );
    }

    #[tokio::test]
    async fn list_names_every_way_it_can_fail() {
        let not = Machine::answering(vec![out(NOT_A_REPO, b"", "")]);
        assert!(matches!(
            list(&not, &workspace("a")).await,
            Err(Error::NotARepo { repo }) if repo == REPO
        ));

        let old_git = Machine::answering(vec![out(
            129,
            b"/home/u/repo\n",
            "error: unknown switch `z'\n",
        )]);
        assert!(matches!(
            list(&old_git, &workspace("a")).await,
            Err(Error::Worktree { stderr }) if stderr == "error: unknown switch `z'"
        ));

        let no_base = Machine::answering(vec![
            out(0, PORCELAIN, ""),
            out(1, b"", "fatal: Not a valid object name HEAD\n"),
        ]);
        assert!(matches!(
            list(&no_base, &workspace("a")).await,
            Err(Error::Worktree { stderr }) if stderr == "fatal: Not a valid object name HEAD"
        ));
    }

    #[tokio::test]
    async fn remove_runs_the_removal_and_names_a_refusal() {
        let machine = Machine::answering(vec![out(0, b"", "")]);
        remove(&machine, &place()).await.expect("removed");
        assert_eq!(
            machine.asked(),
            [format!(
                "{{ [ ! -e '{WORKTREE}' ] \
                 || git -C '{REPO}' worktree remove --force '{WORKTREE}'; }} \
                 && git -C '{REPO}' worktree prune \
                 && {{ ! git -C '{REPO}' rev-parse -q --verify \
                 'refs/heads/yantra/chat/web/11111111' >/dev/null \
                 || git -C '{REPO}' branch -D 'yantra/chat/web/11111111' >/dev/null; }} \
                 && git -C '{REPO}' for-each-ref --format='delete %(refname)' \
                 'refs/yantra/checkpoints/chat/web/11111111' \
                 | git -C '{REPO}' update-ref --stdin"
            )]
        );

        let refused = Machine::answering(vec![out(128, b"", "fatal: not a working tree\n")]);
        assert!(matches!(
            remove(&refused, &place()).await,
            Err(Error::Worktree { stderr }) if stderr == "fatal: not a working tree"
        ));
    }

    #[tokio::test]
    async fn remember_writes_the_session_then_the_harness_under_the_branch() {
        let machine = Machine::answering(vec![out(0, b"", "")]);
        remember(&machine, &place(), Harness::Opencode, "ses_1")
            .await
            .expect("kept");
        assert_eq!(
            machine.asked(),
            [format!(
                "git -C '{REPO}' config 'branch.yantra/chat/web/11111111.yantraSession' 'ses_1' \
                 && git -C '{REPO}' config 'branch.yantra/chat/web/11111111.yantraHarness' 'opencode'"
            )]
        );

        let refused =
            Machine::answering(vec![out(255, b"", "error: could not lock config file\n")]);
        assert!(matches!(
            remember(&refused, &place(), Harness::Codex, "s").await,
            Err(Error::Worktree { stderr }) if stderr == "error: could not lock config file"
        ));
    }

    #[tokio::test]
    async fn recall_reads_both_keys_and_a_thread_without_them_is_claudes() {
        let machine = Machine::answering(vec![out(0, b"opencode\nses_1\n", "")]);
        assert_eq!(
            recall(&machine, &place()).await.expect("read"),
            Some((Harness::Opencode, "ses_1".to_owned()))
        );
        assert_eq!(
            machine.asked(),
            [format!(
                "git -C '{REPO}' config --get 'branch.yantra/chat/web/11111111.yantraHarness' \
                 && git -C '{REPO}' config --get 'branch.yantra/chat/web/11111111.yantraSession'"
            )]
        );

        let claude = Machine::answering(vec![out(1, b"", "")]);
        assert_eq!(recall(&claude, &place()).await.expect("read"), None);

        let gone = Machine::answering(vec![out(128, b"", "fatal: cannot change to '/x'\n")]);
        assert!(matches!(
            recall(&gone, &place()).await,
            Err(Error::Worktree { stderr }) if stderr == "fatal: cannot change to '/x'"
        ));
        let odd = Machine::answering(vec![out(0, b"aider\nses_1\n", "")]);
        assert!(matches!(
            recall(&odd, &place()).await,
            Err(Error::Worktree { stderr }) if stderr.contains("`aider`")
        ));
    }

    fn reads_the_worktree(command: &str) {
        assert!(
            command.contains(&format!("d=$HOME/.claude/projects/{WORKTREE_SLUG}\n")),
            "{command}"
        );
        assert!(!command.contains(REPO_SLUG), "{command}");
    }

    #[tokio::test]
    async fn logs_and_spend_read_the_worktrees_transcript() {
        let machine = Machine::answering(vec![
            out(0, b"/p/s.jsonl\n10\n12\n0\n", ""),
            out(0, b"/p/s.jsonl\n", ""),
        ]);
        let transcript = logs(&machine, &place(), Some("s"), 50, 0)
            .await
            .expect("read");
        assert_eq!(transcript.path, "/p/s.jsonl");
        let spend = spent(&machine, &place(), Some("s"), None)
            .await
            .expect("tallied");
        assert_eq!(spend.path, "/p/s.jsonl");
        for command in machine.asked() {
            reads_the_worktree(&command);
        }

        let none = Machine::answering(vec![
            out(logs::NO_TRANSCRIPT, b"", ""),
            out(logs::NO_TRANSCRIPT, b"", ""),
        ]);
        assert!(matches!(
            logs(&none, &place(), None, 50, 0).await,
            Err(logs::Error::NoTranscript { repo }) if repo == WORKTREE
        ));
        assert!(matches!(
            spent(&none, &place(), None, None).await,
            Err(logs::Error::NoTranscript { repo }) if repo == WORKTREE
        ));
    }

    #[tokio::test]
    async fn status_finds_the_agent_in_the_worktree_and_what_changed() {
        let registry = format!(
            r#"[{{"pid":1,"cwd":"{REPO}","sessionId":"r"}},{{"pid":2,"cwd":"{WORKTREE}","sessionId":"w"}}]"#
        );
        let machine = Machine::answering(vec![
            out(0, b"/usr/bin/claude\n", ""),
            out(0, registry.as_bytes(), ""),
            out(0, b" 1 file changed, 1 insertion(+)\n\0a.txt\0", ""),
        ]);
        let status = status(&machine, &place()).await.expect("asked");
        assert_eq!(status.agent.map(|agent| agent.pid), Some(2));
        assert_eq!(
            status.summary,
            Summary {
                changed: vec!["a.txt".to_owned()],
                shortstat: "1 file changed, 1 insertion(+)".to_owned(),
            }
        );
        let asked = machine.asked();
        assert_eq!(asked[1], "'/usr/bin/claude' agents --json");
        assert_eq!(
            asked[2],
            format!(
                "git -C '{WORKTREE}' diff --shortstat '0123abcd' && printf '\\0' \
                 && git -C '{WORKTREE}' diff --name-only -z '0123abcd' \
                 && git -C '{WORKTREE}' ls-files -z --others --exclude-standard"
            )
        );
        assert_eq!(asked.len(), 3);
    }

    #[tokio::test]
    async fn status_without_claude_still_summarises_and_a_gone_worktree_is_an_error() {
        let alone = Machine::answering(vec![out(1, b"", ""), out(0, b"\0", "")]);
        let status_alone = status(&alone, &place()).await.expect("asked");
        assert_eq!(status_alone.agent, None);
        assert_eq!(status_alone.summary, Summary::default());

        let gone = Machine::answering(vec![
            out(1, b"", ""),
            out(128, b"", "fatal: cannot change to\n"),
        ]);
        assert!(matches!(
            status(&gone, &place()).await,
            Err(Error::Worktree { .. })
        ));
    }

    fn issue() -> IssueRef {
        "o/r#7".parse().expect("good")
    }

    #[tokio::test]
    async fn a_thread_from_an_issue_keeps_the_issue_under_its_branch() {
        let machine = Machine::answering(vec![
            out(0, format!("{REPO}\n{WORKTREE}\n0123abcd\n").as_bytes(), ""),
            out(0, b"", ""),
        ]);
        let place = open_for_issue(&machine, &workspace("web"), &issue())
            .await
            .expect("opened");
        assert_eq!(
            machine.asked()[1],
            format!(
                "git -C '{REPO}' config 'branch.{}.yantraIssue' 'o/r#7'",
                place.branch
            )
        );
        assert_eq!(machine.asked().len(), 2);
    }

    #[tokio::test]
    async fn a_thread_whose_issue_could_not_be_kept_is_removed() {
        let machine = Machine::answering(vec![
            out(0, format!("{REPO}\n{WORKTREE}\n0123abcd\n").as_bytes(), ""),
            out(255, b"", "error: could not lock config file\n"),
            out(0, b"", ""),
        ]);
        let failed = open_for_issue(&machine, &workspace("web"), &issue()).await;
        assert!(
            matches!(&failed, Err(Error::Worktree { stderr }) if stderr == "error: could not lock config file"),
            "{failed:?}"
        );
        let asked = machine.asked();
        assert_eq!(asked.len(), 3);
        assert!(asked[2].contains("worktree remove --force"), "{}", asked[2]);
        assert!(asked[2].contains("branch -D"), "{}", asked[2]);
    }

    const CONFIG: &[u8] = b"branch.yantra/chat/a/11111111.yantraissue\no/r#7\0\
        branch.yantra/chat/a/11111111.remote\norigin\0\
        branch.yantra/chat/a/11111111.merge\nrefs/heads/fix-7\0\
        branch.yantra/chat/a/55555555.remote\nmy.fork\0\
        remote.origin.url\nhttps://github.com/o/r.git\0\
        remote.my.fork.url\ngit@github.com:me/r.git\0";

    #[tokio::test]
    async fn listed_reads_each_threads_issue_and_upstream_in_one_more_call() {
        let machine = Machine::answering(vec![
            out(0, PORCELAIN, ""),
            out(0, b"aaaa\nbbbb\n", ""),
            out(0, CONFIG, ""),
        ]);
        let found = listed(&machine, &workspace("a")).await.expect("listed");
        assert_eq!(
            machine.asked()[2],
            format!(
                "git -C '{REPO}' config -z --get-regexp \
                 '^branch\\.yantra/chat/a/.*\\.(yantraissue|remote|merge)$|^remote\\..*\\.url$'"
            )
        );
        let read: Vec<_> = found
            .iter()
            .map(|listed| (listed.issue.as_deref(), listed.upstream.clone()))
            .collect();
        assert_eq!(
            read,
            [
                (
                    Some("o/r#7"),
                    Some(("https://github.com/o/r.git".to_owned(), "fix-7".to_owned()))
                ),
                // A remote with no `merge` is no upstream.
                (None, None),
            ]
        );
        assert_eq!(found[0].place.id, "chat/a/11111111");
    }

    #[tokio::test]
    async fn listed_with_no_keys_set_or_no_threads_is_plain() {
        let none = Machine::answering(vec![
            out(0, PORCELAIN, ""),
            out(0, b"aaaa\nbbbb\n", ""),
            out(1, b"", ""),
        ]);
        let found = listed(&none, &workspace("a")).await.expect("listed");
        assert!(
            found
                .iter()
                .all(|l| l.issue.is_none() && l.upstream.is_none())
        );

        let empty = Machine::answering(vec![out(0, PORCELAIN, "")]);
        assert_eq!(listed(&empty, &workspace("web")).await.expect("listed"), []);
        assert_eq!(empty.asked().len(), 1);

        let broken = Machine::answering(vec![
            out(0, PORCELAIN, ""),
            out(0, b"aaaa\nbbbb\n", ""),
            out(3, b"", "error: invalid config file\n"),
        ]);
        assert!(matches!(
            listed(&broken, &workspace("a")).await,
            Err(Error::Worktree { stderr }) if stderr == "error: invalid config file"
        ));
    }

    #[test]
    fn the_draft_names_the_issue_then_its_title_and_body() {
        let read = Issue {
            title: "Fix it".to_owned(),
            body: "Steps".to_owned(),
        };
        assert_eq!(draft(&issue(), &read), "Work on o/r#7: Fix it\n\nSteps");
        let bare = Issue {
            title: "Fix it".to_owned(),
            body: String::new(),
        };
        assert_eq!(draft(&issue(), &bare), "Work on o/r#7: Fix it");
    }

    #[tokio::test]
    async fn a_pr_without_a_grant_or_off_github_is_unknown_and_says_no_url() {
        assert_eq!(
            pr_of(None, "https://github.com/o/r", "b").await,
            Pr::Unknown {
                said: github::Error::NoGrant.to_string()
            }
        );
        let token = Token::new("t".to_owned());
        let github = Github::at("http://127.0.0.1:9", "http://127.0.0.1:9");
        match pr_of(
            Some((&github, &token)),
            "https://user:secret@gitlab.com/o/r",
            "b",
        )
        .await
        {
            Pr::Unknown { said } => assert!(!said.contains("secret"), "{said}"),
            other => panic!("{other:?}"),
        }
    }
}
