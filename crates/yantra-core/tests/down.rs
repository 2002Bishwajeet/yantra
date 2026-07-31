//! Stopping a session against a real tmux (§B3).
//!
//! The interesting assertions are about *ordering*: the exit status lives in
//! the pane, `kill-session` destroys the pane, so anything `down` wants to
//! report has to be read before it acts. A test that only checked the session
//! was gone would pass against a `down` that threw that away.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::down;
use yantra_core::ssh::{Exec, Machine, Ssh};
use yantra_core::status::Verdict;
use yantra_core::tmux::Tmux;
use yantra_core::workspace::Workspace;

const REPO: &str = "/tmp/downrepo";

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
        let lab = Self {
            _fixture: fixture,
            ssh,
            tmux,
            dir,
        };
        lab.ssh.exec(&format!("mkdir -p {REPO}")).await?;
        lab.install_claude().await?;
        Ok(Some(lab))
    }

    /// The registry claims an agent is in `REPO`, so a live pane reads as
    /// `Running` rather than `Unclear` and the endings below are unambiguous.
    async fn install_claude(&self) -> Result<()> {
        let script = format!(
            "#!/bin/sh\n\
             if [ \"$1\" = agents ]; then \
             printf '[{{\"pid\":1,\"cwd\":\"{REPO}\",\"sessionId\":\"an-id\",\"status\":\"running\"}}]'; \
             exit 0; fi\n\
             exec sleep 300\n"
        );
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&script);
        self.ssh
            .exec(&format!(
                "mkdir -p ~/.local/bin && printf %s '{b64}' | base64 -d > ~/.local/bin/claude \
                 && chmod 755 ~/.local/bin/claude"
            ))
            .await?;
        Ok(())
    }

    async fn open(&self, name: &str, startup: &str) -> Result<()> {
        self.tmux
            .ensure(&self.ssh, name, REPO, Some(startup))
            .await?;
        self.ssh.exec("sleep 1").await?;
        Ok(())
    }

    async fn sessions(&self) -> Result<Vec<String>> {
        Ok(self
            .tmux
            .list(&self.ssh)
            .await?
            .into_iter()
            .map(|s| s.name)
            .collect())
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

/// §B4 from the other end: stopping something that is not running is the state
/// asked for, so it succeeds — but it must not *claim* to have stopped anything.
#[tokio::test]
async fn stopping_what_is_not_running_succeeds_and_says_so() -> Result<()> {
    let Some(lab) = Lab::start("down-absent").await? else {
        return Ok(());
    };

    let report = down::stop(&lab.ssh, &lab.tmux, workspace("downabsent")).await?;
    assert!(!report.stopped, "there was nothing to stop");
    assert_eq!(report.ending, Verdict::NoSession);
    Ok(())
}

/// The task's actual claim, and Y-046's answer: the session is gone, and with
/// it the process inside — which killing the local `ssh` never achieved (I-27).
#[tokio::test]
async fn the_session_and_the_process_in_it_are_both_gone() -> Result<()> {
    let Some(lab) = Lab::start("down-kill").await? else {
        return Ok(());
    };
    lab.open("downkill", "sleep 300").await?;
    let pid = lab
        .tmux
        .pane(&lab.ssh, "downkill")
        .await?
        .expect("the session is open")
        .pid
        .expect("a live pane has a process");

    let report = down::stop(&lab.ssh, &lab.tmux, workspace("downkill")).await?;
    assert!(report.stopped);
    assert!(
        !lab.sessions().await?.contains(&"downkill".to_owned()),
        "the session must be gone"
    );

    let alive = lab
        .ssh
        .exec(&format!(
            "kill -0 {pid} 2>/dev/null && echo alive || echo gone"
        ))
        .await?;
    assert_eq!(
        String::from_utf8_lossy(&alive.stdout).trim(),
        "gone",
        "an orphaned agent is exactly what Y-046 is about"
    );
    Ok(())
}

/// **Why this stacks on Y-063.** The exit status lives in the pane and
/// `kill-session` destroys the pane, so a `down` that killed first would have
/// nothing left to report. A process that handles `SIGTERM` and exits 143 must
/// come back as `Stopped` — the clean ending, distinct from a crash.
#[tokio::test]
async fn a_clean_shutdown_is_reported_before_the_evidence_is_destroyed() -> Result<()> {
    let Some(lab) = Lab::start("down-clean").await? else {
        return Ok(());
    };
    // Stands in for Claude Code's own handler: traps SIGTERM, does its shutdown,
    // exits 128+15. Measured behaviour of 2.1.220, reproduced with `sh`.
    lab.open(
        "downclean",
        "trap 'exit 143' TERM; while :; do sleep 0.2; done",
    )
    .await?;

    let report = down::stop(&lab.ssh, &lab.tmux, workspace("downclean")).await?;
    assert!(report.stopped);
    assert_eq!(
        report.ending,
        Verdict::Stopped,
        "a handled SIGTERM is a clean stop, not a crash"
    );
    assert!(!lab.sessions().await?.contains(&"downclean".to_owned()));
    Ok(())
}

/// An agent that ignores `SIGTERM` must not hang `down` — the session goes
/// regardless, and the report says the shutdown was not a clean one.
#[tokio::test]
async fn an_agent_that_ignores_sigterm_is_still_stopped() -> Result<()> {
    let Some(lab) = Lab::start("down-stubborn").await? else {
        return Ok(());
    };
    lab.open("downstubborn", "trap '' TERM; while :; do sleep 0.2; done")
        .await?;

    let report = down::stop(&lab.ssh, &lab.tmux, workspace("downstubborn")).await?;
    assert!(report.stopped);
    assert_ne!(
        report.ending,
        Verdict::Stopped,
        "it never handled the signal, so nothing of its own ran"
    );
    assert!(
        !lab.sessions().await?.contains(&"downstubborn".to_owned()),
        "and it is stopped anyway"
    );
    Ok(())
}

/// A crash that happened an hour ago is still the answer `down` should give,
/// rather than being overwritten by the act of cleaning up.
#[tokio::test]
async fn a_session_whose_agent_already_crashed_reports_the_crash() -> Result<()> {
    let Some(lab) = Lab::start("down-crashed").await? else {
        return Ok(());
    };
    lab.open("downcrashed", "exit 7").await?;

    let report = down::stop(&lab.ssh, &lab.tmux, workspace("downcrashed")).await?;
    assert!(report.stopped, "the session was still there to clean up");
    assert_eq!(report.ending, Verdict::Crashed { status: 7 });
    assert!(!lab.sessions().await?.contains(&"downcrashed".to_owned()));
    Ok(())
}
