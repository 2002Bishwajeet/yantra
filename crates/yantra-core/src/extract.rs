//! Candidate rows for the session-state decision, cut from a redacted history
//! folder ([plan] §2.1, §3.1, Y-463).
//!
//! It reads Claude Code transcripts under `<folder>/claude/`, the layout of
//! both the staging copy and the archive. A turn starts at an owner message
//! and ends at the last assistant response before the next one, or at a
//! response that calls `AskUserQuestion`. Each row is re-scanned with gitleaks
//! (§3.3 item 1), and a row with a finding is dropped. The rows hold
//! conversation text, so none of it reaches an error (Q5).
//!
//! [plan]: ../../../docs/plans/decision-model.md

use std::fs;
use std::io::{self, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::history::{self, Scan, ScanError};

/// The question every row, the eval and the integration ask (§4.1).
pub const QUESTIONS: &str = r#"{"turn_state":{"type":"choice","instructions":"The agent's turn has ended. What must the owner do now?","criteria":{"done":"Nothing: the agent finished and reports the result","needs_input":"Answer: the agent asks a question or waits for a choice","blocked":"Fix something: the agent cannot go on without access, a tool or a fix"}}}"#;

/// The base model reads 512 tokens (§5.3), about four characters each. The
/// owner's request is at its head and the agent's ask is at its tail.
pub const OWNER_CHARS: usize = 600;
pub const AGENT_CHARS: usize = 1400;

/// The weak label's bounds (§2.1 item 2).
const ANSWER_CHARS: usize = 200;
const ANSWER_WITHIN: time::Duration = time::Duration::minutes(30);

/// Stop reasons a rule already maps to `blocked`, so the model never sees them.
const BLOCKED: [&str; 2] = ["max_tokens", "model_context_window_exceeded"];

/// What one run wrote, and what it left out.
#[derive(Debug, Default)]
pub struct Report {
    pub ask_user_question: usize,
    pub judge: usize,
    pub skipped_blocked: usize,
    /// The transcript of each row gitleaks found a secret in.
    pub dropped_by_gitleaks: Vec<PathBuf>,
    pub unparsed_lines: usize,
    pub unreadable: Vec<(PathBuf, io::Error)>,
}

impl Report {
    /// The rows written.
    pub fn rows(&self) -> usize {
        self.ask_user_question + self.judge
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("`gitleaks` is not on PATH, so no row can be re-checked and nothing was written")]
    NoGitleaks,

    #[error("gitleaks failed, so no row can be shown clean and nothing was written: {0}")]
    Scan(String),

    #[error(transparent)]
    Setup(#[from] history::Error),

    #[error("could not read or write {}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// Writes `rows.jsonl`, `rows.meta.jsonl` and `questions.json` to `out`, with
/// the real gitleaks.
pub fn extract(folder: &Path, out: &Path) -> Result<Report, Error> {
    extract_in(folder, out, &history::gitleaks()?)
}

/// The testable half.
pub fn extract_in<S: Scan>(folder: &Path, out: &Path, scanner: &S) -> Result<Report, Error> {
    // Asked first, so a missing gitleaks fails even a folder with no rows.
    if let Err(ScanError::Missing) = scanner.rules() {
        return Err(Error::NoGitleaks);
    }
    fs::read_dir(folder).map_err(|source| Error::Io {
        path: folder.to_owned(),
        source,
    })?;
    let mut report = Report::default();
    let (mut rows, mut metas) = (String::new(), String::new());
    for path in transcripts(&folder.join("claude"), &mut report) {
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) => {
                report.unreadable.push((path, e));
                continue;
            }
        };
        let stem = path.file_stem().unwrap_or_default().to_string_lossy();
        let candidates = turns(&text, &stem, &mut report);
        if candidates.is_empty() {
            continue;
        }
        let joined: Vec<&str> = candidates.iter().map(|c| c.row.as_str()).collect();
        let secrets = scanner.secrets(&joined.join("\n")).map_err(|e| match e {
            ScanError::Missing => Error::NoGitleaks,
            ScanError::Failed(why) => Error::Scan(why),
        })?;
        // The Yantra rule matches `API_TOKEN=[REDACTED]`: that is the staging
        // copy's own marker, not a secret.
        let secrets: Vec<&String> = secrets
            .iter()
            .filter(|s| !s.is_empty() && *s != history::REDACTED)
            .collect();
        for candidate in candidates {
            if secrets.iter().any(|s| candidate.row.contains(s.as_str())) {
                report.dropped_by_gitleaks.push(path.clone());
                continue;
            }
            match candidate.source {
                Source::AskUserQuestion => report.ask_user_question += 1,
                Source::Judge => report.judge += 1,
            }
            rows.push_str(&candidate.row);
            rows.push('\n');
            metas.push_str(&candidate.meta);
            metas.push('\n');
        }
    }
    write_out(out, &rows, &metas)?;
    Ok(report)
}

fn write_out(out: &Path, rows: &str, metas: &str) -> Result<(), Error> {
    let io = |path: &Path| {
        let path = path.to_owned();
        move |source| Error::Io { path, source }
    };
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(out)
        .and_then(|()| fs::set_permissions(out, fs::Permissions::from_mode(0o700)))
        .map_err(io(out))?;
    for (name, text) in [
        ("rows.jsonl", rows),
        ("rows.meta.jsonl", metas),
        ("questions.json", QUESTIONS),
    ] {
        let path = out.join(name);
        write_atomic(&path, &out.join(format!(".{name}.tmp")), text).map_err(io(&path))?;
    }
    Ok(())
}

/// Through a temp file and a rename, so a failed run never leaves half a file.
fn write_atomic(path: &Path, temp: &Path, text: &str) -> io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(temp)?;
    file.write_all(text.as_bytes())?;
    drop(file);
    fs::rename(temp, path)
}

/// Every main-session transcript under `root`. A subagent's own transcript is
/// left out, because the plan counts main sessions only.
fn transcripts(root: &Path, report: &mut Report) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_owned()];
    while let Some(dir) = pending.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => {
                report.unreadable.push((dir, e));
                continue;
            }
        };
        for entry in entries {
            let (path, kind) = match entry.and_then(|e| Ok((e.path(), e.file_type()?))) {
                Ok(named) => named,
                Err(e) => {
                    report.unreadable.push((dir.clone(), e));
                    continue;
                }
            };
            if kind.is_dir() && !path.ends_with("subagents") {
                pending.push(path);
            } else if kind.is_file() && path.extension().is_some_and(|x| x == "jsonl") {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}

/// Only the fields this reads (I-46): the rest of a record is not named.
#[derive(Deserialize)]
struct Record {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default, rename = "isSidechain")]
    sidechain: bool,
    #[serde(default, rename = "isMeta")]
    meta: bool,
    #[serde(rename = "toolUseResult")]
    tool_use_result: Option<IgnoredAny>,
    #[serde(rename = "sessionId")]
    session: Option<String>,
    cwd: Option<String>,
    timestamp: Option<String>,
    message: Option<Message>,
}

#[derive(Deserialize)]
struct Message {
    id: Option<String>,
    #[serde(default)]
    content: Content,
    stop_reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Content {
    Text(String),
    Blocks(Vec<Block>),
}

impl Default for Content {
    fn default() -> Self {
        Self::Blocks(Vec::new())
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Block {
    Text {
        text: String,
    },
    ToolUse {
        name: String,
        #[serde(default)]
        input: Value,
    },
    ToolResult {},
    #[serde(other)]
    Other,
}

struct Owner {
    text: String,
    ts: Option<String>,
    session: String,
    repo: String,
}

/// One API response, whose records I-61 says may be several.
#[derive(Default)]
struct Response {
    id: Option<String>,
    text: Vec<String>,
    questions: Vec<String>,
    asks: bool,
    stop: Option<String>,
    ts: Option<String>,
}

#[derive(Clone, Copy)]
enum Source {
    AskUserQuestion,
    Judge,
}

struct Candidate {
    row: String,
    meta: String,
    source: Source,
}

/// A row before its weak label, which waits on the next owner message.
struct Pending {
    state: Value,
    source: Source,
    session: String,
    repo: String,
    end: Option<String>,
}

fn turns(text: &str, stem: &str, report: &mut Report) -> Vec<Candidate> {
    let mut out = Vec::new();
    let mut owner: Option<Owner> = None;
    let mut responses: Vec<Response> = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(record) = serde_json::from_str::<Record>(line) else {
            report.unparsed_lines += 1;
            continue;
        };
        if record.sidechain {
            continue;
        }
        match record.kind.as_str() {
            "user" => {
                let Some(text) = owner_text(&record) else {
                    continue;
                };
                let next = Owner {
                    text,
                    session: record.session.unwrap_or_else(|| stem.to_owned()),
                    repo: record
                        .cwd
                        .as_deref()
                        .map(crate::logs::slug)
                        .unwrap_or_default(),
                    ts: record.timestamp,
                };
                let ended = close(owner.take(), &mut responses, report);
                label(ended, Some(&next), &mut out);
                owner = Some(next);
            }
            "assistant" if owner.is_some() => {
                if let Some(message) = record.message {
                    add(&mut responses, message, record.timestamp);
                }
            }
            _ => {}
        }
    }
    let ended = close(owner, &mut responses, report);
    label(ended, None, &mut out);
    out
}

/// A `user` record holding a tool result is the agent's input, not the owner's.
fn owner_text(record: &Record) -> Option<String> {
    if record.meta || record.tool_use_result.is_some() {
        return None;
    }
    let text = match &record.message.as_ref()?.content {
        Content::Text(text) => text.clone(),
        Content::Blocks(blocks) => {
            if blocks.iter().any(|b| matches!(b, Block::ToolResult {})) {
                return None;
            }
            texts(blocks)
        }
    };
    (!text.trim().is_empty()).then_some(text)
}

fn texts(blocks: &[Block]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            Block::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Merges a record into the response with its `message.id` (I-61).
fn add(responses: &mut Vec<Response>, message: Message, ts: Option<String>) {
    let at = message
        .id
        .as_deref()
        .and_then(|id| responses.iter().rposition(|r| r.id.as_deref() == Some(id)));
    let index = at.unwrap_or_else(|| {
        responses.push(Response {
            id: message.id.clone(),
            ..Response::default()
        });
        responses.len() - 1
    });
    let response = &mut responses[index];
    let blocks = match message.content {
        Content::Text(text) => vec![Block::Text { text }],
        Content::Blocks(blocks) => blocks,
    };
    for block in blocks {
        match block {
            Block::Text { text } => response.text.push(text),
            Block::ToolUse { name, input } if name == "AskUserQuestion" => {
                response.asks = true;
                let asked = input["questions"].as_array().into_iter().flatten();
                response
                    .questions
                    .extend(asked.filter_map(|q| q["question"].as_str().map(str::to_owned)));
            }
            _ => {}
        }
    }
    if message.stop_reason.is_some() {
        response.stop = message.stop_reason;
    }
    if ts.is_some() {
        response.ts = ts;
    }
}

/// The rows one owner message's turn gives: one per `AskUserQuestion`, and
/// one for the last response after them.
fn close(owner: Option<Owner>, responses: &mut Vec<Response>, report: &mut Report) -> Vec<Pending> {
    let mut ended = Vec::new();
    let Some(owner) = owner else {
        responses.clear();
        return ended;
    };
    let mut last = None;
    for response in responses.drain(..) {
        if response.asks {
            last = None;
            ended.extend(pending(&owner, response, Source::AskUserQuestion));
        } else {
            last = Some(response);
        }
    }
    if let Some(response) = last {
        if response
            .stop
            .as_deref()
            .is_some_and(|stop| BLOCKED.contains(&stop))
        {
            report.skipped_blocked += 1;
        } else {
            ended.extend(pending(&owner, response, Source::Judge));
        }
    }
    ended
}

fn pending(owner: &Owner, response: Response, source: Source) -> Option<Pending> {
    let agent = response
        .text
        .into_iter()
        .chain(response.questions)
        .collect::<Vec<_>>()
        .join("\n");
    if agent.trim().is_empty() {
        return None;
    }
    Some(Pending {
        state: json!({
            "owner": head(&owner.text, OWNER_CHARS),
            "agent": tail(&agent, AGENT_CHARS),
        }),
        source,
        session: owner.session.clone(),
        repo: owner.repo.clone(),
        end: response.ts,
    })
}

fn label(ended: Vec<Pending>, next: Option<&Owner>, out: &mut Vec<Candidate>) {
    for p in ended {
        let (expected, source) = match p.source {
            Source::AskUserQuestion => (
                r#","expected":{"turn_state":"needs_input"}"#,
                "ask_user_question",
            ),
            Source::Judge => ("", "judge"),
        };
        let row = format!(
            r#"{{"state":{},"questions":{QUESTIONS}{expected}}}"#,
            p.state
        );
        let meta = json!({
            "session": p.session,
            "repo": p.repo,
            "ts": p.end,
            "source": source,
            "next_message": next_message(p.end.as_deref(), next),
        });
        out.push(Candidate {
            row,
            meta: meta.to_string(),
            source: p.source,
        });
    }
}

/// The weak label (§2.1 item 2).
fn next_message(end: Option<&str>, next: Option<&Owner>) -> &'static str {
    let Some(next) = next else {
        return "none";
    };
    let text = next.text.trim();
    if text == "/clear" || text.contains("<command-name>/clear</command-name>") {
        return "new_task";
    }
    let at = |ts: Option<&str>| ts.and_then(|ts| OffsetDateTime::parse(ts, &Rfc3339).ok());
    let quick = match (at(end), at(next.ts.as_deref())) {
        (Some(end), Some(next)) => next - end <= ANSWER_WITHIN,
        _ => false,
    };
    if quick && text.chars().count() < ANSWER_CHARS {
        "answer"
    } else {
        "new_task"
    }
}

fn head(text: &str, max: usize) -> &str {
    text.char_indices()
        .nth(max)
        .map_or(text, |(i, _)| &text[..i])
}

fn tail(text: &str, max: usize) -> &str {
    text.char_indices()
        .rev()
        .nth(max.saturating_sub(1))
        .map_or(text, |(i, _)| &text[i..])
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    const GHP: &str = "ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6";
    const T0: &str = "2026-10-08T09:00:00Z";

    #[derive(Default)]
    struct Fake {
        missing: bool,
        fail: bool,
    }

    impl Scan for Fake {
        fn secrets(&self, text: &str) -> Result<Vec<String>, ScanError> {
            match (self.missing, self.fail) {
                (true, _) => Err(ScanError::Missing),
                (_, true) => Err(ScanError::Failed("exit status: 1".into())),
                // As the real rule does, it also reports the marker after a name.
                _ => Ok([GHP, history::REDACTED]
                    .into_iter()
                    .filter(|s| text.contains(s))
                    .map(str::to_owned)
                    .collect()),
            }
        }

        fn rules(&self) -> Result<String, ScanError> {
            if self.missing {
                Err(ScanError::Missing)
            } else {
                Ok("v1".into())
            }
        }
    }

    fn temp() -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "yantra-extract-{}-{stamp}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `T0` plus `minutes`.
    fn at(minutes: i64) -> String {
        (OffsetDateTime::parse(T0, &Rfc3339).unwrap() + time::Duration::minutes(minutes))
            .format(&Rfc3339)
            .unwrap()
    }

    fn user(text: &str, minutes: i64) -> Value {
        json!({"type": "user", "sessionId": "s1", "cwd": "/home/o/app", "timestamp": at(minutes),
               "message": {"role": "user", "content": text}})
    }

    fn assistant(id: &str, blocks: Value, stop: &str, minutes: i64) -> Value {
        json!({"type": "assistant", "sessionId": "s1", "timestamp": at(minutes),
               "message": {"id": id, "role": "assistant", "content": blocks, "stop_reason": stop}})
    }

    fn say(id: &str, text: &str, minutes: i64) -> Value {
        assistant(
            id,
            json!([{"type": "text", "text": text}]),
            "end_turn",
            minutes,
        )
    }

    /// One response written as two records, as Claude Code writes it (I-61).
    fn ask(id: &str, text: &str, question: &str, minutes: i64) -> [Value; 2] {
        [
            assistant(
                id,
                json!([{"type": "text", "text": text}]),
                "tool_use",
                minutes,
            ),
            assistant(
                id,
                json!([{"type": "tool_use", "id": "t1", "name": "AskUserQuestion",
                        "input": {"questions": [{"question": question, "header": "h",
                                                 "options": [{"label": "a"}, {"label": "b"}]}]}}]),
                "tool_use",
                minutes,
            ),
        ]
    }

    fn tool_result(minutes: i64) -> Value {
        json!({"type": "user", "timestamp": at(minutes), "toolUseResult": {"answers": {}},
               "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "a"}]}})
    }

    fn write(folder: &Path, rel: &str, records: &[Value]) {
        let path = folder.join("claude").join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text: String = records.iter().map(|r| format!("{r}\n")).collect();
        fs::write(path, text).unwrap();
    }

    fn run(records: &[Value]) -> (Report, Vec<Value>, Vec<Value>) {
        let folder = temp();
        write(&folder, "-home-o-app/s1.jsonl", records);
        let out = temp().join("rows");
        let report = extract_in(&folder, &out, &Fake::default()).unwrap();
        (
            report,
            read(&out.join("rows.jsonl")),
            read(&out.join("rows.meta.jsonl")),
        )
    }

    fn read(path: &Path) -> Vec<Value> {
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn an_ask_user_question_is_needs_input() {
        let [text, tool] = ask(
            "m1",
            "Renamed it in 4 files.",
            "Update the fixtures too?",
            1,
        );
        let (report, rows, metas) = run(&[user("Rename the flag.", 0), text, tool]);
        assert_eq!((report.rows(), report.ask_user_question), (1, 1));
        assert_eq!(rows[0]["expected"], json!({"turn_state": "needs_input"}));
        assert_eq!(
            rows[0]["state"]["agent"],
            "Renamed it in 4 files.\nUpdate the fixtures too?"
        );
        assert_eq!(metas[0]["source"], "ask_user_question");
        assert_eq!(metas[0]["next_message"], "none");
    }

    #[test]
    fn the_work_after_an_answered_question_is_its_own_row() {
        let [text, tool] = ask("m1", "One question.", "Which?", 1);
        let (report, rows, metas) = run(&[
            user("Do it.", 0),
            text,
            tool,
            tool_result(2),
            say("m2", "Done.", 3),
        ]);
        assert_eq!((report.ask_user_question, report.judge), (1, 1));
        assert_eq!(
            rows[1]["state"],
            json!({"owner": "Do it.", "agent": "Done."})
        );
        assert!(rows[1].get("expected").is_none());
        assert_eq!(metas[1]["source"], "judge");
    }

    #[test]
    fn a_quick_short_reply_is_an_answer() {
        let (report, rows, metas) = run(&[
            user("Fix the test.", 0),
            say("m1", "Fixed. Should I push?", 1),
            user("yes", 5),
            say("m2", "Pushed.", 6),
        ]);
        assert_eq!((report.rows(), report.judge), (2, 2));
        assert!(rows[0].get("expected").is_none());
        assert_eq!(metas[0]["source"], "judge");
        assert_eq!(metas[0]["next_message"], "answer");
        assert_eq!(metas[0]["ts"], at(1));
        assert_eq!(metas[0]["session"], "s1");
        assert_eq!(metas[0]["repo"], "-home-o-app");
    }

    #[test]
    fn a_clear_a_long_reply_or_a_late_reply_is_a_new_task() {
        let clear = "<command-name>/clear</command-name>\n<command-message>clear</command-message>";
        let (_, _, metas) = run(&[
            user("One.", 0),
            say("m1", "Done one.", 1),
            user(clear, 2),
            say("m2", "Cleared.", 3),
            user(&"Now a long new request. ".repeat(10), 4),
            say("m3", "Done two.", 5),
            user("ok", 100),
            say("m4", "Done three.", 101),
        ]);
        let labels: Vec<_> = metas.iter().map(|m| m["next_message"].clone()).collect();
        assert_eq!(labels, ["new_task", "new_task", "new_task", "none"]);
    }

    #[test]
    fn the_end_of_the_file_is_no_next_message() {
        let (_, _, metas) = run(&[user("Go.", 0), say("m1", "Gone.", 1)]);
        assert_eq!(metas[0]["source"], "judge");
        assert_eq!(metas[0]["next_message"], "none");
    }

    #[test]
    fn a_max_tokens_turn_is_left_to_the_rule() {
        let (report, rows, _) = run(&[
            user("Write a lot.", 0),
            assistant(
                "m1",
                json!([{"type": "text", "text": "…"}]),
                "max_tokens",
                1,
            ),
            user("Go on.", 2),
            assistant(
                "m2",
                json!([{"type": "text", "text": "…"}]),
                "model_context_window_exceeded",
                3,
            ),
        ]);
        assert_eq!((report.rows(), report.skipped_blocked), (0, 2));
        assert!(rows.is_empty());
    }

    #[test]
    fn tool_results_sidechains_and_subagents_start_no_turn() {
        let mut sidechain = user("A subagent's prompt.", 2);
        sidechain["isSidechain"] = json!(true);
        let mut meta = user("Caveat: generated by a command.", 2);
        meta["isMeta"] = json!(true);
        let folder = temp();
        write(
            &folder,
            "-home-o-app/s1.jsonl",
            &[
                user("Run it.", 0),
                assistant(
                    "m1",
                    json!([{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]),
                    "tool_use",
                    1,
                ),
                tool_result(2),
                sidechain,
                meta,
                say("m2", "It ran.", 3),
            ],
        );
        write(
            &folder,
            "-home-o-app/s1/subagents/a.jsonl",
            &[user("Sub.", 0), say("x", "Sub done.", 1)],
        );
        let out = temp().join("rows");
        let report = extract_in(&folder, &out, &Fake::default()).unwrap();
        assert_eq!(report.rows(), 1);
        let rows = read(&out.join("rows.jsonl"));
        assert_eq!(
            rows[0]["state"],
            json!({"owner": "Run it.", "agent": "It ran."})
        );
    }

    #[test]
    fn a_split_response_is_one_message() {
        let (report, rows, _) = run(&[
            user("Explain.", 0),
            assistant(
                "m1",
                json!([{"type": "text", "text": "First."}]),
                "end_turn",
                1,
            ),
            assistant(
                "m1",
                json!([{"type": "text", "text": "Second."}]),
                "end_turn",
                1,
            ),
        ]);
        assert_eq!(report.rows(), 1);
        assert_eq!(rows[0]["state"]["agent"], "First.\nSecond.");
    }

    #[test]
    fn the_owner_keeps_the_head_and_the_agent_keeps_the_tail() {
        let owner = format!("ask{}", "é".repeat(OWNER_CHARS));
        let agent = format!("{}end?", "ü".repeat(AGENT_CHARS));
        let (_, rows, _) = run(&[user(&owner, 0), say("m1", &agent, 1)]);
        let kept_owner = rows[0]["state"]["owner"].as_str().unwrap();
        let kept_agent = rows[0]["state"]["agent"].as_str().unwrap();
        assert_eq!(kept_owner.chars().count(), OWNER_CHARS);
        assert!(kept_owner.starts_with("ask"));
        assert_eq!(kept_agent.chars().count(), AGENT_CHARS);
        assert!(kept_agent.ends_with("end?"));
        assert_eq!(head("ab", 5), "ab");
        assert_eq!(tail("ab", 5), "ab");
    }

    #[test]
    fn a_row_with_a_secret_is_dropped_and_counted() {
        let (report, rows, metas) = run(&[
            user(&format!("use {GHP}"), 0),
            say("m1", "Done.", 1),
            user("Next with API_TOKEN=[REDACTED].", 2),
            say("m2", "Done too.", 3),
        ]);
        assert_eq!(report.rows(), 1);
        assert_eq!(report.dropped_by_gitleaks.len(), 1);
        assert_eq!(rows[0]["state"]["owner"], "Next with API_TOKEN=[REDACTED].");
        assert_eq!(metas.len(), 1);
    }

    #[test]
    fn no_gitleaks_writes_nothing() {
        let folder = temp();
        write(
            &folder,
            "-w/s.jsonl",
            &[user("Go.", 0), say("m1", "Gone.", 1)],
        );
        let out = temp().join("rows");
        let missing = Fake {
            missing: true,
            ..Fake::default()
        };
        assert!(matches!(
            extract_in(&folder, &out, &missing),
            Err(Error::NoGitleaks)
        ));
        assert!(!out.exists());
    }

    #[test]
    fn a_failed_scan_writes_nothing() {
        let folder = temp();
        write(
            &folder,
            "-w/s.jsonl",
            &[user("Go.", 0), say("m1", "Gone.", 1)],
        );
        let out = temp().join("rows");
        let failing = Fake {
            fail: true,
            ..Fake::default()
        };
        assert!(matches!(
            extract_in(&folder, &out, &failing),
            Err(Error::Scan(_))
        ));
        assert!(!out.exists());
    }

    #[test]
    fn a_folder_that_is_not_there_is_an_error() {
        let gone = temp().join("nothing");
        assert!(matches!(
            extract_in(&gone, &temp().join("rows"), &Fake::default()),
            Err(Error::Io { path, .. }) if path == gone
        ));
    }

    #[test]
    fn a_bad_line_is_counted_and_a_bad_file_is_named() {
        let folder = temp();
        write(
            &folder,
            "-w/a.jsonl",
            &[user("Go.", 0), say("m1", "Gone.", 1)],
        );
        let path = folder.join("claude/-w/a.jsonl");
        let mut text = fs::read_to_string(&path).unwrap();
        text.push_str("{not json\n");
        fs::write(&path, text).unwrap();
        fs::write(folder.join("claude/-w/b.jsonl"), [0xff, 0xfe]).unwrap();

        let report = extract_in(&folder, &temp().join("rows"), &Fake::default()).unwrap();
        assert_eq!((report.rows(), report.unparsed_lines), (1, 1));
        assert!(matches!(
            report.unreadable.as_slice(),
            [(p, _)] if *p == folder.join("claude/-w/b.jsonl")
        ));
    }

    #[test]
    fn the_files_are_private_paired_and_in_the_plans_shape() {
        let folder = temp();
        let [text, tool] = ask("m1", "Renamed it.", "Update the fixtures too?", 1);
        write(
            &folder,
            "-w/s.jsonl",
            &[
                user("Rename the flag.", 0),
                text,
                tool,
                user("yes", 2),
                say("m2", "Updated.", 3),
            ],
        );
        let out = temp().join("rows");
        extract_in(&folder, &out, &Fake::default()).unwrap();

        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&out), 0o700);
        for name in ["rows.jsonl", "rows.meta.jsonl", "questions.json"] {
            assert_eq!(mode(&out.join(name)), 0o600, "{name}");
        }
        let rows = read(&out.join("rows.jsonl"));
        assert_eq!(rows.len(), read(&out.join("rows.meta.jsonl")).len());
        assert_eq!(
            fs::read_to_string(out.join("questions.json")).unwrap(),
            QUESTIONS
        );

        let questions: Value = serde_json::from_str(QUESTIONS).unwrap();
        assert_eq!(
            questions["turn_state"]["criteria"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["blocked", "done", "needs_input"]
        );
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys(&rows[0]), ["expected", "questions", "state"]);
        assert_eq!(keys(&rows[1]), ["questions", "state"]);
        for row in &rows {
            assert_eq!(row["questions"], questions);
            assert_eq!(keys(&row["state"]), ["agent", "owner"]);
        }
        let leftovers: Vec<_> = fs::read_dir(&out)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .filter(|n| n.to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }
}
