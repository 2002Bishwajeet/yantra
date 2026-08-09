//! Y-144 against a real sshd (§B3): the identity Yantra prepares reaches a
//! machine by name alone, and the `known_hosts` nobody typed fills itself.
//!
//! **Every connection here is made from an identity the developer does not
//! have.** The keypair is generated into a scratch directory at test time, the
//! ssh that uses it is given `-F <the config Yantra wrote>` so the developer's
//! own is never read and `IdentityAgent=none` so their agent is never asked,
//! and each test first asserts that the connection is **refused** — it only
//! starts working once the generated public key is placed in the container's
//! `authorized_keys`, which is the owner's half of D2 §2's boundary. Nothing
//! ambient could produce that transition.
//!
//! What a container cannot prove is upstream of all of it: that OpenSSH finds
//! the config at `$HOME/.ssh/config` at all. It resolves that path from
//! `getpwuid`, not from `$HOME`, so the file's *content* is what is proved here
//! and its *discovery* needs the appliance.

// `expect` in a test is a deliberate abort with a message.
#![allow(clippy::expect_used)]

mod common;

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use anyhow::{Result, bail};
use common::{SshFixture, USER};
use yantra_core::identity;
use yantra_core::ssh::{Error, Exec, Machine, Ssh};

/// The name a workspace would spell, meaning nothing until the config says so.
const ALIAS: &str = "fixture-box";

fn scratch(label: &str) -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("yantra-identity-{label}"));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(dir)
}

/// Short on purpose: `%C` adds 40 characters and the socket path budget is 90.
fn state_dir(label: &str) -> Result<PathBuf> {
    let dir = PathBuf::from("/tmp").join(format!("yx-{label}"));
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn authorise(fixture: &SshFixture, public_key: &str) -> Result<()> {
    fixture.arrange_as_root(&format!(
        "printf '%s\\n' '{public_key}' >> /home/{USER}/.ssh/authorized_keys"
    ))
}

/// `ssh` driven by the config Yantra wrote and nothing else. The options match
/// [`yantra_core::ssh`]'s own, plus the two that shut the developer out.
fn ssh_by_name(ssh_dir: &Path, known_hosts: &Path, command: &str) -> Result<Output> {
    Ok(Command::new("ssh")
        .arg("-F")
        .arg(ssh_dir.join("config"))
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "LogLevel=ERROR",
            "-o",
            "IdentityAgent=none",
            "-o",
            "GlobalKnownHostsFile=/dev/null",
        ])
        .arg("-o")
        .arg(format!("UserKnownHostsFile={}", known_hosts.display()))
        .arg(ALIAS)
        .arg("--")
        .arg(command)
        .output()?)
}

/// Whether `known_hosts` holds an entry for that destination, asked of
/// `ssh-keygen` because the entry may be hashed and this repo does not parse
/// someone else's format.
fn known(known_hosts: &Path, destination: &str) -> Result<bool> {
    let out = Command::new("ssh-keygen")
        .arg("-F")
        .arg(destination)
        .arg("-f")
        .arg(known_hosts)
        .output()?;
    Ok(out.status.success() && !out.stdout.is_empty())
}

/// The config is worth only what a real sshd says about it: a `Host` block
/// Yantra wrote, finished by the owner, reaching a machine by name alone.
#[test]
fn a_prepared_identity_reaches_a_real_sshd_by_name_alone() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let dir = scratch("byname")?;
    let known_hosts = dir.join("known_hosts");

    let prepared = identity::prepare_in(&dir, &[ALIAS.to_owned()])?;
    assert!(prepared.generated, "a keypair that did not exist before");
    assert_eq!(prepared.configured, [ALIAS]);
    assert!(prepared.public_key.starts_with("ssh-ed25519 "));

    // D2 §2's "you finish": where the name points and as whom is the owner's,
    // and Yantra could not know either. This block is the last in the file.
    std::fs::write(
        dir.join("config"),
        format!(
            "{}    HostName {}\n    Port {}\n    User {USER}\n",
            std::fs::read_to_string(dir.join("config"))?,
            fixture.host(),
            fixture.port(),
        ),
    )?;

    let refused = ssh_by_name(&dir, &known_hosts, "true")?;
    assert!(
        !refused.status.success(),
        "the far side authorises this key only once it is placed, so nothing \
         of the developer's can be what authenticates: {}",
        String::from_utf8_lossy(&refused.stderr)
    );

    authorise(&fixture, &prepared.public_key)?;
    let out = ssh_by_name(&dir, &known_hosts, "whoami")?;
    if !out.status.success() {
        bail!(
            "the prepared identity did not reach the container: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    assert_eq!(String::from_utf8(out.stdout)?.trim(), USER);

    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

/// The half that was already built, proved rather than assumed: `ssh.rs` gives
/// every connection Yantra's own `known_hosts` under its state directory, with
/// `accept-new` and `BatchMode=yes` — so first contact is recorded with no
/// prompt and no stdin, and a *changed* host key is a hard refusal (M7 §3.3).
#[tokio::test]
async fn yantras_own_known_hosts_fills_unprompted_and_refuses_a_changed_key() -> Result<()> {
    let Some(fixture) = SshFixture::start()? else {
        return Ok(());
    };
    let dir = scratch("hosts")?;
    let state = state_dir("kh")?;
    let known_hosts = state.join("known_hosts");

    let prepared = identity::prepare_in(&dir, &[])?;
    let ssh = Ssh::new(Machine {
        host: fixture.host().to_owned(),
        user: Some(USER.to_owned()),
        port: Some(fixture.port()),
        identity: Some(prepared.key.clone()),
        state_dir: state.clone(),
    })?;

    assert!(
        !known_hosts.exists(),
        "the appliance starts with no known_hosts at all"
    );
    assert!(
        matches!(ssh.exec("true").await, Err(Error::Transport { .. })),
        "the generated key is not authorised yet, so this identity is the only \
         one that could ever make the next call succeed"
    );

    let destination = format!("[{}]:{}", fixture.host(), fixture.port());
    assert!(
        known(&known_hosts, &destination)?,
        "trust-on-first-use recorded the host key with no prompt and no stdin"
    );

    authorise(&fixture, &prepared.public_key)?;
    let out = ssh.exec("whoami").await?;
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), USER);

    // The master would carry the next call without checking anything.
    drop_master(&fixture, &state);
    substitute_host_key(&known_hosts, &dir)?;

    let err = ssh
        .exec("true")
        .await
        .expect_err("a machine whose host key changed must not be reached");
    let Error::Transport { diagnosis, .. } = &err else {
        bail!("got {err:?}, which a caller could mistake for a command result");
    };
    assert!(
        diagnosis.to_lowercase().contains("host key"),
        "the refusal must say what it refused, with nobody there to ask: {diagnosis}"
    );

    std::fs::remove_dir_all(&dir)?;
    std::fs::remove_dir_all(&state)?;
    Ok(())
}

fn drop_master(fixture: &SshFixture, state: &Path) {
    let _ = Command::new("ssh")
        .args(["-O", "exit", "-o"])
        .arg(format!(
            "ControlPath={}",
            state.join("cm").join("%C").display()
        ))
        .arg(format!("{USER}@{}", fixture.host()))
        .args(["-p", &fixture.port().to_string()])
        .output();
}

/// Rewrites the recorded key with another real one, which is what a rebuilt
/// machine looks like from here. The destination field is kept verbatim so a
/// hashed entry survives.
fn substitute_host_key(known_hosts: &Path, dir: &Path) -> Result<()> {
    let other = identity::prepare_in(&dir.join("other"), &[])?;
    let key = other
        .public_key
        .split_whitespace()
        .nth(1)
        .expect("a public key has a type and a body");

    let recorded = std::fs::read_to_string(known_hosts)?;
    let rewritten: Vec<String> = recorded
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .map(|destination| format!("{destination} ssh-ed25519 {key}"))
        .collect();
    std::fs::write(known_hosts, rewritten.join("\n") + "\n")?;
    Ok(())
}
