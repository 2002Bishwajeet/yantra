//! The real MacBook — the checks the container structurally cannot make.
//!
//! Homebrew's prefix, zsh's `~/.zprofile` and macOS `path_helper` are what put
//! tmux outside the non-interactive `PATH` in the first place (I-34), and no
//! Alpine container reproduces that. These also run `up` through the paths the
//! container skips: a real workspace file and a real `~/.ssh/config` (ADR-0009).
//!
//! Ignored rather than skipped (I-32): CI has no tailnet and no macOS, and a
//! skip CI cannot detect is how Y-031's fixture nearly stopped testing anything.
//!
//! ```text
//! YANTRA_MAC=<ssh destination> \
//!   cargo test -p yantra-core --test manual_macbook -- --ignored --nocapture
//! ```

use std::path::PathBuf;

use yantra_core::ssh::{Exec as _, Machine, Ssh};
use yantra_core::tmux::Tmux;
use yantra_core::{up, workspace};

/// Long enough to be nobody's real workspace, and legal under `validate_name`.
const E2E: &str = "yantra-manual-e2e";

#[tokio::test]
#[ignore = "needs the real MacBook; set YANTRA_MAC=user@host"]
async fn tmux_resolves_on_real_macos() -> anyhow::Result<()> {
    let dest = std::env::var("YANTRA_MAC")?;
    let ssh = Ssh::new(Machine {
        host: dest,
        user: None,
        port: None,
        identity: Some(PathBuf::from(std::env::var("HOME")?).join(".ssh/id_yantra")),
        state_dir: PathBuf::from("/tmp/y52"),
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

/// Y-055, and with it M2's claim: `up` by name against a machine that is not
/// the one running the test. The container proves [`up::open`]; only this
/// proves the half above it — workspace file, `~/.ssh/config`, real network.
#[tokio::test]
#[ignore = "needs the real MacBook; set YANTRA_MAC=user@host"]
async fn up_opens_a_remote_session_and_the_second_run_attaches() -> anyhow::Result<()> {
    let dest = std::env::var("YANTRA_MAC")?;
    let dir = workspace::workspaces_dir()?;
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{E2E}.toml"));
    anyhow::ensure!(
        !file.exists(),
        "{} already exists — refusing to overwrite it",
        file.display()
    );
    std::fs::write(&file, format!("machine = \"{dest}\"\nrepo = \"/tmp\"\n"))?;
    let mut leaves = Leaves::of(file, E2E);

    let first = up::up(E2E).await?;
    // Registered before the assertions, so a failing one still tidies up.
    leaves.session = Some((dest, first.tmux.path().to_owned()));
    println!(
        "opened {} via {} on {}",
        first.opened.session().session_id,
        first.tmux.path(),
        first.workspace.machine
    );
    assert!(first.opened.was_created(), "the first up opens the session");

    let second = up::up(E2E).await?;
    assert!(
        !second.opened.was_created(),
        "the second up attaches — §B4, over a real network this time"
    );
    assert_eq!(
        first.opened.session().session_id,
        second.opened.session().session_id,
        "and it is the same session, not a second one with the same name"
    );
    Ok(())
}

/// What the test would otherwise leave on someone's laptop. `Drop` because a
/// failed assertion is exactly when a leaked session is hardest to notice.
struct Leaves {
    workspace_file: PathBuf,
    /// The ssh destination and the absolute tmux path, once `up` has found one.
    session: Option<(String, String)>,
    name: &'static str,
}

impl Leaves {
    fn of(workspace_file: PathBuf, name: &'static str) -> Self {
        Self {
            workspace_file,
            session: None,
            name,
        }
    }
}

impl Drop for Leaves {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.workspace_file);
        if let Some((dest, tmux)) = &self.session {
            // I-35: the far side's login shell is zsh, which eats a bare `=name`.
            let _ = std::process::Command::new("ssh")
                .arg(dest)
                .arg("--")
                .arg(format!("{tmux} kill-session -t '={}'", self.name))
                .output();
        }
    }
}
