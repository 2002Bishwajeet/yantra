//! Telling "finished" from "crashed", from two sources that can disagree.
//!
//! **R-2 is the reason this is a module and not a boolean.** Gemini CLI exits
//! **0** when it loses its TTY, so a health check that reads one number calls a
//! silent death a success. Claude Code is the only agent M3 ships, but that is
//! the failure mode to design against, and tmux supplies a second instance of
//! the same shape: a signal-killed pane leaves `pane_dead_status` *empty*, which
//! reads like a clean exit to anything that defaults it to zero (see
//! [`crate::tmux::Pane`]).
//!
//! So two sources are read — the pane, and `claude agents --json` — and where
//! they contradict each other that contradiction is the answer, not something
//! to resolve by preferring one.

use crate::agent::{self, Claude, Running};
use crate::ssh::{self, Exec, Ssh};
use crate::tmux::{self, Pane, Tmux};
use crate::workspace::{self, Workspace};

/// Claude Code's exit status after a `SIGTERM` it handled itself: it runs its
/// `SessionEnd` hooks and then exits `128 + 15`. A stop that reaches this is a
/// clean one, which is what makes it worth distinguishing from a crash.
const SIGTERM_EXIT: i32 = 143;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// No such session on that machine.
    NoSession,
    /// The pane is alive and `claude` agrees an agent is in that directory.
    Running,
    /// Exited 0 of its own accord.
    Finished,
    /// Exited [`SIGTERM_EXIT`] — asked to stop, and stopped cleanly.
    Stopped,
    Crashed {
        status: i32,
    },
    /// Killed by a signal it did not handle, so it ran no shutdown of its own.
    /// Distinct from [`Verdict::Stopped`], which is the same signal *handled*.
    Killed {
        signal: String,
    },
    /// The two sources contradict each other. **Reported rather than resolved**
    /// — a pane that is alive while `claude` knows of no agent in that
    /// directory is exactly R-2's silent death, and guessing which source to
    /// believe is how that goes unnoticed.
    Unclear {
        because: &'static str,
    },
}

impl Verdict {
    /// Whether anything is still running. Deliberately false for
    /// [`Verdict::Unclear`]: an answer that is not known is not a yes.
    pub fn is_running(&self) -> bool {
        matches!(self, Self::Running)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub workspace: Workspace,
    pub pane: Option<Pane>,
    /// The registry entry for this workspace's repo, when there is one.
    pub agent: Option<Running>,
    pub verdict: Verdict,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Workspace(#[from] workspace::Error),

    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    #[error(transparent)]
    Tmux(#[from] tmux::Error),

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

pub async fn status(name: &str) -> Result<Report, Error> {
    let workspace = workspace::load(name)?;
    let ssh = Ssh::new(ssh::machine_at(&workspace.machine).ok_or(Error::NoStateDir)?)?;
    let tmux = Tmux::resolve(&ssh).await?;
    of(&ssh, &tmux, workspace).await
}

/// The testable half.
///
/// A machine with no usable `claude` is not an error here — [`Verdict`] still
/// has the pane to go on, and `status` refusing to answer because the *second*
/// opinion is missing would be worse than answering from the first.
pub async fn of<E: Exec>(exec: &E, tmux: &Tmux, workspace: Workspace) -> Result<Report, Error> {
    let pane = tmux.pane(exec, &workspace.name).await?;
    let repo = workspace.repo.to_string_lossy().into_owned();

    let agent = match Claude::resolve(exec).await {
        Ok(claude) => claude
            .agents(exec)
            .await
            .unwrap_or_default()
            .into_iter()
            .find(|running| running.cwd == repo),
        Err(agent::Error::NotFound { .. }) => None,
        Err(_) => None,
    };

    let verdict = verdict(pane.as_ref(), agent.is_some());
    Ok(Report {
        workspace,
        pane,
        agent,
        verdict,
    })
}

fn verdict(pane: Option<&Pane>, registered: bool) -> Verdict {
    let Some(pane) = pane else {
        return Verdict::NoSession;
    };
    if !pane.dead {
        return if registered {
            Verdict::Running
        } else {
            Verdict::Unclear {
                because: "the pane is alive but claude knows of no agent in that directory",
            }
        };
    }
    match (pane.status, pane.signal.as_deref()) {
        (Some(0), _) => Verdict::Finished,
        (Some(SIGTERM_EXIT), _) => Verdict::Stopped,
        (Some(status), _) => Verdict::Crashed { status },
        (None, Some(signal)) => Verdict::Killed {
            signal: signal.to_owned(),
        },
        // tmux says the pane is dead and offers neither number, which it has
        // never done on either version in this fleet.
        (None, None) => Verdict::Unclear {
            because: "the pane is dead and tmux reported neither an exit status nor a signal",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(dead: bool, status: Option<i32>, signal: Option<&str>) -> Pane {
        Pane {
            id: "%0".to_owned(),
            dead,
            status,
            signal: signal.map(str::to_owned),
            pid: if dead { None } else { Some(42) },
        }
    }

    #[test]
    fn an_absent_session_is_not_a_crash() {
        assert_eq!(verdict(None, false), Verdict::NoSession);
    }

    #[test]
    fn a_live_pane_with_a_registered_agent_is_running() {
        assert_eq!(
            verdict(Some(&pane(false, None, None)), true),
            Verdict::Running
        );
        assert!(Verdict::Running.is_running());
    }

    /// R-2's shape, and the reason both sources are read: something is in the
    /// pane and it is not the agent.
    #[test]
    fn a_live_pane_with_no_registered_agent_is_not_called_healthy() {
        let verdict = verdict(Some(&pane(false, None, None)), false);
        assert!(matches!(verdict, Verdict::Unclear { .. }), "{verdict:?}");
        assert!(
            !verdict.is_running(),
            "an unknown answer must never read as a yes"
        );
    }

    #[test]
    fn the_three_ways_a_pane_can_end_are_told_apart() {
        assert_eq!(
            verdict(Some(&pane(true, Some(0), None)), false),
            Verdict::Finished
        );
        assert_eq!(
            verdict(Some(&pane(true, Some(SIGTERM_EXIT), None)), false),
            Verdict::Stopped
        );
        assert_eq!(
            verdict(Some(&pane(true, Some(1), None)), false),
            Verdict::Crashed { status: 1 }
        );
    }

    /// The trap this module exists for. tmux leaves `pane_dead_status` empty
    /// when a signal did the killing, so anything that defaults it to zero
    /// reports a `kill -9` as a clean finish.
    #[test]
    fn a_signal_killed_pane_is_never_mistaken_for_a_clean_exit() {
        assert_eq!(
            verdict(Some(&pane(true, None, Some("KILL"))), false),
            Verdict::Killed {
                signal: "KILL".to_owned()
            }
        );
        assert_ne!(
            verdict(Some(&pane(true, None, Some("TERM"))), false),
            Verdict::Finished,
            "an unhandled SIGTERM is not the same as exiting 0"
        );
        assert_ne!(
            verdict(Some(&pane(true, None, Some("TERM"))), false),
            Verdict::Stopped,
            "nor the same as handling one and exiting 143"
        );
    }
}
