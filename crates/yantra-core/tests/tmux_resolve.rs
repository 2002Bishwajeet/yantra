//! Y-052 against a real machine, per §B3: finding tmux when `PATH` cannot.
//!
//! The container is the *opposite* of I-34 by default — Alpine's tmux is on
//! sshd's `PATH` — so these tests move the binary first to reproduce the shape.
//! The macOS specifics (zsh, `path_helper`, Homebrew) are out of reach here and
//! covered by `manual_macbook.rs`; per I-32, green here does not mean them.

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

    /// Moves tmux off `PATH`, asserting it really left — otherwise `PATH`
    /// answers and the candidate list is never exercised.
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

/// No tmux anywhere must be a typed error, not a transport failure.
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

/// The candidate list never overrides a `PATH` that already works.
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

/// What a long-lived daemon hits when a package upgrade moves the binary.
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

/// A bare name would be re-resolved by whatever shell runs it — that is I-34.
#[tokio::test]
async fn the_resolved_path_is_absolute() -> Result<()> {
    let Some(lab) = Lab::start("absolute")? else {
        return Ok(());
    };
    let tmux = Tmux::resolve(&lab.ssh).await?;
    assert!(tmux.path().starts_with('/'), "got `{}`", tmux.path());
    Ok(())
}
