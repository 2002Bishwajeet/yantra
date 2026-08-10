//! Asking a machine about a path, against a real shell and a real git (§B3).
//!
//! Y-184. The unit tests hold captured stdout and would keep passing if the
//! shell fragment stopped working entirely — it is one `if`/`printf`/`git`
//! pipeline sent to `/bin/sh` on another machine, and only a real one can say
//! whether it parses, whether `git`'s failure is really swallowed, and whether a
//! path with a space survives the quoting.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use std::path::PathBuf;
use yantra_core::probe;
use yantra_core::ssh::{Exec, Machine, Ssh};

async fn lab(label: &str) -> Result<Option<(SshFixture, Ssh)>> {
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
    Ok(Some((fixture, ssh)))
}

#[tokio::test]
async fn a_directory_that_is_there_is_found() -> Result<()> {
    let Some((_fixture, ssh)) = lab("probe-there").await? else {
        return Ok(());
    };
    ssh.exec("mkdir -p /tmp/probe-plain").await?;

    let found = probe::probe_on(&ssh, "fixture", "/tmp/probe-plain").await?;
    assert!(found.exists);
    assert_eq!(found.origin, None, "no git repository, so no origin");
    Ok(())
}

#[tokio::test]
async fn a_directory_that_is_not_there_is_not_an_error() -> Result<()> {
    let Some((_fixture, ssh)) = lab("probe-absent").await? else {
        return Ok(());
    };

    let found = probe::probe_on(&ssh, "fixture", "/tmp/no-such-place").await?;
    assert!(!found.exists, "absent is an answer, not a failure");
    Ok(())
}

/// `test -d` is the question `up` asks, and matching it exactly is the point —
/// a file is not somewhere a session can `cd`.
#[tokio::test]
async fn a_file_is_not_a_directory() -> Result<()> {
    let Some((_fixture, ssh)) = lab("probe-file").await? else {
        return Ok(());
    };
    ssh.exec("touch /tmp/probe-a-file").await?;

    assert!(
        !probe::probe_on(&ssh, "fixture", "/tmp/probe-a-file")
            .await?
            .exists
    );
    Ok(())
}

/// The half the unit tests cannot reach: whether `git`'s own failure is really
/// swallowed on a real `/bin/sh`, rather than taking the whole probe with it.
#[tokio::test]
async fn a_real_repository_reports_its_origin_and_a_bare_directory_does_not() -> Result<()> {
    let Some((_fixture, ssh)) = lab("probe-git").await? else {
        return Ok(());
    };
    let out = ssh.exec("command -v git || true").await?;
    if String::from_utf8_lossy(&out.stdout).trim().is_empty() {
        // Saying so beats a silent pass: this test's whole subject is git.
        eprintln!("skipped: no git in the fixture image");
        return Ok(());
    }

    ssh.exec(
        "mkdir -p /tmp/probe-repo && cd /tmp/probe-repo && git init -q && \
         git remote add origin https://example.invalid/o/r.git",
    )
    .await?;

    let found = probe::probe_on(&ssh, "fixture", "/tmp/probe-repo").await?;
    assert!(found.exists);
    assert_eq!(
        found.origin.as_deref(),
        Some("https://example.invalid/o/r.git")
    );
    Ok(())
}

/// A path is a value a person typed, so it reaches a remote shell as one
/// quoted word or it reaches it as several commands.
#[tokio::test]
async fn a_path_with_a_space_survives_the_shell() -> Result<()> {
    let Some((_fixture, ssh)) = lab("probe-space").await? else {
        return Ok(());
    };
    ssh.exec("mkdir -p '/tmp/probe dir'").await?;

    assert!(
        probe::probe_on(&ssh, "fixture", "/tmp/probe dir")
            .await?
            .exists
    );
    Ok(())
}
