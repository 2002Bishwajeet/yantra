//! Resuming an agent, against a real sshd and a real tmux (§B3).
//!
//! **Every state here is produced rather than described.** The interesting one
//! is a pane that has really been `kill -9`ed: under `remain-on-exit` (I-4) it
//! survives its process, and a test that hand-built that state could not see
//! that only `respawn-pane` can put anything back into it.
//!
//! `claude` is a stub, for the reason `tests/agent.rs` gives — an agent CLI is
//! not one of §B2's four seams. What it records is the argv it was handed, which
//! is how these tests check that the resume flags reached the far side intact.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::resume::{self, Outcome};
use yantra_core::ssh::{Exec, Machine, Ssh};
use yantra_core::tmux::Tmux;
use yantra_core::workspace::Workspace;
use yantra_core::{agent, up};

const REPO: &str = "/tmp/resumerepo";

/// The dialog as `claude` 2.1.220 draws it in an 80-column pane, then held on
/// screen — which is what the agent does, since it is waiting for a keystroke
/// Yantra will never send (ADR-0011).
const TRUST_DIALOG: &str = "printf '%s\\n' \
     ' Quick safety check: Is this a project you created or one you trust? (Like your' \
     ' \u{276f} 1. Yes, I trust this folder' \
     '   2. No, exit'; \
     sleep 300";

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

    /// Answers `auth` and `agents`, records what else it was invoked with, and
    /// then sits there like a TUI — a command that exits at once is I-29's trap.
    async fn install_claude(&self) -> Result<()> {
        let script = "#!/bin/sh\n\
                      if [ \"$1\" = auth ]; then \
                      printf '{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}\\n'; exit 0; fi\n\
                      if [ \"$1\" = agents ]; then cat \"$HOME/.agents.json\"; exit 0; fi\n\
                      printf '%s | %s\\n' \"$PWD\" \"$*\" >> \"$HOME/.argv\"\n\
                      exec sleep 300\n";
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(script);
        self.ssh
            .exec(&format!(
                "mkdir -p ~/.local/bin && printf %s '{b64}' | base64 -d > ~/.local/bin/claude \
                 && chmod 755 ~/.local/bin/claude && printf '[]' > ~/.agents.json && : > ~/.argv"
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

    /// Every invocation of the stub so far, one line of `cwd | argv` each.
    async fn argv(&self) -> Result<Vec<String>> {
        let out = self.ssh.exec("cat ~/.argv").await?;
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::to_owned)
            .collect())
    }

    async fn pane_of(&self, name: &str) -> Result<yantra_core::tmux::Pane> {
        Ok(self
            .tmux
            .pane(&self.ssh, name)
            .await?
            .expect("the session is open"))
    }

    async fn settle(&self) -> Result<()> {
        self.ssh.exec("sleep 1").await?;
        Ok(())
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The launch a resume produced, or `None` when it started nothing.
fn launched(outcome: Outcome) -> Option<agent::Launch> {
    match outcome {
        Outcome::Resumed(launch) => Some(launch),
        Outcome::AlreadyRunning => None,
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

/// A workspace whose agent has never run has no session either, so `resume`
/// opens one — and the agent still starts with the resume flags, because
/// nothing on the near side can tell whether the far side has a conversation
/// to continue (`--continue` in a fresh directory starts one and exits 0).
#[tokio::test]
async fn a_workspace_with_no_session_gets_one_with_the_agent_continuing_in_it() -> Result<()> {
    let Some(lab) = Lab::start("resume-none").await? else {
        return Ok(());
    };
    let ws = workspace("resumenone");

    let outcome = resume::of(&lab.ssh, &lab.tmux, &ws).await?;
    lab.settle().await?;

    let launch = launched(outcome).expect("a workspace with no session must be resumed");
    let argv = lab.argv().await?;
    assert_eq!(argv.len(), 1, "exactly one agent was started: {argv:?}");
    assert_eq!(
        argv[0],
        format!(
            "{REPO} | --continue --fork-session --session-id {}",
            launch.session_id
        ),
        "the flags and the id Yantra chose reach the far side intact"
    );

    lab.tmux.kill(&lab.ssh, &ws.name).await?;
    Ok(())
}

/// **The state this verb exists for, produced with a real `kill -9`.** The pane
/// outlives its process under `remain-on-exit`, so the agent goes back into the
/// pane it died in — never into a second session (I-29).
#[tokio::test]
async fn an_agent_killed_mid_session_is_restarted_in_the_pane_it_died_in() -> Result<()> {
    let Some(lab) = Lab::start("resume-killed").await? else {
        return Ok(());
    };
    let ws = workspace("resumekilled");

    let first = agent::prepare(&lab.ssh, REPO).await?;
    up::open(&lab.ssh, &lab.tmux, &ws, Some(&first.command)).await?;
    lab.settle().await?;

    let before = lab.pane_of(&ws.name).await?;
    let pid = before.pid.expect("a live pane has a process");
    lab.ssh.exec(&format!("kill -9 {pid}")).await?;
    lab.settle().await?;
    assert!(
        lab.pane_of(&ws.name).await?.dead,
        "the precondition is a really dead pane, which is what makes respawn the only way back"
    );

    let outcome = resume::of(&lab.ssh, &lab.tmux, &ws).await?;
    lab.settle().await?;

    let second = launched(outcome).expect("a killed agent has a conversation to continue");
    assert_ne!(
        first.session_id, second.session_id,
        "the fork runs under a fresh id, so the transcript path stays Yantra's to predict"
    );

    let after = lab.pane_of(&ws.name).await?;
    assert_eq!(after.id, before.id, "the same pane, respawned");
    assert!(!after.dead, "and it has a process in it again");
    assert_eq!(
        lab.tmux.list(&lab.ssh).await?.len(),
        1,
        "resuming must never leave a second session behind"
    );

    let argv = lab.argv().await?;
    assert_eq!(argv.len(), 2, "one launch and one resume: {argv:?}");
    assert_eq!(
        argv[0],
        format!("{REPO} | --session-id {}", first.session_id)
    );
    assert_eq!(
        argv[1],
        format!(
            "{REPO} | --continue --fork-session --session-id {}",
            second.session_id
        ),
        "only the second invocation carries the resume flags"
    );

    lab.tmux.kill(&lab.ssh, &ws.name).await?;
    Ok(())
}

/// §B4's idempotency, one verb along. An agent that is already working has
/// nothing to continue, and a second one in its pane would kill it.
#[tokio::test]
async fn resuming_a_running_agent_leaves_it_exactly_where_it_was() -> Result<()> {
    let Some(lab) = Lab::start("resume-running").await? else {
        return Ok(());
    };
    let ws = workspace("resumerunning");
    lab.registry(Some(REPO)).await?;

    let launch = agent::prepare(&lab.ssh, REPO).await?;
    up::open(&lab.ssh, &lab.tmux, &ws, Some(&launch.command)).await?;
    lab.settle().await?;
    let before = lab.pane_of(&ws.name).await?;

    assert_eq!(
        resume::of(&lab.ssh, &lab.tmux, &ws).await?,
        Outcome::AlreadyRunning
    );
    lab.settle().await?;

    let after = lab.pane_of(&ws.name).await?;
    assert_eq!(
        after.pid, before.pid,
        "the running agent keeps its process — a respawn would have changed it"
    );
    assert_eq!(
        lab.argv().await?.len(),
        1,
        "no second agent was started in that pane"
    );

    lab.tmux.kill(&lab.ssh, &ws.name).await?;
    Ok(())
}

/// **I-49, produced.** An agent holding at the trust dialog has said nothing
/// there is to continue, and ADR-0011 means Yantra cannot answer the dialog for
/// it — so this is a refusal, and the pane is left untouched for the human.
#[tokio::test]
async fn an_agent_waiting_at_the_trust_prompt_is_refused_and_left_alone() -> Result<()> {
    let Some(lab) = Lab::start("resume-trust").await? else {
        return Ok(());
    };
    let ws = workspace("resumetrust");
    lab.registry(None).await?;
    lab.tmux
        .ensure(&lab.ssh, &ws.name, REPO, Some(TRUST_DIALOG))
        .await?;
    lab.settle().await?;
    let before = lab.pane_of(&ws.name).await?;

    let err = resume::of(&lab.ssh, &lab.tmux, &ws)
        .await
        .expect_err("an agent at the trust dialog cannot be resumed");
    assert!(
        matches!(err, resume::Error::AwaitingTrust { .. }),
        "{err:?}"
    );

    let after = lab.pane_of(&ws.name).await?;
    assert_eq!(
        after.pid, before.pid,
        "the dialog is still waiting for the same process, not a replacement"
    );
    assert!(
        lab.argv().await?.is_empty(),
        "a refusal must not have started an agent"
    );

    lab.tmux.kill(&lab.ssh, &ws.name).await?;
    Ok(())
}

/// **Y-081's refusal, on the path that does not go through `up::open`.** A
/// respawn reaches tmux directly, so without the same check `resume` would put
/// `cd '<gone>' && exec claude …` into the pane, watch the `cd` fail, and report
/// success for an agent that never started.
///
/// The assertion that matters is the one about what did *not* happen: the pane
/// is still dead afterwards. An implementation that refused *after* respawning
/// would pass on the error type alone.
#[tokio::test]
async fn a_repo_that_is_gone_is_refused_before_the_pane_is_respawned() -> Result<()> {
    let Some(lab) = Lab::start("resume-norepo").await? else {
        return Ok(());
    };
    let ws = workspace("resumenorepo");

    let first = agent::prepare(&lab.ssh, REPO).await?;
    up::open(&lab.ssh, &lab.tmux, &ws, Some(&first.command)).await?;
    lab.settle().await?;

    let before = lab.pane_of(&ws.name).await?;
    let pid = before.pid.expect("a live pane has a process");
    lab.ssh.exec(&format!("kill -9 {pid}")).await?;
    lab.ssh.exec(&format!("rm -rf {REPO}")).await?;
    lab.settle().await?;

    let err = resume::of(&lab.ssh, &lab.tmux, &ws)
        .await
        .expect_err("a repo the machine no longer has cannot be resumed into");
    assert!(
        matches!(err, resume::Error::Up(up::Error::NoRepo { .. })),
        "{err:?}"
    );

    let after = lab.pane_of(&ws.name).await?;
    assert_eq!(after.id, before.id, "the same pane");
    assert!(
        after.dead,
        "the refusal happened before the respawn — a pane with a process in it \
         means the agent was started into a directory that is not there"
    );
    assert_eq!(
        lab.argv().await?.len(),
        1,
        "only the original launch ever ran"
    );

    // The same refusal on the other path: with no session at all, `resume` goes
    // through `up::open`, and the two verbs have to agree.
    lab.tmux.kill(&lab.ssh, &ws.name).await?;
    let err = resume::of(&lab.ssh, &lab.tmux, &ws)
        .await
        .expect_err("opening into a missing repo is refused too");
    assert!(
        matches!(err, resume::Error::Up(up::Error::NoRepo { .. })),
        "{err:?}"
    );
    assert!(
        lab.tmux.list(&lab.ssh).await?.is_empty(),
        "and it left no session behind"
    );
    Ok(())
}

/// R-2's shape: something is alive in that pane and `claude` knows of no agent
/// in that directory. Respawning would destroy it to find out what it was.
#[tokio::test]
async fn a_live_pane_the_registry_does_not_know_about_is_never_respawned() -> Result<()> {
    let Some(lab) = Lab::start("resume-ghost").await? else {
        return Ok(());
    };
    let ws = workspace("resumeghost");
    lab.registry(None).await?;
    lab.tmux
        .ensure(&lab.ssh, &ws.name, REPO, Some("sleep 300"))
        .await?;
    lab.settle().await?;
    let before = lab.pane_of(&ws.name).await?;

    let err = resume::of(&lab.ssh, &lab.tmux, &ws)
        .await
        .expect_err("a pane with something unknown in it is not resumable");
    assert!(matches!(err, resume::Error::Unclear { .. }), "{err:?}");
    assert!(
        err.to_string().contains("knows of no agent"),
        "the refusal has to carry the reason: {err}"
    );

    assert_eq!(
        lab.pane_of(&ws.name).await?.pid,
        before.pid,
        "whatever was in that pane is still in it"
    );

    lab.tmux.kill(&lab.ssh, &ws.name).await?;
    Ok(())
}

/// I-26 on the path that reaches a shell as an argument. The unit test can only
/// check the shape of the quoting; a real `/bin/sh` is what settles it, and the
/// resume flags sit between the binary and the payload.
#[tokio::test]
async fn a_hostile_repo_path_never_executes_when_resuming() -> Result<()> {
    let Some(lab) = Lab::start("resume-inject").await? else {
        return Ok(());
    };
    lab.ssh.exec("rm -f /tmp/pwned-resume").await?;

    let launch = agent::resume(&lab.ssh, "/tmp/x'; touch /tmp/pwned-resume; '").await?;
    lab.ssh.exec(&launch.command).await?;

    let out = lab
        .ssh
        .exec("test -e /tmp/pwned-resume && echo PWNED || echo clean")
        .await?;
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "clean",
        "the payload in a repo path must stay an argument: {}",
        launch.command
    );
    Ok(())
}
