//! Y-052 against a real machine, per §B3: finding tmux when `PATH` cannot.
//!
//! **What this container can and cannot prove.** Alpine puts tmux at
//! `/usr/bin/tmux`, and sshd's compiled-in `PATH` includes `/usr/bin`, so the
//! fixture is naturally the case where `PATH` already works — the *opposite* of
//! I-34. These tests therefore move the binary first, which reproduces the
//! *shape* of the macOS failure (installed, but nowhere `PATH` looks) on a
//! machine CI can run.
//!
//! The macOS *specifics* stay out of reach here: zsh's `~/.zprofile`, macOS
//! `path_helper`, and Homebrew's installer choices are what put tmux outside the
//! non-interactive `PATH` in the first place. Those are verified by hand against
//! `bishwajeets-macbook-pro` and recorded in the tracker. Per I-32, a green run
//! of this file must not be read as covering them.

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::ssh::{Machine, Ssh};
use yantra_core::tmux::{Error, Tmux};

struct Lab {
    fixture: SshFixture,
    ssh: Ssh,
    dir: std::path::PathBuf,
}

impl Lab {
    fn start(label: &str) -> Result<Option<Self>> {
        let Some(fixture) = SshFixture::start()? else {
            return Ok(None);
        };
        let dir = std::path::PathBuf::from("/tmp").join(format!("yr-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let ssh = Ssh::new(Machine {
            host: fixture.host().to_owned(),
            user: Some(USER.to_owned()),
            port: Some(fixture.port()),
            identity: Some(fixture.key_path()),
            state_dir: dir.clone(),
        })?;
        Ok(Some(Self { fixture, ssh, dir }))
    }

    /// Moves tmux to `dest`, which must be off the non-interactive `PATH`.
    /// Asserts the precondition, because without it the test passes by accident
    /// — `PATH` would still answer and the candidate list would never run.
    fn hide_tmux_at(&self, dest: &str) -> Result<()> {
        let dir = dest.rsplit_once('/').map(|(d, _)| d).unwrap_or("/");
        self.fixture
            .arrange_as_root(&format!("mkdir -p {dir} && mv /usr/bin/tmux {dest}"))?;

        let found = self.fixture.run("command -v tmux || true")?;
        assert!(
            found.trim().is_empty(),
            "precondition failed: PATH still finds tmux at `{}`, so this test \
             would pass without exercising the candidate list at all",
            found.trim()
        );
        Ok(())
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The I-34 shape: installed, but nowhere the non-interactive `PATH` looks.
#[tokio::test]
async fn tmux_is_found_where_path_cannot_see_it() -> Result<()> {
    let Some(lab) = Lab::start("hidden")? else {
        return Ok(());
    };
    lab.hide_tmux_at("/opt/homebrew/bin/tmux")?;

    let tmux = Tmux::resolve(&lab.ssh).await?;
    assert_eq!(
        tmux.path(),
        "/opt/homebrew/bin/tmux",
        "the candidate list must find what PATH cannot"
    );

    // And the resolved path is usable, not merely a string: this is the whole
    // point of resolving, so it has to open a real session through it.
    let opened = tmux.ensure(&lab.ssh, "hidden", "/tmp", None).await?;
    assert!(opened.was_created());
    tmux.kill(&lab.ssh, "hidden").await?;
    Ok(())
}

/// A machine with no tmux anywhere must say so, rather than surfacing as a
/// transport failure or as a confusing tmux error later on.
#[tokio::test]
async fn a_machine_without_tmux_reports_that_and_not_a_transport_error() -> Result<()> {
    let Some(lab) = Lab::start("absent")? else {
        return Ok(());
    };
    // Somewhere real, but on no candidate list and on no PATH.
    lab.hide_tmux_at("/opt/nowhere/bin/tmux")?;

    let err = Tmux::resolve(&lab.ssh)
        .await
        .expect_err("nothing should be found");
    assert!(
        matches!(err, Error::NotFound { .. }),
        "expected a typed not-found, got {err:?}"
    );
    // The message has to name where it looked, or the machine's owner cannot
    // tell an unusual install prefix from a missing package.
    assert!(err.to_string().contains("/opt/homebrew/bin"), "{err}");
    Ok(())
}

/// `PATH` is consulted first, so a machine that is already configured keeps
/// whichever tmux its owner put on `PATH` — the candidate list never overrides
/// a working answer.
#[tokio::test]
async fn path_wins_when_it_has_an_answer() -> Result<()> {
    let Some(lab) = Lab::start("pathwins")? else {
        return Ok(());
    };

    let tmux = Tmux::resolve(&lab.ssh).await?;
    assert_eq!(
        tmux.path(),
        "/usr/bin/tmux",
        "Alpine's tmux is on PATH, and PATH is the first thing asked"
    );
    Ok(())
}

/// A path that worked at resolve time and then stopped is a different problem
/// from a machine with no tmux, and has to read as one. This is the case a
/// long-lived daemon will hit when a package upgrade moves the binary.
#[tokio::test]
async fn a_binary_that_moves_after_resolution_is_not_reported_as_missing() -> Result<()> {
    let Some(lab) = Lab::start("moved")? else {
        return Ok(());
    };

    let tmux = Tmux::resolve(&lab.ssh).await?;
    assert_eq!(tmux.path(), "/usr/bin/tmux");
    lab.fixture.arrange_as_root("rm /usr/bin/tmux")?;

    let err = tmux
        .ensure(&lab.ssh, "moved", "/tmp", None)
        .await
        .expect_err("the binary is gone");
    assert!(
        matches!(err, Error::Vanished { .. }),
        "expected the it-moved error, got {err:?}"
    );
    assert!(err.to_string().contains("/usr/bin/tmux"), "{err}");
    Ok(())
}

/// The resolved path is absolute, which is the entire contract: a bare name
/// would be re-resolved by whatever shell runs it, which is the bug I-34 names.
#[tokio::test]
async fn the_resolved_path_is_absolute() -> Result<()> {
    let Some(lab) = Lab::start("absolute")? else {
        return Ok(());
    };
    let tmux = Tmux::resolve(&lab.ssh).await?;
    assert!(tmux.path().starts_with('/'), "got `{}`", tmux.path());
    Ok(())
}
