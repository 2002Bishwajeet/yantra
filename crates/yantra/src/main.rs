//! `yantra` — the command-line client.
//!
//! The CLI is the daemon's first client and its honesty check: anything the web
//! UI can do must be expressible here first. It calls `yantra-core` in-process
//! today and becomes an HTTP client of `yantrad` in M2 (ADR-0005), which is a
//! change of *where* the work is called from, not *what* it does.

use clap::{CommandFactory as _, Parser, Subcommand};
use std::process::ExitCode;

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
}

#[tokio::main]
async fn main() -> ExitCode {
    match Cli::parse().command {
        Some(Command::Up { workspace }) => up(&workspace).await,
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
                "{verb} {} on {} — tmux attach -t '={}'",
                report.workspace.name, report.workspace.machine, session.name
            );
            ExitCode::SUCCESS
        }
        Err(err) => {
            report_error(&err);
            ExitCode::FAILURE
        }
    }
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

    /// clap's own consistency check. It catches conflicting flags, duplicate
    /// names and bad defaults at test time rather than on first run — the
    /// failures a hand-rolled slice match could not have.
    #[test]
    fn the_command_tree_is_well_formed() {
        Cli::command().debug_assert();
    }
}
