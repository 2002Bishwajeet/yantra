//! `yantra` — the command-line client.
//!
//! The CLI is the daemon's first client and its honesty check: anything the web
//! UI can do must be expressible here first. It calls `yantra-core` in-process
//! today and becomes an HTTP client of `yantrad` in M2 (ADR-0005), which is a
//! change of *where* the work is called from, not *what* it does.

use clap::{CommandFactory as _, Parser, Subcommand};
use std::process::ExitCode;
use yantra_core::inventory::{Inventory as _, MachineInfo, Tailscale};

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
}

#[derive(Debug, Subcommand)]
enum LsTarget {
    /// Machines in the tailnet
    Machines,
}

#[tokio::main]
async fn main() -> ExitCode {
    match Cli::parse().command {
        Some(Command::Up { workspace }) => up(&workspace).await,
        Some(Command::Ls {
            target: LsTarget::Machines,
        }) => ls_machines().await,
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
    match yantra_core::up::up(name).await {
        Ok(report) => {
            let session = report.opened.session();
            let verb = if report.opened.was_created() {
                "opened"
            } else {
                "attached to"
            };
            println!(
                "{verb} {} on {}",
                report.workspace.name, report.workspace.machine
            );
            println!(
                "  attach: {}",
                attach_hint(&report.workspace.machine, report.tmux.path(), &session.name)
            );
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

/// I-36: `ssh -t` forwards the client's `TERM` and tmux aborts if the far side
/// lacks that terminfo entry. Pin one every database carries.
const ATTACH_TERM: &str = "xterm-256color";

const HEADINGS: [&str; 4] = ["MACHINE", "OS", "STATUS", "LAST SEEN"];

/// The tailnet as a table. Advisory only — ADR-0009 keeps `~/.ssh/config`
/// authoritative over what a name means, so this reports and never gates.
fn render_machines(machines: &[MachineInfo]) -> String {
    let rows: Vec<[String; 4]> = machines.iter().map(row).collect();

    let mut widths = HEADINGS.map(str::len);
    for cells in &rows {
        for (width, cell) in widths.iter_mut().zip(cells) {
            *width = (*width).max(cell.chars().count());
        }
    }

    let mut out = String::new();
    push_row(&mut out, &HEADINGS.map(String::from), &widths);
    for cells in &rows {
        push_row(&mut out, cells, &widths);
    }

    // Counting *online* is what stops the dual boot reading as two, without
    // guessing which nodes share a box — `HostName` would pair the phones too.
    let online = machines.iter().filter(|m| m.online).count();
    out.push_str(&format!("\n{} machines, {online} online\n", machines.len()));
    out
}

fn row(machine: &MachineInfo) -> [String; 4] {
    [
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

fn push_row(out: &mut String, cells: &[String; 4], widths: &[usize; 4]) {
    let padded: Vec<String> = cells
        .iter()
        .zip(widths)
        .map(|(cell, width)| format!("{cell:<width$}", width = *width))
        .collect();
    out.push_str(padded.join("  ").trim_end());
    out.push('\n');
}

/// Every part is load-bearing: the session is remote, the login shell cannot
/// find tmux (I-34), `-t` forwards a `TERM` the far side may lack (I-36), and
/// zsh eats an unquoted `=name` (I-35).
fn attach_hint(machine: &str, tmux: &str, session: &str) -> String {
    format!("ssh {machine} -t \"TERM={ATTACH_TERM} {tmux} attach -t '={session}'\"")
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
        let hint = attach_hint("mac", "/opt/homebrew/bin/tmux", "demo");
        assert_eq!(
            hint,
            "ssh mac -t \"TERM=xterm-256color /opt/homebrew/bin/tmux attach -t '=demo'\""
        );
    }

    /// I-35: unquoted, zsh expands `=demo` and the attach silently misses.
    #[test]
    fn the_session_target_is_quoted_against_zsh() {
        assert!(attach_hint("mac", "/usr/bin/tmux", "demo").contains("'=demo'"));
    }

    #[test]
    fn an_unrecognised_os_reaches_the_table_verbatim() {
        let odd = machine("nas", Os::Other("freebsd".to_string()), true, false, None);
        assert!(render_machines(&[odd]).contains("freebsd"));
    }
}
