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

/// The unit's `RuntimeDirectory`, where `install.sh` writes how far it got
/// (Y-612). The daemon's account cannot read the journal, so it reads this.
pub const PROGRESS: &str = "/run/yantra-update";

/// How many of the unit's last stderr lines a failure carries.
const SAID_LINES: usize = 20;

/// How far the unit has got, read from [`PROGRESS`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "step", rename_all = "lowercase")]
pub enum Progress {
    Resolving,
    /// `total` is `None` when the release host sent no length.
    Downloading {
        version: String,
        received: u64,
        total: Option<u64>,
    },
    Verifying,
    Installing,
    /// The last lines the unit wrote to stderr, as the journal has them.
    Failed {
        said: String,
    },
}

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

    #[error("could not read {}", path.display())]
    Unreadable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("{} names a step this build does not know: {step}", dir.display())]
    UnknownStep { dir: PathBuf, step: String },

    #[error("{} names an archive that is a path: {archive}", dir.display())]
    ArchivePath { dir: PathBuf, archive: String },
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

/// What `install.sh` last wrote to `dir/status`. No directory, no file and a
/// run that finished are all `None`: nothing is running and nothing failed.
pub fn progress(dir: &Path) -> Result<Option<Progress>, Error> {
    let Some(status) = read(&dir.join("status"))? else {
        return Ok(None);
    };
    let field = |key: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
            .unwrap_or_default()
    };
    let step = field("step");
    Ok(Some(match step {
        "" | "done" => return Ok(None),
        "resolving" => Progress::Resolving,
        "downloading" => {
            let archive = field("archive");
            if archive.contains('/') {
                return Err(Error::ArchivePath {
                    dir: dir.to_owned(),
                    archive: archive.to_owned(),
                });
            }
            // Before curl creates the file, nothing has arrived.
            let received = match archive {
                "" => 0,
                name => std::fs::metadata(dir.join(name)).map_or(0, |meta| meta.len()),
            };
            Progress::Downloading {
                version: field("version").to_owned(),
                received,
                total: field("total").parse().ok(),
            }
        }
        "verifying" => Progress::Verifying,
        "installing" => Progress::Installing,
        "failed" => {
            let said = read(&dir.join("said"))?.unwrap_or_default();
            let lines: Vec<&str> = said.lines().collect();
            Progress::Failed {
                said: lines[lines.len().saturating_sub(SAID_LINES)..].join("\n"),
            }
        }
        other => {
            return Err(Error::UnknownStep {
                dir: dir.to_owned(),
                step: other.to_owned(),
            });
        }
    }))
}

fn read(path: &Path) -> Result<Option<String>, Error> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(Error::Unreadable {
            path: path.to_owned(),
            source,
        }),
    }
}

/// The CLI's half: starts the unit and waits for it, restarts included.
pub async fn apply() -> Result<(), Error> {
    if !Path::new(UPDATER).exists() {
        return Err(Error::NotInstalled {
            updater: PathBuf::from(UPDATER),
        });
    }
    let out = tokio::process::Command::from(crate::scrubbed("systemctl"))
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

    fn status(dir: &Path, body: &str) {
        std::fs::write(dir.join("status"), body).expect("a status file");
    }

    #[test]
    fn no_directory_no_file_and_a_finished_run_are_nothing() {
        let dir = scratch("progress-none");
        assert_eq!(progress(&dir.join("gone")).expect("read"), None);
        assert_eq!(progress(&dir).expect("read"), None);
        status(
            &dir,
            "step=done\nversion=0.10.0\narchive=a.tar.gz\ntotal=\n",
        );
        assert_eq!(progress(&dir).expect("read"), None);
    }

    #[test]
    fn each_step_is_read_and_a_download_counts_the_bytes_on_disk() {
        let dir = scratch("progress-steps");
        for (step, want) in [
            ("resolving", Progress::Resolving),
            ("verifying", Progress::Verifying),
            ("installing", Progress::Installing),
        ] {
            status(&dir, &format!("step={step}\nversion=\narchive=\ntotal=\n"));
            assert_eq!(progress(&dir).expect("read"), Some(want));
        }

        let archive = "yantra-0.10.0-x86_64-unknown-linux-musl.tar.gz";
        status(
            &dir,
            &format!("step=downloading\nversion=0.10.0\narchive={archive}\ntotal=9800000\n"),
        );
        assert_eq!(
            progress(&dir).expect("read"),
            Some(Progress::Downloading {
                version: "0.10.0".into(),
                received: 0,
                total: Some(9_800_000),
            }),
            "curl has not created the file yet"
        );
        std::fs::write(dir.join(archive), [0u8; 3_100]).expect("some bytes");
        assert_eq!(
            progress(&dir).expect("read"),
            Some(Progress::Downloading {
                version: "0.10.0".into(),
                received: 3_100,
                total: Some(9_800_000),
            })
        );

        status(
            &dir,
            &format!("step=downloading\nversion=0.10.0\narchive={archive}\ntotal=\n"),
        );
        assert!(
            matches!(
                progress(&dir).expect("read"),
                Some(Progress::Downloading { total: None, .. })
            ),
            "a host that sent no length"
        );
    }

    #[test]
    fn a_failure_carries_the_last_twenty_lines_the_unit_said() {
        let dir = scratch("progress-failed");
        status(&dir, "step=failed\nversion=0.10.0\narchive=\ntotal=\n");
        assert_eq!(
            progress(&dir).expect("read"),
            Some(Progress::Failed {
                said: String::new()
            }),
            "a failure before anything was said"
        );

        let said: String = (1..=25).map(|n| format!("line {n}\n")).collect();
        std::fs::write(dir.join("said"), said).expect("said");
        let tail: String = (6..=25)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            progress(&dir).expect("read"),
            Some(Progress::Failed { said: tail })
        );
    }

    #[test]
    fn an_unknown_step_is_a_typed_error() {
        let dir = scratch("progress-unknown");
        status(&dir, "step=rebooting\n");
        let refused = progress(&dir);
        assert!(
            matches!(&refused, Err(Error::UnknownStep { step, .. }) if step == "rebooting"),
            "{refused:?}"
        );
    }

    #[test]
    fn an_archive_that_is_a_path_is_refused_and_nothing_is_read_through_it() {
        let dir = scratch("progress-path");
        status(
            &dir,
            "step=downloading\nversion=0.10.0\narchive=../../etc/shadow\ntotal=\n",
        );
        let refused = progress(&dir);
        assert!(
            matches!(refused, Err(Error::ArchivePath { .. })),
            "{refused:?}"
        );
    }

    #[test]
    fn progress_is_spelled_by_its_step_on_the_wire() {
        let wire = serde_json::to_value(Progress::Downloading {
            version: "0.10.0".into(),
            received: 1,
            total: None,
        })
        .expect("serialised");
        assert_eq!(
            wire,
            serde_json::json!({"step": "downloading", "version": "0.10.0", "received": 1, "total": null})
        );
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
