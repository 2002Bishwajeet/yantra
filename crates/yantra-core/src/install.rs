//! Installing what a machine needs to run a session, when a person asks
//! ([ADR-0028]).
//!
//! **Only what is missing, and only [`BASICS`].** Each tool is looked for with
//! the predicate `doctor` reports on, so the two never disagree about what a
//! machine has. **Root is `sudo -n` and nothing more**: a sudo that wants a
//! password stops the package step and names the command for a person to run
//! there. No password is asked for, passed or stored. The `claude` step needs
//! no root, so it still runs.
//!
//! [ADR-0028]: ../../../docs/adr/0028-yantra-installs-the-bare-minimum-on-a-machine.md

use std::fmt;

use crate::agent;
use crate::doctor;
use crate::ssh::{self, Exec, Os, Ssh};
use crate::tmux::{self, Tmux, sq};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Tmux,
    Git,
    Claude,
}

impl Tool {
    pub fn name(self) -> &'static str {
        match self {
            Self::Tmux => "tmux",
            Self::Git => "git",
            Self::Claude => "claude",
        }
    }
}

impl fmt::Display for Tool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// The whole list ADR-0028 §1 allows, and adding an entry is a reviewed change.
pub const BASICS: [Tool; 3] = [Tool::Tmux, Tool::Git, Tool::Claude];

/// The vendor's own command, as code.claude.com/docs/en/setup printed it on
/// 2026-09-12. It writes `~/.local/bin/claude`, the first of
/// [`agent::CANDIDATES`] (I-34), and needs no root.
pub const CLAUDE_INSTALLER: &str = "curl -fsSL https://claude.ai/install.sh | bash";

/// Homebrew's own command, as brew.sh printed it on 2026-09-12. Named for a
/// person and never run: it asks for the account's password.
pub const HOMEBREW_INSTALLER: &str = r#"/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)""#;

/// Apple's `git` comes with these, and their installer is a dialog on the
/// Mac's own screen (ADR-0028 §5).
pub const COMMAND_LINE_TOOLS: &str = "xcode-select --install";

/// How much of an installer's output a report keeps: the end, where the error is.
pub const OUTPUT_CAP: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Manager {
    AptGet,
    Dnf,
    Pacman,
    Apk,
    Zypper,
    Brew,
}

impl Manager {
    /// In the order they are looked for. `brew` is last so a Linux machine
    /// that also carries Linuxbrew uses its own distribution's.
    const ALL: [Self; 6] = [
        Self::AptGet,
        Self::Dnf,
        Self::Pacman,
        Self::Apk,
        Self::Zypper,
        Self::Brew,
    ];

    fn binary(self) -> &'static str {
        match self {
            Self::AptGet => "apt-get",
            Self::Dnf => "dnf",
            Self::Pacman => "pacman",
            Self::Apk => "apk",
            Self::Zypper => "zypper",
            Self::Brew => "brew",
        }
    }

    /// Every one runs as root except `brew`'s, which refuses root.
    fn commands(self, names: &str) -> Vec<String> {
        match self {
            Self::AptGet => vec![
                "apt-get update".to_owned(),
                format!("apt-get install -y {names}"),
            ],
            Self::Dnf => vec![format!("dnf install -y {names}")],
            Self::Pacman => vec![format!("pacman -S --needed --noconfirm {names}")],
            Self::Apk => vec![format!("apk add {names}")],
            Self::Zypper => vec![format!("zypper --non-interactive install {names}")],
            Self::Brew => vec![format!("brew install {names}")],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// It was there already, so nothing ran for it.
    Present,
    Installed,
    /// Yantra stopped, and `command` is the step for a person on that machine
    /// where there is one to name.
    ForYou {
        because: Because,
        command: Option<String>,
    },
    /// The installer ran and the tool is still not found. `output` is the last
    /// [`OUTPUT_CAP`] bytes of what it printed.
    Failed {
        output: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Because {
    /// The package manager needs root and `sudo -n` refused: sudo wants a
    /// password there, or there is no sudo.
    NeedsRoot,
    NoPackageManager,
    /// macOS, and no Homebrew to install `tmux` with.
    NoHomebrew,
    /// macOS with no Homebrew and no `git`.
    NoCommandLineTools,
}

impl fmt::Display for Because {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NeedsRoot => {
                "the package manager needs root, and `sudo -n` was refused: sudo asks for a \
                 password there, or there is no sudo"
            }
            Self::NoPackageManager => {
                "there is no package manager Yantra knows: apt-get, dnf, pacman, apk, zypper or brew"
            }
            Self::NoHomebrew => "it is macOS, and there is no Homebrew to install it with",
            Self::NoCommandLineTools => {
                "it is macOS, and Apple's git comes with the Command Line Tools, whose installer \
                 is a dialog on that Mac's own screen"
            }
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub tool: Tool,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub machine: String,
    /// One per entry of [`BASICS`], in that order.
    pub steps: Vec<Step>,
}

impl Report {
    /// Whether every basic is on the machine now.
    pub fn complete(&self) -> bool {
        self.steps
            .iter()
            .all(|step| matches!(step.outcome, Outcome::Present | Outcome::Installed))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    #[error(transparent)]
    Tmux(#[from] tmux::Error),

    #[error(transparent)]
    Agent(#[from] agent::Error),

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

pub async fn install(machine: &str) -> Result<Report, Error> {
    let ssh = Ssh::new(ssh::machine_at(machine).ok_or(Error::NoStateDir)?)?;
    of(&ssh, machine, CLAUDE_INSTALLER).await
}

/// The testable half. `claude_installer` is a parameter so a container test
/// runs a local stand-in and never fetches from claude.ai.
pub async fn of<E: Exec>(exec: &E, machine: &str, claude_installer: &str) -> Result<Report, Error> {
    let mut missing = Vec::new();
    for tool in BASICS {
        if !found(exec, tool).await? {
            missing.push(tool);
        }
    }

    let packages: Vec<Tool> = missing
        .iter()
        .copied()
        .filter(|tool| *tool != Tool::Claude)
        .collect();
    let mut done = Vec::new();
    if !packages.is_empty() {
        done.extend(with_packages(exec, &packages).await?);
    }
    if missing.contains(&Tool::Claude) {
        let out = exec.exec(claude_installer).await?;
        done.push(settle(exec, Tool::Claude, &out).await?);
    }

    let steps = BASICS
        .into_iter()
        .map(|tool| {
            done.iter()
                .find(|step| step.tool == tool)
                .cloned()
                .unwrap_or(Step {
                    tool,
                    outcome: Outcome::Present,
                })
        })
        .collect();
    Ok(Report {
        machine: machine.to_owned(),
        steps,
    })
}

async fn found<E: Exec>(exec: &E, tool: Tool) -> Result<bool, Error> {
    Ok(match tool {
        Tool::Tmux => match Tmux::resolve(exec).await {
            Ok(_) => true,
            Err(tmux::Error::NotFound { .. }) => false,
            Err(error) => return Err(error.into()),
        },
        Tool::Git => doctor::find_git(exec).await?.is_some(),
        Tool::Claude => agent::locate(exec, "claude").await?.is_some(),
    })
}

async fn with_packages<E: Exec>(exec: &E, tools: &[Tool]) -> Result<Vec<Step>, Error> {
    let for_you = |because: Because, command: Option<&str>| -> Vec<Step> {
        tools
            .iter()
            .map(|&tool| Step {
                tool,
                outcome: Outcome::ForYou {
                    because,
                    command: command.map(str::to_owned),
                },
            })
            .collect()
    };

    let mut manager = None;
    for candidate in Manager::ALL {
        if let Some(path) = agent::locate(exec, candidate.binary()).await? {
            manager = Some((candidate, path));
            break;
        }
    }
    let Some((manager, path)) = manager else {
        if ssh::os(exec).await? == Os::MacOs {
            return Ok(tools
                .iter()
                .map(|&tool| {
                    let (because, command) = match tool {
                        Tool::Git => (Because::NoCommandLineTools, COMMAND_LINE_TOOLS),
                        _ => (Because::NoHomebrew, HOMEBREW_INSTALLER),
                    };
                    Step {
                        tool,
                        outcome: Outcome::ForYou {
                            because,
                            command: Some(command.to_owned()),
                        },
                    }
                })
                .collect());
        }
        return Ok(for_you(Because::NoPackageManager, None));
    };

    let names: Vec<&str> = tools.iter().map(|tool| tool.name()).collect();
    let names = names.join(" ");
    let commands = manager.commands(&names);
    let run = if manager == Manager::Brew {
        // Its path, because `brew` is not on a non-interactive PATH (I-34).
        format!("{} install {names}", sq(&path))
    } else {
        let Some(prefix) = root(exec).await? else {
            let asked: Vec<String> = commands.iter().map(|c| format!("sudo {c}")).collect();
            return Ok(for_you(Because::NeedsRoot, Some(&asked.join(" && "))));
        };
        format!(
            "{prefix}env DEBIAN_FRONTEND=noninteractive sh -c {}",
            sq(&commands.join(" && "))
        )
    };

    let out = exec.exec(&run).await?;
    let mut steps = Vec::new();
    for &tool in tools {
        steps.push(settle(exec, tool, &out).await?);
    }
    Ok(steps)
}

/// `Some("")` as root, `Some("sudo -n ")` where sudo asks for no password, and
/// `None` otherwise. `-n` is what keeps a password out of this (ADR-0028 §5).
async fn root<E: Exec>(exec: &E) -> Result<Option<&'static str>, Error> {
    let out = exec
        .exec("[ \"$(id -u)\" = 0 ] && echo root || { sudo -n true >/dev/null 2>&1 && echo sudo; }")
        .await?;
    Ok(match String::from_utf8_lossy(&out.stdout).trim() {
        "root" => Some(""),
        "sudo" => Some("sudo -n "),
        _ => None,
    })
}

/// Asked again rather than read off the exit status: an installer that exits
/// 0 and puts nothing where Yantra looks has not installed anything it can use.
async fn settle<E: Exec>(exec: &E, tool: Tool, out: &ssh::Output) -> Result<Step, Error> {
    let outcome = if found(exec, tool).await? {
        Outcome::Installed
    } else {
        Outcome::Failed { output: tail(out) }
    };
    Ok(Step { tool, outcome })
}

fn tail(out: &ssh::Output) -> String {
    let mut all = out.stdout.clone();
    all.extend_from_slice(&out.stderr);
    let from = all.len().saturating_sub(OUTPUT_CAP);
    format!(
        "exit {}: {}",
        out.status,
        String::from_utf8_lossy(&all[from..]).trim()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Asserted whole: the person pastes it, and the automated half is the
    /// same list with `sudo -n` in front.
    #[test]
    fn apt_updates_its_lists_before_it_installs() {
        assert_eq!(
            Manager::AptGet.commands("tmux git"),
            ["apt-get update", "apt-get install -y tmux git"]
        );
        assert_eq!(Manager::Apk.commands("tmux"), ["apk add tmux"]);
    }

    #[test]
    fn a_report_is_complete_only_when_nothing_is_left_for_a_person() {
        let step = |outcome| Step {
            tool: Tool::Git,
            outcome,
        };
        let report = |outcome| Report {
            machine: "pi".to_owned(),
            steps: vec![step(Outcome::Present), step(outcome)],
        };
        assert!(report(Outcome::Installed).complete());
        assert!(
            !report(Outcome::ForYou {
                because: Because::NeedsRoot,
                command: Some("sudo apk add git".to_owned()),
            })
            .complete()
        );
        assert!(
            !report(Outcome::Failed {
                output: String::new()
            })
            .complete()
        );
    }

    #[test]
    fn the_output_kept_is_the_end_of_it() {
        let out = ssh::Output {
            status: 1,
            stdout: vec![b'a'; OUTPUT_CAP * 2],
            stderr: b"E: Unable to locate package tmux".to_vec(),
        };
        let kept = tail(&out);
        assert!(
            kept.len() <= OUTPUT_CAP + "exit 1: ".len(),
            "{}",
            kept.len()
        );
        assert!(kept.ends_with("Unable to locate package tmux"), "{kept}");
    }
}
