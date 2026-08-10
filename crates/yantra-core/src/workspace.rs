//! Workspace definitions — what to open and where, never how.
//!
//! A workspace is a file at `~/.config/yantra/workspaces/<name>.toml`. The
//! filename is the identity, so a file and its name cannot disagree.
//!
//! ```toml
//! machine = "pi"
//! repo    = "/home/user/code/demo"
//! startup = "claude"    # optional
//! ```
//!
//! There is no `branch`. It was parsed and never acted on, so [ADR-0010]
//! removed it rather than keep a key that only looked implemented; branch
//! selection returns in M3 as worktrees, which is the model that lets two
//! workspaces share one repo.
//!
//! [ADR-0010]: ../../../docs/adr/0010-drop-branch-from-the-workspace-schema.md

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    /// From the filename, not the file's contents.
    pub name: String,
    /// An ssh destination, verbatim — `~/.ssh/config` decides what it means
    /// (ADR-0009). Yantra never resolves it.
    pub machine: String,
    /// Path to the repository **on `machine`**, not on the local box.
    pub repo: PathBuf,
    /// `None` means just a shell.
    pub startup: Option<String>,
}

/// What an edit asks to change. A `None` leaves the field as it is, which is
/// what makes editing one field not a rewrite of the other two.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Changes {
    pub machine: Option<String>,
    pub repo: Option<PathBuf>,
    /// `Some(None)` puts the workspace back to just a shell.
    pub startup: Option<Option<String>>,
}

impl Changes {
    /// Whether this sends the workspace to a *different* machine. Naming the
    /// machine it already has moves nothing, so it is not the move
    /// [`crate::edit`] has to refuse under a live session (§B4).
    pub fn moves(&self, from: &Workspace) -> bool {
        self.machine.as_deref().is_some_and(|to| to != from.machine)
    }

    fn applied_to(&self, before: &Workspace) -> Workspace {
        Workspace {
            name: before.name.clone(),
            machine: self
                .machine
                .clone()
                .unwrap_or_else(|| before.machine.clone()),
            repo: self.repo.clone().unwrap_or_else(|| before.repo.clone()),
            startup: self
                .startup
                .clone()
                .unwrap_or_else(|| before.startup.clone()),
        }
    }
}

/// `deny_unknown_fields` turns a mistyped key into an error instead of a
/// silently ignored line.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct OnDisk {
    machine: String,
    repo: PathBuf,
    #[serde(default)]
    startup: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(
        "`{name}` is not a usable workspace name: only letters, digits, `_` and `-` are allowed \
         (looked at {})",
        path.display()
    )]
    InvalidName { name: String, path: PathBuf },

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

    #[error("workspace `{name}` already exists at {}", path.display())]
    Exists { name: String, path: PathBuf },

    #[error("could not write workspace `{name}` to {}", path.display())]
    Unwritable {
        name: String,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("a workspace's {field} cannot be empty")]
    Empty { field: &'static str },

    /// [`Empty`](Error::Empty)'s counterpart on the reading side, and a separate
    /// variant because the two are different faults: that one is a request this
    /// refused to write, and this one is a file already on disk. So it names the
    /// file, which is the fix — [`update`] loads before it writes, so no verb
    /// can repair it (R-23).
    #[error(
        "workspace `{name}` at {} has an empty `{field}`, so nothing can open it — fill that \
         line in or move the file aside",
        path.display()
    )]
    Blank {
        name: String,
        path: PathBuf,
        field: &'static str,
    },
}

/// `~/.config/yantra/workspaces`, or the platform equivalent.
pub fn workspaces_dir() -> Result<PathBuf, Error> {
    use etcetera::BaseStrategy;
    let base = etcetera::choose_base_strategy().map_err(|_| Error::NoConfigDir)?;
    Ok(base.config_dir().join("yantra").join("workspaces"))
}

/// Writes a workspace file, which is the one thing that used to require a text
/// editor. `brainstorm.md`'s UI Philosophy asks for exactly this — *the
/// interface should generate them automatically* — and Y-116 needs a verb here
/// before the dashboard may grow a form.
///
/// **It refuses to overwrite.** Editing an existing workspace is a different
/// verb with a different confirmation, and a `new` that silently replaced one
/// would lose the operator's own file to a typo in a name.
///
/// `machine` and `repo` are **not** validated against reality. ADR-0009 has
/// Yantra never resolving a machine name, and `repo` is a path on the *far*
/// side — `up` already refuses a repo that is not there, on that machine,
/// before a session exists (Y-081). Checking here would check the wrong box.
pub fn create(
    name: &str,
    machine: &str,
    repo: &Path,
    startup: Option<&str>,
) -> Result<Workspace, Error> {
    create_in(&workspaces_dir()?, name, machine, repo, startup)
}

fn create_in(
    dir: &Path,
    name: &str,
    machine: &str,
    repo: &Path,
    startup: Option<&str>,
) -> Result<Workspace, Error> {
    validate_name(dir, name)?;
    non_empty(machine, repo, startup)?;

    let path = dir.join(format!("{name}.toml"));
    if path.exists() {
        return Err(Error::Exists {
            name: name.to_owned(),
            path,
        });
    }

    std::fs::create_dir_all(dir).map_err(|source| Error::Unwritable {
        name: name.to_owned(),
        path: dir.to_owned(),
        source,
    })?;
    // `create_new` rather than `write`: `path.exists()` above is a courtesy
    // that says *which* workspace, and this is the check that actually holds
    // when two callers race.
    let mut file = std::fs::File::options()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|source| Error::Unwritable {
            name: name.to_owned(),
            path: path.clone(),
            source,
        })?;
    use std::io::Write;
    file.write_all(render(machine, repo, startup).as_bytes())
        .map_err(|source| Error::Unwritable {
            name: name.to_owned(),
            path: path.clone(),
            source,
        })?;

    load_from(dir, name)
}

/// The one predicate both paths ask, so a file [`create`] would refuse to write
/// is a file [`load`] refuses to read and neither can drift from the other. Y-119
/// closed the writing half alone and Y-137 the reading half.
///
/// `repo` is compared empty rather than trimmed because it is a path and `"  "`
/// is a legal name for one; `up` refuses a `repo` the machine does not have,
/// on that machine, which is where a path stops being guesswork (Y-081).
fn blank_field(machine: &str, repo: &Path, startup: Option<&str>) -> Option<&'static str> {
    if machine.trim().is_empty() {
        return Some("machine");
    }
    if repo.as_os_str().is_empty() {
        return Some("repo");
    }
    // Refused rather than read as `None`: absent already means "just a shell",
    // and coercing here would have two callers disagree about what they wrote.
    if startup.is_some_and(|startup| startup.trim().is_empty()) {
        return Some("startup");
    }
    None
}

fn non_empty(machine: &str, repo: &Path, startup: Option<&str>) -> Result<(), Error> {
    match blank_field(machine, repo, startup) {
        Some(field) => Err(Error::Empty { field }),
        None => Ok(()),
    }
}

/// Rewrites an existing workspace, leaving every field the caller did not name.
/// The counterpart to [`create`]: that one refuses to touch a file that exists,
/// and this one refuses to make a file that does not.
///
/// **It does not ask what is running.** `machine` is where the tmux session
/// lives, so changing it under a live session strands that session — refusing
/// that is [`crate::edit`]'s job, and this half only knows about the file.
pub fn update(name: &str, changes: &Changes) -> Result<Workspace, Error> {
    update_in(&workspaces_dir()?, name, changes)
}

fn update_in(dir: &Path, name: &str, changes: &Changes) -> Result<Workspace, Error> {
    let after = changes.applied_to(&load_from(dir, name)?);
    non_empty(&after.machine, &after.repo, after.startup.as_deref())?;

    let path = dir.join(format!("{name}.toml"));
    // Renamed over the original rather than written in place: `list` fails the
    // whole listing on one malformed file, so a half-written one costs every
    // workspace and not just this one. `.tmp` is not `.toml`, so a leftover is
    // invisible to that listing.
    let temp = dir.join(format!("{name}.toml.tmp"));
    let unwritable = |source| Error::Unwritable {
        name: name.to_owned(),
        path: path.clone(),
        source,
    };
    std::fs::write(
        &temp,
        render(&after.machine, &after.repo, after.startup.as_deref()),
    )
    .map_err(unwritable)?;
    std::fs::rename(&temp, &path).map_err(unwritable)?;

    load_from(dir, name)
}

/// Written by hand rather than serialised. The file is three keys and it is
/// the operator's to edit afterwards, so it is worth it being the same shape
/// the README shows — and adding `Serialize` to [`Workspace`] would put a wire
/// format on a type ADR-0005 keeps free of one.
fn render(machine: &str, repo: &Path, startup: Option<&str>) -> String {
    let mut toml = format!(
        "machine = {}\nrepo = {}\n",
        quote(machine),
        quote(&repo.display().to_string())
    );
    if let Some(startup) = startup {
        toml.push_str(&format!("startup = {}\n", quote(startup)));
    }
    toml
}

/// A TOML basic string. `repo` is a path and `startup` is a shell command, so
/// both can carry a quote or a backslash, and neither is ours to trust.
fn quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for c in value.chars() {
        match c {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\t' => quoted.push_str("\\t"),
            '\r' => quoted.push_str("\\r"),
            _ => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

pub fn load(name: &str) -> Result<Workspace, Error> {
    load_from(&workspaces_dir()?, name)
}

/// Deletes a workspace file and returns what was in it, so a caller can say
/// what it removed rather than only that it removed something.
///
/// **It loads first, and that is the point.** A file that will not parse is
/// still deletable — `remove_from` reads before it unlinks only so the caller
/// has something to print, and a `Malformed` file is exactly the one an
/// operator most wants gone. So a load failure other than `NotFound` does not
/// stop the delete; it costs the description.
///
/// Whether a session is stranded by this is [`crate::remove`]'s question, not
/// this function's: this half is a file, and that half is a machine.
pub fn remove(name: &str) -> Result<Option<Workspace>, Error> {
    remove_from(&workspaces_dir()?, name)
}

fn remove_from(dir: &Path, name: &str) -> Result<Option<Workspace>, Error> {
    validate_name(dir, name)?;
    let path = dir.join(format!("{name}.toml"));
    let described = load_from(dir, name);

    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::NotFound {
                name: name.to_owned(),
                path,
            });
        }
        Err(source) => {
            return Err(Error::Unwritable {
                name: name.to_owned(),
                path,
                source,
            });
        }
    }
    Ok(described.ok())
}

/// A file the listing refused, under the name it would have had. The shape
/// [`crate::sessions::MachineSessions`] already has: something that did not
/// answer is reported by name rather than dropped (Y-054).
#[derive(Debug)]
pub struct Unusable {
    pub name: String,
    pub error: Error,
}

/// Every workspace in the directory, beside every file that is not one.
#[derive(Debug)]
pub struct Listing {
    /// Name-sorted.
    pub workspaces: Vec<Workspace>,
    pub unusable: Vec<Unusable>,
}

/// Every workspace, name-sorted. A missing directory is an empty listing —
/// nobody has made one yet, which is not an error.
///
/// **A file that does not load is carried rather than dropped or fatal**
/// (Y-141): it lands in [`Listing::unusable`] with its reason, so the workspaces
/// that did load stay listable and the one that did not is still named. Omitting
/// it silently would report "no sessions on that machine" for a machine that was
/// never queried, which is the wrong answer this used to refuse whole.
///
/// The failures that are still fatal are the ones that are about no single file:
/// no config directory, a directory that cannot be read, an entry that cannot be
/// resolved. Those say nothing about which workspaces exist.
pub fn list() -> Result<Listing, Error> {
    list_in(&workspaces_dir()?)
}

fn list_in(dir: &Path) -> Result<Listing, Error> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Listing {
                workspaces: Vec::new(),
                unusable: Vec::new(),
            });
        }
        Err(source) => {
            return Err(Error::Unreadable {
                name: "*".to_owned(),
                path: dir.to_owned(),
                source,
            });
        }
    };

    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|source| Error::Unreadable {
                name: "*".to_owned(),
                path: dir.to_owned(),
                source,
            })?
            .path();
        if path.extension().is_some_and(|ext| ext == "toml")
            && let Some(stem) = path.file_stem().and_then(|s| s.to_str())
        {
            names.push(stem.to_owned());
        }
    }
    names.sort();

    let mut workspaces = Vec::new();
    let mut unusable = Vec::new();
    for name in names {
        match load_from(dir, &name) {
            Ok(workspace) => workspaces.push(workspace),
            Err(error) => unusable.push(Unusable { name, error }),
        }
    }
    Ok(Listing {
        workspaces,
        unusable,
    })
}

/// Private so the public surface stays one function (ADR-0005).
fn load_from(dir: &Path, name: &str) -> Result<Workspace, Error> {
    validate_name(dir, name)?;
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

/// Names arrive from the command line and become both a filename and a tmux
/// session name, so this is the intersection of I-24 (nothing that can escape a
/// directory) and I-2 (nothing tmux cannot address). One rule, checked once, so
/// an unusable workspace fails at load rather than half-way through `up`.
///
/// The path is built rather than opened: a listing reaches this variant through
/// a stem it read off disk, and naming only the stem would leave the operator
/// hunting for the file (R-23).
fn validate_name(dir: &Path, name: &str) -> Result<(), Error> {
    let usable = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');

    if usable {
        Ok(())
    } else {
        Err(Error::InvalidName {
            name: name.to_owned(),
            path: dir.join(format!("{name}.toml")),
        })
    }
}

fn parse(name: &str, path: &Path, text: &str) -> Result<Workspace, Error> {
    let on_disk: OnDisk = toml::from_str(text).map_err(|source| Error::Malformed {
        name: name.to_owned(),
        path: path.to_owned(),
        source: Box::new(source),
    })?;

    if let Some(field) = blank_field(&on_disk.machine, &on_disk.repo, on_disk.startup.as_deref()) {
        return Err(Error::Blank {
            name: name.to_owned(),
            path: path.to_owned(),
            field,
        });
    }

    Ok(Workspace {
        name: name.to_owned(),
        machine: on_disk.machine,
        repo: on_disk.repo,
        startup: on_disk.startup,
    })
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets library code, where the same call would take the daemon down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use std::error::Error as _;

    const GOOD: &str = "machine = \"box\"\nrepo = \"/srv/app\"\n";

    #[test]
    fn removing_returns_what_the_file_held() -> Result<(), Box<dyn std::error::Error>> {
        let dir = dir_with("remove-good", &[("gone.toml", GOOD)])?;
        let removed = remove_from(&dir, "gone")?.expect("a readable file describes itself");
        assert_eq!(removed.machine, "box");
        assert!(!dir.join("gone.toml").exists(), "the file is unlinked");
        Ok(())
    }

    /// The file an operator most wants gone is the one that will not parse, so
    /// the delete does not depend on the read succeeding — only the description
    /// does.
    #[test]
    fn a_file_that_will_not_parse_is_still_deleted() -> Result<(), Box<dyn std::error::Error>> {
        let dir = dir_with("remove-broken", &[("broken.toml", "machine = 1\n")])?;
        assert!(
            remove_from(&dir, "broken")?.is_none(),
            "nothing true can be said about where it pointed"
        );
        assert!(!dir.join("broken.toml").exists(), "it is gone regardless");
        Ok(())
    }

    /// Distinguishable from a delete that happened, because the caller decides
    /// whether absence is success and this function must not decide for it.
    #[test]
    fn removing_what_is_not_there_says_so() -> Result<(), Box<dyn std::error::Error>> {
        let dir = dir_with("remove-absent", &[])?;
        assert!(matches!(
            remove_from(&dir, "ghost"),
            Err(Error::NotFound { .. })
        ));
        Ok(())
    }

    /// I-57: the path in an `InvalidName` is built rather than read, so a name
    /// that could escape the directory is refused before any filesystem call.
    #[test]
    fn a_name_that_is_not_a_name_never_reaches_the_filesystem() {
        let dir = std::env::temp_dir().join("yantra-workspace-test-remove-escape");
        assert!(matches!(
            remove_from(&dir, "../../etc/passwd"),
            Err(Error::InvalidName { .. })
        ));
    }

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
                repo    = "/home/user/code/demo"
                startup = "claude"
                "#,
            )],
        )?;

        let ws = load_from(&dir, "demo").expect("a complete workspace loads");

        assert_eq!(ws.name, "demo", "identity comes from the filename");
        assert_eq!(ws.machine, "pi");
        assert_eq!(ws.repo, PathBuf::from("/home/user/code/demo"));
        assert_eq!(ws.startup.as_deref(), Some("claude"));
        Ok(())
    }

    /// ADR-0010: it is gone, and `deny_unknown_fields` means gone is loud. A
    /// file that still carries it must not load and quietly do nothing —
    /// which is precisely what the field did for the whole of M1 and M2.
    #[test]
    fn a_workspace_still_carrying_branch_fails_to_load() -> std::io::Result<()> {
        let dir = dir_with(
            "stale-branch",
            &[(
                "stale.toml",
                r#"
                machine = "pi"
                repo    = "/srv/stale"
                branch  = "main"
                "#,
            )],
        )?;

        let err = load_from(&dir, "stale").expect_err("branch is no longer a key");
        assert!(matches!(err, Error::Malformed { .. }));
        // The message has to name the field, because deleting that line is the
        // entire migration.
        assert!(
            err.source()
                .is_some_and(|e| e.to_string().contains("branch"))
        );
        Ok(())
    }

    #[test]
    fn startup_is_optional() -> std::io::Result<()> {
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

    /// Y-119 closed `create` and left `load` open, so a hand-edited file walked
    /// a blank command into `up` and a blank destination into ssh. Each field is
    /// asserted through `load_from`, which is what every CLI verb and every
    /// route reaches.
    #[test]
    fn a_blank_required_field_is_refused_at_load_and_the_refusal_says_where() -> std::io::Result<()>
    {
        let files = [
            (
                "nomachine.toml",
                "machine = \"\"\nrepo = \"/srv/x\"\n",
                "machine",
            ),
            ("norepo.toml", "machine = \"pi\"\nrepo = \"\"\n", "repo"),
            (
                "nostartup.toml",
                "machine = \"pi\"\nrepo = \"/srv/x\"\nstartup = \"\"\n",
                "startup",
            ),
        ];
        let dir = dir_with("blank-on-disk", &files.map(|(file, body, _)| (file, body)))?;

        for (file, _, field) in files {
            let name = file.trim_end_matches(".toml");
            let refused = load_from(&dir, name).expect_err("a blank field is not a value");
            assert!(
                matches!(&refused, Error::Blank { field: f, .. } if *f == field),
                "{refused}",
            );
            // R-23: the file, the field and the workspace, or the operator has
            // to go looking for a file they could have fixed in a second.
            let said = refused.to_string();
            for part in [name, field, &dir.join(file).display().to_string()] {
                assert!(said.contains(part), "`{part}` is missing from: {said}");
            }
        }
        Ok(())
    }

    /// The two paths ask one predicate, so what `create` refuses to write is
    /// what `load` refuses to read — including `machine` and `startup` being
    /// trimmed while `repo` is not, `"  "` being a legal name for a path.
    #[test]
    fn whitespace_is_blank_for_the_same_fields_on_disk_as_in_a_request() -> std::io::Result<()> {
        let dir = dir_with(
            "blank-whitespace",
            &[
                ("spaces.toml", "machine = \"   \"\nrepo = \"/srv/x\"\n"),
                (
                    "spacedstartup.toml",
                    "machine = \"pi\"\nrepo = \"/srv/x\"\nstartup = \"  \"\n",
                ),
                ("spacedrepo.toml", "machine = \"pi\"\nrepo = \"   \"\n"),
            ],
        )?;

        for (name, field) in [("spaces", "machine"), ("spacedstartup", "startup")] {
            let refused = load_from(&dir, name).expect_err("whitespace is not a value");
            assert!(
                matches!(&refused, Error::Blank { field: f, .. } if *f == field),
                "{refused}",
            );
        }
        assert_eq!(
            load_from(&dir, "spacedrepo")
                .expect("a padded path is a path")
                .repo,
            PathBuf::from("   "),
            "`repo` is the one `non_empty` does not trim, and the two halves must agree"
        );
        Ok(())
    }

    /// The state this row exists to keep distinguishable: absent is *just a
    /// shell* (ADR-0007) and must go on loading, or refusing `Some("")` would
    /// have cost the very thing it protects.
    #[test]
    fn an_absent_startup_still_loads_as_just_a_shell() -> std::io::Result<()> {
        let dir = dir_with(
            "still-a-shell",
            &[("shell.toml", "machine = \"pi\"\nrepo = \"/srv/x\"\n")],
        )?;

        assert_eq!(
            load_from(&dir, "shell")
                .expect("a workspace with no startup")
                .startup,
            None,
        );
        assert_eq!(list_in(&dir).expect("and it lists").workspaces.len(), 1);
        Ok(())
    }

    /// Y-141's rule where Y-137 left the opposite one: the blank file is named
    /// with its reason **and** the good workspace beside it is still returned.
    #[test]
    fn a_blank_field_names_its_file_without_taking_the_good_ones_with_it() -> std::io::Result<()> {
        let dir = dir_with(
            "listing-blank",
            &[
                ("good.toml", "machine = \"a\"\nrepo = \"/tmp\"\n"),
                ("blank.toml", "machine = \"\"\nrepo = \"/tmp\"\n"),
            ],
        )?;

        let listed = list_in(&dir).expect("one unusable file does not stop the listing");

        let names: Vec<&str> = listed.workspaces.iter().map(|w| w.name.as_str()).collect();
        assert_eq!(names, ["good"], "the workspace that loads stays listed");
        let refused = &listed.unusable[0];
        assert_eq!(refused.name, "blank");
        assert!(
            matches!(refused.error, Error::Blank { .. }),
            "{}",
            refused.error
        );
        // R-23: named loudly with the file and the field, since no verb can
        // repair it and the operator has to open the file.
        let said = refused.error.to_string();
        for part in [
            "blank",
            "machine",
            &dir.join("blank.toml").display().to_string(),
        ] {
            assert!(said.contains(part), "`{part}` is missing from: {said}");
        }
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
            // Rejected by I-2 as well: tmux cannot address a dotted name.
            "has.dot",
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

    #[test]
    fn listing_returns_every_workspace_sorted_and_ignores_other_files() -> std::io::Result<()> {
        let dir = dir_with(
            "listing",
            &[
                ("zeta.toml", "machine = \"a\"\nrepo = \"/tmp\"\n"),
                ("alpha.toml", "machine = \"b\"\nrepo = \"/tmp\"\n"),
                // Neither is a workspace, and neither may derail the listing.
                ("notes.md", "not a workspace"),
                ("alpha.toml.bak", "machine = \"c\"\nrepo = \"/tmp\"\n"),
            ],
        )?;

        let found = list_in(&dir).expect("a directory of valid workspaces lists");
        let names: Vec<&str> = found.workspaces.iter().map(|w| w.name.as_str()).collect();
        assert_eq!(names, ["alpha", "zeta"]);
        assert!(found.unusable.is_empty());
        Ok(())
    }

    /// Absence is emptiness: a user who has never made a workspace is not in an
    /// error state, and `ls` should say so rather than fail.
    #[test]
    fn listing_a_directory_that_does_not_exist_is_empty_not_an_error() {
        let found = list_in(Path::new("/nonexistent/yantra/workspaces")).expect("not an error");
        assert!(found.workspaces.is_empty());
        assert!(found.unusable.is_empty());
    }

    /// The opposite call: a file that *is* a workspace but cannot be parsed is
    /// reported by name, and the workspace beside it still answers. Quietly
    /// dropping it would report "no sessions" for a machine that was never
    /// asked, which is the answer that made this fail whole until Y-141.
    #[test]
    fn a_malformed_workspace_is_named_and_the_rest_of_the_listing_survives() -> std::io::Result<()>
    {
        let dir = dir_with(
            "listing-bad",
            &[
                ("good.toml", "machine = \"a\"\nrepo = \"/tmp\"\n"),
                ("broken.toml", "machine = = ="),
            ],
        )?;

        let listed = list_in(&dir).expect("a broken file is one entry, not the whole answer");

        assert_eq!(listed.workspaces.len(), 1);
        assert_eq!(listed.workspaces[0].name, "good");
        assert_eq!(listed.unusable[0].name, "broken");
        assert!(
            matches!(listed.unusable[0].error, Error::Malformed { .. }),
            "{}",
            listed.unusable[0].error
        );
        Ok(())
    }

    /// A stem tmux cannot address is reachable from a listing rather than only
    /// from an argument, so the refusal has to name the file like its siblings.
    #[test]
    fn a_file_whose_stem_is_not_a_usable_name_is_named_with_its_path() -> std::io::Result<()> {
        let dir = dir_with(
            "listing-dotted",
            &[("my.app.toml", "machine = \"a\"\nrepo = \"/tmp\"\n")],
        )?;

        let listed = list_in(&dir).expect("a dotted stem is one entry");

        assert!(listed.workspaces.is_empty());
        assert_eq!(listed.unusable[0].name, "my.app");
        let said = listed.unusable[0].error.to_string();
        assert!(said.contains("my.app"), "{said}");
        assert!(said.contains(&dir.display().to_string()), "{said}");
        Ok(())
    }

    /// The outer `Result` is what is left of the old rule, and it is about the
    /// directory rather than a file in it: nothing here says which workspaces
    /// exist, so there is nothing partial to report.
    #[test]
    fn a_directory_that_cannot_be_read_still_fails_the_whole_listing() -> std::io::Result<()> {
        let dir = dir_with("listing-not-a-dir", &[("file.toml", "machine = \"a\"\n")])?;

        let refused = list_in(&dir.join("file.toml")).expect_err("that is not a directory");

        assert!(matches!(refused, Error::Unreadable { .. }), "{refused}");
        Ok(())
    }
    /// The round trip is the assertion: a file this wrote must be one `load`
    /// reads back identically, or the two halves have drifted.
    #[test]
    fn a_created_workspace_loads_back_as_written() {
        let dir = dir_with("created", &[]).expect("a temp dir");

        let made = create_in(
            &dir,
            "personal-website",
            "bishwajeets-macbook-pro",
            Path::new("/Users/<user>/code/site"),
            Some("npm run dev"),
        )
        .expect("a usable workspace");

        assert_eq!(made, load_from(&dir, "personal-website").expect("loads"));
        assert_eq!(made.machine, "bishwajeets-macbook-pro");
        assert_eq!(made.startup.as_deref(), Some("npm run dev"));
    }

    #[test]
    fn without_a_startup_the_key_is_absent_rather_than_empty() {
        let dir = dir_with("shell", &[]).expect("a temp dir");

        create_in(&dir, "shell", "a-machine", Path::new("/srv/repo"), None).expect("created");

        let text = std::fs::read_to_string(dir.join("shell.toml")).expect("readable");
        assert!(!text.contains("startup"), "{text}");
        assert!(
            load_from(&dir, "shell").expect("loads").startup.is_none(),
            "an absent startup is just a shell"
        );
    }

    /// `None` is a shell and `Some("")` is a command that cannot run, so the
    /// two must not collapse into one another on the way to disk.
    #[test]
    fn an_empty_startup_is_refused_rather_than_read_as_no_startup() {
        let dir = dir_with("blank-startup", &[]).expect("a temp dir");

        for blank in ["", "   "] {
            let refused = create_in(
                &dir,
                "blank",
                "a-machine",
                Path::new("/srv/repo"),
                Some(blank),
            )
            .expect_err("an empty startup is not a startup");
            assert!(
                matches!(refused, Error::Empty { field: "startup" }),
                "`{blank}`: {refused}",
            );
        }
        assert!(
            list_in(&dir).expect("listable").workspaces.is_empty(),
            "a refusal must leave no file behind"
        );
    }

    /// A `new` that overwrote would lose the operator's own file to a typo.
    #[test]
    fn it_refuses_to_overwrite_an_existing_workspace() {
        let dir = dir_with("twice", &[]).expect("a temp dir");
        create_in(&dir, "once", "a-machine", Path::new("/srv/repo"), None).expect("first");

        let refused = create_in(&dir, "once", "other", Path::new("/elsewhere"), None)
            .expect_err("the second must not clobber the first");

        assert!(matches!(refused, Error::Exists { .. }), "{refused}");
        assert_eq!(
            load_from(&dir, "once").expect("loads").machine,
            "a-machine",
            "the original survived"
        );
    }

    /// `repo` is a path and `startup` a shell command, so both reach TOML with
    /// characters TOML gives meaning to. Written and read back, not eyeballed.
    #[test]
    fn a_quote_or_a_backslash_survives_the_round_trip() {
        let dir = dir_with("quoting", &[]).expect("a temp dir");
        let repo = Path::new(r#"/srv/a "quoted" \ path"#);

        create_in(
            &dir,
            "awkward",
            "a-machine",
            repo,
            Some(r#"echo "hi" \ there"#),
        )
        .expect("created");

        let read = load_from(&dir, "awkward").expect("loads");
        assert_eq!(read.repo, repo);
        assert_eq!(read.startup.as_deref(), Some(r#"echo "hi" \ there"#));
    }

    /// The whole point of naming one field: the other two are not touched, and
    /// a `startup` that is not mentioned is not the same as one cleared.
    #[test]
    fn an_edit_rewrites_only_the_fields_it_names() {
        let dir = dir_with("edit-one", &[]).expect("a temp dir");
        create_in(
            &dir,
            "site",
            "a-machine",
            Path::new("/srv/old"),
            Some("npm run dev"),
        )
        .expect("created");

        let after = update_in(
            &dir,
            "site",
            &Changes {
                repo: Some(PathBuf::from("/srv/new")),
                ..Changes::default()
            },
        )
        .expect("edited");

        assert_eq!(after.repo, PathBuf::from("/srv/new"));
        assert_eq!(after.machine, "a-machine");
        assert_eq!(after.startup.as_deref(), Some("npm run dev"));
        assert_eq!(after, load_from(&dir, "site").expect("loads back"));
    }

    /// `Some(None)` is the only way back to *just a shell*, and without it a
    /// startup set by mistake could only be removed by hand-editing the file —
    /// which is the thing this verb exists to stop.
    #[test]
    fn an_edit_can_clear_a_startup_back_to_a_shell() {
        let dir = dir_with("edit-clear", &[]).expect("a temp dir");
        create_in(&dir, "site", "a-machine", Path::new("/srv/x"), Some("nvim")).expect("created");

        let after = update_in(
            &dir,
            "site",
            &Changes {
                startup: Some(None),
                ..Changes::default()
            },
        )
        .expect("edited");

        assert_eq!(after.startup, None);
        let text = std::fs::read_to_string(dir.join("site.toml")).expect("readable");
        assert!(!text.contains("startup"), "{text}");
    }

    /// §B4: an edit that asks for what is already there is not a failure and not
    /// a move, so the caller can repeat one safely.
    #[test]
    fn naming_the_machine_a_workspace_already_has_is_not_a_move() {
        let before = Workspace {
            name: "site".to_owned(),
            machine: "a-machine".to_owned(),
            repo: PathBuf::from("/srv/x"),
            startup: None,
        };

        assert!(!Changes::default().moves(&before));
        assert!(
            !Changes {
                machine: Some("a-machine".to_owned()),
                ..Changes::default()
            }
            .moves(&before)
        );
        assert!(
            Changes {
                machine: Some("elsewhere".to_owned()),
                ..Changes::default()
            }
            .moves(&before)
        );
    }

    /// The same refusals `create` makes, from the other side — and the file has
    /// to survive them, because an edit that half-applied would be worse than
    /// one that did nothing.
    #[test]
    fn an_edit_to_an_empty_field_is_refused_and_leaves_the_file_as_it_was() {
        let dir = dir_with("edit-empty", &[]).expect("a temp dir");
        create_in(&dir, "site", "a-machine", Path::new("/srv/x"), None).expect("created");
        let before = load_from(&dir, "site").expect("loads");

        for (changes, field) in [
            (
                Changes {
                    machine: Some("  ".to_owned()),
                    ..Changes::default()
                },
                "machine",
            ),
            (
                Changes {
                    repo: Some(PathBuf::new()),
                    ..Changes::default()
                },
                "repo",
            ),
            (
                Changes {
                    startup: Some(Some(String::new())),
                    ..Changes::default()
                },
                "startup",
            ),
        ] {
            let refused = update_in(&dir, "site", &changes).expect_err("an empty field");
            assert!(
                matches!(refused, Error::Empty { field: f } if f == field),
                "{refused}"
            );
        }
        assert_eq!(before, load_from(&dir, "site").expect("still loads"));
    }

    #[test]
    fn editing_a_workspace_that_is_not_there_is_not_found() {
        let dir = dir_with("edit-absent", &[]).expect("a temp dir");

        let refused = update_in(
            &dir,
            "absent",
            &Changes {
                machine: Some("m".to_owned()),
                ..Changes::default()
            },
        )
        .expect_err("there is nothing to edit");

        assert!(matches!(refused, Error::NotFound { .. }), "{refused}");
        assert!(
            list_in(&dir).expect("listable").workspaces.is_empty(),
            "an edit must never create a workspace"
        );
    }

    #[test]
    fn an_unusable_name_or_an_empty_field_is_refused_before_anything_is_written() {
        let dir = dir_with("refusals", &[]).expect("a temp dir");

        assert!(matches!(
            create_in(&dir, "not a name", "m", Path::new("/r"), None),
            Err(Error::InvalidName { .. })
        ));
        assert!(matches!(
            create_in(&dir, "fine", "  ", Path::new("/r"), None),
            Err(Error::Empty { field: "machine" })
        ));
        assert!(matches!(
            create_in(&dir, "fine", "m", Path::new(""), None),
            Err(Error::Empty { field: "repo" })
        ));
        assert!(
            list_in(&dir).expect("listable").workspaces.is_empty(),
            "a refusal must leave no file behind"
        );
    }
}
