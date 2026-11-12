//! Y-701, ADR-0046 §2: the owner terminal against a real sshd and a real sudo
//! (§B3). The owner's admin account keeps its password, the daemon's key logs
//! in to it only from the hub's address, and sudo asks for the password as
//! keystrokes.

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

mod common;

use std::net::IpAddr;
use std::time::Duration;

use anyhow::{Result, anyhow};
use common::SshFixture;
use yantra_core::identity;
use yantra_core::pty::{self, Terminal};
use yantra_core::ssh::{Machine, Ssh};

const ADMIN: &str = "owner";
const PASSWORD: &str = "typed-only-as-keys";
const TERM: &str = "xterm-256color";
const SIZE: pty::Size = pty::Size {
    rows: 30,
    cols: 100,
};

/// An admin account with a password and a sudo that asks for it, whose
/// `authorized_keys` holds the run's key behind `from=` set to `addresses`.
fn admin(fixture: &SshFixture, addresses: &[IpAddr]) -> Result<()> {
    let public = std::fs::read_to_string(fixture.key_path().with_extension("pub"))?;
    let line = identity::owner_line(&public, addresses);
    fixture.arrange_as_root(&format!(
        "adduser -D -s /bin/sh {ADMIN} && echo '{ADMIN}:{PASSWORD}' | chpasswd \
         && printf '%s\\n' '{ADMIN} ALL=(ALL) ALL' > /etc/sudoers.d/{ADMIN} \
         && chmod 440 /etc/sudoers.d/{ADMIN} \
         && install -d -o {ADMIN} -g {ADMIN} -m 700 /home/{ADMIN}/.ssh \
         && printf '%s\\n' '{line}' > /home/{ADMIN}/.ssh/authorized_keys \
         && chown {ADMIN}:{ADMIN} /home/{ADMIN}/.ssh/authorized_keys \
         && chmod 600 /home/{ADMIN}/.ssh/authorized_keys"
    ))
}

/// The address sshd sees this host's connections come from, which is what the
/// hub's tailnet address is on a real machine.
fn source(fixture: &SshFixture) -> Result<IpAddr> {
    let client = fixture.run("echo \"$SSH_CLIENT\"")?;
    client
        .split_whitespace()
        .next()
        .and_then(|word| word.parse().ok())
        .ok_or_else(|| anyhow!("no address in SSH_CLIENT: {client:?}"))
}

/// A state directory of its own, so no master another test opened is reused.
fn as_admin(fixture: &SshFixture, label: &str) -> Result<(Ssh, std::path::PathBuf)> {
    let dir = std::path::PathBuf::from("/tmp").join(format!("yo-{label}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(ADMIN.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: dir.clone(),
    })?;
    Ok((ssh, dir))
}

/// Reads until what `seen` gained past `from` holds `wanted`, or fails naming
/// what it did see.
async fn until(
    terminal: &mut Terminal,
    seen: &mut String,
    from: usize,
    wanted: &str,
) -> Result<()> {
    let by = tokio::time::Instant::now() + Duration::from_secs(30);
    while !seen[from..].to_lowercase().contains(wanted) {
        let bytes = tokio::time::timeout_at(by, terminal.read())
            .await
            .map_err(|_| anyhow!("never printed {wanted:?}: {seen}"))?
            .ok_or_else(|| anyhow!("ended before {wanted:?}: {seen}"))?;
        seen.push_str(&String::from_utf8_lossy(&bytes));
    }
    Ok(())
}

async fn to_the_end(terminal: &mut Terminal, seen: &mut String) -> Result<()> {
    let by = tokio::time::Instant::now() + Duration::from_secs(30);
    while let Some(bytes) = tokio::time::timeout_at(by, terminal.read())
        .await
        .map_err(|_| anyhow!("the terminal never ended: {seen}"))?
    {
        seen.push_str(&String::from_utf8_lossy(&bytes));
    }
    Ok(())
}

#[tokio::test]
async fn a_password_sudo_runs_in_the_owner_terminal() -> Result<()> {
    // Every thread's log: the pty's reader is a thread of its own.
    let capture = Capture::default();
    let writer = capture.clone();
    let _ = tracing::subscriber::set_global_default(
        tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .with_writer(move || writer.clone())
            .finish(),
    );

    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    admin(&fixture, &[source(&fixture)?])?;
    let (ssh, dir) = as_admin(&fixture, "sudo")?;

    let mut terminal = pty::login_on(&ssh, TERM, SIZE)?;
    let mut seen = String::new();
    until(&mut terminal, &mut seen, 0, "$ ").await?;
    terminal.write(b"sudo -k; sudo id -u\r".to_vec()).await?;
    until(&mut terminal, &mut seen, 0, "password").await?;
    let before = seen.len();
    terminal.write(format!("{PASSWORD}\r").into_bytes()).await?;
    until(&mut terminal, &mut seen, before, "$ ").await?;
    let answered = seen[before..].to_owned();
    terminal.write(b"exit\r".to_vec()).await?;
    to_the_end(&mut terminal, &mut seen).await?;
    let _ = std::fs::remove_dir_all(&dir);

    assert!(
        answered.lines().any(|line| line.trim() == "0"),
        "sudo ran as root: {answered:?}"
    );
    assert!(
        !seen.contains(PASSWORD),
        "sudo does not echo a password: {seen}"
    );
    assert!(
        terminal.exited().await.is_some(),
        "`exit` ends the terminal with a status: {seen}"
    );

    // Q5: neither the password nor what the terminal printed is in any log.
    let logged = String::from_utf8_lossy(&capture.0.lock().expect("the log")).into_owned();
    assert!(
        !logged.contains(PASSWORD),
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

/// The other half, so the case above cannot pass on a `from=` sshd ignores.
#[tokio::test]
async fn a_key_limited_to_another_address_is_refused() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let elsewhere: IpAddr = "192.0.2.1".parse()?;
    admin(&fixture, &[elsewhere])?;
    let (ssh, dir) = as_admin(&fixture, "from")?;

    let mut terminal = pty::login_on(&ssh, TERM, SIZE)?;
    let mut seen = String::new();
    to_the_end(&mut terminal, &mut seen).await?;
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(terminal.exited().await, Some(255), "{seen}");
    assert!(seen.contains("Permission denied"), "{seen}");
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
