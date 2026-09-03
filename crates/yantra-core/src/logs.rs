//! Reading what the agent has been saying, from its transcript.
//!
//! [ADR-0011] made the transcript JSONL the log and ruled out `pipe-pane`: a
//! TUI's pane carries the raw redraw stream, which tells you the process is
//! alive and nothing about what it did.
//!
//! **The transcript is not a log either — it is an application journal**, and
//! that is what shapes this module. Measured on a real 14 MB file: 6,815
//! records across **13** `type`s, of which only `user` and `assistant` carry
//! anything a person wants to read. The rest is bookkeeping (`queue-operation`,
//! `file-history-snapshot`, `bridge-session`, `ai-title`, …). So the far side
//! selects before anything crosses the wire, and what arrives is projected down
//! to who spoke and what they said.
//!
//! [ADR-0011]: ../../../docs/adr/0011-claude-code-runs-as-a-tui-in-tmux.md

use crate::agent;
use crate::ssh::{self, Exec, Ssh};
use crate::tmux::{Tmux, sq};
use crate::workspace;

/// Exit status the probe uses for "there is no transcript here". Distinct from
/// a failure, because a workspace whose agent has never run is not an error.
pub(crate) const NO_TRANSCRIPT: i32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Who {
    User,
    Assistant,
}

/// One turn, reduced to what a reader wants.
///
/// `tools` names the tools an assistant turn invoked and what each acted on;
/// the *results* never arrive, because they are the bulk of the file and are
/// the agent's input rather than its output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub who: Who,
    /// The record's own ISO-8601 instant, absent on the few records that carry
    /// no timestamp.
    pub at: Option<String>,
    pub text: String,
    pub tools: Vec<Call>,
}

/// One tool call: the tool's name, and the one string it acted on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub name: String,
    /// [`TARGET_KEYS`]'s first match in the call's input, capped by [`CAP`].
    /// `None` for a tool whose input names none of them — `SendUserFile`, the
    /// one miss measured over 200 records, whose `files` is a list.
    pub target: Option<String>,
}

/// The keys a tool call's target is read from, in the order they are tried.
/// Measured: this finds a target for 126 of 127 calls (D5 §4.2).
const TARGET_KEYS: [&str; 8] = [
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "description",
    "prompt",
];

/// How much of a target survives. The median is 107 characters and the longest
/// measured is 3,383, so this keeps the typical one whole (D5 §4.2). A cut one
/// ends in [`CUT`] and the reader is not promised the rest.
const CAP: usize = 120;

/// What a cut target ends with. The whole command is in the terminal and in the
/// file, and this projection never claims to be either.
const CUT: char = '…';

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transcript {
    pub path: String,
    /// Both from the *remote* clock, so their difference is a real age rather
    /// than a measure of how far two machines' clocks have drifted apart.
    pub modified: i64,
    pub now: i64,
    /// Every record the far side would have selected, counted before the
    /// window cut it down. **Records, not turns** — the same unit `lines` and
    /// `before` are in, so a caller can say *the last 50 of 1,944 records* and
    /// never mix the two (D5 §4.4).
    pub total: usize,
    pub entries: Vec<Entry>,
}

impl Transcript {
    /// How long since anything was written. Q12's requirement in one number:
    /// a transcript that exists proves nothing, one that is still growing does.
    pub fn idle_for(&self) -> i64 {
        (self.now - self.modified).max(0)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Workspace(#[from] workspace::Error),

    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    /// I-49: a launch does not write one. Saying "has an agent ever run there?"
    /// pointed at the wrong thing for every agent that had only just started.
    #[error(
        "no agent transcript for `{repo}` on that machine — one appears on the agent's first message, not when it launches"
    )]
    NoTranscript { repo: String },

    /// The pane names a session and that session has written nothing yet.
    /// Reading the newest file instead would show a *different* conversation
    /// under this session's name, which is the guess this module stopped making.
    #[error(
        "the agent in `{repo}` has written no turn yet — its transcript appears on its first message, not when it launches (session {session})"
    )]
    NoTurnYet { repo: String, session: String },

    #[error("could not read the transcript directory: {stderr}")]
    Probe { stderr: String },

    #[error("the transcript probe answered in a shape this version does not understand")]
    Unreadable,

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

/// The last `lines` turns of the agent working in workspace `name`.
pub async fn logs(name: &str, lines: usize) -> Result<Transcript, Error> {
    let workspace = workspace::load(name)?;
    let machine = ssh::machine_at(&workspace.machine).ok_or(Error::NoStateDir)?;
    let ssh = Ssh::new(machine)?;
    let session = session_of(&ssh, &workspace.name).await;
    read(
        &ssh,
        &workspace.repo.to_string_lossy(),
        session.as_deref(),
        lines,
        0,
    )
    .await
}

/// The session id the workspace's pane was launched with, from the command tmux
/// holds (Y-091) — `None` for a shell session, an absent session, or a tmux
/// that could not be asked.
///
/// Two round trips, and neither failure is one `logs` reports: reading the
/// newest transcript worked before this existed and still answers without it.
pub async fn session_of<E: Exec>(exec: &E, name: &str) -> Option<String> {
    let tmux = Tmux::resolve(exec).await.ok()?;
    let started = tmux.pane(exec, name).await.ok()??.start_command?;
    agent::session_id_in(&started).map(str::to_owned)
}

/// The testable half, once a machine can be reached.
///
/// Naming `session` is what separates the conversation now running from
/// whichever one touched this repo last. Without one the newest transcript is
/// still the answer: an agent that has exited is gone from `claude agents
/// --json`, and "show me the last thing that happened here" is the question
/// `logs` is asked after a crash as much as during a run.
///
/// A named session with no file yet is [`Error::NoTurnYet`] and never a fall
/// back to the newest file — a launch writes no transcript (I-49), and the
/// state that produces this is an agent that has only just started.
///
/// `before` skips that many newer records, so `Older` is the next window back
/// rather than a re-read of a longer one. The far side counts from the end of
/// the file, and a running agent appends while a reader pages backwards — which
/// is what [`Transcript::total`] is for.
pub async fn read<E: Exec>(
    exec: &E,
    repo: &str,
    session: Option<&str>,
    lines: usize,
    before: usize,
) -> Result<Transcript, Error> {
    let out = exec.exec(&probe(repo, session, lines, before)).await?;
    if out.status == NO_TRANSCRIPT {
        return Err(match session {
            Some(session) => Error::NoTurnYet {
                repo: repo.to_owned(),
                session: session.to_owned(),
            },
            None => Error::NoTranscript {
                repo: repo.to_owned(),
            },
        });
    }
    if !out.success() {
        return Err(Error::Probe {
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        });
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let mut header = text.lines();
    let path = header.next().ok_or(Error::Unreadable)?.to_owned();
    let modified = header
        .next()
        .and_then(|n| n.trim().parse().ok())
        .ok_or(Error::Unreadable)?;
    let now = header
        .next()
        .and_then(|n| n.trim().parse().ok())
        .ok_or(Error::Unreadable)?;
    let total = header
        .next()
        .and_then(|n| n.trim().parse().ok())
        .ok_or(Error::Unreadable)?;

    Ok(Transcript {
        path,
        modified,
        now,
        total,
        entries: header.filter_map(entry).collect(),
    })
}

/// Everything the far side would show, before the window cuts it down.
///
/// The selection is `grep`, not `jq`: the fleet is not guaranteed to have `jq`,
/// and a byte-level filter over a 14 MB file costs nothing next to shipping it.
/// It over-matches slightly — `"type":"user"` also occurs inside message text —
/// and that is safe, because the parse on this side is what decides.
const SELECT: &str = "grep -E '\"type\":\"(user|assistant)\"' \"$f\" | grep -v '\"toolUseResult\"'";

/// Four header lines — the path, its mtime, the far side's clock and how many
/// records the selection found — then the window.
///
/// The window costs nothing and **the count is a second pass, which is not
/// free where `grep` is busybox's**: 17.8 MB in the Alpine fixture reads in
/// 277 ms either way and pays 245 ms more for the count. D5 §2.2 measured
/// 0.01 s for it on GNU grep, so that figure does not travel. Both still sit
/// under one ssh round trip to a real machine, which is why `Older` is another
/// read rather than a bigger first one.
///
/// The file is `<session id>.jsonl`, measured on both fleet machines and across
/// a `resume` fork, which is what makes naming one possible at all.
fn probe(repo: &str, session: Option<&str>, lines: usize, before: usize) -> String {
    format!(
        "{locate}\
         printf '%s\\n' \"$f\"\n\
         stat -c %Y \"$f\" 2>/dev/null || stat -f %m \"$f\"\n\
         date +%s\n\
         {SELECT} | grep -c ''\n\
         {SELECT} | tail -n {end} | head -n {lines}\n",
        locate = locate(repo, session),
        end = lines.saturating_add(before),
    )
}

/// The lines that put the session's transcript in `$f`, or exit
/// [`NO_TRANSCRIPT`]. [`crate::tokens`] asks a different question of the same
/// file and has to find it by the same rules.
pub(crate) fn locate(repo: &str, session: Option<&str>) -> String {
    // Quoted, unlike the slug: a workspace's own `startup` decides what follows
    // `--session-id`, and that file is a code-execution boundary.
    let find = match session {
        Some(id) => format!(
            "f=$d/{id}.jsonl\n\
             [ -f \"$f\" ] || exit {NO_TRANSCRIPT}\n",
            id = sq(id)
        ),
        None => format!(
            "f=$(ls -t \"$d\"/*.jsonl 2>/dev/null | head -n 1)\n\
             [ -n \"$f\" ] || exit {NO_TRANSCRIPT}\n"
        ),
    };
    format!("d=$HOME/.claude/projects/{slug}\n{find}", slug = slug(repo),)
}

/// Claude Code's own mapping from a working directory to a project directory:
/// every byte that is not `[A-Za-z0-9]` becomes `-`. Checked against this
/// machine, where `/home/<user>/Github/homelab` is stored under
/// `-home-<user>-Github-homelab`.
///
/// It is also why [`probe`] needs no quoting around `$d`: the result cannot
/// contain a character a shell would act on.
fn slug(repo: &str) -> String {
    repo.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// One JSONL record, or `None` if it is not a turn worth showing.
fn entry(line: &str) -> Option<Entry> {
    let record: Record = serde_json::from_str(line).ok()?;
    let who = match record.kind.as_str() {
        "user" => Who::User,
        "assistant" => Who::Assistant,
        _ => return None,
    };

    let mut text = Vec::new();
    let mut tools = Vec::new();
    match record.message?.content {
        Content::Text(said) => text.push(said),
        Content::Blocks(blocks) => {
            for block in blocks {
                match block {
                    Block::Text { text: said } => text.push(said),
                    Block::ToolUse { name, input } => tools.push(Call {
                        name,
                        target: target_in(&input),
                    }),
                    Block::Other => {}
                }
            }
        }
    }

    // A turn that is only a tool result carries nothing to read and no tool to
    // name; dropping it here is what keeps `-n 20` worth twenty useful lines.
    if text.is_empty() && tools.is_empty() {
        return None;
    }
    Some(Entry {
        who,
        at: record.timestamp,
        text: text.join("\n").trim().to_owned(),
        tools,
    })
}

/// What one call acted on: the first of [`TARGET_KEYS`] the input spells with a
/// string, capped. Forwarding the whole object instead would carry a `Write`'s
/// file contents to a phone (D5 §4.2).
fn target_in(input: &serde_json::Value) -> Option<String> {
    let found = TARGET_KEYS
        .iter()
        .find_map(|key| input.get(key)?.as_str())?
        .trim();
    let mut target: String = found.chars().take(CAP).collect();
    if found.chars().nth(CAP).is_some() {
        target.push(CUT);
    }
    (!target.is_empty()).then_some(target)
}

/// Someone else's format, so unknown fields are tolerated as in
/// [`crate::inventory`] — and 11 of the 13 record types have no `message` at
/// all, which is why it is an `Option` rather than a parse failure.
#[derive(Debug, serde::Deserialize)]
struct Record {
    #[serde(rename = "type")]
    kind: String,
    timestamp: Option<String>,
    message: Option<Message>,
}

#[derive(Debug, serde::Deserialize)]
struct Message {
    content: Content,
}

/// A user turn's content is a bare string when a person typed it and a block
/// array when it is a tool result.
#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
enum Content {
    Text(String),
    Blocks(Vec<Block>),
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type")]
enum Block {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        name: String,
        /// Already on the wire — the far side drops tool *results*, not the
        /// calls that asked for them (D5 §2.1).
        #[serde(default)]
        input: serde_json::Value,
    },
    #[serde(other)]
    Other,
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn a_repo_path_becomes_the_directory_claude_code_actually_uses() {
        assert_eq!(slug("/home/u/Github/homelab"), "-home-u-Github-homelab");
        assert_eq!(slug("/srv/repo.git"), "-srv-repo-git");
    }

    /// The slug is what makes [`probe`] safe without quoting, so a path that
    /// tries to leave it is the test that matters.
    #[test]
    fn a_hostile_repo_path_cannot_reach_the_remote_shell() {
        let probe = probe("/tmp/x'; touch /tmp/pwned; '", None, 5, 0);
        assert!(probe.contains("-tmp-x---touch--tmp-pwned---"), "{probe}");
        assert!(!probe.contains("touch /tmp/pwned"), "{probe}");
    }

    /// Y-094: a named session is opened by name, and `ls -t` — the guess that
    /// picks whichever conversation touched this repo last — is gone from the
    /// script entirely.
    #[test]
    fn a_named_session_is_asked_for_by_name_rather_than_by_age() {
        let probe = probe(
            "/srv/repo",
            Some("34d9a1ab-0000-4000-8000-000000000000"),
            5,
            0,
        );
        assert!(
            probe.contains("f=$d/'34d9a1ab-0000-4000-8000-000000000000'.jsonl"),
            "{probe}"
        );
        assert!(!probe.contains("ls -t"), "{probe}");
    }

    /// The id comes from a start command a workspace's `startup` can write, so
    /// it is the second string in this module that must not reach a shell.
    /// Asserted as an exact string for `agent.rs`'s reason: the escaped form
    /// still *contains* the payload, so searching for it proves nothing.
    #[test]
    fn a_hostile_session_id_cannot_reach_the_remote_shell() {
        let probe = probe("/srv/repo", Some("x'; touch /tmp/pwned; '"), 5, 0);
        assert!(
            probe.contains(&format!(
                "f=$d/{}.jsonl\n",
                r"'x'\''; touch /tmp/pwned; '\'''"
            )),
            "{probe}"
        );
    }

    /// `before` skips newer records, so the window walks back rather than
    /// growing. The count is asked of the same selection.
    #[test]
    fn a_window_asks_for_more_of_the_file_than_it_returns() {
        let first = probe("/srv/repo", None, 50, 0);
        assert!(first.contains("| tail -n 50 | head -n 50\n"), "{first}");

        let older = probe("/srv/repo", None, 50, 50);
        assert!(older.contains("| tail -n 100 | head -n 50\n"), "{older}");
        assert!(
            older.contains(&format!("{SELECT} | grep -c ''\n")),
            "{older}"
        );
    }

    /// Real records, byte for byte, from a 14 MB transcript on this machine.
    #[test]
    fn the_two_record_types_that_matter_are_the_ones_kept() {
        let said = entry(
            r#"{"parentUuid":"a","isSidechain":false,"type":"user","message":{"role":"user","content":"fix the failing test"},"timestamp":"2026-07-28T18:20:30.543Z"}"#,
        )
        .expect("a typed prompt is a turn");
        assert_eq!(said.who, Who::User);
        assert_eq!(said.text, "fix the failing test");
        assert_eq!(said.at.as_deref(), Some("2026-07-28T18:20:30.543Z"));

        let replied = entry(
            r#"{"type":"assistant","message":{"model":"claude-opus-5","role":"assistant","content":[{"type":"text","text":"I'll start by looking at the current repo state."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cargo test","description":"Run the test suite"}}]},"timestamp":"2026-07-28T18:20:34.000Z"}"#,
        )
        .expect("an assistant turn is a turn");
        assert_eq!(replied.who, Who::Assistant);
        assert_eq!(
            replied.text,
            "I'll start by looking at the current repo state."
        );
        assert_eq!(replied.tools, [call("Bash", Some("cargo test"))]);
    }

    fn call(name: &str, target: Option<&str>) -> Call {
        Call {
            name: name.to_owned(),
            target: target.map(str::to_owned),
        }
    }

    fn target_of(input: &str) -> Option<String> {
        target_in(&serde_json::from_str(input).expect("the input is JSON"))
    }

    /// The list is ordered, so a `Grep` naming both is read by its `path` —
    /// `path` comes before `pattern` in D5 §4.2's list.
    #[test]
    fn a_call_is_named_by_the_first_key_the_list_finds() {
        assert_eq!(
            target_of(r#"{"pattern":"Vec<Call>","path":"crates","output_mode":"content"}"#)
                .as_deref(),
            Some("crates")
        );
        assert_eq!(
            target_of(r#"{"pattern":"Vec<Call>","output_mode":"content"}"#).as_deref(),
            Some("Vec<Call>")
        );
        assert_eq!(
            target_of(r#"{"file_path":"/srv/repo/src/api.ts","limit":40}"#).as_deref(),
            Some("/srv/repo/src/api.ts")
        );
        assert_eq!(
            target_of(r#"{"command":"cargo test","description":"Run the tests"}"#).as_deref(),
            Some("cargo test")
        );
    }

    /// `SendUserFile`'s `files` is a list, and it is the one call in 127 that
    /// this list misses. It renders as its name alone.
    #[test]
    fn a_call_the_list_misses_carries_no_target() {
        assert_eq!(target_of(r#"{"files":["a.png"],"notify":true}"#), None);
        assert_eq!(target_of("{}"), None);
        assert_eq!(
            entry(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"SendUserFile","input":{"files":["a.png"]}}]}}"#
            )
            .expect("a tool call is a turn")
            .tools,
            [call("SendUserFile", None)]
        );
    }

    /// The cap is what keeps a `Write`'s file out of a phone's payload, so a
    /// target that hits it has to say it was cut.
    #[test]
    fn a_target_longer_than_the_cap_is_cut_and_says_so() {
        let whole = "x".repeat(CAP);
        assert_eq!(
            target_of(&format!(r#"{{"command":"{whole}"}}"#)).as_deref(),
            Some(whole.as_str()),
            "a target that exactly fills the cap is not cut"
        );

        let cut =
            target_of(&format!(r#"{{"command":"{whole}y"}}"#)).expect("a command is a target");
        assert_eq!(cut.chars().count(), CAP + 1);
        assert!(cut.ends_with(CUT), "{cut}");
        assert!(cut.starts_with(&whole), "{cut}");
    }

    /// The cap counts characters, and a command a person typed may hold none of
    /// them in one byte. Cutting bytes would panic on the boundary.
    #[test]
    fn the_cap_counts_characters_rather_than_bytes() {
        let wide = "漢".repeat(CAP + 10);
        let cut = target_of(&format!(r#"{{"command":"{wide}"}}"#)).expect("a command is a target");
        assert_eq!(cut.chars().count(), CAP + 1);
    }

    /// The other eleven types are the bulk of the file. Dropping them is the
    /// whole reason `-n 20` shows twenty turns rather than twenty snapshots.
    #[test]
    fn the_bookkeeping_records_are_dropped() {
        for line in [
            r#"{"type":"mode","mode":"normal","sessionId":"s"}"#,
            r#"{"type":"bridge-session","sessionId":"s","bridgeSessionId":"b","lastSequenceNum":0}"#,
            r#"{"type":"ai-title","aiTitle":"Design a control plane","sessionId":"s"}"#,
            r#"{"type":"file-history-snapshot","messageId":"m","snapshot":{},"isSnapshotUpdate":false}"#,
            r#"{"type":"pr-link","sessionId":"s","prNumber":1,"prUrl":"u","prRepository":"r"}"#,
            r#"{"type":"queue-operation","operation":"enqueue","content":"...","sessionId":"s"}"#,
            "not json at all",
        ] {
            assert_eq!(entry(line), None, "{line}");
        }
    }

    /// A tool result is a `user` record and would otherwise fill the window
    /// with the agent's own input.
    #[test]
    fn a_tool_result_turn_is_not_a_turn() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"ok"}]},"toolUseResult":{"stdout":"ok"}}"#;
        assert_eq!(entry(line), None);
    }

    /// Both clocks come from the far side, so this is an age and not a drift.
    #[test]
    fn idle_time_is_measured_entirely_on_the_remote_clock() {
        let transcript = Transcript {
            path: "/x".to_owned(),
            modified: 1_000,
            now: 1_042,
            total: 0,
            entries: Vec::new(),
        };
        assert_eq!(transcript.idle_for(), 42);
    }
}
