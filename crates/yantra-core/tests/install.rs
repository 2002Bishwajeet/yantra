//! `install` against a real sshd, a real sudo and a real `apk` (§B3, Y-386).
//!
//! **The one stand-in is `claude`'s installer.** The tests never fetch from
//! claude.ai: the vendor command is a parameter of `install::of`, and these
//! pass a script that writes a stub where the real installer puts `claude`.
//! `tmux` and `git` are the real Alpine packages, fetched by the container's
//! own `apk`, so the first test needs the Alpine mirror as the image build does.

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::doctor::{self, Check, State};
use yantra_core::install::{self, Because, Outcome, Report, Tool};
use yantra_core::ssh::{Exec as _, Machine, Ssh};

/// Writes a stub where the vendor's installer writes `claude`, and leaves a
/// mark so a test can tell whether it ran.
const STAND_IN: &str = "mkdir -p \"$HOME/.local/bin\" \
    && printf '#!/bin/sh\\nexit 0\\n' > \"$HOME/.local/bin/claude\" \
    && chmod 755 \"$HOME/.local/bin/claude\" && touch /tmp/stand-in-ran";

const TERM: &str = "xterm-256color";

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
        let dir = std::path::PathBuf::from("/tmp").join(format!("yi-{label}"));
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

    /// A machine missing both packages, with a sudoers line of its own.
    fn bare(&self, sudoers: &str) -> Result<()> {
        self.fixture.arrange_as_root(&format!(
            "apk del -q tmux git && printf '%s\\n' '{sudoers}' > /etc/sudoers.d/yantra \
             && chmod 440 /etc/sudoers.d/yantra"
        ))
    }

    async fn checks(&self) -> Vec<Check> {
        doctor::of(&self.ssh, TERM).await
    }

    async fn stand_in_ran(&self) -> Result<bool> {
        Ok(self.ssh.exec("test -e /tmp/stand-in-ran").await?.success())
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn state(checks: &[Check], name: &str) -> State {
    checks
        .iter()
        .find(|check| check.check == name)
        .map(|check| check.state)
        .expect("doctor reports every check")
}

fn outcomes(report: &Report) -> Vec<(Tool, Outcome)> {
    report
        .steps
        .iter()
        .map(|step| (step.tool, step.outcome.clone()))
        .collect()
}

/// ADR-0028's whole promise on the machine it is for: all three missing,
/// sudo that asks for nothing, one call — and `doctor` agrees afterwards.
/// Asked twice, the second call finds everything and does nothing.
#[tokio::test]
async fn a_bare_machine_with_passwordless_sudo_gets_all_three() -> Result<()> {
    let Some(lab) = Lab::start("bare")? else {
        return Ok(());
    };
    lab.bare("yantra ALL=(ALL) NOPASSWD: ALL")?;
    let before = lab.checks().await;
    for check in ["tmux", "git", "agent-cli"] {
        assert_eq!(state(&before, check), State::Absent, "{check} before");
    }

    let report = install::of(&lab.ssh, "lab", STAND_IN).await?;
    assert_eq!(
        outcomes(&report),
        [
            (Tool::Tmux, Outcome::Installed),
            (Tool::Git, Outcome::Installed),
            (Tool::Claude, Outcome::Installed),
        ],
        "{report:#?}"
    );
    assert!(report.complete());

    let after = lab.checks().await;
    for check in ["tmux", "git", "agent-cli"] {
        assert_eq!(state(&after, check), State::Present, "{check} after");
    }

    let again = install::of(&lab.ssh, "lab", STAND_IN).await?;
    assert!(
        again
            .steps
            .iter()
            .all(|step| step.outcome == Outcome::Present),
        "a second install attaches to what is there: {again:#?}"
    );
    Ok(())
}

/// ADR-0028 §5: a sudo that wants a password stops the package step, the
/// report names the one command to run there, and no package moves. The
/// `claude` step needs no root, so it still runs.
#[tokio::test]
async fn a_sudo_that_wants_a_password_stops_and_names_the_command() -> Result<()> {
    let Some(lab) = Lab::start("password")? else {
        return Ok(());
    };
    lab.bare("yantra ALL=(ALL) ALL")?;
    lab.fixture
        .arrange_as_root("echo 'yantra:typed-nowhere' | chpasswd")?;

    let report = install::of(&lab.ssh, "lab", STAND_IN).await?;
    let left = Outcome::ForYou {
        because: Because::NeedsRoot,
        command: Some("sudo apk add tmux git".to_owned()),
    };
    assert_eq!(
        outcomes(&report),
        [
            (Tool::Tmux, left.clone()),
            (Tool::Git, left),
            (Tool::Claude, Outcome::Installed),
        ],
        "{report:#?}"
    );
    assert!(!report.complete());

    let after = lab.checks().await;
    assert_eq!(state(&after, "tmux"), State::Absent);
    assert_eq!(state(&after, "git"), State::Absent);
    Ok(())
}

/// A machine that has all three is left alone: every step is `Present`, and
/// the vendor's installer never runs.
#[tokio::test]
async fn a_machine_that_has_everything_is_left_alone() -> Result<()> {
    let Some(lab) = Lab::start("equipped")? else {
        return Ok(());
    };
    let placed = lab
        .ssh
        .exec(&format!("{STAND_IN} && rm /tmp/stand-in-ran"))
        .await?;
    anyhow::ensure!(placed.success(), "placing the claude stub failed");

    let report = install::of(&lab.ssh, "lab", STAND_IN).await?;
    assert!(
        report
            .steps
            .iter()
            .all(|step| step.outcome == Outcome::Present),
        "{report:#?}"
    );
    assert!(report.complete());
    assert!(!lab.stand_in_ran().await?, "nothing ran for a present tool");
    Ok(())
}
