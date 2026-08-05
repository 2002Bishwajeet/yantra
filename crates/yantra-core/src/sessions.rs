//! What is running, derived from tmux rather than stored (Y-044).
//!
//! Machines come from the workspaces, not from the tailnet: ADR-0009 makes a
//! workspace's `machine` the only string Yantra may treat as an ssh
//! destination, and a MagicDNS name is not one until `~/.ssh/config` says so.

use crate::ssh::{self, Ssh};
use crate::tmux::{self, Summary, Tmux};
use crate::workspace;

/// One machine's answer. The sessions are a `Result` because an unreachable
/// machine must not fail the whole listing — the others still have answers.
#[derive(Debug)]
pub struct MachineSessions {
    pub machine: String,
    pub sessions: Result<Vec<Summary>, Error>,
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

    #[error("querying {machine} did not finish: {reason}")]
    Interrupted { machine: String, reason: String },
}

/// Every machine any workspace names, queried concurrently and returned
/// machine-sorted. Concurrency is the point: an unreachable machine costs the
/// full `ConnectTimeout`, and sequentially those add up.
pub async fn list() -> Result<Vec<MachineSessions>, Error> {
    let mut machines: Vec<String> = workspace::list()?
        .workspaces
        .into_iter()
        .map(|workspace| workspace.machine)
        .collect();
    machines.sort();
    machines.dedup();

    let queries: Vec<_> = machines
        .into_iter()
        .map(|machine| {
            let name = machine.clone();
            (name, tokio::spawn(async move { on(machine).await }))
        })
        .collect();

    let mut answers = Vec::with_capacity(queries.len());
    for (machine, query) in queries {
        let sessions = match query.await {
            Ok(sessions) => sessions,
            Err(joined) => Err(Error::Interrupted {
                machine: machine.clone(),
                reason: joined.to_string(),
            }),
        };
        answers.push(MachineSessions { machine, sessions });
    }
    Ok(answers)
}

async fn on(machine: String) -> Result<Vec<Summary>, Error> {
    let ssh = Ssh::new(ssh::machine_at(&machine).ok_or(Error::NoStateDir)?)?;
    Ok(Tmux::resolve(&ssh).await?.list(&ssh).await?)
}
