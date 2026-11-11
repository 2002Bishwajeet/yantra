//! Y-682 against a real sshd and real git, per §B3: the dictation's hotwords
//! come from the index, the manifests and the scripts of a real repository.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::mention::Error;
use yantra_core::ssh::{Machine, Ssh};
use yantra_core::stt;

const REPO: &str = "/home/yantra/hotwords";

/// Short on purpose: `%C` adds 40 characters and the socket path budget is 90.
fn state_dir(label: &str) -> Result<std::path::PathBuf> {
    let dir = std::path::PathBuf::from("/tmp").join(format!("ys-{label}-{}", std::process::id()));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[tokio::test]
async fn hotwords_come_from_the_index_the_manifests_and_the_scripts() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(fixture.key_path()),
        state_dir: state_dir("stt")?,
    })?;
    fixture.run(&format!(
        "mkdir -p {REPO}/crates/yantrad/src {REPO}/web {REPO}/scripts && cd {REPO} && git init -q \
         && printf '[package]\\nname = \"yantrad\"\\n[dependencies]\\ntokio = \"1\"\\n' > crates/yantrad/Cargo.toml \
         && echo 'fn main() {{}}' > crates/yantrad/src/main.rs \
         && printf '{{\"name\":\"web\",\"dependencies\":{{\"react\":\"19\"}}}}' > web/package.json \
         && printf 'lint:\\n    cargo clippy --workspace\\n' > justfile \
         && printf 'podman run --rm img\\n' > scripts/ci.sh \
         && git add . && git -c user.name=t -c user.email=t@example.com commit -qm one \
         && echo untracked > notes && mkdir -p /home/yantra/plain"
    ))?;

    let listing = stt::listing(&ssh, REPO).await?;
    let mut files = listing.files.clone();
    files.sort();
    assert_eq!(
        files,
        [
            "crates/yantrad/Cargo.toml",
            "crates/yantrad/src/main.rs",
            "justfile",
            "scripts/ci.sh",
            "web/package.json"
        ],
        "only the index, so `notes` is not here"
    );
    let read: Vec<&str> = listing.read.iter().map(|(path, _)| path.as_str()).collect();
    assert_eq!(
        read,
        [
            "justfile",
            "crates/yantrad/Cargo.toml",
            "web/package.json",
            "scripts/ci.sh"
        ]
    );

    let words = stt::hotwords(&listing, &[]);
    for word in [
        "yantrad",
        "tokio",
        "web",
        "react",
        "crates",
        "cargo",
        "clippy",
        "workspace",
        "podman",
        "rm",
    ] {
        assert!(words.contains(&word.to_owned()), "{word} in {words:?}");
    }
    assert!(
        words.iter().all(|word| !word.contains(['-', '/', '.'])),
        "{words:?}"
    );

    assert!(matches!(
        stt::listing(&ssh, "/home/yantra/plain").await,
        Err(Error::NotARepo { dir }) if dir == "/home/yantra/plain"
    ));
    Ok(())
}
