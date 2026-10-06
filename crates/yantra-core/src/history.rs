//! One pass of the redaction job: each machine keeps a redacted staging copy of
//! every harness's transcripts, which Syncthing sends to the appliance
//! ([ADR-0032] decision 2, Y-430).
//!
//! The live transcript is read and never written, because `--resume` needs it
//! whole. `gitleaks` finds the secrets (§B2); this module replaces each one it
//! reports, and refuses a file when it cannot do that and keep the JSON whole.
//! A pass that cannot be sure a copy is clean does not stage it.
//!
//! opencode is not here: it keeps its sessions in one SQLite database, not in
//! transcript files.
//!
//! [ADR-0032]: ../../../docs/adr/0032-the-appliance-keeps-the-conversation-history-encrypted.md

use std::collections::HashSet;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

/// What replaces each secret in a staging copy.
pub const REDACTED: &str = "[REDACTED]";

/// `gitleaks`' own rules, and one more. R18 §11.3 found the default set misses
/// `DATABASE_PASSWORD=<17 characters>`: it has no known shape and too little
/// entropy, so this rule has no entropy gate. A backslash ends the value
/// because a JSON line escapes the newline or quote after it; it may also
/// come before the opening quote, as `\"` in a JSON line.
pub const GITLEAKS_CONFIG: &str = r#"[extend]
useDefault = true

[[rules]]
id = "yantra-assignment"
description = "A name that says secret, assigned a value"
regex = '''(?i)\b[A-Z0-9_]*(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY)[A-Z0-9_]*\s*[=:]\s*(?:\\?["'])?([^\s"'\\]{8,})'''
secretGroup = 2
"#;

/// One agent harness, and where under `$HOME` its transcripts live.
#[derive(Debug, Clone, Copy)]
pub struct Harness {
    /// The directory under `history/` that holds its staging copies.
    pub name: &'static str,
    root: &'static str,
    keeps: fn(&Path) -> bool,
}

pub const HARNESSES: [Harness; 4] = [
    Harness {
        name: "claude",
        root: ".claude/projects",
        keeps: is_jsonl,
    },
    Harness {
        name: "codex",
        root: ".codex/sessions",
        keeps: is_jsonl,
    },
    Harness {
        name: "gemini",
        root: ".gemini/tmp",
        keeps: |rel| is_jsonl(rel) && rel.iter().nth(1).is_some_and(|dir| dir == "chats"),
    },
    Harness {
        name: "grok",
        root: ".grok/sessions",
        keeps: |rel| is_jsonl(rel) || rel.extension().is_some_and(|ext| ext == "json"),
    },
];

fn is_jsonl(rel: &Path) -> bool {
    rel.extension().is_some_and(|ext| ext == "jsonl")
}

/// What one pass did. A file left as it was is counted, not listed.
#[derive(Debug, Default)]
pub struct Report {
    /// Staging copies (re)written, by their staging path.
    pub written: Vec<PathBuf>,
    pub unchanged: usize,
    /// Staging copies whose live transcript is gone.
    pub removed: Vec<PathBuf>,
    pub failed: Vec<Failure>,
    /// Secrets replaced, counted per occurrence.
    pub redactions: usize,
}

/// A live transcript with no fresh staging copy, and why.
#[derive(Debug)]
pub struct Failure {
    pub live: PathBuf,
    pub reason: Refusal,
}

#[derive(Debug, thiserror::Error)]
pub enum Refusal {
    #[error("gitleaks failed: {0}")]
    Scan(String),

    #[error("the transcript is not UTF-8 text")]
    NotText,

    #[error(
        "gitleaks reported a secret that is not in the file as written, so it cannot be removed"
    )]
    Unfound,

    #[error("line {0} no longer parses as JSON after redaction")]
    BrokeJson(usize),

    #[error("the file no longer parses as JSON after redaction")]
    BrokeDocument,

    #[error(transparent)]
    Io(#[from] io::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no home directory, so there are no transcripts to read")]
    NoHome,

    #[error("`gitleaks` is not on PATH, so nothing can be redacted and nothing was staged")]
    NoGitleaks,

    #[error("could not read or write {}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// Why a scan gave no answer. `Missing` stops the pass: every file would fail
/// the same way.
#[derive(Debug)]
pub enum ScanError {
    Missing,
    Failed(String),
}

/// The secret scanner. The test double stands in for `gitleaks`.
pub trait Scan {
    /// Each secret in `text`, spelled as it appears there.
    fn secrets(&self, text: &str) -> Result<Vec<String>, ScanError>;
}

/// The real scanner: `gitleaks stdin`, with [`GITLEAKS_CONFIG`].
///
/// The text goes on stdin and the report comes back on stdout, so no
/// unredacted copy is written anywhere, and gitleaks scans exactly the bytes
/// this pass redacts.
#[derive(Debug)]
pub struct Gitleaks {
    /// Where `gitleaks` looks for a `.gitleaksignore`. A directory this job owns,
    /// so no ignore file from somewhere else can hide a finding.
    pub ignore_dir: PathBuf,
    config: PathBuf,
}

impl Gitleaks {
    /// Writes [`GITLEAKS_CONFIG`] to `scratch/gitleaks.toml`, which every scan
    /// passes as `--config`.
    pub fn new(scratch: PathBuf) -> io::Result<Self> {
        let config = scratch.join("gitleaks.toml");
        write_atomic(&config, &scratch, GITLEAKS_CONFIG, SystemTime::now())?;
        Ok(Self {
            ignore_dir: scratch,
            config,
        })
    }

    // `--config` outranks both GITLEAKS_CONFIG variables in every 8.x release;
    // GITLEAKS_CONFIG_TOML is read only from 8.25.0.
    fn command(&self) -> Command {
        let mut command = Command::new("gitleaks");
        command
            .args([
                "stdin",
                "--no-banner",
                "--log-level",
                "error",
                "--exit-code",
                "0",
                "--report-format",
                "json",
                "--report-path",
                "-",
                // A transcript can quote `gitleaks:allow`; it must not hide a line.
                "--ignore-gitleaks-allow",
                "--config",
            ])
            .arg(&self.config)
            .arg("--gitleaks-ignore-path")
            .arg(&self.ignore_dir);
        command
    }
}

impl Scan for Gitleaks {
    fn secrets(&self, text: &str) -> Result<Vec<String>, ScanError> {
        let mut child = self
            .command()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| match e.kind() {
                io::ErrorKind::NotFound => ScanError::Missing,
                _ => ScanError::Failed(e.to_string()),
            })?;
        let fed = child
            .stdin
            .take()
            .map(|mut stdin| stdin.write_all(text.as_bytes()));
        let out = child
            .wait_with_output()
            .map_err(|e| ScanError::Failed(e.to_string()))?;
        if !out.status.success() {
            return Err(ScanError::Failed(format!(
                "{}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        if let Some(Err(e)) = fed {
            return Err(ScanError::Failed(format!("writing to gitleaks: {e}")));
        }
        parse_report(&out.stdout)
    }
}

#[derive(serde::Deserialize)]
struct Finding {
    #[serde(rename = "Secret")]
    secret: String,
}

fn parse_report(json: &[u8]) -> Result<Vec<String>, ScanError> {
    let findings: Vec<Finding> = serde_json::from_slice(json)
        .map_err(|e| ScanError::Failed(format!("unreadable report: {e}")))?;
    Ok(findings.into_iter().map(|f| f.secret).collect())
}

/// One pass for this account: transcripts under `$HOME`, staging copies under
/// `$XDG_DATA_HOME/yantra/history`.
pub fn stage() -> Result<Report, Error> {
    use etcetera::BaseStrategy as _;
    let base = etcetera::choose_base_strategy().map_err(|_| Error::NoHome)?;
    let data = base.data_dir().join("yantra");
    let scratch = data.join("history.tmp");
    fs::create_dir_all(&scratch).map_err(|source| Error::Io {
        path: scratch.clone(),
        source,
    })?;
    let scanner = Gitleaks::new(scratch.clone()).map_err(|source| Error::Io {
        path: scratch.join("gitleaks.toml"),
        source,
    })?;
    stage_in(base.home_dir(), &data, &scanner)
}

/// The testable half. `data` holds `history/`, which Syncthing sends, and
/// `history.tmp/`, which it does not: a write lands there first and a rename on
/// the same filesystem moves it into place, so a half-written file is never
/// in the folder Syncthing watches.
pub fn stage_in<S: Scan>(home: &Path, data: &Path, scanner: &S) -> Result<Report, Error> {
    let staging = data.join("history");
    let scratch = data.join("history.tmp");
    fs::create_dir_all(&scratch).map_err(|source| Error::Io {
        path: scratch.clone(),
        source,
    })?;
    let mut report = Report::default();
    for harness in &HARNESSES {
        let root = home.join(harness.root);
        let into = staging.join(harness.name);
        for rel in files(&root)? {
            if !(harness.keeps)(&rel) {
                continue;
            }
            let live = root.join(&rel);
            let staged = into.join(&rel);
            match stage_one(&live, &staged, &scratch, scanner) {
                Ok(None) => report.unchanged += 1,
                Ok(Some(count)) => {
                    report.redactions += count;
                    report.written.push(staged);
                }
                Err(Step::Stop) => return Err(Error::NoGitleaks),
                Err(Step::Refused(reason)) => report.failed.push(Failure { live, reason }),
            }
        }
        for rel in files(&into)? {
            let live = root.join(&rel);
            if (harness.keeps)(&rel) && live.is_file() {
                continue;
            }
            let staged = into.join(&rel);
            fs::remove_file(&staged).map_err(|source| Error::Io {
                path: staged.clone(),
                source,
            })?;
            report.removed.push(staged);
        }
        prune_empty(&into)?;
    }
    Ok(report)
}

enum Step {
    Stop,
    Refused(Refusal),
}

impl From<io::Error> for Step {
    fn from(e: io::Error) -> Self {
        Self::Refused(Refusal::Io(e))
    }
}

impl From<Refusal> for Step {
    fn from(r: Refusal) -> Self {
        Self::Refused(r)
    }
}

/// `Ok(None)` when the staging copy is current, `Ok(Some(redactions))` when it
/// was written.
///
/// "Current" is the mtime alone: the staging copy carries the live file's
/// mtime, and its size differs whenever something was redacted.
fn stage_one<S: Scan>(
    live: &Path,
    staged: &Path,
    scratch: &Path,
    scanner: &S,
) -> Result<Option<usize>, Step> {
    // Read the mtime before the bytes: a write in between moves the mtime on,
    // so the next pass stages again rather than keeping a stale copy.
    let mtime = fs::metadata(live)?.modified()?;
    if fs::metadata(staged)
        .and_then(|m| m.modified())
        .is_ok_and(|staged_mtime| staged_mtime == mtime)
    {
        return Ok(None);
    }
    let text = String::from_utf8(fs::read(live)?).map_err(|_| Refusal::NotText)?;
    let secrets = scanner.secrets(&text).map_err(|e| match e {
        ScanError::Missing => Step::Stop,
        ScanError::Failed(why) => Step::Refused(Refusal::Scan(why)),
    })?;
    let (clean, count) = redact(&text, &secrets)?;
    write_atomic(staged, scratch, &clean, mtime)?;
    Ok(Some(count))
}

/// Replaces every reported secret, longest first so that a secret inside
/// another is not left behind. Each line that was JSON must still be.
fn redact(text: &str, secrets: &[String]) -> Result<(String, usize), Refusal> {
    let mut unique: Vec<&str> = secrets
        .iter()
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    unique.sort_by_key(|s| std::cmp::Reverse(s.len()));
    let mut clean = text.to_owned();
    let mut count = 0;
    for secret in unique {
        if !text.contains(secret) {
            return Err(Refusal::Unfound);
        }
        count += clean.matches(secret).count();
        clean = clean.replace(secret, REDACTED);
    }
    let after: Vec<&str> = clean.lines().collect();
    for (index, line) in text.lines().enumerate() {
        if is_json(line) && !after.get(index).is_some_and(|l| is_json(l)) {
            return Err(Refusal::BrokeJson(index + 1));
        }
    }
    if is_json(text) && !is_json(&clean) {
        return Err(Refusal::BrokeDocument);
    }
    Ok((clean, count))
}

fn is_json(text: &str) -> bool {
    serde_json::from_str::<serde::de::IgnoredAny>(text).is_ok()
}

fn write_atomic(staged: &Path, scratch: &Path, text: &str, mtime: SystemTime) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt as _;
    let temp = scratch.join(format!("stage-{}", std::process::id()));
    // The live transcript is 0600, and some secrets survive redaction.
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)?;
    file.write_all(text.as_bytes())?;
    // Set before the rename, so the file never appears in the folder with
    // another mtime.
    file.set_modified(mtime)?;
    drop(file);
    if let Some(parent) = staged.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&temp, staged)
}

/// Every regular file under `root`, relative to it. Symlinks are not followed.
/// A root that is not there holds nothing.
fn files(root: &Path) -> Result<Vec<PathBuf>, Error> {
    let mut found = Vec::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(rel) = pending.pop() {
        let dir = root.join(&rel);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(source) => return Err(Error::Io { path: dir, source }),
        };
        for entry in entries {
            let entry = entry.map_err(|source| Error::Io {
                path: dir.clone(),
                source,
            })?;
            let kind = entry.file_type().map_err(|source| Error::Io {
                path: entry.path(),
                source,
            })?;
            let child = rel.join(entry.file_name());
            if kind.is_dir() {
                pending.push(child);
            } else if kind.is_file() {
                found.push(child);
            }
        }
    }
    found.sort();
    Ok(found)
}

/// Removes the empty directories under `dir`, and `dir` when it ends empty.
fn prune_empty(dir: &Path) -> Result<bool, Error> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(source) => {
            return Err(Error::Io {
                path: dir.to_owned(),
                source,
            });
        }
    };
    let mut empty = true;
    for entry in entries {
        let entry = entry.map_err(|source| Error::Io {
            path: dir.to_owned(),
            source,
        })?;
        let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
        if !(is_dir && prune_empty(&entry.path())?) {
            empty = false;
        }
    }
    if empty {
        fs::remove_dir(dir).map_err(|source| Error::Io {
            path: dir.to_owned(),
            source,
        })?;
    }
    Ok(empty)
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::os::unix::fs::PermissionsExt as _;

    /// R18 §11.3's three fake secrets, in the shapes that test used.
    const GHP: &str = "ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6";
    const API_TOKEN: &str = "Zq7Xw2Lp9Rt4Vb8Nm3Kc";
    const DB_PASSWORD: &str = "Hunter2Correct9xQ";

    /// Reports every fixture secret the text holds, as gitleaks does with the
    /// config above.
    struct Fake {
        calls: Cell<usize>,
        fail: bool,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                calls: Cell::new(0),
                fail: false,
            }
        }
    }

    impl Scan for Fake {
        fn secrets(&self, text: &str) -> Result<Vec<String>, ScanError> {
            self.calls.set(self.calls.get() + 1);
            if self.fail {
                return Err(ScanError::Failed("exit status: 1".into()));
            }
            Ok([GHP, API_TOKEN, DB_PASSWORD]
                .into_iter()
                .filter(|s| text.contains(s))
                .map(str::to_owned)
                .collect())
        }
    }

    struct Missing;
    impl Scan for Missing {
        fn secrets(&self, _: &str) -> Result<Vec<String>, ScanError> {
            Err(ScanError::Missing)
        }
    }

    fn temp() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "yantra-history-{}-{stamp}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn line(text: &str) -> String {
        serde_json::json!({"type": "user", "message": {"content": text}}).to_string() + "\n"
    }

    fn secret_line() -> String {
        line(&format!(
            "PINEAPPLE {GHP} API_TOKEN={API_TOKEN}\nDATABASE_PASSWORD={DB_PASSWORD}"
        ))
    }

    /// The Yantra rule, read from the config this binary embeds, matches the
    /// two R18 fixtures gitleaks' own rules missed or barely caught, and its
    /// secret group is the value alone.
    #[test]
    fn the_embedded_rule_catches_the_r18_fixtures() {
        let config: toml::Table = toml::from_str(GITLEAKS_CONFIG).unwrap();
        let rule = &config["rules"].as_array().unwrap()[0];
        let pattern = rule["regex"].as_str().unwrap();
        let group = usize::try_from(rule["secretGroup"].as_integer().unwrap()).unwrap();
        assert!(
            rule.get("entropy").is_none(),
            "an entropy gate is R18's miss"
        );
        assert!(config["extend"]["useDefault"].as_bool().unwrap());

        let re = regex::Regex::new(pattern).unwrap();
        for (text, secret) in [
            (format!("GITHUB_TOKEN={GHP}"), GHP),
            (format!("API_TOKEN={API_TOKEN}"), API_TOKEN),
            (format!("DATABASE_PASSWORD={DB_PASSWORD}"), DB_PASSWORD),
            // As a JSON line spells it: the escaped newline ends the value.
            (
                format!(r#""DATABASE_PASSWORD={DB_PASSWORD}\nnext""#),
                DB_PASSWORD,
            ),
            (format!("db_password: '{DB_PASSWORD}'"), DB_PASSWORD),
            // A quoted `.env` line, as a JSON line escapes it.
            (
                format!(r#""DATABASE_PASSWORD=\"{DB_PASSWORD}\"""#),
                DB_PASSWORD,
            ),
        ] {
            let found = re.captures(&text).and_then(|c| c.get(group));
            assert_eq!(found.map(|m| m.as_str()), Some(secret), "in {text}");
        }
        assert!(re.captures("PASSWORD=short").is_none());
    }

    #[test]
    fn redaction_keeps_every_json_line_valid() {
        let text = secret_line() + &line("plain");
        let (clean, count) = redact(
            &text,
            &[GHP.into(), API_TOKEN.into(), DB_PASSWORD.into(), GHP.into()],
        )
        .unwrap();
        assert_eq!(count, 3);
        for secret in [GHP, API_TOKEN, DB_PASSWORD] {
            assert!(!clean.contains(secret));
        }
        assert!(clean.contains("PINEAPPLE"));
        assert!(clean.contains(REDACTED));
        assert!(clean.lines().all(is_json));
    }

    #[test]
    fn a_secret_inside_another_is_not_left_behind() {
        let (clean, _) = redact("ab abcdef", &["ab".into(), "abcdef".into()]).unwrap();
        assert_eq!(clean, format!("{REDACTED} {REDACTED}"));
    }

    #[test]
    fn a_line_the_redaction_would_break_refuses_the_file() {
        let text = line("x") + r#"{"a":"b","c":1}"#;
        let refused = redact(&text, &[r#"","c"#.into()]);
        assert!(matches!(refused, Err(Refusal::BrokeJson(2))), "{refused:?}");
    }

    #[test]
    fn a_secret_not_in_the_file_as_written_refuses_it() {
        assert!(matches!(
            redact("nothing here", &["decoded-from-base64".into()]),
            Err(Refusal::Unfound)
        ));
    }

    #[test]
    fn each_harness_maps_to_its_own_staging_folder() {
        let home = temp();
        let data = temp();
        let cases = [
            (".claude/projects/-w-app/1.jsonl", "claude/-w-app/1.jsonl"),
            (
                ".claude/projects/-w-app/1/subagents/a.jsonl",
                "claude/-w-app/1/subagents/a.jsonl",
            ),
            (
                ".codex/sessions/2026/10/06/rollout-1.jsonl",
                "codex/2026/10/06/rollout-1.jsonl",
            ),
            (".gemini/tmp/abc/chats/s.jsonl", "gemini/abc/chats/s.jsonl"),
            (".grok/sessions/s.json", "grok/s.json"),
            (".grok/sessions/x/s.jsonl", "grok/x/s.jsonl"),
        ];
        for (live, _) in cases {
            put(&home.join(live), &line("hi"));
        }
        // Not transcripts: Gemini's other files, and anything not JSON lines.
        put(&home.join(".gemini/tmp/abc/logs.jsonl"), &line("no"));
        put(&home.join(".claude/projects/-w-app/notes.md"), "no");

        let report = stage_in(&home, &data, &Fake::new()).unwrap();
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        let mut written: Vec<_> = report
            .written
            .iter()
            .map(|p| p.strip_prefix(data.join("history")).unwrap().to_owned())
            .collect();
        written.sort();
        let mut expected: Vec<_> = cases.iter().map(|(_, s)| PathBuf::from(s)).collect();
        expected.sort();
        assert_eq!(written, expected);
    }

    #[test]
    fn a_pass_stages_redacted_and_leaves_the_live_file_alone() {
        let home = temp();
        let data = temp();
        let live = home.join(".claude/projects/-w/s.jsonl");
        let text = secret_line();
        put(&live, &text);

        let report = stage_in(&home, &data, &Fake::new()).unwrap();
        assert_eq!(report.redactions, 3);
        let staged = data.join("history/claude/-w/s.jsonl");
        let clean = fs::read_to_string(&staged).unwrap();
        assert!(!clean.contains(GHP) && !clean.contains(DB_PASSWORD));
        assert_eq!(fs::read_to_string(&live).unwrap(), text);
        let mode = fs::metadata(&staged).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the staged copy is {mode:o}");
        assert_eq!(
            fs::metadata(&staged).unwrap().modified().unwrap(),
            fs::metadata(&live).unwrap().modified().unwrap()
        );
        assert_eq!(fs::read_dir(data.join("history.tmp")).unwrap().count(), 0);
    }

    #[test]
    fn a_file_is_staged_again_only_when_it_changes() {
        let home = temp();
        let data = temp();
        let live = home.join(".codex/sessions/s.jsonl");
        put(&live, &secret_line());
        let fake = Fake::new();

        stage_in(&home, &data, &fake).unwrap();
        let again = stage_in(&home, &data, &fake).unwrap();
        assert_eq!((again.written.len(), again.unchanged), (0, 1));
        assert_eq!(fake.calls.get(), 1);

        let later =
            fs::metadata(&live).unwrap().modified().unwrap() + std::time::Duration::from_secs(5);
        let mut file = fs::File::options().append(true).open(&live).unwrap();
        file.write_all(line("more").as_bytes()).unwrap();
        file.set_modified(later).unwrap();
        drop(file);
        let changed = stage_in(&home, &data, &fake).unwrap();
        assert_eq!(changed.written.len(), 1);
        assert!(
            fs::read_to_string(data.join("history/codex/s.jsonl"))
                .unwrap()
                .contains("more")
        );
    }

    #[test]
    fn a_staging_file_goes_when_its_live_file_goes() {
        let home = temp();
        let data = temp();
        let live = home.join(".codex/sessions/2026/10/s.jsonl");
        put(&live, &line("hi"));
        put(&home.join(".codex/sessions/keep.jsonl"), &line("hi"));
        stage_in(&home, &data, &Fake::new()).unwrap();

        fs::remove_file(&live).unwrap();
        let report = stage_in(&home, &data, &Fake::new()).unwrap();
        assert_eq!(
            report.removed,
            vec![data.join("history/codex/2026/10/s.jsonl")]
        );
        assert!(!data.join("history/codex/2026").exists());
        assert!(data.join("history/codex/keep.jsonl").exists());
    }

    #[test]
    fn a_failed_scan_stages_nothing_for_that_file() {
        let home = temp();
        let data = temp();
        put(&home.join(".claude/projects/-w/s.jsonl"), &secret_line());
        let fake = Fake {
            calls: Cell::new(0),
            fail: true,
        };

        let report = stage_in(&home, &data, &fake).unwrap();
        assert!(report.written.is_empty());
        assert!(matches!(
            report.failed.as_slice(),
            [Failure {
                reason: Refusal::Scan(_),
                ..
            }]
        ));
        assert!(!data.join("history/claude/-w/s.jsonl").exists());
    }

    #[test]
    fn no_gitleaks_stops_the_pass_and_stages_nothing() {
        let home = temp();
        let data = temp();
        put(&home.join(".claude/projects/-w/s.jsonl"), &secret_line());

        assert!(matches!(
            stage_in(&home, &data, &Missing),
            Err(Error::NoGitleaks)
        ));
        assert!(files(&data.join("history")).unwrap().is_empty());
    }

    #[test]
    fn a_gitleaks_report_reads_as_its_secrets() {
        let report = br#"[{"RuleID":"github-pat","Secret":"ghp_x","Match":"m","File":""}]"#;
        assert_eq!(parse_report(report).unwrap(), vec!["ghp_x".to_owned()]);
        assert_eq!(parse_report(b"[]").unwrap(), Vec::<String>::new());
        assert!(matches!(parse_report(b"FTL"), Err(ScanError::Failed(_))));
    }

    #[test]
    fn gitleaks_reads_the_yantra_rule_from_the_jobs_own_file() {
        let scratch = temp();
        let scanner = Gitleaks::new(scratch.clone()).unwrap();
        let command = scanner.command();
        let args: Vec<&std::ffi::OsStr> = command.get_args().collect();
        let at = args.iter().position(|a| *a == "--config").unwrap();
        let file = scratch.join("gitleaks.toml");
        assert_eq!(args[at + 1], file.as_os_str());

        let written: toml::Table = toml::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        let embedded: toml::Table = toml::from_str(GITLEAKS_CONFIG).unwrap();
        assert_eq!(written, embedded);
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn gitleaks_gets_no_config_variable() {
        let scanner = Gitleaks::new(temp()).unwrap();
        let command = scanner.command();
        let set: Vec<_> = command
            .get_envs()
            .filter(|(k, _)| k.to_string_lossy().starts_with("GITLEAKS_CONFIG"))
            .collect();
        assert!(set.is_empty(), "{set:?}");
    }
}
