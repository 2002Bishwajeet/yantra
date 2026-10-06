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
fn state_dir(label: &str) -> Result<std::path::PathBuf> {
    let dir = std::path::PathBuf::from("/tmp").join(format!("yx-{label}"));
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

    fixture.run(&format!("echo two > {}/delegated.txt", place.worktree))?;
    let summary = within("a summary", task.summary()).await?;
    // The agent may leave files of its own; the one written here must be named.
    assert!(
        summary.changed.iter().any(|path| path == "delegated.txt"),
        "{summary:?}"
    );
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

    within("removing", task.remove()).await?;
    assert_eq!(
        fixture
            .run(&format!("test -e {} && echo there || true", place.worktree))?
            .trim(),
        ""
    );
    let listed = fixture.run(&format!("git -C {REPO} worktree list"))?;
    assert!(!listed.contains(&place.worktree), "{listed}");
    let branches = fixture.run(&format!("git -C {REPO} branch --list 'yantra/*'"))?;
    assert!(branches.trim().is_empty(), "{branches}");

    drop(task);
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}
