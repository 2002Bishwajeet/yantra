//! `yantra` — the command-line client.
//!
//! The CLI is the daemon's first client and its honesty check: anything the web
//! UI can do must be expressible here first. It calls `yantra-core` in-process
//! today and becomes an HTTP client of `yantrad` in M2 (ADR-0005), which is a
//! change of *where* the work is called from, not *what* it does.

use clap::{CommandFactory as _, Parser, Subcommand};
use std::io::IsTerminal as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use yantra_core::agent;
use yantra_core::attach;
use yantra_core::doctor::{self, Report, State};
use yantra_core::identity;
use yantra_core::inventory::{Inventory as _, MachineInfo, Tailscale};
use yantra_core::logs;
use yantra_core::notify;
use yantra_core::resume;
use yantra_core::sessions::{self, MachineSessions};
use yantra_core::status::Verdict;
use yantra_core::terminfo::{self, Chosen};
use yantra_core::tokens;
use yantra_core::up;
use yantra_core::workspace::{self, Listing};

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
    /// Write a new workspace file
    New {
        /// Workspace name, without the `.toml`
        workspace: String,
        /// ssh destination to run it on, as `~/.ssh/config` spells it
        #[arg(long)]
        machine: String,
        /// Path to the repository **on that machine**, not on this one
        #[arg(long)]
        repo: PathBuf,
        /// Command to run when the session opens, instead of an agent
        #[arg(long)]
        startup: Option<String>,
    },
    /// Change an existing workspace's fields
    #[command(group(clap::ArgGroup::new("fields").required(true).multiple(true)
        .args(["machine", "repo", "startup", "no_startup"])))]
    Edit {
        /// Workspace name, without the `.toml`
        workspace: String,
        /// ssh destination to run it on, as `~/.ssh/config` spells it
        #[arg(long)]
        machine: Option<String>,
        /// Path to the repository **on that machine**, not on this one
        #[arg(long)]
        repo: Option<PathBuf>,
        /// Command to run when the session opens, instead of an agent
        #[arg(long, conflicts_with = "no_startup")]
        startup: Option<String>,
        /// Drop the startup command, so the session opens a plain shell
        #[arg(long)]
        no_startup: bool,
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
    /// Add up the tokens the workspace's session has spent
    Tokens {
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
    /// Publish a message to the relay this machine is configured with
    Notify {
        /// What to say. It is sent as written and nothing is composed into it
        message: String,
        /// A headline shown above it
        #[arg(long)]
        title: Option<String>,
        /// Urgency, 1 (min) to 5 (max)
        #[arg(long, value_parser = clap::value_parser!(u8).range(1..=5))]
        priority: Option<u8>,
    },
    /// Say what each machine can and cannot do — a read, it changes nothing
    Doctor {
        /// ssh destination to check. Every machine a workspace names, if omitted
        machine: Option<String>,
        /// Print the checks as JSON, for an installer or an agent to read
        #[arg(long)]
        json: bool,
    },
    /// Teach a machine about the terminal you are sitting at
    FixTerminfo {
        /// ssh destination, spelled the way a workspace's `machine` spells it
        machine: String,
    },
    /// Prepare this account's ssh identity, and print the public key to place
    SshIdentity,
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
        Some(Command::New {
            workspace,
            machine,
            repo,
            startup,
        }) => new(&workspace, &machine, &repo, startup.as_deref()),
        Some(Command::Edit {
            workspace,
            machine,
            repo,
            startup,
            no_startup,
        }) => {
            edit(
                &workspace,
                &workspace::Changes {
                    machine,
                    repo,
                    startup: startup.map(Some).or(no_startup.then_some(None)),
                },
            )
            .await
        }
        Some(Command::Attach { workspace }) => attach(&workspace).await,
        Some(Command::Resume { workspace }) => resume(&workspace).await,
        Some(Command::Logs { workspace, lines }) => show_logs(&workspace, lines).await,
        Some(Command::Status { workspace }) => show_status(&workspace).await,
        Some(Command::Tokens { workspace }) => show_tokens(&workspace).await,
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
        Some(Command::Notify {
            message,
            title,
            priority,
        }) => {
            publish(notify::Message {
                body: message,
                title,
                priority,
            })
            .await
        }
        Some(Command::Doctor { machine, json }) => doctor(machine.as_deref(), json).await,
        Some(Command::FixTerminfo { machine }) => fix_terminfo(&machine).await,
        Some(Command::SshIdentity) => ssh_identity(),
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
///
/// It no longer suggests `ssh <machine> claude auth status`: since ADR-0018 §5
/// that is the one process whose answer is known to be wrong, and sending
/// someone to reproduce a false negative is worse than saying nothing.
const KEYCHAIN_NOTE: &str = "\
\x20 note: on macOS the agent's token lives in the login keychain, and only a
        process the login session forked can read it. yantra asks inside that
        machine's tmux server for that reason, so this answer means the server
        itself was started without the keychain — over ssh, most likely. start
        one from a login session on that machine and try again.";

async fn show_logs(name: &str, lines: usize) -> ExitCode {
    match logs::logs(name, lines).await {
        Ok(transcript) => {
            print!("{}", render_logs(&transcript));
            ExitCode::SUCCESS
        }
        Err(err) => {
            report_error(&err);
            if matches!(
                err,
                logs::Error::NoTranscript { .. } | logs::Error::NoTurnYet { .. }
            ) {
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

/// Exit 0 whenever the transcript was read, including for a session that has
/// spent nothing — unlike `status`, this reports a measurement rather than a
/// state, and zero is one.
async fn show_tokens(name: &str) -> ExitCode {
    match tokens::tokens(name).await {
        Ok(spend) => {
            print!("{}", render_tokens(&spend));
            ExitCode::SUCCESS
        }
        Err(err) => {
            report_error(&err);
            if matches!(
                err,
                logs::Error::NoTranscript { .. } | logs::Error::NoTurnYet { .. }
            ) {
                eprintln!("{}", transcript_note(name));
            }
            ExitCode::FAILURE
        }
    }
}

/// No total line: the four are not the same unit of anything, and Yantra prints
/// no money — every figure here is one Claude Code wrote down.
fn render_tokens(spend: &tokens::Spend) -> String {
    let rows = [
        ("input", spend.input),
        ("output", spend.output),
        ("cache write", spend.cache_write),
        ("cache read", spend.cache_read),
    ];
    let counts: Vec<String> = rows.iter().map(|(_, count)| thousands(*count)).collect();
    let width = counts.iter().map(String::len).max().unwrap_or(0);

    let mut out = format!("transcript: {}\n\n", spend.path);
    for ((label, _), count) in rows.iter().zip(&counts) {
        out.push_str(&format!("  {label:<12}  {count:>width$}\n"));
    }
    if spend.responses == 0 {
        out.push_str("\nthis session has spent nothing yet\n");
    } else {
        out.push_str(&format!(
            "\n{} response{}\n",
            spend.responses,
            if spend.responses == 1 { "" } else { "s" }
        ));
    }
    out
}

/// Every figure here runs to six or seven digits, and unseparated they cannot
/// be compared at a glance — which is the only thing anyone does with them.
fn thousands(count: u64) -> String {
    let digits = count.to_string();
    let mut out = String::new();
    for (at, digit) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
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

/// Not `async`: writing one small file is the whole of it, and there is no
/// machine to ask. `up` is what discovers whether `machine` and `repo` were
/// right, on the far side and before a session exists (Y-081) — checking here
/// would check this machine's filesystem for a path on another one.
fn new(name: &str, machine: &str, repo: &Path, startup: Option<&str>) -> ExitCode {
    match yantra_core::workspace::create(name, machine, repo, startup) {
        Ok(workspace) => {
            println!("created {} on {}", workspace.name, workspace.machine);
            println!("  repo:   {}", workspace.repo.display());
            if let Some(startup) = &workspace.startup {
                println!("  startup: {startup}");
            }
            println!("  next:   yantra up {} --agent claude", workspace.name);
            ExitCode::SUCCESS
        }
        Err(err) => {
            report_error(&err);
            ExitCode::FAILURE
        }
    }
}

async fn edit(name: &str, changes: &workspace::Changes) -> ExitCode {
    match yantra_core::edit::edit(name, changes).await {
        Ok(edited) => {
            let workspace = &edited.workspace;
            if edited.changed {
                println!("edited {} on {}", workspace.name, workspace.machine);
            } else {
                println!(
                    "{} on {} already reads that way",
                    workspace.name, workspace.machine
                );
            }
            println!("  repo:   {}", workspace.repo.display());
            match &workspace.startup {
                Some(startup) => println!("  startup: {startup}"),
                None => println!("  startup: none, so the session opens a shell"),
            }
            ExitCode::SUCCESS
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

/// The one command that proves a topic, a token and egress from a box with no
/// screen, so every refusal names the variable that would change it — and the
/// token is never one of the things printed (§B4).
async fn publish(message: notify::Message) -> ExitCode {
    let Some(relay) = notify::from_env() else {
        eprintln!("yantra: no relay is configured, so there is nowhere to publish to");
        eprintln!("{}", relay_note());
        return ExitCode::FAILURE;
    };
    match notify::post(&relay, message).await {
        Ok(()) => {
            println!("published");
            ExitCode::SUCCESS
        }
        Err(err) => {
            report_error(&err);
            if matches!(err, notify::Error::Refused { status: 401 | 403 })
                && std::env::var_os(notify::RELAY_TOKEN).is_none()
            {
                eprintln!("{}", token_note());
            }
            ExitCode::FAILURE
        }
    }
}

fn relay_note() -> String {
    format!(
        "\x20 note: the topic is the address, so publishing needs one:\n\
         \x20         {}=https://ntfy.sh/<topic> yantra notify 'hello'\n\
         \x20       on the public server that topic is the only password there is,\n\
         \x20       so make it one nobody guesses — or point this at your own ntfy.",
        notify::RELAY_URL
    )
}

/// A protected topic answers the same way a wrong one does, and the difference
/// between them is a variable that is not set.
fn token_note() -> String {
    format!(
        "\x20 note: that topic wants credentials and {} is not set.\n\
         \x20       it is read from the environment and nowhere else — yantra never\n\
         \x20       writes it to a file, a log or the API.",
        notify::RELAY_TOKEN
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

/// D2 §2's ssh row, the *Yantra prepares it, you finish* column. **Invoked and
/// never automatic**: whether generating the keypair is Yantra's job rather than
/// the owner's is still unconfirmed, so nothing calls this for them.
fn ssh_identity() -> ExitCode {
    match identity::prepare() {
        Ok(prepared) => {
            let key = prepared.key.display();
            if prepared.generated {
                println!("key:    {key}, generated");
            } else {
                println!("key:    {key}, already here and left alone");
            }
            let config = prepared.config.display();
            if prepared.configured.is_empty() {
                println!("config: {config}, unchanged");
            } else {
                println!(
                    "config: {config}, a Host block added for {}",
                    prepared.configured.join(", ")
                );
            }
            if !prepared.left_alone.is_empty() {
                println!(
                    "        {} already named there, left as it is",
                    prepared.left_alone.join(", ")
                );
            }
            println!(
                "\nplace this in ~/.ssh/authorized_keys on each machine, which is your half:\n"
            );
            println!("  {}\n", prepared.public_key);
            println!("{IDENTITY_NOTE}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            report_error(&err);
            ExitCode::FAILURE
        }
    }
}

const IDENTITY_NOTE: &str = "\
The key has no passphrase: `BatchMode=yes` has nowhere to type one, and the alternative is
an agent, which is a login session an appliance nobody logs into does not have.
Add `User` to a block whose account name over there differs from this one's — `HostName`,
`Port` and `ProxyJump` live in the same file and Yantra writes none of them (ADR-0009).
`known_hosts` wants nothing: Yantra keeps its own beside its control sockets, and it fills
on first contact.";

/// D2 §3.2: this verb is a **read**, so there is no `--fix` and nothing here
/// asks for one. Exit 0 means every check answered *present* — an `unknown` is
/// not a yes, which is what lets an installer loop on this command.
async fn doctor(machine: Option<&str>, json: bool) -> ExitCode {
    let term = local_term();
    let reports = match machine {
        Some(machine) => vec![doctor::machine(machine, &term).await],
        None => match doctor::fleet(&term).await {
            Ok(reports) => reports,
            Err(err) => {
                report_error(&err);
                return ExitCode::FAILURE;
            }
        },
    };

    if json {
        match render_doctor_json(&reports) {
            Ok(rendered) => print!("{rendered}"),
            Err(err) => {
                report_error(&err);
                return ExitCode::FAILURE;
            }
        }
    } else {
        print!("{}", render_doctor(&reports));
    }

    // An empty fleet is not a clean one: nothing was asked, so nothing is known.
    if !reports.is_empty() && reports.iter().all(Report::ready) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// The shape an installer and an agent read (D2.2), and a test pins it.
/// `machines` is an object rather than a bare array so a later reading can be
/// added beside it without moving what is already there.
fn render_doctor_json(reports: &[Report]) -> Result<String, serde_json::Error> {
    let mut document = serde_json::Map::new();
    document.insert("machines".to_owned(), serde_json::to_value(reports)?);
    Ok(format!("{}\n", serde_json::to_string_pretty(&document)?))
}

/// The state is a **word** rather than a symbol, and that is the whole reason
/// this column exists: `unknown` must never be readable as `absent` (R-23).
fn render_doctor(reports: &[Report]) -> String {
    if reports.is_empty() {
        return "no workspace names a machine, so nothing was checked\n  \
                to check one anyway: yantra doctor <machine>\n"
            .to_owned();
    }

    let rows: Vec<Vec<String>> = reports
        .iter()
        .flat_map(|report| {
            report.checks.iter().map(move |check| {
                vec![
                    report.machine.clone(),
                    check.check.to_owned(),
                    state(check.state).to_owned(),
                    check.detail.clone(),
                ]
            })
        })
        .collect();

    let mut out = table(&["MACHINE", "CHECK", "STATE", "DETAIL"], &rows);
    let count = |wanted: State| {
        reports
            .iter()
            .flat_map(|report| &report.checks)
            .filter(|check| check.state == wanted)
            .count()
    };
    out.push_str(&format!(
        "\n{} check{} on {} machine{}: {} present, {} absent, {} unknown\n",
        rows.len(),
        if rows.len() == 1 { "" } else { "s" },
        reports.len(),
        if reports.len() == 1 { "" } else { "s" },
        count(State::Present),
        count(State::Absent),
        count(State::Unknown),
    ));
    out
}

fn state(state: State) -> &'static str {
    match state {
        State::Present => "present",
        State::Absent => "absent",
        State::Unknown => "unknown",
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
        Ok(listing) => {
            print!("{}", render_workspaces(&listing));
            // Non-zero on a partial answer, exactly as `ls sessions`: the table
            // is still printed, but a caller must be able to tell it is
            // incomplete.
            if listing.unusable.is_empty() {
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

/// A file that did not load is named **under** the table rather than given a
/// row in it, which is `render_sessions`'s shape for an unreachable machine.
/// Every column here is something to act on and a broken file has none of them:
/// no machine, nothing to attach to, and nothing `yantra edit` can repair, since
/// `update` loads before it writes and the file is the fix.
fn render_workspaces(listing: &Listing) -> String {
    let workspaces = &listing.workspaces;
    if workspaces.is_empty() && listing.unusable.is_empty() {
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

    let mut out = if rows.is_empty() {
        String::new()
    } else {
        table(&["WORKSPACE", "MACHINE", "REPO", "STARTUP"], &rows)
    };
    out.push_str(&format!(
        "\n{} workspace{}\n",
        workspaces.len(),
        if workspaces.len() == 1 { "" } else { "s" }
    ));

    for unusable in &listing.unusable {
        out.push_str(&format!(
            "  {} unusable: {}\n",
            unusable.name,
            chain(&unusable.error)
        ));
    }
    out
}

/// The chain `report_error` prints, on one line: a footer under a table has no
/// second line to give it, and the useful detail is a level or two down.
fn chain(err: &dyn std::error::Error) -> String {
    let mut out = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        out.push_str(&format!(": {cause}"));
        source = cause.source();
    }
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
    use yantra_core::workspace::Workspace;

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

    /// The message is the whole of what is required: a title and a priority are
    /// ntfy's headers, and 1–5 is the scale it documents, so a 9 is refused here
    /// rather than by a relay on a box nobody is looking at.
    #[test]
    fn notify_takes_a_message_and_bounds_the_priority() {
        let plain =
            Cli::try_parse_from(["yantra", "notify", "needs you"]).expect("a body is enough");
        assert!(matches!(
            plain.command,
            Some(Command::Notify {
                title: None,
                priority: None,
                ..
            })
        ));

        let dressed = Cli::try_parse_from([
            "yantra",
            "notify",
            "needs you",
            "--title",
            "api",
            "--priority",
            "5",
        ])
        .expect("a title and a priority parse");
        assert!(matches!(
            dressed.command,
            Some(Command::Notify {
                priority: Some(5),
                ..
            })
        ));

        assert!(
            Cli::try_parse_from(["yantra", "notify", "hi", "--priority", "9"]).is_err(),
            "a priority ntfy has no meaning for is refused by name"
        );
        assert!(Cli::try_parse_from(["yantra", "notify"]).is_err());
    }

    /// Every field is optional on its own and at least one is mandatory
    /// together, because `yantra edit demo` asks for nothing and a verb that
    /// silently did nothing would read as one that worked.
    #[test]
    fn edit_takes_any_field_but_needs_at_least_one() {
        let one = Cli::try_parse_from(["yantra", "edit", "demo", "--repo", "/srv/x"])
            .expect("one field is enough");
        assert!(matches!(
            one.command,
            Some(Command::Edit {
                machine: None,
                startup: None,
                no_startup: false,
                ..
            })
        ));

        Cli::try_parse_from([
            "yantra",
            "edit",
            "demo",
            "--machine",
            "mac",
            "--startup",
            "nvim",
        ])
        .expect("several fields at once");
        assert!(
            Cli::try_parse_from(["yantra", "edit", "demo"]).is_err(),
            "an edit that names no field has nothing to do"
        );
    }

    /// The two ways to spell a `startup` are mutually exclusive: `--startup ''`
    /// is refused by the library, so clearing one needs its own flag rather than
    /// an empty value, and asking for both at once is a contradiction.
    #[test]
    fn a_startup_can_be_set_or_dropped_but_not_both() {
        let dropped = Cli::try_parse_from(["yantra", "edit", "demo", "--no-startup"])
            .expect("`--no-startup` parses");
        assert!(matches!(
            dropped.command,
            Some(Command::Edit {
                no_startup: true,
                startup: None,
                ..
            })
        ));

        assert!(
            Cli::try_parse_from([
                "yantra",
                "edit",
                "demo",
                "--startup",
                "nvim",
                "--no-startup"
            ])
            .is_err(),
            "setting and dropping the same field is not an instruction"
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

    /// A workspace and nothing else: which session is the pane's business, and
    /// there is no window to choose because the answer is the whole session.
    #[test]
    fn tokens_takes_a_workspace_and_no_window() {
        let parsed = Cli::try_parse_from(["yantra", "tokens", "demo"]).expect("`tokens` parses");
        assert!(matches!(
            parsed.command,
            Some(Command::Tokens { workspace }) if workspace == "demo"
        ));
        assert!(
            Cli::try_parse_from(["yantra", "tokens", "demo", "-n", "5"]).is_err(),
            "a window would be a different question from what the session spent"
        );
    }

    /// The four counts, each as Claude Code recorded it, and no fifth number:
    /// no total, and nothing in money — that is Y-182 and a rate this file does
    /// not carry.
    #[test]
    fn the_four_counts_are_reported_and_nothing_is_derived_from_them() {
        let rendered = render_tokens(&tokens::Spend {
            path: "/h/.claude/projects/-srv-repo/s.jsonl".to_owned(),
            responses: 66,
            input: 1_434,
            output: 49_118,
            cache_write: 239_765,
            cache_read: 7_492_711,
        });
        assert!(rendered.contains("transcript: /h/.claude"), "{rendered}");
        assert!(rendered.contains("input             1,434"), "{rendered}");
        assert!(rendered.contains("cache read    7,492,711"), "{rendered}");
        assert!(rendered.ends_with("66 responses\n"), "{rendered}");
        assert!(
            !rendered.contains('$'),
            "the transcript records no cost, so nothing here may print one: {rendered}"
        );
        for line in rendered.lines() {
            assert_eq!(line, line.trim_end(), "trailing space in {line:?}");
        }
    }

    /// A session that has said nothing has spent nothing, and that is a reading
    /// rather than a failure — the state right after `up --agent claude`.
    #[test]
    fn a_session_that_has_spent_nothing_says_so() {
        let rendered = render_tokens(&tokens::Spend {
            path: "/h/x.jsonl".to_owned(),
            ..tokens::Spend::default()
        });
        assert!(rendered.contains("spent nothing yet"), "{rendered}");
        assert!(rendered.contains("input         0"), "{rendered}");
    }

    #[test]
    fn a_seven_digit_count_is_grouped_and_a_small_one_is_left_alone() {
        assert_eq!(thousands(7_492_711), "7,492,711");
        assert_eq!(thousands(1_434), "1,434");
        assert_eq!(thousands(0), "0");
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
            addresses: Vec::new(),
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

    /// The machine is optional because a box being installed has no workspace
    /// yet, and there is deliberately no `--fix` to parse (D2 §3.2).
    #[test]
    fn doctor_takes_an_optional_machine_and_a_json_flag() {
        let fleet = Cli::try_parse_from(["yantra", "doctor"]).expect("a bare doctor parses");
        assert!(matches!(
            fleet.command,
            Some(Command::Doctor {
                machine: None,
                json: false
            })
        ));

        let one = Cli::try_parse_from(["yantra", "doctor", "pi", "--json"])
            .expect("a machine and --json parse");
        assert!(matches!(
            one.command,
            Some(Command::Doctor {
                machine: Some(machine),
                json: true
            }) if machine == "pi"
        ));

        assert!(
            Cli::try_parse_from(["yantra", "doctor", "--fix"]).is_err(),
            "doctor is a read, and a flag that changes a machine must not be silently accepted"
        );
    }

    fn check(name: &'static str, state: State, detail: &str) -> doctor::Check {
        doctor::Check {
            check: name,
            state,
            detail: detail.to_owned(),
        }
    }

    /// **D2.2's pin.** An installer and an agent read these bytes, so the field
    /// names, the three state spellings and the envelope are a contract — this
    /// test failing means a consumer somewhere breaks, not that it needs
    /// updating. (Keys are alphabetical because that is what `serde_json`'s map
    /// does; the check *order* is `doctor`'s and is asserted in its own tests.)
    #[test]
    fn the_json_shape_is_pinned() {
        let rendered = render_doctor_json(&[Report {
            machine: "pi".to_owned(),
            checks: vec![
                check("reachable", State::Present, "a command ran there"),
                check("sshd", State::Absent, "nothing is listening"),
                check("heartbeat", State::Unknown, "nothing to read"),
            ],
        }])
        .expect("a report serialises");

        assert_eq!(
            rendered,
            r#"{
  "machines": [
    {
      "checks": [
        {
          "check": "reachable",
          "detail": "a command ran there",
          "state": "present"
        },
        {
          "check": "sshd",
          "detail": "nothing is listening",
          "state": "absent"
        },
        {
          "check": "heartbeat",
          "detail": "nothing to read",
          "state": "unknown"
        }
      ],
      "machine": "pi"
    }
  ]
}
"#
        );
    }

    /// R-23 at the surface a person reads: the two failure states are different
    /// words in a column of their own, and the footer counts them apart.
    #[test]
    fn an_unknown_check_never_renders_as_an_absent_one() {
        let rendered = render_doctor(&[Report {
            machine: "pi".to_owned(),
            checks: vec![
                check("reachable", State::Absent, "the connection was refused"),
                check("tmux", State::Unknown, "nothing behind ssh could be asked"),
            ],
        }]);

        assert!(rendered.contains("reachable  absent"), "{rendered}");
        assert!(rendered.contains("tmux       unknown"), "{rendered}");
        assert!(
            rendered.ends_with("2 checks on 1 machine: 0 present, 1 absent, 1 unknown\n"),
            "{rendered}"
        );
        for line in rendered.lines() {
            assert_eq!(line, line.trim_end(), "trailing space in {line:?}");
        }
    }

    /// A fleet with nothing in it is not a clean one — nothing was asked, so the
    /// output must not look like nine passes, and `doctor` exits non-zero.
    #[test]
    fn no_machines_says_nothing_was_checked_and_names_the_way_to_check_one() {
        let rendered = render_doctor(&[]);
        assert!(rendered.contains("nothing was checked"), "{rendered}");
        assert!(rendered.contains("yantra doctor <machine>"), "{rendered}");
    }

    fn workspace(name: &str, machine: &str, startup: Option<&str>) -> Workspace {
        Workspace {
            name: name.to_owned(),
            machine: machine.to_owned(),
            repo: std::path::PathBuf::from(format!("/srv/{name}")),
            startup: startup.map(str::to_owned),
        }
    }

    fn listing(workspaces: Vec<Workspace>, unusable: Vec<workspace::Unusable>) -> Listing {
        Listing {
            workspaces,
            unusable,
        }
    }

    /// A workspace with no `startup` is just a shell, which is a real state and
    /// not a missing one — so the cell is blank rather than saying `none`.
    #[test]
    fn a_workspace_with_no_startup_leaves_the_column_empty() {
        let rendered = render_workspaces(&listing(
            vec![
                workspace("yantra", "cachyos-g14", Some("claude")),
                workspace("scratch", "pi", None),
            ],
            Vec::new(),
        ));
        assert!(
            rendered.contains("yantra     cachyos-g14  /srv/yantra   claude"),
            "{rendered}"
        );
        for line in rendered.lines() {
            assert_eq!(line, line.trim_end(), "trailing space in {line:?}");
        }
        assert!(rendered.ends_with("2 workspaces\n"), "{rendered}");
    }

    /// Absence is emptiness (`workspace::list` returns an empty listing for a
    /// directory nobody has made), so this exits 0 — and a bare header row
    /// would tell a first-time user nothing about where to put a file.
    #[test]
    fn no_workspaces_names_where_one_goes_rather_than_printing_a_header() {
        let rendered = render_workspaces(&listing(Vec::new(), Vec::new()));
        assert!(rendered.contains("no workspaces yet"), "{rendered}");
        assert!(rendered.contains("<name>.toml"), "{rendered}");
    }

    /// Y-141's rule at the terminal: the file that did not load is named under
    /// the table with its reason, and it takes none of the others with it.
    #[test]
    fn an_unusable_file_is_named_below_the_table_and_the_rest_still_print() {
        let rendered = render_workspaces(&listing(
            vec![workspace("yantra", "cachyos-g14", Some("claude"))],
            vec![workspace::Unusable {
                name: "site".to_owned(),
                error: workspace::Error::Blank {
                    name: "site".to_owned(),
                    path: std::path::PathBuf::from("/srv/workspaces/site.toml"),
                    field: "machine",
                },
            }],
        ));

        assert!(rendered.contains("yantra     cachyos-g14"), "{rendered}");
        assert!(rendered.contains("1 workspace\n"), "{rendered}");
        assert!(rendered.contains("site unusable:"), "{rendered}");
        // The reason and the file, or the note sends nobody anywhere.
        assert!(rendered.contains("empty `machine`"), "{rendered}");
        assert!(rendered.contains("/srv/workspaces/site.toml"), "{rendered}");
        // It is a note, not a row — the columns are all things to act on.
        assert!(
            !rendered.contains("site  \n") && !rendered.contains("\nsite "),
            "an unusable file must not be drawn as a row: {rendered}"
        );
    }

    /// A directory whose every file is broken is not an empty directory, so it
    /// must not print the invitation to make a first workspace.
    #[test]
    fn a_directory_where_nothing_loads_says_so_rather_than_saying_it_is_empty() {
        let rendered = render_workspaces(&listing(
            Vec::new(),
            vec![workspace::Unusable {
                name: "site".to_owned(),
                error: workspace::Error::InvalidName {
                    name: "site".to_owned(),
                    path: std::path::PathBuf::from("/srv/workspaces/site.toml"),
                },
            }],
        ));

        assert!(!rendered.contains("no workspaces yet"), "{rendered}");
        assert!(rendered.contains("0 workspaces"), "{rendered}");
        assert!(rendered.contains("site unusable:"), "{rendered}");
    }

    /// `report_error` walks the chain because the detail is a level down, and a
    /// one-line footer that dropped it would name a fault nobody can act on.
    #[test]
    fn the_footer_carries_the_cause_and_not_only_the_headline() {
        let error = workspace::Error::Unreadable {
            name: "site".to_owned(),
            path: std::path::PathBuf::from("/srv/workspaces/site.toml"),
            source: std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        };
        assert!(
            chain(&error).contains("permission denied"),
            "{}",
            chain(&error)
        );
    }

    #[test]
    fn an_unrecognised_os_reaches_the_table_verbatim() {
        let odd = machine("nas", Os::Other("freebsd".to_string()), true, false, None);
        assert!(render_machines(&[odd]).contains("freebsd"));
    }
}
