//! What is running, derived from tmux rather than stored (Y-044).
//!
//! Machines come from the workspaces **and, since Y-176, from the tailnet**.
//! The header here used to say the second half was forbidden, reading ADR-0009
//! as *only a workspace's `machine` may be treated as an ssh destination*. That
//! reading was stronger than the ADR: what ADR-0009 forbids is Yantra
//! **resolving** a name, and passing a tailnet label to `ssh` verbatim resolves
//! nothing — `~/.ssh/config` still decides what it means, and MagicDNS answers
//! only where the config declines to. So tailnet membership is a **candidate**,
//! never a resolution, and a candidate that is not an ssh destination comes back
//! as that machine's `Err` rather than as a missing row.
//!
//! **This widens a poll, which is the cost to know.** `refresh.rs` calls
//! [`list`] every 30 s, and an unreachable candidate spends the full
//! `ConnectTimeout` on every one of those. Hence [`worth_asking`]: a phone is
//! not an ssh host and an offline machine is a known negative, so neither is
//! paid for repeatedly.

use crate::inventory::{Inventory, MachineInfo, Os, Tailscale};
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

/// Every machine any workspace names or the tailnet offers, queried
/// concurrently and returned machine-sorted. Concurrency is the point: an
/// unreachable machine costs the full `ConnectTimeout`, and sequentially those
/// add up.
pub async fn list() -> Result<Vec<MachineSessions>, Error> {
    list_from(&Tailscale).await
}

/// The testable half. The inventory is a parameter because a tailnet cannot be
/// put in a container ([`crate::inventory`]), so the widening this function does
/// is provable only through a fake.
pub async fn list_from<I: Inventory>(inventory: &I) -> Result<Vec<MachineSessions>, Error> {
    let mut machines: Vec<String> = workspace::list()?
        .workspaces
        .into_iter()
        .map(|workspace| workspace.machine)
        .collect();

    // Advisory, so an inventory that cannot answer costs candidates and never
    // the listing — a workspace's machine is knowable with Tailscale absent,
    // switched off, or not installed at all (ADR-0009).
    if let Ok(seen) = inventory.machines().await {
        machines.extend(
            seen.into_iter()
                .filter(worth_asking)
                .map(|machine| machine.name),
        );
    }

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

/// What [`kill`] did, so a caller can say *killed* or *already gone* rather
/// than guessing which happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Killed {
    pub machine: String,
    pub session: String,
    /// `false` when nothing was there. Absence is the state asked for (I-30),
    /// so this is a fact to report and never a failure.
    pub killed: bool,
}

/// Stops a session by machine and name, for the sessions [`list`] finds that no
/// workspace claims.
///
/// **This is not `down`.** `down` reads how the agent ended before destroying
/// the pane that holds it, because a workspace's session was started by Yantra
/// and its ending means something. A session Yantra did not start has no agent
/// to report on, so this only stops it.
pub async fn kill(machine: &str, session: &str) -> Result<Killed, Error> {
    let ssh = Ssh::new(ssh::machine_at(machine).ok_or(Error::NoStateDir)?)?;
    let tmux = Tmux::resolve(&ssh).await?;
    kill_on(&ssh, &tmux, machine, session).await
}

/// The testable half, driven by the container fixture.
pub async fn kill_on<E: ssh::Exec>(
    exec: &E,
    tmux: &Tmux,
    machine: &str,
    session: &str,
) -> Result<Killed, Error> {
    // Asked before killing, because `tmux kill-session` cannot tell the caller
    // whether it destroyed anything — absence is success there, which is right
    // for the verb and useless for the sentence a person reads afterwards.
    let present = tmux
        .list(exec)
        .await?
        .iter()
        .any(|summary| summary.name == session);

    if present {
        tmux.kill(exec, session).await?;
    }
    Ok(Killed {
        machine: machine.to_owned(),
        session: session.to_owned(),
        killed: present,
    })
}

/// Which tailnet peers are worth a `ConnectTimeout` every 30 s.
///
/// **Both tests are about cost, not about permission.** A phone runs no sshd
/// and no tmux, so asking it can only ever fail; an offline peer is a negative
/// already known from the inventory. Neither exclusion applies to a machine a
/// workspace names — that name is the owner's instruction and is always asked,
/// which is why this filter sits on the tailnet half alone.
fn worth_asking(machine: &MachineInfo) -> bool {
    machine.online && !matches!(machine.os, Os::Ios | Os::Android)
}

async fn on(machine: String) -> Result<Vec<Summary>, Error> {
    let ssh = Ssh::new(ssh::machine_at(&machine).ok_or(Error::NoStateDir)?)?;
    Ok(Tmux::resolve(&ssh).await?.list(&ssh).await?)
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets library code, where the same call would take the daemon down.
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn peer(name: &str, os: Os, online: bool) -> MachineInfo {
        MachineInfo {
            id: format!("n{name}"),
            name: name.to_string(),
            dns_name: format!("{name}.tail.ts.net."),
            os,
            online,
            last_seen: None,
            expired: false,
            addresses: Vec::new(),
        }
    }

    /// A phone runs no sshd and no tmux, so asking it can only fail — and it
    /// would fail slowly, once every 30 s, for as long as the daemon runs.
    #[test]
    fn a_phone_is_never_asked() {
        assert!(!worth_asking(&peer("iphone", Os::Ios, true)));
        assert!(!worth_asking(&peer("pixel", Os::Android, true)));
    }

    /// Offline is a negative the inventory already gave us. Paying a
    /// `ConnectTimeout` to be told it again is the cost this filter exists for.
    #[test]
    fn an_offline_peer_is_not_paid_for() {
        assert!(!worth_asking(&peer("nas", Os::Linux, false)));
    }

    #[test]
    fn an_online_computer_is_a_candidate() {
        assert!(worth_asking(&peer("g14", Os::Linux, true)));
        assert!(worth_asking(&peer("mac", Os::MacOs, true)));
        assert!(worth_asking(&peer("box", Os::Windows, true)));
    }

    /// An OS Tailscale names and this crate does not know is still a computer
    /// until proven otherwise — R-23's shape: refuse to *assume* the negative.
    #[test]
    fn an_unrecognised_os_is_asked_rather_than_assumed_useless() {
        assert!(worth_asking(&peer(
            "nas",
            Os::Other("freebsd".to_string()),
            true
        )));
    }
}
