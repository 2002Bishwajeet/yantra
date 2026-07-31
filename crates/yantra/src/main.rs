//! `yantra` — the command-line client.
//!
//! The CLI is the daemon's first client and its honesty check: anything the web
//! UI can do must be expressible here first. It calls `yantra-core` in-process
//! today and becomes an HTTP client of `yantrad` in M2 (ADR-0005), which is a
//! change of *where* the work is called from, not *what* it does.

use clap::{CommandFactory as _, Parser, Subcommand};
use std::process::ExitCode;
use yantra_core::agent;
use yantra_core::inventory::{Inventory as _, MachineInfo, Tailscale};
use yantra_core::logs;
use yantra_core::sessions::{self, MachineSessions};
use yantra_core::status::Verdict;
use yantra_core::terminfo::{self, Chosen};
use yantra_core::up;

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
}

#[tokio::main]
async fn main() -> ExitCode {
    match Cli::parse().command {
        Some(Command::Up { workspace, agent }) => up(&workspace, agent).await,
        Some(Command::Logs { workspace, lines }) => show_logs(&workspace, lines).await,
        Some(Command::Status { workspace }) => show_status(&workspace).await,
        Some(Command::Ls {
            target: LsTarget::Machines,
        }) => ls_machines().await,
        Some(Command::Ls {
            target: LsTarget::Sessions,
        }) => ls_sessions().await,
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
            ExitCode::FAILURE
        }
    }
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
            "{:<8}  {who:<6}  ",
            time_of_day(entry.at.as_deref())
        ));
        // Continuations line up under the first line rather than under the
        // clock, so a wrapped paragraph still reads as one turn.
        out.push_str(&entry.text.replace('\n', "\n                  "));
        out.push('\n');
        if !entry.tools.is_empty() {
            out.push_str(&format!(
                "                  tools: {}\n",
                entry.tools.join(", ")
            ));
        }
    }
    out
}

/// The clock part of an ISO-8601 instant. `get` rather than a slice because the
/// field is someone else's and a short string must not take the process down.
fn time_of_day(at: Option<&str>) -> &str {
    at.and_then(|at| at.get(11..19)).unwrap_or("")
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
        Verdict::Unclear { because } => format!("unclear — {because}"),
    }
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
fn attach_hint(machine: &str, tmux: &str, session: &str, term: &str) -> String {
    format!("ssh {machine} -t \"TERM={term} {tmux} attach -t '={session}'\"")
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
        assert!(
            rendered.contains("18:20:30  you     fix the test"),
            "{rendered}"
        );
        assert!(rendered.contains("tools: Read, Bash"), "{rendered}");
        assert_eq!(
            rendered.matches("tools:").count(),
            1,
            "a turn with no tools gets no tools line: {rendered}"
        );
        assert!(
            rendered.contains("\n                  Two lines."),
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

    #[test]
    fn an_unrecognised_os_reaches_the_table_verbatim() {
        let odd = machine("nas", Os::Other("freebsd".to_string()), true, false, None);
        assert!(render_machines(&[odd]).contains("freebsd"));
    }
}
