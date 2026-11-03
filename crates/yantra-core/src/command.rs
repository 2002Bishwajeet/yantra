/*
 * The probe and the list's clean-up follow T3 Code at 810e8f6,
 * apps/server/src/provider/ClaudeProvider.ts (probeClaudeCapabilities,
 * parseClaudeInitializationCommands, dedupeSlashCommands):
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/server/src/provider/ClaudeProvider.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 *
 * Kept: Claude's own `initialize` control request, an empty name dropped, a duplicate settled
 * case-insensitively with the first entry's fields winning. Changed: the request is one
 * `claude -p` on the machine over ssh, with no hook and no session kept.
 */
//! The slash commands Claude offers in a thread's worktree (Y-563), for the
//! Chat composer's `/` menu.
//!
//! **One round trip, asked for and never polled** ([ADR-0019]). Claude
//! answers `initialize` before any prompt, so no model is called, and it
//! exits when stdin closes. An ACP agent sends its list on the turn stream
//! instead ([`crate::acp`]), so it has no probe here.
//!
//! [ADR-0019]: ../../../docs/adr/0019-a-probe-that-asks-a-machine-is-a-post.md

use std::collections::HashMap;
use std::collections::hash_map::Entry;

use serde::Deserialize;

use crate::agent;
use crate::chat::Command;
use crate::clone::destination;
use crate::commit::{TIMED_OUT, bounded};
use crate::delegate::{self, NOT_A_REPO};
use crate::ssh::{self, Exec, Ssh};
use crate::thread;
use crate::tmux::sq;
use crate::workspace;

/// The control request's id, which the answer repeats.
const REQUEST_ID: &str = "yantra-commands";
const REQUEST: &str = r#"{"type":"control_request","request_id":"yantra-commands","request":{"subtype":"initialize"}}"#;
const NO_CLAUDE: i32 = 127;
/// `initialize` answers in a second or two; a machine slower than this is stopped (I-27).
const TIME_LIMIT_SECS: u64 = 30;
/// Claude can leave `compact` out of the list, and a thread still has it.
const COMPACT: &str = "compact";
const COMPACT_DESCRIPTION: &str = "Free up context by summarizing the conversation so far";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Ssh(#[from] ssh::Error),

    #[error("`{dir}` is not a git work tree on that machine")]
    NotARepo { dir: String },

    #[error("claude is not on that machine: {said}")]
    NoClaude { said: String },

    #[error("the machine answered a command list this build could not read: {said}")]
    Unreadable { said: String },

    #[error(transparent)]
    Workspace(#[from] workspace::Error),

    #[error(transparent)]
    Thread(#[from] delegate::Error),

    #[error("the workspace has no thread `{thread}`")]
    UnknownThread { thread: String },

    #[error("could not determine a directory for ssh control sockets")]
    NoStateDir,
}

/// Claude's commands for workspace `name`: in `thread`'s worktree when one is
/// named, and in the workspace's repository otherwise.
pub async fn for_workspace(name: &str, thread: Option<&str>) -> Result<Vec<Command>, Error> {
    let workspace = workspace::load(name)?;
    let ssh = Ssh::new(ssh::machine_at(&workspace.machine).ok_or(Error::NoStateDir)?)?;
    let dir = match thread {
        None => workspace.repo.to_string_lossy().into_owned(),
        Some(id) => {
            thread::list(&ssh, &workspace)
                .await?
                .into_iter()
                .find(|place| thread::name(place) == id)
                .ok_or_else(|| Error::UnknownThread {
                    thread: id.to_owned(),
                })?
                .worktree
        }
    };
    commands(&ssh, &dir).await
}

/// One remote script (I-26: it rides the base64 envelope, and `dir` is quoted).
pub async fn commands<E: Exec>(exec: &E, dir: &str) -> Result<Vec<Command>, Error> {
    let out = exec.exec(&bounded(&script(dir), TIME_LIMIT_SECS)).await?;
    match out.status {
        NOT_A_REPO => Err(Error::NotARepo {
            dir: dir.to_owned(),
        }),
        NO_CLAUDE => Err(Error::NoClaude {
            said: delegate::said(&out.stderr),
        }),
        TIMED_OUT => Err(Error::Unreadable {
            said: format!("claude did not answer within {TIME_LIMIT_SECS} seconds"),
        }),
        _ => parse(&out.stdout).map_err(|said| Error::Unreadable {
            said: match delegate::said(&out.stderr) {
                stderr if stderr.is_empty() => said,
                stderr => stderr,
            },
        }),
    }
}

/// Claude runs in `dir`, so the project's own commands are listed. No hook
/// runs and no transcript is written, so the thread's `--resume` target stays.
fn script(dir: &str) -> String {
    format!(
        "d={dir}\n\
         git -C \"$d\" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit {NOT_A_REPO}\n\
         cd \"$d\" || exit {NOT_A_REPO}\n\
         c=$({probe}) || {{ echo 'claude was not found on PATH or in any of: {searched}' >&2; exit {NO_CLAUDE}; }}\n\
         printf '%s\\n' {request} | \"$c\" -p --input-format stream-json --output-format stream-json \
         --verbose --no-session-persistence --settings '{{\"disableAllHooks\":true}}'\n",
        dir = destination(dir),
        probe = agent::probe("claude"),
        searched = agent::CANDIDATES.join(", "),
        request = sq(REQUEST),
    )
}

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: String,
    response: Option<Answer>,
}

#[derive(Deserialize)]
struct Answer {
    request_id: Option<String>,
    subtype: Option<String>,
    error: Option<String>,
    response: Option<Initialized>,
}

#[derive(Deserialize)]
struct Initialized {
    #[serde(default)]
    commands: Vec<Listed>,
}

/// Only the three fields the menu draws are named.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Listed {
    name: Option<String>,
    description: Option<String>,
    argument_hint: Option<String>,
}

/// The answer to [`REQUEST_ID`], or why there is none.
fn parse(stdout: &[u8]) -> Result<Vec<Command>, String> {
    let answer = String::from_utf8_lossy(stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Line>(line).ok())
        .filter(|line| line.kind == "control_response")
        .filter_map(|line| line.response)
        .find(|answer| answer.request_id.as_deref() == Some(REQUEST_ID))
        .ok_or_else(|| "claude did not answer the initialize request".to_owned())?;
    if answer.subtype.as_deref() == Some("error") {
        return Err(answer
            .error
            .unwrap_or_else(|| "initialize failed".to_owned()));
    }
    let listed = answer
        .response
        .ok_or_else(|| "the initialize answer has no commands".to_owned())?
        .commands;
    Ok(cleaned(listed))
}

fn cleaned(listed: Vec<Listed>) -> Vec<Command> {
    let text = |value: Option<String>| {
        value
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    // Each lower-cased name, and where its first entry sits in `commands`.
    let mut seen = HashMap::new();
    let mut commands: Vec<Command> = Vec::new();
    for entry in listed {
        let Some(name) = text(entry.name) else {
            continue;
        };
        let description = text(entry.description);
        let hint = text(entry.argument_hint);
        match seen.entry(name.to_lowercase()) {
            Entry::Vacant(slot) => {
                slot.insert(commands.len());
                commands.push(Command {
                    name,
                    description: description.unwrap_or_default(),
                    hint,
                });
            }
            Entry::Occupied(slot) => {
                let first = &mut commands[*slot.get()];
                if first.description.is_empty() {
                    first.description = description.unwrap_or_default();
                }
                first.hint = first.hint.take().or(hint);
            }
        }
    }
    if !seen.contains_key(COMPACT) {
        commands.push(Command {
            name: COMPACT.to_owned(),
            description: COMPACT_DESCRIPTION.to_owned(),
            hint: None,
        });
    }
    commands.sort_by_key(|command| command.name.to_lowercase());
    commands
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    /// claude 2.1.317's answer, cut to three commands and a few other fields.
    const CAPTURED: &str = r#"{"type": "control_response", "response": {"subtype": "success", "request_id": "yantra-commands", "response": {"commands": [{"name": "init", "description": "Initialize a new CLAUDE.md file with codebase documentation", "argumentHint": "", "builtin": true}, {"name": "compact", "description": "Free up context by summarizing the conversation so far", "argumentHint": "<optional custom summarization instructions>", "builtin": true}, {"name": "accessibility", "description": "Audit and improve web accessibility following WCAG 2.2 guidelines. (user)", "argumentHint": ""}], "agents": [], "output_style": "default", "pid": 1}, "pending_permission_requests": [], "pending_user_dialog_requests": []}}"#;

    fn command(name: &str, description: &str, hint: Option<&str>) -> Command {
        Command {
            name: name.to_owned(),
            description: description.to_owned(),
            hint: hint.map(str::to_owned),
        }
    }

    #[test]
    fn the_captured_answer_gives_the_commands_sorted() {
        assert_eq!(
            parse(CAPTURED.as_bytes()).expect("a list"),
            [
                command(
                    "accessibility",
                    "Audit and improve web accessibility following WCAG 2.2 guidelines. (user)",
                    None
                ),
                command(
                    "compact",
                    COMPACT_DESCRIPTION,
                    Some("<optional custom summarization instructions>")
                ),
                command(
                    "init",
                    "Initialize a new CLAUDE.md file with codebase documentation",
                    None
                ),
            ]
        );
    }

    #[test]
    fn a_duplicate_is_settled_by_case_and_compact_is_always_there() {
        let answer = serde_json::json!({"type": "control_response", "response": {
        "subtype": "success", "request_id": REQUEST_ID, "response": {"commands": [
            {"name": "Review", "description": ""},
            {"name": "review", "description": "Reviews a PR", "argumentHint": "<pr>"},
            {"name": "review", "description": "later", "argumentHint": "later"},
            {"name": "  ", "description": "no name"},
            {"description": "no name at all"},
        ]}}});
        let other = r#"{"type":"system","subtype":"init"}"#;
        assert_eq!(
            parse(format!("{other}\nnot json\n{answer}\n").as_bytes()).expect("a list"),
            [
                command(COMPACT, COMPACT_DESCRIPTION, None),
                command("Review", "Reviews a PR", Some("<pr>")),
            ]
        );
    }

    #[test]
    fn no_answer_a_garbled_one_and_a_refusal_are_unreadable() {
        assert!(parse(b"").is_err());
        assert!(parse(b"{\"type\":\"control_response\"").is_err());
        let other_id = CAPTURED.replace(REQUEST_ID, "someone-else");
        assert!(parse(other_id.as_bytes()).is_err());
        let refused = r#"{"type":"control_response","response":{"subtype":"error","request_id":"yantra-commands","error":"Not ready"}}"#;
        assert_eq!(parse(refused.as_bytes()), Err("Not ready".to_owned()));
    }

    #[test]
    fn the_script_is_quoted_and_keeps_nothing() {
        let script = script("/srv/it's");
        assert!(script.starts_with("d='/srv/it'\\''s'\n"), "{script}");
        assert!(super::script("~/repo").starts_with("d=\"$HOME\"/'repo'\n"));
        for flag in [
            "--input-format stream-json",
            "--output-format stream-json",
            "--no-session-persistence",
            "disableAllHooks",
            "\"subtype\":\"initialize\"",
            "exit 127",
        ] {
            assert!(script.contains(flag), "{flag}: {script}");
        }
    }

    /// Answers every command with one output, and keeps the last command sent.
    struct Answered(ssh::Output, std::sync::Mutex<String>);

    impl Exec for Answered {
        async fn exec(&self, command: &str) -> Result<ssh::Output, ssh::Error> {
            *self.1.lock().expect("not poisoned") = command.to_owned();
            Ok(self.0.clone())
        }
    }

    fn answered(status: i32, stdout: &str, stderr: &str) -> Answered {
        let output = ssh::Output {
            status,
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        };
        Answered(output, std::sync::Mutex::default())
    }

    #[tokio::test]
    async fn the_probe_runs_under_the_bound() {
        let machine = answered(0, CAPTURED, "");
        commands(&machine, "/r").await.expect("a list");
        let sent = machine.1.lock().expect("not poisoned").clone();
        assert_eq!(sent, bounded(&script("/r"), TIME_LIMIT_SECS));
        assert!(sent.contains("sleep 30"), "{sent}");
    }

    #[tokio::test]
    async fn each_failure_is_typed() {
        assert!(matches!(
            commands(&answered(NOT_A_REPO, "", ""), "/tmp").await,
            Err(Error::NotARepo { dir }) if dir == "/tmp"
        ));
        assert!(matches!(
            commands(&answered(NO_CLAUDE, "", "claude was not found\n"), "/r").await,
            Err(Error::NoClaude { said }) if said == "claude was not found"
        ));
        assert!(matches!(
            commands(&answered(TIMED_OUT, "", ""), "/r").await,
            Err(Error::Unreadable { said }) if said.contains("30 seconds")
        ));
        assert!(matches!(
            commands(&answered(1, "", "Error: bad flag\n"), "/r").await,
            Err(Error::Unreadable { said }) if said == "Error: bad flag"
        ));
        assert_eq!(
            commands(&answered(0, CAPTURED, ""), "/r")
                .await
                .expect("a list")
                .len(),
            3
        );
    }
}
