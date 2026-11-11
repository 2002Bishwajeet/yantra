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
//! Commit and push a chat thread's branch (Y-492, ADR-0034 decisions 2 and 5),
//! and open its PR with the daemon's grant (Y-449, decisions 1 and 3).
//!
//! Every call is one remote command in the thread's worktree, with the
//! machine's own git identity and credential. Yantra keeps nothing: the
//! upstream is git's own `branch.<b>.remote` and `branch.<b>.merge`. No diff
//! and no message is logged or printed (Q5). On a Mac the draft and the push
//! run inside the login session's tmux server, which can read the keychain
//! (I-44). Each call stops after five minutes (I-27).

use crate::agent;
use crate::checkpoint::{self, DIFF_FLAGS, SNAPSHOT, capped};
use crate::delegate::said;
use crate::github::{self, Conditional, Github, IssueRef, PullState, Token};
use crate::ssh::{self, Exec, Os, Ssh};
use crate::thread::{self, Place};
use crate::tmux::{self, Tmux, run_shell, sq};
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
const GIT_FAILED: i32 = 6;
const NOT_PUSHED: i32 = 7;
const AHEAD: i32 = 8;
const BEHIND: i32 = 9;
const DIVERGED: i32 = 10;
pub(crate) const TIMED_OUT: i32 = 124;
const NO_CLAUDE: i32 = 127;
/// How long a draft, a commit with its hooks, or a push may run.
const TIME_LIMIT_SECS: u64 = 5 * 60;
/// What [`carried`] prints between a command's stdout and its status.
const STATUS_MARK: &str = "yantra-status:";
const CUT_NOTE: &str = "[The patch is cut at 256 KiB. The file list above is complete.]";

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

    #[error("the commit message is empty")]
    EmptyMessage,

    #[error("the machine took longer than {minutes} minutes, so Yantra stopped it there")]
    TimedOut { minutes: u64 },

    #[error(
        "the Mac has no tmux server from a login session, because no one is logged in at its \
         screen, so git and claude there cannot read the login keychain (ADR-0018 §1). Log in at \
         that Mac, then try again"
    )]
    NoLoginServer,

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

/// A thread's PR. `created` is `false` when one was already open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    /// The repository the PR is on, which the appliance's watch keys by.
    pub owner: String,
    pub repo: String,
    pub number: u64,
    pub url: String,
    pub created: bool,
}

/// A thread's open PR and the head the owner is asked to confirm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    pub owner: String,
    pub repo: String,
    pub number: u64,
    pub url: String,
    /// The upstream's branch, which the merge deletes.
    pub branch: String,
    pub head_sha: String,
}

/// A squash-merged PR. `kept` says why its branch is still on the remote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedPr {
    pub number: u64,
    pub url: String,
    pub branch: String,
    pub kept: Option<String>,
}

/// A commit message for everything the worktree changed, untracked files
/// too, by `claude -p` on the machine. `tmux` is a Mac's [`login_server`],
/// or [`Tmux::command`] where one runs.
pub async fn draft<E: Exec>(exec: &E, place: &Place, tmux: Option<&str>) -> Result<String, Error> {
    let out = run(exec, &draft_command(place), tmux).await?;
    match out.status {
        NOTHING => Err(Error::NothingToCommit),
        NO_CLAUDE => Err(Error::Claude {
            said: said(&out.stderr),
        }),
        GIT_FAILED => Err(failed(&out)),
        TIMED_OUT => Err(timed_out()),
        _ => message(&out),
    }
}

/// Runs `script` within [`TIME_LIMIT_SECS`], inside the tmux server `tmux`
/// names when there is one.
async fn run<E: Exec>(exec: &E, script: &str, tmux: Option<&str>) -> Result<ssh::Output, Error> {
    let script = bounded(script, TIME_LIMIT_SECS);
    Ok(match tmux {
        None => exec.exec(&script).await?,
        Some(tmux) => landed(exec.exec(&run_shell(tmux, &carried(&script))).await?),
    })
}

/// Stops `script` and every process under it after `secs`: a dropped ssh
/// leaves it running (I-27). `STOP` first, so no child escapes the walk.
pub(crate) fn bounded(script: &str, secs: u64) -> String {
    format!(
        "k() {{ kill -STOP \"$1\" 2>/dev/null; for c in $(pgrep -P \"$1\"); do k \"$c\"; done; \
         kill -TERM \"$1\" 2>/dev/null; kill -CONT \"$1\" 2>/dev/null; }}\n\
         t=$(mktemp) || exit {GIT_FAILED}\n\
         sh -c {script} </dev/null & p=$!\n\
         {{ sleep {secs}; echo >\"$t\"; k \"$p\"; }} >/dev/null 2>&1 & w=$!\n\
         wait \"$p\"; s=$?\n\
         k \"$w\"\n\
         [ -s \"$t\" ] && s={TIMED_OUT}\n\
         rm -f \"$t\"\n\
         exit \"$s\"",
        script = sq(script),
    )
}

/// `run-shell` passes back stdout alone, so the status and the stderr follow
/// the stdout there, after [`STATUS_MARK`].
fn carried(script: &str) -> String {
    format!(
        "e=$(mktemp) || exit; sh -c {script} 2>\"$e\"; s=$?; \
         printf '\\n{STATUS_MARK}%s\\n' \"$s\"; cat \"$e\"; rm -f \"$e\"",
        script = sq(script),
    )
}

/// Splits what [`carried`] printed back into stdout, status and stderr. With
/// no mark, tmux itself failed, and what it printed is the reason.
fn landed(out: ssh::Output) -> ssh::Output {
    let mark = format!("\n{STATUS_MARK}").into_bytes();
    let Some(at) = out.stdout.windows(mark.len()).position(|w| w == mark) else {
        return ssh::Output {
            status: if out.success() { 1 } else { out.status },
            stderr: if out.stderr.is_empty() {
                out.stdout
            } else {
                out.stderr
            },
            stdout: Vec::new(),
        };
    };
    let rest = &out.stdout[at + mark.len()..];
    let end = rest.iter().position(|&b| b == b'\n').unwrap_or(rest.len());
    ssh::Output {
        status: std::str::from_utf8(&rest[..end])
            .ok()
            .and_then(|status| status.parse().ok())
            .unwrap_or(1),
        stderr: rest.get(end + 1..).unwrap_or_default().to_vec(),
        stdout: out.stdout[..at].to_vec(),
    }
}

fn timed_out() -> Error {
    Error::TimedOut {
        minutes: TIME_LIMIT_SECS / 60,
    }
}

/// Claude runs from a fresh directory: a transcript under the worktree would
/// become the thread's next `--resume` target (`logs::newest`).
fn draft_command(place: &Place) -> String {
    let diff = |flags: &str| {
        format!("git -c core.quotePath=false diff {flags}{DIFF_FLAGS} HEAD \"$tree\"")
    };
    format!(
        "cd {worktree} || exit {GIT_FAILED}\n\
         {SNAPSHOT} || exit {GIT_FAILED}\n\
         git diff --quiet HEAD \"$tree\" && exit {NOTHING}\n\
         c=$({probe}) || {{ echo 'claude was not found on PATH or in any of: {searched}' >&2; exit {NO_CLAUDE}; }}\n\
         in=$(mktemp) && patch=$(mktemp) && dir=$(mktemp -d) || exit {GIT_FAILED}\n\
         trap 'rm -rf \"$tmp\" \"$tmp.lock\" \"$in\" \"$patch\" \"$dir\"' EXIT\n\
         {{ printf '%s\\n\\nFiles:\\n' {prompt}; {stat}; }} > \"$in\" || exit {GIT_FAILED}\n\
         ( {patch}\n) > \"$patch\" || exit {GIT_FAILED}\n\
         {{ printf '\\nPatch:\\n'; head -c {limit} \"$patch\"; }} >> \"$in\" || exit {GIT_FAILED}\n\
         [ $(wc -c < \"$patch\") -gt {limit} ] && printf '\\n\\n%s\\n' {cut} >> \"$in\"\n\
         cd \"$dir\" || exit {GIT_FAILED}\n\
         \"$c\" -p --output-format json --json-schema {schema} --tools '' --disable-slash-commands \
         --strict-mcp-config --permission-mode dontAsk --no-session-persistence \
         --settings '{{\"disableAllHooks\":true}}' < \"$in\"",
        worktree = sq(&place.worktree),
        probe = agent::probe("claude"),
        searched = agent::CANDIDATES.join(", "),
        prompt = sq(PROMPT),
        stat = diff("--stat "),
        patch = capped(&diff(""), checkpoint::LIMIT + 1),
        limit = checkpoint::LIMIT,
        cut = sq(CUT_NOTE),
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

/// Commits every change in the worktree with the machine's own identity,
/// never the checkpoint one (decision 2). Hooks run.
pub async fn commit<E: Exec>(exec: &E, place: &Place, message: &str) -> Result<Committed, Error> {
    if message.trim().is_empty() {
        return Err(Error::EmptyMessage);
    }
    let out = run(exec, &commit_command(place, message), None).await?;
    match out.status {
        NO_IDENTITY => return Err(Error::NoIdentity),
        NOTHING => return Err(Error::NothingToCommit),
        TIMED_OUT => return Err(timed_out()),
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

/// Stages into [`SNAPSHOT`]'s private index, which replaces the real one only
/// once the commit is made, so a failed hook leaves the index as it was.
fn commit_command(place: &Place, message: &str) -> String {
    format!(
        "cd {worktree} || exit {GIT_FAILED}\n\
         for v in GIT_AUTHOR_IDENT GIT_COMMITTER_IDENT; do \
         git -c user.useConfigOnly=true var \"$v\" >/dev/null 2>&1 || exit {NO_IDENTITY}; done\n\
         {SNAPSHOT} || exit {GIT_FAILED}\n\
         git diff --quiet HEAD \"$tree\" && exit {NOTHING}\n\
         GIT_INDEX_FILE=$tmp git -c user.useConfigOnly=true commit -q -m {message} >&2 || exit\n\
         mv -f \"$tmp\" \"$(git rev-parse --git-path index)\" || exit {GIT_FAILED}\n\
         git rev-parse HEAD && git log -1 --no-show-signature --format=%s",
        worktree = sq(&place.worktree),
        message = sq(message),
    )
}

/// Pushes the thread's branch to its upstream, or to `origin` under a name
/// Yantra makes, and sets the upstream. Never forced. `tmux` as in [`draft`].
pub async fn push<E: Exec>(
    exec: &E,
    place: &Place,
    issue: Option<&IssueRef>,
    tmux: Option<&str>,
) -> Result<Pushed, Error> {
    let out = run(exec, &push_command(place, issue), tmux).await?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if let Some(reason) = refusal(&stdout) {
        return Err(Error::Refused { reason });
    }
    match out.status {
        NO_REMOTE => return Err(Error::NoRemote),
        TIMED_OUT => return Err(timed_out()),
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

/// An explicit refspec, as `push.default=simple` refuses a renamed branch. An
/// upstream counts only with a named remote, never a URL, and a `yantra/` branch.
fn push_command(place: &Place, issue: Option<&IssueRef>) -> String {
    let key = |name: &str| sq(&format!("branch.{}.{name}", place.branch));
    format!(
        "cd {worktree} || exit {GIT_FAILED}\n\
         r=$(git config --get {remote}) && m=$(git config --get {merge}) \
         && [ \"$r\" != . ] && git remote | grep -qxF -e \"$r\" \
         && [ \"${{m#refs/heads/yantra/}}\" != \"$m\" ] \
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

/// The tip's subject and body, which a PR's title and body default to.
#[derive(Debug, PartialEq, Eq)]
struct Tip {
    subject: String,
    body: String,
}

/// The pushed tip, or a refusal when the local branch is not at it. Reads
/// only local refs, so it needs no credential and no Mac tmux server.
async fn tip<E: Exec>(exec: &E, place: &Place, branch: &str) -> Result<Tip, Failed> {
    let out = exec
        .exec(&tip_command(place, branch))
        .await
        .map_err(Error::Ssh)?;
    match out.status {
        NOT_PUSHED => return Err(Failed::NotPushed),
        AHEAD => return Err(Failed::Ahead),
        BEHIND => return Err(Failed::Behind),
        DIVERGED => return Err(Failed::Diverged),
        0 => {}
        _ => return Err(failed(&out).into()),
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let (subject, body) = stdout.split_once('\0').unwrap_or((&stdout, ""));
    Ok(Tip {
        subject: subject.trim().to_owned(),
        body: body.trim().to_owned(),
    })
}

/// `branch` is the upstream's branch, as [`thread::Listed`] read it.
pub(crate) fn tip_command(place: &Place, branch: &str) -> String {
    format!(
        "cd {worktree} || exit {GIT_FAILED}\n\
         r=$(git config --get {remote}) || exit {NOT_PUSHED}\n\
         l=$(git rev-parse -q --verify {local}) || exit {GIT_FAILED}\n\
         t=$(git rev-parse -q --verify \"refs/remotes/$r/\"{branch}) || exit {NOT_PUSHED}\n\
         if [ \"$l\" != \"$t\" ]; then\n\
         git merge-base --is-ancestor \"$t\" \"$l\" && exit {AHEAD}\n\
         git merge-base --is-ancestor \"$l\" \"$t\" && exit {BEHIND}\n\
         exit {DIVERGED}\n\
         fi\n\
         git log -1 --no-show-signature --format=%s%x00%b \"$t\"",
        worktree = sq(&place.worktree),
        remote = sq(&format!("branch.{}.remote", place.branch)),
        local = sq(&format!("refs/heads/{}", place.branch)),
        branch = sq(branch),
    )
}

/// `Closes #n` in the PR's own repository, `Closes owner/repo#n` elsewhere.
fn closes(issue: &IssueRef, owner: &str, repo: &str) -> String {
    if issue.owner.eq_ignore_ascii_case(owner) && issue.repo.eq_ignore_ascii_case(repo) {
        format!("Closes #{}", issue.number)
    } else {
        format!("Closes {issue}")
    }
}

/// Whether `body` already closes `issue` with one of GitHub's keywords.
fn already_closes(body: &str, issue: &IssueRef, owner: &str, repo: &str) -> bool {
    const KEYWORDS: [&str; 9] = [
        "close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved",
    ];
    let whole = issue.to_string().to_lowercase();
    let short = format!("#{}", issue.number);
    let here = issue.owner.eq_ignore_ascii_case(owner) && issue.repo.eq_ignore_ascii_case(repo);
    let words: Vec<String> = body.split_whitespace().map(str::to_lowercase).collect();
    words.windows(2).any(|pair| {
        let keyword = pair[0].trim_end_matches(':');
        let named = pair[1]
            .trim_start_matches('(')
            .trim_end_matches(|c: char| ".,;:!?)".contains(c));
        KEYWORDS.contains(&keyword) && (named == whole || (here && named == short))
    })
}

fn is_race(error: &github::Error) -> bool {
    matches!(error, github::Error::Unprocessable { said } if said.contains("A pull request already exists"))
}

/// Opens a PR from the thread's pushed branch to the repository's default
/// branch, or answers the one already open (§B4). Yantra keeps no link: the
/// threads list reads the PR from the upstream (ADR-0034 decision 3).
pub async fn open_pr<E: Exec>(
    exec: &E,
    found: &thread::Listed,
    github: &Github,
    token: &Token,
    title: Option<&str>,
    body: Option<&str>,
) -> Result<Opened, Failed> {
    let (url, branch) = found.upstream.as_ref().ok_or(Failed::NotPushed)?;
    let (owner, repo) = github::repo_of(url).ok_or(Failed::NotGithub)?;
    let unseen = |error| unseen(&owner, &repo, error);
    let open = async || -> Result<Option<Opened>, Failed> {
        let pull = github
            .pull_for_head(token, &owner, &repo, branch)
            .await
            .map_err(unseen)?;
        Ok(pull
            .filter(|pull| pull.state == PullState::Open)
            .map(|pull| Opened {
                owner: owner.clone(),
                repo: repo.clone(),
                number: pull.number,
                url: pull.url,
                created: false,
            }))
    };
    // Before the tip: a commit made after the PR opened must not hide it.
    if let Some(opened) = open().await? {
        return Ok(opened);
    }
    let tip = tip(exec, &found.place, branch).await?;
    let title = title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or(&tip.subject);
    if title.is_empty() {
        return Err(Failed::NoTitle);
    }
    let base = github
        .default_branch(token, &owner, &repo)
        .await
        .map_err(unseen)?;
    let mut body = body.unwrap_or(&tip.body).trim().to_owned();
    if let Some(issue) = found
        .issue
        .as_deref()
        .and_then(|issue| issue.parse::<IssueRef>().ok())
        .filter(|issue| !already_closes(&body, issue, &owner, &repo))
    {
        if !body.is_empty() {
            body.push_str("\n\n");
        }
        body.push_str(&closes(&issue, &owner, &repo));
    }
    let head = format!("{owner}:{branch}");
    match github
        .create_pull(token, &owner, &repo, &head, &base, title, &body)
        .await
    {
        Ok(pull) => Ok(Opened {
            owner,
            repo,
            number: pull.number,
            url: pull.url,
            created: true,
        }),
        // Another open won GitHub's race: answer its PR (§B4).
        Err(error) if is_race(&error) => open().await?.ok_or_else(|| error.into()),
        Err(error) => Err(unseen(error)),
    }
}

/// A 404 from GitHub is a repository the grant cannot see, not a missing thread.
fn unseen(owner: &str, repo: &str, error: github::Error) -> Failed {
    match error {
        github::Error::Status { status: 404, .. } => Failed::Unseen {
            repo: format!("{owner}/{repo}"),
        },
        other => other.into(),
    }
}

/// The open PR of the thread's upstream, with its head (Y-496).
pub async fn pending_pr(
    found: &thread::Listed,
    github: &Github,
    token: &Token,
) -> Result<Pending, Failed> {
    let (url, branch) = found.upstream.as_ref().ok_or(Failed::NotPushed)?;
    let (owner, repo) = github::repo_of(url).ok_or(Failed::NotGithub)?;
    let unseen = |error| unseen(&owner, &repo, error);
    let pull = github
        .pull_for_head(token, &owner, &repo, branch)
        .await
        .map_err(unseen)?
        .ok_or(Failed::NoPr)?;
    let head = match github
        .pull(token, &owner, &repo, pull.number, None)
        .await
        .map_err(unseen)?
    {
        Conditional::Fresh { value, .. } => value,
        // No etag was sent, so GitHub has nothing to answer 304 to.
        Conditional::NotModified => return Err(Failed::NoPr),
    };
    match head.state {
        PullState::Open => Ok(Pending {
            owner: owner.clone(),
            repo: repo.clone(),
            number: pull.number,
            url: pull.url,
            branch: branch.clone(),
            head_sha: head.head_sha,
        }),
        PullState::Merged => Err(Failed::AlreadyMerged {
            number: pull.number,
        }),
        PullState::Closed => Err(Failed::NoPr),
    }
}

/// Squash-merges PR `number`, the one the owner confirmed, then deletes its branch. With `seen`,
/// the head the owner was shown, a head that moved since is refused; without it the merge takes
/// the head read now. A delete that fails keeps the merge and says why in [`MergedPr::kept`].
pub async fn merge_pr(
    found: &thread::Listed,
    github: &Github,
    token: &Token,
    number: u64,
    seen: Option<&str>,
) -> Result<MergedPr, Failed> {
    let pending = pending_pr(found, github, token).await?;
    if pending.number != number {
        return Err(Failed::NotThatPr {
            confirmed: number,
            open: pending.number,
        });
    }
    if seen.is_some_and(|seen| seen != pending.head_sha) {
        return Err(github::Error::HeadMoved.into());
    }
    let Pending {
        owner,
        repo,
        url,
        branch,
        head_sha,
        ..
    } = pending;
    github
        .merge_pull(token, &owner, &repo, number, &head_sha)
        .await
        .map_err(|error| unseen(&owner, &repo, error))?;
    let kept = github
        .delete_branch(token, &owner, &repo, &branch)
        .await
        .err()
        .map(|error| error.to_string());
    Ok(MergedPr {
        number,
        url,
        branch,
        kept,
    })
}

#[derive(Debug, thiserror::Error)]
pub enum Failed {
    #[error(transparent)]
    Workspace(#[from] workspace::Error),

    #[error("the workspace has no thread {id}")]
    NoThread { id: String },

    #[error("the thread's branch has no upstream; push it first with `yantra push`")]
    NotPushed,

    // The URL is not repeated: a remote can carry a credential in it.
    #[error("the thread's upstream is not a github.com repository")]
    NotGithub,

    #[error("the thread's branch has commits its upstream lacks; push it first with `yantra push`")]
    Ahead,

    #[error(
        "the thread's branch is behind its upstream; bring the upstream's commits into the worktree first"
    )]
    Behind,

    #[error(
        "the thread's branch and its upstream have diverged; reconcile them in the worktree first"
    )]
    Diverged,

    #[error("the PR has no title, and the tip commit has no subject")]
    NoTitle,

    #[error("the thread's branch has no open PR; open one first with `yantra pr open`")]
    NoPr,

    #[error("PR #{number} is already merged")]
    AlreadyMerged { number: u64 },

    #[error("the thread's open PR is #{open}, not #{confirmed}; confirm that one")]
    NotThatPr { confirmed: u64, open: u64 },

    #[error("the GitHub grant cannot see {repo}, or the repository is gone")]
    Unseen { repo: String },

    #[error(transparent)]
    Github(#[from] github::Error),

    #[error(transparent)]
    Thread(#[from] thread::Error),

    #[error(transparent)]
    Commit(#[from] Error),

    #[error(transparent)]
    Tmux(#[from] tmux::Error),

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

async fn reach(name: &str) -> Result<(Workspace, Ssh), Failed> {
    let workspace = workspace::load(name)?;
    let machine = ssh::machine_at(&workspace.machine).ok_or(Failed::NoStateDir)?;
    let ssh = Ssh::new(machine).map_err(Error::Ssh)?;
    Ok((workspace, ssh))
}

/// The [`Tmux::command`] of the server a Mac drafts and pushes in, or `None`
/// elsewhere: over ssh a Mac cannot read the login keychain (I-44, ADR-0018 §5).
async fn login_server<E: Exec>(exec: &E) -> Result<Option<String>, Failed> {
    if ssh::os(exec).await.map_err(Error::Ssh)? != Os::MacOs {
        return Ok(None);
    }
    let tmux = Tmux::resolve(exec).await?;
    if !tmux.login_server(exec).await? {
        return Err(Error::NoLoginServer.into());
    }
    Ok(Some(tmux.command()))
}

async fn find_listed(name: &str, id: &str) -> Result<(Ssh, thread::Listed), Failed> {
    let (workspace, ssh) = reach(name).await?;
    let found = thread::listed(&ssh, &workspace)
        .await?
        .into_iter()
        .find(|found| thread::name(&found.place) == id)
        .ok_or_else(|| Failed::NoThread { id: id.to_owned() })?;
    Ok((ssh, found))
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
    let tmux = login_server(&ssh).await?;
    Ok(draft(&ssh, &place, tmux.as_deref()).await?)
}

/// [`commit`] for thread `id` of workspace `name`, with a [`draft`] when no
/// message is given.
pub async fn commit_for(name: &str, id: &str, message: Option<&str>) -> Result<Committed, Failed> {
    if message.is_some_and(|message| message.trim().is_empty()) {
        return Err(Error::EmptyMessage.into());
    }
    let (ssh, place) = find(name, id).await?;
    let message = match message {
        Some(message) => message.to_owned(),
        None => {
            let tmux = login_server(&ssh).await?;
            draft(&ssh, &place, tmux.as_deref()).await?
        }
    };
    Ok(commit(&ssh, &place, &message).await?)
}

/// [`push`] for thread `id` of workspace `name`. An issue thread's remote
/// branch carries the issue's number.
pub async fn push_for(name: &str, id: &str) -> Result<Pushed, Failed> {
    let (ssh, found) = find_listed(name, id).await?;
    let issue = found.issue.and_then(|issue| issue.parse::<IssueRef>().ok());
    let tmux = login_server(&ssh).await?;
    Ok(push(&ssh, &found.place, issue.as_ref(), tmux.as_deref()).await?)
}

/// [`open_pr`] for thread `id` of workspace `name`.
pub async fn open_pr_for(
    name: &str,
    id: &str,
    github: &Github,
    token: &Token,
    title: Option<&str>,
    body: Option<&str>,
) -> Result<Opened, Failed> {
    let (ssh, found) = find_listed(name, id).await?;
    open_pr(&ssh, &found, github, token, title, body).await
}

/// [`pending_pr`] for thread `id` of workspace `name`.
pub async fn pending_pr_for(
    name: &str,
    id: &str,
    github: &Github,
    token: &Token,
) -> Result<Pending, Failed> {
    let (_, found) = find_listed(name, id).await?;
    pending_pr(&found, github, token).await
}

/// [`merge_pr`] for thread `id` of workspace `name`.
pub async fn merge_pr_for(
    name: &str,
    id: &str,
    github: &Github,
    token: &Token,
    number: u64,
    seen: Option<&str>,
) -> Result<MergedPr, Failed> {
    let (_, found) = find_listed(name, id).await?;
    merge_pr(&found, github, token, number, seen).await
}

/// [`thread::remove`] for thread `id` of workspace `name`: its keeper, worktree, branch,
/// checkpoints, journals and images.
pub async fn remove_for(name: &str, id: &str) -> Result<(), Failed> {
    let (ssh, place) = find(name, id).await?;
    Ok(thread::remove(&ssh, &place).await?)
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::github::tests::{at, listen, reply, serve, token};
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

    /// A Mac with no tmux server, whose login-server script exits `script`.
    fn serverless_mac(script: i32) -> Machine {
        Machine::answering(vec![
            out(0, "Darwin\n", ""),
            out(0, "Darwin\n/opt/homebrew/bin/tmux\n", ""),
            out(1, "", "no server running on /private/tmp/tmux-501/default"),
            out(script, "", "launchctl said no"),
        ])
    }

    #[tokio::test]
    async fn a_mac_with_no_server_drafts_in_the_one_the_launch_agent_starts() {
        let mac = serverless_mac(0);
        let tmux = login_server(&mac).await.expect("a server");
        assert_eq!(
            tmux.as_deref(),
            Some("'/opt/homebrew/bin/tmux' -L yantra -N")
        );
        assert!(mac.asked()[3].ends_with("\nlogin_server '/opt/homebrew/bin/tmux'\n"));
    }

    #[tokio::test]
    async fn a_mac_with_no_one_at_the_screen_is_no_login_server() {
        assert!(matches!(
            login_server(&serverless_mac(3)).await,
            Err(Failed::Commit(Error::NoLoginServer))
        ));
        assert!(matches!(
            login_server(&serverless_mac(1)).await,
            Err(Failed::Tmux(tmux::Error::Command { ref command, ref stderr, .. }))
                if command == "launchctl" && stderr == "launchctl said no"
        ));
    }

    #[tokio::test]
    async fn a_mac_holding_a_session_sends_no_launchctl() {
        let mac = Machine::answering(vec![
            out(0, "Darwin\n", ""),
            out(0, "Darwin\n/opt/homebrew/bin/tmux\n", ""),
            out(0, "main: 1 windows\n", ""),
        ]);
        assert!(login_server(&mac).await.expect("a server").is_some());
        assert_eq!(mac.asked().len(), 3);
    }

    /// Y-640: an empty server gets the script, and serves if it fails while
    /// it still answers. The script's bootout may have ended it.
    #[tokio::test]
    async fn a_mac_with_an_empty_server_is_sent_the_script() {
        let mac = Machine::answering(vec![
            out(0, "Darwin\n", ""),
            out(0, "Darwin\n/opt/homebrew/bin/tmux\n", ""),
            out(0, "", ""),
            out(1, "", "launchctl said no"),
            out(0, "", ""),
        ]);
        assert!(login_server(&mac).await.expect("a server").is_some());
        assert!(mac.asked()[3].ends_with("\nlogin_server '/opt/homebrew/bin/tmux'\n"));

        let mac = Machine::answering(vec![
            out(0, "Darwin\n", ""),
            out(0, "Darwin\n/opt/homebrew/bin/tmux\n", ""),
            out(0, "", ""),
            out(1, "", "launchctl said no"),
            out(1, "", "no server running on /private/tmp/tmux-501/default"),
        ]);
        assert!(login_server(&mac).await.is_err());
    }

    #[tokio::test]
    async fn linux_has_no_login_server() {
        let linux = Machine::answering(vec![out(0, "Linux\n", "")]);
        assert_eq!(login_server(&linux).await.expect("answered"), None);
        assert_eq!(linux.asked().len(), 1);
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
        let script = format!(
            "cd '{WORKTREE}' || exit 6\n\
             for v in GIT_AUTHOR_IDENT GIT_COMMITTER_IDENT; do \
             git -c user.useConfigOnly=true var \"$v\" >/dev/null 2>&1 || exit 3; done\n\
             {SNAPSHOT} || exit 6\n\
             git diff --quiet HEAD \"$tree\" && exit 4\n\
             GIT_INDEX_FILE=$tmp git -c user.useConfigOnly=true commit -q -m 'Add x' >&2 || exit\n\
             mv -f \"$tmp\" \"$(git rev-parse --git-path index)\" || exit 6\n\
             git rev-parse HEAD && git log -1 --no-show-signature --format=%s"
        );
        assert_eq!(machine.asked(), [bounded(&script, TIME_LIMIT_SECS)]);
    }

    /// `log.showSignature` would put gpg's output above the hash.
    #[test]
    fn the_commit_is_read_back_without_a_signature() {
        let command = commit_command(&place(), "m");
        assert!(
            command.ends_with("git rev-parse HEAD && git log -1 --no-show-signature --format=%s")
        );
        assert!(
            !command.contains("git add -A ||"),
            "the real index is never staged"
        );
    }

    #[tokio::test]
    async fn an_empty_message_is_refused_before_the_machine_is_asked() {
        let machine = Machine::answering(Vec::new());
        for empty in ["", "  \n\t"] {
            assert!(matches!(
                commit(&machine, &place(), empty).await,
                Err(Error::EmptyMessage)
            ));
        }
        assert!(machine.asked().is_empty());
    }

    #[tokio::test]
    async fn a_commit_without_identity_or_changes_or_past_a_hook_is_named() {
        let machine = Machine::answering(vec![
            out(NO_IDENTITY, "", ""),
            out(NOTHING, "", ""),
            out(1, "", "pre-commit: lint failed\n"),
            out(0, "", ""),
            out(TIMED_OUT, "", ""),
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
        assert!(matches!(
            commit(&machine, &place(), "m").await,
            Err(Error::TimedOut { minutes: 5 })
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
            push(&machine, &place(), Some(&issue()), None)
                .await
                .expect("pushed"),
            Pushed {
                remote: "origin".to_owned(),
                branch: "yantra/42-11111111".to_owned(),
            }
        );
        let asked = machine.asked();
        let script = format!(
            "cd '{WORKTREE}' || exit 6\n\
             r=$(git config --get 'branch.yantra/chat/web/11111111.remote') \
             && m=$(git config --get 'branch.yantra/chat/web/11111111.merge') \
             && [ \"$r\" != . ] && git remote | grep -qxF -e \"$r\" \
             && [ \"${{m#refs/heads/yantra/}}\" != \"$m\" ] \
             || {{ r=origin; m='refs/heads/yantra/42-11111111'; \
             git remote get-url origin >/dev/null 2>&1 || exit 5; }}\n\
             printf '%s\\n%s\\n' \"$r\" \"${{m#refs/heads/}}\"\n\
             GIT_TERMINAL_PROMPT=0 git push --porcelain -u \"$r\" \
             'refs/heads/yantra/chat/web/11111111':\"$m\""
        );
        assert_eq!(asked, [bounded(&script, TIME_LIMIT_SECS)]);
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
            push(&machine, &place(), None, None).await,
            Err(Error::Refused { reason }) if reason == "rejected (non-fast-forward)"
        ));
        assert!(matches!(
            push(&machine, &place(), None, None).await,
            Err(Error::NoRemote)
        ));
        assert!(matches!(
            push(&machine, &place(), None, None).await,
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
        assert_eq!(
            draft(&machine, &place(), None).await.expect("drafted"),
            "Add x"
        );
        let command = draft_command(&place());
        assert_eq!(machine.asked(), [bounded(&command, TIME_LIMIT_SECS)]);
        assert!(command.starts_with(&format!(
            "cd '{WORKTREE}' || exit 6\n{SNAPSHOT} || exit 6\n"
        )));
        assert!(command.contains("git diff --quiet HEAD \"$tree\" && exit 4\n"));
        assert!(command.contains("cd \"$dir\" || exit 6\n\"$c\" -p --output-format json"));
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
        assert!(
            command.contains(&format!(
                "-gt 262144 ] && printf '\\n\\n%s\\n' {} >> \"$in\"",
                sq(CUT_NOTE)
            )),
            "claude is told when the patch is cut"
        );
    }

    #[tokio::test]
    async fn a_draft_with_nothing_changed_or_no_claude_is_named() {
        let machine = Machine::answering(vec![
            out(NOTHING, "", ""),
            out(NO_CLAUDE, "", "claude was not found on PATH\n"),
            out(GIT_FAILED, "", "fatal: not a git repository\n"),
            out(TIMED_OUT, "", ""),
        ]);
        assert!(matches!(
            draft(&machine, &place(), None).await,
            Err(Error::NothingToCommit)
        ));
        assert!(matches!(
            draft(&machine, &place(), None).await,
            Err(Error::Claude { said }) if said == "claude was not found on PATH"
        ));
        assert!(matches!(
            draft(&machine, &place(), None).await,
            Err(Error::Git { stderr }) if stderr == "fatal: not a git repository"
        ));
        assert!(matches!(
            draft(&machine, &place(), None).await,
            Err(Error::TimedOut { .. })
        ));
    }

    /// I-44: on a Mac the draft and the push run inside the tmux server, and
    /// their status and stderr come back on stdout; Linux asks over ssh.
    #[tokio::test]
    async fn a_mac_drafts_and_pushes_inside_the_tmux_server() {
        const TMUX: &str = "'/opt/homebrew/bin/tmux' -L yantra -N";
        let json = r#"{"is_error":false,"structured_output":{"subject":"Add x","body":""}}"#;
        let machine = Machine::answering(vec![
            out(0, &format!("{json}\n{STATUS_MARK}0\n"), ""),
            out(0, &format!("\n{STATUS_MARK}{NO_REMOTE}\n"), ""),
            out(0, &format!("\n{STATUS_MARK}{GIT_FAILED}\nfatal: bad\n"), ""),
        ]);
        assert_eq!(
            draft(&machine, &place(), Some(TMUX))
                .await
                .expect("drafted"),
            "Add x"
        );
        assert!(matches!(
            push(&machine, &place(), None, Some(TMUX)).await,
            Err(Error::NoRemote)
        ));
        assert!(matches!(
            draft(&machine, &place(), Some(TMUX)).await,
            Err(Error::Git { stderr }) if stderr == "fatal: bad"
        ));
        let asked = machine.asked();
        let inside = |script: &str| run_shell(TMUX, &carried(&bounded(script, TIME_LIMIT_SECS)));
        assert_eq!(asked[0], inside(&draft_command(&place())));
        assert_eq!(asked[1], inside(&push_command(&place(), None)));
        assert!(asked[0].starts_with("'/opt/homebrew/bin/tmux' -L yantra -N run-shell '"));
    }

    /// What tmux says when it could not run the command at all.
    #[test]
    fn a_reply_with_no_status_is_tmuxs_own_failure() {
        let gone = landed(out(1, "", "no server running on /tmp/tmux-501/default\n"));
        assert_eq!(gone.status, 1);
        assert_eq!(
            said(&gone.stderr),
            "no server running on /tmp/tmux-501/default"
        );
        let odd = landed(out(0, "'sh' returned 2\n", ""));
        assert_eq!(
            (odd.status, said(&odd.stderr)),
            (1, "'sh' returned 2".to_owned())
        );
    }

    fn sh(command: &str) -> ssh::Output {
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(command)
            .output()
            .expect("sh runs");
        out(
            output.status.code().unwrap_or(-1),
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        )
    }

    /// The wrapping on a real `/bin/sh`: the stdout, the status and the stderr
    /// each come back whole.
    #[test]
    fn what_tmux_carries_back_splits_into_stdout_status_and_stderr() {
        let back = landed(sh(&carried("printf 'one\\ntwo'; echo err >&2; exit 7")));
        assert_eq!(back.status, 7);
        assert_eq!(back.stdout, b"one\ntwo");
        assert_eq!(back.stderr, b"err\n");
    }

    /// I-27: the bound kills the command and what it started, and a command
    /// inside the bound returns at once with its own status.
    #[test]
    fn the_bound_kills_the_command_and_its_children() {
        let dir = std::env::temp_dir().join(format!("yt-bound-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a directory");
        let late = dir.join("late");
        let started = std::time::Instant::now();
        let stopped = sh(&bounded(
            &format!("sh -c 'sleep 5; touch {}'", late.display()),
            1,
        ));
        assert_eq!(stopped.status, TIMED_OUT);
        assert!(started.elapsed() < std::time::Duration::from_secs(4));
        std::thread::sleep(std::time::Duration::from_secs(5));
        assert!(!late.exists(), "the grandchild was killed");

        let started = std::time::Instant::now();
        let quick = sh(&bounded("echo out; echo err >&2; exit 7", 30));
        assert_eq!(
            (
                quick.status,
                quick.stdout.as_slice(),
                quick.stderr.as_slice()
            ),
            (7, &b"out\n"[..], &b"err\n"[..])
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        let _ = std::fs::remove_dir_all(&dir);
    }

    const UPSTREAM: &str = "yantra/42-11111111";
    const NONE_OPEN: &str = "[]";
    const REPO: &str = r#"{"full_name":"o/r","default_branch":"main"}"#;
    const MADE: &str = r#"{"number":21,"html_url":"https://github.com/o/r/pull/21","state":"open","merged_at":null}"#;
    const OPEN: &str = r#"[{"number":21,"html_url":"https://github.com/o/r/pull/21","state":"open","merged_at":null}]"#;

    fn listed(issue: Option<&str>, remote: Option<&str>) -> thread::Listed {
        thread::Listed {
            place: place(),
            title: None,
            from: None,
            issue: issue.map(str::to_owned),
            upstream: remote.map(|url| (url.to_owned(), UPSTREAM.to_owned())),
            kept: thread::Kept::default(),
        }
    }

    fn pushed_tip() -> ssh::Output {
        out(0, "Fix the thing\0- one\n- two\n\n", "")
    }

    /// The JSON body of the POST among `seen`.
    fn posted(seen: &[String]) -> serde_json::Value {
        let post = seen
            .iter()
            .find(|request| request.starts_with("POST "))
            .expect("a POST");
        serde_json::from_str(post.rsplit("\r\n\r\n").next().unwrap_or_default())
            .expect("a JSON body")
    }

    #[tokio::test]
    async fn pr_open_for_an_issue_thread_says_closes_n_and_defaults_to_the_tip() {
        let (listener, address) = listen();
        let served = serve(
            listener,
            vec![
                reply("200 OK", NONE_OPEN),
                reply("200 OK", REPO),
                reply("201 Created", MADE),
            ],
        );
        let machine = Machine::answering(vec![pushed_tip()]);

        let opened = open_pr(
            &machine,
            &listed(Some("o/r#42"), Some("git@github.com:o/r.git")),
            &at(address),
            &token(),
            None,
            None,
        )
        .await
        .expect("opened");

        assert_eq!(
            opened,
            Opened {
                owner: "o".to_owned(),
                repo: "r".to_owned(),
                number: 21,
                url: "https://github.com/o/r/pull/21".to_owned(),
                created: true,
            }
        );
        let seen = served.join().expect("the listener thread");
        assert_eq!(
            posted(&seen),
            serde_json::json!({
                "head": "o:yantra/42-11111111",
                "base": "main",
                "title": "Fix the thing",
                "body": "- one\n- two\n\nCloses #42",
            })
        );
        let script = format!(
            "cd '{WORKTREE}' || exit 6\n\
             r=$(git config --get 'branch.yantra/chat/web/11111111.remote') || exit 7\n\
             l=$(git rev-parse -q --verify 'refs/heads/yantra/chat/web/11111111') || exit 6\n\
             t=$(git rev-parse -q --verify \"refs/remotes/$r/\"'yantra/42-11111111') || exit 7\n\
             if [ \"$l\" != \"$t\" ]; then\n\
             git merge-base --is-ancestor \"$t\" \"$l\" && exit 8\n\
             git merge-base --is-ancestor \"$l\" \"$t\" && exit 9\n\
             exit 10\n\
             fi\n\
             git log -1 --no-show-signature --format=%s%x00%b \"$t\""
        );
        assert_eq!(machine.asked(), [script]);
    }

    #[tokio::test]
    async fn pr_open_for_another_repositorys_issue_names_it_whole_and_takes_the_given_text() {
        let (listener, address) = listen();
        let served = serve(
            listener,
            vec![
                reply("200 OK", NONE_OPEN),
                reply("200 OK", REPO),
                reply("201 Created", MADE),
            ],
        );
        let machine = Machine::answering(vec![pushed_tip()]);

        open_pr(
            &machine,
            &listed(Some("other/tracker#9"), Some("https://github.com/o/r.git")),
            &at(address),
            &token(),
            Some("My title"),
            Some(""),
        )
        .await
        .expect("opened");

        let body = posted(&served.join().expect("the listener thread"));
        assert_eq!(body["title"], "My title");
        assert_eq!(body["body"], "Closes other/tracker#9");
    }

    #[test]
    fn pr_open_closes_the_same_repository_in_any_case() {
        let issue: IssueRef = "O/R#3".parse().expect("an issue");
        assert_eq!(closes(&issue, "o", "r"), "Closes #3");
        assert_eq!(closes(&issue, "o", "fork"), "Closes O/R#3");
    }

    /// §B4: twice is one PR. The stub answers one request, so a POST would
    /// find nothing listening.
    #[tokio::test]
    async fn pr_open_answers_the_open_pr_and_posts_nothing() {
        let (listener, address) = listen();
        let served = serve(listener, vec![reply("200 OK", OPEN)]);
        let machine = Machine::answering(vec![pushed_tip()]);

        let opened = open_pr(
            &machine,
            &listed(None, Some("git@github.com:o/r.git")),
            &at(address),
            &token(),
            None,
            None,
        )
        .await
        .expect("the open one");

        assert!(!opened.created);
        assert_eq!(opened.number, 21);
        let seen = served.join().expect("the listener thread");
        assert_eq!(seen.len(), 1);
        assert!(
            seen[0].starts_with("GET /repos/o/r/pulls?head=o%3Ayantra%2F42-11111111"),
            "{}",
            seen[0]
        );
    }

    #[tokio::test]
    async fn pr_open_refuses_no_upstream_a_foreign_remote_and_an_unpushed_tip() {
        let (listener, address) = listen();
        let _served = serve(
            listener,
            vec![reply("200 OK", NONE_OPEN), reply("200 OK", NONE_OPEN)],
        );
        let github = at(address);
        let machine = Machine::answering(vec![out(AHEAD, "", ""), out(NOT_PUSHED, "", "")]);
        let open = |found: thread::Listed| {
            let (machine, github) = (&machine, &github);
            async move { open_pr(machine, &found, github, &token(), None, None).await }
        };

        assert!(matches!(
            open(listed(None, None)).await,
            Err(Failed::NotPushed)
        ));
        let foreign = open(listed(None, Some("https://me:secret@gitlab.com/o/r.git")))
            .await
            .expect_err("not github");
        assert!(matches!(foreign, Failed::NotGithub));
        assert!(!foreign.to_string().contains("secret"), "{foreign}");
        assert_eq!(machine.asked().len(), 0, "both refused before the machine");

        let github_remote = Some("git@github.com:o/r.git");
        assert!(matches!(
            open(listed(None, github_remote)).await,
            Err(Failed::Ahead)
        ));
        assert!(matches!(
            open(listed(None, github_remote)).await,
            Err(Failed::NotPushed)
        ));
    }

    #[tokio::test]
    async fn pr_open_refused_by_github_is_its_own_failure() {
        let (listener, address) = listen();
        let _served = serve(
            listener,
            vec![
                reply("200 OK", NONE_OPEN),
                reply("200 OK", REPO),
                reply(
                    "422 Unprocessable Entity",
                    r#"{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"No commits between main and yantra/42-11111111"}]}"#,
                ),
            ],
        );
        let machine = Machine::answering(vec![pushed_tip()]);

        let refused = open_pr(
            &machine,
            &listed(None, Some("git@github.com:o/r.git")),
            &at(address),
            &token(),
            None,
            None,
        )
        .await
        .expect_err("422");

        match refused {
            Failed::Github(github::Error::Unprocessable { said }) => {
                assert_eq!(
                    said,
                    "Validation Failed: No commits between main and yantra/42-11111111"
                );
            }
            other => panic!("{other:?}"),
        }
    }

    /// §B4: two opens at once. The one that loses GitHub's race gets the
    /// winner back, not a refusal.
    #[tokio::test]
    async fn pr_open_that_loses_the_race_answers_the_winner() {
        let (listener, address) = listen();
        let served = serve(
            listener,
            vec![
                reply("200 OK", NONE_OPEN),
                reply("200 OK", REPO),
                reply(
                    "422 Unprocessable Entity",
                    r#"{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for o:yantra/42-11111111."}]}"#,
                ),
                reply("200 OK", OPEN),
            ],
        );
        let machine = Machine::answering(vec![pushed_tip()]);

        let opened = open_pr(
            &machine,
            &listed(None, Some("git@github.com:o/r.git")),
            &at(address),
            &token(),
            None,
            None,
        )
        .await
        .expect("the winner");

        assert_eq!(
            opened,
            Opened {
                owner: "o".to_owned(),
                repo: "r".to_owned(),
                number: 21,
                url: "https://github.com/o/r/pull/21".to_owned(),
                created: false,
            }
        );
        assert_eq!(served.join().expect("the listener thread").len(), 4);
    }

    /// §B4: an open PR is answered before the tip is read, so a commit made
    /// after it does not turn the answer into "push it first".
    #[tokio::test]
    async fn pr_open_answers_the_open_pr_even_with_an_unpushed_commit() {
        let (listener, address) = listen();
        let _served = serve(listener, vec![reply("200 OK", OPEN)]);
        let machine = Machine::answering(vec![out(AHEAD, "", "")]);

        let opened = open_pr(
            &machine,
            &listed(None, Some("git@github.com:o/r.git")),
            &at(address),
            &token(),
            None,
            None,
        )
        .await
        .expect("the open one");

        assert!(!opened.created);
        assert!(machine.asked().is_empty(), "{:?}", machine.asked());
    }

    #[tokio::test]
    async fn pr_open_does_not_close_the_issue_twice() {
        let (listener, address) = listen();
        let served = serve(
            listener,
            vec![
                reply("200 OK", NONE_OPEN),
                reply("200 OK", REPO),
                reply("201 Created", MADE),
            ],
        );
        let machine = Machine::answering(vec![pushed_tip()]);

        open_pr(
            &machine,
            &listed(Some("o/r#42"), Some("git@github.com:o/r.git")),
            &at(address),
            &token(),
            None,
            Some("Done.\n\nFixes: #42."),
        )
        .await
        .expect("opened");

        let body = posted(&served.join().expect("the listener thread"));
        assert_eq!(body["body"], "Done.\n\nFixes: #42.");
    }

    /// A 404 says the grant cannot see the repository, never "no thread".
    #[tokio::test]
    async fn pr_open_on_a_repository_the_grant_cannot_see_says_so() {
        let (listener, address) = listen();
        let _served = serve(
            listener,
            vec![reply("404 Not Found", r#"{"message":"Not Found"}"#)],
        );
        let machine = Machine::answering(vec![]);

        let refused = open_pr(
            &machine,
            &listed(None, Some("git@github.com:o/r.git")),
            &at(address),
            &token(),
            None,
            None,
        )
        .await
        .expect_err("404");

        assert!(
            matches!(&refused, Failed::Unseen { repo } if repo == "o/r"),
            "{refused:?}"
        );
    }

    #[tokio::test]
    async fn pr_open_with_no_title_anywhere_is_refused_before_github_is_written() {
        let (listener, address) = listen();
        let served = serve(listener, vec![reply("200 OK", NONE_OPEN)]);
        let machine = Machine::answering(vec![out(0, "\0body\n", "")]);

        let refused = open_pr(
            &machine,
            &listed(None, Some("git@github.com:o/r.git")),
            &at(address),
            &token(),
            Some("  "),
            None,
        )
        .await
        .expect_err("no title");

        assert!(matches!(refused, Failed::NoTitle), "{refused:?}");
        assert_eq!(served.join().expect("the listener thread").len(), 1);
    }

    #[test]
    fn pr_open_tells_behind_and_diverged_from_ahead() {
        assert!(Failed::Ahead.to_string().contains("push it first"));
        for refused in [Failed::Behind, Failed::Diverged] {
            assert!(!refused.to_string().contains("push"), "{refused}");
        }
    }

    #[test]
    fn pr_open_sees_a_closing_keyword_already_in_the_body() {
        let here: IssueRef = "o/r#42".parse().expect("an issue");
        assert!(already_closes("Fixes #42.", &here, "o", "r"));
        assert!(already_closes("resolves: O/R#42", &here, "o", "r"));
        assert!(!already_closes("See #42", &here, "o", "r"));
        assert!(!already_closes("Fixes #421", &here, "o", "r"));
        let other: IssueRef = "x/y#9".parse().expect("an issue");
        assert!(!already_closes("Closes #9", &other, "o", "r"));
        assert!(already_closes("closes x/y#9", &other, "o", "r"));
    }

    const HEAD_OPEN: &str = r#"{"number":21,"state":"open","merged_at":null,"head":{"sha":"aaa111"},"user":{"login":"owner"}}"#;
    const MERGED_LIST: &str = r#"[{"number":21,"html_url":"https://github.com/o/r/pull/21","state":"closed","merged_at":"2026-11-10T00:00:00Z"}]"#;
    const SQUASHED: &str =
        r#"{"sha":"bbb222","merged":true,"message":"Pull Request successfully merged"}"#;

    fn pushed() -> thread::Listed {
        listed(None, Some("git@github.com:o/r.git"))
    }

    /// Y-496: the merge is a squash at the head the owner was shown, then the head ref goes.
    #[tokio::test]
    async fn pr_merge_squashes_the_confirmed_pr_and_deletes_its_branch() {
        let (listener, address) = listen();
        let served = serve(
            listener,
            vec![
                reply("200 OK", OPEN),
                reply("200 OK", HEAD_OPEN),
                reply("200 OK", SQUASHED),
                reply("204 No Content", ""),
            ],
        );

        let merged = merge_pr(&pushed(), &at(address), &token(), 21, Some("aaa111"))
            .await
            .expect("merged");

        assert_eq!(
            merged,
            MergedPr {
                number: 21,
                url: "https://github.com/o/r/pull/21".to_owned(),
                branch: UPSTREAM.to_owned(),
                kept: None,
            }
        );
        let seen = served.join().expect("the listener thread");
        assert!(
            seen[1].starts_with("GET /repos/o/r/pulls/21 "),
            "{}",
            seen[1]
        );
        assert!(
            seen[2].starts_with("PUT /repos/o/r/pulls/21/merge "),
            "{}",
            seen[2]
        );
        let body: serde_json::Value =
            serde_json::from_str(seen[2].rsplit("\r\n\r\n").next().unwrap_or_default())
                .expect("a JSON body");
        assert_eq!(
            body,
            serde_json::json!({"merge_method":"squash","sha":"aaa111"})
        );
        assert!(
            seen[3].starts_with("DELETE /repos/o/r/git/refs/heads/yantra/42-11111111 "),
            "{}",
            seen[3]
        );
    }

    /// The owner was shown head `zzz999`; a push moved it to `aaa111`, so nothing is merged.
    #[tokio::test]
    async fn pr_merge_refuses_a_head_the_owner_was_not_shown() {
        let (listener, address) = listen();
        let served = serve(
            listener,
            vec![reply("200 OK", OPEN), reply("200 OK", HEAD_OPEN)],
        );

        let refused = merge_pr(&pushed(), &at(address), &token(), 21, Some("zzz999"))
            .await
            .expect_err("a moved head");

        assert!(
            matches!(refused, Failed::Github(github::Error::HeadMoved)),
            "{refused:?}"
        );
        assert_eq!(served.join().expect("the listener thread").len(), 2);
    }

    /// The owner confirmed #20; #21 is what is open now, so nothing is merged.
    #[tokio::test]
    async fn pr_merge_refuses_a_pr_the_owner_did_not_confirm() {
        let (listener, address) = listen();
        let served = serve(
            listener,
            vec![reply("200 OK", OPEN), reply("200 OK", HEAD_OPEN)],
        );

        let refused = merge_pr(&pushed(), &at(address), &token(), 20, None)
            .await
            .expect_err("another PR");

        assert!(
            matches!(
                refused,
                Failed::NotThatPr {
                    confirmed: 20,
                    open: 21
                }
            ),
            "{refused:?}"
        );
        assert_eq!(served.join().expect("the listener thread").len(), 2);
    }

    /// §B4: a second merge says the PR is merged, and no PR at all says so.
    #[tokio::test]
    async fn pr_merge_twice_says_already_merged_and_no_pr_says_none() {
        let (listener, address) = listen();
        let _served = serve(
            listener,
            vec![
                reply("200 OK", MERGED_LIST),
                reply(
                    "200 OK",
                    r#"{"number":21,"state":"closed","merged_at":"2026-11-10T00:00:00Z","head":{"sha":"aaa111"}}"#,
                ),
                reply("200 OK", NONE_OPEN),
            ],
        );
        let github = at(address);

        let again = merge_pr(&pushed(), &github, &token(), 21, None).await;
        let none = merge_pr(&pushed(), &github, &token(), 21, None).await;

        assert!(
            matches!(again, Err(Failed::AlreadyMerged { number: 21 })),
            "{again:?}"
        );
        assert!(matches!(none, Err(Failed::NoPr)), "{none:?}");
        assert!(matches!(
            merge_pr(&listed(None, None), &github, &token(), 21, None).await,
            Err(Failed::NotPushed)
        ));
    }

    /// A delete that fails after a good merge does not fail the merge.
    #[tokio::test]
    async fn pr_merge_keeps_the_merge_when_the_branch_delete_fails() {
        let (listener, address) = listen();
        let _served = serve(
            listener,
            vec![
                reply("200 OK", OPEN),
                reply("200 OK", HEAD_OPEN),
                reply("200 OK", SQUASHED),
                reply("403 Forbidden", r#"{"message":"Resource not accessible"}"#),
            ],
        );

        let merged = merge_pr(&pushed(), &at(address), &token(), 21, None)
            .await
            .expect("merged");

        assert_eq!(
            merged.kept.as_deref(),
            Some("GitHub answered 403 to the branch delete")
        );
    }

    #[tokio::test]
    async fn pending_pr_reads_the_open_pr_and_its_head() {
        let (listener, address) = listen();
        let _served = serve(
            listener,
            vec![reply("200 OK", OPEN), reply("200 OK", HEAD_OPEN)],
        );

        let pending = pending_pr(&pushed(), &at(address), &token())
            .await
            .expect("pending");

        assert_eq!(pending.number, 21);
        assert_eq!(pending.head_sha, "aaa111");
        assert_eq!(pending.branch, UPSTREAM);
        assert_eq!((pending.owner.as_str(), pending.repo.as_str()), ("o", "r"));
    }

    /// The tip command on a real git: pushed, ahead, behind, diverged, then
    /// no remote-tracking ref at all.
    #[test]
    fn pr_open_reads_the_tip_on_a_real_git() {
        let dir = std::env::temp_dir().join(format!("yt-pr-tip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let work = dir.join("work");
        let mut here = place();
        here.worktree = work.display().to_string();
        let git = format!(
            "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
             GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t\n\
             git init -q --bare {dir}/bare.git && git init -q -b {b} {work} && cd {work} \
             && git commit -q --allow-empty -m 'Fix the thing' -m 'why' \
             && git remote add origin {dir}/bare.git \
             && git push -q -u origin {b}:{UPSTREAM}",
            dir = dir.display(),
            work = work.display(),
            b = here.branch,
        );
        assert!(sh(&git).success(), "the fixture is made");
        let env = "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\n";
        let tip = || sh(&format!("{env}{}", tip_command(&here, UPSTREAM)));

        let pushed = tip();
        assert_eq!(pushed.status, 0);
        assert!(pushed.stdout.starts_with(b"Fix the thing\0why\n"));
        let run = |step: &str| {
            sh(&format!(
                "{env}export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t \
                 GIT_COMMITTER_EMAIL=t@t\ncd {} && {step}",
                work.display()
            ))
            .success()
        };
        assert!(run("git commit -q --allow-empty -m more"));
        assert_eq!(tip().status, AHEAD);
        assert!(run(&format!(
            "git push -q origin HEAD:{UPSTREAM} && git reset -q --hard HEAD~1"
        )));
        assert_eq!(tip().status, BEHIND);
        assert!(run("git commit -q --allow-empty -m other"));
        assert_eq!(tip().status, DIVERGED);
        assert!(run(&format!(
            "git update-ref -d refs/remotes/origin/{UPSTREAM}"
        )));
        assert_eq!(tip().status, NOT_PUSHED);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
