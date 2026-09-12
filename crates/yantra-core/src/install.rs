//! Installing what a machine needs to run a session, when a person asks
//! ([ADR-0028]).
//!
//! **Only what is missing, and only [`BASICS`]** — plus what the vendor's
//! installer needs to run, under the owner's *bare minimum* ruling (ADR-0028
//! §5's 2026-09-12 note). Each tool is looked for with the predicate `doctor`
//! reports on, so the two never disagree about what a machine has. **Root is
//! `sudo -n` and nothing more**: a sudo that wants a password stops the package
//! step and names the command for a person to run there. No password is asked
//! for, passed or stored.
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

/// What the vendor's installer needs to run, then what `claude` needs at
/// runtime on musl (code.claude.com/docs/en/setup, 2026-09-12). Package names:
/// every manager here spells `curl` and `bash` alike, and the last three are
/// Alpine's.
const PREREQUISITES: [&str; 5] = ["curl", "bash", "libgcc", "libstdc++", "ripgrep"];

/// Prints each missing prerequisite on a line of its own, and `musl` on a musl
/// system.
const MISSING_PREREQUISITES: &str = r#"command -v curl >/dev/null 2>&1 || echo curl
command -v bash >/dev/null 2>&1 || echo bash
if ls /lib/ld-musl-* >/dev/null 2>&1; then
  echo musl
  [ -e /usr/lib/libgcc_s.so.1 ] || [ -e /lib/libgcc_s.so.1 ] || echo libgcc
  [ -e /usr/lib/libstdc++.so.6 ] || echo libstdc++
  command -v rg >/dev/null 2>&1 || echo ripgrep
fi"#;

/// On musl `claude` must use the system `rg`, which the vendor's docs set in
/// `~/.claude/settings.json`. Written where no settings file exists yet; a file
/// that exists without it exits 1, because Yantra rewrites no one's settings.
const RIPGREP_SETTING: &str = r#"f="$HOME/.claude/settings.json"
if [ -e "$f" ]; then
  grep -q USE_BUILTIN_RIPGREP "$f"
else
  mkdir -p "$HOME/.claude" && printf '%s\n' '{"env":{"USE_BUILTIN_RIPGREP":"0"}}' > "$f"
fi"#;

/// `root`, `none` where there is no sudo, `sudo` where it asks for nothing, and
/// otherwise `refused` with what sudo said.
const ROOT: &str = r#"[ "$(id -u)" = 0 ] && { echo root; exit 0; }
command -v sudo >/dev/null 2>&1 || { echo none; exit 0; }
if said=$(sudo -n true 2>&1); then echo sudo; else printf 'refused %s\n' "$said"; fi"#;

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

    /// Every one runs as root except `brew`'s, which refuses root. They are
    /// joined with `;`, so one dead mirror in `apt-get update` does not stop
    /// the install from the lists already there.
    fn commands(self, names: &str) -> Vec<String> {
        match self {
            Self::AptGet => vec![
                "apt-get update".to_owned(),
                format!("apt-get install -y {names}"),
            ],
            Self::Dnf => vec![format!("dnf install -y {names}")],
            // `-y`: a stale sync database answers "target not found".
            Self::Pacman => vec![format!("pacman -Sy --needed --noconfirm {names}")],
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
    /// The installer ran and the tool is still not found, or is found and does
    /// not run. `output` is the last [`OUTPUT_CAP`] bytes of what it printed,
    /// with the terminal's escape sequences taken out.
    Failed {
        output: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Because {
    /// sudo wants a password or a terminal; the command works typed there.
    SudoAsks,
    /// sudo refused this account, so the command is for root.
    SudoRefused,
    /// There is no sudo, so the command is for root.
    NoSudo,
    NoPackageManager,
    /// macOS, and no Homebrew to install `tmux` with.
    NoHomebrew,
    /// macOS with no Homebrew and no `git`.
    NoCommandLineTools,
    /// musl, and `~/.claude/settings.json` exists without the setting the
    /// vendor's docs name.
    RipgrepSetting,
}

impl fmt::Display for Because {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::SudoAsks => {
                "the package manager needs root, and sudo asks for a password or a terminal there"
            }
            Self::SudoRefused => {
                "the package manager needs root, and sudo refused this account, so run it as root"
            }
            Self::NoSudo => "the package manager needs root, and there is no sudo, so run it as root",
            Self::NoPackageManager => {
                "there is no package manager Yantra knows: apt-get, dnf, pacman, apk, zypper or brew"
            }
            Self::NoHomebrew => "it is macOS, and there is no Homebrew to install it with",
            Self::NoCommandLineTools => {
                "it is macOS, and Apple's git comes with the Command Line Tools, whose installer \
                 is a dialog on that Mac's own screen"
            }
            Self::RipgrepSetting => {
                "claude is there, and on musl it needs `\"env\": {\"USE_BUILTIN_RIPGREP\": \"0\"}` \
                 in ~/.claude/settings.json, which already holds settings Yantra will not rewrite"
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

/// What the one package-manager run came to.
enum Packaged {
    /// Nothing needed a package.
    Nothing,
    /// It ran; the end of its output.
    Ran(String),
    /// Nothing ran, and a person has to.
    Stopped {
        because: Because,
        command: Option<String>,
    },
    /// macOS with no Homebrew.
    NoHomebrew,
}

#[derive(Debug, PartialEq, Eq)]
enum Root {
    Superuser,
    Sudo,
    Asks,
    Refused,
    NoSudo,
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

    let mut names: Vec<&'static str> = missing
        .iter()
        .filter(|tool| **tool != Tool::Claude)
        .map(|tool| tool.name())
        .collect();
    let tools = names.len();
    let mut musl = false;
    if missing.contains(&Tool::Claude) {
        let (needed, is_musl) = prerequisites(exec).await?;
        musl = is_musl;
        names.extend(needed);
    }
    // Whether the claude step waits on this package run.
    let claude_waits = names.len() > tools;
    let packaged = if names.is_empty() {
        Packaged::Nothing
    } else {
        with_packages(exec, &names).await?
    };

    let mut done = Vec::new();
    for &tool in &missing {
        let outcome = match (&packaged, tool) {
            (Packaged::Stopped { because, command }, Tool::Tmux | Tool::Git) => {
                for_you(*because, command.as_deref())
            }
            (Packaged::Stopped { because, command }, Tool::Claude) if claude_waits => {
                for_you(*because, command.as_deref())
            }
            (Packaged::NoHomebrew, Tool::Git) => {
                for_you(Because::NoCommandLineTools, Some(COMMAND_LINE_TOOLS))
            }
            (Packaged::NoHomebrew, Tool::Tmux) => {
                for_you(Because::NoHomebrew, Some(HOMEBREW_INSTALLER))
            }
            (Packaged::NoHomebrew, Tool::Claude) if claude_waits => {
                for_you(Because::NoHomebrew, Some(HOMEBREW_INSTALLER))
            }
            (_, Tool::Claude) => claude(exec, claude_installer, musl).await?,
            (Packaged::Ran(output), _) => settled(exec, tool, output).await?,
            (Packaged::Nothing, _) => settled(exec, tool, "").await?,
        };
        done.push(Step { tool, outcome });
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

fn for_you(because: Because, command: Option<&str>) -> Outcome {
    Outcome::ForYou {
        because,
        command: command.map(str::to_owned),
    }
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

async fn prerequisites<E: Exec>(exec: &E) -> Result<(Vec<&'static str>, bool), Error> {
    let out = exec.exec(MISSING_PREREQUISITES).await?;
    let said = String::from_utf8_lossy(&out.stdout);
    let said: Vec<&str> = said.lines().map(str::trim).collect();
    let needed = PREREQUISITES
        .into_iter()
        .filter(|name| said.contains(name))
        .collect();
    Ok((needed, said.contains(&"musl")))
}

async fn with_packages<E: Exec>(exec: &E, names: &[&str]) -> Result<Packaged, Error> {
    let mut manager = None;
    for candidate in Manager::ALL {
        if let Some(path) = agent::locate(exec, candidate.binary()).await? {
            manager = Some((candidate, path));
            break;
        }
    }
    let Some((manager, path)) = manager else {
        if ssh::os(exec).await? == Os::MacOs {
            return Ok(Packaged::NoHomebrew);
        }
        return Ok(Packaged::Stopped {
            because: Because::NoPackageManager,
            command: None,
        });
    };

    let names = names.join(" ");
    let commands = manager.commands(&names);
    let stopped = |because, sudo: bool| {
        let lines: Vec<String> = commands
            .iter()
            .map(|c| if sudo { format!("sudo {c}") } else { c.clone() })
            .collect();
        Ok(Packaged::Stopped {
            because,
            command: Some(lines.join("; ")),
        })
    };
    let run = if manager == Manager::Brew {
        // Its path, because `brew` is not on a non-interactive PATH (I-34).
        format!("{} install {names}", sq(&path))
    } else {
        let prefix = match root(exec).await? {
            Root::Superuser => "",
            Root::Sudo => "sudo -n ",
            Root::Asks => return stopped(Because::SudoAsks, true),
            Root::Refused => return stopped(Because::SudoRefused, false),
            Root::NoSudo => return stopped(Because::NoSudo, false),
        };
        format!(
            "{prefix}env DEBIAN_FRONTEND=noninteractive sh -c {}",
            sq(&commands.join("; "))
        )
    };
    Ok(Packaged::Ran(tail(&exec.exec(&run).await?)))
}

/// `-n` is what keeps a password out of this (ADR-0028 §5).
async fn root<E: Exec>(exec: &E) -> Result<Root, Error> {
    let out = exec.exec(ROOT).await?;
    Ok(classify(String::from_utf8_lossy(&out.stdout).trim()))
}

fn classify(said: &str) -> Root {
    match said {
        "root" => Root::Superuser,
        "sudo" => Root::Sudo,
        "none" => Root::NoSudo,
        _ => {
            // With `-n`, sudo also says "a password is required" to an account
            // it would refuse: it authenticates before it reads the policy.
            let said = said.to_lowercase();
            if said.contains("password") || said.contains("tty") || said.contains("terminal") {
                Root::Asks
            } else {
                Root::Refused
            }
        }
    }
}

/// Asked again rather than read off the exit status: an installer that exits
/// 0 and puts nothing where Yantra looks has not installed anything it can use.
async fn settled<E: Exec>(exec: &E, tool: Tool, output: &str) -> Result<Outcome, Error> {
    Ok(if found(exec, tool).await? {
        Outcome::Installed
    } else {
        Outcome::Failed {
            output: output.to_owned(),
        }
    })
}

/// A `claude` that is found and does not start — the musl libraries missing,
/// say — is `Failed`, not `Installed`.
async fn claude<E: Exec>(exec: &E, installer: &str, musl: bool) -> Result<Outcome, Error> {
    let out = exec.exec(installer).await?;
    let Some(path) = agent::locate(exec, "claude").await? else {
        return Ok(Outcome::Failed { output: tail(&out) });
    };
    let runs = exec
        .exec(&format!("{} --version >/dev/null 2>&1", sq(&path)))
        .await?;
    if !runs.success() {
        return Ok(Outcome::Failed {
            output: format!(
                "{path} is there and `claude --version` exited {}; the installer said {}",
                runs.status,
                tail(&out)
            ),
        });
    }
    if musl && !exec.exec(RIPGREP_SETTING).await?.success() {
        return Ok(for_you(Because::RipgrepSetting, None));
    }
    Ok(Outcome::Installed)
}

fn tail(out: &ssh::Output) -> String {
    let mut all = out.stdout.clone();
    all.extend_from_slice(&out.stderr);
    let text = plain(&String::from_utf8_lossy(&all));
    let mut from = text.len().saturating_sub(OUTPUT_CAP);
    while !text.is_char_boundary(from) {
        from += 1;
    }
    format!("exit {}: {}", out.status, text[from..].trim())
}

/// Without the terminal's escape sequences: a person reads them as noise, and
/// a phone draws them as boxes. A carriage return is a line of its own.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    for c in chars.by_ref() {
                        if c == '\u{7}' || c == '\u{1b}' {
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\r' => out.push('\n'),
            '\n' | '\t' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Asserted whole: the person pastes it, and the automated half is the
    /// same list with `sudo -n` in front.
    #[test]
    fn apt_updates_its_lists_and_pacman_syncs_before_they_install() {
        assert_eq!(
            Manager::AptGet.commands("tmux git"),
            ["apt-get update", "apt-get install -y tmux git"]
        );
        assert_eq!(
            Manager::Pacman.commands("tmux"),
            ["pacman -Sy --needed --noconfirm tmux"]
        );
        assert_eq!(Manager::Apk.commands("tmux"), ["apk add tmux"]);
    }

    /// Measured on Alpine 3.22's sudo: "a password is required" is also what
    /// an account with no sudoers line hears under `-n`.
    #[test]
    fn what_sudo_said_decides_whose_command_it_is() {
        assert_eq!(classify("root"), Root::Superuser);
        assert_eq!(classify("sudo"), Root::Sudo);
        assert_eq!(classify("none"), Root::NoSudo);
        assert_eq!(classify("refused sudo: a password is required"), Root::Asks);
        assert_eq!(
            classify("refused sudo: sorry, you must have a tty to run sudo"),
            Root::Asks
        );
        assert_eq!(
            classify("refused yantra is not in the sudoers file."),
            Root::Refused
        );
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
        assert!(!report(for_you(Because::SudoAsks, Some("sudo apk add git"))).complete());
        assert!(
            !report(Outcome::Failed {
                output: String::new()
            })
            .complete()
        );
    }

    #[test]
    fn the_output_kept_is_the_end_of_it_without_escapes() {
        let mut stdout = vec![b'a'; OUTPUT_CAP * 2];
        stdout.extend_from_slice(b"\x1b[1;31mE:\x1b[0m Unable\r\x1b]0;title\x07 to locate");
        let out = ssh::Output {
            status: 1,
            stdout,
            stderr: b" package tmux".to_vec(),
        };
        let kept = tail(&out);
        assert!(
            kept.len() <= OUTPUT_CAP + "exit 1: ".len(),
            "{}",
            kept.len()
        );
        assert!(
            kept.ends_with("E: Unable\n to locate package tmux"),
            "{kept:?}"
        );
    }
}
