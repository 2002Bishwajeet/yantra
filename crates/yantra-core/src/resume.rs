//! `resume` — picking a conversation up where it stopped.
//!
//! The fourth of the agent verbs [`brainstorm.md`] names, and the one Q9 killed
//! Aider over: *"Yantra's core promise is 'continue where you left off'."*
//!
//! **Which conversation to resume is Claude Code's question, not Yantra's**
//! (§B2). Yantra keeps no session id — [`crate::agent::prepare`] mints a fresh
//! one per launch and nothing persists it, because Y-044's session store is
//! deliberately unbuilt and ADR-0011 is why it recedes. So of what 2.1.220
//! offers, only one flag is reachable from here:
//!
//! - `--resume <id>` needs an id Yantra never kept, and a bare `--resume` opens
//!   an **interactive picker** — which resumes nothing until a human attaches
//!   and answers it.
//! - `--continue` resolves the most recent conversation **from the cwd**, and
//!   the cwd is the workspace's `repo` because the launch command `cd`s there.
//!
//! `--continue` on its own reuses the *original* session id, which would cost
//! the predictable transcript path ADR-0011 built `logs` on. `--fork-session`
//! gives it back: measured on 2.1.220,
//! `--continue --fork-session --session-id <uuid>` carries the earlier turns
//! into a transcript Yantra named, while `--continue --session-id <uuid>`
//! without the fork is **refused outright**.
//!
//! **What no flag can tell Yantra is that there was nothing to resume.**
//! `--continue` in a directory with no earlier conversation starts a fresh one
//! and exits 0 — measured, not assumed — so `resume` on a workspace whose agent
//! has never run is `up --agent claude` under another name.
//!
//! What it will not do is guess. A live pane holding something that is not a
//! registered agent is R-2's shape ([`crate::status`]), and respawning it would
//! destroy whatever is in there; an agent waiting at the trust dialog has no
//! conversation to continue and needs a human, never Yantra (ADR-0011). Both
//! are refusals, and so is a `repo` the machine no longer has — Y-081's check
//! binds a respawn exactly as it binds an open, or `resume` would report success
//! for an agent whose `cd` failed.
//!
//! [`brainstorm.md`]: ../../../docs/brainstorm.md

use crate::agent::{self, Launch};
use crate::ssh::{self, Exec, Os, Ssh};
use crate::status::{self, Verdict};
use crate::terminfo::{self, Chosen};
use crate::tmux::{self, Pane, Tmux};
use crate::up;
use crate::workspace::{self, Workspace};

/// What happened. Never "a second agent was started".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Resumed(Launch),
    /// An agent is already working in that session, so there is nothing to
    /// continue and the session is left exactly as it is.
    AlreadyRunning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub workspace: Workspace,
    /// Carried for the attach hint, as in [`crate::up::Report`].
    pub tmux: Tmux,
    pub term: Chosen,
    pub outcome: Outcome,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Workspace(#[from] workspace::Error),

    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    #[error(transparent)]
    Tmux(#[from] tmux::Error),

    #[error(transparent)]
    Terminfo(#[from] terminfo::Error),

    #[error(transparent)]
    Agent(#[from] agent::Error),

    #[error(transparent)]
    Status(#[from] status::Error),

    #[error(transparent)]
    Up(#[from] up::Error),

    /// I-49: the agent never got past the dialog, so it has said nothing there
    /// is to continue — and ADR-0011 means Yantra cannot answer it either.
    #[error(
        "`{workspace}` is holding at claude's trust prompt, so it has no conversation to continue"
    )]
    AwaitingTrust { workspace: String },

    /// The session is open as a shell and no agent was ever launched in it, so
    /// there is no conversation to continue. Respawning would put an agent in a
    /// pane the user is sitting in, which is a launch wearing `resume`'s name —
    /// and `up --agent` is the verb that already means that.
    #[error("`{workspace}` has no agent — it was opened as a shell")]
    NoAgent { workspace: String },

    /// Refused rather than resolved, for the same reason [`Verdict::Unclear`]
    /// is reported rather than resolved: respawning would kill whatever is in
    /// that pane to find out what it was.
    #[error("refusing to resume `{workspace}` — {because}")]
    Unclear {
        workspace: String,
        because: &'static str,
    },

    /// The same rule as [`up::Error::StartupConflict`], one verb along: a
    /// workspace that runs something of its own at startup is not running an
    /// agent, and silently replacing it is ADR-0007's worst kind of bug.
    #[error(
        "workspace `{workspace}` runs `{startup}` at startup rather than an agent, so there is \
         nothing for resume to continue"
    )]
    Startup { workspace: String, startup: String },

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

/// Resumes the workspace called `name`, for a caller sitting at `term`.
pub async fn resume(name: &str, term: &str) -> Result<Report, Error> {
    let workspace = workspace::load(name)?;
    if let Some(startup) = workspace.startup.as_deref() {
        return Err(Error::Startup {
            workspace: workspace.name.clone(),
            startup: startup.to_owned(),
        });
    }

    let ssh = Ssh::new(ssh::machine_at(&workspace.machine).ok_or(Error::NoStateDir)?)?;
    let tmux = Tmux::resolve(&ssh).await?;
    let os = ssh::os(&ssh).await?;
    let term = terminfo::choose(&ssh, term).await?;
    let outcome = of(&ssh, &tmux, &workspace, os).await?;

    Ok(Report {
        workspace,
        tmux,
        term,
        outcome,
    })
}

/// The testable half.
///
/// The agent is prepared *after* the state is known, so a refusal costs no
/// round trip to `claude auth status` and leaves nothing half-started.
///
/// ADR-0018 §1 is asked first and not left to [`up::open`], because every plan
/// but one prepares the agent before it reaches there — and on macOS that gate
/// runs inside the server this refuses to create.
pub async fn of<E: Exec>(
    exec: &E,
    tmux: &Tmux,
    workspace: &Workspace,
    os: Os,
) -> Result<Outcome, Error> {
    up::require_login_server(exec, tmux, os, &workspace.machine).await?;
    let status = status::of(exec, tmux, workspace.clone()).await?;
    let repo = workspace.repo.to_string_lossy();
    let named = || workspace.name.clone();

    match plan(&status.verdict, status.pane.as_ref()) {
        Plan::AlreadyRunning => Ok(Outcome::AlreadyRunning),
        Plan::AwaitingTrust => Err(Error::AwaitingTrust { workspace: named() }),
        Plan::NoAgent => Err(Error::NoAgent { workspace: named() }),
        Plan::Unclear(because) => Err(Error::Unclear {
            workspace: named(),
            because,
        }),
        Plan::Open => {
            let launch = agent::resume(exec, &repo, tmux, os).await?;
            up::open(exec, tmux, workspace, Some(&launch.command), os).await?;
            Ok(Outcome::Resumed(launch))
        }
        Plan::Respawn(pane_id) => {
            // Y-081 binds both paths or neither: `Plan::Open` inherits the check
            // from `up::open`, and a respawn goes straight to tmux instead.
            up::ensure_repo(exec, workspace, &repo).await?;
            let launch = agent::resume(exec, &repo, tmux, os).await?;
            tmux.respawn(exec, pane_id, &launch.command).await?;
            Ok(Outcome::Resumed(launch))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Plan<'a> {
    Open,
    /// Under `remain-on-exit` the pane outlives its process, so putting the
    /// agent back means `respawn-pane` and never a second session (I-29).
    Respawn(&'a str),
    AlreadyRunning,
    AwaitingTrust,
    NoAgent,
    Unclear(&'static str),
}

/// Every verdict spelled out rather than a wildcard, so a state added later
/// cannot default into respawning a pane that has something live in it.
fn plan<'a>(verdict: &'a Verdict, pane: Option<&'a Pane>) -> Plan<'a> {
    match verdict {
        Verdict::NoSession => Plan::Open,
        Verdict::Running => Plan::AlreadyRunning,
        Verdict::AwaitingTrust => Plan::AwaitingTrust,
        Verdict::NoAgent => Plan::NoAgent,
        Verdict::Unclear { because } => Plan::Unclear(because),
        Verdict::Finished | Verdict::Stopped | Verdict::Crashed { .. } | Verdict::Killed { .. } => {
            match pane {
                Some(pane) => Plan::Respawn(&pane.id),
                None => Plan::Unclear("tmux said how the agent ended and then reported no pane"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape `agent::launch_command` builds, so a pane in these tests is one
    /// an agent was actually launched into.
    const AGENT_COMMAND: &str = "cd '/srv/repo' && exec '/usr/bin/claude' --session-id 'd4c3b2a1-0000-4000-8000-000000000000'";

    fn pane(dead: bool) -> Pane {
        Pane {
            id: "%7".to_owned(),
            dead,
            status: dead.then_some(0),
            signal: None,
            pid: (!dead).then_some(42),
            start_command: Some(AGENT_COMMAND.to_owned()),
        }
    }

    #[test]
    fn a_workspace_with_no_session_gets_one_opened() {
        assert_eq!(plan(&Verdict::NoSession, None), Plan::Open);
    }

    /// The four ways an agent can be gone are one state to `resume`, and all of
    /// them leave a dead pane that only `respawn-pane` can refill.
    #[test]
    fn every_ending_is_resumed_in_the_pane_it_ended_in() {
        for verdict in [
            Verdict::Finished,
            Verdict::Stopped,
            Verdict::Crashed { status: 1 },
            Verdict::Killed {
                signal: "KILL".to_owned(),
            },
        ] {
            assert_eq!(
                plan(&verdict, Some(&pane(true))),
                Plan::Respawn("%7"),
                "{verdict:?}"
            );
        }
    }

    /// §B4's idempotency, one verb along: resuming a running agent must not put
    /// a second one in the pane the first is working in.
    #[test]
    fn a_running_agent_is_left_alone_rather_than_replaced() {
        assert_eq!(
            plan(&Verdict::Running, Some(&pane(false))),
            Plan::AlreadyRunning
        );
    }

    /// I-49. There is no conversation to continue, and ADR-0011 says the one
    /// who answers the dialog is never Yantra.
    #[test]
    fn an_agent_at_the_trust_prompt_is_refused_rather_than_restarted() {
        assert_eq!(
            plan(&Verdict::AwaitingTrust, Some(&pane(false))),
            Plan::AwaitingTrust
        );
    }

    /// R-2's shape. Something is alive in that pane and it is not the agent —
    /// respawning would destroy it to find out what it was.
    #[test]
    fn a_pane_the_registry_does_not_know_about_is_never_respawned() {
        let because = "the pane is alive but claude knows of no agent in that directory";
        assert_eq!(
            plan(&Verdict::Unclear { because }, Some(&pane(false))),
            Plan::Unclear(because),
            "the reason has to survive, or the refusal tells nobody anything"
        );
    }

    /// A dead verdict with no pane to respawn is a contradiction, and the
    /// answer to a contradiction is the same here as in `status`: say so.
    #[test]
    fn an_ending_with_no_pane_refuses_instead_of_opening_a_fresh_session() {
        assert!(
            matches!(plan(&Verdict::Finished, None), Plan::Unclear(_)),
            "silently opening a new session would lose the conversation being asked for"
        );
    }
}
