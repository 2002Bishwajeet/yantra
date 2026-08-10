//! Deleting a workspace, and the session that would be left behind.
//!
//! This is [`crate::edit`]'s refusal with the field removed rather than moved.
//! `down`, `resume`, `status` and `logs` all find a session by reading the
//! workspace file; delete the file while a session is open and that session sits
//! on a machine nothing looks at any more, and each of those verbs reports the
//! absence as **success** (I-30). So the delete is refused rather than performed.
//!
//! The wording differs from `edit`'s because the remedy does: a move can be
//! undone by moving back, and a delete cannot.

use crate::ssh::{self, Exec, Ssh};
use crate::tmux::Tmux;
use crate::workspace::{self, Workspace};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removed {
    pub name: String,
    /// What the file held, when it could be read. `None` for a file that would
    /// not parse — it is deleted either way, since a malformed workspace is the
    /// one an operator most wants gone, and only the description is lost.
    pub workspace: Option<Workspace>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Workspace(#[from] workspace::Error),

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,

    /// The refusal this module exists for.
    #[error(
        "`{workspace}` still has a session open on `{machine}`: deleting the file would leave it \
         there with nothing pointing at it, and `down`, `resume`, `status` and `logs` would each \
         report it as absent — run `yantra down {workspace}` first, or `--force` to delete anyway"
    )]
    SessionOpen { workspace: String, machine: String },

    /// R-23: a check that cannot know must refuse or say so, never quietly
    /// allow. A machine asleep, unreachable or without tmux can still be holding
    /// the session, and nothing here can tell which.
    #[error(
        "`{machine}` could not be asked whether `{workspace}` has a session open there, so \
         deleting it might strand one: reach the machine, or use `--force` to delete regardless"
    )]
    CannotTell {
        workspace: String,
        machine: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
}

/// Deletes the workspace called `name`, refusing while its machine still holds
/// the session.
///
/// `force` skips the machine entirely rather than ignoring its answer — a
/// deliberate delete of a workspace whose machine is switched off should not
/// have to wait for a `ConnectTimeout` to be told what it already knows.
pub async fn remove(name: &str, force: bool) -> Result<Removed, Error> {
    if !force {
        // Loaded rather than taken from the delete below, because the machine
        // has to be known *before* the file goes. A file that will not parse
        // names no machine, so it cannot be checked and this refuses (R-23) —
        // `--force` is the way past that, and it is the honest one.
        let workspace = workspace::load(name)?;
        let ssh = Ssh::new(ssh::machine_at(&workspace.machine).ok_or(Error::NoStateDir)?)
            .map_err(|source| cannot_tell(&workspace, source))?;
        let tmux = Tmux::resolve(&ssh)
            .await
            .map_err(|source| cannot_tell(&workspace, source))?;
        ensure_free(&ssh, &tmux, &workspace).await?;
    }

    Ok(Removed {
        name: name.to_owned(),
        workspace: workspace::remove(name)?,
    })
}

/// The testable half: whether the machine a workspace names still holds its
/// session.
///
/// **A session, not a running agent** — a finished agent still leaves a pane
/// (I-4) that `down` has to clean up on that machine, so it strands exactly as a
/// busy one does.
pub async fn ensure_free<E: Exec>(
    exec: &E,
    tmux: &Tmux,
    workspace: &Workspace,
) -> Result<(), Error> {
    match tmux.pane(exec, &workspace.name).await {
        Ok(None) => Ok(()),
        Ok(Some(_)) => Err(Error::SessionOpen {
            workspace: workspace.name.clone(),
            machine: workspace.machine.clone(),
        }),
        Err(source) => Err(cannot_tell(workspace, source)),
    }
}

fn cannot_tell(
    workspace: &Workspace,
    source: impl std::error::Error + Send + Sync + 'static,
) -> Error {
    Error::CannotTell {
        workspace: workspace.name.clone(),
        machine: workspace.machine.clone(),
        source: Box::new(source),
    }
}
