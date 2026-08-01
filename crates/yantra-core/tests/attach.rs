//! `attach` against a real tmux (§B3).
//!
//! The half worth proving on a real machine is the **refusal**: `attach` must
//! never create, so a workspace with no session has to come back as an error
//! rather than as a session that did not exist a moment ago.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::attach;
use yantra_core::ssh::{Exec, Machine, Ssh};
use yantra_core::tmux::Tmux;
use yantra_core::workspace::Workspace;

const REPO: &str = "/tmp/attachrepo";

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
        let dir = std::path::PathBuf::from("/tmp").join(format!("ya-{label}"));
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
        ssh.exec(&format!("mkdir -p {REPO}")).await?;
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

fn workspace(name: &str) -> Workspace {
    Workspace {
        name: name.to_owned(),
        machine: "fixture".to_owned(),
        repo: std::path::PathBuf::from(REPO),
        startup: None,
    }
}

/// The whole point of the verb being separate from `up`: it does not open.
#[tokio::test]
async fn a_workspace_with_no_session_is_refused_and_none_is_created() -> Result<()> {
    let Some(lab) = Lab::start("attach-none").await? else {
        return Ok(());
    };
    let ws = workspace("attachnone");

    let err = attach::ensure_session(&lab.ssh, &lab.tmux, &ws)
        .await
        .expect_err("there is nothing to attach to");
    assert!(matches!(err, attach::Error::NoSession { .. }), "{err:?}");
    assert!(
        err.to_string().contains("fixture"),
        "the machine that was looked at is the useful half: {err}"
    );
    assert!(
        lab.tmux.list(&lab.ssh).await?.is_empty(),
        "and asking must not have created one"
    );
    Ok(())
}

/// Y-081 left a live session with no way back to it: `up` refuses a workspace
/// whose `repo` has since been deleted, and that refusal is deliberate. `attach`
/// is the way in, so it must not inherit the check.
#[tokio::test]
async fn a_session_whose_repo_is_gone_is_still_reachable() -> Result<()> {
    let Some(lab) = Lab::start("attach-norepo").await? else {
        return Ok(());
    };
    let ws = workspace("attachnorepo");
    lab.tmux
        .ensure(&lab.ssh, &ws.name, REPO, Some("sleep 300"))
        .await?;
    lab.ssh.exec(&format!("rm -rf {REPO}")).await?;

    attach::ensure_session(&lab.ssh, &lab.tmux, &ws)
        .await
        .expect("a live session is reachable even with its repo deleted");

    lab.tmux.kill(&lab.ssh, &ws.name).await?;
    Ok(())
}
