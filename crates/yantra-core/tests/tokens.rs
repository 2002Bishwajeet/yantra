//! Adding up a transcript's tokens on a real remote (§B3).
//!
//! The counting is unit-tested; what needs a machine is the *script* — a `grep
//! -n -o` pipeline whose grouping is the whole design, and whose `|| :` is the
//! difference between "spent nothing" and a failed command. The records below
//! are real ones, copied byte for byte from a transcript this machine wrote.

#![allow(clippy::expect_used)]

mod common;

use anyhow::Result;
use common::{SshFixture, USER};
use yantra_core::logs;
use yantra_core::ssh::{Exec, Machine, Ssh};
use yantra_core::tokens;

const REPO: &str = "/tmp/tokensrepo";
const PROJECT: &str = "-tmp-tokensrepo";

/// **One API response, written as two records.** Both carry the same
/// `requestId` and the same `message.usage`, and each names the four counts a
/// second time inside `iterations`. Anything that sums per record reports four
/// times what this response cost.
const ONE_RESPONSE: &[&str] = &[
    r#"{"parentUuid":"a","isSidechain":false,"message":{"id":"msg_1","model":"claude-opus-5","role":"assistant","content":[{"type":"text","text":"Looking at the test first."}],"usage":{"input_tokens":2,"cache_creation_input_tokens":40353,"cache_read_input_tokens":0,"output_tokens":200,"server_tool_use":{"web_search_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":40353,"ephemeral_5m_input_tokens":0},"iterations":[{"input_tokens":2,"output_tokens":200,"cache_read_input_tokens":0,"cache_creation_input_tokens":40353,"type":"message"}]}},"requestId":"req_011Cdjz3sxeFdmZwvK8L4Gs7","type":"assistant","uuid":"u1","timestamp":"2026-08-05T17:19:37.154Z"}"#,
    r#"{"parentUuid":"u1","isSidechain":false,"message":{"id":"msg_1","model":"claude-opus-5","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}],"usage":{"input_tokens":2,"cache_creation_input_tokens":40353,"cache_read_input_tokens":0,"output_tokens":200,"server_tool_use":{"web_search_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":40353,"ephemeral_5m_input_tokens":0},"iterations":[{"input_tokens":2,"output_tokens":200,"cache_read_input_tokens":0,"cache_creation_input_tokens":40353,"type":"message"}]}},"requestId":"req_011Cdjz3sxeFdmZwvK8L4Gs7","type":"assistant","uuid":"u2","timestamp":"2026-08-05T17:19:38.452Z"}"#,
];

/// A second response, and the records that surround one: a typed prompt, a tool
/// result, and the bookkeeping that outnumbers both.
const THE_REST: &[&str] = &[
    r#"{"type":"mode","mode":"normal","sessionId":"s"}"#,
    r#"{"parentUuid":"u2","isSidechain":false,"type":"user","message":{"role":"user","content":"fix the failing test"},"timestamp":"2026-08-05T17:19:40.000Z"}"#,
    r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"a very large file"}]},"toolUseResult":{"stdout":"a very large file"}}"#,
    r#"{"parentUuid":"u2","isSidechain":false,"message":{"id":"msg_2","model":"claude-opus-5","role":"assistant","content":[{"type":"text","text":"Fixed it."}],"usage":{"input_tokens":2,"cache_creation_input_tokens":465,"cache_read_input_tokens":40353,"output_tokens":75,"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":465,"ephemeral_5m_input_tokens":0},"iterations":[{"input_tokens":2,"output_tokens":75,"cache_read_input_tokens":40353,"cache_creation_input_tokens":465,"type":"message"}]}},"requestId":"req_011CdjzSECOND","type":"assistant","uuid":"u3","timestamp":"2026-08-05T17:19:44.000Z"}"#,
    r#"{"type":"file-history-snapshot","messageId":"m","snapshot":{},"isSnapshotUpdate":false}"#,
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

    /// Base64 so the JSON's quotes never meet a shell (ADR-0006).
    async fn write_transcript(&self, session_id: &str, records: &[&str]) -> Result<()> {
        use base64::Engine as _;
        let body = format!("{}\n", records.join("\n"));
        let b64 = base64::engine::general_purpose::STANDARD.encode(&body);
        self.ssh
            .exec(&format!(
                "mkdir -p ~/.claude/projects/{PROJECT} && printf %s '{b64}' | base64 -d \
                 >> ~/.claude/projects/{PROJECT}/{session_id}.jsonl"
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

/// The measurement the module exists to get right, made by a real `grep`:
/// seven records, two API responses, and the totals are theirs once each.
#[tokio::test]
async fn a_response_written_as_two_records_is_counted_once() -> Result<()> {
    let Some(lab) = Lab::start("tokens-sum").await? else {
        return Ok(());
    };
    let id = "11111111-1111-4111-8111-111111111111";
    lab.write_transcript(id, ONE_RESPONSE).await?;
    lab.write_transcript(id, THE_REST).await?;

    let spend = tokens::spent(&lab.ssh, REPO, Some(id)).await?;
    assert!(
        spend.path.ends_with(&format!("/{id}.jsonl")),
        "{}",
        spend.path
    );
    assert_eq!(spend.responses, 2, "{spend:?}");
    assert_eq!(spend.input, 4, "{spend:?}");
    assert_eq!(spend.output, 275, "{spend:?}");
    assert_eq!(spend.cache_write, 40_818, "{spend:?}");
    assert_eq!(spend.cache_read, 40_353, "{spend:?}");
    Ok(())
}

/// A launched agent that has only just started has a transcript with no
/// assistant record in it. `grep` matching nothing exits 1, so without the
/// `|| :` this reads as a failed probe rather than as nothing spent.
#[tokio::test]
async fn a_transcript_with_no_assistant_record_is_zero_and_not_an_error() -> Result<()> {
    let Some(lab) = Lab::start("tokens-empty").await? else {
        return Ok(());
    };
    let id = "22222222-2222-4222-8222-222222222222";
    lab.write_transcript(
        id,
        &[
            r#"{"type":"user","message":{"role":"user","content":"fix the failing test"},"timestamp":"2026-08-05T17:19:40.000Z"}"#,
        ],
    )
    .await?;

    let spend = tokens::spent(&lab.ssh, REPO, Some(id)).await?;
    assert_eq!(spend.responses, 0, "{spend:?}");
    assert_eq!(spend.input, 0, "{spend:?}");
    Ok(())
}

/// The conversation stays on the far side. What comes back is numbers and
/// request ids, and this is the assertion that says so: the text of a turn is
/// in the file, and nowhere in the answer.
#[tokio::test]
async fn no_conversation_crosses_the_wire() -> Result<()> {
    let Some(lab) = Lab::start("tokens-quiet").await? else {
        return Ok(());
    };
    let id = "33333333-3333-4333-8333-333333333333";
    lab.write_transcript(id, ONE_RESPONSE).await?;
    lab.write_transcript(id, THE_REST).await?;

    let spend = tokens::spent(&lab.ssh, REPO, Some(id)).await?;
    let answer = format!("{spend:?}");
    assert!(!answer.contains("Fixed it."), "{answer}");
    assert!(!answer.contains("fix the failing test"), "{answer}");
    assert!(!answer.contains("req_"), "{answer}");
    Ok(())
}

/// A workspace whose agent has never run is the ordinary answer `logs` gives,
/// and it is the same one here — the two verbs read one file by one script.
#[tokio::test]
async fn a_repo_with_no_transcript_says_so_instead_of_failing() -> Result<()> {
    let Some(lab) = Lab::start("tokens-none").await? else {
        return Ok(());
    };

    let err = tokens::spent(&lab.ssh, REPO, None)
        .await
        .expect_err("there is no transcript there");
    assert!(matches!(err, logs::Error::NoTranscript { .. }), "{err:?}");
    Ok(())
}
