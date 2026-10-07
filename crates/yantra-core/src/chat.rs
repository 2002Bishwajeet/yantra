/*
 * The event names and payload vocabulary below are T3 Code's, re-expressed in Rust:
 * https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/providerRuntime.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
//! The provider-neutral chat event model (ADR-0026 decision 1).
//!
//! An agent's stream is normalised into these events, and the browser draws
//! them without knowing which agent spoke. It carries only what its sources
//! produce: ACP v1 ([`crate::acp`]), Claude's stream-json ([`crate::claude`])
//! and a thread's checkpoints ([`crate::checkpoint`]). Serialised as
//! `{"threadId", "type", "payload"}`, so a relay can send it on unchanged.

use serde::{Deserialize, Serialize};

/// One event, and the conversation it belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEvent {
    pub thread_id: String,
    #[serde(flatten)]
    pub event: Event,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "payload")]
pub enum Event {
    /// `thread` is the id a caller reopens the conversation by. `harness` is
    /// the agent that speaks in it: claude, codex, gemini, grok or opencode.
    #[serde(rename = "thread.started")]
    ThreadStarted { thread: String, harness: String },
    #[serde(rename = "thread.metadata.updated")]
    ThreadMetadataUpdated { name: String },
    #[serde(rename = "thread.token-usage.updated")]
    TokenUsageUpdated(TokenUsage),
    #[serde(rename = "turn.started")]
    TurnStarted,
    #[serde(rename = "turn.completed")]
    TurnCompleted(TurnCompleted),
    #[serde(rename = "turn.diff.updated")]
    TurnDiffUpdated(TurnDiff),
    /// Not T3 Code's: the thread's files are back as checkpoint `turn` kept them.
    #[serde(rename = "thread.reverted")]
    ThreadReverted { turn: u32 },
    #[serde(rename = "turn.plan.updated")]
    PlanUpdated { plan: Vec<PlanStep> },
    #[serde(rename = "content.delta")]
    ContentDelta(ContentDelta),
    #[serde(rename = "item.started")]
    ItemStarted(Item),
    #[serde(rename = "item.updated")]
    ItemUpdated(Item),
    #[serde(rename = "item.completed")]
    ItemCompleted(Item),
    #[serde(rename = "request.opened")]
    RequestOpened(RequestOpened),
    #[serde(rename = "request.resolved")]
    RequestResolved(RequestResolved),
}

/// How full the context window is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub used_tokens: u64,
    pub max_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompleted {
    pub state: TurnState,
    /// `None` when the turn failed rather than stopped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<StopReason>,
    /// Why a failed turn failed, in the agent's or `ssh`'s own words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// What turn `turn` changed in the worktree, as a unified diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnDiff {
    pub turn: u32,
    pub unified_diff: String,
    /// The diff was cut at [`crate::checkpoint::LIMIT`].
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnState {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanStep {
    pub step: String,
    pub status: PlanStepStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanStepStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentDelta {
    pub stream_kind: StreamKind,
    pub delta: String,
    /// Groups the chunks of one message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamKind {
    AssistantText,
    ReasoningText,
    /// Not T3 Code's: a replayed conversation repeats what the person wrote.
    UserText,
}

/// A tool call. On `item.updated` and `item.completed` a field that is `None`
/// or empty is unchanged; `output` and `changes` replace what came before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub item_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_type: Option<ItemType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<ItemStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<FileChange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemType {
    CommandExecution,
    FileChange,
    WebSearch,
    DynamicToolCall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    InProgress,
    Completed,
    Failed,
}

/// One file a tool wrote. `old_text` is `None` for a file it created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_text: Option<String>,
    pub new_text: String,
}

/// The agent asks before a tool runs, and waits for one of `options`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestOpened {
    pub request_id: String,
    pub request_type: RequestType,
    /// The tool call this request is about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    /// What the tool acts on: the command, the path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub options: Vec<RequestOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestOption {
    pub option_id: String,
    pub label: String,
    pub decision: Decision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestResolved {
    pub request_id: String,
    pub request_type: RequestType,
    pub decision: Decision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestType {
    ExecCommandApproval,
    FileReadApproval,
    FileChangeApproval,
    DynamicToolCall,
}

/// Deserialised too: a browser answers a request with one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Accept,
    AcceptAlways,
    Decline,
    Cancel,
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wire(event: Event) -> serde_json::Value {
        serde_json::to_value(ThreadEvent {
            thread_id: "ses_1".to_owned(),
            event,
        })
        .expect("an event serialises")
    }

    /// The shape a relay sends on, so the browser's parser is written once.
    #[test]
    fn an_event_carries_its_thread_type_and_payload() {
        let delta = wire(Event::ContentDelta(ContentDelta {
            stream_kind: StreamKind::AssistantText,
            delta: "hi".to_owned(),
            item_id: None,
        }));
        assert_eq!(
            delta,
            json!({"threadId": "ses_1", "type": "content.delta",
                   "payload": {"streamKind": "assistant_text", "delta": "hi"}})
        );
        assert_eq!(
            wire(Event::TurnStarted),
            json!({"threadId": "ses_1", "type": "turn.started"})
        );
    }

    #[test]
    fn a_completed_turn_names_its_state_and_stop_reason() {
        let done = wire(Event::TurnCompleted(TurnCompleted {
            state: TurnState::Cancelled,
            stop_reason: Some(StopReason::Cancelled),
            message: None,
        }));
        assert_eq!(
            done["payload"],
            json!({"state": "cancelled", "stopReason": "cancelled"})
        );
        let failed = wire(Event::TurnCompleted(TurnCompleted {
            state: TurnState::Failed,
            stop_reason: None,
            message: Some("Not logged in · Please run /login".to_owned()),
        }));
        assert_eq!(
            failed["payload"],
            json!({"state": "failed", "message": "Not logged in · Please run /login"})
        );
    }

    #[test]
    fn a_turns_diff_and_a_revert_name_their_turn() {
        assert_eq!(
            wire(Event::TurnDiffUpdated(TurnDiff {
                turn: 2,
                unified_diff: "diff --git a/a b/a\n".to_owned(),
                truncated: false,
            })),
            json!({"threadId": "ses_1", "type": "turn.diff.updated",
                   "payload": {"turn": 2, "unifiedDiff": "diff --git a/a b/a\n",
                               "truncated": false}})
        );
        assert_eq!(
            wire(Event::ThreadReverted { turn: 1 }),
            json!({"threadId": "ses_1", "type": "thread.reverted", "payload": {"turn": 1}})
        );
    }

    #[test]
    fn a_started_thread_names_itself_and_a_request_names_its_subject() {
        assert_eq!(
            wire(Event::ThreadStarted {
                thread: "1a2b3c4d".to_owned(),
                harness: "opencode".to_owned(),
            }),
            json!({"threadId": "ses_1", "type": "thread.started",
                   "payload": {"thread": "1a2b3c4d", "harness": "opencode"}})
        );
        let opened = wire(Event::RequestOpened(RequestOpened {
            request_id: "r".to_owned(),
            request_type: RequestType::ExecCommandApproval,
            item_id: None,
            title: Some("touch made.txt".to_owned()),
            detail: None,
            options: vec![],
        }));
        assert_eq!(
            opened["payload"],
            json!({"requestId": "r", "requestType": "exec_command_approval",
                   "title": "touch made.txt", "options": []})
        );
    }
}
