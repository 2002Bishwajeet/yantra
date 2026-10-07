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

fn number(stdout: &str) -> Result<u32, Error> {
    stdout.trim().parse().map_err(|_| Error::Git {
        stderr: format!("git printed `{}` for a checkpoint number", stdout.trim()),
    })
}

/// The next number is the count of the thread's refs. `cp -p` keeps the
/// index's time, so git's racy check still sees a file changed in its second.
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
         tmp=$(mktemp) || exit\n\
         trap 'rm -f \"$tmp\" \"$tmp.lock\"' EXIT\n\
         cp -p \"$(git rev-parse --git-path index)\" \"$tmp\" 2>/dev/null || rm -f \"$tmp\"\n\
         GIT_INDEX_FILE=$tmp git -c core.fsmonitor=false add -A \
         && tree=$(GIT_INDEX_FILE=$tmp git write-tree) \
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
             exec 3>&1\n\
             s=$({{ {{ git -c core.quotePath=false diff {DIFF_FLAGS} {from} {to}; echo $? >&4; }} \
             | head -c {over} >&3; }} 4>&1)\n\
             [ \"$s\" -eq 0 ] || [ \"$s\" -eq {SIGPIPE} ] || exit \"$s\"",
            worktree = sq(&place.worktree),
            over = LIMIT + 1,
        ))
        .await?;
    match out.status {
        0 => Ok(cut(&out.stdout)),
        NO_CHECKPOINT => Err(Error::NoCheckpoint { turn }),
        _ => Err(failed(&out)),
    }
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
