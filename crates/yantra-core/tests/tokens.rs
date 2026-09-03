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

/// **A subagent's response, on a different model and carrying a `model`
/// argument of its own** (Y-182). Two things have to survive a real `grep`
/// here: the response is priced at Haiku's rate rather than Opus's, and the
/// `Agent` tool's `"model":"sonnet"` further along the same line does not
/// become the model that is priced.
const A_SUBAGENT: &[&str] = &[
    r#"{"parentUuid":"u3","isSidechain":true,"message":{"id":"msg_3","model":"claude-haiku-4-5-20251001","role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Agent","input":{"subagent_type":"general-purpose","model":"sonnet","prompt":"look it up"}}],"usage":{"input_tokens":11,"cache_creation_input_tokens":300,"cache_read_input_tokens":0,"output_tokens":7,"service_tier":"standard","speed":"standard","cache_creation":{"ephemeral_5m_input_tokens":300,"ephemeral_1h_input_tokens":0}}},"requestId":"req_011CdjzTHIRD","type":"assistant","uuid":"u4","timestamp":"2026-08-05T17:19:50.000Z"}"#,
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
    let opus = spend
        .by_model
        .get("claude-opus-5")
        .expect("the model each record named");
    assert_eq!(opus.responses, 2, "{spend:?}");
    assert_eq!(opus.input, 4, "{spend:?}");
    assert_eq!(opus.output, 275, "{spend:?}");
    assert_eq!(opus.cache_write, 40_818, "{spend:?}");
    assert_eq!(opus.cache_write_1h, 40_818, "{spend:?}");
    assert_eq!(opus.cache_read, 40_353, "{spend:?}");
    assert_eq!(spend.fast, 0, "{spend:?}");
    Ok(())
}

/// Two models in one transcript are two rates, and a real `grep` has to keep
/// them apart — including from the `model` a tool call carries in its own
/// arguments, which sits on the same line as the response's (Y-182).
#[tokio::test]
async fn a_second_model_is_counted_apart_from_the_first() -> Result<()> {
    let Some(lab) = Lab::start("tokens-models").await? else {
        return Ok(());
    };
    let id = "44444444-4444-4444-8444-444444444444";
    lab.write_transcript(id, ONE_RESPONSE).await?;
    lab.write_transcript(id, A_SUBAGENT).await?;

    let spend = tokens::spent(&lab.ssh, REPO, Some(id)).await?;
    assert_eq!(
        spend.by_model.keys().collect::<Vec<_>>(),
        vec!["claude-haiku-4-5-20251001", "claude-opus-5"],
        "the Agent tool's own `model` argument must not become a third: {spend:?}"
    );
    let haiku = spend
        .by_model
        .get("claude-haiku-4-5-20251001")
        .expect("the subagent's model");
    assert_eq!(haiku.responses, 1, "{spend:?}");
    assert_eq!(haiku.input, 11, "{spend:?}");
    assert_eq!(haiku.cache_write, 300, "{spend:?}");
    assert_eq!(
        haiku.cache_write_1h, 0,
        "a five-minute write is billed at 1.25x, not 2x: {spend:?}"
    );
    assert_eq!(spend.total().responses, 2, "{spend:?}");
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
    assert!(spend.by_model.is_empty(), "{spend:?}");
    assert_eq!(spend.total().responses, 0, "{spend:?}");
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
    lab.write_transcript(id, A_SUBAGENT).await?;

    let spend = tokens::spent(&lab.ssh, REPO, Some(id)).await?;
    let answer = format!("{spend:?}");
    assert!(!answer.contains("Fixed it."), "{answer}");
    assert!(!answer.contains("fix the failing test"), "{answer}");
    assert!(!answer.contains("req_"), "{answer}");
    // Y-182 added a field that a tool call also carries, so what sits beside
    // one in a tool's arguments is worth asserting on too.
    assert!(!answer.contains("look it up"), "{answer}");
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
