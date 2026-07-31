//! Telling how an agent ended, against a real tmux (§B3).
//!
//! The endings here are produced rather than described: a pane really exits 0,
//! really exits 143, and really takes a `kill -9`. That matters more than usual
//! for this module, because the trap it exists for — an empty
//! `pane_dead_status` after a signal — is invisible to any test that builds the
//! pane state by hand.
//!
//! `claude agents --json` comes from a stub, whose shape was copied from
//! executed 2.1.220. See `tests/agent.rs` for what that does and does not prove.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::ssh::{Exec, Machine, Ssh};
use yantra_core::status::{self, Verdict};
use yantra_core::tmux::Tmux;
use yantra_core::workspace::Workspace;

const REPO: &str = "/tmp/statusrepo";

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
        lab.install_claude().await?;
        lab.ssh.exec(&format!("mkdir -p {REPO}")).await?;
        Ok(Some(lab))
    }

    /// A stub whose `agents --json` answers with whatever [`Self::registry`]
    /// last wrote, so a test can put the two sources in agreement or not.
    async fn install_claude(&self) -> Result<()> {
        let script = "#!/bin/sh\n\
                      if [ \"$1\" = agents ]; then cat \"$HOME/.agents.json\"; exit 0; fi\n\
                      if [ \"$1\" = auth ]; then \
                      printf '{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}\\n'; exit 0; fi\n\
                      exec sleep 300\n";
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(script);
        self.ssh
            .exec(&format!(
                "mkdir -p ~/.local/bin && printf %s '{b64}' | base64 -d > ~/.local/bin/claude \
                 && chmod 755 ~/.local/bin/claude && printf '[]' > ~/.agents.json"
            ))
            .await?;
        Ok(())
    }

    /// What `claude agents --json` will say next. The real shape, from 2.1.220.
    async fn registry(&self, running_in: Option<&str>) -> Result<()> {
        let json = match running_in {
            Some(cwd) => format!(
                r#"[{{"pid":4242,"cwd":"{cwd}","kind":"cli","startedAt":"2026-07-31T09:00:00.000Z","sessionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","name":"agent","status":"running"}}]"#
            ),
            None => "[]".to_owned(),
        };
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&json);
        self.ssh
            .exec(&format!("printf %s '{b64}' | base64 -d > ~/.agents.json"))
            .await?;
        Ok(())
    }

    /// Opens the session and leaves its pane running `startup`.
    async fn open(&self, name: &str, startup: &str) -> Result<()> {
        self.tmux
            .ensure(&self.ssh, name, REPO, Some(startup))
            .await?;
        self.ssh.exec("sleep 1").await?;
        Ok(())
    }

    async fn verdict(&self, name: &str) -> Result<Verdict> {
        let report = status::of(&self.ssh, &self.tmux, workspace(name)).await?;
        Ok(report.verdict)
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

#[tokio::test]
async fn a_workspace_with_no_session_is_not_a_crash() -> Result<()> {
    let Some(lab) = Lab::start("status-none").await? else {
        return Ok(());
    };
    assert_eq!(lab.verdict("statusnone").await?, Verdict::NoSession);
    Ok(())
}

/// Both sources agree: the pane is alive and `claude` claims an agent in that
/// directory.
#[tokio::test]
async fn a_live_pane_backed_by_the_registry_is_running() -> Result<()> {
    let Some(lab) = Lab::start("status-run").await? else {
        return Ok(());
    };
    lab.registry(Some(REPO)).await?;
    lab.open("statusrun", "sleep 300").await?;

    assert_eq!(lab.verdict("statusrun").await?, Verdict::Running);
    lab.tmux.kill(&lab.ssh, "statusrun").await?;
    Ok(())
}

/// **R-2's shape, and the reason two sources are read.** The pane is alive, so
/// anything watching only tmux calls this healthy — while `claude` knows of no
/// agent in that directory at all.
#[tokio::test]
async fn a_live_pane_the_registry_does_not_know_about_is_never_called_running() -> Result<()> {
    let Some(lab) = Lab::start("status-ghost").await? else {
        return Ok(());
    };
    lab.registry(None).await?;
    lab.open("statusghost", "sleep 300").await?;

    let verdict = lab.verdict("statusghost").await?;
    assert!(matches!(verdict, Verdict::Unclear { .. }), "{verdict:?}");
    assert!(!verdict.is_running());
    lab.tmux.kill(&lab.ssh, "statusghost").await?;
    Ok(())
}

/// Exited of its own accord, three ways, told apart by the number.
#[tokio::test]
async fn the_endings_a_pane_reports_itself_are_told_apart() -> Result<()> {
    let Some(lab) = Lab::start("status-exits").await? else {
        return Ok(());
    };
    lab.registry(None).await?;

    for (startup, expected) in [
        ("exit 0", Verdict::Finished),
        ("exit 143", Verdict::Stopped),
        ("exit 1", Verdict::Crashed { status: 1 }),
    ] {
        let name = format!("s{}", startup.replace(' ', ""));
        lab.open(&name, startup).await?;
        assert_eq!(lab.verdict(&name).await?, expected, "after `{startup}`");
        lab.tmux.kill(&lab.ssh, &name).await?;
    }
    Ok(())
}

/// **The trap this module exists for, produced rather than described.** tmux
/// leaves `pane_dead_status` *empty* when a signal did the killing, so anything
/// that reads that field and defaults it to zero reports a `kill -9` as a clean
/// finish — R-2 arriving through tmux instead of through the agent.
#[tokio::test]
async fn a_signal_killed_agent_is_never_reported_as_finished() -> Result<()> {
    let Some(lab) = Lab::start("status-killed").await? else {
        return Ok(());
    };
    lab.registry(Some(REPO)).await?;
    lab.open("statuskilled", "sleep 300").await?;

    let pane = lab
        .tmux
        .pane(&lab.ssh, "statuskilled")
        .await?
        .expect("the session is open");
    let pid = pane.pid.expect("a live pane has a process");
    // The registry keeps claiming the agent is up, which is the other half of
    // the trap: a stale second source must not rescue a dead first one.
    lab.ssh.exec(&format!("kill -9 {pid}")).await?;
    lab.ssh.exec("sleep 1").await?;

    let verdict = lab.verdict("statuskilled").await?;
    assert_eq!(
        verdict,
        Verdict::Killed {
            signal: "KILL".to_owned()
        },
        "{verdict:?}"
    );
    assert_ne!(
        verdict,
        Verdict::Finished,
        "an empty pane_dead_status must never be read as exit 0"
    );

    lab.tmux.kill(&lab.ssh, "statuskilled").await?;
    Ok(())
}

/// A machine with no `claude` at all still gets an answer from the pane —
/// a missing second opinion is not a contradiction.
#[tokio::test]
async fn a_machine_without_claude_is_still_answered_from_the_pane() -> Result<()> {
    let Some(lab) = Lab::start("status-noclaude").await? else {
        return Ok(());
    };
    lab.ssh.exec("rm -f ~/.local/bin/claude").await?;
    lab.open("statusnoclaude", "exit 1").await?;

    assert_eq!(
        lab.verdict("statusnoclaude").await?,
        Verdict::Crashed { status: 1 }
    );
    lab.tmux.kill(&lab.ssh, "statusnoclaude").await?;
    Ok(())
}
