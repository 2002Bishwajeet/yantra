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

    assert_eq!(checkpoint::base(&ssh, &place).await?, Some(0));
    assert_eq!(checkpoint::base(&ssh, &place).await?, None, "one baseline");

    fixture.run(&format!(
        "cd {wt} && printf 'two\\n' >> kept.txt && rm gone.txt \
         && printf 'new\\n' > made.txt && mkdir -p deep/er && printf 'x\\n' > deep/er/file.txt"
    ))?;
    assert_eq!(checkpoint::capture(&ssh, &place).await?, 1);

    let diff = checkpoint::diff(&ssh, &place, 1).await?;
    assert!(!diff.truncated);
    for changed in ["kept.txt", "gone.txt", "made.txt", "deep/er/file.txt"] {
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
    let again = checkpoint::diff(&ssh, &place, 1).await?;
    assert!(again.unified.contains("a/again.txt"), "{}", again.unified);
    assert!(!again.unified.contains("made.txt"), "{}", again.unified);

    thread::remove(&ssh, &place).await?;
    assert_eq!(
        fixture.run(&refs)?.trim(),
        "",
        "remove forgets the checkpoints"
    );
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}
