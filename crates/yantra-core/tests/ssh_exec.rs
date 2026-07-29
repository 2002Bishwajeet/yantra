//! Y-041 against a real sshd, per §B3. Mocks would only prove the mock.
//!
//! The cases that matter are the ones plain `ssh` gets wrong: a remote exit of
//! 255, and a command killed by a signal. Both are reported by `ssh` as exit
//! 255 with empty stderr, so anything that passes these is genuinely reading
//! the remote status rather than `ssh`'s.

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::ssh::{Error, Exec, Machine, Ssh};

fn ssh_to(fixture: &SshFixture, state_dir: &std::path::Path) -> Result<Ssh> {
    Ok(Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: state_dir.to_owned(),
    })?)
}

/// Short on purpose: `%C` adds 40 characters and the socket path budget is 90.
fn state_dir(label: &str) -> Result<std::path::PathBuf> {
    let dir = std::path::PathBuf::from("/tmp").join(format!("yx-{label}"));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[tokio::test]
async fn reports_the_real_exit_status_including_255_and_signals() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let dir = state_dir("status")?;
    let ssh = ssh_to(&fixture, &dir)?;

    let out = ssh.exec("exit 0").await?;
    assert_eq!(out.status, 0, "a successful command");
    assert!(out.success());

    let out = ssh.exec("exit 7").await?;
    assert_eq!(out.status, 7, "an ordinary failure");

    // `ssh` reports this as 255 with empty stderr, identically to a dropped
    // connection. Reading 255 here means the sentinel is doing its job.
    let out = ssh.exec("exit 255").await?;
    assert_eq!(out.status, 255, "a remote 255 is not a transport failure");

    // `ssh` cannot express this at all: clientloop.c has no `exit-signal`
    // branch, so it surfaces as 255.
    let out = ssh.exec("kill -9 $$").await?;
    assert_eq!(out.status, 137, "SIGKILL is recovered as 128+9");

    let out = ssh.exec("kill -TERM $$").await?;
    assert_eq!(out.status, 143, "SIGTERM is recovered as 128+15");

    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

#[tokio::test]
async fn stdout_is_byte_exact_and_stderr_excludes_the_sentinel() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let dir = state_dir("streams")?;
    let ssh = ssh_to(&fixture, &dir)?;

    let out = ssh.exec("printf 'a\\nb'; printf 'oops' >&2").await?;
    assert_eq!(out.stdout, b"a\nb", "stdout is not reformatted");
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "oops",
        "the sentinel trailer is stripped before the caller sees stderr"
    );
    assert!(
        !String::from_utf8_lossy(&out.stderr).contains(':'),
        "no sentinel leaked into stderr"
    );

    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

/// The reason the payload is base64 rather than quoted: `ssh` hands its
/// arguments to the remote *login shell*, so this would otherwise execute.
#[tokio::test]
async fn a_command_containing_shell_metacharacters_is_not_expanded() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let dir = state_dir("inject")?;
    let ssh = ssh_to(&fixture, &dir)?;

    let out = ssh.exec("printf '%s' '$(id -un)'").await?;
    assert_eq!(
        out.stdout, b"$(id -un)",
        "the substitution reached the remote side as literal text"
    );

    let out = ssh.exec("printf '%s' \"a'b\\\"c\"").await?;
    assert_eq!(
        out.stdout, b"a'b\"c",
        "mixed quotes survive the wire format"
    );

    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

/// Regression for the stdin-EOF watchdog withdrawn in ADR-0008. It killed
/// every command slower than a few hundred milliseconds, and Y-041's original
/// suite missed it entirely because every command in it was instantaneous.
/// Anything reintroducing a watchdog must keep this passing.
#[tokio::test]
async fn a_slow_command_runs_to_completion() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let dir = state_dir("slow")?;
    let ssh = ssh_to(&fixture, &dir)?;

    let out = ssh.exec("sleep 3; echo finished").await?;
    assert_eq!(out.status, 0, "a three-second command is not a failure");
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "finished",
        "the command produced its output rather than being killed"
    );

    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

/// An unreachable host must be a `Transport` error, never a command status —
/// the distinction Y-042 relies on to avoid creating a duplicate session.
#[tokio::test]
async fn an_unreachable_host_is_a_transport_error() -> Result<()> {
    let dir = state_dir("unreach")?;
    let ssh = Ssh::new(Machine {
        host: "127.0.0.1".to_owned(),
        user: Some("nobody".to_owned()),
        // Reserved as "discard" by IANA; nothing listens here.
        port: Some(9),
        identity: None,
        state_dir: dir.clone(),
    })?;

    let err = ssh
        .exec("exit 0")
        .await
        .expect_err("connecting to a closed port cannot succeed");
    assert!(
        matches!(err, Error::Transport { .. }),
        "got {err:?}, which a caller could mistake for a command result"
    );

    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

#[tokio::test]
async fn multiplexing_reuses_one_connection() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let dir = state_dir("mux")?;
    let ssh = ssh_to(&fixture, &dir)?;

    ssh.exec("true").await?;
    let sockets = std::fs::read_dir(dir.join("cm"))?.count();
    ssh.exec("true").await?;
    assert_eq!(
        std::fs::read_dir(dir.join("cm"))?.count(),
        sockets,
        "the second exec reused the master rather than opening another"
    );
    assert_eq!(sockets, 1, "exactly one control socket exists");

    // Leaving a master running past the test would outlive the container.
    let _ = std::process::Command::new("ssh")
        .args(["-O", "exit", "-o"])
        .arg(format!(
            "ControlPath={}",
            dir.join("cm").join("%C").display()
        ))
        .arg(format!("{USER}@{}", fixture.host()))
        .args(["-p", &fixture.port().to_string()])
        .output();
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}
