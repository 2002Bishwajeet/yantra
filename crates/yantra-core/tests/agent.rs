//! Launching an agent in a session, against a real sshd and a real tmux (§B3).
//!
//! **The `claude` here is a stub, and that is a deliberate limit of these
//! tests.** Yantra's four seams — SSH, tmux, telemetry, hardware — are the ones
//! §B2 says must be tested against the real thing, and an agent CLI is not one
//! of them; what is under test is Yantra's orchestration, which the container
//! runs for real. The stub's behaviour is not invented either: every shape it
//! emits was copied from `claude` **2.1.220** executed on a real machine, and
//! the negative case is the exact JSON the MacBook produced while I-44 was in
//! force.
//!
//! What that leaves untested is whether the real binary behaves as measured on a
//! day other than today. The reality check for that is a live run, which needs a
//! reachable machine with an authenticated agent on it — blocked on Y-059.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::agent::{self, Claude};
use yantra_core::ssh::{Exec, Machine, Ssh};
use yantra_core::tmux::Tmux;
use yantra_core::up;
use yantra_core::workspace::Workspace;

/// Where Claude Code's own installer puts the binary, and **not** on the
/// non-interactive `PATH` — which is the whole reason [`agent`] carries a
/// candidate list that includes `$HOME` where [`yantra_core::tmux`]'s does not.
const INSTALLED_AT: &str = "/home/yantra/.local/bin/claude";

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
        Ok(Some(Self {
            _fixture: fixture,
            ssh,
            tmux,
            dir,
        }))
    }

    /// Installs the stub agent, logged in or not.
    ///
    /// `auth status` prints its JSON on stdout either way and exits 1 in the
    /// negative case — both measured on 2.1.220, and the reason [`Claude::auth`]
    /// reads the JSON rather than the exit status.
    async fn install_claude(&self, logged_in: bool) -> Result<()> {
        let (flag, method, code) = if logged_in {
            ("true", "claude.ai", 0)
        } else {
            ("false", "none", 1)
        };
        // Records argv and cwd where a test can read them, then sits there like
        // a TUI rather than exiting — a command that exits at once is I-29's
        // trap, and an agent that exited is not what is being tested.
        let script = format!(
            "#!/bin/sh\n\
             if [ \"$1\" = auth ]; then\n\
             \x20 printf '%s\\n' '{{\"loggedIn\":{flag},\"authMethod\":\"{method}\",\
             \"apiProvider\":\"firstParty\",\"email\":\"someone@example.com\"}}'\n\
             \x20 exit {code}\n\
             fi\n\
             id=\n\
             while [ $# -gt 0 ]; do\n\
             \x20 [ \"$1\" = --session-id ] && id=$2\n\
             \x20 shift\n\
             done\n\
             slug=$(printf %s \"$PWD\" | tr -c 'a-zA-Z0-9' '-')\n\
             dir=$HOME/.claude/projects/$slug\n\
             mkdir -p \"$dir\"\n\
             printf '{{\"cwd\":\"%s\",\"sessionId\":\"%s\"}}\\n' \"$PWD\" \"$id\" > \"$dir/$id.jsonl\"\n\
             exec sleep 300\n"
        );

        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&script);
        self.ssh
            .exec(&format!(
                "mkdir -p ~/.local/bin && printf %s '{b64}' | base64 -d > {INSTALLED_AT} \
                 && chmod 755 {INSTALLED_AT}"
            ))
            .await?;
        Ok(())
    }

    /// The transcript the stub wrote, if it wrote one.
    async fn transcript(&self, repo: &str, session_id: &str) -> Result<String> {
        let slug: String = repo
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let out = self
            .ssh
            .exec(&format!(
                "cat ~/.claude/projects/{slug}/{session_id}.jsonl 2>/dev/null || true"
            ))
            .await?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn workspace(name: &str, repo: &str) -> Workspace {
    Workspace {
        name: name.to_owned(),
        machine: "fixture".to_owned(),
        repo: std::path::PathBuf::from(repo),
        startup: None,
    }
}

/// I-34, in the form that motivated `agent`'s own candidate list: the binary is
/// in `$HOME/.local/bin`, which the installer adds to `PATH` by editing a shell
/// rc file that a non-interactive ssh session never reads.
#[tokio::test]
async fn claude_is_found_where_its_installer_puts_it_and_not_on_path() -> Result<()> {
    let Some(lab) = Lab::start("agent-resolve").await? else {
        return Ok(());
    };
    lab.install_claude(true).await?;

    let on_path = lab.ssh.exec("command -v claude || true").await?;
    assert!(
        String::from_utf8_lossy(&on_path.stdout).trim().is_empty(),
        "the precondition is that PATH does not find it — otherwise this test \
         proves nothing about the candidate list"
    );

    let claude = Claude::resolve(&lab.ssh).await?;
    assert_eq!(claude.path(), INSTALLED_AT);
    Ok(())
}

/// The gate that I-44 exists for. A machine whose agent cannot authenticate must
/// be refused **before** anything is opened, or `up` leaves a session that looks
/// healthy and can never do any work.
#[tokio::test]
async fn an_agent_that_cannot_authenticate_is_refused_and_opens_nothing() -> Result<()> {
    let Some(lab) = Lab::start("agent-auth").await? else {
        return Ok(());
    };
    lab.install_claude(false).await?;
    let ws = workspace("agentauth", "/tmp");

    let claude = Claude::resolve(&lab.ssh).await?;
    let auth = claude.auth(&lab.ssh).await?;
    assert!(!auth.logged_in);
    assert_eq!(auth.method, "none");

    let err = agent::prepare(&lab.ssh, "/tmp")
        .await
        .expect_err("an agent that is not logged in cannot be prepared");
    assert!(matches!(err, agent::Error::NotLoggedIn { .. }), "{err:?}");

    // The session must not exist: the check happens before tmux is touched.
    let sessions = lab.tmux.list(&lab.ssh).await?;
    assert!(
        !sessions.iter().any(|s| s.name == ws.name),
        "nothing may be left half-open by a refusal: {sessions:?}"
    );
    Ok(())
}

/// The milestone's claim, one layer down from the CLI: the agent runs, in the
/// workspace's repo, under the session id Yantra chose.
#[tokio::test]
async fn the_agent_runs_in_the_repo_under_the_id_yantra_chose() -> Result<()> {
    let Some(lab) = Lab::start("agent-launch").await? else {
        return Ok(());
    };
    lab.install_claude(true).await?;
    lab.ssh.exec("mkdir -p /tmp/agentrepo").await?;
    let ws = workspace("agentrun", "/tmp/agentrepo");

    let launch = agent::prepare(&lab.ssh, "/tmp/agentrepo").await?;
    let opened = up::open(&lab.ssh, &lab.tmux, &ws, Some(&launch.command)).await?;
    assert!(opened.was_created());
    lab.ssh.exec("sleep 1").await?;

    let transcript = lab.transcript("/tmp/agentrepo", &launch.session_id).await?;
    assert!(
        transcript.contains(&launch.session_id),
        "the id Yantra chose is the one the agent ran under — which is what \
         makes the transcript path predictable: {transcript:?}"
    );
    assert!(
        transcript.contains("/tmp/agentrepo"),
        "and it ran in the workspace's repo, not in $HOME: {transcript:?}"
    );

    // I-4 via I-21: without this a crashed agent would vanish and be
    // indistinguishable from one that finished.
    let remain = lab
        .ssh
        .exec(&format!(
            "{} show-options -w -t '{}' remain-on-exit",
            lab.tmux.path(),
            opened.session().window_id
        ))
        .await?;
    assert!(
        String::from_utf8_lossy(&remain.stdout).contains("on"),
        "remain-on-exit must be set on the window running the agent"
    );

    lab.tmux.kill(&lab.ssh, &ws.name).await?;
    Ok(())
}

/// I-26 on the path that reaches a shell as an argument rather than as a
/// command. A workspace's `repo` comes from a config file, so this is a
/// code-execution boundary; the unit test can only check the *shape* of the
/// quoting, and a real `/bin/sh` is the only thing that can settle it.
#[tokio::test]
async fn a_hostile_repo_path_never_executes_on_the_far_side() -> Result<()> {
    let Some(lab) = Lab::start("agent-inject").await? else {
        return Ok(());
    };
    lab.install_claude(true).await?;
    lab.ssh.exec("rm -f /tmp/pwned").await?;

    let launch = agent::prepare(&lab.ssh, "/tmp/x'; touch /tmp/pwned; '").await?;
    // Runs it directly rather than through tmux: what is under test is the
    // command, and tmux would only add a layer between it and the shell.
    lab.ssh.exec(&launch.command).await?;

    let out = lab
        .ssh
        .exec("test -e /tmp/pwned && echo PWNED || echo clean")
        .await?;
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "clean",
        "the payload in a repo path must stay an argument: {}",
        launch.command
    );
    Ok(())
}

/// §B4 with an agent in the session: the second `up` must not start a second
/// one. Reporting a launch that did not happen would have `logs` follow a
/// transcript that will never exist.
#[tokio::test]
async fn a_second_up_does_not_start_a_second_agent() -> Result<()> {
    let Some(lab) = Lab::start("agent-twice").await? else {
        return Ok(());
    };
    lab.install_claude(true).await?;
    lab.ssh.exec("mkdir -p /tmp/twicerepo").await?;
    let ws = workspace("agenttwice", "/tmp/twicerepo");

    let first = agent::prepare(&lab.ssh, "/tmp/twicerepo").await?;
    assert!(
        up::open(&lab.ssh, &lab.tmux, &ws, Some(&first.command))
            .await?
            .was_created()
    );
    lab.ssh.exec("sleep 1").await?;

    let second = agent::prepare(&lab.ssh, "/tmp/twicerepo").await?;
    assert_ne!(
        first.session_id, second.session_id,
        "each prepare picks a fresh id, so a leak would be visible"
    );
    let again = up::open(&lab.ssh, &lab.tmux, &ws, Some(&second.command)).await?;
    assert!(!again.was_created(), "the second open attaches");
    lab.ssh.exec("sleep 1").await?;

    assert!(
        lab.transcript("/tmp/twicerepo", &second.session_id)
            .await?
            .is_empty(),
        "the second id must never have been run — the session was already there"
    );
    assert!(
        !lab.transcript("/tmp/twicerepo", &first.session_id)
            .await?
            .is_empty(),
        "and the first agent is still the one running"
    );

    lab.tmux.kill(&lab.ssh, &ws.name).await?;
    Ok(())
}
