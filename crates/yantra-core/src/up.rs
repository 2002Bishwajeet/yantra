//! `up` — the whole walking skeleton in one function.
//!
//! Load a workspace, reach its machine over SSH, open a tmux session there.
//! Running it twice attaches rather than duplicating (§B4), and that is a
//! return value the caller can assert on, not a promise.

use crate::ssh::{self, Machine, Ssh};
use crate::tmux::{self, Opened, Tmux};
use crate::workspace::{self, Workspace};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub workspace: Workspace,
    pub opened: Opened,
    /// Carried so the attach hint can name a real path (I-34).
    pub tmux: Tmux,
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

/// Opens the workspace called `name`. Resolving tmux first means a machine
/// without it says so, rather than failing partway through.
pub async fn up(name: &str) -> Result<Report, Error> {
    let workspace = workspace::load(name)?;
    let ssh = Ssh::new(machine_for(&workspace)?)?;
    let tmux = Tmux::resolve(&ssh).await?;
    let opened = open(&ssh, &tmux, &workspace).await?;
    Ok(Report {
        workspace,
        opened,
        tmux,
    })
}

/// The testable half: `up` once it can reach a machine and has found tmux.
pub async fn open<E: ssh::Exec>(
    exec: &E,
    tmux: &Tmux,
    workspace: &Workspace,
) -> Result<Opened, Error> {
    let repo = workspace.repo.to_string_lossy();
    let opened = tmux
        .ensure(exec, &workspace.name, &repo, workspace.startup.as_deref())
        .await?;
    Ok(opened)
}

/// `machine` is used as an ssh destination verbatim, so `~/.ssh/config` decides
/// what it means — the fidelity I-20 chose the system binary for. Yantra does
/// not maintain a second copy of that mapping. Settled in ADR-0009: the
/// Tailscale inventory observes machines, it does not resolve them.
fn machine_for(workspace: &Workspace) -> Result<Machine, Error> {
    ssh::machine_at(&workspace.machine).ok_or(Error::NoStateDir)
}
