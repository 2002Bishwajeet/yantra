//! `up` — the whole walking skeleton in one function.
//!
//! Load a workspace, reach its machine over SSH, open a tmux session there.
//! Running it twice attaches rather than duplicating (§B4), and that is a
//! return value the caller can assert on, not a promise.

use crate::ssh::{self, Machine, Ssh};
use crate::tmux::{self, Opened, Tmux};
use crate::workspace::{self, Workspace};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub workspace: Workspace,
    pub opened: Opened,
    /// Carried so the caller can spell out a working `attach` command. A bare
    /// `tmux` in that hint would fail on exactly the machines I-34 describes.
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

/// Opens the workspace called `name`.
///
/// Locating tmux costs one round trip and precedes everything else, because a
/// machine that has no tmux should say so rather than fail partway through
/// (I-34).
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

/// The testable half: everything `up` does once it has a way to reach a machine
/// and knows where tmux lives on it.
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
    Ok(Machine {
        host: workspace.machine.clone(),
        user: None,
        port: None,
        identity: None,
        state_dir: state_dir()?,
    })
}

/// Control sockets are runtime state, and the runtime directory is also the
/// shortest — which matters, because the path budget is 90 bytes (I-28).
fn state_dir() -> Result<PathBuf, Error> {
    use etcetera::BaseStrategy as _;
    let base = etcetera::choose_base_strategy().map_err(|_| Error::NoStateDir)?;
    let dir = base
        .runtime_dir()
        .unwrap_or_else(|| base.data_dir())
        .join("yantra");
    Ok(dir)
}
