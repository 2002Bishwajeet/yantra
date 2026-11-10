//! The systemd user timers on the machine this process runs on, with each
//! one's last result and the state file its job writes (Y-706).
//!
//! **This is a read.** It asks `systemctl --user` and reads
//! `$XDG_STATE_HOME/box/<service>.json`; it starts, stops and writes nothing.
//! The times are the local strings systemctl prints, so nothing here needs a
//! local UTC offset, which `time` cannot read soundly on musl.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Job {
    pub timer: String,
    pub service: String,
    /// Microseconds since the Unix epoch, as `list-timers` reports them.
    pub next: Option<u64>,
    pub last: Option<u64>,
    /// The same instants in local time, as systemctl spells them:
    /// `Tue 2026-12-01 06:03:56 IST`.
    pub next_local: Option<String>,
    pub last_local: Option<String>,
    pub last_result: LastResult,
    pub state: Option<StateFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LastResult {
    Never,
    Running,
    Succeeded,
    /// `result` is systemd's word (`exit-code`, `signal`, `timeout`,
    /// `oom-kill`, ...); `status` is the exit status when the process exited.
    Failed {
        result: String,
        status: Option<i32>,
    },
}

/// The job's own record. In JSON an object is the file and a string is why it
/// could not be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum StateFile {
    Read(Fields),
    Unreadable(String),
}

/// A JSON object's fields in file order; serde_json's map sorts them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fields(pub Vec<(String, Value)>);

impl Serialize for Fields {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.collect_map(self.0.iter().map(|(key, value)| (key, value)))
    }
}

impl<'de> Deserialize<'de> for Fields {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Fields;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Fields, A::Error> {
                let mut fields = Vec::new();
                while let Some(entry) = map.next_entry()? {
                    fields.push(entry);
                }
                Ok(Fields(fields))
            }
        }
        de.deserialize_map(Visitor)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not run `{program}`")]
    Io {
        program: &'static str,
        #[source]
        source: std::io::Error,
    },

    #[error("`{program}` failed: {stderr}")]
    Failed {
        program: &'static str,
        stderr: String,
    },

    #[error("`systemctl --user list-timers` answered JSON this version does not understand")]
    Json(#[source] serde_json::Error),
}

const PROPERTIES: &str = "NextElapseUSecRealtime,LastTriggerUSec,ActiveState,Result,ExecMainCode,ExecMainStatus,ExecMainStartTimestamp";

pub async fn list() -> Result<Vec<Job>, Error> {
    use etcetera::BaseStrategy as _;
    let state_dir = etcetera::choose_base_strategy()
        .ok()
        .and_then(|base| base.state_dir())
        .map(|dir| dir.join("box"));

    let listed = run(
        "systemctl",
        &["--user", "list-timers", "--all", "--output=json"],
    )
    .await?;
    let timers = parse_timers(&listed)?;
    if timers.is_empty() {
        return Ok(Vec::new());
    }
    let mut args = vec!["--user", "show", "-p", PROPERTIES];
    for timer in &timers {
        args.extend([timer.unit.as_str(), timer.activates.as_str()]);
    }
    let shown = run("systemctl", &args).await?;
    let mut blocks = split_blocks(&shown).into_iter();

    let mut jobs = Vec::new();
    for timer in timers {
        let timer_props = blocks.next().unwrap_or_default();
        let service_props = blocks.next().unwrap_or_default();

        let mut next_local = local(&timer_props, "NextElapseUSecRealtime");
        // A monotonic timer (`OnUnitActiveSec=`) has no realtime string.
        if let (None, Some(next)) = (&next_local, timer.next) {
            next_local = Some(format_local(next).await?);
        }
        jobs.push(Job {
            next_local,
            last_local: local(&timer_props, "LastTriggerUSec"),
            last_result: judge(&service_props),
            state: state_dir
                .as_deref()
                .and_then(|dir| read_state(&state_path(dir, &timer.activates))),
            timer: timer.unit,
            service: timer.activates,
            next: timer.next,
            last: timer.last,
        });
    }
    Ok(jobs)
}

async fn run(program: &'static str, args: &[&str]) -> Result<String, Error> {
    let out = tokio::process::Command::from(crate::scrubbed(program))
        .args(args)
        // `date` spells weekdays in the locale; systemctl's strings are C's.
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|source| Error::Io { program, source })?;
    if !out.status.success() {
        return Err(Error::Failed {
            program,
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

async fn format_local(micros: u64) -> Result<String, Error> {
    let at = format!("@{}", micros / 1_000_000);
    let out = run("date", &["-d", &at, "+%a %Y-%m-%d %H:%M:%S %Z"]).await?;
    Ok(out.trim().to_owned())
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
struct Timer {
    #[serde(deserialize_with = "zero_is_none")]
    next: Option<u64>,
    #[serde(deserialize_with = "zero_is_none")]
    last: Option<u64>,
    unit: String,
    activates: String,
}

/// `list-timers` writes `null` for a timer with no next run and `0` for one
/// that never fired.
fn zero_is_none<'de, D: serde::Deserializer<'de>>(de: D) -> Result<Option<u64>, D::Error> {
    Ok(Option::<u64>::deserialize(de)?.filter(|&micros| micros != 0))
}

fn parse_timers(json: &str) -> Result<Vec<Timer>, Error> {
    serde_json::from_str(json).map_err(Error::Json)
}

/// `systemctl show a b ...` prints one block per unit, in argument order,
/// separated by a blank line. The properties inside a block are in systemd's
/// order, not the order `-p` named them.
fn split_blocks(text: &str) -> Vec<BTreeMap<String, String>> {
    text.split("\n\n")
        .map(|block| {
            block
                .lines()
                .filter_map(|line| line.split_once('='))
                .map(|(key, value)| (key.to_owned(), value.to_owned()))
                .collect()
        })
        .collect()
}

fn local(props: &BTreeMap<String, String>, key: &str) -> Option<String> {
    props.get(key).filter(|value| !value.is_empty()).cloned()
}

fn judge(props: &BTreeMap<String, String>) -> LastResult {
    let get = |key: &str| props.get(key).map_or("", String::as_str);
    // A unit that never ran also reads Result=success.
    if get("ExecMainStartTimestamp").is_empty() {
        return LastResult::Never;
    }
    if matches!(get("ActiveState"), "activating" | "active" | "reloading") {
        return LastResult::Running;
    }
    match get("Result") {
        "success" => LastResult::Succeeded,
        result => LastResult::Failed {
            result: result.to_owned(),
            // 1 is CLD_EXITED: ExecMainStatus is then an exit status, not a signal.
            status: (get("ExecMainCode") == "1")
                .then(|| get("ExecMainStatus").parse().ok())
                .flatten(),
        },
    }
}

fn state_path(dir: &Path, service: &str) -> PathBuf {
    let stem = service.strip_suffix(".service").unwrap_or(service);
    dir.join(format!("{stem}.json"))
}

fn read_state(path: &Path) -> Option<StateFile> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => return Some(StateFile::Unreadable(error.to_string())),
    };
    Some(match serde_json::from_str(&text) {
        Ok(fields) => StateFile::Read(fields),
        Err(error) => StateFile::Unreadable(error.to_string()),
    })
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    /// yantra-box, systemd 257, 2026-11-10: `invoice.timer` has not fired yet.
    const BOX_TIMERS: &str = r#"[{"next":1794436562616795,"left":1794436562616795,"last":1794349950107562,"passed":117541975984,"unit":"seagate-recycle.timer","activates":"seagate-recycle.service"},{"next":1796085236425850,"left":1796085236425850,"last":0,"passed":0,"unit":"invoice.timer","activates":"invoice.service"}]"#;

    const BOX_SHOW: &str = "NextElapseUSecRealtime=Tue 2026-12-01 06:03:56 IST\nLastTriggerUSec=\nResult=success\nActiveState=active\n\nResult=success\nExecMainStartTimestamp=\nExecMainCode=0\nExecMainStatus=0\nActiveState=inactive\n";

    fn props(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn ran(active: &str, result: &str, code: &str, status: &str) -> BTreeMap<String, String> {
        props(&[
            ("ActiveState", active),
            ("Result", result),
            ("ExecMainCode", code),
            ("ExecMainStatus", status),
            ("ExecMainStartTimestamp", "Tue 2026-11-10 13:01:58 CET"),
        ])
    }

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yantra-jobs-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        dir
    }

    #[test]
    fn list_timers_json_reads_zero_and_null_as_none() {
        let timers = parse_timers(BOX_TIMERS).expect("the box's output parses");
        assert_eq!(timers.len(), 2);
        assert_eq!(timers[1].unit, "invoice.timer");
        assert_eq!(timers[1].activates, "invoice.service");
        assert_eq!(timers[1].next, Some(1_796_085_236_425_850));
        assert_eq!(timers[1].last, None);

        let never =
            parse_timers(r#"[{"next":null,"last":null,"unit":"a.timer","activates":"a.service"}]"#)
                .expect("a null next parses");
        assert_eq!((never[0].next, never[0].last), (None, None));
        assert!(matches!(parse_timers("not json"), Err(Error::Json(_))));
    }

    #[test]
    fn show_output_splits_into_one_block_per_unit() {
        let blocks = split_blocks(BOX_SHOW);
        assert_eq!(blocks.len(), 2);
        assert_eq!(
            local(&blocks[0], "NextElapseUSecRealtime").as_deref(),
            Some("Tue 2026-12-01 06:03:56 IST")
        );
        assert_eq!(local(&blocks[0], "LastTriggerUSec"), None);
        assert_eq!(blocks[1]["ActiveState"], "inactive");
        assert_eq!(judge(&blocks[1]), LastResult::Never);
    }

    #[test]
    fn judge_reads_every_last_result() {
        assert_eq!(judge(&BTreeMap::new()), LastResult::Never);
        assert_eq!(
            judge(&ran("activating", "success", "0", "0")),
            LastResult::Running
        );
        assert_eq!(
            judge(&ran("inactive", "success", "1", "0")),
            LastResult::Succeeded
        );
        // Measured on the host: a failed `/usr/bin/false`.
        assert_eq!(
            judge(&ran("failed", "exit-code", "1", "1")),
            LastResult::Failed {
                result: "exit-code".to_owned(),
                status: Some(1)
            }
        );
        // ExecMainCode 2 is CLD_KILLED: ExecMainStatus is a signal number.
        assert_eq!(
            judge(&ran("failed", "signal", "2", "9")),
            LastResult::Failed {
                result: "signal".to_owned(),
                status: None
            }
        );
        assert_eq!(
            judge(&ran("failed", "timeout", "0", "0")),
            LastResult::Failed {
                result: "timeout".to_owned(),
                status: None
            }
        );
    }

    #[test]
    fn a_service_names_its_state_file() {
        let dir = Path::new("/home/me/.local/state/box");
        assert_eq!(state_path(dir, "invoice.service"), dir.join("invoice.json"));
        assert_eq!(state_path(dir, "odd"), dir.join("odd.json"));
    }

    #[test]
    fn a_state_file_is_read_or_named_unreadable() {
        let dir = scratch("state");
        assert_eq!(read_state(&dir.join("absent.json")), None);

        let good = dir.join("good.json");
        std::fs::write(&good, r#"{"sent":"2026-11-01","count":3}"#).expect("write");
        assert_eq!(
            read_state(&good),
            Some(StateFile::Read(Fields(vec![
                ("sent".to_owned(), "2026-11-01".into()),
                ("count".to_owned(), 3.into()),
            ])))
        );

        let array = dir.join("array.json");
        std::fs::write(&array, "[1]").expect("write");
        assert!(
            matches!(read_state(&array), Some(StateFile::Unreadable(reason)) if reason.contains("a JSON object"))
        );

        let broken = dir.join("broken.json");
        std::fs::write(&broken, "{").expect("write");
        assert!(matches!(
            read_state(&broken),
            Some(StateFile::Unreadable(_))
        ));

        // A directory where the file should be cannot be read as one.
        let dir_file = dir.join("dir.json");
        std::fs::create_dir(&dir_file).expect("mkdir");
        assert!(matches!(
            read_state(&dir_file),
            Some(StateFile::Unreadable(_))
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Removes the throwaway units however the test ends.
    struct Units {
        dir: PathBuf,
        name: String,
    }

    impl Drop for Units {
        fn drop(&mut self) {
            let timer = format!("{}.timer", self.name);
            let service = format!("{}.service", self.name);
            let systemctl = |args: &[&str]| {
                let _ = std::process::Command::new("systemctl")
                    .arg("--user")
                    .args(args)
                    .output();
            };
            systemctl(&["stop", &timer, &service]);
            systemctl(&["reset-failed", &timer, &service]);
            let _ = std::fs::remove_file(self.dir.join(&timer));
            let _ = std::fs::remove_file(self.dir.join(&service));
            systemctl(&["daemon-reload"]);
        }
    }

    /// §B3: the real user manager, not a fixture.
    #[tokio::test]
    async fn a_failed_job_reads_as_failed_with_its_exit_status() {
        let reachable = std::process::Command::new("systemctl")
            .args(["--user", "list-timers"])
            .output()
            .is_ok_and(|out| out.status.success());
        if !reachable {
            assert!(
                std::env::var_os("YANTRA_REQUIRE_SYSTEMD_USER").is_none(),
                "YANTRA_REQUIRE_SYSTEMD_USER is set and `systemctl --user` cannot reach a user bus"
            );
            eprintln!("skipped: `systemctl --user` cannot reach a user bus");
            return;
        }

        use etcetera::BaseStrategy as _;
        let dir = etcetera::choose_base_strategy()
            .expect("a home directory")
            .config_dir()
            .join("systemd/user");
        std::fs::create_dir_all(&dir).expect("the user unit directory");
        let units = Units {
            dir,
            name: format!("y706-test-{}", std::process::id()),
        };
        let timer = format!("{}.timer", units.name);
        let service = format!("{}.service", units.name);
        std::fs::write(units.dir.join(&timer), "[Timer]\nOnCalendar=2099-01-01\n")
            .expect("write the timer");
        std::fs::write(
            units.dir.join(&service),
            "[Service]\nType=oneshot\nExecStart=/bin/false\n",
        )
        .expect("write the service");

        let systemctl = |args: &[&str]| {
            std::process::Command::new("systemctl")
                .arg("--user")
                .args(args)
                .status()
                .expect("systemctl runs")
        };
        assert!(systemctl(&["daemon-reload"]).success());
        assert!(systemctl(&["start", &timer]).success());
        assert!(
            !systemctl(&["start", &service]).success(),
            "/bin/false fails"
        );

        let jobs = list().await.expect("the timers list");
        let job = jobs
            .iter()
            .find(|job| job.timer == timer)
            .expect("the throwaway timer is listed");
        assert_eq!(job.service, service);
        assert_eq!(
            job.last_result,
            LastResult::Failed {
                result: "exit-code".to_owned(),
                status: Some(1)
            }
        );
        assert!(
            job.next_local
                .as_deref()
                .is_some_and(|next| next.contains("2099-01-01")),
            "next run: {:?}",
            job.next_local
        );
    }
}
