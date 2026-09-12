//! The ssh identity this account reaches the fleet with — a key and the
//! `~/.ssh/config` entries that bind it to the names workspaces use (Y-144).
//!
//! Every machine name is an ssh destination resolved by that file and never by
//! Yantra (ADR-0009), so an appliance with no config file has workspaces that
//! name nothing. This prepares the half Yantra knows: the key, and a block per
//! machine pointing at it. Where the name points is the owner's
//! ([D2](../../../docs/design/02-setup.md) §2). **As whom** is learned from the
//! machine itself since Y-387: [`join_in`] writes the account the join command
//! ran as ([ADR-0029](../../../docs/adr/0029-a-machine-joins-itself.md)).
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

/// The identity as a reader sees it (Y-343): the public half and its
/// fingerprint. The private key is never read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub path: PathBuf,
    /// `ed25519`, read off the public key's own type word.
    pub kind: String,
    pub public_key: String,
    /// `SHA256:…`, as `ssh-keygen -l` prints it.
    pub fingerprint: String,
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

    #[error("could not read {}", path.display())]
    Read {
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

    #[error(
        "`{user}` is not an account name Yantra writes into ~/.ssh/config: letters, digits, `.`, `_` and `-`, at most 32, not starting with `-` or `.`"
    )]
    UnusableUser { user: String },
}

/// What [`join_in`] found and what it changed, for one machine.
#[derive(Debug, Clone)]
pub struct Joined {
    pub key: PathBuf,
    pub public_key: String,
    /// True when this call made the key, which is the first join (ADR-0029).
    pub generated: bool,
    pub config: PathBuf,
    pub machine: String,
    pub user: String,
    /// False when the config already named the machine and was left alone.
    pub configured: bool,
}

/// Prepares `~/.ssh` for the account this runs as, for every machine a
/// workspace names. The first join makes the same key without this verb
/// (ADR-0029); running it by hand is still harmless.
pub fn prepare() -> Result<Prepared, Error> {
    let listing = workspace::list()?;
    let mut machines: Vec<String> = listing
        .workspaces
        .into_iter()
        .map(|workspace| workspace.machine)
        .collect();
    machines.sort();
    machines.dedup();
    prepare_in(&dir()?, &machines)
}

/// This account's `~/.ssh`, which is the only directory anything here touches.
pub fn dir() -> Result<PathBuf, Error> {
    use etcetera::BaseStrategy as _;
    let base = etcetera::choose_base_strategy().map_err(|_| Error::NoHome)?;
    Ok(base.home_dir().join(".ssh"))
}

/// The identity as it is, changing nothing. `None` is no key yet, which
/// [`prepare`] changes and nothing else does — so a read can sit on a route a
/// browser opens without generating anything.
pub fn describe() -> Result<Option<Identity>, Error> {
    describe_in(&dir()?)
}

pub fn describe_in(dir: &Path) -> Result<Option<Identity>, Error> {
    let key = dir.join(KEY);
    let public = key.with_extension("pub");
    let public_key = match fs::read_to_string(&public) {
        Ok(text) => text.trim().to_owned(),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(Error::Read {
                path: public,
                source,
            });
        }
    };
    let kind = public_key
        .split_whitespace()
        .next()
        .map(|word| word.strip_prefix("ssh-").unwrap_or(word))
        .unwrap_or_default()
        .to_owned();
    Ok(Some(Identity {
        fingerprint: fingerprint(&public)?,
        path: key,
        kind,
        public_key,
    }))
}

/// `ssh-keygen -l` rather than a hash written here: it is the spelling every
/// `authorized_keys` tool prints, and the binary is already required.
fn fingerprint(public: &Path) -> Result<String, Error> {
    let out = Command::new("ssh-keygen")
        .arg("-lf")
        .arg(public)
        .output()
        .map_err(Error::Spawn)?;
    if !out.status.success() {
        return Err(Error::Keygen(
            String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        ));
    }
    // `256 SHA256:… comment (ED25519)` — the second word.
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .nth(1)
        .map(str::to_owned)
        .ok_or_else(|| Error::Keygen("`ssh-keygen -l` printed no fingerprint".to_owned()))
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

    let (key, public_key, generated) = key_in(dir)?;
    let config = dir.join("config");
    let existing = read_config(&config)?;

    let mut appended = String::new();
    let mut configured = Vec::new();
    let mut left_alone = Vec::new();
    for machine in machines {
        if names(&existing, machine) || names(&appended, machine) {
            left_alone.push(machine.clone());
            continue;
        }
        appended.push_str(&block(machine, &key, None));
        configured.push(machine.clone());
    }
    append(&config, &existing, &appended)?;

    Ok(Prepared {
        key,
        public_key,
        generated,
        config,
        configured,
        left_alone,
    })
}

/// One machine that ran the join command, for the account this runs as.
pub fn join(machine: &str, user: &str) -> Result<Joined, Error> {
    join_in(&dir()?, machine, user)
}

/// Appends `Host <machine>` with `User <user>` and this key, making the key if
/// there is none (ADR-0029). A config that already names the machine is left
/// exactly as it is, whoever wrote it (ADR-0009).
pub fn join_in(dir: &Path, machine: &str, user: &str) -> Result<Joined, Error> {
    // Both are refused before anything is written: each becomes a config line.
    if !usable_label(machine) {
        return Err(Error::UnusableMachine {
            machine: machine.to_owned(),
        });
    }
    if !usable_user(user) {
        return Err(Error::UnusableUser {
            user: user.to_owned(),
        });
    }

    let (key, public_key, generated) = key_in(dir)?;
    let config = dir.join("config");
    let existing = read_config(&config)?;
    let configured = !names(&existing, machine);
    if configured {
        append(&config, &existing, &block(machine, &key, Some(user)))?;
    }

    Ok(Joined {
        key,
        public_key,
        generated,
        config,
        machine: machine.to_owned(),
        user: user.to_owned(),
        configured,
    })
}

/// An account name that is one `User` token and nothing more. `%` is out
/// because ssh expands tokens in `User`, and whitespace would start a new line.
pub fn usable_user(user: &str) -> bool {
    (1..=32).contains(&user.len())
        && !user.starts_with(['-', '.'])
        && user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A tailnet machine name is a DNS label, and anything else here would be a
/// `Host` pattern (`*`, `!`) rather than a name.
fn usable_label(machine: &str) -> bool {
    (1..=63).contains(&machine.len())
        && !machine.starts_with('-')
        && machine
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The key, made when there is none. Never regenerated: that would orphan
/// every `authorized_keys` entry it is in.
fn key_in(dir: &Path) -> Result<(PathBuf, String, bool), Error> {
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
    Ok((key, public_key, generated))
}

fn read_config(config: &Path) -> Result<String, Error> {
    match fs::read_to_string(config) {
        Ok(text) => Ok(text),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(source) => Err(Error::Write {
            path: config.to_owned(),
            source,
        }),
    }
}

fn append(config: &Path, existing: &str, appended: &str) -> Result<(), Error> {
    if appended.is_empty() {
        return Ok(());
    }
    let writing = |source| Error::Write {
        path: config.to_owned(),
        source,
    };
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(config)
        .map_err(writing)?;
    // A file that already ended mid-block would swallow the first Host line.
    if !existing.is_empty() && !existing.ends_with('\n') {
        file.write_all(b"\n").map_err(writing)?;
    }
    let appended = match existing.is_empty() {
        true => appended.trim_start_matches('\n'),
        false => appended,
    };
    file.write_all(appended.as_bytes()).map_err(writing)
}

/// `IdentitiesOnly` so the appliance offers this key and no other: a box that
/// walks a list of keys gets refused for too many failures before it reaches
/// the right one. `User` only when a machine said which account ran the join.
fn block(machine: &str, key: &Path, user: Option<&str>) -> String {
    let user = user
        .map(|user| format!("    User {user}\n"))
        .unwrap_or_default();
    format!(
        "\nHost {machine}\n{user}    IdentityFile {}\n    IdentitiesOnly yes\n",
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

    /// The read half: nothing before a key exists, and afterwards the public
    /// key, its kind and the fingerprint `ssh-keygen` itself prints — never
    /// the private half.
    #[test]
    fn describing_generates_nothing_and_reads_only_the_public_half() {
        let dir = scratch("describe");
        assert_eq!(describe_in(&dir).expect("readable"), None);
        assert!(!dir.exists(), "a read that made a key would be a write");

        let prepared = prepare_in(&dir, &[]).expect("prepared");
        let identity = describe_in(&dir)
            .expect("readable")
            .expect("a key is there now");

        assert_eq!(identity.path, prepared.key);
        assert_eq!(identity.kind, "ed25519");
        assert_eq!(identity.public_key, prepared.public_key);
        assert!(identity.fingerprint.starts_with("SHA256:"), "{identity:?}");
        assert!(!identity.public_key.contains("PRIVATE"));

        let _ = fs::remove_dir_all(&dir);
    }

    /// Y-387: the first join makes the key, and the block names the account
    /// the join command ran as — the half `prepare` could never know.
    #[test]
    fn a_join_makes_the_key_and_names_the_account() {
        let dir = scratch("join");

        let joined = join_in(&dir, "cachyos-g14", "biswa").expect("joined");
        assert!(joined.generated, "no key existed, so the join made one");
        assert!(joined.configured);
        let config = fs::read_to_string(&joined.config).expect("readable");
        assert_eq!(
            config,
            format!(
                "Host cachyos-g14\n    User biswa\n    IdentityFile {}\n    IdentitiesOnly yes\n",
                joined.key.display()
            )
        );

        let again = join_in(&dir, "cachyos-g14", "biswa").expect("joined again");
        assert!(
            !again.generated && !again.configured,
            "a second join is a no-op"
        );
        assert_eq!(fs::read_to_string(&again.config).expect("readable"), config);

        let _ = fs::remove_dir_all(&dir);
    }

    /// ADR-0009: whatever the config already says about a name wins, and a
    /// join does not append a second block for it.
    #[test]
    fn a_join_leaves_a_block_the_owner_wrote_alone() {
        let dir = scratch("join-owner");
        fs::create_dir_all(&dir).expect("scratch");
        let owners = "Host laptop\n    User someone-else\n    ProxyJump bastion\n";
        fs::write(dir.join("config"), owners).expect("an existing config");

        let joined = join_in(&dir, "laptop", "biswa").expect("answered");

        assert!(!joined.configured);
        assert_eq!(
            fs::read_to_string(&joined.config).expect("readable"),
            owners
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// The account arrives in a request body and the machine from the tailnet,
    /// and either one becomes a line in the file every connection reads.
    #[test]
    fn a_join_with_an_account_or_a_name_that_writes_its_own_lines_is_refused() {
        let dir = scratch("join-hostile");
        for user in [
            "biswa\nHost *\n    ProxyCommand touch /tmp/pwned",
            "a b",
            "%u",
            "-oProxyCommand=x",
            ".hidden",
            "",
            &"x".repeat(33),
        ] {
            assert!(
                matches!(
                    join_in(&dir, "laptop", user),
                    Err(Error::UnusableUser { .. })
                ),
                "{user:?}"
            );
        }
        for machine in ["*", "!laptop", "laptop other", "-laptop", ""] {
            assert!(
                matches!(
                    join_in(&dir, machine, "biswa"),
                    Err(Error::UnusableMachine { .. })
                ),
                "{machine:?}"
            );
        }
        assert!(!dir.exists(), "refused before anything was written");
    }

    #[test]
    fn an_ordinary_account_name_is_usable() {
        for user in ["biswa", "bishwajeet.p", "ci_runner-2", "Admin"] {
            assert!(usable_user(user), "{user}");
        }
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
