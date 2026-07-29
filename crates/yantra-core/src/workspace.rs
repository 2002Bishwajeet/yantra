//! Workspace definitions — what to open and where, never how.
//!
//! A workspace is a file at `~/.config/yantra/workspaces/<name>.toml`. The
//! filename is the identity, so a file and its name cannot disagree.
//!
//! ```toml
//! machine = "pi"
//! repo    = "/home/biswa/code/demo"
//! branch  = "main"      # optional
//! startup = "claude"    # optional
//! ```

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    /// From the filename, not the file's contents.
    pub name: String,
    /// An alias; Y-041 resolves it to a host.
    pub machine: String,
    /// Path to the repository **on `machine`**, not on the local box.
    pub repo: PathBuf,
    /// `None` leaves the working tree alone.
    pub branch: Option<String>,
    /// `None` means just a shell.
    pub startup: Option<String>,
}

/// `deny_unknown_fields` turns a mistyped key into an error instead of a
/// silently ignored line.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct OnDisk {
    machine: String,
    repo: PathBuf,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    startup: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(
        "`{name}` is not a usable workspace name: it must be non-empty, must not start with a dot, and must not contain `/`, `\\` or `..`"
    )]
    InvalidName { name: String },

    #[error("no workspace named `{name}` (looked for {})", path.display())]
    NotFound { name: String, path: PathBuf },

    #[error("workspace `{name}` at {} could not be read", path.display())]
    Unreadable {
        name: String,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// Boxed because `toml::de::Error` is 136 bytes and would otherwise widen
    /// every `Result` in this module (clippy::result_large_err).
    #[error("workspace `{name}` at {} is not valid TOML", path.display())]
    Malformed {
        name: String,
        path: PathBuf,
        #[source]
        source: Box<toml::de::Error>,
    },

    #[error("could not determine a config directory for the current user")]
    NoConfigDir,
}

/// `~/.config/yantra/workspaces`, or the platform equivalent.
pub fn workspaces_dir() -> Result<PathBuf, Error> {
    use etcetera::BaseStrategy;
    let base = etcetera::choose_base_strategy().map_err(|_| Error::NoConfigDir)?;
    Ok(base.config_dir().join("yantra").join("workspaces"))
}

pub fn load(name: &str) -> Result<Workspace, Error> {
    load_from(&workspaces_dir()?, name)
}

/// Private so the public surface stays one function (ADR-0005).
fn load_from(dir: &Path, name: &str) -> Result<Workspace, Error> {
    validate_name(name)?;
    let path = dir.join(format!("{name}.toml"));

    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::NotFound {
                name: name.to_owned(),
                path,
            });
        }
        Err(source) => {
            return Err(Error::Unreadable {
                name: name.to_owned(),
                path,
                source,
            });
        }
    };

    parse(name, &path, &text)
}

/// Names arrive from the command line and become filenames, so
/// `yantra up ../../etc/passwd` must fail here rather than read that file.
fn validate_name(name: &str) -> Result<(), Error> {
    let usable = !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.contains('\0');

    if usable {
        Ok(())
    } else {
        Err(Error::InvalidName {
            name: name.to_owned(),
        })
    }
}

fn parse(name: &str, path: &Path, text: &str) -> Result<Workspace, Error> {
    let on_disk: OnDisk = toml::from_str(text).map_err(|source| Error::Malformed {
        name: name.to_owned(),
        path: path.to_owned(),
        source: Box::new(source),
    })?;

    Ok(Workspace {
        name: name.to_owned(),
        machine: on_disk.machine,
        repo: on_disk.repo,
        branch: on_disk.branch,
        startup: on_disk.startup,
    })
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets library code, where the same call would take the daemon down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn dir_with(label: &str, files: &[(&str, &str)]) -> std::io::Result<PathBuf> {
        let dir = std::env::temp_dir().join(format!("yantra-workspace-test-{label}"));
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        std::fs::create_dir_all(&dir)?;
        for (name, body) in files {
            std::fs::write(dir.join(name), body)?;
        }
        Ok(dir)
    }

    #[test]
    fn loads_every_field() -> std::io::Result<()> {
        let dir = dir_with(
            "every-field",
            &[(
                "demo.toml",
                r#"
                machine = "pi"
                repo    = "/home/biswa/code/demo"
                branch  = "main"
                startup = "claude"
                "#,
            )],
        )?;

        let ws = load_from(&dir, "demo").expect("a complete workspace loads");

        assert_eq!(ws.name, "demo", "identity comes from the filename");
        assert_eq!(ws.machine, "pi");
        assert_eq!(ws.repo, PathBuf::from("/home/biswa/code/demo"));
        assert_eq!(ws.branch.as_deref(), Some("main"));
        assert_eq!(ws.startup.as_deref(), Some("claude"));
        Ok(())
    }

    #[test]
    fn branch_and_startup_are_optional() -> std::io::Result<()> {
        let dir = dir_with(
            "optional",
            &[(
                "minimal.toml",
                r#"
                machine = "pi"
                repo    = "/srv/minimal"
                "#,
            )],
        )?;

        let ws = load_from(&dir, "minimal").expect("the minimum set is enough");

        assert_eq!(ws.branch, None);
        assert_eq!(ws.startup, None);
        Ok(())
    }

    #[test]
    fn a_missing_required_field_is_malformed() -> std::io::Result<()> {
        let dir = dir_with("no-repo", &[("norepo.toml", r#"machine = "pi""#)])?;

        assert!(
            matches!(load_from(&dir, "norepo"), Err(Error::Malformed { .. })),
            "a workspace with no repo is not usable"
        );
        Ok(())
    }

    #[test]
    fn an_unknown_key_is_rejected() -> std::io::Result<()> {
        let dir = dir_with(
            "typo",
            &[(
                "typo.toml",
                r#"
                machine = "pi"
                repo    = "/srv/typo"
                statup  = "claude"
                "#,
            )],
        )?;

        assert!(
            matches!(load_from(&dir, "typo"), Err(Error::Malformed { .. })),
            "a mistyped key is an error, not a silently ignored line"
        );
        Ok(())
    }

    #[test]
    fn a_missing_workspace_is_not_found() -> std::io::Result<()> {
        let dir = dir_with("absent", &[])?;

        assert!(
            matches!(load_from(&dir, "absent"), Err(Error::NotFound { .. })),
            "absent is distinguishable from unreadable"
        );
        Ok(())
    }

    #[test]
    fn names_cannot_escape_the_workspaces_directory() {
        for hostile in [
            "../../etc/passwd",
            "..",
            "a/b",
            "a\\b",
            ".hidden",
            "",
            "nul\0byte",
        ] {
            assert!(
                matches!(
                    load_from(Path::new("/nonexistent"), hostile),
                    Err(Error::InvalidName { .. })
                ),
                "`{hostile}` must be rejected as a name, before it becomes a path",
            );
        }
    }
}
