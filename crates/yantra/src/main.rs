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

/// I-36: `ssh -t` forwards the client's `TERM`, and tmux aborts outright when
/// the far side has no terminfo entry for it — measured against the MacBook,
/// which has never heard of `xterm-ghostty`. The client's terminal is unbounded,
/// so the hint pins one that every terminfo database carries instead.
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

    // Counting the *online* machines is what stops the dual-booted laptop
    // reading as two: its nodes are one box, so only one can ever be up.
    // Tailscale cannot say they are related, and the obvious guess is worse
    // than none — grouping by `HostName` pairs them correctly and pairs the
    // iPad with the iPhone (I-33).
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

/// I-39: an expired key is a third state, not a flavour of offline. Such a
/// node cannot re-authenticate until someone signs in on the device itself.
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

/// A command that actually attaches to the session `up` just opened.
///
/// Three things it cannot leave out, each of which breaks it on a real machine:
///
/// - **`ssh <machine>`** — the session is on `machine`, not here. A bare
///   `tmux attach` would find a local session of the same name, or none.
/// - **the absolute tmux path** (I-34) — `ssh host "tmux …"` runs through the
///   login shell non-interactively, which on macOS never sees Homebrew.
/// - **`TERM=`** (I-36) — `-t` forwards the client's `TERM` and tmux refuses to
///   attach when the far side lacks that terminfo entry.
///
/// `=name` is quoted because I-35: the MacBook's login shell is zsh, where a
/// bare `=word` is filename expansion.
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

    /// clap's own consistency check. It catches conflicting flags, duplicate
    /// names and bad defaults at test time rather than on first run — the
    /// failures a hand-rolled slice match could not have.
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

    /// The dual boot, exactly as this tailnet reports it: one physical laptop,
    /// two node IDs, and the Linux side's key expired while it was down.
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

    /// I-39. `LastSeen` on an online peer is unrelated to reachability — the
    /// live tailnet has an online peer holding a real timestamp and an online
    /// `Self` holding the zero time — so the column stays empty there.
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

    /// Every element here was verified against the real MacBook: without the
    /// pinned `TERM` the identical command aborts with `missing or unsuitable
    /// terminal: xterm-ghostty`, and without the absolute path the login shell
    /// cannot find tmux at all.
    #[test]
    fn the_attach_hint_survives_a_remote_machine() {
        let hint = attach_hint("mac", "/opt/homebrew/bin/tmux", "demo");
        assert_eq!(
            hint,
            "ssh mac -t \"TERM=xterm-256color /opt/homebrew/bin/tmux attach -t '=demo'\""
        );
    }

    /// I-35: unquoted, zsh treats `=demo` as filename expansion and the attach
    /// fails with `zsh: demo not found` while the session sits there untouched.
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
