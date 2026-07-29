//! `yantra` — the command-line client.
//!
//! The CLI is the daemon's first client and its honesty check: anything the web
//! UI can do must be expressible here first. It calls `yantra-core` in-process
//! today and becomes an HTTP client of `yantrad` in M2 (ADR-0005), which is a
//! change of *where* the work is called from, not *what* it does.
//!
//! Argument parsing is hand-rolled because there is one command. When there are
//! three, this becomes `clap`.

use std::process::ExitCode;

const USAGE: &str = "\
yantra — a personal developer control plane

USAGE:
    yantra up <workspace>    open a workspace and its tmux session
    yantra --help            show this message
    yantra --version         show the version

Workspaces live in ~/.config/yantra/workspaces/<name>.toml
";

#[tokio::main]
async fn main() -> ExitCode {
    let owned: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = owned.iter().map(String::as_str).collect();

    match args.as_slice() {
        [] | ["--help" | "-h"] => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        ["--version" | "-V"] => {
            println!("yantra {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        ["up", name] => up(name).await,
        _ => {
            eprint!("{USAGE}");
            ExitCode::FAILURE
        }
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
