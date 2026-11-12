//! A room's definition on disk: `~/.config/yantra/rooms/<name>.toml`
//! ([ADR-0039](../../../docs/adr/0039-a-room-is-a-shared-project.md) decision 2).
//!
//! It is configuration the owner writes, like a workspace file. It holds no
//! message, no fleet state and no secret. [`crate::room`] stays pure, so the
//! file I/O lives here. Unknown keys are ignored, so a later row can add one.

use std::path::{Path, PathBuf};

use crate::room;

/// The longest brief, in characters.
pub const BRIEF_LIMIT: usize = 500;

/// One room's definition. The file name is the name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Definition {
    pub name: String,
    /// The home workspace.
    pub workspace: String,
    pub brief: Option<String>,
    /// `None` is the workspace's current branch.
    pub base: Option<String>,
    /// More workspaces whose agent tokens reach the room. Only the owner writes it.
    pub workspaces: Vec<String>,
    /// Seconds since the Unix epoch.
    pub made_at: u64,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct OnDisk {
    workspace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    brief: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    workspaces: Vec<String>,
    made_at: u64,
}

// No variant carries a brief or a file's bytes, so a log of one names no content (Q5).
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{}", room::Error::BadName(.0.clone()))]
    BadName(String),

    #[error("room {0} already exists")]
    Exists(String),

    #[error("no room {0} is defined")]
    Missing(String),

    #[error("`{0}` is not a workspace name: only letters, digits, `_` and `-` are allowed")]
    BadWorkspace(String),

    #[error("a brief is at most 500 characters, with no control character but a newline")]
    BadBrief,

    #[error(
        "a base is a git branch name: no space, `..`, `~^:?*[\\`, leading `-` or `.lock` at the end"
    )]
    BadBase,

    /// Boxed for the reason `workspace::Error::Malformed` is.
    #[error("room file {name}.toml is not a room definition")]
    Unparsable {
        name: String,
        #[source]
        source: Box<toml::de::Error>,
    },

    #[error("room file {name}.toml could not be read")]
    Unreadable {
        name: String,
        #[source]
        source: std::io::Error,
    },

    #[error("room file {name}.toml could not be written")]
    Unwritable {
        name: String,
        #[source]
        source: std::io::Error,
    },

    #[error("could not determine a config directory for the current user")]
    NoConfigDir,
}

impl Definition {
    /// The checks a file on disk gets too, so a room `create` writes is one `list` reads.
    pub fn check(&self) -> Result<(), Error> {
        if !room::valid_name(&self.name) {
            return Err(Error::BadName(self.name.clone()));
        }
        if let Some(bad) = std::iter::once(&self.workspace)
            .chain(&self.workspaces)
            .find(|workspace| !crate::workspace::usable_name(workspace))
        {
            return Err(Error::BadWorkspace(bad.clone()));
        }
        if self
            .brief
            .as_deref()
            .is_some_and(|brief| !good_brief(brief))
        {
            return Err(Error::BadBrief);
        }
        if self.base.as_deref().is_some_and(|base| !good_base(base)) {
            return Err(Error::BadBase);
        }
        Ok(())
    }
}

/// A blank brief is no brief.
#[must_use]
pub fn brief(text: Option<&str>) -> Option<String> {
    text.filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
}

fn good_brief(brief: &str) -> bool {
    brief.chars().count() <= BRIEF_LIMIT && brief.chars().all(|c| c == '\n' || !c.is_control())
}

/// `git check-ref-format`'s rules for a branch, the ones a typo trips.
fn good_base(base: &str) -> bool {
    !base.is_empty()
        && !base.starts_with('-')
        && !base.starts_with('/')
        && !base.ends_with('/')
        && !base.ends_with('.')
        && !base.ends_with(".lock")
        && !base.contains("..")
        && !base.contains("@{")
        && !base.contains("//")
        && base
            .chars()
            .all(|c| !c.is_whitespace() && !c.is_control() && !"~^:?*[\\".contains(c))
}

/// `~/.config/yantra/rooms`, or the platform equivalent.
pub fn rooms_dir() -> Result<PathBuf, Error> {
    use etcetera::BaseStrategy;
    let base = etcetera::choose_base_strategy().map_err(|_| Error::NoConfigDir)?;
    Ok(base.config_dir().join("yantra").join("rooms"))
}

/// Writes a new definition, and refuses a name that has one.
pub fn create(definition: &Definition) -> Result<(), Error> {
    create_in(&rooms_dir()?, definition)
}

pub fn create_in(dir: &Path, definition: &Definition) -> Result<(), Error> {
    definition.check()?;
    if path(dir, &definition.name).exists() {
        return Err(Error::Exists(definition.name.clone()));
    }
    write(dir, definition)
}

/// Sets the brief of a room that has a file, and answers what is on disk now.
pub fn update(name: &str, brief: Option<&str>) -> Result<Definition, Error> {
    update_in(&rooms_dir()?, name, brief)
}

pub fn update_in(dir: &Path, name: &str, brief: Option<&str>) -> Result<Definition, Error> {
    let definition = Definition {
        brief: self::brief(brief),
        ..load(dir, name)?
    };
    definition.check()?;
    write(dir, &definition)?;
    Ok(definition)
}

/// Deletes a definition. `false` is a file that was not there.
pub fn remove(name: &str) -> Result<bool, Error> {
    remove_in(&rooms_dir()?, name)
}

pub fn remove_in(dir: &Path, name: &str) -> Result<bool, Error> {
    if !room::valid_name(name) {
        return Err(Error::BadName(name.to_owned()));
    }
    match std::fs::remove_file(path(dir, name)) {
        Ok(()) => Ok(true),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(Error::Unwritable {
            name: name.to_owned(),
            source,
        }),
    }
}

/// Every definition, beside every file that is not one.
#[derive(Debug, Default)]
pub struct Listing {
    /// Name-sorted.
    pub rooms: Vec<Definition>,
    pub unusable: Vec<(String, Error)>,
}

pub fn list() -> Result<Listing, Error> {
    list_in(&rooms_dir()?)
}

/// A missing directory is an empty listing. A file that does not load costs
/// only itself, as `workspace::list` has it.
pub fn list_in(dir: &Path) -> Result<Listing, Error> {
    let unreadable = |source| Error::Unreadable {
        name: "*".to_owned(),
        source,
    };
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Listing::default());
        }
        Err(source) => return Err(unreadable(source)),
    };
    let mut names = Vec::new();
    for entry in entries {
        let path = entry.map_err(unreadable)?.path();
        // A torn `<name>.toml.tmp` has the extension `tmp`, so it is never read.
        if path.extension().is_some_and(|ext| ext == "toml")
            && let Some(stem) = path.file_stem().and_then(|stem| stem.to_str())
        {
            names.push(stem.to_owned());
        }
    }
    names.sort();
    let mut listing = Listing::default();
    for name in names {
        match load(dir, &name) {
            Ok(definition) => listing.rooms.push(definition),
            Err(error) => listing.unusable.push((name, error)),
        }
    }
    Ok(listing)
}

fn path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.toml"))
}

/// The name is checked before a path is built from it.
fn load(dir: &Path, name: &str) -> Result<Definition, Error> {
    if !room::valid_name(name) {
        return Err(Error::BadName(name.to_owned()));
    }
    let text = match std::fs::read_to_string(path(dir, name)) {
        Ok(text) => text,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::Missing(name.to_owned()));
        }
        Err(source) => {
            return Err(Error::Unreadable {
                name: name.to_owned(),
                source,
            });
        }
    };
    let on_disk: OnDisk = toml::from_str(&text).map_err(|source| Error::Unparsable {
        name: name.to_owned(),
        source: Box::new(source),
    })?;
    let definition = Definition {
        name: name.to_owned(),
        workspace: on_disk.workspace,
        brief: on_disk.brief,
        base: on_disk.base,
        workspaces: on_disk.workspaces,
        made_at: on_disk.made_at,
    };
    definition.check()?;
    Ok(definition)
}

/// Written to `<name>.toml.tmp` and renamed over the file, so a reader never
/// sees half a definition.
fn write(dir: &Path, definition: &Definition) -> Result<(), Error> {
    let unwritable = |source| Error::Unwritable {
        name: definition.name.clone(),
        source,
    };
    let text = toml::to_string(&OnDisk {
        workspace: definition.workspace.clone(),
        brief: definition.brief.clone(),
        base: definition.base.clone(),
        workspaces: definition.workspaces.clone(),
        made_at: definition.made_at,
    })
    .map_err(|error| unwritable(std::io::Error::other(error)))?;
    std::fs::create_dir_all(dir).map_err(unwritable)?;
    let temp = dir.join(format!("{}.toml.tmp", definition.name));
    std::fs::write(&temp, text).map_err(unwritable)?;
    std::fs::rename(&temp, path(dir, &definition.name)).map_err(unwritable)
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("yantra-room-file-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn definition(name: &str) -> Definition {
        Definition {
            name: name.to_owned(),
            workspace: "web".to_owned(),
            brief: Some("Ship the login page.\nThen the tests.".to_owned()),
            base: Some("feature/login".to_owned()),
            workspaces: Vec::new(),
            made_at: 1_800_000_000,
        }
    }

    #[test]
    fn a_bad_name_is_refused_before_a_path_is_built() {
        let dir = scratch("bad-names");
        let long = "x".repeat(33);
        for bad in ["", "A", "../x", "a/b", "x.toml", long.as_str(), "a b"] {
            assert!(
                matches!(create_in(&dir, &definition(bad)), Err(Error::BadName(_))),
                "{bad}"
            );
            assert!(
                matches!(update_in(&dir, bad, None), Err(Error::BadName(_))),
                "{bad}"
            );
            assert!(
                matches!(remove_in(&dir, bad), Err(Error::BadName(_))),
                "{bad}"
            );
        }
        assert!(!dir.exists(), "nothing was written");
    }

    #[test]
    fn a_bad_field_is_refused() {
        let dir = scratch("bad-fields");
        let refused = |change: fn(&mut Definition)| {
            let mut bad = definition("r1");
            change(&mut bad);
            create_in(&dir, &bad).expect_err("refused")
        };
        assert!(matches!(
            refused(|d| d.workspace = "a/b".to_owned()),
            Error::BadWorkspace(_)
        ));
        assert!(matches!(
            refused(|d| d.workspaces = vec!["api".to_owned(), "a/b".to_owned()]),
            Error::BadWorkspace(bad) if bad == "a/b"
        ));
        assert!(matches!(
            refused(|d| d.brief = Some("x".repeat(BRIEF_LIMIT + 1))),
            Error::BadBrief
        ));
        assert!(matches!(
            refused(|d| d.brief = Some("bell\u{7}".to_owned())),
            Error::BadBrief
        ));
        for base in [
            "a b", "a..b", "-x", "x.lock", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "",
        ] {
            let mut bad = definition("r1");
            bad.base = Some(base.to_owned());
            assert!(
                matches!(create_in(&dir, &bad), Err(Error::BadBase)),
                "{base}"
            );
        }
        let mut long = definition("r1");
        long.brief = Some("é".repeat(BRIEF_LIMIT));
        create_in(&dir, &long).expect("500 characters fit, whatever their bytes");
    }

    #[test]
    fn a_definition_round_trips_and_an_existing_name_is_refused() {
        let dir = scratch("round-trip");
        let made = definition("design-review");
        create_in(&dir, &made).expect("written");
        assert!(matches!(create_in(&dir, &made), Err(Error::Exists(_))));

        let bare = Definition {
            brief: None,
            base: None,
            ..definition("bare")
        };
        create_in(&dir, &bare).expect("written");
        let text = std::fs::read_to_string(dir.join("bare.toml")).expect("a file");
        assert_eq!(
            text, "workspace = \"web\"\nmade_at = 1800000000\n",
            "no dead keys"
        );

        let listing = list_in(&dir).expect("listed");
        assert_eq!(listing.rooms, [bare, made.clone()]);
        assert!(listing.unusable.is_empty());

        let edited = update_in(&dir, "design-review", Some("New brief")).expect("updated");
        assert_eq!(edited.brief.as_deref(), Some("New brief"));
        assert_eq!(edited.base, made.base, "only the brief moves");
        let cleared = update_in(&dir, "design-review", Some("  ")).expect("updated");
        assert_eq!(cleared.brief, None, "a blank brief is none");
        assert_eq!(list_in(&dir).expect("listed").rooms[1], cleared);
        assert!(!dir.join("design-review.toml.tmp").exists());
    }

    #[test]
    fn the_workspaces_list_round_trips_and_a_brief_edit_keeps_it() {
        let dir = scratch("workspaces");
        let shared = Definition {
            workspaces: vec!["api".to_owned(), "docs".to_owned()],
            ..definition("shared")
        };
        create_in(&dir, &shared).expect("written");
        assert_eq!(
            list_in(&dir).expect("listed").rooms,
            std::slice::from_ref(&shared)
        );

        let edited = update_in(&dir, "shared", Some("New brief")).expect("updated");
        assert_eq!(edited.workspaces, shared.workspaces, "only the brief moves");
        assert_eq!(list_in(&dir).expect("listed").rooms, [edited]);

        std::fs::write(dir.join("old.toml"), "workspace = \"web\"\nmade_at = 1\n")
            .expect("written");
        let listing = list_in(&dir).expect("listed");
        assert!(listing.rooms[0].workspaces.is_empty(), "no key is no list");
    }

    #[test]
    fn a_missing_file_is_missing_on_update_and_false_on_remove() {
        let dir = scratch("missing");
        assert!(matches!(
            update_in(&dir, "gone", Some("x")),
            Err(Error::Missing(_))
        ));
        assert!(!remove_in(&dir, "gone").expect("absence is success"));
        create_in(&dir, &definition("here")).expect("written");
        assert!(remove_in(&dir, "here").expect("removed"));
        assert!(list_in(&dir).expect("listed").rooms.is_empty());
        assert!(
            list_in(&scratch("never-made"))
                .expect("no directory is no rooms")
                .rooms
                .is_empty()
        );
    }

    #[test]
    fn a_torn_write_a_bad_file_and_a_bad_stem_cost_only_themselves() {
        let dir = scratch("listing");
        create_in(&dir, &definition("good")).expect("written");
        std::fs::write(dir.join("torn.toml.tmp"), "workspace = \"w").expect("written");
        std::fs::write(dir.join("broken.toml"), "workspace = [").expect("written");
        std::fs::write(dir.join("blank.toml"), "made_at = 1\n").expect("written");
        std::fs::write(
            dir.join("Bad Name.toml"),
            "workspace = \"w\"\nmade_at = 1\n",
        )
        .expect("written");
        std::fs::write(
            dir.join("later.toml"),
            "workspace = \"w\"\nmade_at = 1\nbudget = 30\n",
        )
        .expect("written");

        let listing = list_in(&dir).expect("listed");
        let names: Vec<&str> = listing
            .rooms
            .iter()
            .map(|room| room.name.as_str())
            .collect();
        assert_eq!(names, ["good", "later"], "an unknown key is ignored");
        let bad: Vec<(&str, String)> = listing
            .unusable
            .iter()
            .map(|(name, error)| (name.as_str(), error.to_string()))
            .collect();
        assert_eq!(bad.len(), 3, "{bad:?}");
        assert!(
            matches!(listing.unusable[0], (_, Error::BadName(_))),
            "{bad:?}"
        );
        assert!(
            matches!(listing.unusable[1], (_, Error::Unparsable { .. })),
            "{bad:?}"
        );
        assert!(
            matches!(listing.unusable[2], (_, Error::Unparsable { .. })),
            "{bad:?}"
        );
        assert!(
            bad.iter().all(|(_, said)| !said.contains("workspace = [")),
            "no content in the reason: {bad:?}"
        );
    }
}
