//! `attach` — everything needed to hand the terminal over, and nothing that does.
//!
//! The command itself is the CLI's, because attaching *is* giving away the
//! process (ADR-0005 keeps that out of here). What this module owns is the
//! answer to "is there something to attach to, and what is the command" — the
//! four parts [`crate::up`] already assembles for its hint, each of which took a
//! task to get right: the machine, the resolved tmux path (I-34), the session
//! name spelled so a login `zsh` cannot eat it (I-35), and a `TERM` the far side
//! actually has (I-36, I-43).
//!
//! **It never creates.** `up` is the verb that opens a session and is idempotent
//! about it; a second verb that quietly created one would make `attach` a worse
//! `up`. The useful consequence is that this reaches a session `up` no longer
//! can: Y-081 made `up` refuse a workspace whose `repo` has since been deleted,
//! which left a live session with no way back to it.

use crate::ssh::{self, Exec, Ssh};
use crate::terminfo::{self, Chosen};
use crate::tmux::{self, Tmux};
use crate::workspace::{self, Workspace};

/// What the caller needs to become the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub workspace: Workspace,
    pub tmux: Tmux,
    pub term: Chosen,
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

    /// Names the machine as well as the workspace: with no session, the
    /// interesting question is usually *which machine was looked at*.
    #[error("`{workspace}` has no session on {machine}")]
    NoSession { workspace: String, machine: String },

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

/// Resolves everything needed to attach to `name`, for a caller sitting at `term`.
pub async fn plan(name: &str, term: &str) -> Result<Plan, Error> {
    let workspace = workspace::load(name)?;
    let ssh = Ssh::new(ssh::machine_at(&workspace.machine).ok_or(Error::NoStateDir)?)?;
    let tmux = Tmux::resolve(&ssh).await?;
    ensure_session(&ssh, &tmux, &workspace).await?;
    let term = terminfo::choose(&ssh, term).await?;

    Ok(Plan {
        workspace,
        tmux,
        term,
    })
}

/// The testable half.
///
/// Asked before `TERM` is chosen, because `choose` can install a terminfo entry
/// on the far side and a workspace with nothing to attach to should not leave
/// anything behind.
pub async fn ensure_session<E: Exec>(
    exec: &E,
    tmux: &Tmux,
    workspace: &Workspace,
) -> Result<(), Error> {
    match tmux.pane(exec, &workspace.name).await? {
        Some(_) => Ok(()),
        None => Err(Error::NoSession {
            workspace: workspace.name.clone(),
            machine: workspace.machine.clone(),
        }),
    }
}

/// The command to run on `machine`, as one argument for the remote shell.
///
/// Shared with the hint [`crate::up`] prints, so what a user copies and what
/// `attach` runs can never drift apart.
pub fn remote_command(tmux: &str, session: &str, term: &str) -> String {
    format!(
        "TERM={term} {tmux} attach -t {}",
        tmux::sq(&session_target(session))
    )
}

/// `=name` is tmux's exact-match spelling (I-21), and it has to survive the
/// remote login shell to reach tmux at all — an unquoted `=name` is filename
/// expansion in `zsh` (I-35).
fn session_target(session: &str) -> String {
    format!("={session}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_is_addressed_exactly_and_survives_zsh() {
        let command = remote_command("/opt/homebrew/bin/tmux", "yantra", "xterm-ghostty");
        assert_eq!(
            command,
            "TERM=xterm-ghostty /opt/homebrew/bin/tmux attach -t '=yantra'"
        );
    }
}
