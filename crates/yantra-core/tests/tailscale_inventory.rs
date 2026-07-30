//! The inventory against a real `tailscale`, which CI does not have.
//!
//! Ignored rather than skipped: a skip that CI cannot detect is how Y-031's
//! container fixture nearly stopped testing anything (I-32). This is a
//! developer-run check, and its result belongs in the tracker session log when
//! it is run.
//!
//! ```text
//! cargo test -p yantra-core --test tailscale_inventory -- --ignored --nocapture
//! ```

use yantra_core::inventory::{Inventory, Tailscale};

#[tokio::test]
#[ignore = "needs a running tailscaled; CI has no tailnet"]
async fn the_live_tailnet_parses() -> anyhow::Result<()> {
    let machines = Tailscale.machines().await?;
    assert!(!machines.is_empty(), "a joined tailnet has at least Self");

    for m in &machines {
        // I-33: whatever HostName says, the name Yantra shows must be a legal
        // tmux session name (I-2) and a legal DNS label.
        assert!(
            !m.name.is_empty()
                && m.name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-'),
            "unusable name {:?}",
            m.name
        );
        assert!(m.dns_name.ends_with('.'), "expected a trailing dot");
        println!(
            "{:<24} {:<8} online={:<5} expired={:<5} last_seen={:?}",
            m.name,
            format!("{:?}", m.os),
            m.online,
            m.expired,
            m.last_seen
        );
    }
    Ok(())
}
