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

use time::OffsetDateTime;

use crate::agent::Running;
use crate::clone::destination;
use crate::delegate::{self, NOT_A_REPO, said};
pub use crate::delegate::{Error, Place, Summary};
use crate::logs::{self, Transcript};
use crate::ssh::Exec;
use crate::tmux::sq;
use crate::tokens::{self, Spend};
use crate::workspace::Workspace;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    /// The registry entry whose `cwd` is the thread's worktree.
    pub agent: Option<Running>,
    pub summary: Summary,
}

/// Makes a new worktree of the workspace's repository, at its `HEAD`. A live
/// session in the repository does not stop it.
pub async fn open<E: Exec>(exec: &E, workspace: &Workspace) -> Result<Place, Error> {
    let id = format!("chat/{}/{}", workspace.name, delegate::id());
    delegate::prepare(exec, &workspace.repo.to_string_lossy(), &id).await
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
    let found = threads(&out.stdout[newline + 1..], &workspace.name);
    if found.is_empty() {
        return Ok(Vec::new());
    }

    let asks: Vec<String> = found
        .iter()
        .map(|(_, id)| {
            format!(
                "git -C {} merge-base {} HEAD",
                sq(&top),
                sq(&format!("yantra/{id}"))
            )
        })
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
            branch: format!("yantra/{id}"),
            id,
            repo: top.clone(),
            worktree,
            base: base.trim().to_owned(),
        })
        .collect())
}

/// The worktree path and id of each entry of `git worktree list --porcelain -z`
/// whose branch is one of `name`'s threads.
fn threads(porcelain: &[u8], name: &str) -> Vec<(String, String)> {
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

/// Removes the worktree and the branch, uncommitted work included. The only
/// path that deletes a thread.
pub async fn remove<E: Exec>(exec: &E, place: &Place) -> Result<(), Error> {
    let out = exec.exec(&delegate::removal(place)).await?;
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
#[allow(clippy::expect_used)]
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
            .and_then(|rest| rest.get(..8))
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
                "git -C '{REPO}' worktree remove --force '{WORKTREE}' \
                 && git -C '{REPO}' branch -D 'yantra/chat/web/11111111' >/dev/null \
                 && git -C '{REPO}' worktree prune"
            )]
        );

        let refused = Machine::answering(vec![out(128, b"", "fatal: not a working tree\n")]);
        assert!(matches!(
            remove(&refused, &place()).await,
            Err(Error::Worktree { stderr }) if stderr == "fatal: not a working tree"
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
            out(0, b"a.txt\0", ""),
            out(0, b" 1 file changed, 1 insertion(+)\n", ""),
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
                "git -C '{WORKTREE}' diff --name-only -z '0123abcd' \
                 && git -C '{WORKTREE}' ls-files -z --others --exclude-standard"
            )
        );
        assert_eq!(
            asked[3],
            format!("git -C '{WORKTREE}' diff --shortstat '0123abcd'")
        );
    }

    #[tokio::test]
    async fn status_without_claude_still_summarises_and_a_gone_worktree_is_an_error() {
        let alone = Machine::answering(vec![out(1, b"", ""), out(0, b"", ""), out(0, b"", "")]);
        let status_alone = status(&alone, &place()).await.expect("asked");
        assert_eq!(status_alone.agent, None);
        assert_eq!(status_alone.summary, Summary::default());

        let gone = Machine::answering(vec![
            out(1, b"", ""),
            out(128, b"", "fatal: cannot change to\n"),
            out(128, b"", "fatal: cannot change to\n"),
        ]);
        assert!(matches!(
            status(&gone, &place()).await,
            Err(Error::Worktree { .. })
        ));
    }
}
