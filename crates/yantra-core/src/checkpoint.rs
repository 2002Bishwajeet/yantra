/*
 * The shape below is T3 Code's, at commit 72d5c32:
 * https://github.com/pingdotgg/t3code/blob/main/apps/server/src/checkpointing/CheckpointStore.ts
 * https://github.com/pingdotgg/t3code/blob/main/apps/server/src/vcs/GitVcsDriver.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 *
 * Kept: a checkpoint is a parentless commit of the whole tree, made through a private index
 * and held by a hidden ref; checkpoint 0 is the tree before the first turn and N the tree after
 * turn N; a restore is `restore --source … --worktree --staged`, `clean -fd` and a `reset` to
 * HEAD, with the guard for a checkpoint that tracks nothing. Changed: one remote shell command
 * per call, and a revert deletes the refs above it so the numbers stay contiguous.
 */
//! Checkpoints of a chat thread's worktree, and a revert to one (Y-448).
//!
//! A checkpoint is a commit no branch reaches, under
//! `refs/yantra/checkpoints/<thread id>/<n>`, so the daemon still keeps
//! nothing and no branch moves. [`crate::thread::remove`] deletes them.

use crate::ssh::{self, Exec};
use crate::thread::Place;
use crate::tmux::sq;

/// The most of one diff a caller gets.
pub const LIMIT: usize = 256 * 1024;
/// How the commands below say a checkpoint is not there.
const NO_CHECKPOINT: i32 = 3;
/// `commit-tree` refuses on a machine with no git identity.
const IDENTITY: &str = "GIT_AUTHOR_NAME=Yantra GIT_AUTHOR_EMAIL=yantra@localhost \
                        GIT_COMMITTER_NAME=Yantra GIT_COMMITTER_EMAIL=yantra@localhost";
/// The browser reads `a/` and `b/`, so no user config may change the format.
const DIFF_FLAGS: &str =
    "--no-color --no-ext-diff --no-textconv --no-relative --src-prefix=a/ --dst-prefix=b/";
/// `git diff` dies of SIGPIPE when `head` has read enough, which is no failure.
const SIGPIPE: i32 = 128 + 13;
/// Writes the whole worktree, untracked files too, as `$tree` through a
/// private index, so the real one is untouched. `cp -p` keeps the index's
/// time, so git's racy check still sees a file changed in its second.
const SNAPSHOT: &str = "tmp=$(mktemp) || exit\n\
     trap 'rm -f \"$tmp\" \"$tmp.lock\"' EXIT\n\
     cp -p \"$(git rev-parse --git-path index)\" \"$tmp\" 2>/dev/null || rm -f \"$tmp\"\n\
     GIT_INDEX_FILE=$tmp git -c core.fsmonitor=false add -A \
     && tree=$(GIT_INDEX_FILE=$tmp git write-tree)";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("the thread has no checkpoint {turn}")]
    NoCheckpoint { turn: u32 },

    #[error("git could not keep or restore a checkpoint: {stderr}")]
    Git { stderr: String },

    #[error(transparent)]
    Ssh(#[from] ssh::Error),
}

/// What one turn changed. Never logged or printed (Q5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diff {
    pub unified: String,
    /// The diff was longer than [`LIMIT`] and was cut there.
    pub truncated: bool,
}

/// Everything a thread changed since its branch left the repository's `HEAD`:
/// its commits and its uncommitted files (Y-490). Never logged (Q5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchDiff {
    /// The merge-base of the thread's branch and the repository's `HEAD`.
    pub base: String,
    pub files: Vec<FileStat>,
    /// The file list was longer than [`LIMIT`] and was cut at a whole file.
    pub files_truncated: bool,
    pub diff: Diff,
}

/// One file of a [`BranchDiff`]. The counts are `None` for a binary file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStat {
    pub path: String,
    /// The path the file was renamed from.
    pub from: Option<String>,
    pub added: Option<u32>,
    pub deleted: Option<u32>,
}

fn refs(place: &Place) -> String {
    format!("refs/yantra/checkpoints/{}", place.id)
}

fn named(place: &Place, turn: u32) -> String {
    sq(&format!("{}/{turn}^{{commit}}", refs(place)))
}

/// Keeps the tree as checkpoint 0 when the thread has none yet, so a thread
/// that existed before checkpoints gets one too. `None` when it had one.
pub async fn base<E: Exec>(exec: &E, place: &Place) -> Result<Option<u32>, Error> {
    let stdout = run(exec, &keep(place, true)).await?;
    if stdout.trim().is_empty() {
        return Ok(None);
    }
    number(&stdout).map(Some)
}

/// Keeps the tree as the next checkpoint and returns its number.
pub async fn capture<E: Exec>(exec: &E, place: &Place) -> Result<u32, Error> {
    number(&run(exec, &keep(place, false)).await?)
}

/// The newest checkpoint that has a diff, which is the last turn's, or `None`
/// when the thread holds no checkpoint above 0. The numbers are contiguous.
pub async fn latest<E: Exec>(exec: &E, place: &Place) -> Result<Option<u32>, Error> {
    let count = run(
        exec,
        &format!(
            "cd {} || exit\ngit for-each-ref --format=x {} | wc -l",
            sq(&place.worktree),
            sq(&refs(place))
        ),
    )
    .await?;
    Ok(number(&count)?.checked_sub(1).filter(|&turn| turn > 0))
}

fn number(stdout: &str) -> Result<u32, Error> {
    stdout.trim().parse().map_err(|_| Error::Git {
        stderr: format!("git printed `{}` for a checkpoint number", stdout.trim()),
    })
}

/// The next number is the count of the thread's refs.
/// The empty old value makes `update-ref` refuse a ref that exists, so two
/// captures at once never overwrite each other; the loser counts again once.
fn keep(place: &Place, first: bool) -> String {
    let refs = sq(&refs(place));
    let count = format!("n=$(git for-each-ref --format=x {refs} | wc -l) && n=$((n)) || exit\n");
    let (only_first, again) = if first {
        (
            "[ \"$n\" -eq 0 ] || exit 0\n".to_owned(),
            // Another caller kept checkpoint 0 first.
            format!("git rev-parse -q --verify {refs}/0 >/dev/null && exit 0\n"),
        )
    } else {
        (String::new(), count.clone())
    };
    format!(
        "cd {worktree} || exit\n\
         {count}\
         {only_first}\
         {SNAPSHOT} \
         && commit=$({IDENTITY} git commit-tree -m 'yantra checkpoint' \"$tree\") || exit\n\
         if ! git update-ref {refs}/\"$n\" \"$commit\" '' 2>/dev/null; then\n\
         {again}\
         git update-ref {refs}/\"$n\" \"$commit\" '' || exit\n\
         fi\n\
         echo \"$n\"",
        worktree = sq(&place.worktree),
    )
}

/// What turn `turn` changed: checkpoint `turn - 1` to checkpoint `turn`.
pub async fn diff<E: Exec>(exec: &E, place: &Place, turn: u32) -> Result<Diff, Error> {
    let Some(before) = turn.checked_sub(1) else {
        return Err(Error::NoCheckpoint { turn });
    };
    let (from, to) = (named(place, before), named(place, turn));
    let out = exec
        .exec(&format!(
            "cd {worktree} || exit\n\
             for c in {from} {to}; do \
             git rev-parse -q --verify \"$c\" >/dev/null || exit {NO_CHECKPOINT}; done\n\
             {}",
            capped(&format!(
                "git -c core.quotePath=false diff {DIFF_FLAGS} {from} {to}"
            )),
            worktree = sq(&place.worktree),
        ))
        .await?;
    match out.status {
        0 => Ok(cut(&out.stdout)),
        NO_CHECKPOINT => Err(Error::NoCheckpoint { turn }),
        _ => Err(failed(&out)),
    }
}

/// The whole tree of the thread's worktree, untracked files too, against the
/// merge-base of its branch and the repository's `HEAD`. The base is asked
/// fresh, because `HEAD` moves after the thread opens.
pub async fn branch<E: Exec>(exec: &E, place: &Place) -> Result<BranchDiff, Error> {
    let worktree = sq(&place.worktree);
    let out = exec
        .exec(&format!(
            "cd {worktree} || exit\n\
             b=$(git -C {repo} merge-base {branch} HEAD) \
             || {{ echo 'fatal: the branch has no merge-base with HEAD' >&2; exit 1; }}\n\
             {SNAPSHOT} || exit\n\
             echo \"$b $tree\"\n\
             {numstat}",
            repo = sq(&place.repo),
            branch = sq(&place.branch),
            numstat = capped(&format!(
                "git -c core.quotePath=false diff --numstat -z -M {DIFF_FLAGS} \"$b\" \"$tree\""
            )),
        ))
        .await?;
    if !out.success() {
        return Err(failed(&out));
    }
    let mut lines = out.stdout.splitn(2, |&b| b == b'\n');
    let named = String::from_utf8_lossy(lines.next().unwrap_or_default());
    // Both go into the next command unquoted, so each must be an object name.
    let object = |word: &str| !word.is_empty() && word.bytes().all(|b| b.is_ascii_hexdigit());
    let Some((base, tree)) = named
        .split_once(' ')
        .filter(|&(b, t)| object(b) && object(t))
    else {
        return Err(Error::Git {
            stderr: "git did not name the merge-base and the tree".to_owned(),
        });
    };
    let (files, files_truncated) = stats(lines.next().unwrap_or_default())?;

    let out = exec
        .exec(&format!(
            "cd {worktree} || exit\n\
             {}",
            capped(&format!(
                "git -c core.quotePath=false diff -M {DIFF_FLAGS} {base} {tree}"
            )),
        ))
        .await?;
    if !out.success() {
        return Err(failed(&out));
    }
    Ok(BranchDiff {
        base: base.to_owned(),
        files,
        files_truncated,
        diff: cut(&out.stdout),
    })
}

/// Reads `git diff --numstat -z`: `added\tdeleted\tpath\0`, or
/// `added\tdeleted\t\0from\0path\0` for a rename, and `-` for a binary count.
/// A record the cap cut is dropped.
fn stats(numstat: &[u8]) -> Result<(Vec<FileStat>, bool), Error> {
    let truncated = numstat.len() > LIMIT;
    let mut fields: Vec<&[u8]> = numstat[..numstat.len().min(LIMIT)]
        .split(|&b| b == 0)
        .collect();
    // What follows the last NUL is empty, or a field the cap cut.
    fields.pop();
    let unreadable = || Error::Git {
        stderr: "git printed a file list Yantra cannot read".to_owned(),
    };
    let count = |count: &str| match count {
        "-" => Ok(None),
        _ => count.parse().map(Some).map_err(|_| unreadable()),
    };
    let lossy = |field: &[u8]| String::from_utf8_lossy(field).into_owned();
    let mut fields = fields.into_iter();
    let mut files = Vec::new();
    while let Some(field) = fields.next() {
        let field = lossy(field);
        let mut parts = field.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            return Err(unreadable());
        };
        let (path, from) = if path.is_empty() {
            match (fields.next(), fields.next()) {
                (Some(from), Some(path)) => (lossy(path), Some(lossy(from))),
                _ if truncated => break,
                _ => return Err(unreadable()),
            }
        } else {
            (path.to_owned(), None)
        };
        files.push(FileStat {
            path,
            from,
            added: count(added)?,
            deleted: count(deleted)?,
        });
    }
    Ok((files, truncated))
}

/// Runs `command` and passes on one byte more than [`LIMIT`], so a caller can
/// tell that it was cut.
fn capped(command: &str) -> String {
    format!(
        "exec 3>&1\n\
         s=$({{ {{ {command}; echo $? >&4; }} | head -c {over} >&3; }} 4>&1)\n\
         [ \"$s\" -eq 0 ] || [ \"$s\" -eq {SIGPIPE} ] || exit \"$s\"",
        over = LIMIT + 1,
    )
}

/// At most [`LIMIT`] bytes, cut where a character ends.
fn cut(stdout: &[u8]) -> Diff {
    if stdout.len() <= LIMIT {
        return Diff {
            unified: String::from_utf8_lossy(stdout).into_owned(),
            truncated: false,
        };
    }
    let head = &stdout[..LIMIT];
    let kept = match std::str::from_utf8(head) {
        Err(error) if error.error_len().is_none() => &head[..error.valid_up_to()],
        _ => head,
    };
    let unified = String::from_utf8_lossy(kept);
    let end = unified.floor_char_boundary(LIMIT);
    Diff {
        unified: unified[..end].to_owned(),
        truncated: true,
    }
}

/// Puts the worktree's files back as checkpoint `turn` kept them, and leaves
/// the index at `HEAD`. Then deletes every checkpoint above it, so the next
/// turn is `turn + 1` and diffs against the restored tree.
pub async fn revert<E: Exec>(exec: &E, place: &Place, turn: u32) -> Result<(), Error> {
    let out = exec
        .exec(&format!(
            "cd {worktree} || exit\n\
             c=$(git rev-parse -q --verify {at}) || exit {NO_CHECKPOINT}\n\
             if [ -n \"$(git ls-files --cached --with-tree=\"$c\" -- . | head -n 1)\" ]; then \
             git restore --source \"$c\" --worktree --staged -- . || exit; fi\n\
             git clean -fdq -- . || exit\n\
             if git rev-parse -q --verify HEAD >/dev/null; then git reset -q -- . || exit; fi\n\
             git for-each-ref --format='%(refname) %(objectname)' {refs} | while read -r r o; do \
             [ \"${{r##*/}}\" -le {turn} ] || echo \"delete $r $o\"; done | git update-ref --stdin",
            worktree = sq(&place.worktree),
            at = named(place, turn),
            refs = sq(&refs(place)),
        ))
        .await?;
    match out.status {
        0 => Ok(()),
        NO_CHECKPOINT => Err(Error::NoCheckpoint { turn }),
        _ => Err(failed(&out)),
    }
}

/// Deletes every checkpoint of the thread, for [`crate::thread::remove`].
pub(crate) fn forget(place: &Place) -> String {
    let repo = sq(&place.repo);
    format!(
        "git -C {repo} for-each-ref --format='delete %(refname)' {} \
         | git -C {repo} update-ref --stdin",
        sq(&refs(place))
    )
}

async fn run<E: Exec>(exec: &E, command: &str) -> Result<String, Error> {
    let out = exec.exec(command).await?;
    if !out.success() {
        return Err(failed(&out));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn failed(out: &ssh::Output) -> Error {
    Error::Git {
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use std::sync::{Mutex, PoisonError};

    const WORKTREE: &str = "/home/u/.yantra/worktrees/chat/web/11111111";
    const REFS: &str = "'refs/yantra/checkpoints/chat/web/11111111'";

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

    fn out(status: i32, stdout: &[u8], stderr: &str) -> ssh::Output {
        ssh::Output {
            status,
            stdout: stdout.to_vec(),
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

    const COUNT: &str = "n=$(git for-each-ref --format=x \
                         'refs/yantra/checkpoints/chat/web/11111111' | wc -l) \
                         && n=$((n)) || exit\n";

    fn kept(guard: &str, again: &str) -> String {
        format!(
            "cd '{WORKTREE}' || exit\n\
             {COUNT}\
             {guard}\
             tmp=$(mktemp) || exit\n\
             trap 'rm -f \"$tmp\" \"$tmp.lock\"' EXIT\n\
             cp -p \"$(git rev-parse --git-path index)\" \"$tmp\" 2>/dev/null || rm -f \"$tmp\"\n\
             GIT_INDEX_FILE=$tmp git -c core.fsmonitor=false add -A \
             && tree=$(GIT_INDEX_FILE=$tmp git write-tree) \
             && commit=$(GIT_AUTHOR_NAME=Yantra GIT_AUTHOR_EMAIL=yantra@localhost \
             GIT_COMMITTER_NAME=Yantra GIT_COMMITTER_EMAIL=yantra@localhost \
             git commit-tree -m 'yantra checkpoint' \"$tree\") || exit\n\
             if ! git update-ref {REFS}/\"$n\" \"$commit\" '' 2>/dev/null; then\n\
             {again}\
             git update-ref {REFS}/\"$n\" \"$commit\" '' || exit\n\
             fi\n\
             echo \"$n\""
        )
    }

    #[tokio::test]
    async fn capture_commits_the_tree_through_a_private_index_and_names_its_number() {
        let machine = Machine::answering(vec![out(0, b"2\n", "")]);
        assert_eq!(capture(&machine, &place()).await.expect("kept"), 2);
        assert_eq!(
            machine.asked(),
            [kept("", COUNT)],
            "a lost race counts again"
        );
    }

    #[tokio::test]
    async fn base_keeps_checkpoint_0_only_when_the_thread_has_none() {
        let machine = Machine::answering(vec![out(0, b"0\n", ""), out(0, b"", "")]);
        assert_eq!(base(&machine, &place()).await.expect("kept"), Some(0));
        assert_eq!(base(&machine, &place()).await.expect("had one"), None);
        let base = kept(
            "[ \"$n\" -eq 0 ] || exit 0\n",
            &format!("git rev-parse -q --verify {REFS}/0 >/dev/null && exit 0\n"),
        );
        assert_eq!(machine.asked(), [base.clone(), base]);
    }

    #[tokio::test]
    async fn a_capture_git_refused_or_printed_nonsense_is_named() {
        let refused = Machine::answering(vec![out(
            128,
            b"",
            "fatal: unable to auto-detect email address\n",
        )]);
        assert!(matches!(
            capture(&refused, &place()).await,
            Err(Error::Git { stderr }) if stderr == "fatal: unable to auto-detect email address"
        ));
        let odd = Machine::answering(vec![out(0, b"x\n", "")]);
        assert!(matches!(
            base(&odd, &place()).await,
            Err(Error::Git { stderr }) if stderr.contains("`x`")
        ));
    }

    #[tokio::test]
    async fn diff_asks_both_checkpoints_and_diffs_them() {
        let machine = Machine::answering(vec![out(0, b"diff --git a/a b/a\n", "")]);
        assert_eq!(
            diff(&machine, &place(), 2).await.expect("diffed"),
            Diff {
                unified: "diff --git a/a b/a\n".to_owned(),
                truncated: false,
            }
        );
        let one = "'refs/yantra/checkpoints/chat/web/11111111/1^{commit}'";
        let two = "'refs/yantra/checkpoints/chat/web/11111111/2^{commit}'";
        assert_eq!(
            machine.asked(),
            [format!(
                "cd '{WORKTREE}' || exit\n\
                 for c in {one} {two}; do \
                 git rev-parse -q --verify \"$c\" >/dev/null || exit 3; done\n\
                 exec 3>&1\n\
                 s=$({{ {{ git -c core.quotePath=false diff --no-color --no-ext-diff \
                 --no-textconv --no-relative --src-prefix=a/ --dst-prefix=b/ {one} {two}; \
                 echo $? >&4; }} | head -c 262145 >&3; }} 4>&1)\n\
                 [ \"$s\" -eq 0 ] || [ \"$s\" -eq 141 ] || exit \"$s\""
            )]
        );
    }

    #[tokio::test]
    async fn a_diff_without_its_checkpoints_and_a_git_that_failed_are_named() {
        let machine = Machine::answering(vec![]);
        assert!(matches!(
            diff(&machine, &place(), 0).await,
            Err(Error::NoCheckpoint { turn: 0 })
        ));
        assert!(machine.asked().is_empty(), "turn 0 has nothing before it");

        let missing = Machine::answering(vec![out(NO_CHECKPOINT, b"", "")]);
        assert!(matches!(
            diff(&missing, &place(), 4).await,
            Err(Error::NoCheckpoint { turn: 4 })
        ));
        let gone = Machine::answering(vec![out(2, b"", "sh: cd: can't cd to /x\n")]);
        assert!(matches!(
            diff(&gone, &place(), 1).await,
            Err(Error::Git { stderr }) if stderr == "sh: cd: can't cd to /x"
        ));
    }

    #[test]
    fn a_long_diff_is_cut_at_the_limit_where_a_character_ends() {
        let short = cut(b"+a\n");
        assert!(!short.truncated);

        let mut long = vec![b'+'; LIMIT - 1];
        long.extend("é and more".as_bytes());
        let cut_long = cut(&long);
        assert!(cut_long.truncated);
        assert_eq!(cut_long.unified.len(), LIMIT - 1, "é does not fit whole");
        assert!(cut_long.unified.bytes().all(|byte| byte == b'+'));

        let exact = cut(&vec![b'+'; LIMIT + 1]);
        assert!(exact.truncated);
        assert_eq!(exact.unified.len(), LIMIT);
    }

    #[tokio::test]
    async fn revert_restores_cleans_resets_and_drops_the_checkpoints_above() {
        let machine = Machine::answering(vec![out(0, b"", "")]);
        revert(&machine, &place(), 1).await.expect("reverted");
        assert_eq!(
            machine.asked(),
            [format!(
                "cd '{WORKTREE}' || exit\n\
                 c=$(git rev-parse -q --verify \
                 'refs/yantra/checkpoints/chat/web/11111111/1^{{commit}}') || exit 3\n\
                 if [ -n \"$(git ls-files --cached --with-tree=\"$c\" -- . | head -n 1)\" ]; then \
                 git restore --source \"$c\" --worktree --staged -- . || exit; fi\n\
                 git clean -fdq -- . || exit\n\
                 if git rev-parse -q --verify HEAD >/dev/null; then git reset -q -- . || exit; fi\n\
                 git for-each-ref --format='%(refname) %(objectname)' {REFS} \
                 | while read -r r o; do \
                 [ \"${{r##*/}}\" -le 1 ] || echo \"delete $r $o\"; done | git update-ref --stdin"
            )]
        );
    }

    #[tokio::test]
    async fn a_revert_to_nothing_and_a_revert_git_refused_are_named() {
        let missing = Machine::answering(vec![out(NO_CHECKPOINT, b"", "")]);
        assert!(matches!(
            revert(&missing, &place(), 7).await,
            Err(Error::NoCheckpoint { turn: 7 })
        ));
        let refused = Machine::answering(vec![out(
            1,
            b"",
            "error: unable to unlink old 'a': Permission denied\n",
        )]);
        assert!(matches!(
            revert(&refused, &place(), 0).await,
            Err(Error::Git { stderr }) if stderr == "error: unable to unlink old 'a': Permission denied"
        ));
    }

    const BASE: &str = "0123abcd0123abcd0123abcd0123abcd0123abcd";
    const TREE: &str = "4567ef014567ef014567ef014567ef014567ef01";

    fn stat(path: &str, from: Option<&str>, counts: Option<(u32, u32)>) -> FileStat {
        FileStat {
            path: path.to_owned(),
            from: from.map(str::to_owned),
            added: counts.map(|(added, _)| added),
            deleted: counts.map(|(_, deleted)| deleted),
        }
    }

    #[tokio::test]
    async fn branch_snapshots_the_tree_against_a_fresh_merge_base_and_diffs_it() {
        let numstat =
            b"2\t1\tkeep.txt\x000\t0\t\x00old-name.txt\x00new-name.txt\x00-\t-\tblob.bin\x00";
        let mut first = format!("{BASE} {TREE}\n").into_bytes();
        first.extend_from_slice(numstat);
        let machine = Machine::answering(vec![
            out(0, &first, ""),
            out(0, b"diff --git a/keep.txt b/keep.txt\n", ""),
        ]);
        assert_eq!(
            branch(&machine, &place()).await.expect("diffed"),
            BranchDiff {
                base: BASE.to_owned(),
                files: vec![
                    stat("keep.txt", None, Some((2, 1))),
                    stat("new-name.txt", Some("old-name.txt"), Some((0, 0))),
                    stat("blob.bin", None, None),
                ],
                files_truncated: false,
                diff: Diff {
                    unified: "diff --git a/keep.txt b/keep.txt\n".to_owned(),
                    truncated: false,
                },
            }
        );
        let flags = "--no-color --no-ext-diff --no-textconv --no-relative \
                     --src-prefix=a/ --dst-prefix=b/";
        assert_eq!(
            machine.asked(),
            [
                format!(
                    "cd '{WORKTREE}' || exit\n\
                     b=$(git -C '/home/u/repo' merge-base 'yantra/chat/web/11111111' HEAD) \
                     || {{ echo 'fatal: the branch has no merge-base with HEAD' >&2; exit 1; }}\n\
                     tmp=$(mktemp) || exit\n\
                     trap 'rm -f \"$tmp\" \"$tmp.lock\"' EXIT\n\
                     cp -p \"$(git rev-parse --git-path index)\" \"$tmp\" 2>/dev/null \
                     || rm -f \"$tmp\"\n\
                     GIT_INDEX_FILE=$tmp git -c core.fsmonitor=false add -A \
                     && tree=$(GIT_INDEX_FILE=$tmp git write-tree) || exit\n\
                     echo \"$b $tree\"\n\
                     exec 3>&1\n\
                     s=$({{ {{ git -c core.quotePath=false diff --numstat -z -M {flags} \
                     \"$b\" \"$tree\"; echo $? >&4; }} | head -c 262145 >&3; }} 4>&1)\n\
                     [ \"$s\" -eq 0 ] || [ \"$s\" -eq 141 ] || exit \"$s\""
                ),
                format!(
                    "cd '{WORKTREE}' || exit\n\
                     exec 3>&1\n\
                     s=$({{ {{ git -c core.quotePath=false diff -M {flags} {BASE} {TREE}; \
                     echo $? >&4; }} | head -c 262145 >&3; }} 4>&1)\n\
                     [ \"$s\" -eq 0 ] || [ \"$s\" -eq 141 ] || exit \"$s\""
                ),
            ]
        );
    }

    #[test]
    fn numstat_reads_odd_paths_and_drops_a_cut_record() {
        let odd = b"1\t0\ta\tb.txt\x003\t2\tline\nbreak.txt\x000\t1\t\xc3\xa9.txt\x00\
                    0\t0\t\x00from\ttab\x00to\nline\x00";
        assert_eq!(
            stats(odd).expect("read"),
            (
                vec![
                    stat("a\tb.txt", None, Some((1, 0))),
                    stat("line\nbreak.txt", None, Some((3, 2))),
                    stat("é.txt", None, Some((0, 1))),
                    stat("to\nline", Some("from\ttab"), Some((0, 0))),
                ],
                false
            )
        );
        assert_eq!(stats(b"").expect("read"), (vec![], false));

        // One byte over the cap is a cut, wherever it falls.
        let record = b"1\t1\tf\x00";
        let mut long: Vec<u8> = record.repeat(LIMIT / record.len());
        let whole = long.len() / record.len();
        long.extend_from_slice(b"7\t7\tcut-in-half.txt\x00");
        let (files, cut) = stats(&long).expect("read");
        assert!(cut);
        assert_eq!(files.len(), whole, "the record the cap cut is dropped");
        assert!(files.iter().all(|file| file.path == "f"));

        // The cap falls after a rename's old path and before its new one.
        let mut renamed = format!("1\t1\t{}\0", "f".repeat(LIMIT - 14)).into_bytes();
        renamed.extend_from_slice(b"0\t0\t\x00old\x00new\x00");
        assert_eq!(renamed.len(), LIMIT + 4);
        let (files, cut) = stats(&renamed).expect("read");
        assert!(cut);
        assert_eq!(files.len(), 1, "a rename without its new path is dropped");
    }

    #[test]
    fn numstat_git_should_never_print_is_a_git_error() {
        for odd in [&b"1\t1\x00"[..], b"x\t1\tf\x00", b"1\t1\t\x00old\x00"] {
            assert!(
                matches!(stats(odd), Err(Error::Git { .. })),
                "{}",
                String::from_utf8_lossy(odd)
            );
        }
    }

    #[tokio::test]
    async fn a_branch_diff_git_refused_is_named_in_gits_words() {
        let gone = Machine::answering(vec![out(2, b"", "sh: cd: can't cd to /x\n")]);
        assert!(matches!(
            branch(&gone, &place()).await,
            Err(Error::Git { stderr }) if stderr == "sh: cd: can't cd to /x"
        ));
        let unrelated = Machine::answering(vec![out(
            1,
            b"",
            "fatal: the branch has no merge-base with HEAD\n",
        )]);
        assert!(matches!(
            branch(&unrelated, &place()).await,
            Err(Error::Git { stderr }) if stderr == "fatal: the branch has no merge-base with HEAD"
        ));
        let odd = Machine::answering(vec![out(0, b"$(reboot) x\n", "")]);
        assert!(
            matches!(branch(&odd, &place()).await, Err(Error::Git { .. })),
            "a base that is no object name never reaches a command"
        );
        assert_eq!(odd.asked().len(), 1);
        let corrupt = Machine::answering(vec![
            out(0, format!("{BASE} {TREE}\n").as_bytes(), ""),
            out(128, b"", "fatal: unable to read 89ab\n"),
        ]);
        assert!(matches!(
            branch(&corrupt, &place()).await,
            Err(Error::Git { stderr }) if stderr == "fatal: unable to read 89ab"
        ));
    }

    #[test]
    fn forget_deletes_every_ref_of_the_thread() {
        assert_eq!(
            forget(&place()),
            format!(
                "git -C '/home/u/repo' for-each-ref --format='delete %(refname)' {REFS} \
                 | git -C '/home/u/repo' update-ref --stdin"
            )
        );
    }
}
