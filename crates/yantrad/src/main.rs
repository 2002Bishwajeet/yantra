//! `yantrad` — the Yantra control-plane daemon.
//!
//! Owns machine inventory, workspace definitions, session state, and placement.
//! Every client (CLI, web UI, hardware panel) talks to this and nothing else;
//! no client ever talks directly to a managed machine.
//!
//! Nothing is implemented yet — this is the M0 skeleton.

fn main() -> anyhow::Result<()> {
    println!(
        "yantrad {} — not implemented yet",
        env!("CARGO_PKG_VERSION")
    );
    Ok(())
}
