//! Reading an agent's transcript off a real remote (§B3).
//!
//! No stub `claude` here, and that is the point: [`yantra_core::logs`] never
//! runs the agent's binary, so what it needs from the far side is a filesystem
//! and a shell. The records written below are real ones, copied byte for byte
//! from a 14 MB transcript this machine produced.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::logs::{self, Who};
use yantra_core::ssh::{Exec, Machine, Ssh};
use yantra_core::tmux::Tmux;

/// A directory that is not `$HOME`, so the slug is not the trivial case.
const REPO: &str = "/tmp/logsrepo";

/// What Claude Code turns `REPO` into. Spelled out rather than computed, so a
/// change to the mapping fails here instead of being mirrored by the test.
const PROJECT: &str = "-tmp-logsrepo";

/// One assistant turn with a tool call, one typed prompt, and the bookkeeping
/// that outnumbers both in a real file.
const REAL_RECORDS: &[&str] = &[
    r#"{"type":"mode","mode":"normal","sessionId":"s"}"#,
    r#"{"type":"bridge-session","sessionId":"s","bridgeSessionId":"b","lastSequenceNum":0}"#,
    r#"{"parentUuid":"a","isSidechain":false,"promptId":"p","type":"user","message":{"role":"user","content":"fix the failing test"},"timestamp":"2026-07-28T18:20:30.543Z","cwd":"/tmp/logsrepo"}"#,
    r#"{"type":"ai-title","aiTitle":"Fix the failing test","sessionId":"s"}"#,
    r#"{"type":"assistant","message":{"model":"claude-opus-5","role":"assistant","content":[{"type":"text","text":"Looking at the test first."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/tmp/logsrepo/tests/api.rs","limit":40}}]},"timestamp":"2026-07-28T18:20:34.000Z"}"#,
    r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"a very large file"}]},"toolUseResult":{"stdout":"a very large file"}}"#,
    r#"{"type":"file-history-snapshot","messageId":"m","snapshot":{},"isSnapshotUpdate":false}"#,
    r#"{"type":"pr-link","sessionId":"s","prNumber":1,"prUrl":"u","prRepository":"r"}"#,
];

struct Lab {
    _fixture: SshFixture,
    ssh: Ssh,
    dir: std::path::PathBuf,
}

impl Lab {
    async fn start(label: &str) -> Result<Option<Self>> {
        let Some(fixture) = SshFixture::start()? else {
            return Ok(None);
        };
        let dir = std::path::PathBuf::from("/tmp").join(format!("ya-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let ssh = Ssh::new(Machine {
            host: fixture.host().to_owned(),
            user: Some(USER.to_owned()),
            port: Some(fixture.port()),
            identity: Some(fixture.key_path()),
            state_dir: dir.clone(),
        })?;
        Ok(Some(Self {
            _fixture: fixture,
            ssh,
            dir,
        }))
    }

    /// Writes a transcript exactly where Claude Code would put it. Base64 so
    /// the JSON's quotes never meet a shell (ADR-0006).
    async fn write_transcript(
        &self,
        session_id: &str,
        records: &[&str],
        append: bool,
    ) -> Result<()> {
        use base64::Engine as _;
        let body = format!("{}\n", records.join("\n"));
        let b64 = base64::engine::general_purpose::STANDARD.encode(&body);
        let redirect = if append { ">>" } else { ">" };
        self.ssh
            .exec(&format!(
                "mkdir -p ~/.claude/projects/{PROJECT} && printf %s '{b64}' | base64 -d \
                 {redirect} ~/.claude/projects/{PROJECT}/{session_id}.jsonl"
            ))
            .await?;
        Ok(())
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A workspace whose agent has never run is an ordinary answer, not a failure —
/// `logs` is the first thing someone tries when they are not sure it started.
#[tokio::test]
async fn a_repo_with_no_transcript_says_so_instead_of_failing() -> Result<()> {
    let Some(lab) = Lab::start("logs-none").await? else {
        return Ok(());
    };

    let err = logs::read(&lab.ssh, REPO, None, 20)
        .await
        .expect_err("there is no transcript there");
    assert!(matches!(err, logs::Error::NoTranscript { .. }), "{err:?}");
    Ok(())
}

/// The projection, end to end: eight records in, two turns out.
#[tokio::test]
async fn only_the_turns_survive_the_trip() -> Result<()> {
    let Some(lab) = Lab::start("logs-read").await? else {
        return Ok(());
    };
    lab.write_transcript("11111111-1111-4111-8111-111111111111", REAL_RECORDS, false)
        .await?;

    let transcript = logs::read(&lab.ssh, REPO, None, 20).await?;
    assert!(
        transcript.path.ends_with(&format!(
            "/.claude/projects/{PROJECT}/11111111-1111-4111-8111-111111111111.jsonl"
        )),
        "{}",
        transcript.path
    );

    assert_eq!(transcript.entries.len(), 2, "{:#?}", transcript.entries);
    assert_eq!(transcript.entries[0].who, Who::User);
    assert_eq!(transcript.entries[0].text, "fix the failing test");
    assert_eq!(transcript.entries[1].who, Who::Assistant);
    assert_eq!(transcript.entries[1].text, "Looking at the test first.");
    assert_eq!(
        transcript.entries[1].tools,
        [logs::Call {
            name: "Read".to_owned(),
            target: Some("/tmp/logsrepo/tests/api.rs".to_owned()),
        }],
        "the call's input crossed the wire inside the record that holds it"
    );
    Ok(())
}

/// **Q12's standing requirement.** Issue #70632's failure mode is a transcript
/// that exists and stops growing, which looks healthy to anything that only
/// checks for the file — so what is asserted here is that the mtime *moved*.
///
/// Both timestamps come from the far side's own clock, so this measures the
/// file rather than the gap between two machines' clocks.
#[tokio::test]
async fn a_transcript_that_is_still_being_written_reports_a_moving_mtime() -> Result<()> {
    let Some(lab) = Lab::start("logs-mtime").await? else {
        return Ok(());
    };
    let id = "22222222-2222-4222-8222-222222222222";
    lab.write_transcript(id, REAL_RECORDS, false).await?;

    let before = logs::read(&lab.ssh, REPO, None, 20).await?;
    // A whole second, because the mtime this reads has one-second resolution.
    lab.ssh.exec("sleep 2").await?;
    lab.write_transcript(
        id,
        &[
            r#"{"type":"assistant","message":{"model":"claude-opus-5","role":"assistant","content":[{"type":"text","text":"Fixed it."}]},"timestamp":"2026-07-28T18:21:00.000Z"}"#,
        ],
        true,
    )
    .await?;
    let after = logs::read(&lab.ssh, REPO, None, 20).await?;

    assert!(
        after.modified > before.modified,
        "the agent is working, so the transcript must be growing: {} then {}",
        before.modified,
        after.modified
    );
    assert!(
        after.idle_for() < before.idle_for() + 2,
        "a fresh write must read as fresher, not merely as different"
    );
    assert_eq!(after.entries.len(), 3);
    assert_eq!(after.entries[2].text, "Fixed it.");
    Ok(())
}

/// Two workspaces may name the same repo, and a repo outlives any one session,
/// so the directory accumulates. With no session to name — a shell, a machine
/// with no tmux, an agent long gone — the newest is the one anybody means.
#[tokio::test]
async fn the_newest_transcript_is_the_one_read() -> Result<()> {
    let Some(lab) = Lab::start("logs-newest").await? else {
        return Ok(());
    };
    lab.write_transcript(
        "33333333-3333-4333-8333-333333333333",
        &[
            r#"{"type":"user","message":{"role":"user","content":"the older conversation"},"timestamp":"2026-07-27T10:00:00.000Z"}"#,
        ],
        false,
    )
    .await?;
    lab.ssh.exec("sleep 2").await?;
    lab.write_transcript(
        "44444444-4444-4444-8444-444444444444",
        &[
            r#"{"type":"user","message":{"role":"user","content":"the newer conversation"},"timestamp":"2026-07-28T10:00:00.000Z"}"#,
        ],
        false,
    )
    .await?;

    let transcript = logs::read(&lab.ssh, REPO, None, 20).await?;
    assert!(transcript.path.contains("44444444"), "{}", transcript.path);
    assert_eq!(transcript.entries[0].text, "the newer conversation");
    Ok(())
}

/// **Y-094.** The running session is not always the newest file: an agent
/// sitting at a prompt writes nothing while another one in the same repo does.
/// Naming it is the whole fix, and the assertion that matters is which
/// conversation came back, not merely which path.
#[tokio::test]
async fn the_named_session_is_read_even_when_another_wrote_more_recently() -> Result<()> {
    let Some(lab) = Lab::start("logs-named").await? else {
        return Ok(());
    };
    let running = "66666666-6666-4666-8666-666666666666";
    lab.write_transcript(
        running,
        &[
            r#"{"type":"user","message":{"role":"user","content":"the session yantra launched"},"timestamp":"2026-07-27T10:00:00.000Z"}"#,
        ],
        false,
    )
    .await?;
    lab.ssh.exec("sleep 2").await?;
    lab.write_transcript(
        "77777777-7777-4777-8777-777777777777",
        &[
            r#"{"type":"user","message":{"role":"user","content":"somebody else's agent"},"timestamp":"2026-07-28T10:00:00.000Z"}"#,
        ],
        false,
    )
    .await?;

    let transcript = logs::read(&lab.ssh, REPO, Some(running), 20).await?;
    assert!(
        transcript.path.ends_with(&format!("/{running}.jsonl")),
        "{}",
        transcript.path
    );
    assert_eq!(transcript.entries[0].text, "the session yantra launched");
    Ok(())
}

/// The state a fresh launch and a fresh `resume` both pass through: the pane
/// names a session, and that session has not spoken yet (I-49). Answering with
/// the transcript next to it would be the old guess wearing the new name.
#[tokio::test]
async fn a_named_session_that_has_written_nothing_borrows_no_other_transcript() -> Result<()> {
    let Some(lab) = Lab::start("logs-noturn").await? else {
        return Ok(());
    };
    lab.write_transcript(
        "88888888-8888-4888-8888-888888888888",
        &[
            r#"{"type":"user","message":{"role":"user","content":"the conversation before this one"},"timestamp":"2026-07-27T10:00:00.000Z"}"#,
        ],
        false,
    )
    .await?;

    let err = logs::read(
        &lab.ssh,
        REPO,
        Some("34d9a1ab-0000-4000-8000-000000000000"),
        20,
    )
    .await
    .expect_err("the forked session has written nothing yet");
    assert!(
        matches!(&err, logs::Error::NoTurnYet { session, .. }
            if session == "34d9a1ab-0000-4000-8000-000000000000"),
        "the answer must name the session asked for, not the file beside it: {err:?}"
    );
    Ok(())
}

/// Where the id comes from: the command tmux was asked to run, which is an
/// agent's for a launch and nothing at all for a plain `up`.
#[tokio::test]
async fn the_session_to_name_is_read_back_out_of_the_pane() -> Result<()> {
    let Some(lab) = Lab::start("logs-pane").await? else {
        return Ok(());
    };
    let tmux = Tmux::resolve(&lab.ssh).await?;
    lab.ssh.exec(&format!("mkdir -p {REPO}")).await?;

    assert_eq!(
        logs::session_of(&lab.ssh, "logsgone").await,
        None,
        "a workspace with no session has no session to name"
    );

    tmux.ensure(&lab.ssh, "logsshell", REPO, None).await?;
    assert_eq!(
        logs::session_of(&lab.ssh, "logsshell").await,
        None,
        "a session opened as a shell was never asked to run an agent"
    );

    // The arguments after `sh -c`'s script land in `$0`/`$1` and are ignored, so
    // the pane stays alive while carrying a launch's command line.
    let id = "d4c3b2a1-0000-4000-8000-000000000000";
    tmux.ensure(
        &lab.ssh,
        "logsagent",
        REPO,
        Some(&format!("sh -c 'exec sleep 300' --session-id '{id}'")),
    )
    .await?;
    assert_eq!(
        logs::session_of(&lab.ssh, "logsagent").await.as_deref(),
        Some(id)
    );

    tmux.kill(&lab.ssh, "logsshell").await?;
    tmux.kill(&lab.ssh, "logsagent").await?;
    Ok(())
}

/// `-n` counts turns, and it only can because the bookkeeping is dropped before
/// it is counted. Without that, a window of 3 over this file shows nothing.
#[tokio::test]
async fn the_window_counts_turns_and_not_records() -> Result<()> {
    let Some(lab) = Lab::start("logs-window").await? else {
        return Ok(());
    };
    let mut records: Vec<&str> = vec![
        r#"{"type":"queue-operation","operation":"enqueue","content":"x","sessionId":"s"}"#;
        40
    ];
    records.extend_from_slice(REAL_RECORDS);
    lab.write_transcript("55555555-5555-4555-8555-555555555555", &records, false)
        .await?;

    let transcript = logs::read(&lab.ssh, REPO, None, 3).await?;
    assert!(
        !transcript.entries.is_empty(),
        "a small window over a file that is mostly bookkeeping must still show turns"
    );
    assert!(
        transcript.entries.iter().all(|e| !e.text.is_empty()),
        "{:#?}",
        transcript.entries
    );
    Ok(())
}
