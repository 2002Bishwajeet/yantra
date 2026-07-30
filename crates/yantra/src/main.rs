//! `yantra` — the command-line client.
//!
//! The CLI is the daemon's first client and its honesty check: anything the web
//! UI can do must be expressible here first. It calls `yantra-core` in-process
//! today and becomes an HTTP client of `yantrad` in M2 (ADR-0005), which is a
//! change of *where* the work is called from, not *what* it does.

use clap::{CommandFactory as _, Parser, Subcommand};
use std::process::ExitCode;
use yantra_core::inventory::{Inventory as _, MachineInfo, Tailscale};
use yantra_core::sessions::{self, MachineSessions};
use yantra_core::terminfo::{self, Chosen};

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
        Some(Command::Up { workspace }) => up(&workspace).await,
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

async fn up(name: &str) -> ExitCode {
    match yantra_core::up::up(name, &local_term()).await {
        Ok(report) => {
            let session = report.opened.session();
            let verb = if report.opened.was_created() {
                "opened"
            } else {
                "attached to"
            };
            let machine = &report.workspace.machine;
            println!("{verb} {} on {machine}", report.workspace.name);
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
            ExitCode::FAILURE
        }
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
mod tests {
    use super::*;
    use yantra_core::inventory::Os;
    use yantra_core::tmux::Summary;

    /// clap's own check: conflicting flags, duplicate names, bad defaults.
    #[test]
    fn the_command_tree_is_well_formed() {
        Cli::command().debug_assert();
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
