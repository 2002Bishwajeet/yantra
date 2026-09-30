//! Asking the appliance to install the current release
//! ([ADR-0027](../../../docs/adr/0027-the-appliance-pulls-its-own-update.md) §3).
//!
//! Two callers, one unit. `yantrad` runs as an account that cannot write
//! `/usr/local/bin`, so it only creates [`TRIGGER`] and `yantra-update.path`
//! starts the unit. `yantra update` run with privilege starts the unit itself.
//! Neither passes a version: the unit resolves the current release on its own.

use std::path::{Path, PathBuf};
use std::process::Stdio;

/// Directly in the daemon's home, which its account cannot rename: a
/// directory under it could be swapped for a symlink under root's `rm`.
pub const TRIGGER: &str = "/home/yantra/yantra-update.requested";

/// The copy of `install.sh` that `install.sh` leaves behind. A box installed
/// by `just appliance-install` has none.
pub const UPDATER: &str = "/usr/local/bin/yantra-update";

pub const UNIT: &str = "yantra-update.service";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(
        "this box has no {}, so it was not installed by install.sh and cannot update itself. \
         Run install.sh once (docs/appliance.md), and it can",
        updater.display()
    )]
    NotInstalled { updater: PathBuf },

    #[error("starting {UNIT} needs root: {said}")]
    NoPrivilege { said: String },

    #[error("{UNIT} failed: {said}")]
    Failed { said: String },

    #[error("could not ask for an update")]
    Io(#[source] std::io::Error),
}

/// The daemon's half: an empty file the path unit watches. The paths are
/// parameters so a test names a scratch directory.
pub fn request(trigger: &Path, updater: &Path) -> Result<(), Error> {
    if !updater.exists() {
        return Err(Error::NotInstalled {
            updater: updater.to_owned(),
        });
    }
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(trigger)
        .map(drop)
        .map_err(Error::Io)
}

/// The CLI's half: starts the unit and waits for it, restarts included.
pub async fn apply() -> Result<(), Error> {
    if !Path::new(UPDATER).exists() {
        return Err(Error::NotInstalled {
            updater: PathBuf::from(UPDATER),
        });
    }
    let out = tokio::process::Command::new("systemctl")
        .args(["start", "--no-ask-password", UNIT])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(Error::Io)?;
    judge(
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).trim(),
    )
}

/// `systemctl` exits 1 both for a unit that failed and for a caller polkit
/// refused, so the words decide between them. 4 and 5 are its own codes for
/// no permission and no such unit.
fn judge(code: Option<i32>, said: &str) -> Result<(), Error> {
    match code {
        Some(0) => Ok(()),
        Some(5) => Err(Error::NotInstalled {
            updater: PathBuf::from(UPDATER),
        }),
        Some(4) => Err(Error::NoPrivilege {
            said: said.to_owned(),
        }),
        _ if said.contains("Access denied") || said.contains("authentication required") => {
            Err(Error::NoPrivilege {
                said: said.to_owned(),
            })
        }
        _ => Err(Error::Failed {
            said: said.to_owned(),
        }),
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("yantra-update-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    #[test]
    fn a_box_with_no_updater_is_told_so_and_nothing_is_written() {
        let dir = scratch("absent");
        let trigger = dir.join("requested");

        let refused = request(&trigger, &dir.join("yantra-update"));

        assert!(
            matches!(refused, Err(Error::NotInstalled { .. })),
            "{refused:?}"
        );
        assert!(!trigger.exists(), "the path unit would fire for nothing");
        let said = refused.expect_err("refused").to_string();
        assert!(said.contains("install.sh"), "{said}");
    }

    #[test]
    fn a_request_is_an_empty_file_and_asking_twice_is_one_request() {
        let dir = scratch("present");
        let (trigger, updater) = (dir.join("requested"), dir.join("yantra-update"));
        std::fs::write(&updater, "#!/bin/sh\n").expect("an updater");

        request(&trigger, &updater).expect("asked");
        request(&trigger, &updater).expect("asked again");

        assert_eq!(std::fs::read(&trigger).expect("the trigger"), b"");
    }

    #[test]
    fn a_directory_that_cannot_hold_the_trigger_is_an_io_error() {
        let dir = scratch("unwritable");
        let updater = dir.join("yantra-update");
        std::fs::write(&updater, "#!/bin/sh\n").expect("an updater");

        let refused = request(&dir.join("gone").join("requested"), &updater);

        assert!(matches!(refused, Err(Error::Io(_))), "{refused:?}");
    }

    /// polkit's refusal measured on systemd 262, 2026-09-30: exit 1, as a
    /// failed oneshot is.
    #[test]
    fn systemctl_is_read_by_code_and_then_by_words() {
        assert!(judge(Some(0), "").is_ok());
        assert!(matches!(
            judge(Some(5), "Unit yantra-update.service not found."),
            Err(Error::NotInstalled { .. })
        ));
        assert!(matches!(
            judge(
                Some(1),
                "Failed to start yantra-update.service: Access denied as the requested operation \
                 requires interactive authentication."
            ),
            Err(Error::NoPrivilege { .. })
        ));
        assert!(matches!(
            judge(
                Some(1),
                "Failed to start yantra-update.service: Interactive authentication required."
            ),
            Err(Error::NoPrivilege { .. })
        ));
        assert!(matches!(judge(Some(4), ""), Err(Error::NoPrivilege { .. })));
        assert!(matches!(
            judge(
                Some(1),
                "Job for yantra-update.service failed because the control process exited with error code."
            ),
            Err(Error::Failed { .. })
        ));
        assert!(matches!(judge(None, ""), Err(Error::Failed { .. })));
    }
}
