//! M1's definition of done, against a real machine.
//!
//! `up` twice must attach rather than duplicate. Everything else in the
//! milestone exists to make this one assertion trustworthy.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::ssh::{Exec, Machine, Ssh};
use yantra_core::tmux::Tmux;
use yantra_core::up;
use yantra_core::workspace::Workspace;

struct Lab {
    _fixture: SshFixture,
    ssh: Ssh,
    tmux: Tmux,
    dir: std::path::PathBuf,
}

impl Lab {
    async fn start(label: &str) -> Result<Option<Self>> {
        let Some(fixture) = SshFixture::start()? else {
            return Ok(None);
        };
        let dir = std::path::PathBuf::from("/tmp").join(format!("yu-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let ssh = Ssh::new(Machine {
            host: fixture.host().to_owned(),
            user: Some(USER.to_owned()),
            port: Some(fixture.port()),
            identity: Some(fixture.key_path()),
            state_dir: dir.clone(),
        })?;
        let tmux = Tmux::resolve(&ssh).await?;
        Ok(Some(Self {
            _fixture: fixture,
            ssh,
            tmux,
            dir,
        }))
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn workspace(name: &str, startup: Option<&str>) -> Workspace {
    Workspace {
        name: name.to_owned(),
        machine: "fixture".to_owned(),
        repo: std::path::PathBuf::from("/tmp"),
        branch: None,
        startup: startup.map(str::to_owned),
    }
}

/// The milestone, in one test.
#[tokio::test]
async fn up_twice_attaches_and_does_not_duplicate() -> Result<()> {
    let Some(lab) = Lab::start("skeleton").await? else {
        return Ok(());
    };
    let ws = workspace("skeleton", None);

    let first = up::open(&lab.ssh, &lab.tmux, &ws).await?;
    assert!(first.was_created(), "the first up opens the session");

    let second = up::open(&lab.ssh, &lab.tmux, &ws).await?;
    assert!(
        !second.was_created(),
        "the second up attaches — this is the whole point of M1"
    );
    assert_eq!(
        first.session().session_id,
        second.session().session_id,
        "and it is the same session"
    );

    let out = lab
        .ssh
        .exec("tmux list-sessions -F '#{session_name}' | grep -c '^skeleton$'")
        .await?;
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "1",
        "exactly one session exists on the machine"
    );

    lab.tmux.kill(&lab.ssh, "skeleton").await?;
    Ok(())
}

/// The startup command must run, and must survive a second `up` without being
/// run again — re-running it would defeat the point of attaching.
#[tokio::test]
async fn startup_runs_once_and_is_not_repeated() -> Result<()> {
    let Some(lab) = Lab::start("startup").await? else {
        return Ok(());
    };
    lab.ssh.exec("rm -f /tmp/ran.log").await?;
    let ws = workspace("startup", Some("echo ran >> /tmp/ran.log; sleep 30"));

    up::open(&lab.ssh, &lab.tmux, &ws).await?;
    lab.ssh.exec("sleep 1").await?;
    let again = up::open(&lab.ssh, &lab.tmux, &ws).await?;
    assert!(!again.was_created(), "the second open attaches");
    lab.ssh.exec("sleep 1").await?;

    let out = lab.ssh.exec("wc -l < /tmp/ran.log").await?;
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "1",
        "the startup command ran exactly once across two ups"
    );

    lab.tmux.kill(&lab.ssh, "startup").await?;
    Ok(())
}

/// The session opens in the workspace's repo, on the machine — the reason any
/// of this exists.
#[tokio::test]
async fn the_session_opens_in_the_workspace_repo() -> Result<()> {
    let Some(lab) = Lab::start("repo").await? else {
        return Ok(());
    };
    lab.ssh.exec("mkdir -p /tmp/somerepo").await?;
    let mut ws = workspace("repo", None);
    ws.repo = std::path::PathBuf::from("/tmp/somerepo");

    let opened = up::open(&lab.ssh, &lab.tmux, &ws).await?;
    let out = lab
        .ssh
        .exec(&format!(
            "tmux display-message -p -t '{}' '#{{pane_current_path}}'",
            opened.session().pane_id
        ))
        .await?;
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "/tmp/somerepo");

    lab.tmux.kill(&lab.ssh, "repo").await?;
    Ok(())
}
