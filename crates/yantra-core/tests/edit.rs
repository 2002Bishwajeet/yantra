//! The refusal that stops a session being stranded, against a real tmux (§B3).
//!
//! Y-126. Moving a workspace's `machine` while a session is open on the old one
//! leaves that session where `down`, `resume`, `status` and `logs` no longer
//! look, and each of them then reports the absence as **success** (I-30). The
//! refusal is worth exactly as much as its detection, so the detection is
//! exercised against a real tmux rather than described to a fake.
//!
//! **Two of these tests exist to fail against a plausible wrong guard**, the one
//! that asks whether something is *running* rather than whether a session is
//! *there*: a session whose agent has already finished, and one that never held
//! an agent at all. Both are still `down`'s to clean up on the machine the field
//! names, so both strand exactly as a busy one does.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use std::path::PathBuf;
use yantra_core::edit;
use yantra_core::ssh::{Exec, Machine, Ssh};
use yantra_core::tmux::Tmux;
use yantra_core::workspace::Workspace;

const REPO: &str = "/tmp/editrepo";

struct Lab {
    _fixture: SshFixture,
    ssh: Ssh,
    tmux: Tmux,
    dir: PathBuf,
}

impl Lab {
    async fn start(label: &str) -> Result<Option<Self>> {
        let Some(fixture) = SshFixture::start()? else {
            return Ok(None);
        };
        let dir = PathBuf::from("/tmp").join(format!("ya-{label}"));
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
        let lab = Self {
            _fixture: fixture,
            ssh,
            tmux,
            dir,
        };
        lab.ssh.exec(&format!("mkdir -p {REPO}")).await?;
        Ok(Some(lab))
    }

    async fn open(&self, name: &str, startup: &str) -> Result<()> {
        self.tmux
            .ensure(&self.ssh, name, REPO, Some(startup))
            .await?;
        self.ssh.exec("sleep 1").await?;
        Ok(())
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The `machine` here is the one the refusal quotes back, and it is deliberately
/// not the fixture's host: a workspace names an ssh destination, and the message
/// has to say the name the operator wrote.
fn workspace(name: &str) -> Workspace {
    Workspace {
        name: name.to_owned(),
        machine: "a-machine".to_owned(),
        repo: PathBuf::from(REPO),
        startup: None,
    }
}

/// The case the task is about: something is running there, and moving the field
/// would leave it running there with nothing pointing at it any more.
#[tokio::test]
async fn a_machine_still_holding_the_session_refuses_the_move() -> Result<()> {
    let Some(lab) = Lab::start("edit-busy").await? else {
        return Ok(());
    };
    lab.open("editbusy", "sleep 300").await?;

    let refused = edit::ensure_free(&lab.ssh, &lab.tmux, &workspace("editbusy"))
        .await
        .expect_err("a session is open on that machine");

    assert!(
        matches!(refused, edit::Error::SessionOpen { .. }),
        "{refused:?}"
    );
    // The operator has to be able to act on it: the message names the workspace,
    // the machine it may not leave, and the command that ends the refusal.
    let said = refused.to_string();
    assert!(said.contains("editbusy"), "{said}");
    assert!(said.contains("a-machine"), "{said}");
    assert!(said.contains("yantra down editbusy"), "{said}");
    Ok(())
}

/// **The test a liveness check fails.** The agent exited an hour ago, so nothing
/// is *running* — and the session is still there, still holding a dead pane
/// (I-4), and still `down`'s to clean up on the machine the field names. Moving
/// the field now would leave it behind exactly as a busy one.
#[tokio::test]
async fn a_session_whose_process_already_died_still_refuses_the_move() -> Result<()> {
    let Some(lab) = Lab::start("edit-dead").await? else {
        return Ok(());
    };
    lab.open("editdead", "exit 7").await?;

    let pane = lab
        .tmux
        .pane(&lab.ssh, "editdead")
        .await?
        .expect("the session outlives the process it held");
    assert!(pane.dead, "the premise: nothing is running in it any more");

    let refused = edit::ensure_free(&lab.ssh, &lab.tmux, &workspace("editdead"))
        .await
        .expect_err("a dead pane is still a session to be stranded");

    assert!(
        matches!(refused, edit::Error::SessionOpen { .. }),
        "{refused:?}"
    );
    Ok(())
}

/// **The second test a liveness check fails**, and a different shape from the
/// one above: a session opened as a plain shell never held an agent at all, so
/// every source that could report one says no. It is still a session.
#[tokio::test]
async fn a_session_that_never_held_an_agent_still_refuses_the_move() -> Result<()> {
    let Some(lab) = Lab::start("edit-shell").await? else {
        return Ok(());
    };
    lab.tmux.ensure(&lab.ssh, "editshell", REPO, None).await?;
    lab.ssh.exec("sleep 1").await?;

    let refused = edit::ensure_free(&lab.ssh, &lab.tmux, &workspace("editshell"))
        .await
        .expect_err("a shell session strands as readily as an agent one");

    assert!(
        matches!(refused, edit::Error::SessionOpen { .. }),
        "{refused:?}"
    );
    Ok(())
}

/// The other half of the contract, and the one that keeps the refusal from being
/// a blanket ban: a machine holding no such session lets the move through.
#[tokio::test]
async fn a_machine_holding_no_such_session_allows_the_move() -> Result<()> {
    let Some(lab) = Lab::start("edit-free").await? else {
        return Ok(());
    };
    // Another session is open, so tmux has a server to answer from and the
    // question really is *this* session rather than *any*.
    lab.open("editother", "sleep 300").await?;

    edit::ensure_free(&lab.ssh, &lab.tmux, &workspace("editfree"))
        .await
        .expect("nothing of this workspace's is running there");
    Ok(())
}

/// R-23. An unreachable machine can be holding the session just as well as a
/// reachable one, and a check that cannot know must never answer *yes, safe*.
/// The port is closed rather than filtered, so this costs a refused connection
/// and not a `ConnectTimeout`.
#[tokio::test]
async fn a_machine_that_cannot_be_asked_refuses_rather_than_allowing() -> Result<()> {
    let Some(lab) = Lab::start("edit-unreachable").await? else {
        return Ok(());
    };
    let closed = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = closed.local_addr()?.port();
    drop(closed);

    let nowhere = Ssh::new(Machine {
        host: "127.0.0.1".to_owned(),
        user: Some(USER.to_owned()),
        port: Some(port),
        identity: Some(lab._fixture.key_path()),
        state_dir: lab.dir.join("unreachable"),
    })?;

    let refused = edit::ensure_free(&nowhere, &lab.tmux, &workspace("editgone"))
        .await
        .expect_err("nothing was established, so nothing may be allowed");

    assert!(
        matches!(refused, edit::Error::CannotTell { .. }),
        "an unreachable machine must not read as an empty one: {refused:?}"
    );
    Ok(())
}
