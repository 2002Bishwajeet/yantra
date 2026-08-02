//! `yantra` — the command-line client.
//!
//! The CLI is the daemon's first client and its honesty check: anything the web
//! UI can do must be expressible here first. It calls `yantra-core` in-process
//! today and becomes an HTTP client of `yantrad` in M2 (ADR-0005), which is a
//! change of *where* the work is called from, not *what* it does.

use clap::{CommandFactory as _, Parser, Subcommand};
use std::io::IsTerminal as _;
use std::process::ExitCode;
use yantra_core::agent;
use yantra_core::attach;
use yantra_core::inventory::{Inventory as _, MachineInfo, Tailscale};
use yantra_core::logs;
use yantra_core::resume;
use yantra_core::sessions::{self, MachineSessions};
use yantra_core::status::Verdict;
use yantra_core::terminfo::{self, Chosen};
use yantra_core::up;
use yantra_core::workspace::{self, Workspace};

#[derive(Debug, Parser)]
#[command(
    name = "yantra",
    version,
    about = "a personal developer control plane",
    after_help = "Workspaces live in ~/.config/yantra/workspaces/<name>.toml"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Open a workspace and its tmux session
    Up {
        /// Workspace name, without the `.toml`
        workspace: String,
        /// Start a coding agent in the session
        #[arg(long, value_enum)]
        agent: Option<AgentArg>,
    },
    /// Attach this terminal to a workspace's session
    Attach {
        /// Workspace name, without the `.toml`
        workspace: String,
    },
    /// Start the agent again on the conversation it left off
    Resume {
        /// Workspace name, without the `.toml`
        workspace: String,
    },
    /// Show what the workspace's agent has been saying
    Logs {
        /// Workspace name, without the `.toml`
        workspace: String,
        /// How many turns to show
        #[arg(short = 'n', long, default_value_t = 20)]
        lines: usize,
    },
    /// Say whether the workspace's agent is running, finished or crashed
    Status {
        /// Workspace name, without the `.toml`
        workspace: String,
    },
    /// Stop the workspace's session, giving the agent a chance to shut down
    Down {
        /// Workspace name, without the `.toml`
        workspace: String,
    },
    /// List what Yantra can see
    Ls {
        #[command(subcommand)]
        target: LsTarget,
    },
    /// Teach a machine about the terminal you are sitting at
    FixTerminfo {
        /// ssh destination, spelled the way a workspace's `machine` spells it
        machine: String,
    },
}

/// Spelled out rather than a bare bool so that adding a second agent is a new
/// variant, not a new flag — even though the guardrail says that day is far off.
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
enum AgentArg {
    Claude,
}

#[derive(Debug, Subcommand)]
enum LsTarget {
    /// Machines in the tailnet
    Machines,
    /// tmux sessions on the machines your workspaces name
    Sessions,
    /// Workspaces defined in ~/.config/yantra/workspaces
    Workspaces,
}

#[tokio::main]
async fn main() -> ExitCode {
    match Cli::parse().command {
        Some(Command::Up { workspace, agent }) => up(&workspace, agent).await,
        Some(Command::Attach { workspace }) => attach(&workspace).await,
        Some(Command::Resume { workspace }) => resume(&workspace).await,
        Some(Command::Logs { workspace, lines }) => show_logs(&workspace, lines).await,
        Some(Command::Status { workspace }) => show_status(&workspace).await,
        Some(Command::Down { workspace }) => down(&workspace).await,
        Some(Command::Ls {
            target: LsTarget::Machines,
        }) => ls_machines().await,
        Some(Command::Ls {
            target: LsTarget::Sessions,
        }) => ls_sessions().await,
        Some(Command::Ls {
            target: LsTarget::Workspaces,
        }) => ls_workspaces(),
        Some(Command::FixTerminfo { machine }) => fix_terminfo(&machine).await,
        // clap would make a bare `yantra` an error exiting 2. It printed help
        // and exited 0 before this crate had a parser, and that is the contract.
        None => match Cli::command().print_help() {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("yantra: {err}");
                ExitCode::FAILURE
            }
        },
    }
}

async fn up(name: &str, agent: Option<AgentArg>) -> ExitCode {
    let agent = agent.map(|AgentArg::Claude| up::Agent::Claude);
    match up::up(name, &local_term(), agent).await {
        Ok(report) => {
            let session = report.opened.session();
            let verb = if report.opened.was_created() {
                "opened"
            } else {
                "attached to"
            };
            let machine = &report.workspace.machine;
            println!("{verb} {} on {machine}", report.workspace.name);
            if let Some(launch) = &report.launched {
                println!("  agent:  claude, session {}", launch.session_id);
            } else if agent.is_some() {
                println!("  agent:  already running in that session, left alone");
            }
            println!(
                "  attach: {}",
                attach_hint(
                    machine,
                    report.tmux.path(),
                    &session.name,
                    report.term.term()
                )
            );
            if let Chosen::Substituted { wanted } = &report.term {
                println!("{}", downgrade_notice(machine, wanted));
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            report_error(&err);
            if matches!(err, up::Error::Agent(agent::Error::NotLoggedIn { .. })) {
                eprintln!("{KEYCHAIN_NOTE}");
            }
            ExitCode::FAILURE
        }
    }
}

async fn resume(name: &str) -> ExitCode {
    match resume::resume(name, &local_term()).await {
        Ok(report) => {
            let machine = &report.workspace.machine;
            match &report.outcome {
                resume::Outcome::Resumed(launch) => {
                    println!("resumed {} on {machine}", report.workspace.name);
                    println!(
                        "  agent:  claude, session {}, continuing the last conversation in {}",
                        launch.session_id,
                        report.workspace.repo.display()
                    );
                }
                // Not an error: an agent that is already working is the state
                // the user was asking for, and starting a second is the bug.
                resume::Outcome::AlreadyRunning => println!(
                    "{} on {machine} already has an agent running, left alone",
                    report.workspace.name
                ),
            }
            println!(
                "  attach: {}",
                attach_hint(
                    machine,
                    report.tmux.path(),
                    &report.workspace.name,
                    report.term.term()
                )
            );
            if let Chosen::Substituted { wanted } = &report.term {
                println!("{}", downgrade_notice(machine, wanted));
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            report_error(&err);
            match err {
                resume::Error::AwaitingTrust { .. } => eprintln!("{}", trust_note(name)),
                resume::Error::NoAgent { .. } => eprintln!("{}", no_agent_note(name)),
                resume::Error::Agent(agent::Error::NotLoggedIn { .. }) => {
                    eprintln!("{KEYCHAIN_NOTE}");
                }
                _ => {}
            }
            ExitCode::FAILURE
        }
    }
}

/// I-44, in the one place someone meets it. Without this the message reads as
/// nonsense on a Mac where `claude` works perfectly in a terminal — which is
/// every Mac, because the keychain is reachable there and not over ssh.
const KEYCHAIN_NOTE: &str = "\
\x20 note: on macOS the agent's token lives in the login keychain, which a process
        launched over ssh cannot read — so a machine that works when you sit at
        it still answers `not logged in` here. check with:
          ssh <machine> claude auth status";

async fn show_logs(name: &str, lines: usize) -> ExitCode {
    match logs::logs(name, lines).await {
        Ok(transcript) => {
            print!("{}", render_logs(&transcript));
            ExitCode::SUCCESS
        }
        Err(err) => {
            report_error(&err);
            if matches!(err, logs::Error::NoTranscript { .. }) {
                eprintln!("{}", transcript_note(name));
            }
            ExitCode::FAILURE
        }
    }
}

/// I-49: an agent that was launched and never spoken to has no transcript, and
/// one still at the trust prompt never got that far — two states this error
/// cannot tell apart, and `status` can.
fn transcript_note(workspace: &str) -> String {
    format!(
        "\x20 note: a fresh agent has none yet, and one waiting at claude's trust prompt\n\
         \x20       never gets that far. which of those it is:\n\
         \x20         yantra status {workspace}"
    )
}

fn render_logs(transcript: &logs::Transcript) -> String {
    let mut out = format!(
        "transcript: {}\nlast write: {}\n\n",
        transcript.path,
        ago(transcript.idle_for())
    );
    if transcript.entries.is_empty() {
        out.push_str("nothing has been said in this session yet\n");
        return out;
    }

    for entry in &transcript.entries {
        let who = match entry.who {
            logs::Who::User => "you",
            logs::Who::Assistant => "claude",
        };
        out.push_str(&format!(
            "{:<9}  {who:<6}  ",
            time_of_day(entry.at.as_deref())
        ));
        // Continuations line up under the first line rather than under the
        // clock, so a wrapped paragraph still reads as one turn.
        out.push_str(&entry.text.replace('\n', "\n                   "));
        out.push('\n');
        if !entry.tools.is_empty() {
            out.push_str(&format!(
                "                   tools: {}\n",
                entry.tools.join(", ")
            ));
        }
    }
    out
}

/// The clock part of an ISO-8601 instant, labelled `Z`: the transcript is
/// written in UTC on the agent's machine, and an unlabelled `21:52:48` reads as
/// the reader's own clock while being hours from it.
///
/// The label is appended rather than sliced, because the zone designator sits
/// after a fractional-second field that is present or absent at the writer's
/// discretion. `get` rather than a slice because the field is someone else's
/// and a short string must not take the process down.
fn time_of_day(at: Option<&str>) -> String {
    at.and_then(|at| at.get(11..19))
        .map(|clock| format!("{clock}Z"))
        .unwrap_or_default()
}

fn ago(seconds: i64) -> String {
    match seconds {
        s if s < 60 => format!("{s}s ago"),
        s if s < 3600 => format!("{}m ago", s / 60),
        s if s < 86_400 => format!("{}h ago", s / 3600),
        s => format!("{}d ago", s / 86_400),
    }
}

async fn show_status(name: &str) -> ExitCode {
    match yantra_core::status::status(name).await {
        Ok(report) => {
            println!("{} on {}", report.workspace.name, report.workspace.machine);
            println!("  state:  {}", describe(&report.verdict));
            if let Some(agent) = &report.agent {
                println!(
                    "  agent:  claude, session {}, pid {}",
                    agent.session_id, agent.pid
                );
            }
            if report.verdict == Verdict::AwaitingTrust {
                println!("{}", trust_note(&report.workspace.name));
            }
            // Non-zero when nothing is running, so `yantra status x && …` means
            // what it looks like it means in a shell.
            if report.verdict.is_running() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(err) => {
            report_error(&err);
            ExitCode::FAILURE
        }
    }
}

async fn down(name: &str) -> ExitCode {
    match yantra_core::down::down(name).await {
        Ok(report) => {
            let machine = &report.workspace.machine;
            if report.stopped {
                println!("stopped {} on {machine}", report.workspace.name);
                // What it was doing when it was stopped, which is only knowable
                // before the session is destroyed and is gone by now. Absent for
                // a session that held no agent, which has no ending to report.
                if let Some(ending) = &report.ending {
                    println!("  agent:  {}", describe(ending));
                }
            } else {
                println!("{} was not running on {machine}", report.workspace.name);
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            report_error(&err);
            ExitCode::FAILURE
        }
    }
}

fn describe(verdict: &Verdict) -> String {
    match verdict {
        Verdict::NoSession => "no session on that machine".to_owned(),
        Verdict::Running => "running".to_owned(),
        Verdict::Finished => "finished (exit 0)".to_owned(),
        Verdict::Stopped => "stopped cleanly (exit 143)".to_owned(),
        Verdict::Crashed { status } => format!("crashed (exit {status})"),
        Verdict::Killed { signal } => {
            format!("killed by SIG{signal}, so it ran no shutdown of its own")
        }
        Verdict::AwaitingTrust => {
            "waiting at claude's trust prompt, so it has done nothing yet".to_owned()
        }
        Verdict::NoAgent => "no agent — the session was opened as a shell".to_owned(),
        Verdict::Unclear { because } => format!("unclear — {because}"),
    }
}

/// `resume` will not start a first agent, because that is `up --agent` and the
/// session already holds a shell someone may be working in.
fn no_agent_note(workspace: &str) -> String {
    format!(
        "\x20 note: resume continues a conversation, and this session never had one.\n\
         \x20       to start an agent in it:\n\
         \x20         yantra up {workspace} --agent claude"
    )
}

/// I-49 at the one place someone meets it. The state is only legible if it says
/// who has to act, and ADR-0011 means that is never Yantra: it sends the agent no
/// input, so the dialog is answered by a person or not at all.
fn trust_note(workspace: &str) -> String {
    format!(
        "\x20 note: the first run in a directory asks whether you trust it, and the agent\n\
         \x20       does nothing at all until a human answers — yantra never answers it\n\
         \x20       for you. this prints the command that attaches:\n\
         \x20         yantra up {workspace}\n\
         \x20       then choose `Yes, I trust this folder`."
    )
}

/// The terminal the user is sitting at. Unset under cron and in CI, which is
/// not an error — it is the same case as a terminal the far side never heard of.
fn local_term() -> String {
    std::env::var("TERM").unwrap_or_else(|_| terminfo::FALLBACK.to_owned())
}

/// Names the loss and the one command that ends it. Printing a shell pipeline
/// to paste would work too; this way the error handling is Yantra's.
fn downgrade_notice(machine: &str, wanted: &str) -> String {
    format!(
        "  note: {machine} has no `{wanted}`, so the attach above uses `{}`.\n\
         \x20       colour depth and styled underlines are what that costs.\n\
         \x20       fix it once with: yantra fix-terminfo {machine}",
        terminfo::FALLBACK
    )
}

async fn fix_terminfo(machine: &str) -> ExitCode {
    let term = local_term();
    match terminfo::install_on(machine, &term).await {
        Ok(installed) => {
            println!("installed {} on {machine}", installed.term);
            // `tic` accepts entries it is unhappy about, and the machines here
            // are ten ncurses releases apart, so what it said is worth showing.
            if !installed.warnings.is_empty() {
                println!("  tic said: {}", installed.warnings);
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            report_error(&err);
            ExitCode::FAILURE
        }
    }
}

async fn ls_machines() -> ExitCode {
    match Tailscale.machines().await {
        Ok(machines) => {
            print!("{}", render_machines(&machines));
            ExitCode::SUCCESS
        }
        Err(err) => {
            report_error(&err);
            ExitCode::FAILURE
        }
    }
}

async fn ls_sessions() -> ExitCode {
    match sessions::list().await {
        Ok(machines) => {
            print!("{}", render_sessions(&machines));
            // Non-zero on a partial answer: the table is still printed, but a
            // caller must be able to tell it is incomplete.
            let complete = machines.iter().all(|m| m.sessions.is_ok());
            if complete {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(err) => {
            report_error(&err);
            ExitCode::FAILURE
        }
    }
}

/// The same `workspace::list()` the daemon's `/api/workspaces` serves, called
/// in-process — ADR-0012 keeps the CLI a caller of the library rather than a
/// client of the daemon, so this works with no `yantrad` running.
fn ls_workspaces() -> ExitCode {
    match workspace::list() {
        Ok(workspaces) => {
            print!("{}", render_workspaces(&workspaces));
            ExitCode::SUCCESS
        }
        Err(err) => {
            report_error(&err);
            ExitCode::FAILURE
        }
    }
}

fn render_workspaces(workspaces: &[Workspace]) -> String {
    if workspaces.is_empty() {
        return format!(
            "no workspaces yet — make one at {}/<name>.toml\n",
            workspace::workspaces_dir()
                .map(|dir| dir.display().to_string())
                .unwrap_or_else(|_| "~/.config/yantra/workspaces".to_owned())
        );
    }

    let rows: Vec<Vec<String>> = workspaces
        .iter()
        .map(|workspace| {
            vec![
                workspace.name.clone(),
                workspace.machine.clone(),
                workspace.repo.display().to_string(),
                workspace.startup.clone().unwrap_or_default(),
            ]
        })
        .collect();

    let mut out = table(&["WORKSPACE", "MACHINE", "REPO", "STARTUP"], &rows);
    out.push_str(&format!(
        "\n{} workspace{}\n",
        workspaces.len(),
        if workspaces.len() == 1 { "" } else { "s" }
    ));
    out
}

fn render_sessions(machines: &[MachineSessions]) -> String {
    let rows: Vec<Vec<String>> = machines
        .iter()
        .filter_map(|machine| {
            machine
                .sessions
                .as_ref()
                .ok()
                .map(|s| (&machine.machine, s))
        })
        .flat_map(|(name, sessions)| {
            sessions.iter().map(move |session| {
                vec![
                    name.clone(),
                    session.name.clone(),
                    session.windows.to_string(),
                    session.attached.to_string(),
                    session.created.clone(),
                ]
            })
        })
        .collect();

    let mut out = if rows.is_empty() {
        String::new()
    } else {
        table(
            &["MACHINE", "SESSION", "WINDOWS", "ATTACHED", "CREATED"],
            &rows,
        )
    };

    let answered = machines.iter().filter(|m| m.sessions.is_ok()).count();
    out.push_str(&format!(
        "\n{} session{} on {answered} of {} machines\n",
        rows.len(),
        if rows.len() == 1 { "" } else { "s" },
        machines.len()
    ));

    for machine in machines.iter().filter(|m| m.sessions.is_err()) {
        if let Err(err) = &machine.sessions {
            out.push_str(&format!("  {} unreachable: {err}\n", machine.machine));
        }
    }
    out
}

/// The tailnet as a table. Advisory only — ADR-0009 keeps `~/.ssh/config`
/// authoritative over what a name means, so this reports and never gates.
fn render_machines(machines: &[MachineInfo]) -> String {
    let rows: Vec<Vec<String>> = machines.iter().map(row).collect();
    let mut out = table(&["MACHINE", "OS", "STATUS", "LAST SEEN"], &rows);

    // Counting *online* is what stops the dual boot reading as two, without
    // guessing which nodes share a box — `HostName` would pair the phones too.
    let online = machines.iter().filter(|m| m.online).count();
    out.push_str(&format!("\n{} machines, {online} online\n", machines.len()));
    out
}

fn row(machine: &MachineInfo) -> Vec<String> {
    vec![
        machine.name.clone(),
        machine.os.to_string(),
        status(machine),
        // I-39: on an online peer `LastSeen` is noise — it may hold a real
        // timestamp or the zero time, and neither reports reachability.
        if machine.online {
            String::new()
        } else {
            machine.last_seen.clone().unwrap_or_default()
        },
    ]
}

/// I-39: expired is a third state — the node cannot re-authenticate itself.
fn status(machine: &MachineInfo) -> String {
    let reachable = if machine.online { "online" } else { "offline" };
    if machine.expired {
        format!("{reachable}, key expired")
    } else {
        reachable.to_string()
    }
}

/// Column-aligned, no line ending in whitespace.
fn table(headings: &[&str], rows: &[Vec<String>]) -> String {
    let mut widths: Vec<usize> = headings.iter().map(|h| h.chars().count()).collect();
    for row in rows {
        for (width, cell) in widths.iter_mut().zip(row) {
            *width = (*width).max(cell.chars().count());
        }
    }

    let headings: Vec<String> = headings.iter().map(|h| (*h).to_owned()).collect();
    let mut out = String::new();
    for row in std::iter::once(&headings).chain(rows) {
        let padded: Vec<String> = row
            .iter()
            .zip(&widths)
            .map(|(cell, width)| format!("{cell:<width$}", width = *width))
            .collect();
        out.push_str(padded.join("  ").trim_end());
        out.push('\n');
    }
    out
}

/// Every part is load-bearing: the session is remote, the login shell cannot
/// find tmux (I-34), `-t` forwards a `TERM` the far side may lack (I-36), and
/// zsh eats an unquoted `=name` (I-35). `term` is already known to be one the
/// far side has, so setting it here is passing through rather than pinning.
///
/// The remote half comes from the library so that what a user copies and what
/// `yantra attach` runs cannot drift apart.
fn attach_hint(machine: &str, tmux: &str, session: &str, term: &str) -> String {
    format!(
        "ssh {machine} -t \"{}\"",
        attach::remote_command(tmux, session, term)
    )
}

/// **This command does not return.** `exec` replaces the process with `ssh`, so
/// from here on the exit code, the signals and the terminal are `ssh`'s and
/// tmux's — which is the whole point, and the reason `attach` is the one verb
/// outside the exit-code contract in this crate's notes.
///
/// `exec` rather than spawn-and-wait deliberately: a supervising parent would
/// have to forward `SIGWINCH`, relay signals and reap a child, all to add
/// nothing. Replacing the image means there is no parent to get any of it wrong.
#[cfg(unix)]
fn hand_over(machine: &str, remote: &str) -> ExitCode {
    use std::os::unix::process::CommandExt as _;

    // `exec` only returns when it failed, so anything after it is the error path.
    let err = std::process::Command::new("ssh")
        .arg(machine)
        .arg("-t")
        .arg(remote)
        .exec();
    eprintln!("yantra: could not run ssh: {err}");
    ExitCode::FAILURE
}

/// Windows has no `exec`, and Q4 is deliberately open — but it also has no tmux
/// to attach to (R-7), so refusing here forecloses nothing that works today.
#[cfg(not(unix))]
fn hand_over(machine: &str, remote: &str) -> ExitCode {
    eprintln!(
        "yantra: attach needs a unix host; run it yourself:\n  ssh {machine} -t \"{remote}\""
    );
    ExitCode::FAILURE
}

async fn attach(name: &str) -> ExitCode {
    let plan = match attach::plan(name, &local_term()).await {
        Ok(plan) => plan,
        Err(err) => {
            report_error(&err);
            return ExitCode::FAILURE;
        }
    };

    // Asked before handing over, because `ssh -t` without one degrades into a
    // non-interactive session that attaches to nothing and says why in a way
    // nobody reads.
    if !std::io::stdin().is_terminal() {
        eprintln!("yantra: attach needs a terminal — nothing is reading this session");
        return ExitCode::FAILURE;
    }

    let machine = &plan.workspace.machine;
    if let Chosen::Substituted { wanted } = &plan.term {
        println!("{}", downgrade_notice(machine, wanted));
    }
    hand_over(
        machine,
        &attach::remote_command(plan.tmux.path(), &plan.workspace.name, plan.term.term()),
    )
}

/// The library never prints (ADR-0005), so rendering the chain is the CLI's job.
/// `source` matters here: the useful detail is usually a level or two down.
fn report_error(err: &dyn std::error::Error) {
    eprintln!("yantra: {err}");
    let mut source = err.source();
    while let Some(cause) = source {
        eprintln!("  caused by: {cause}");
        source = cause.source();
    }
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets code that ships, where the same call would take the process down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use yantra_core::inventory::Os;
    use yantra_core::tmux::Summary;

    /// clap's own check: conflicting flags, duplicate names, bad defaults.
    #[test]
    fn the_command_tree_is_well_formed() {
        Cli::command().debug_assert();
    }

    /// `--agent` is a value enum rather than a flag, so the spelling users type
    /// is part of the contract and `debug_assert` does not check it.
    #[test]
    fn the_agent_flag_takes_a_named_agent_and_is_optional() {
        let with = Cli::try_parse_from(["yantra", "up", "demo", "--agent", "claude"])
            .expect("`--agent claude` parses");
        assert!(matches!(
            with.command,
            Some(Command::Up {
                agent: Some(AgentArg::Claude),
                ..
            })
        ));

        let without =
            Cli::try_parse_from(["yantra", "up", "demo"]).expect("no agent is the default");
        assert!(matches!(
            without.command,
            Some(Command::Up { agent: None, .. })
        ));

        assert!(
            Cli::try_parse_from(["yantra", "up", "demo", "--agent", "aider"]).is_err(),
            "an agent Yantra does not ship must be refused by name, not started"
        );
    }

    /// `resume` takes a workspace and nothing else — which agent to continue is
    /// the workspace's business, and *which conversation* is claude's.
    #[test]
    fn resume_takes_a_workspace_and_no_flags() {
        let parsed = Cli::try_parse_from(["yantra", "resume", "demo"]).expect("`resume` parses");
        assert!(matches!(
            parsed.command,
            Some(Command::Resume { workspace }) if workspace == "demo"
        ));
        assert!(
            Cli::try_parse_from(["yantra", "resume"]).is_err(),
            "a resume with no workspace must be an argument error, not a guess"
        );
        assert!(
            Cli::try_parse_from(["yantra", "resume", "demo", "--agent", "claude"]).is_err(),
            "there is no agent to choose when continuing one that already ran"
        );
    }

    #[test]
    fn logs_defaults_to_a_window_rather_than_the_whole_transcript() {
        let default = Cli::try_parse_from(["yantra", "logs", "demo"]).expect("a bare logs parses");
        assert!(matches!(
            default.command,
            Some(Command::Logs { lines: 20, .. })
        ));
        let asked = Cli::try_parse_from(["yantra", "logs", "demo", "-n", "5"]).expect("-n parses");
        assert!(matches!(
            asked.command,
            Some(Command::Logs { lines: 5, .. })
        ));
    }

    /// A turn with no tool call must not print an empty `tools:` line, and a
    /// multi-line answer must stay one turn.
    #[test]
    fn a_turn_renders_as_one_block_whether_or_not_it_used_tools() {
        let rendered = render_logs(&logs::Transcript {
            path: "/h/.claude/projects/-srv-repo/an-id.jsonl".to_owned(),
            modified: 1_000,
            now: 1_004,
            entries: vec![
                logs::Entry {
                    who: logs::Who::User,
                    at: Some("2026-07-28T18:20:30.543Z".to_owned()),
                    text: "fix the test".to_owned(),
                    tools: Vec::new(),
                },
                logs::Entry {
                    who: logs::Who::Assistant,
                    at: Some("2026-07-28T18:20:34.000Z".to_owned()),
                    text: "Looking at it.\nTwo lines.".to_owned(),
                    tools: vec!["Read".to_owned(), "Bash".to_owned()],
                },
            ],
        });
        assert!(rendered.contains("last write: 4s ago"), "{rendered}");
        // The zone is part of the contract: the instant is the agent machine's
        // UTC, not the reader's local time.
        assert!(
            rendered.contains("18:20:30Z  you     fix the test"),
            "{rendered}"
        );
        assert!(rendered.contains("tools: Read, Bash"), "{rendered}");
        assert_eq!(
            rendered.matches("tools:").count(),
            1,
            "a turn with no tools gets no tools line: {rendered}"
        );
        assert!(
            rendered.contains("\n                   Two lines."),
            "a wrapped answer stays one turn: {rendered}"
        );
    }

    /// The transcript exists and has nothing in it — the state right after
    /// `up --agent claude`, and not an error.
    #[test]
    fn an_empty_transcript_says_so_rather_than_printing_a_bare_header() {
        let rendered = render_logs(&logs::Transcript {
            path: "/h/x.jsonl".to_owned(),
            modified: 1_000,
            now: 1_000,
            entries: Vec::new(),
        });
        assert!(rendered.contains("nothing has been said"), "{rendered}");
    }

    /// Every verdict must read as a sentence a person can act on — and the two
    /// that are not plain exits must say *why*, since those are the ones nobody
    /// can guess from a number.
    #[test]
    fn every_verdict_says_what_happened() {
        assert_eq!(describe(&Verdict::Finished), "finished (exit 0)");
        assert_eq!(
            describe(&Verdict::Crashed { status: 1 }),
            "crashed (exit 1)"
        );
        let killed = Verdict::Killed {
            signal: "KILL".to_owned(),
        };
        assert!(describe(&killed).contains("SIGKILL"));
        assert!(
            describe(&killed).contains("no shutdown"),
            "a signal kill means the agent ran none of its own shutdown"
        );
        assert!(
            describe(&Verdict::Unclear {
                because: "the sources disagree"
            })
            .contains("the sources disagree"),
            "an unclear verdict is useless without its reason"
        );
        let waiting = describe(&Verdict::AwaitingTrust);
        assert!(waiting.contains("trust prompt"), "{waiting}");
        assert!(
            waiting.contains("done nothing"),
            "the point of the state is that no work has happened: {waiting}"
        );
    }

    /// I-49: naming the state is half of it — the other half is who answers the
    /// dialog, which ADR-0011 says is never Yantra.
    #[test]
    fn the_trust_note_names_the_answer_and_who_has_to_give_it() {
        let note = trust_note("demo");
        // The answer quoted verbatim as 2.1.220 draws it, so it is the thing a
        // person is looking at rather than a paraphrase of it.
        assert!(note.contains("Yes, I trust this folder"), "{note}");
        assert!(note.contains("yantra up demo"), "{note}");
        assert!(
            note.contains("yantra never"),
            "a user must not be left expecting Yantra to answer it: {note}"
        );
    }

    /// An absent transcript is two states — never launched, and launched but
    /// still at the dialog — so the note has to send the reader somewhere that
    /// can tell them apart rather than guess for them.
    #[test]
    fn the_missing_transcript_note_points_at_the_command_that_can_tell_which() {
        let note = transcript_note("demo");
        assert!(note.contains("trust prompt"), "{note}");
        assert!(note.contains("yantra status demo"), "{note}");
    }

    /// `\` eats the leading whitespace of a continued line, so an indented one
    /// needs `\x20`. That was shipped wrong once already.
    #[test]
    fn the_notes_keep_their_indentation() {
        for note in [trust_note("demo"), transcript_note("demo")] {
            for line in note.lines() {
                assert!(line.starts_with(' '), "unindented note line: {line:?}");
            }
        }
    }

    fn machine(name: &str, os: Os, online: bool, expired: bool, seen: Option<&str>) -> MachineInfo {
        MachineInfo {
            id: format!("n{name}"),
            name: name.to_string(),
            dns_name: format!("{name}.example.ts.net."),
            os,
            online,
            last_seen: seen.map(str::to_string),
            expired,
        }
    }

    /// One laptop, two node IDs; the Linux side's key expired while down.
    fn dual_boot() -> Vec<MachineInfo> {
        vec![
            machine(
                "laptop-9ml3d644",
                Os::Linux,
                false,
                true,
                Some("2026-07-07T09:00:00Z"),
            ),
            machine(
                "laptop-9ml3d644-1",
                Os::Windows,
                false,
                false,
                Some("2026-07-28T18:30:00Z"),
            ),
        ]
    }

    #[test]
    fn the_dual_boot_is_never_two_online_machines() {
        let mut fleet = dual_boot();
        fleet.push(machine("cachyos-g14", Os::Linux, true, false, None));
        assert!(render_machines(&fleet).ends_with("3 machines, 1 online\n"));

        // And when the laptop is up, it is up on exactly one side.
        fleet[0].online = true;
        assert!(render_machines(&fleet).ends_with("3 machines, 2 online\n"));
    }

    /// I-39: `LastSeen` on an online peer says nothing, so the column is blank.
    #[test]
    fn an_online_machine_reports_no_last_seen_however_tailscale_fills_it() {
        let noisy = machine(
            "bishwajeets-macbook-pro",
            Os::MacOs,
            true,
            false,
            Some("2026-07-29T22:10:00.1Z"),
        );
        assert!(!render_machines(&[noisy]).contains("2026-07-29"));
    }

    #[test]
    fn an_expired_key_is_reported_as_more_than_offline() {
        let rendered = render_machines(&dual_boot());
        assert!(rendered.contains("offline, key expired"), "{rendered}");
        // The Windows side is merely down, and must not borrow the label.
        assert_eq!(rendered.matches("key expired").count(), 1, "{rendered}");
    }

    #[test]
    fn the_columns_are_padded_but_no_line_ends_in_whitespace() {
        let fleet = dual_boot();
        let rendered = render_machines(&fleet);
        for line in rendered.lines() {
            assert_eq!(line, line.trim_end(), "trailing space in {line:?}");
        }
        // A short name is still padded out to meet the next column.
        assert!(rendered.contains("laptop-9ml3d644    linux"), "{rendered}");
    }

    /// Verified against the MacBook; each missing part breaks it there.
    #[test]
    fn the_attach_hint_survives_a_remote_machine() {
        let hint = attach_hint("mac", "/opt/homebrew/bin/tmux", "demo", "xterm-256color");
        assert_eq!(
            hint,
            "ssh mac -t \"TERM=xterm-256color /opt/homebrew/bin/tmux attach -t '=demo'\""
        );
    }

    /// I-35: unquoted, zsh expands `=demo` and the attach silently misses.
    #[test]
    fn the_session_target_is_quoted_against_zsh() {
        assert!(attach_hint("mac", "/usr/bin/tmux", "demo", "xterm-256color").contains("'=demo'"));
    }

    /// Y-058: a terminal the far side knows reaches the hint unchanged, rather
    /// than everyone getting the floor.
    #[test]
    fn a_terminal_the_machine_knows_is_passed_through() {
        let hint = attach_hint("g14", "/usr/bin/tmux", "demo", "xterm-ghostty");
        assert!(hint.contains("TERM=xterm-ghostty"), "{hint}");
    }

    /// A downgrade has to say what was lost and how to end it, or it is the
    /// silent degradation Y-058 exists to remove.
    #[test]
    fn the_downgrade_notice_names_the_cost_and_the_cure() {
        let notice = downgrade_notice("mac", "xterm-ghostty");
        assert!(notice.contains("no `xterm-ghostty`"), "{notice}");
        assert!(notice.contains("xterm-256color"), "{notice}");
        assert!(notice.contains("yantra fix-terminfo mac"), "{notice}");
    }

    fn summary(name: &str, windows: u32, attached: u32) -> Summary {
        Summary {
            name: name.to_owned(),
            windows,
            attached,
            created: "Thu Jul 30 13:02:31 2026".to_owned(),
        }
    }

    /// One unreachable machine must not erase the machines that answered.
    #[test]
    fn an_unreachable_machine_is_reported_beside_the_ones_that_answered() {
        let listed = vec![
            MachineSessions {
                machine: "cachyos-g14".to_owned(),
                sessions: Ok(vec![summary("demo", 2, 1)]),
            },
            MachineSessions {
                machine: "pi".to_owned(),
                sessions: Err(sessions::Error::Interrupted {
                    machine: "pi".to_owned(),
                    reason: "timed out".to_owned(),
                }),
            },
        ];

        let rendered = render_sessions(&listed);
        assert!(rendered.contains("cachyos-g14  demo"), "{rendered}");
        assert!(
            rendered.contains("1 session on 1 of 2 machines"),
            "{rendered}"
        );
        assert!(rendered.contains("pi unreachable"), "{rendered}");
    }

    /// A machine with a running tmux and no sessions is not an error, and must
    /// not be confused with a machine that could not be reached.
    #[test]
    fn no_sessions_anywhere_still_says_which_machines_answered() {
        let listed = vec![MachineSessions {
            machine: "mac".to_owned(),
            sessions: Ok(Vec::new()),
        }];
        let rendered = render_sessions(&listed);
        assert!(
            rendered.contains("0 sessions on 1 of 1 machines"),
            "{rendered}"
        );
        assert!(!rendered.contains("unreachable"), "{rendered}");
    }

    fn workspace(name: &str, machine: &str, startup: Option<&str>) -> Workspace {
        Workspace {
            name: name.to_owned(),
            machine: machine.to_owned(),
            repo: std::path::PathBuf::from(format!("/srv/{name}")),
            startup: startup.map(str::to_owned),
        }
    }

    /// A workspace with no `startup` is just a shell, which is a real state and
    /// not a missing one — so the cell is blank rather than saying `none`.
    #[test]
    fn a_workspace_with_no_startup_leaves_the_column_empty() {
        let rendered = render_workspaces(&[
            workspace("yantra", "cachyos-g14", Some("claude")),
            workspace("scratch", "pi", None),
        ]);
        assert!(
            rendered.contains("yantra     cachyos-g14  /srv/yantra   claude"),
            "{rendered}"
        );
        for line in rendered.lines() {
            assert_eq!(line, line.trim_end(), "trailing space in {line:?}");
        }
        assert!(rendered.ends_with("2 workspaces\n"), "{rendered}");
    }

    /// Absence is emptiness (`workspace::list` returns `Ok(vec![])` for a
    /// directory nobody has made), so this exits 0 — and a bare header row
    /// would tell a first-time user nothing about where to put a file.
    #[test]
    fn no_workspaces_names_where_one_goes_rather_than_printing_a_header() {
        let rendered = render_workspaces(&[]);
        assert!(rendered.contains("no workspaces yet"), "{rendered}");
        assert!(rendered.contains("<name>.toml"), "{rendered}");
    }

    #[test]
    fn an_unrecognised_os_reaches_the_table_verbatim() {
        let odd = machine("nas", Os::Other("freebsd".to_string()), true, false, None);
        assert!(render_machines(&[odd]).contains("freebsd"));
    }
}
