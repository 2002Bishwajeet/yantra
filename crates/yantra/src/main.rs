//! `yantra` — the command-line client.
//!
//! The CLI is the daemon's first client and its honesty check: anything the web
//! UI can do must be expressible here first. It speaks to `yantrad` over HTTP
//! and holds no orchestration logic of its own.
//!
//! Nothing is implemented yet — this is the M0 skeleton.

fn main() -> anyhow::Result<()> {
    println!("yantra {} — not implemented yet", env!("CARGO_PKG_VERSION"));
    Ok(())
}
