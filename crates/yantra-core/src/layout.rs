//! The dashboard layout on disk: `~/.config/yantra/dashboard.json`
//! ([ADR-0036](../../../docs/adr/0036-the-dashboard-layout-syncs-through-the-daemon.md)).
//!
//! It is the owner's preference, not fleet state, and it holds no secret.
//! This module checks the shape only. The browser knows the widget ids and
//! drops one it does not know (Y-504). A write names the `rev` it read, and a
//! write against an older `rev` is refused.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The most widgets one form factor holds.
pub const ITEMS_LIMIT: usize = 32;
/// The most workspaces one widget pins.
pub const PINS_LIMIT: usize = 16;

const FILE: &str = "dashboard.json";
const TEMP: &str = "dashboard.json.tmp";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    pub v: u32,
    pub rev: u64,
    pub phone: Vec<Item>,
    pub tablet: Vec<Item>,
    pub desktop: Vec<Item>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    pub id: String,
    pub size: Size,
    /// The workspaces the Spend widget shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pins: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Size {
    S,
    M,
    L,
}

// No variant carries the file's bytes.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not determine a config directory for the current user")]
    NoConfigDir,

    #[error("not a dashboard layout: {0}")]
    Invalid(String),

    /// The layout on disk, so the caller can start again from it.
    #[error("the layout changed since it was read: it is at rev {}", .0.rev)]
    Stale(Box<Layout>),

    /// A file that is there but is not a layout. A reader shows the default.
    #[error("{FILE} is not a dashboard layout: {0}")]
    Corrupt(String),

    #[error("{FILE} could not be read")]
    Unreadable(#[source] std::io::Error),

    #[error("{FILE} could not be written")]
    Unwritable(#[source] std::io::Error),
}

impl Default for Layout {
    /// The M17 plan's §6.1, without PR checks: no daemon serves `/api/pulls` yet.
    fn default() -> Self {
        let items = |list: &[(&str, Size)]| -> Vec<Item> {
            list.iter()
                .map(|&(id, size)| Item {
                    id: id.to_owned(),
                    size,
                    pins: None,
                })
                .collect()
        };
        let wide = items(&[
            ("needs-you", Size::L),
            ("running", Size::M),
            ("machines", Size::S),
            ("appliance", Size::S),
            ("github-inbox", Size::M),
            ("worth-a-look", Size::M),
            ("recent-activity", Size::M),
            ("idle", Size::M),
        ]);
        Self {
            v: 1,
            rev: 0,
            phone: items(&[
                ("needs-you", Size::M),
                ("running", Size::M),
                ("machines", Size::S),
                ("github-inbox", Size::S),
                ("worth-a-look", Size::S),
                ("recent-activity", Size::S),
                ("idle", Size::S),
                ("appliance", Size::S),
            ]),
            tablet: wide.clone(),
            desktop: wide,
        }
    }
}

impl Layout {
    /// Parses and checks a layout that arrived from outside.
    pub fn parse(bytes: &[u8]) -> Result<Self, Error> {
        let layout: Self =
            serde_json::from_slice(bytes).map_err(|error| Error::Invalid(error.to_string()))?;
        layout.check()?;
        Ok(layout)
    }

    pub fn check(&self) -> Result<(), Error> {
        if self.v != 1 {
            return Err(Error::Invalid(format!("version {} is not 1", self.v)));
        }
        for (form, items) in [
            ("phone", &self.phone),
            ("tablet", &self.tablet),
            ("desktop", &self.desktop),
        ] {
            if items.len() > ITEMS_LIMIT {
                return Err(Error::Invalid(format!(
                    "{form} has more than {ITEMS_LIMIT} widgets"
                )));
            }
            for item in items {
                if !good_id(&item.id) {
                    return Err(Error::Invalid(format!(
                        "a widget id is 1 to 32 of a-z and -, starting with a letter: {:?}",
                        item.id
                    )));
                }
                let pins = item.pins.as_deref().unwrap_or_default();
                if pins.len() > PINS_LIMIT {
                    return Err(Error::Invalid(format!(
                        "{} pins more than {PINS_LIMIT} workspaces",
                        item.id
                    )));
                }
                if let Some(pin) = pins.iter().find(|pin| !crate::workspace::usable_name(pin)) {
                    return Err(Error::Invalid(format!("{pin:?} is not a workspace name")));
                }
            }
        }
        Ok(())
    }
}

fn good_id(id: &str) -> bool {
    id.len() <= 32
        && id.starts_with(|c: char| c.is_ascii_lowercase())
        && id.chars().all(|c| c.is_ascii_lowercase() || c == '-')
}

/// `~/.config/yantra`, or the platform equivalent.
pub fn dir() -> Result<PathBuf, Error> {
    use etcetera::BaseStrategy;
    let base = etcetera::choose_base_strategy().map_err(|_| Error::NoConfigDir)?;
    Ok(base.config_dir().join("yantra"))
}

pub fn read() -> Result<Layout, Error> {
    read_in(&dir()?)
}

/// A missing file is the default at rev 0. A file that is not a layout is
/// [`Error::Corrupt`]: losing it loses only the layout (ADR-0036).
pub fn read_in(dir: &Path) -> Result<Layout, Error> {
    let bytes = match std::fs::read(dir.join(FILE)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Layout::default());
        }
        Err(error) => return Err(Error::Unreadable(error)),
    };
    Layout::parse(&bytes).map_err(|error| match error {
        Error::Invalid(reason) => Error::Corrupt(reason),
        other => other,
    })
}

pub fn replace(sent: &Layout) -> Result<Layout, Error> {
    replace_in(&dir()?, sent)
}

/// Saves `sent` at the next rev when `sent.rev` is the rev on disk. A corrupt
/// file counts as rev 0, so a save repairs it. The caller serialises calls.
pub fn replace_in(dir: &Path, sent: &Layout) -> Result<Layout, Error> {
    sent.check()?;
    let current = match read_in(dir) {
        Err(Error::Corrupt(_)) => Layout::default(),
        read => read?,
    };
    if sent.rev != current.rev {
        return Err(Error::Stale(Box::new(current)));
    }
    let saved = Layout {
        rev: current.rev + 1,
        ..sent.clone()
    };
    let text = serde_json::to_vec_pretty(&saved)
        .map_err(|error| Error::Unwritable(std::io::Error::other(error)))?;
    std::fs::create_dir_all(dir).map_err(Error::Unwritable)?;
    // Renamed over the file, so a reader never sees half a layout.
    let temp = dir.join(TEMP);
    std::fs::write(&temp, text).map_err(Error::Unwritable)?;
    std::fs::rename(&temp, dir.join(FILE)).map_err(Error::Unwritable)?;
    Ok(saved)
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("yantra-layout-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn mine(rev: u64) -> Layout {
        Layout {
            rev,
            desktop: vec![Item {
                id: "spend".to_owned(),
                size: Size::L,
                pins: Some(vec!["web".to_owned(), "api_2".to_owned()]),
            }],
            ..Layout::default()
        }
    }

    #[test]
    fn a_missing_file_is_the_default_at_rev_0() {
        let layout = read_in(&scratch("missing")).expect("read");
        assert_eq!(layout, Layout::default());
        assert_eq!((layout.v, layout.rev), (1, 0));
        layout.check().expect("the default passes its own check");
        let ids: Vec<&str> = layout.phone.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids[..2], ["needs-you", "running"]);
        assert!(
            !ids.contains(&"pr-checks"),
            "no daemon serves /api/pulls yet"
        );
    }

    #[test]
    fn a_matching_rev_saves_the_next_rev_and_leaves_no_temp_file() {
        let dir = scratch("save");
        let saved = replace_in(&dir, &mine(0)).expect("saved");
        assert_eq!(saved, mine(1));
        assert_eq!(read_in(&dir).expect("read"), mine(1));
        assert_eq!(replace_in(&dir, &mine(1)).expect("saved").rev, 2);
        assert!(!dir.join(TEMP).exists());
    }

    #[test]
    fn a_stale_rev_answers_the_current_layout_and_changes_nothing() {
        let dir = scratch("stale");
        replace_in(&dir, &mine(0)).expect("saved");
        let before = std::fs::read(dir.join(FILE)).expect("a file");
        let stale = Layout {
            rev: 0,
            ..Layout::default()
        };
        match replace_in(&dir, &stale) {
            Err(Error::Stale(current)) => assert_eq!(*current, mine(1)),
            other => panic!("expected Stale, got {other:?}"),
        }
        assert!(matches!(replace_in(&dir, &mine(7)), Err(Error::Stale(_))));
        assert_eq!(std::fs::read(dir.join(FILE)).expect("a file"), before);
    }

    #[test]
    fn each_guard_refuses_a_bad_shape() {
        let good = serde_json::to_value(mine(0)).expect("json");
        let refused = |change: &dyn Fn(&mut serde_json::Value)| {
            let mut bad = good.clone();
            change(&mut bad);
            let bytes = serde_json::to_vec(&bad).expect("json");
            match Layout::parse(&bytes) {
                Err(Error::Invalid(reason)) => reason,
                other => panic!("expected Invalid for {bad}, got {other:?}"),
            }
        };
        refused(&|l| l["desktop"][0]["size"] = "XL".into());
        refused(&|l| l["desktop"][0]["id"] = "Spend".into());
        refused(&|l| l["desktop"][0]["id"] = "".into());
        refused(&|l| l["desktop"][0]["id"] = "-x".into());
        refused(&|l| l["desktop"][0]["id"] = "x".repeat(33).into());
        refused(&|l| l["desktop"][0]["id"] = "a/b".into());
        refused(&|l| l["desktop"][0]["colour"] = "red".into());
        refused(&|l| l["theme"] = "dark".into());
        refused(&|l| l["v"] = 2.into());
        refused(&|l| l["desktop"][0]["pins"] = serde_json::json!(["../x"]));
        refused(&|l| l["desktop"][0]["pins"] = serde_json::json!(vec!["a"; 17]));
        refused(&|l| {
            let item = l["desktop"][0].clone();
            l["phone"] = serde_json::Value::Array(vec![item; ITEMS_LIMIT + 1]);
        });
        refused(&|l| {
            l.as_object_mut()
                .expect("an object")
                .remove("tablet")
                .map(drop)
                .expect("a key")
        });

        let longest = "x".repeat(32);
        let mut fits = good.clone();
        fits["desktop"][0]["id"] = longest.into();
        fits["desktop"][0]["pins"] = serde_json::json!(vec!["a"; 16]);
        Layout::parse(&serde_json::to_vec(&fits).expect("json")).expect("the limits fit");
        assert!(matches!(
            replace_in(&scratch("refused"), &Layout { v: 2, ..mine(0) }),
            Err(Error::Invalid(_))
        ));
    }

    #[test]
    fn a_corrupt_file_reads_as_corrupt_and_a_save_repairs_it() {
        let dir = scratch("corrupt");
        std::fs::create_dir_all(&dir).expect("a dir");
        std::fs::write(dir.join(FILE), "{\"v\":1,").expect("written");
        assert!(matches!(read_in(&dir), Err(Error::Corrupt(_))));
        assert_eq!(replace_in(&dir, &mine(0)).expect("saved"), mine(1));
    }
}
