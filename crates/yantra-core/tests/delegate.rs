//! Y-435 against real git and a real `opencode acp`, per §B3. The fixture has
//! no model login, so this proves the worktree, the agent's lifecycle, the diff
//! summary and the cleanup; the unit tests prove what a turn leaves behind.

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

mod common;

use std::future::Future;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use common::{SshFixture, USER};
use yantra_core::acp::Harness;
use yantra_core::delegate::{Error, State, Task};
use yantra_core::ssh::{Exec, Machine, Ssh};

/// opencode's first start fetches its plugins.
const PATIENCE: Duration = Duration::from_secs(120);
const REPO: &str = "/home/yantra/repo";

fn ssh_to(fixture: &SshFixture, state_dir: &std::path::Path) -> Result<Ssh> {
    Ok(Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: state_dir.to_owned(),
    })?)
}

/// Short on purpose: `%C` adds 40 characters and the socket path budget is 90.
/// The pid keeps two runs apart.
fn state_dir(label: &str) -> Result<std::path::PathBuf> {
    let dir = std::path::PathBuf::from("/tmp").join(format!("yx-{label}-{}", std::process::id()));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

async fn within<T, E>(what: &str, step: impl Future<Output = Result<T, E>>) -> Result<T>
where
    E: std::error::Error + Send + Sync + 'static,
{
    Ok(tokio::time::timeout(PATIENCE, step)
        .await
        .with_context(|| format!("{what} took longer than {PATIENCE:?}"))??)
}

async fn until(what: &str, limit: Duration, mut done: impl FnMut() -> Result<bool>) -> Result<()> {
    let start = Instant::now();
    while !done()? {
        if start.elapsed() > limit {
            bail!("{what} did not happen within {limit:?}");
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(())
}

/// No folder, no worktree in git's list and no `yantra/*` branch.
fn left_nothing(fixture: &SshFixture, worktree: &str) -> Result<()> {
    assert_eq!(
        fixture
            .run(&format!("test -e {worktree} && echo there || true"))?
            .trim(),
        ""
    );
    let listed = fixture.run(&format!("git -C {REPO} worktree list"))?;
    assert!(!listed.contains(worktree), "{listed}");
    let branches = fixture.run(&format!("git -C {REPO} branch --list 'yantra/*'"))?;
    assert!(branches.trim().is_empty(), "{branches}");
    Ok(())
}

#[tokio::test]
async fn a_task_works_in_its_own_worktree_and_leaves_nothing_when_removed() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let dir = state_dir("dlg")?;
    let ssh = ssh_to(&fixture, &dir)?;
    let made = ssh
        .exec(&format!(
            "mkdir -p {REPO} && cd {REPO} && git init -q && echo one > README \
             && git add README && git -c user.name=t -c user.email=t@example.com \
             commit -qm one"
        ))
        .await?;
    assert!(made.success(), "{}", String::from_utf8_lossy(&made.stderr));

    let refused = Task::start(ssh.clone(), Harness::Opencode, "/home/yantra", "hi").await;
    assert!(
        matches!(&refused, Err(Error::NotARepo { repo }) if repo == "/home/yantra"),
        "{refused:?}"
    );

    let task = within(
        "starting a task",
        Task::start(ssh.clone(), Harness::Opencode, REPO, "Say hello."),
    )
    .await?;
    let place = task.place().clone();
    assert_eq!(place.repo, REPO);
    assert_eq!(place.branch, format!("yantra/{}", place.id));
    assert_eq!(
        place.worktree,
        format!("/home/yantra/.yantra/worktrees/{}", place.id)
    );
    fixture.run(&format!("test -f {}/README", place.worktree))?;
    let branches = fixture.run(&format!("git -C {REPO} branch --list 'yantra/*'"))?;
    assert!(branches.contains(&place.branch), "{branches}");

    until("the task leaving Starting", PATIENCE, || {
        Ok(task.progress().state != State::Starting)
    })
    .await?;

    // Work the agent commits on its branch must show as much as work it leaves.
    fixture.run(&format!(
        "cd {} && echo two > delegated.txt && echo three > 'committed \u{fc}.md' \
         && git add 'committed \u{fc}.md' \
         && git -c user.name=t -c user.email=t@example.com commit -qm three",
        place.worktree
    ))?;
    let summary = within("a summary", task.summary()).await?;
    // The agent may leave files of its own; the ones written here must be named.
    for written in ["delegated.txt", "committed \u{fc}.md"] {
        assert!(
            summary.changed.iter().any(|path| path == written),
            "{written}: {summary:?}"
        );
    }
    assert!(!summary.shortstat.is_empty(), "{summary:?}");
    assert_eq!(task.progress().summary, Some(summary));

    within("stopping", async {
        task.stop().await;
        Ok::<_, Error>(())
    })
    .await?;
    assert!(task.progress().state.is_terminal(), "{:?}", task.progress());
    until(
        "opencode exiting on the machine",
        Duration::from_secs(30),
        || Ok(fixture.run("pgrep -x opencode || true")?.trim().is_empty()),
    )
    .await?;
    fixture.run(&format!("test -f {}/delegated.txt", place.worktree))?;

    // A folder someone already deleted does not stop the removal.
    fixture.run(&format!("rm -rf {}", place.worktree))?;
    within("removing", task.remove()).await?;
    left_nothing(&fixture, &place.worktree)?;
    drop(task);

    // The fixture has no `codex-acp`, so this agent never starts, and its
    // worktree goes with it. A second removal still succeeds.
    let missing = within(
        "starting a harness the machine lacks",
        Task::start(ssh.clone(), Harness::Codex, REPO, "hi"),
    )
    .await?;
    let worktree = missing.place().worktree.clone();
    until("the worktree being removed", PATIENCE, || {
        Ok(matches!(&missing.progress().state,
            State::Failed(said) if said.ends_with("its worktree and branch were removed")))
    })
    .await?;
    left_nothing(&fixture, &worktree)?;
    within("removing again", missing.remove()).await?;
    left_nothing(&fixture, &worktree)?;

    drop(missing);
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}
