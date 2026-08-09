//! The ssh identity this account reaches the fleet with — a key and the
//! `~/.ssh/config` entries that bind it to the names workspaces use (Y-144).
//!
//! Every machine name is an ssh destination resolved by that file and never by
//! Yantra (ADR-0009), so an appliance with no config file has workspaces that
//! name nothing. This prepares the half Yantra knows: the key, and a block per
//! machine pointing at it. Where the name points and as whom is the owner's,
//! and so is placing the public key in each `authorized_keys`
//! ([D2](../../../docs/design/02-setup.md) §2).
//!
//! **Nothing here writes a `known_hosts`.** [`crate::ssh`] already gives every
//! connection its own under Yantra's state directory with
//! `StrictHostKeyChecking=accept-new`, so it fills on first contact with nobody
//! typing anything — and a *changed* host key stays a hard refusal.
//!
//! **The key has no passphrase.** `BatchMode=yes` has nowhere to type one, and
//! the alternative is an agent, which is a login session an appliance that
//! nobody logs into does not have ([M7](../../../docs/plans/m7-appliance.md)
//! §3.3).

use std::fs;
use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::workspace;

const KEY: &str = "id_yantra";

/// What [`prepare`] found and what it changed. The public key is here to be
/// printed; the private one is never read.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub key: PathBuf,
    pub public_key: String,
    /// False when a key was already there, which is the second run.
    pub generated: bool,
    pub config: PathBuf,
    /// Machines a `Host` block was appended for.
    pub configured: Vec<String>,
    /// Machines the config already named, left exactly as they are.
    pub left_alone: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not read the workspaces to see which machines to configure")]
    Workspaces(#[from] workspace::Error),

    #[error("no home directory, so there is no ~/.ssh to prepare")]
    NoHome,

    #[error("could not write {}", path.display())]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("could not spawn `ssh-keygen` — is OpenSSH installed and on PATH?")]
    Spawn(#[source] std::io::Error),

    #[error("`ssh-keygen` failed: {0}")]
    Keygen(String),

    #[error("`{machine}` cannot be one `Host` pattern, so no block is written for it")]
    UnusableMachine { machine: String },
}

/// Prepares `~/.ssh` for the account this runs as, for every machine a
/// workspace names.
///
/// Invoked, never automatic: whether generating the keypair is Yantra's job at
/// all is still the owner's to confirm (D2 §2), and a verb survives either
/// answer.
pub fn prepare() -> Result<Prepared, Error> {
    use etcetera::BaseStrategy as _;
    let base = etcetera::choose_base_strategy().map_err(|_| Error::NoHome)?;
    let listing = workspace::list()?;
    let mut machines: Vec<String> = listing
        .workspaces
        .into_iter()
        .map(|workspace| workspace.machine)
        .collect();
    machines.sort();
    machines.dedup();
    prepare_in(&base.home_dir().join(".ssh"), &machines)
}

/// The half the tests drive, against a directory that is not the developer's.
pub fn prepare_in(dir: &Path, machines: &[String]) -> Result<Prepared, Error> {
    // A name carrying a newline would write config lines of its own, and this
    // file decides how every connection Yantra makes is made.
    if let Some(machine) = machines.iter().find(|m| m.split_whitespace().count() != 1) {
        return Err(Error::UnusableMachine {
            machine: machine.clone(),
        });
    }

    let writing = |path: &Path| {
        let path = path.to_owned();
        move |source| Error::Write { path, source }
    };

    fs::create_dir_all(dir).map_err(writing(dir))?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(writing(dir))?;

    let key = dir.join(KEY);
    let generated = !key.exists();
    if generated {
        keygen(&key)?;
    }
    let public = key.with_extension("pub");
    let public_key = fs::read_to_string(&public)
        .map_err(writing(&public))?
        .trim()
        .to_owned();

    let config = dir.join("config");
    let existing = match fs::read_to_string(&config) {
        Ok(text) => text,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(source) => {
            return Err(Error::Write {
                path: config,
                source,
            });
        }
    };

    let mut appended = String::new();
    let mut configured = Vec::new();
    let mut left_alone = Vec::new();
    for machine in machines {
        if names(&existing, machine) || names(&appended, machine) {
            left_alone.push(machine.clone());
            continue;
        }
        appended.push_str(&block(machine, &key));
        configured.push(machine.clone());
    }

    if !appended.is_empty() {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&config)
            .map_err(writing(&config))?;
        // A file that already ended mid-block would swallow the first Host line.
        if !existing.is_empty() && !existing.ends_with('\n') {
            file.write_all(b"\n").map_err(writing(&config))?;
        }
        let appended = match existing.is_empty() {
            true => appended.trim_start_matches('\n'),
            false => &appended,
        };
        file.write_all(appended.as_bytes())
            .map_err(writing(&config))?;
    }

    Ok(Prepared {
        key,
        public_key,
        generated,
        config,
        configured,
        left_alone,
    })
}

/// `IdentitiesOnly` so the appliance offers this key and no other: a box that
/// walks a list of keys gets refused for too many failures before it reaches
/// the right one.
fn block(machine: &str, key: &Path) -> String {
    format!(
        "\nHost {machine}\n    IdentityFile {}\n    IdentitiesOnly yes\n",
        key.display()
    )
}

/// Whether the config already says anything about `machine`. Appending is safe
/// either way — ssh takes the first value it finds, so a block the owner wrote
/// above wins — but a second block for a name is noise a reader has to resolve.
fn names(config: &str, machine: &str) -> bool {
    config.lines().any(|line| {
        let mut tokens = line.split_whitespace();
        tokens
            .next()
            .is_some_and(|key| key.eq_ignore_ascii_case("host"))
            && tokens.any(|pattern| pattern == machine)
    })
}

fn keygen(key: &Path) -> Result<(), Error> {
    let out = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "yantra"])
        .arg("-f")
        .arg(key)
        .output()
        .map_err(Error::Spawn)?;
    if !out.status.success() {
        return Err(Error::Keygen(
            String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        ));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yantra-identity-{label}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_second_run_generates_nothing_and_appends_nothing() {
        let dir = scratch("idempotent");
        let machines = ["cachyos-g14".to_owned()];

        let first = prepare_in(&dir, &machines).expect("prepared");
        assert!(first.generated);
        assert_eq!(first.configured, machines);
        let key = fs::read_to_string(&first.key).expect("the private key is on disk");
        let config = fs::read_to_string(&first.config).expect("a config was written");

        let second = prepare_in(&dir, &machines).expect("prepared again");
        assert!(!second.generated, "the key the fleet authorised is kept");
        assert!(second.configured.is_empty());
        assert_eq!(second.left_alone, machines);
        assert_eq!(
            fs::read_to_string(&second.key).expect("still there"),
            key,
            "regenerating would orphan every authorized_keys entry"
        );
        assert_eq!(
            fs::read_to_string(&second.config).expect("still there"),
            config
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// The owner's own entry is what ADR-0009 calls the escape hatch — a jump
    /// host, a `Match`, an address pinned by hand — and a second block for the
    /// same name is a reader's problem.
    #[test]
    fn a_machine_the_owner_already_configured_is_left_alone() {
        let dir = scratch("owner");
        fs::create_dir_all(&dir).expect("scratch");
        fs::write(
            dir.join("config"),
            "host mac-via-jump bishwajeets-macbook-pro\n    ProxyJump bastion\n",
        )
        .expect("an existing config");

        let prepared = prepare_in(
            &dir,
            &[
                "bishwajeets-macbook-pro".to_owned(),
                "cachyos-g14".to_owned(),
            ],
        )
        .expect("prepared");

        assert_eq!(prepared.left_alone, ["bishwajeets-macbook-pro"]);
        assert_eq!(prepared.configured, ["cachyos-g14"]);
        let config = fs::read_to_string(&prepared.config).expect("readable");
        assert!(config.contains("ProxyJump bastion"), "{config}");
        assert!(config.contains("IdentitiesOnly yes"), "{config}");

        let _ = fs::remove_dir_all(&dir);
    }

    /// `machine` is validated as an ssh destination nowhere (ADR-0009), so it
    /// arrives here as whatever a TOML on disk said.
    #[test]
    fn a_machine_name_that_would_write_its_own_config_lines_is_refused() {
        let dir = scratch("injection");
        let hostile = "cachyos-g14\nHost *\n    ProxyCommand touch /tmp/pwned".to_owned();

        assert!(matches!(
            prepare_in(&dir, &[hostile]),
            Err(Error::UnusableMachine { .. })
        ));
        assert!(!dir.exists(), "refused before anything was written");

        let _ = fs::remove_dir_all(&dir);
    }

    /// `HostName` is not one of them: it defaults to the destination, and a
    /// restated default is a line someone has to read.
    #[test]
    fn the_block_binds_the_key_and_says_nothing_else() {
        let dir = scratch("block");
        let prepared = prepare_in(&dir, &["cachyos-g14".to_owned()]).expect("prepared");
        let config = fs::read_to_string(&prepared.config).expect("readable");

        assert_eq!(
            config,
            format!(
                "Host cachyos-g14\n    IdentityFile {}\n    IdentitiesOnly yes\n",
                prepared.key.display()
            )
        );
        assert!(
            !prepared.public_key.contains("PRIVATE"),
            "only the public half is ever carried out of here"
        );
        assert!(prepared.public_key.starts_with("ssh-ed25519 "));

        let _ = fs::remove_dir_all(&dir);
    }
}
