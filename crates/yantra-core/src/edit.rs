//! Changing a workspace after it exists, and the one field that is not free to
//! change.
//!
//! `repo` and `startup` are inert until the next `up`, so editing them is a file
//! write and nothing more. `machine` is not: it is *where the tmux session is*,
//! and `down`, `resume`, `status` and `logs` all find that session by reading
//! the field. Moving it while a session is open therefore leaves that session on
//! a machine nothing looks at any more, and each of those verbs then finds
//! nothing and reports the absence as **success** (I-30) — the bug Y-117 was
//! deferred to avoid. So the move is refused rather than performed.
//!
//! Moving the session along with the field is M10's, because it needs the read
//! model that surveys the tailnet rather than the machines the workspaces name.

use crate::ssh::{self, Exec, Ssh};
use crate::tmux::Tmux;
use crate::workspace::{self, Changes, Workspace};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edited {
    pub workspace: Workspace,
    /// `false` when every field already held the value asked for (§B4). The
    /// caller should not claim to have changed anything.
    pub changed: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Workspace(#[from] workspace::Error),

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,

    /// The refusal this module exists for.
    #[error(
        "`{workspace}` cannot be moved off `{machine}` while a session is open there: the session \
         would stay behind where nothing looks for it, and `down`, `resume`, `status` and `logs` \
         would each report it as absent — run `yantra down {workspace}` first"
    )]
    SessionOpen { workspace: String, machine: String },

    /// R-23: a check that cannot know must refuse or say so, never quietly
    /// allow. A machine that is asleep, unreachable or without tmux can still be
    /// holding the session, and there is no way from here to tell which.
    #[error(
        "`{machine}` could not be asked whether `{workspace}` has a session open there, so moving \
         it might strand one: reach the machine, or stop the session, and try again"
    )]
    CannotTell {
        workspace: String,
        machine: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
}

/// Edits the workspace called `name`, refusing to move it off a machine that
/// still holds its session.
///
/// The machine is reached **only** when `machine` actually changes, so editing
/// `repo` or `startup` works with the whole fleet asleep — and so does naming
/// the machine the workspace already has (§B4).
pub async fn edit(name: &str, changes: &Changes) -> Result<Edited, Error> {
    let before = workspace::load(name)?;

    if changes.moves(&before) {
        let ssh = Ssh::new(ssh::machine_at(&before.machine).ok_or(Error::NoStateDir)?)
            .map_err(|source| cannot_tell(&before, source))?;
        let tmux = Tmux::resolve(&ssh)
            .await
            .map_err(|source| cannot_tell(&before, source))?;
        ensure_free(&ssh, &tmux, &before).await?;
    }

    let workspace = workspace::update(name, changes)?;
    Ok(Edited {
        changed: workspace != before,
        workspace,
    })
}

/// The testable half: whether the machine a workspace names still holds its
/// session.
///
/// **A session, not a running agent.** A session whose agent has already
/// finished still has a pane (I-4) and still has to be cleaned up by `down` on
/// that machine, so it strands exactly as a busy one does — and
/// [`crate::status::Verdict::is_running`] is deliberately false for `Unclear`,
/// which would let the move through in precisely the case nothing is sure about.
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
