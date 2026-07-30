//! Y-052 against the real MacBook — the machine that raised I-34.
//!
//! Ignored rather than skipped (I-32): CI has no tailnet and no macOS, and a
//! skip CI cannot detect is how Y-031's fixture nearly stopped testing
//! anything. This is the check the container structurally cannot make —
//! Homebrew's prefix, zsh's `~/.zprofile`, and macOS `path_helper` are what put
//! tmux outside the non-interactive `PATH` in the first place.
//!
//! ```text
//! YANTRA_MAC=user@host cargo test -p yantra-core --test manual_macbook -- --ignored --nocapture
//! ```

use yantra_core::ssh::{Exec as _, Machine, Ssh};
use yantra_core::tmux::Tmux;

#[tokio::test]
#[ignore = "needs the real MacBook; set YANTRA_MAC=user@host"]
async fn tmux_resolves_on_real_macos() -> anyhow::Result<()> {
    let dest = std::env::var("YANTRA_MAC")?;
    let ssh = Ssh::new(Machine {
        host: dest,
        user: None,
        port: None,
        identity: Some(std::path::PathBuf::from(std::env::var("HOME")?).join(".ssh/id_yantra")),
        state_dir: std::path::PathBuf::from("/tmp/y52"),
    })?;

    let tmux = Tmux::resolve(&ssh).await?;
    println!("resolved: {}", tmux.path());
    assert!(tmux.path().starts_with('/'));

    // The point of I-34: PATH alone would have found nothing here.
    let bare = ssh.exec("command -v tmux || echo NONE").await?;
    println!(
        "command -v tmux: {}",
        String::from_utf8_lossy(&bare.stdout).trim()
    );
    Ok(())
}
