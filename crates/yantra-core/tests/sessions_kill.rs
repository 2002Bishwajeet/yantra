//! Stopping a session by machine and name, against a real tmux (§B3).
//!
//! Y-178. The half worth proving is not the kill — `tmux kill-session` does
//! that — it is the sentence afterwards. `Tmux::kill` treats absence as success
//! (correctly, I-30), so it cannot tell a caller whether it destroyed anything,
//! and a person reading *killed* about a session that was never there has been
//! told something untrue. The `present` check is what buys that distinction, and
//! a fake tmux would agree with whatever it was told.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use std::path::PathBuf;
use yantra_core::sessions;
use yantra_core::ssh::{Machine, Ssh};
use yantra_core::tmux::Tmux;

struct Lab {
    _fixture: SshFixture,
    ssh: Ssh,
    tmux: Tmux,
}

impl Lab {
    async fn start(label: &str) -> Result<Option<Self>> {
        let Some(fixture) = SshFixture::start()? else {
            return Ok(None);
        };
        let dir = PathBuf::from("/tmp").join(format!("ya-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let ssh = Ssh::new(Machine {
            host: fixture.host().to_owned(),
            user: Some(USER.to_owned()),
            port: Some(fixture.port()),
            identity: Some(fixture.key_path()),
            state_dir: dir,
        })?;
        let tmux = Tmux::resolve(&ssh).await?;
        Ok(Some(Self {
            _fixture: fixture,
            ssh,
            tmux,
        }))
    }
}

#[tokio::test]
async fn a_session_that_is_there_is_killed_and_reported_as_killed() -> Result<()> {
    let Some(lab) = Lab::start("killreal").await? else {
        return Ok(());
    };
    lab.tmux.ensure(&lab.ssh, "killme", "/tmp", None).await?;

    let report = sessions::kill_on(&lab.ssh, &lab.tmux, "fixture", "killme").await?;
    assert!(report.killed, "it was there, so it was killed");
    assert_eq!(report.session, "killme");

    let left = lab.tmux.list(&lab.ssh).await?;
    assert!(
        !left.iter().any(|s| s.name == "killme"),
        "the session is gone from tmux itself, not only from the report: {left:?}"
    );
    Ok(())
}

/// The distinction this module exists for. `Tmux::kill` succeeds here either
/// way, so only the `present` check separates *killed* from *was never there*.
#[tokio::test]
async fn a_session_that_was_never_there_is_reported_as_absent_not_killed() -> Result<()> {
    let Some(lab) = Lab::start("killabsent").await? else {
        return Ok(());
    };

    let report = sessions::kill_on(&lab.ssh, &lab.tmux, "fixture", "neverexisted").await?;
    assert!(!report.killed, "nothing was destroyed, so say so");
    Ok(())
}

/// Idempotency (§B4): the second call is the state the first one produced, and
/// it must not become an error just because the first call succeeded.
#[tokio::test]
async fn killing_twice_succeeds_and_the_second_says_nothing_was_there() -> Result<()> {
    let Some(lab) = Lab::start("killtwice").await? else {
        return Ok(());
    };
    lab.tmux.ensure(&lab.ssh, "twice", "/tmp", None).await?;

    assert!(
        sessions::kill_on(&lab.ssh, &lab.tmux, "fixture", "twice")
            .await?
            .killed
    );
    assert!(
        !sessions::kill_on(&lab.ssh, &lab.tmux, "fixture", "twice")
            .await?
            .killed,
        "the second call finds nothing, and that is success"
    );
    Ok(())
}
