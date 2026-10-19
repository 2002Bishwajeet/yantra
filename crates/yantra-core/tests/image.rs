//! Y-424 against a real sshd in the podman fixture, per §B3: an image pasted
//! into the chat lands over `ssh` at the path it names, in a directory of its
//! own outside the repository, and goes when the chat does.

#![allow(clippy::expect_used)]

mod common;

use std::path::PathBuf;

use anyhow::{Result, ensure};
use common::{SshFixture, USER};
use yantra_core::image::{Error, Images};
use yantra_core::keep::Keeper;
use yantra_core::ssh::{Machine, Ssh};

/// Short on purpose: `%C` adds 40 characters and the socket path budget is 90.
fn state_dir() -> Result<PathBuf> {
    let dir = PathBuf::from("/tmp").join(format!("yi-{}", std::process::id()));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// A 10 MB screenshot's worth of bytes behind a PNG's magic, which nothing on
/// the way may compress away.
fn screenshot() -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut state = 0x2545_f491_u32;
    while bytes.len() < 10_000_000 {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        bytes.extend_from_slice(&state.to_le_bytes());
    }
    bytes
}

#[tokio::test]
async fn an_image_lands_at_the_path_it_names_and_goes_with_the_session() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let state = state_dir()?;
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: state.clone(),
    })?;

    let blob = screenshot();
    let local = state.join("expected.png");
    std::fs::write(&local, &blob)?;
    fixture.copy_in(&local, "/tmp/expected.png")?;

    let mut images = Images::of(&Keeper::new("web", "1a2b3c4d5e6f7a8b"));
    let first = images.put(&ssh, &blob).await?;
    fixture.run(&format!("cmp /tmp/expected.png '{first}'"))?;

    // ADR-0035 decision 4: beside the thread's journals, outside every worktree.
    let home = fixture.run("printf %s \"$HOME\"")?;
    ensure!(first.starts_with('/'), "{first} is not absolute");
    ensure!(
        first.starts_with(&format!("{home}/.yantra/keep/web/1a2b3c4d5e6f7a8b/images/")),
        "{first} is not in the thread's keeper directory"
    );
    let dir = images
        .dir()
        .expect("a directory once an image landed")
        .to_owned();
    ensure!(
        first.starts_with(&format!("{dir}/")),
        "{first} is not in {dir}"
    );
    let mode = fixture.run(&format!("stat -c %a '{dir}'"))?;
    ensure!(mode.trim() == "700", "the directory is {mode}");

    let second = images.put(&ssh, &blob[..4096]).await?;
    ensure!(
        second != first,
        "the second image took the first one's name"
    );
    ensure!(
        second.starts_with(&format!("{dir}/")),
        "{second} is not beside {first}"
    );
    fixture.run(&format!("cmp -n 4096 /tmp/expected.png '{second}'"))?;

    let refused = images.put(&ssh, b"#!/bin/sh\necho not an image\n").await;
    ensure!(matches!(refused, Err(Error::NotAnImage)), "{refused:?}");
    let count = fixture.run(&format!("ls '{dir}' | wc -l"))?;
    ensure!(count.trim() == "2", "the directory holds {count} files");

    images.remove(&ssh).await?;
    fixture.run(&format!("test ! -e '{dir}'"))?;
    let _ = std::fs::remove_dir_all(&state);
    Ok(())
}
