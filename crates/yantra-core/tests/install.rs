//! `install` against a real sshd, a real sudo and a real `apk` (§B3, Y-386).
//!
//! **The one stand-in is `claude`'s installer.** The tests never fetch from
//! claude.ai: the vendor command is a parameter of `install::of`, and these
//! pass a script that writes a stub where the real installer puts `claude`.
//! `tmux`, `git` and the installer's prerequisites are the real Alpine
//! packages, fetched by the container's own `apk`, so the tests that install
//! need the Alpine mirror as the image build does.

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

/// Everything the fixture lacks once `tmux` and `git` are removed: the two
/// basics, then the vendor installer's prerequisites and musl's runtime ones.
const EVERYTHING: &str = "apk add tmux git curl bash libgcc libstdc++ ripgrep";

const TERM: &str = "xterm-256color";

struct Lab {
    fixture: SshFixture,
    ssh: Ssh,
    dirs: Vec<std::path::PathBuf>,
}

impl Lab {
    fn start(label: &str) -> Result<Option<Self>> {
        let Some(fixture) = SshFixture::start()? else {
            return Ok(None);
        };
        let dir = state_dir(label)?;
        let ssh = connect(&fixture, USER, &dir)?;
        Ok(Some(Self {
            fixture,
            ssh,
            dirs: vec![dir],
        }))
    }

    /// A machine missing both packages, with a sudoers line of its own.
    fn bare(&self, sudoers: &str) -> Result<()> {
        self.fixture.arrange_as_root(&format!(
            "apk del -q tmux git && printf '%s\\n' '{sudoers}' > /etc/sudoers.d/yantra \
             && chmod 440 /etc/sudoers.d/yantra"
        ))
    }

    /// The same key, for root: sshd reloads its config on SIGHUP, and it is
    /// PID 1 in the fixture.
    async fn as_root(&mut self) -> Result<Ssh> {
        self.fixture.arrange_as_root(
            "mkdir -p /root/.ssh && cp /home/yantra/.ssh/authorized_keys /root/.ssh/ \
             && chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys \
             && sed -i 's/^PermitRootLogin no/PermitRootLogin prohibit-password/' \
                /etc/ssh/sshd_config && kill -HUP 1",
        )?;
        let dir = state_dir("root")?;
        self.dirs.push(dir.clone());
        let root = connect(&self.fixture, "root", &dir)?;
        for _ in 0..50 {
            if root.exec("true").await.is_ok() {
                return Ok(root);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        anyhow::bail!("sshd never let root in after the reload")
    }

    async fn stand_in_ran(&self) -> Result<bool> {
        Ok(self.ssh.exec("test -e /tmp/stand-in-ran").await?.success())
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        for dir in &self.dirs {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

fn state_dir(label: &str) -> Result<std::path::PathBuf> {
    let dir = std::path::PathBuf::from("/tmp").join(format!("yi-{label}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn connect(fixture: &SshFixture, user: &str, dir: &std::path::Path) -> Result<Ssh> {
    Ok(Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(user.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: dir.to_owned(),
    })?)
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

fn all(outcome: &Outcome) -> Vec<(Tool, Outcome)> {
    [Tool::Tmux, Tool::Git, Tool::Claude]
        .into_iter()
        .map(|tool| (tool, outcome.clone()))
        .collect()
}

/// ADR-0028's whole promise on the machine it is for: all three missing,
/// sudo that asks for nothing, one call — and `doctor` agrees afterwards.
/// No settings file is written: on musl the agent gets its ripgrep setting at
/// launch. Asked twice, the second call finds everything and does nothing.
#[tokio::test]
async fn a_bare_machine_with_passwordless_sudo_gets_all_three() -> Result<()> {
    let Some(lab) = Lab::start("bare")? else {
        return Ok(());
    };
    lab.bare("yantra ALL=(ALL) NOPASSWD: ALL")?;
    let before = doctor::of(&lab.ssh, TERM).await;
    for check in ["tmux", "git", "agent-cli"] {
        assert_eq!(state(&before, check), State::Absent, "{check} before");
    }

    let report = install::of(&lab.ssh, "lab", STAND_IN).await?;
    assert_eq!(outcomes(&report), all(&Outcome::Installed), "{report:#?}");
    assert!(report.complete());

    let after = doctor::of(&lab.ssh, TERM).await;
    for check in ["tmux", "git", "agent-cli"] {
        assert_eq!(state(&after, check), State::Present, "{check} after");
    }
    let written = lab
        .ssh
        .exec("test -e \"$HOME/.claude/settings.json\"")
        .await?;
    assert!(
        !written.success(),
        "no settings file is written (owner, 2026-09-13)"
    );

    let again = install::of(&lab.ssh, "lab", STAND_IN).await?;
    assert_eq!(
        outcomes(&again),
        all(&Outcome::Present),
        "a second install finds what is there"
    );
    Ok(())
}

/// ADR-0028 §5: a sudo that wants a password stops the package step, and the
/// report names the one command to run there. `claude` waits on that step for
/// its installer's prerequisites, so it stops too, and nothing moves.
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
        because: Because::SudoAsks,
        command: Some(format!("sudo {EVERYTHING}")),
    };
    assert_eq!(outcomes(&report), all(&left), "{report:#?}");
    assert!(!report.complete());
    assert!(!lab.stand_in_ran().await?, "claude's installer never ran");

    let after = doctor::of(&lab.ssh, TERM).await;
    assert_eq!(state(&after, "tmux"), State::Absent);
    assert_eq!(state(&after, "git"), State::Absent);
    Ok(())
}

/// Root needs no sudo: the fixture has no sudoers line for anyone, and root
/// installs everything.
#[tokio::test]
async fn a_root_account_installs_without_sudo() -> Result<()> {
    let Some(mut lab) = Lab::start("root")? else {
        return Ok(());
    };
    lab.fixture.arrange_as_root("apk del -q tmux git")?;
    let root = lab.as_root().await?;

    let report = install::of(&root, "lab", STAND_IN).await?;
    assert_eq!(outcomes(&report), all(&Outcome::Installed), "{report:#?}");
    Ok(())
}

/// No package manager Yantra knows: every tool, `claude` included for its
/// installer's prerequisites, is left for a person with no command to name.
#[tokio::test]
async fn no_package_manager_names_no_command() -> Result<()> {
    let Some(lab) = Lab::start("nomanager")? else {
        return Ok(());
    };
    lab.fixture
        .arrange_as_root("apk del -q tmux git && mv \"$(command -v apk)\" /root/apk.gone")?;

    let report = install::of(&lab.ssh, "lab", STAND_IN).await?;
    let left = Outcome::ForYou {
        because: Because::NoPackageManager,
        command: None,
    };
    assert_eq!(outcomes(&report), all(&left), "{report:#?}");
    assert!(!lab.stand_in_ran().await?);
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
    assert_eq!(outcomes(&report), all(&Outcome::Present), "{report:#?}");
    assert!(report.complete());
    assert!(!lab.stand_in_ran().await?, "nothing ran for a present tool");
    Ok(())
}

/// Y-394, ADR-0030: the step a password-wanting sudo stopped runs in a one-off
/// terminal, the password goes in as keystrokes, and the install completes.
/// There is no tmux on the machine and none is needed: it is one of the things
/// being installed.
#[tokio::test]
async fn a_password_sudo_step_completes_in_a_one_off_terminal() -> Result<()> {
    use std::time::Duration;
    use yantra_core::pty;

    // Every thread's log, for this whole test binary: the pty's reader is a
    // thread of its own, and a per-thread capture would not see it.
    let capture = Capture::default();
    let writer = capture.clone();
    let _ = tracing::subscriber::set_global_default(
        tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .with_writer(move || writer.clone())
            .finish(),
    );

    let Some(lab) = Lab::start("terminal")? else {
        return Ok(());
    };
    lab.bare("yantra ALL=(ALL) ALL")?;
    lab.fixture
        .arrange_as_root("echo 'yantra:typed-as-keys' | chpasswd")?;

    let report = install::of(&lab.ssh, "lab", STAND_IN).await?;
    let command = report
        .steps
        .iter()
        .find_map(|step| match &step.outcome {
            Outcome::ForYou {
                because: Because::SudoAsks,
                command: Some(command),
            } => Some(command.clone()),
            _ => None,
        })
        .expect("sudo asked for a password, so a step was left for a person");

    let mut terminal = pty::run_on(
        &lab.ssh,
        &command,
        TERM,
        pty::Size {
            rows: 30,
            cols: 100,
        },
    )?;
    let mut seen = String::new();
    // Nothing is typed until sudo has asked, on the terminal.
    let asked = tokio::time::Instant::now() + Duration::from_secs(30);
    while !seen.to_lowercase().contains("password") {
        let bytes = tokio::time::timeout_at(asked, terminal.read())
            .await
            .map_err(|_| anyhow::anyhow!("sudo never asked: {seen}"))?
            .ok_or_else(|| anyhow::anyhow!("the terminal ended before sudo asked: {seen}"))?;
        seen.push_str(&String::from_utf8_lossy(&bytes));
    }
    terminal.write(b"typed-as-keys\r".to_vec()).await?;
    // `apk` fetches from the Alpine mirror, as the image build does.
    let done = tokio::time::Instant::now() + Duration::from_secs(300);
    while let Some(bytes) = tokio::time::timeout_at(done, terminal.read())
        .await
        .map_err(|_| anyhow::anyhow!("the command never ended: {seen}"))?
    {
        seen.push_str(&String::from_utf8_lossy(&bytes));
    }

    assert_eq!(terminal.exited().await, Some(0), "{seen}");
    assert!(
        !seen.contains("typed-as-keys"),
        "sudo does not echo a password: {seen}"
    );
    let after = doctor::of(&lab.ssh, TERM).await;
    assert_eq!(state(&after, "tmux"), State::Present);
    assert_eq!(state(&after, "git"), State::Present);

    // Q5: neither the password nor what the terminal printed is in any log.
    let logged = String::from_utf8_lossy(&capture.0.lock().expect("the log")).into_owned();
    assert!(
        !logged.contains("typed-as-keys"),
        "the password reached a log: {logged}"
    );
    for line in seen.lines().map(str::trim).filter(|line| line.len() > 12) {
        assert!(
            !logged.contains(line),
            "a printed line reached a log: {line}"
        );
    }
    Ok(())
}

/// A log that a test reads back.
#[derive(Clone, Default)]
struct Capture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("the log").extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
