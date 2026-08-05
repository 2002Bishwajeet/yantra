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
//!
//! **One other state hides inside that contradiction**, and it is not a death at
//! all: a fresh agent in an unseen directory holds at Claude Code's trust dialog,
//! in no registry entry and writing no transcript (I-49). The two sources say
//! exactly what they say for a silent death, so the sources cannot tell them
//! apart — the dialog still on the pane's screen can, and that is asked for only
//! once the contradiction has already happened. It fails to a fallback: a
//! reworded dialog, a pane too narrow to hold the line, or an ssh that does not
//! answer all read as [`Verdict::Unclear`], which is the verdict there was
//! before. Yantra reads that screen and never answers it (ADR-0011).

use std::collections::BTreeMap;

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
    /// The session is open and no agent was ever launched in it — a plain `up`,
    /// or a workspace whose `startup` is not an agent. **Not a failure**, and
    /// distinct from [`Verdict::Unclear`]: the pane was never asked to run one,
    /// which tmux knows because it holds the command it was given.
    NoAgent,
    /// Launched, and holding at Claude Code's trust dialog until a human answers
    /// it — no registry entry, no transcript, and no work done in between
    /// (I-49). Not running, and not a failure either.
    AwaitingTrust,
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

/// One machine's answer for every workspace that names it.
#[derive(Debug)]
pub struct MachineStatus {
    pub machine: String,
    /// Listed whether or not the machine answered, because a workspace whose
    /// machine is asleep still has to be findable by name.
    pub workspaces: Vec<Workspace>,
    /// One [`Report`] per entry of [`Self::workspaces`], in that order — or why
    /// the machine could not be asked at all.
    pub reports: Result<Vec<Report>, Error>,
}

/// What one look at the whole fleet found.
#[derive(Debug)]
pub struct Fleet {
    pub machines: Vec<MachineStatus>,
    /// A file that did not load names no machine, so it belongs to no
    /// [`MachineStatus`] — and dropping it here would leave the one class that
    /// reads a workspace's state unable to say the file exists (Y-141).
    pub unusable: Vec<workspace::Unusable>,
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

pub async fn status(name: &str) -> Result<Report, Error> {
    let workspace = workspace::load(name)?;
    let ssh = Ssh::new(ssh::machine_at(&workspace.machine).ok_or(Error::NoStateDir)?)?;
    let tmux = Tmux::resolve(&ssh).await?;
    of(&ssh, &tmux, workspace).await
}

/// Every workspace, grouped by the machine it names so a machine is reached once
/// rather than once per workspace. Machines are queried concurrently, as in
/// [`crate::sessions::list`] and for the same reason.
///
/// **The machine is the unit because that is what the round trips are** (Y-084).
/// Three of the four `of` makes are machine-scoped and only the pane query is
/// per workspace; measured warm on this fleet, the machine-scoped three cost
/// ~480 ms of which `claude agents --json` alone is ~400 ms, against ~50 ms for
/// the pane query — and that registry covers the whole machine, so asking it per
/// workspace would pay the machine's price once per workspace. The sharper form
/// is the unreachable case: `ConnectTimeout=10` is spent per *ssh invocation*
/// and `ControlMaster` caches no failure, so per-workspace would make a sleeping
/// machine cost ten seconds for each workspace that names it. Here it costs ten
/// seconds once, whatever N is.
pub async fn fleet() -> Result<Fleet, Error> {
    let listing = workspace::list()?;
    let mut by_machine: BTreeMap<String, Vec<Workspace>> = BTreeMap::new();
    for workspace in listing.workspaces {
        by_machine
            .entry(workspace.machine.clone())
            .or_default()
            .push(workspace);
    }

    let queries: Vec<_> = by_machine
        .into_iter()
        .map(|(machine, workspaces)| {
            let name = machine.clone();
            let asked = workspaces.clone();
            (
                name,
                asked,
                tokio::spawn(async move { on(machine, workspaces).await }),
            )
        })
        .collect();

    let mut answers = Vec::with_capacity(queries.len());
    for (machine, workspaces, query) in queries {
        let reports = query.await.unwrap_or_else(|joined| {
            Err(Error::Interrupted {
                machine: machine.clone(),
                reason: joined.to_string(),
            })
        });
        answers.push(MachineStatus {
            machine,
            workspaces,
            reports,
        });
    }
    Ok(Fleet {
        machines: answers,
        unusable: listing.unusable,
    })
}

/// A pane query that fails after tmux has already answered is the connection
/// rather than the workspace, so it fails the machine rather than one entry.
async fn on(machine: String, workspaces: Vec<Workspace>) -> Result<Vec<Report>, Error> {
    let ssh = Ssh::new(ssh::machine_at(&machine).ok_or(Error::NoStateDir)?)?;
    let tmux = Tmux::resolve(&ssh).await?;
    on_machine(&ssh, &tmux, workspaces).await
}

/// The testable half.
///
/// A machine with no usable `claude` is not an error here — [`Verdict`] still
/// has the pane to go on, and `status` refusing to answer because the *second*
/// opinion is missing would be worse than answering from the first.
pub async fn of<E: Exec>(exec: &E, tmux: &Tmux, workspace: Workspace) -> Result<Report, Error> {
    let registry = registry(exec).await;
    against(exec, tmux, workspace, &registry).await
}

/// Every workspace on one machine, over one connection and one registry read.
///
/// The testable half of the grouping [`fleet`] does; see there for why the
/// machine is the unit.
pub async fn on_machine<E: Exec>(
    exec: &E,
    tmux: &Tmux,
    workspaces: Vec<Workspace>,
) -> Result<Vec<Report>, Error> {
    let registry = registry(exec).await;
    let mut reports = Vec::with_capacity(workspaces.len());
    for workspace in workspaces {
        reports.push(against(exec, tmux, workspace, &registry).await?);
    }
    Ok(reports)
}

/// What `claude` believes is running on this machine, or nothing when it cannot
/// be asked — a missing second opinion is not a contradiction, so the caller
/// still has the pane to go on.
async fn registry<E: Exec>(exec: &E) -> Vec<Running> {
    match Claude::resolve(exec).await {
        Ok(claude) => claude.agents(exec).await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

async fn against<E: Exec>(
    exec: &E,
    tmux: &Tmux,
    workspace: Workspace,
    registry: &[Running],
) -> Result<Report, Error> {
    let pane = tmux.pane(exec, &workspace.name).await?;
    let repo = workspace.repo.to_string_lossy().into_owned();
    let agent = registry.iter().find(|running| running.cwd == repo).cloned();

    // Asked only where the two sources already disagree, so the extra round trip
    // buys the one verdict that has no action in it. An ssh that fails here
    // leaves that verdict exactly as it was.
    let at_trust_prompt = match &pane {
        Some(pane) if !pane.dead && agent.is_none() => tmux
            .pane_shows(exec, &pane.id, agent::TRUST_PROMPT)
            .await
            .unwrap_or(false),
        _ => false,
    };

    let verdict = verdict(pane.as_ref(), agent.is_some(), at_trust_prompt);
    Ok(Report {
        workspace,
        pane,
        agent,
        verdict,
    })
}

fn verdict(pane: Option<&Pane>, registered: bool, at_trust_prompt: bool) -> Verdict {
    let Some(pane) = pane else {
        return Verdict::NoSession;
    };
    if !pane.dead {
        // Asked only once the registry has already come back empty, so a running
        // agent is never described by what it was launched with.
        let launched_an_agent = pane
            .start_command
            .as_deref()
            .is_some_and(|started| agent::session_id_in(started).is_some());
        return match (registered, at_trust_prompt, launched_an_agent) {
            (true, _, _) => Verdict::Running,
            (false, true, _) => Verdict::AwaitingTrust,
            (false, false, false) => Verdict::NoAgent,
            (false, false, true) => Verdict::Unclear {
                because: "the pane is alive but claude knows of no agent in that directory",
            },
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

    /// The shape `agent::launch_command` builds, so a pane in these tests is one
    /// an agent was actually launched into.
    const AGENT_COMMAND: &str = "cd '/srv/repo' && exec '/usr/bin/claude' --session-id 'd4c3b2a1-0000-4000-8000-000000000000'";

    fn pane(dead: bool, status: Option<i32>, signal: Option<&str>) -> Pane {
        Pane {
            id: "%0".to_owned(),
            dead,
            status,
            signal: signal.map(str::to_owned),
            pid: if dead { None } else { Some(42) },
            start_command: Some(AGENT_COMMAND.to_owned()),
        }
    }

    #[test]
    fn an_absent_session_is_not_a_crash() {
        assert_eq!(verdict(None, false, false), Verdict::NoSession);
    }

    #[test]
    fn a_live_pane_with_a_registered_agent_is_running() {
        assert_eq!(
            verdict(Some(&pane(false, None, None)), true, false),
            Verdict::Running
        );
        assert!(Verdict::Running.is_running());
    }

    /// R-2's shape, and the reason both sources are read: something is in the
    /// pane and it is not the agent.
    #[test]
    fn a_live_pane_with_no_registered_agent_is_not_called_healthy() {
        let verdict = verdict(Some(&pane(false, None, None)), false, false);
        assert!(matches!(verdict, Verdict::Unclear { .. }), "{verdict:?}");
        assert!(
            !verdict.is_running(),
            "an unknown answer must never read as a yes"
        );
    }

    /// I-49. The two sources say the same thing here as they do one test up —
    /// only the dialog on the screen separates the two, and naming the state
    /// must not promote it to a running agent.
    #[test]
    fn a_live_pane_still_showing_the_trust_dialog_is_named_rather_than_unclear() {
        assert_eq!(
            verdict(Some(&pane(false, None, None)), false, true),
            Verdict::AwaitingTrust
        );
        assert!(
            !Verdict::AwaitingTrust.is_running(),
            "an agent that has not been let out of the dialog is doing nothing"
        );
    }

    /// The registry outranks the screen: an agent that answered the dialog
    /// leaves it drawn until something redraws over it.
    #[test]
    fn a_registered_agent_is_running_whatever_is_left_on_its_screen() {
        assert_eq!(
            verdict(Some(&pane(false, None, None)), true, true),
            Verdict::Running
        );
    }

    #[test]
    fn the_three_ways_a_pane_can_end_are_told_apart() {
        assert_eq!(
            verdict(Some(&pane(true, Some(0), None)), false, false),
            Verdict::Finished
        );
        assert_eq!(
            verdict(Some(&pane(true, Some(SIGTERM_EXIT), None)), false, false),
            Verdict::Stopped
        );
        assert_eq!(
            verdict(Some(&pane(true, Some(1), None)), false, false),
            Verdict::Crashed { status: 1 }
        );
    }

    /// The trap this module exists for. tmux leaves `pane_dead_status` empty
    /// when a signal did the killing, so anything that defaults it to zero
    /// reports a `kill -9` as a clean finish.
    #[test]
    fn a_signal_killed_pane_is_never_mistaken_for_a_clean_exit() {
        assert_eq!(
            verdict(Some(&pane(true, None, Some("KILL"))), false, false),
            Verdict::Killed {
                signal: "KILL".to_owned()
            }
        );
        assert_ne!(
            verdict(Some(&pane(true, None, Some("TERM"))), false, false),
            Verdict::Finished,
            "an unhandled SIGTERM is not the same as exiting 0"
        );
        assert_ne!(
            verdict(Some(&pane(true, None, Some("TERM"))), false, false),
            Verdict::Stopped,
            "nor the same as handling one and exiting 143"
        );
    }
}
