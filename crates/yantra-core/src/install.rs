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
//! **The microphone is optional and asked for per run** ([ADR-0031] §1–3):
//! its audio packages join the same package run, and the rest is per user.
//!
//! [ADR-0028]: ../../../docs/adr/0028-yantra-installs-the-bare-minimum-on-a-machine.md
//! [ADR-0031]: ../../../docs/adr/0031-the-microphone-reaches-a-machine-as-a-virtual-source.md

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
    /// Not in [`BASICS`]: a step only when someone asks for the microphone.
    Mic,
}

impl Tool {
    pub fn name(self) -> &'static str {
        match self {
            Self::Tmux => "tmux",
            Self::Git => "git",
            Self::Claude => "claude",
            Self::Mic => "mic",
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

/// Where the kernel lists sound cards. Claude Code reads it to decide whether
/// a machine has one (R17 §1), and so does the microphone step.
pub const SOUND_CARDS: &str = "/proc/asound/cards";

/// The per-user drop-in, relative to `$HOME` (ADR-0031 §1). `doctor` asks
/// whether it is there.
pub const MIC_DROP_IN: &str = ".config/pipewire/pipewire-pulse.conf.d/yantra-mic.conf";

/// R17 §2's two modules. `media.class=Audio/Sink/Virtual` keeps the sink out of
/// WirePlumber 0.5's default-sink choice, which takes only `Audio/Sink` and
/// `Audio/Duplex` (`default-nodes/rescan.lua`); `pw-cat --target` still finds
/// it by name.
const MIC_CONFIG: &str = r#"pulse.cmd = [
  { cmd = "load-module" args = "module-null-sink sink_name=yantra-mic-sink channel_map=mono rate=48000 sink_properties='device.description=Yantra-microphone-input media.class=Audio/Sink/Virtual'" flags = [ ] }
  { cmd = "load-module" args = "module-remap-source master=yantra-mic-sink.monitor source_name=yantra-mic channel_map=mono source_properties=device.description=Yantra-microphone" flags = [ ] }
]"#;

/// Exits 0 when everything the microphone needs to run is on the machine.
/// `pipewire-alsa` is a config file rather than a command.
const AUDIO_PRESENT: &str = r#"for c in pipewire pipewire-pulse wireplumber pactl pw-cat arecord; do
  command -v "$c" >/dev/null 2>&1 || exit 1
done
[ -e /usr/share/alsa/alsa.conf.d/99-pipewire-default.conf ] || [ -e /etc/alsa/conf.d/99-pipewire-default.conf ]"#;

/// How much of an installer's output a report keeps: the end, where the error is.
pub const OUTPUT_CAP: usize = 2048;

/// What the vendor's installer needs to run, then what `claude` needs at
/// runtime on musl (code.claude.com/docs/en/setup, 2026-09-12). Package names:
/// every manager here spells `curl` and `bash` alike, and the last three are
/// Alpine's. The docs' `USE_BUILTIN_RIPGREP=0` is no package and no file:
/// [`agent`] sets it in the agent's start command on musl.
const PREREQUISITES: [&str; 5] = ["curl", "bash", "libgcc", "libstdc++", "ripgrep"];

/// Prints each missing prerequisite on a line of its own.
const MISSING_PREREQUISITES: &str = r#"command -v curl >/dev/null 2>&1 || echo curl
command -v bash >/dev/null 2>&1 || echo bash
if ls /lib/ld-musl-* >/dev/null 2>&1; then
  [ -e /usr/lib/libgcc_s.so.1 ] || [ -e /lib/libgcc_s.so.1 ] || echo libgcc
  [ -e /usr/lib/libstdc++.so.6 ] || echo libstdc++
  command -v rg >/dev/null 2>&1 || echo ripgrep
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

    /// ADR-0031 §1's set. Only apt's names were tested on a machine (R17 §2),
    /// and dnf's are what `yantrad/tests/mic.rs` installs; the rest are the
    /// same set by each distribution's own names. `brew` has none: the Mac is
    /// Y-420.
    fn audio(self) -> &'static [&'static str] {
        match self {
            Self::AptGet => &[
                "pipewire",
                "pipewire-pulse",
                "wireplumber",
                "pipewire-alsa",
                "pulseaudio-utils",
                "alsa-utils",
            ],
            // Fedora keeps `pw-cat` in `pipewire-utils`.
            Self::Dnf => &[
                "pipewire",
                "pipewire-pulseaudio",
                "wireplumber",
                "pipewire-alsa",
                "pulseaudio-utils",
                "alsa-utils",
                "pipewire-utils",
            ],
            // Arch keeps `pactl` in `libpulse`.
            Self::Pacman => &[
                "pipewire",
                "pipewire-pulse",
                "wireplumber",
                "pipewire-alsa",
                "libpulse",
                "alsa-utils",
            ],
            Self::Apk => &[
                "pipewire",
                "pipewire-pulse",
                "wireplumber",
                "pipewire-alsa",
                "pulseaudio-utils",
                "alsa-utils",
                "pipewire-tools",
            ],
            Self::Zypper => &[
                "pipewire",
                "pipewire-pulseaudio",
                "wireplumber",
                "pipewire-alsa",
                "pulseaudio-utils",
                "alsa-utils",
                "pipewire-tools",
            ],
            Self::Brew => &[],
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
    /// The microphone, asked for on a Mac.
    MicOnMacOs,
}

impl fmt::Display for Because {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::SudoAsks => "it needs root, and sudo asks for a password or a terminal there",
            Self::SudoRefused => "it needs root, and sudo refused this account, so run it as root",
            Self::NoSudo => "it needs root, and there is no sudo, so run it as root",
            Self::NoPackageManager => {
                "there is no package manager Yantra knows: apt-get, dnf, pacman, apk, zypper or brew"
            }
            Self::NoHomebrew => "it is macOS, and there is no Homebrew to install it with",
            Self::NoCommandLineTools => {
                "it is macOS, and Apple's git comes with the Command Line Tools, whose installer \
                 is a dialog on that Mac's own screen"
            }
            Self::MicOnMacOs => "Yantra sets up the microphone on Linux only so far",
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
    /// One per entry of [`BASICS`], in that order, then [`Tool::Mic`] when it
    /// was asked for.
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

    #[error(
        "`{machine}` is not a machine name Yantra passes to ssh: dot-separated labels of letters, \
         digits and `-`, none starting with `-`, each at most 63 characters and 253 in all"
    )]
    InvalidMachine { machine: String },
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

/// A name is a request value, and it becomes `ssh`'s destination argument
/// (ADR-0009), so it must be a hostname and nothing more: PR #302's label
/// rule, with dots between labels.
pub fn check_machine(machine: &str) -> Result<(), Error> {
    let label = |label: &str| {
        (1..=63).contains(&label.len())
            && !label.starts_with('-')
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    };
    if machine.len() <= 253 && machine.split('.').all(label) {
        Ok(())
    } else {
        Err(Error::InvalidMachine {
            machine: machine.to_owned(),
        })
    }
}

pub async fn install(machine: &str, mic: bool) -> Result<Report, Error> {
    check_machine(machine)?;
    let ssh = Ssh::new(ssh::machine_at(machine).ok_or(Error::NoStateDir)?)?;
    of(&ssh, machine, CLAUDE_INSTALLER, mic.then_some(SOUND_CARDS)).await
}

/// The testable half. `claude_installer` is a parameter so a container test
/// runs a local stand-in and never fetches from claude.ai. `mic` is the sound
/// card list to read when the microphone is asked for, for the same reason.
pub async fn of<E: Exec>(
    exec: &E,
    machine: &str,
    claude_installer: &str,
    mic: Option<&str>,
) -> Result<Report, Error> {
    let mut missing = Vec::new();
    for tool in BASICS {
        if !found(exec, tool).await? {
            missing.push(tool);
        }
    }

    let on_mac = mic.is_some() && ssh::os(exec).await? == Os::MacOs;
    if mic.is_some() && !on_mac && !found(exec, Tool::Mic).await? {
        missing.push(Tool::Mic);
    }
    let audio = missing.contains(&Tool::Mic);

    let mut names: Vec<&'static str> = missing
        .iter()
        .filter(|tool| !matches!(tool, Tool::Claude | Tool::Mic))
        .map(|tool| tool.name())
        .collect();
    let tools = names.len();
    if missing.contains(&Tool::Claude) {
        names.extend(prerequisites(exec).await?);
    }
    // Whether the claude step waits on this package run.
    let claude_waits = names.len() > tools;
    let packaged = if names.is_empty() && !audio {
        Packaged::Nothing
    } else {
        with_packages(exec, &names, audio).await?
    };

    let mut done = Vec::new();
    for &tool in &missing {
        let outcome = match (&packaged, tool) {
            (Packaged::Stopped { because, command }, Tool::Tmux | Tool::Git | Tool::Mic) => {
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
            (Packaged::NoHomebrew, Tool::Mic) => for_you(Because::MicOnMacOs, None),
            (_, Tool::Claude) => claude(exec, claude_installer).await?,
            (Packaged::Ran(output), _) => settled(exec, tool, output).await?,
            (Packaged::Nothing, _) => settled(exec, tool, "").await?,
        };
        done.push(Step { tool, outcome });
    }

    let mut steps: Vec<Step> = BASICS
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
    if let Some(cards) = mic {
        let packages = done.iter().find(|step| step.tool == Tool::Mic);
        let outcome = match packages.map(|step| &step.outcome) {
            _ if on_mac => for_you(Because::MicOnMacOs, None),
            None | Some(Outcome::Installed) => set_up_mic(exec, cards).await?,
            Some(left) => left.clone(),
        };
        steps.push(Step {
            tool: Tool::Mic,
            outcome,
        });
    }
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
        // Its packages; the rest is per user and [`set_up_mic`]'s.
        Tool::Mic => exec.exec(AUDIO_PRESENT).await?.success(),
    })
}

async fn prerequisites<E: Exec>(exec: &E) -> Result<Vec<&'static str>, Error> {
    let out = exec.exec(MISSING_PREREQUISITES).await?;
    let said = String::from_utf8_lossy(&out.stdout);
    let said: Vec<&str> = said.lines().map(str::trim).collect();
    Ok(PREREQUISITES
        .into_iter()
        .filter(|name| said.contains(name))
        .collect())
}

/// `audio` adds the microphone's packages, by this manager's names.
async fn with_packages<E: Exec>(exec: &E, names: &[&str], audio: bool) -> Result<Packaged, Error> {
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

    let mut names = names.to_vec();
    if audio {
        names.extend(manager.audio());
    }
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

/// ADR-0031 §1–3 after the packages: linger, the drop-in and the source, then
/// the default source on a machine with no card. Linger comes first so the
/// user manager runs whatever the login was. A linger step left for a person
/// is the outcome even when the rest worked: without it the microphone stops
/// at logout. `Present` when every part was there already (§B4).
async fn set_up_mic<E: Exec>(exec: &E, cards: &str) -> Result<Outcome, Error> {
    let (left, mut changed) = match linger(exec).await? {
        Ok(changed) => (None, changed),
        Err(Outcome::Failed { output }) => return Ok(Outcome::Failed { output }),
        Err(left) => (Some(left), false),
    };

    let out = exec.exec(&configure_mic()).await?;
    let set = if !out.success() {
        Outcome::Failed { output: tail(&out) }
    } else {
        changed |= String::from_utf8_lossy(&out.stdout).trim() != "unchanged";
        let listed = exec.exec(&format!("cat {} 2>/dev/null", sq(cards))).await?;
        if has_card(&String::from_utf8_lossy(&listed.stdout)) {
            settled_mic(changed)
        } else {
            let out = exec.exec(DEFAULT_SOURCE).await?;
            if out.success() {
                changed |= String::from_utf8_lossy(&out.stdout).trim() != "unchanged";
                settled_mic(changed)
            } else {
                Outcome::Failed { output: tail(&out) }
            }
        }
    };
    Ok(left.unwrap_or(set))
}

fn settled_mic(changed: bool) -> Outcome {
    if changed {
        Outcome::Installed
    } else {
        Outcome::Present
    }
}

/// `Ok(changed)` when linger is on now, and otherwise the step for a person,
/// or `Failed` when `sudo -n` ran and loginctl refused.
async fn linger<E: Exec>(exec: &E) -> Result<Result<bool, Outcome>, Error> {
    let out = exec.exec(LINGER).await?;
    let said = String::from_utf8_lossy(&out.stdout);
    let mut lines = said.lines().map(str::trim);
    let user = lines.next().unwrap_or_default();
    if lines.next() == Some("yes") {
        return Ok(Ok(false));
    }
    let command = format!("loginctl enable-linger {}", word(user));
    let prefix = match root(exec).await? {
        Root::Superuser => "",
        Root::Sudo => "sudo -n ",
        Root::Asks => {
            return Ok(Err(for_you(
                Because::SudoAsks,
                Some(&format!("sudo {command}")),
            )));
        }
        Root::Refused => return Ok(Err(for_you(Because::SudoRefused, Some(&command)))),
        Root::NoSudo => return Ok(Err(for_you(Because::NoSudo, Some(&command)))),
    };
    let out = exec.exec(&format!("{prefix}{command}")).await?;
    if !out.success() {
        return Ok(Err(Outcome::Failed { output: tail(&out) }));
    }
    Ok(Ok(true))
}

/// Overwrites the drop-in rather than appending to it, and restarts
/// `pipewire-pulse` only when the file changed or the source is missing, so a
/// second run interrupts no stream. Prints `changed` or `unchanged`. PipeWire
/// listens in the runtime directory, which a command over ssh may not have in
/// its environment (R17 §2), and which linger just enabled may not have made
/// yet.
fn configure_mic() -> String {
    format!(
        r#"export XDG_RUNTIME_DIR=/run/user/$(id -u)
f="$HOME/{MIC_DROP_IN}"
want={config}
heard() {{ pactl list short sources 2>/dev/null | cut -f2 | grep -qx yantra-mic; }}
if [ "$(cat "$f" 2>/dev/null)" = "$want" ] && heard; then echo unchanged; exit 0; fi
mkdir -p "${{f%/*}}" && printf '%s\n' "$want" > "$f" || exit 1
i=0
while [ ! -S "$XDG_RUNTIME_DIR/systemd/private" ] && [ "$i" -lt 50 ]; do
  sleep 0.2
  i=$((i + 1))
done
systemctl --user daemon-reload
systemctl --user restart pipewire-pulse.service || exit 1
i=0
while [ "$i" -lt 50 ]; do
  heard && {{ echo changed; exit 0; }}
  sleep 0.2
  i=$((i + 1))
done
echo "PipeWire made no yantra-mic within 10 seconds. pactl lists:"
pactl list short sources 2>&1
exit 1"#,
        config = sq(MIC_CONFIG),
    )
}

/// ADR-0031 §3 as amended 2026-10-05: only where there is no card. With no
/// card WirePlumber already picks `yantra-mic` itself, so the test is the
/// configured choice, which `get-default-source` does not show.
const DEFAULT_SOURCE: &str = r#"export XDG_RUNTIME_DIR=/run/user/$(id -u)
pw-metadata -n default 0 default.configured.audio.source 2>/dev/null | grep -q '"yantra-mic"' && { echo unchanged; exit 0; }
pactl set-default-source yantra-mic && echo changed"#;

/// The account, then whether systemd keeps its services with nobody logged in.
const LINGER: &str = r#"u=$(id -un)
printf '%s
' "$u"
loginctl show-user "$u" -p Linger --value 2>/dev/null"#;

/// Claude Code's own test (R17 §1): a list that is missing, empty or says
/// `no soundcards` is a machine with no card.
fn has_card(cards: &str) -> bool {
    let cards = cards.trim();
    !cards.is_empty() && !cards.contains("no soundcards")
}

/// An account name as it goes into a command a person runs: bare when it is
/// one plain word, quoted otherwise.
fn word(name: &str) -> String {
    let plain = !name.is_empty()
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if plain { name.to_owned() } else { sq(name) }
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
async fn claude<E: Exec>(exec: &E, installer: &str) -> Result<Outcome, Error> {
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

    /// ADR-0031 §1: the audio set joins the basics in the one package run.
    #[test]
    fn the_microphone_packages_have_each_managers_names() {
        assert_eq!(
            Manager::AptGet.commands(&Manager::AptGet.audio().join(" ")),
            [
                "apt-get update",
                "apt-get install -y pipewire pipewire-pulse wireplumber pipewire-alsa \
                 pulseaudio-utils alsa-utils"
            ]
        );
        assert_eq!(
            Manager::Dnf.commands(&Manager::Dnf.audio().join(" ")),
            [
                "dnf install -y pipewire pipewire-pulseaudio wireplumber pipewire-alsa \
              pulseaudio-utils alsa-utils pipewire-utils"
            ]
        );
        assert!(Manager::Pacman.audio().contains(&"libpulse"));
        assert!(Manager::Brew.audio().is_empty());
    }

    /// R17 §1, Claude Code's test for a card, on each shape the file takes.
    #[test]
    fn a_machine_without_a_card_is_told_from_one_with_a_card() {
        assert!(!has_card(""), "missing: `cat` printed nothing");
        assert!(!has_card("\n"), "empty");
        assert!(!has_card("--- no soundcards ---\n"));
        assert!(has_card(
            " 0 [PCH            ]: HDA-Intel - HDA Intel PCH\n                      \
             HDA Intel PCH at 0xf7f10000 irq 32\n"
        ));
    }

    /// The drop-in is overwritten, never appended to, and it names the two
    /// nodes ADR-0031 §5 writes to and records from.
    #[test]
    fn the_drop_in_is_written_whole() {
        let script = configure_mic();
        assert!(script.contains(r#"> "$f""#), "{script}");
        assert!(!script.contains(">>"), "{script}");
        assert!(MIC_CONFIG.contains("sink_name=yantra-mic-sink"));
        assert!(MIC_CONFIG.contains("source_name=yantra-mic "));
        assert!(MIC_CONFIG.contains("media.class=Audio/Sink/Virtual"));
    }

    #[test]
    fn an_account_name_reaches_the_command_as_one_word() {
        assert_eq!(word("deploy"), "deploy");
        assert_eq!(word("first.last"), "first.last");
        assert_eq!(word("a b"), "'a b'");
        assert_eq!(word("-x"), "'-x'");
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

    /// The name reaches `ssh`'s argv, so anything that could be read as an
    /// option, a second word or a `Host` pattern is refused.
    #[test]
    fn a_machine_name_is_a_hostname_and_nothing_more() {
        for good in ["pi", "a", "cachyos-g14", "pi.tailnet.ts.net"] {
            assert!(check_machine(good).is_ok(), "{good}");
        }
        let long = "a".repeat(64);
        for bad in [
            "",
            "-oProxyCommand=id",
            "a b",
            "pi\nid",
            "pi;id",
            "user@pi",
            "*",
            "pi..x",
            "pi.",
            ".pi",
            "pi_x",
            long.as_str(),
        ] {
            assert!(
                matches!(check_machine(bad), Err(Error::InvalidMachine { .. })),
                "{bad:?} must be refused"
            );
        }
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
