//! Stopping a workspace, and saying how the agent went out.
//!
//! **The order is the whole design.** `tmux kill-session` destroys the pane, and
//! the pane is where the exit status lives (I-4) — so how the agent ended can
//! only be read *before* it is stopped, never after. [`crate::status`] is read
//! first for that reason, not as a courtesy.
//!
//! It is also **Y-046's answer**. I-27 leaves a remote command parented to PID 1
//! when the local `ssh` dies, which has been harmless while every command Yantra
//! issued finished in milliseconds; an agent session is the first that does not.
//! Killing the session kills what is in it, which killing the `ssh` never did.

use crate::ssh::{self, Exec, Ssh};
use crate::status::{self, Verdict};
use crate::tmux::{self, Tmux};
use crate::workspace::{self, Workspace};

/// How long the agent is given to handle `SIGTERM` before the session is torn
/// down regardless. Claude Code runs its `SessionEnd` hooks in this window,
/// which is the difference between [`Verdict::Stopped`] and [`Verdict::Killed`].
const GRACE: &str = "50"; // × 0.1s

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub workspace: Workspace,
    /// How the agent ended, read while there was still a pane to read it from.
    ///
    /// `None` when there was no agent to have an ending — a session opened as a
    /// shell (Y-091), or no session at all. The distinction cannot be recovered
    /// afterwards: a shell that takes the `SIGTERM` below reports exactly the
    /// `Killed` an agent that ignored its own shutdown would, and calling that
    /// *"it ran no shutdown of its own"* says something untrue about a shell.
    pub ending: Option<Verdict>,
    /// `false` when there was nothing to stop. Absence is success (I-30, §B4),
    /// but the caller should not claim to have stopped something.
    pub stopped: bool,
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
    Status(#[from] status::Error),

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

pub async fn down(name: &str) -> Result<Report, Error> {
    let workspace = workspace::load(name)?;
    let ssh = Ssh::new(ssh::machine_at(&workspace.machine).ok_or(Error::NoStateDir)?)?;
    let tmux = Tmux::resolve(&ssh).await?;
    stop(&ssh, &tmux, workspace).await
}

/// The testable half.
pub async fn stop<E: Exec>(exec: &E, tmux: &Tmux, workspace: Workspace) -> Result<Report, Error> {
    let before = status::of(exec, tmux, workspace).await?;
    if before.verdict == Verdict::NoSession {
        return Ok(Report {
            workspace: before.workspace,
            ending: None,
            stopped: false,
        });
    }

    // Asked before the SIGTERM, because afterwards a shell and an agent that
    // ignored its shutdown are the same dead pane.
    let had_agent = before.verdict != Verdict::NoAgent;

    // Ask before telling. A pane that is already dead has nothing to ask.
    if let Some(pid) = before.pane.as_ref().and_then(|pane| pane.pid) {
        exec.exec(&terminate(pid)).await?;
    }

    // Re-read while the pane still exists: this is the last moment the exit
    // status is knowable, and it is what turns a handled SIGTERM into
    // `Stopped` rather than the `Running` the first read saw.
    let after = status::of(exec, tmux, before.workspace).await?;
    tmux.kill(exec, &after.workspace.name).await?;

    Ok(Report {
        workspace: after.workspace,
        ending: had_agent.then_some(after.verdict),
        stopped: true,
    })
}

/// `kill -0` rather than a fixed sleep, so a fast shutdown costs one round trip
/// and a hung one still ends. The whole wait happens on the far side — polling
/// from here would be `GRACE` round trips instead of one.
fn terminate(pid: u32) -> String {
    format!(
        "kill -TERM {pid} 2>/dev/null || exit 0\n\
         i=0\n\
         while kill -0 {pid} 2>/dev/null && [ $i -lt {GRACE} ]; do\n\
         \x20 i=$((i+1)); sleep 0.1\n\
         done\n\
         exit 0\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pid is a number Yantra read from tmux, so there is nothing to quote —
    /// but the loop must still be bounded, or a process that ignores `SIGTERM`
    /// hangs `down` forever.
    #[test]
    fn the_wait_for_a_clean_shutdown_is_bounded() {
        let script = terminate(4242);
        assert!(script.contains("kill -TERM 4242"), "{script}");
        assert!(script.contains(&format!("-lt {GRACE}")), "{script}");
        assert!(
            script.contains("kill -0 4242"),
            "a fast exit must not pay the whole grace period: {script}"
        );
    }
}
