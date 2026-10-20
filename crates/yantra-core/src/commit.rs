/*
 * The message request below is T3 Code's, at commit 1451e7c:
 * https://github.com/pingdotgg/t3code/blob/main/apps/server/src/textGeneration/ClaudeTextGeneration.ts
 * https://github.com/pingdotgg/t3code/blob/main/packages/provider-core/src/server/textGenerationPrompts.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 *
 * Kept: the prompt's rules, the `{subject, body}` schema, and the flags that run `claude -p` with
 * no tools, no slash commands, no MCP servers, no hooks and no prompts, from a fresh temporary
 * directory. Changed: the diff is the whole worktree through a private index rather than the
 * staged patch, the run happens on the machine over ssh, and no session is kept.
 */
//! Commit and push a chat thread's branch (Y-492, ADR-0034 decisions 2 and 5).
//!
//! Every call is one remote command in the thread's worktree, with the
//! machine's own git identity and credential. Yantra keeps nothing: the
//! upstream is git's own `branch.<b>.remote` and `branch.<b>.merge`. No diff
//! and no message is logged or printed (Q5).

use crate::agent;
use crate::checkpoint::{DIFF_FLAGS, SNAPSHOT, capped};
use crate::delegate::said;
use crate::github::IssueRef;
use crate::ssh::{self, Exec, Ssh};
use crate::thread::{self, Place};
use crate::tmux::sq;
use crate::workspace::{self, Workspace};

/// T3 Code's commit prompt. The diff follows it on claude's stdin.
const PROMPT: &str = "You write concise git commit messages.\n\
                      Return a JSON object with keys: subject, body.\n\
                      Rules:\n\
                      - subject must be imperative, <= 72 chars, and no trailing period\n\
                      - body can be empty string or short bullet points\n\
                      - capture the primary user-visible or developer-visible change";
const SCHEMA: &str = r#"{"type":"object","properties":{"subject":{"type":"string"},"body":{"type":"string"}},"required":["subject","body"],"additionalProperties":false}"#;
/// How the commands below say what git would not.
const NO_IDENTITY: i32 = 3;
const NOTHING: i32 = 4;
const NO_REMOTE: i32 = 5;
const NO_CLAUDE: i32 = 127;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("claude could not write a commit message: {said}")]
    Claude { said: String },

    #[error("the machine has no git identity; set user.name and user.email there")]
    NoIdentity,

    #[error("the thread has nothing to commit")]
    NothingToCommit,

    #[error("the repository has no remote named origin")]
    NoRemote,

    #[error("the remote refused the push: {reason}")]
    Refused { reason: String },

    #[error("git failed: {stderr}")]
    Git { stderr: String },

    #[error(transparent)]
    Ssh(#[from] ssh::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Committed {
    pub commit: String,
    pub subject: String,
}

/// Where the branch went. The remote is its name, never its URL, which can
/// carry a credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pushed {
    pub remote: String,
    pub branch: String,
}

/// A commit message for everything the worktree changed, untracked files
/// too, written by `claude -p` on the machine with its own login.
pub async fn draft<E: Exec>(exec: &E, place: &Place) -> Result<String, Error> {
    let out = exec.exec(&draft_command(place)).await?;
    match out.status {
        NOTHING => Err(Error::NothingToCommit),
        NO_CLAUDE => Err(Error::Claude {
            said: said(&out.stderr),
        }),
        _ => message(&out),
    }
}

/// Claude runs from a fresh directory: a transcript under the worktree would
/// become the thread's next `--resume` target (`logs::newest`).
fn draft_command(place: &Place) -> String {
    let diff = |flags: &str| {
        format!("git -c core.quotePath=false diff {flags}{DIFF_FLAGS} HEAD \"$tree\"")
    };
    format!(
        "cd {worktree} || exit\n\
         {SNAPSHOT} || exit\n\
         git diff --quiet HEAD \"$tree\" && exit {NOTHING}\n\
         c=$({probe}) || {{ echo 'claude was not found on PATH or in any of: {searched}' >&2; exit {NO_CLAUDE}; }}\n\
         in=$(mktemp) && dir=$(mktemp -d) || exit\n\
         trap 'rm -rf \"$tmp\" \"$tmp.lock\" \"$in\" \"$dir\"' EXIT\n\
         {{ printf '%s\\n\\nFiles:\\n' {prompt}; {stat} || exit; printf '\\nPatch:\\n'\n\
         {patch}\n\
         }} > \"$in\"\n\
         cd \"$dir\" || exit\n\
         \"$c\" -p --output-format json --json-schema {schema} --tools '' --disable-slash-commands \
         --strict-mcp-config --permission-mode dontAsk --no-session-persistence \
         --settings '{{\"disableAllHooks\":true}}' < \"$in\"",
        worktree = sq(&place.worktree),
        probe = agent::probe("claude"),
        searched = agent::CANDIDATES.join(", "),
        prompt = sq(PROMPT),
        stat = diff("--stat "),
        patch = capped(&diff("")),
        schema = sq(SCHEMA),
    )
}

#[derive(serde::Deserialize)]
struct Reply {
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    structured_output: Option<Message>,
}

#[derive(serde::Deserialize)]
struct Message {
    subject: String,
    #[serde(default)]
    body: String,
}

/// `structured_output`, or `result` when only that holds the JSON.
fn message(out: &ssh::Output) -> Result<String, Error> {
    let unreadable = || Error::Claude {
        said: if out.success() {
            "claude answered with nothing Yantra can read as a message".to_owned()
        } else {
            said(&out.stderr)
        },
    };
    let reply: Reply = serde_json::from_slice(&out.stdout).map_err(|_| unreadable())?;
    if reply.is_error {
        return Err(Error::Claude {
            said: reply
                .result
                .map(|said| said.trim().to_owned())
                .filter(|said| !said.is_empty())
                .unwrap_or_else(|| "claude reported an error".to_owned()),
        });
    }
    let found = reply.structured_output.or_else(|| {
        reply
            .result
            .and_then(|result| serde_json::from_str(&result).ok())
    });
    let Some(Message { subject, body }) = found else {
        return Err(unreadable());
    };
    let (subject, body) = (subject.trim(), body.trim());
    match (subject.is_empty(), body.is_empty()) {
        (true, _) => Err(unreadable()),
        (false, true) => Ok(subject.to_owned()),
        (false, false) => Ok(format!("{subject}\n\n{body}")),
    }
}

/// Commits every change in the worktree with the machine's own identity.
/// Hooks run. A machine with no identity is refused before anything is
/// staged, and Yantra's checkpoint identity is never used (decision 2).
pub async fn commit<E: Exec>(exec: &E, place: &Place, message: &str) -> Result<Committed, Error> {
    let out = exec.exec(&commit_command(place, message)).await?;
    match out.status {
        NO_IDENTITY => return Err(Error::NoIdentity),
        NOTHING => return Err(Error::NothingToCommit),
        0 => {}
        _ => return Err(failed(&out)),
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut lines = stdout.lines();
    match (lines.next(), lines.next()) {
        (Some(commit), subject) if !commit.trim().is_empty() => Ok(Committed {
            commit: commit.trim().to_owned(),
            subject: subject.unwrap_or_default().to_owned(),
        }),
        _ => Err(Error::Git {
            stderr: "git did not name the commit it made".to_owned(),
        }),
    }
}

fn commit_command(place: &Place, message: &str) -> String {
    format!(
        "cd {worktree} || exit\n\
         for v in GIT_AUTHOR_IDENT GIT_COMMITTER_IDENT; do \
         git -c user.useConfigOnly=true var \"$v\" >/dev/null 2>&1 || exit {NO_IDENTITY}; done\n\
         git add -A || exit\n\
         git diff --cached --quiet && exit {NOTHING}\n\
         git -c user.useConfigOnly=true commit -q -m {message} >&2 || exit\n\
         git log -1 --format='%H%n%s'",
        worktree = sq(&place.worktree),
        message = sq(message),
    )
}

/// Pushes the thread's branch to its upstream, or to `origin` under a name
/// Yantra makes, and sets the upstream. Never forced.
pub async fn push<E: Exec>(
    exec: &E,
    place: &Place,
    issue: Option<&IssueRef>,
) -> Result<Pushed, Error> {
    let out = exec.exec(&push_command(place, issue)).await?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if let Some(reason) = refusal(&stdout) {
        return Err(Error::Refused { reason });
    }
    match out.status {
        NO_REMOTE => return Err(Error::NoRemote),
        0 => {}
        _ => return Err(failed(&out)),
    }
    let mut lines = stdout.lines();
    match (lines.next(), lines.next()) {
        (Some(remote), Some(branch)) => Ok(Pushed {
            remote: remote.to_owned(),
            branch: branch.to_owned(),
        }),
        _ => Err(Error::Git {
            stderr: "git did not name where it pushed".to_owned(),
        }),
    }
}

/// An explicit refspec, because `push.default=simple` refuses a branch whose
/// remote name differs from its local one. An upstream counts only if Yantra
/// could have set it: a thread opened before `--no-track` may track `main`.
fn push_command(place: &Place, issue: Option<&IssueRef>) -> String {
    let key = |name: &str| sq(&format!("branch.{}.{name}", place.branch));
    format!(
        "cd {worktree} || exit\n\
         r=$(git config --get {remote}) && m=$(git config --get {merge}) \
         && [ \"$r\" != . ] && [ \"${{m#refs/heads/yantra/}}\" != \"$m\" ] \
         || {{ r=origin; m={named}; git remote get-url origin >/dev/null 2>&1 || exit {NO_REMOTE}; }}\n\
         printf '%s\\n%s\\n' \"$r\" \"${{m#refs/heads/}}\"\n\
         GIT_TERMINAL_PROMPT=0 git push --porcelain -u \"$r\" {local}:\"$m\"",
        worktree = sq(&place.worktree),
        remote = key("remote"),
        merge = key("merge"),
        named = sq(&format!("refs/heads/{}", remote_branch(place, issue))),
        local = sq(&format!("refs/heads/{}", place.branch)),
    )
}

/// `yantra/<n>-<id>` for an issue thread and `yantra/<id>` otherwise: an
/// issue number and the thread id, never title text (I-24).
fn remote_branch(place: &Place, issue: Option<&IssueRef>) -> String {
    let id: String = thread::name(place)
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    match issue {
        Some(issue) => format!("yantra/{}-{id}", issue.number),
        None => format!("yantra/{id}"),
    }
}

/// The summary of a porcelain `!` line, such as `remote rejected (pre-receive
/// hook declined)`.
fn refusal(porcelain: &str) -> Option<String> {
    porcelain.lines().find_map(|line| {
        let summary = line.strip_prefix("!\t")?.split('\t').nth(1)?;
        Some(summary.replace(['[', ']'], ""))
    })
}

fn failed(out: &ssh::Output) -> Error {
    Error::Git {
        stderr: redact(&said(&out.stderr)),
    }
}

/// Drops `user:secret@` from every URL in `text`: a remote's URL can carry a
/// credential, and git repeats it in some of its errors.
fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let (head, tail) = rest.split_at(at + 3);
        out.push_str(head);
        let host_end = tail
            .find(|c: char| c == '/' || c.is_whitespace() || c == '\'' || c == '"')
            .unwrap_or(tail.len());
        rest = match tail[..host_end].rfind('@') {
            Some(userinfo) => &tail[userinfo + 1..],
            None => tail,
        };
    }
    out.push_str(rest);
    out
}

#[derive(Debug, thiserror::Error)]
pub enum Failed {
    #[error(transparent)]
    Workspace(#[from] workspace::Error),

    #[error("the workspace has no thread {id}")]
    NoThread { id: String },

    #[error(transparent)]
    Thread(#[from] thread::Error),

    #[error(transparent)]
    Commit(#[from] Error),

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

async fn reach(name: &str) -> Result<(Workspace, Ssh), Failed> {
    let workspace = workspace::load(name)?;
    let machine = ssh::machine_at(&workspace.machine).ok_or(Failed::NoStateDir)?;
    let ssh = Ssh::new(machine).map_err(Error::Ssh)?;
    Ok((workspace, ssh))
}

async fn find(name: &str, id: &str) -> Result<(Ssh, Place), Failed> {
    let (workspace, ssh) = reach(name).await?;
    let place = thread::list(&ssh, &workspace)
        .await?
        .into_iter()
        .find(|place| thread::name(place) == id)
        .ok_or_else(|| Failed::NoThread { id: id.to_owned() })?;
    Ok((ssh, place))
}

/// [`draft`] for thread `id` of workspace `name`.
pub async fn draft_for(name: &str, id: &str) -> Result<String, Failed> {
    let (ssh, place) = find(name, id).await?;
    Ok(draft(&ssh, &place).await?)
}

/// [`commit`] for thread `id` of workspace `name`, with a [`draft`] when no
/// message is given.
pub async fn commit_for(name: &str, id: &str, message: Option<&str>) -> Result<Committed, Failed> {
    let (ssh, place) = find(name, id).await?;
    let message = match message {
        Some(message) => message.to_owned(),
        None => draft(&ssh, &place).await?,
    };
    Ok(commit(&ssh, &place, &message).await?)
}

/// [`push`] for thread `id` of workspace `name`. An issue thread's remote
/// branch carries the issue's number.
pub async fn push_for(name: &str, id: &str) -> Result<Pushed, Failed> {
    let (workspace, ssh) = reach(name).await?;
    let found = thread::listed(&ssh, &workspace)
        .await?
        .into_iter()
        .find(|found| thread::name(&found.place) == id)
        .ok_or_else(|| Failed::NoThread { id: id.to_owned() })?;
    let issue = found.issue.and_then(|issue| issue.parse::<IssueRef>().ok());
    Ok(push(&ssh, &found.place, issue.as_ref()).await?)
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use std::sync::{Mutex, PoisonError};

    const WORKTREE: &str = "/home/u/.yantra/worktrees/chat/web/11111111";

    /// A scripted machine that keeps every command it was sent, as in `thread.rs`.
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

    fn out(status: i32, stdout: &str, stderr: &str) -> ssh::Output {
        ssh::Output {
            status,
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    fn place() -> Place {
        Place {
            id: "chat/web/11111111".to_owned(),
            repo: "/home/u/repo".to_owned(),
            worktree: WORKTREE.to_owned(),
            branch: "yantra/chat/web/11111111".to_owned(),
            base: "0123abcd".to_owned(),
        }
    }

    fn issue() -> IssueRef {
        "o/r#42".parse().expect("an issue")
    }

    /// What the machine's shell receives for `word` once `sq` quoted it.
    fn shell_reads(quoted: &str) -> String {
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("printf %s {quoted}"))
            .output()
            .expect("sh runs");
        String::from_utf8(output.stdout).expect("utf-8")
    }

    #[test]
    fn a_rejected_and_a_remote_rejected_line_are_refusals_and_a_clean_push_is_not() {
        let rejected = "To ../bare.git\n\
                        !\trefs/heads/main:refs/heads/yantra/x\t[rejected] (non-fast-forward)\nDone\n";
        assert_eq!(
            refusal(rejected).as_deref(),
            Some("rejected (non-fast-forward)")
        );
        let hook = "origin\nyantra/x\nTo ../bare.git\n\
                    !\trefs/heads/main:refs/heads/yantra/x\t[remote rejected] (pre-receive hook declined)\nDone\n";
        assert_eq!(
            refusal(hook).as_deref(),
            Some("remote rejected (pre-receive hook declined)")
        );
        let clean = "origin\nyantra/x\nTo ../bare.git\n\
                     *\trefs/heads/main:refs/heads/yantra/x\t[new branch]\nDone\n";
        assert_eq!(refusal(clean), None);
    }

    #[test]
    fn claude_json_is_read_from_structured_output_then_result() {
        let structured = out(
            0,
            r#"{"type":"result","is_error":false,"result":"ignored","structured_output":{"subject":" Add x ","body":"- one\n- two"}}"#,
            "",
        );
        assert_eq!(message(&structured).expect("read"), "Add x\n\n- one\n- two");
        let bare = out(
            0,
            r#"{"is_error":false,"result":"{\"subject\":\"Fix y\",\"body\":\"\"}"}"#,
            "",
        );
        assert_eq!(message(&bare).expect("read"), "Fix y");
    }

    #[test]
    fn a_claude_error_and_a_reply_no_one_can_read_are_named() {
        let error = out(
            1,
            r#"{"is_error":true,"result":"Not logged in · Please run /login"}"#,
            "",
        );
        assert!(matches!(
            message(&error),
            Err(Error::Claude { said }) if said == "Not logged in · Please run /login"
        ));
        for garbage in [
            "not json",
            "{}",
            r#"{"result":"plain prose"}"#,
            r#"{"structured_output":{"subject":"  ","body":"x"}}"#,
        ] {
            assert!(
                matches!(message(&out(0, garbage, "")), Err(Error::Claude { .. })),
                "{garbage}"
            );
        }
        let died = out(2, "", "error: unknown option '--x'\n");
        assert!(matches!(
            message(&died),
            Err(Error::Claude { said }) if said == "error: unknown option '--x'"
        ));
    }

    #[test]
    fn the_remote_branch_is_the_issue_number_and_the_thread_id() {
        assert_eq!(remote_branch(&place(), None), "yantra/11111111");
        assert_eq!(
            remote_branch(&place(), Some(&issue())),
            "yantra/42-11111111"
        );
        let mut odd = place();
        odd.id = "chat/web/a b;$(x)".to_owned();
        assert_eq!(remote_branch(&odd, None), "yantra/abx");
    }

    #[test]
    fn a_message_with_quotes_and_a_substitution_reaches_git_as_written() {
        let message = "Don't run $(rm -rf ~) or `id`\n\nit's \"fine\"";
        let command = commit_command(&place(), message);
        let quoted = sq(message);
        assert!(command.contains(&format!("commit -q -m {quoted} >&2")));
        assert_eq!(shell_reads(&quoted), message);
    }

    #[tokio::test]
    async fn commit_checks_the_identity_stages_everything_and_reads_back_the_commit() {
        let machine = Machine::answering(vec![out(0, "89abcdef\nAdd x\n", "")]);
        assert_eq!(
            commit(&machine, &place(), "Add x")
                .await
                .expect("committed"),
            Committed {
                commit: "89abcdef".to_owned(),
                subject: "Add x".to_owned(),
            }
        );
        assert_eq!(
            machine.asked(),
            [format!(
                "cd '{WORKTREE}' || exit\n\
                 for v in GIT_AUTHOR_IDENT GIT_COMMITTER_IDENT; do \
                 git -c user.useConfigOnly=true var \"$v\" >/dev/null 2>&1 || exit 3; done\n\
                 git add -A || exit\n\
                 git diff --cached --quiet && exit 4\n\
                 git -c user.useConfigOnly=true commit -q -m 'Add x' >&2 || exit\n\
                 git log -1 --format='%H%n%s'"
            )]
        );
    }

    #[tokio::test]
    async fn a_commit_without_identity_or_changes_or_past_a_hook_is_named() {
        let machine = Machine::answering(vec![
            out(NO_IDENTITY, "", ""),
            out(NOTHING, "", ""),
            out(1, "", "pre-commit: lint failed\n"),
            out(0, "", ""),
        ]);
        assert!(matches!(
            commit(&machine, &place(), "m").await,
            Err(Error::NoIdentity)
        ));
        assert!(matches!(
            commit(&machine, &place(), "m").await,
            Err(Error::NothingToCommit)
        ));
        assert!(matches!(
            commit(&machine, &place(), "m").await,
            Err(Error::Git { stderr }) if stderr == "pre-commit: lint failed"
        ));
        assert!(matches!(
            commit(&machine, &place(), "m").await,
            Err(Error::Git { .. })
        ));
    }

    #[tokio::test]
    async fn push_names_the_upstream_or_makes_one_and_never_forces() {
        let machine = Machine::answering(vec![out(
            0,
            "origin\nyantra/42-11111111\nTo git@github.com:o/r.git\n\
             *\trefs/heads/yantra/chat/web/11111111:refs/heads/yantra/42-11111111\t[new branch]\nDone\n",
            "",
        )]);
        assert_eq!(
            push(&machine, &place(), Some(&issue()))
                .await
                .expect("pushed"),
            Pushed {
                remote: "origin".to_owned(),
                branch: "yantra/42-11111111".to_owned(),
            }
        );
        let asked = machine.asked();
        assert_eq!(
            asked,
            [format!(
                "cd '{WORKTREE}' || exit\n\
                 r=$(git config --get 'branch.yantra/chat/web/11111111.remote') \
                 && m=$(git config --get 'branch.yantra/chat/web/11111111.merge') \
                 && [ \"$r\" != . ] && [ \"${{m#refs/heads/yantra/}}\" != \"$m\" ] \
                 || {{ r=origin; m='refs/heads/yantra/42-11111111'; \
                 git remote get-url origin >/dev/null 2>&1 || exit 5; }}\n\
                 printf '%s\\n%s\\n' \"$r\" \"${{m#refs/heads/}}\"\n\
                 GIT_TERMINAL_PROMPT=0 git push --porcelain -u \"$r\" \
                 'refs/heads/yantra/chat/web/11111111':\"$m\""
            )]
        );
        assert!(!asked[0].contains("force") && !asked[0].contains(" +"));
    }

    #[tokio::test]
    async fn a_refused_push_no_origin_and_a_failed_push_are_named_without_a_credential() {
        let machine = Machine::answering(vec![
            out(
                1,
                "origin\nyantra/11111111\nTo x\n\
                 !\trefs/heads/a:refs/heads/b\t[rejected] (non-fast-forward)\nDone\n",
                "error: failed to push some refs\n",
            ),
            out(NO_REMOTE, "", ""),
            out(
                128,
                "origin\nyantra/11111111\n",
                "fatal: unable to access 'https://me:ghp_secret@github.com/o/r.git/': 403\n",
            ),
        ]);
        assert!(matches!(
            push(&machine, &place(), None).await,
            Err(Error::Refused { reason }) if reason == "rejected (non-fast-forward)"
        ));
        assert!(matches!(
            push(&machine, &place(), None).await,
            Err(Error::NoRemote)
        ));
        assert!(matches!(
            push(&machine, &place(), None).await,
            Err(Error::Git { stderr })
                if stderr == "fatal: unable to access 'https://github.com/o/r.git/': 403"
        ));
    }

    #[test]
    fn redact_drops_the_userinfo_of_every_url() {
        assert_eq!(redact("ssh://git@host/x and done"), "ssh://host/x and done");
        assert_eq!(redact("no url here"), "no url here");
        assert_eq!(redact("https://github.com/o/r"), "https://github.com/o/r");
    }

    #[tokio::test]
    async fn draft_snapshots_the_tree_and_runs_claude_outside_the_worktree() {
        let machine = Machine::answering(vec![out(
            0,
            r#"{"is_error":false,"structured_output":{"subject":"Add x","body":""}}"#,
            "",
        )]);
        assert_eq!(draft(&machine, &place()).await.expect("drafted"), "Add x");
        let asked = machine.asked();
        let command = &asked[0];
        assert!(command.starts_with(&format!("cd '{WORKTREE}' || exit\n{SNAPSHOT} || exit\n")));
        assert!(command.contains("git diff --quiet HEAD \"$tree\" && exit 4\n"));
        assert!(command.contains("cd \"$dir\" || exit\n\"$c\" -p --output-format json"));
        for flag in [
            "--tools ''",
            "--disable-slash-commands",
            "--strict-mcp-config",
            "--permission-mode dontAsk",
            "--no-session-persistence",
            "--settings '{\"disableAllHooks\":true}'",
            "< \"$in\"",
        ] {
            assert!(command.contains(flag), "{flag}");
        }
        assert!(command.contains("head -c 262145"), "the patch is capped");
    }

    #[tokio::test]
    async fn a_draft_with_nothing_changed_or_no_claude_is_named() {
        let machine = Machine::answering(vec![
            out(NOTHING, "", ""),
            out(NO_CLAUDE, "", "claude was not found on PATH\n"),
        ]);
        assert!(matches!(
            draft(&machine, &place()).await,
            Err(Error::NothingToCommit)
        ));
        assert!(matches!(
            draft(&machine, &place()).await,
            Err(Error::Claude { said }) if said == "claude was not found on PATH"
        ));
    }
}
