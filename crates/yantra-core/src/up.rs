//! `up` — the whole walking skeleton in one function.
//!
//! Load a workspace, reach its machine over SSH, open a tmux session there.
//! Running it twice attaches rather than duplicating (§B4), and that is a
//! return value the caller can assert on, not a promise.

use crate::agent::{self, Launch};
use crate::ssh::{self, Machine, Ssh};
use crate::terminfo::{self, Chosen};
use crate::tmux::{self, Opened, Tmux};
use crate::workspace::{self, Workspace};

/// Which agent to launch. One variant, and it stays one until a second agent is
/// genuinely wanted — the guardrail, and ADR-0011.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    Claude,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub workspace: Workspace,
    pub opened: Opened,
    /// Carried so the attach hint can name a real path (I-34).
    pub tmux: Tmux,
    /// Carried so the attach hint can name a terminal the far side has (I-36),
    /// and so the caller can say when that is not the one asked for.
    pub term: Chosen,
    /// `Some` only when this call actually started an agent. A second `up`
    /// attaches to the session that is already running one, so there is nothing
    /// launched to report — asking the machine what is running there is
    /// [`crate::agent`]'s job, not this one's.
    pub launched: Option<Launch>,
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

    /// Refused rather than resolved. Picking a winner would mean silently
    /// ignoring one of them, and ADR-0007's rule — that a quietly ignored
    /// instruction is the worst kind of bug — does not stop applying because the
    /// instruction arrived on the command line instead of in the file.
    #[error(
        "workspace `{workspace}` already runs `{startup}` at startup, so --agent has nothing to \
         start it in: drop one of the two"
    )]
    StartupConflict { workspace: String, startup: String },

    /// Names all three of workspace, path and machine, because any one of them
    /// can be the thing that is wrong and the reader cannot tell which from the
    /// other two.
    #[error("workspace `{workspace}` opens at `{repo}`, and `{machine}` has no such directory")]
    NoRepo {
        workspace: String,
        repo: String,
        machine: String,
    },

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

/// Opens the workspace called `name`, for a caller sitting at `term`, optionally
/// starting an agent in it.
///
/// Resolving tmux first means a machine without it says so, rather than failing
/// partway through. `term` is a request, not a promise: the far side may have no
/// description of it, and [`Report::term`] reports what was actually used.
///
/// Everything an agent needs is settled *before* the session is touched — the
/// binary located, the account checked — so a machine that cannot run one leaves
/// nothing half-open behind.
pub async fn up(name: &str, term: &str, agent: Option<Agent>) -> Result<Report, Error> {
    let workspace = workspace::load(name)?;
    if let (Some(_), Some(startup)) = (agent, workspace.startup.as_deref()) {
        return Err(Error::StartupConflict {
            workspace: workspace.name.clone(),
            startup: startup.to_owned(),
        });
    }

    let ssh = Ssh::new(machine_for(&workspace)?)?;
    let tmux = Tmux::resolve(&ssh).await?;
    let term = terminfo::choose(&ssh, term).await?;

    let launch = match agent {
        Some(Agent::Claude) => Some(agent::prepare(&ssh, &workspace.repo.to_string_lossy()).await?),
        None => None,
    };

    let opened = open(
        &ssh,
        &tmux,
        &workspace,
        launch.as_ref().map(|l| l.command.as_str()),
    )
    .await?;

    // Nothing was started if the session was already there, and saying otherwise
    // would have `logs` follow a transcript that will never exist.
    let launched = opened.was_created().then_some(launch).flatten();

    Ok(Report {
        workspace,
        opened,
        tmux,
        term,
        launched,
    })
}

/// The testable half: `up` once it can reach a machine and has found tmux.
///
/// `agent_command` replaces the workspace's own `startup` rather than joining
/// it; [`up`] refuses the case where both are set, so only one can arrive here.
pub async fn open<E: ssh::Exec>(
    exec: &E,
    tmux: &Tmux,
    workspace: &Workspace,
    agent_command: Option<&str>,
) -> Result<Opened, Error> {
    let repo = workspace.repo.to_string_lossy();
    ensure_repo(exec, workspace, &repo).await?;
    let startup = agent_command.or(workspace.startup.as_deref());
    let opened = tmux.ensure(exec, &workspace.name, &repo, startup).await?;
    Ok(opened)
}

/// Refuses a `repo` the machine does not have, before anything is opened.
///
/// A missing directory is otherwise invisible: `new-session -c` falls back to
/// `$HOME` rather than failing, so the session comes up healthy in the wrong
/// tree and an agent launched into it works on nothing. Costs one round trip,
/// and it is on the far side because `repo` is a path on *that* machine
/// (ADR-0009).
///
/// Refused even when the session is already there. Skipping the check for an
/// existing session would mean asking tmux first, which is I-1's
/// `has-session || create` race in a new place.
async fn ensure_repo<E: ssh::Exec>(
    exec: &E,
    workspace: &Workspace,
    repo: &str,
) -> Result<(), Error> {
    if exec.exec(&exists_command(repo)).await?.success() {
        return Ok(());
    }
    Err(Error::NoRepo {
        workspace: workspace.name.clone(),
        repo: repo.to_owned(),
        machine: workspace.machine.clone(),
    })
}

fn exists_command(repo: &str) -> String {
    format!("test -d {}", tmux::sq(repo))
}

/// `machine` is used as an ssh destination verbatim, so `~/.ssh/config` decides
/// what it means — the fidelity I-20 chose the system binary for. Yantra does
/// not maintain a second copy of that mapping. Settled in ADR-0009: the
/// Tailscale inventory observes machines, it does not resolve them.
fn machine_for(workspace: &Workspace) -> Result<Machine, Error> {
    ssh::machine_at(&workspace.machine).ok_or(Error::NoStateDir)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The existence check puts `repo` in front of a remote shell, and a
    /// workspace file is where it comes from — the boundary I-26 drew.
    ///
    /// Asserted as an exact string, as in [`crate::agent`]: the correctly
    /// escaped form still *contains* `; rm -rf ~; `, inside quotes, so a
    /// substring search cannot tell safe from unsafe. A real `/bin/sh` settles
    /// it in `tests/up_walking_skeleton.rs`.
    #[test]
    fn a_hostile_repo_path_cannot_break_out_of_the_check() {
        assert_eq!(
            exists_command("/tmp/x'; rm -rf ~; '"),
            r"test -d '/tmp/x'\''; rm -rf ~; '\'''"
        );
    }
}
