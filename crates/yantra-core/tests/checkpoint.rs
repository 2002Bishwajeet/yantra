//! Y-448 against a real sshd and real git, per §B3: a thread's checkpoints
//! keep its tree, a revert puts it back, and no branch of the repository moves.
//! The fixture has no git identity, which is the case `commit-tree` refuses.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::checkpoint::{self, Error};
use yantra_core::ssh::{Machine, Ssh};
use yantra_core::thread;
use yantra_core::tmux::Tmux;
use yantra_core::workspace::Workspace;

const REPO: &str = "/home/yantra/checkpoints";

/// Short on purpose: `%C` adds 40 characters and the socket path budget is 90.
fn state_dir() -> Result<std::path::PathBuf> {
    let dir = std::path::PathBuf::from("/tmp").join("yt-ckp");
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[tokio::test]
async fn a_revert_restores_the_tree_and_moves_no_branch() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let dir = state_dir()?;
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: dir.clone(),
    })?;
    assert_eq!(
        fixture
            .run("git config --global user.email || echo none")?
            .trim(),
        "none",
        "the fixture has no git identity"
    );
    fixture.run(&format!(
        "mkdir -p {REPO} && cd {REPO} && git init -q && printf 'one\\n' > kept.txt \
         && printf 'gone\\n' > gone.txt && git add kept.txt gone.txt \
         && git -c user.name=t -c user.email=t@example.com commit -qm one"
    ))?;
    let workspace = Workspace {
        name: "ckp".to_owned(),
        machine: "fixture".to_owned(),
        repo: REPO.into(),
        startup: None,
    };
    let place = thread::open(&ssh, &workspace).await?;
    let wt = place.worktree.clone();

    let repo_state = format!(
        "git -C {REPO} rev-parse HEAD && git -C {REPO} rev-list --count HEAD \
         && git -C {REPO} for-each-ref refs/heads && git -C {REPO} status --porcelain \
         && git -C {REPO} rev-parse {}",
        place.branch
    );
    let before = fixture.run(&repo_state)?;
    let tree =
        format!("cd {wt} && find . -path ./.git -prune -o -type f -print | sort | xargs cat");
    let original = fixture.run(&format!(
        "cd {wt} && find . -path ./.git -prune -o -print | sort"
    ))?;
    let contents = fixture.run(&tree)?;

    // Two tabs at once: one keeps checkpoint 0 and the other finds it kept.
    let (one, two) = tokio::join!(
        checkpoint::base(&ssh, &place),
        checkpoint::base(&ssh, &place)
    );
    let mut bases = [one?, two?];
    bases.sort_unstable();
    assert_eq!(bases, [None, Some(0)]);
    assert_eq!(checkpoint::base(&ssh, &place).await?, None, "one baseline");
    assert_eq!(checkpoint::latest(&ssh, &place).await?, None, "no turn yet");

    fixture.run(&format!(
        "cd {wt} && printf 'two\\n' >> kept.txt && rm gone.txt \
         && printf 'new\\n' > made.txt && mkdir -p deep/er && printf 'x\\n' > deep/er/file.txt \
         && printf 'u\\n' > é.txt"
    ))?;
    // Two captures at once take two numbers, and neither overwrites the other.
    let (one, two) = tokio::join!(
        checkpoint::capture(&ssh, &place),
        checkpoint::capture(&ssh, &place)
    );
    let mut turns = [one?, two?];
    turns.sort_unstable();
    assert_eq!(turns, [1, 2]);
    assert_eq!(checkpoint::latest(&ssh, &place).await?, Some(2));
    assert_eq!(checkpoint::diff(&ssh, &place, 2).await?.unified, "");

    // A user's config must not change the format the browser reads.
    fixture.run(&format!(
        "git -C {REPO} config diff.noprefix true && git -C {REPO} config diff.mnemonicPrefix true \
         && git -C {REPO} config color.ui always && git -C {REPO} config core.quotePath true \
         && git -C {REPO} config diff.external /bin/false"
    ))?;
    let diff = checkpoint::diff(&ssh, &place, 1).await?;
    assert!(!diff.truncated);
    for changed in [
        "kept.txt",
        "gone.txt",
        "made.txt",
        "deep/er/file.txt",
        "é.txt",
    ] {
        assert!(
            diff.unified
                .contains(&format!("diff --git a/{changed} b/{changed}")),
            "{changed}"
        );
    }
    assert!(diff.unified.contains("+two"));
    assert!(diff.unified.contains("deleted file mode"));

    checkpoint::revert(&ssh, &place, 0).await?;
    assert_eq!(
        fixture.run(&format!(
            "cd {wt} && find . -path ./.git -prune -o -print | sort"
        ))?,
        original,
        "the new files and the directory are gone, the deleted one is back"
    );
    assert_eq!(fixture.run(&tree)?, contents);
    assert_eq!(
        fixture.run(&format!("git -C {wt} status --porcelain"))?,
        "",
        "the index is back at HEAD"
    );
    assert_eq!(fixture.run(&repo_state)?, before, "no branch moved");

    let refs = format!("git -C {REPO} for-each-ref --format='%(refname)' refs/yantra/checkpoints");
    assert_eq!(
        fixture.run(&refs)?.trim(),
        format!("refs/yantra/checkpoints/{}/0", place.id),
        "checkpoint 1 is deleted"
    );
    assert_eq!(checkpoint::latest(&ssh, &place).await?, None);
    assert!(matches!(
        checkpoint::revert(&ssh, &place, 1).await,
        Err(Error::NoCheckpoint { turn: 1 })
    ));
    assert!(matches!(
        checkpoint::diff(&ssh, &place, 1).await,
        Err(Error::NoCheckpoint { turn: 1 })
    ));

    // The next turn is 1 again, and diffs against the restored tree.
    fixture.run(&format!("cd {wt} && printf 'again\\n' > again.txt"))?;
    assert_eq!(checkpoint::capture(&ssh, &place).await?, 1);
    assert_eq!(checkpoint::latest(&ssh, &place).await?, Some(1));
    let again = checkpoint::diff(&ssh, &place, 1).await?;
    assert!(again.unified.contains("a/again.txt"), "{}", again.unified);
    assert!(!again.unified.contains("made.txt"), "{}", again.unified);

    // A git diff that fails is a failure, not an empty diff.
    fixture.run(&format!(
        "cd {wt} && h=$(git rev-parse refs/yantra/checkpoints/{}/1:again.txt) \
         && rm \"$(git rev-parse --git-common-dir)/objects/$(echo $h | cut -c1-2)/$(echo $h | cut -c3-)\"",
        place.id
    ))?;
    assert!(matches!(
        checkpoint::diff(&ssh, &place, 1).await,
        Err(Error::Git { stderr }) if !stderr.is_empty()
    ));

    thread::remove(&ssh, Some(&Tmux::resolve(&ssh).await?), &place).await?;
    assert_eq!(
        fixture.run(&refs)?.trim(),
        "",
        "remove forgets the checkpoints"
    );
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

const BRANCH_REPO: &str = "/home/yantra/branchdiff";

/// Y-490: the whole branch, committed and uncommitted work, against the
/// merge-base, read through a hostile git config, with no index or branch moved.
#[tokio::test]
async fn a_branch_diff_is_the_whole_tree_against_the_merge_base() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    // Its own directory: nextest runs this beside the test above.
    let dir = std::path::PathBuf::from("/tmp").join("yt-brd");
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: dir.clone(),
    })?;
    let commit = "git -c user.name=t -c user.email=t@example.com commit -q";
    fixture.run(&format!(
        "mkdir -p {BRANCH_REPO} && cd {BRANCH_REPO} && git init -q \
         && printf 'zero\\n' > zero.txt && git add zero.txt && {commit} -m zero \
         && printf 'one\\n' > keep.txt && seq 1 40 > old-name.txt \
         && git add keep.txt old-name.txt && {commit} -m one"
    ))?;
    let workspace = Workspace {
        name: "brd".to_owned(),
        machine: "fixture".to_owned(),
        repo: BRANCH_REPO.into(),
        startup: None,
    };
    let place = thread::open(&ssh, &workspace).await?;
    let wt = place.worktree.clone();

    fixture.run(&format!(
        "cd {wt} && printf 'two\\n' >> keep.txt && git add keep.txt && {commit} -m two \
         && mv old-name.txt new-name.txt && printf 'a\\000b\\000c' > blob.bin"
    ))?;
    fixture.run(&format!(
        "cd {BRANCH_REPO} && printf 'main\\n' > main-only.txt && git add main-only.txt \
         && {commit} -m main"
    ))?;
    fixture.run(&format!(
        "git -C {BRANCH_REPO} config diff.renames false \
         && git -C {BRANCH_REPO} config diff.noprefix true \
         && git -C {BRANCH_REPO} config color.ui always \
         && git -C {BRANCH_REPO} config core.quotePath true \
         && git -C {BRANCH_REPO} config diff.external /bin/false"
    ))?;
    let state = format!(
        "git -C {wt} status --porcelain && git -C {wt} ls-files --stage \
         && git -C {BRANCH_REPO} for-each-ref --format='%(refname) %(objectname)' refs/heads"
    );
    let before = fixture.run(&state)?;

    let diff = checkpoint::branch(&ssh, &place).await?;
    assert_eq!(fixture.run(&state)?, before, "no index or branch moved");
    assert_eq!(
        diff.base,
        fixture
            .run(&format!(
                "git -C {BRANCH_REPO} merge-base {} HEAD",
                place.branch
            ))?
            .trim()
    );
    let file = |path: &str| diff.files.iter().find(|file| file.path == path);
    let renamed = file("new-name.txt").expect("the rename");
    assert_eq!(renamed.from.as_deref(), Some("old-name.txt"));
    let blob = file("blob.bin").expect("the untracked binary");
    assert_eq!((blob.added, blob.deleted), (None, None));
    let keep = file("keep.txt").expect("the committed change");
    assert_eq!((keep.added, keep.deleted), (Some(1), Some(0)));
    assert!(
        file("main-only.txt").is_none(),
        "main's own commit is not the thread's"
    );
    assert_eq!(diff.files.len(), 3, "{:?}", diff.files);
    assert!(!diff.files_truncated);
    assert!(!diff.diff.truncated);
    let unified = &diff.diff.unified;
    assert!(
        unified.contains("diff --git a/keep.txt b/keep.txt"),
        "{unified}"
    );
    assert!(unified.contains("+two"), "{unified}");
    assert!(unified.contains("rename from old-name.txt"), "{unified}");
    assert!(unified.contains("Binary files"), "{unified}");
    assert!(!unified.contains("main-only.txt"), "{unified}");
    assert!(!unified.contains('\x1b'), "no colour");

    // Y-543: the main checkout on an older branch does not move the base.
    fixture.run(&format!(
        "cd {BRANCH_REPO} && git checkout -q -b older \"$(git rev-list --max-parents=0 HEAD)\""
    ))?;
    let older = checkpoint::branch(&ssh, &place).await?;
    assert_eq!(older.base, diff.base, "the thread's start still bounds it");
    assert_eq!(older.files, diff.files);

    // Y-543: an untracked file is read from the worktree, and no blob is written.
    fixture.run(&format!(
        "cd {wt} && printf 'y543-only-here\\n' > fresh.txt"
    ))?;
    let objects = format!(
        "cd {wt} && for f in fresh.txt blob.bin; do \
         git cat-file -e \"$(git hash-object \"$f\")\" 2>/dev/null && echo \"$f\"; done; true"
    );
    let fresh = checkpoint::branch(&ssh, &place).await?;
    let listed = fresh
        .files
        .iter()
        .find(|file| file.path == "fresh.txt")
        .expect("the untracked file");
    assert_eq!((listed.added, listed.deleted), (Some(1), Some(0)));
    assert!(fresh.diff.unified.contains("+y543-only-here"));
    assert_eq!(fixture.run(&objects)?.trim(), "", "no blob was written");
    fixture.run(&format!("rm {wt}/fresh.txt"))?;

    // A diff past the cap is cut, and its file is still listed whole.
    fixture.run(&format!("cd {wt} && seq 1 60000 > big.txt"))?;
    let big = checkpoint::branch(&ssh, &place).await?;
    assert!(big.diff.truncated);
    assert!(big.diff.unified.len() <= checkpoint::LIMIT);
    assert!(!big.files_truncated);
    let listed = big
        .files
        .iter()
        .find(|file| file.path == "big.txt")
        .expect("the big file");
    assert_eq!((listed.added, listed.deleted), (Some(60_000), Some(0)));

    // Y-543: git's own error passes alone; only no shared commit adds a line.
    let bogus = thread::Place {
        base: "0".repeat(40),
        ..place.clone()
    };
    fixture.run(&format!(
        "cd {BRANCH_REPO} && git checkout -q --orphan lone"
    ))?;
    let refused = checkpoint::branch(&ssh, &bogus).await;
    assert!(
        matches!(&refused, Err(Error::Git { stderr })
            if stderr.starts_with("fatal:") && stderr.lines().count() == 1),
        "git's line alone: {refused:?}"
    );
    let lone = fixture.run(&format!(
        "cd {BRANCH_REPO} && {commit} -m lone && git rev-parse HEAD"
    ))?;
    let unrelated = thread::Place {
        base: lone.trim().to_owned(),
        ..place.clone()
    };
    assert!(matches!(
        checkpoint::branch(&ssh, &unrelated).await,
        Err(Error::Git { stderr })
            if stderr == "fatal: the thread shares no commit with its start or HEAD"
    ));

    // A diff git cannot read is a failure, not an empty diff.
    fixture.run(&format!(
        "cd {wt} && h=$(git rev-parse {}:keep.txt) \
         && rm \"$(git rev-parse --git-common-dir)/objects/$(echo $h | cut -c1-2)/$(echo $h | cut -c3-)\"",
        diff.base
    ))?;
    assert!(matches!(
        checkpoint::branch(&ssh, &place).await,
        Err(Error::Git { stderr }) if !stderr.is_empty()
    ));
    fixture.run(&format!("rm -rf {wt}"))?;
    assert!(matches!(
        checkpoint::branch(&ssh, &place).await,
        Err(Error::Git { stderr }) if !stderr.is_empty()
    ));

    thread::remove(&ssh, Some(&Tmux::resolve(&ssh).await?), &place).await?;
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}
