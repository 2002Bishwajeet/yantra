//! `yantra-agent` — the per-machine heartbeat agent.
//!
//! Exists because Tailscale exposes **no** CPU/RAM/GPU/battery/load telemetry
//! (R1, verified against `ipnstate.PeerStatus`, the API v2 OpenAPI spec, and
//! `tailscale metrics`), and because SSH-polling cannot see a sleeping laptop
//! (R5). Pushes a heartbeat every 10s; the daemon marks a machine stale at 30s.
//!
//! Deliberately tiny: it reports, it does not decide. Keeping it that way is
//! what stops Yantra drifting from "orchestrator" into "fleet management" (R-12).
//!
//! Nothing is implemented yet — this is the M0 skeleton.

fn main() -> anyhow::Result<()> {
    println!(
        "yantra-agent {} — not implemented yet",
        env!("CARGO_PKG_VERSION")
    );
    Ok(())
}
