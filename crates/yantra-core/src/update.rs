//! Asking the appliance to install the current release
//! ([ADR-0027](../../../docs/adr/0027-the-appliance-pulls-its-own-update.md) §3).
//!
//! Two callers, one unit. `yantrad` runs as an account that cannot write
//! `/usr/local/bin`, so it only creates [`TRIGGER`] and `yantra-update.path`
//! starts the unit. `yantra update` run with privilege starts the unit itself.
//! Neither passes a version: the unit resolves the current release on its own,
//! on the channel [`CHANNEL`] names (Y-662).

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

/// Which release the unit installs (Y-662). `/etc/yantra` is root's, so the
/// daemon's account can rewrite this file and cannot swap it for a link.
pub const CHANNEL: &str = "/etc/yantra/channel";

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

/// A stable release is a `v*` tag; a nightly is the rolling pre-release that
/// every merge to `main` republishes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Stable,
    Nightly,
}

impl std::fmt::Display for Channel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Stable => "stable",
            Self::Nightly => "nightly",
        })
    }
}

impl std::str::FromStr for Channel {
    type Err = String;

    fn from_str(word: &str) -> Result<Self, String> {
        match word {
            "stable" => Ok(Self::Stable),
            "nightly" => Ok(Self::Nightly),
            _ => Err(format!("`{word}` is not a channel: name stable or nightly")),
        }
    }
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

    /// The file's text stays out: root reads it, and this error reaches a page.
    #[error("{} names no channel: it must hold stable or nightly", path.display())]
    NotAChannel { path: PathBuf },

    /// A box installed before Y-662 has no file, and only root may create one in `/etc/yantra`.
    #[error("{} is not there, and only root can create it. Run this once on the box: sudo yantra update --channel {channel}", path.display())]
    ChannelMissing { path: PathBuf, channel: Channel },

    #[error("could not write {}", path.display())]
    ChannelUnwritable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// The channel `path` names. No file is stable, as it is to the unit.
pub fn channel(path: &Path) -> Result<Channel, Error> {
    match read(path)? {
        None => Ok(Channel::Stable),
        Some(text) => text.trim().parse().map_err(|_| Error::NotAChannel {
            path: path.to_owned(),
        }),
    }
}

/// Written in place, because the daemon's account cannot create a file in
/// `/etc/yantra`. `install.sh` creates it and hands it to that account.
pub fn set_channel(path: &Path, channel: Channel) -> Result<(), Error> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let unwritable = |source| Error::ChannelUnwritable {
        path: path.to_owned(),
        source,
    };
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o644)
        .open(path)
        .and_then(|mut file| writeln!(file, "{channel}"))
        .map_err(|source| {
            if source.kind() == std::io::ErrorKind::PermissionDenied && !path.exists() {
                Error::ChannelMissing {
                    path: path.to_owned(),
                    channel,
                }
            } else {
                unwritable(source)
            }
        })
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

    /// `install.sh`'s `name_the_origin`, run with `sh` on two files in `dir`.
    fn name_the_origin(dir: &Path, env: &str, caddy: Option<&str>) -> String {
        const SCRIPT: &str = include_str!("../../../install.sh");
        let start = SCRIPT
            .find("name_the_origin() {")
            .expect("install.sh has name_the_origin");
        let end = start + SCRIPT[start..].find("\n}\n").expect("it ends") + 3;
        std::fs::write(dir.join("daemon.env"), env).expect("written");
        if let Some(caddy) = caddy {
            std::fs::write(dir.join("Caddyfile"), caddy).expect("written");
        }
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "as_root() {{ \"$@\"; }}\n{}\nname_the_origin \"$1/daemon.env\" \"$1/Caddyfile\"",
                &SCRIPT[start..end]
            ))
            .arg("sh")
            .arg(dir)
            .output()
            .expect("sh is on every machine this builds on");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        std::fs::read_to_string(dir.join("daemon.env")).expect("read")
    }

    const CADDY: &str = "{\n}\n\nhttps://yantra.cloudx.run {\n    bind 100.64.0.1\n    reverse_proxy unix//run/yantra/yantrad.sock {\n    }\n}\n";

    /// ADR-0044's 2026-11-12 amendment: a box named before the passkey gets
    /// its name as the origin on its next update, once.
    #[test]
    fn an_update_names_the_origin_domain_setup_gave_the_box() {
        let dir = scratch("origin");
        let named = name_the_origin(&dir, "YANTRA_PROXY_ACCOUNT=caddy", Some(CADDY));
        assert_eq!(
            named,
            "YANTRA_PROXY_ACCOUNT=caddy\nYANTRA_ORIGIN=https://yantra.cloudx.run\n"
        );
        assert_eq!(name_the_origin(&dir, &named, Some(CADDY)), named, "once");

        let kept = "YANTRA_ORIGIN=https://other.example\n";
        assert_eq!(name_the_origin(&dir, kept, Some(CADDY)), kept);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// No Caddyfile, or one domain-setup.sh did not write, names nothing.
    #[test]
    fn an_update_with_no_domain_setup_names_no_origin() {
        let dir = scratch("no-origin");
        assert_eq!(name_the_origin(&dir, "A=1\n", None), "A=1\n");
        let other = "https://yantra.cloudx.run {\n    reverse_proxy 100.64.0.1:7717\n}\n";
        assert_eq!(name_the_origin(&dir, "A=1\n", Some(other)), "A=1\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn scratch(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("yantra-update-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    #[test]
    fn a_channel_is_one_of_two_words_and_no_file_is_stable() {
        let dir = scratch("channel");
        let file = dir.join("channel");
        assert_eq!(channel(&file).expect("no file"), Channel::Stable);
        set_channel(&file, Channel::Nightly).expect("written");
        assert_eq!(std::fs::read_to_string(&file).expect("read"), "nightly\n");
        assert_eq!(channel(&file).expect("read"), Channel::Nightly);
        set_channel(&file, Channel::Stable).expect("rewritten");
        assert_eq!(channel(&file).expect("read"), Channel::Stable);
        std::fs::write(&file, "root:x:0:0\n").expect("junk");
        let refused = channel(&file).expect_err("junk");
        assert!(matches!(refused, Error::NotAChannel { .. }), "{refused:?}");
        assert!(!refused.to_string().contains("root:x"), "{refused}");
        assert!("beta".parse::<Channel>().is_err());
        assert_eq!("nightly".parse::<Channel>(), Ok(Channel::Nightly));
    }

    #[test]
    fn a_channel_in_a_directory_that_is_not_there_is_unwritable() {
        let dir = scratch("channel-gone");
        let refused = set_channel(&dir.join("gone").join("channel"), Channel::Nightly);
        assert!(
            matches!(refused, Err(Error::ChannelUnwritable { .. })),
            "{refused:?}"
        );
    }

    #[test]
    fn a_missing_channel_in_a_directory_only_root_writes_names_the_command() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("channel-root");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).expect("chmod");
        let refused = set_channel(&dir.join("channel"), Channel::Nightly);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        if refused.is_ok() {
            return; // root ignores the mode, so this proves nothing as root.
        }
        let refused = refused.expect_err("refused");
        assert!(
            matches!(refused, Error::ChannelMissing { .. }),
            "{refused:?}"
        );
        assert!(
            refused
                .to_string()
                .contains("sudo yantra update --channel nightly"),
            "{refused}"
        );
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
