/*
 * The tool shapes below follow T3 Code's orchestrator MCP server, at commit 72d5c32:
 * https://github.com/pingdotgg/t3code/blob/72d5c32ba67953805feb6fe9ad3b70b632a64c47/docs/orchestration-v2/orchestrator-mcp-server.md
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 *
 * Kept: a steer to a running ACP turn is a cancel and a restart in the same session, and one sent
 * before the turn begins waits for it (`t3_thread_send`'s `auto`); a wait takes `timeoutMs`,
 * answers `waitTimedOut` and never cancels the task; a cancel of an ended task returns its state
 * (`task_cancel`). Changed: the tasks are the daemon's, not threads; a steer to an ended task is
 * refused, and a cancel has no child tasks to reach.
 */
//! `yantra mcp`: a stdio MCP server whose tools call `yantrad`'s `/api/tasks`,
//! so the main agent can delegate work (ADR-0033 decision 5).
//!
//! JSON-RPC 2.0, one message per line. **Stdout carries protocol and nothing
//! else**, because the client reads every byte there as a message.

use std::io::{self, BufRead, Write};
use std::time::Duration;

use serde_json::{Value, json};
use yantra_core::delegate;

const PARSE_ERROR: i64 = -32700;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
/// Starting a task connects to the machine and makes a worktree; stopping one
/// waits up to ten seconds for its turn to end.
const TIMEOUT: Duration = Duration::from_secs(60);
/// The MCP revisions this server speaks, newest first.
const SUPPORTED: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// What a wait's answer may take beyond the wait itself.
const WAIT_SLACK: Duration = Duration::from_secs(30);

/// Answers requests from `input` until it ends.
pub fn serve(daemon: &str, mut input: impl BufRead, mut output: impl Write) -> io::Result<()> {
    let daemon = Daemon::new(daemon);
    let mut line = Vec::new();
    loop {
        line.clear();
        // Bytes, not `lines()`: a line that is not UTF-8 is a parse error, not the end.
        if input.read_until(b'\n', &mut line)? == 0 {
            return Ok(());
        }
        if line.trim_ascii().is_empty() {
            continue;
        }
        if let Some(answer) = answer(&daemon, &line) {
            writeln!(output, "{answer}")?;
            output.flush()?;
        }
    }
}

fn answer(daemon: &Daemon, line: &[u8]) -> Option<Value> {
    let Ok(message) = serde_json::from_slice::<Value>(line) else {
        return Some(error(&Value::Null, PARSE_ERROR, "Parse error"));
    };
    // A notification, or a response to nothing this server asked, gets no answer.
    let id = message.get("id")?;
    let method = message.get("method")?.as_str()?;
    let params = message.get("params").unwrap_or(&Value::Null);
    Some(match method {
        "initialize" => {
            // The MCP lifecycle: echo a version this server speaks, else offer its newest.
            let version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .and_then(|asked| SUPPORTED.into_iter().find(|known| *known == asked))
                .unwrap_or(SUPPORTED[0]);
            result(
                id,
                json!({"protocolVersion": version,
                       "capabilities": {"tools": {}},
                       "serverInfo": {"name": "yantra", "version": env!("CARGO_PKG_VERSION")}}),
            )
        }
        "ping" => result(id, json!({})),
        "tools/list" => result(id, json!({"tools": tools()})),
        "tools/call" => match call(daemon, params) {
            Ok(said) => result(id, said),
            Err(why) => error(id, INVALID_PARAMS, &why),
        },
        _ => error(id, METHOD_NOT_FOUND, "Method not found"),
    })
}

fn result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn tools() -> Value {
    let id = json!({"type": "object", "required": ["id"], "additionalProperties": false,
                    "properties": {"id": {"type": "string", "description": "The task id start_task returned"}}});
    json!([
        {"name": "start_task",
         "description": "Start a coding agent on a fleet machine. It works alone in a new git worktree \
                         of the repository, on a new branch, and answers its own permission requests. \
                         Returns the task id, the worktree and the branch.",
         "inputSchema": {"type": "object", "additionalProperties": false,
             "required": ["machine", "harness", "repo", "prompt"],
             "properties": {
                 "machine": {"type": "string", "description": "The machine, as ssh names it"},
                 "harness": {"type": "string", "enum": ["codex", "gemini", "grok", "opencode"]},
                 "repo": {"type": "string", "description": "A directory in a git repository on that machine: absolute, or ~/…"},
                 "prompt": {"type": "string", "description": "The task, as the agent will read it"}}}},
        {"name": "task_status",
         "description": "Read a task's state (starting, running, completed, cancelled or failed), \
                         the agent's last message, and the worktree's diff summary once the turn has ended.",
         "inputSchema": id},
        {"name": "list_tasks",
         "description": "List the tasks the daemon holds, with their state.",
         "inputSchema": {"type": "object", "additionalProperties": false, "properties": {}}},
        {"name": "steer_task",
         "description": "Send a task's agent a follow-up prompt. A running turn is cancelled and the prompt \
                         starts a new turn in the same session, so the agent keeps its context. A task that \
                         has not begun its first turn gets the prompt when that turn ends. A task that has \
                         ended refuses it.",
         "inputSchema": {"type": "object", "additionalProperties": false, "required": ["id", "prompt"],
             "properties": {
                 "id": id["properties"]["id"],
                 "prompt": {"type": "string", "description": "What the agent reads next"}}}},
        {"name": "wait_task",
         "description": "Wait for a task to end, then return what task_status returns, with waitTimedOut. \
                         A timeout does not cancel the task; wait again or read task_status.",
         "inputSchema": {"type": "object", "additionalProperties": false, "required": ["id"],
             "properties": {
                 "id": id["properties"]["id"],
                 "timeoutMs": {"type": "integer", "minimum": 0,
                               "description": "How long to wait, in milliseconds: 60000 if left out, 600000 at most"}}}},
        {"name": "cancel_task",
         "description": "Cancel a task's turn and end its agent. The worktree stays, so its diff can be reviewed. \
                         A task that has already ended returns its state.",
         "inputSchema": id},
        {"name": "remove_task",
         "description": "Stop a task, then delete its worktree and its branch on the machine.",
         "inputSchema": id},
    ])
}

/// A tool's answer, or why the call itself was malformed.
fn call(daemon: &Daemon, params: &Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or("tools/call needs a tool name")?;
    let arguments = params.get("arguments").unwrap_or(&Value::Null);
    let task = || -> Result<&str, String> {
        arguments
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()))
            .ok_or_else(|| format!("{name} needs the id start_task returned"))
    };
    let said = match name {
        "start_task" => {
            let field = |key: &str| -> Result<Value, String> {
                arguments
                    .get(key)
                    .filter(|value| value.is_string())
                    .cloned()
                    .ok_or_else(|| format!("start_task needs `{key}`"))
            };
            let body = json!({"machine": field("machine")?, "harness": field("harness")?,
                              "repo": field("repo")?, "prompt": field("prompt")?});
            daemon.send(Method::Post(Some(body)), "/api/tasks")
        }
        "task_status" => daemon.send(Method::Get, &format!("/api/tasks/{}", task()?)),
        "list_tasks" => daemon.send(Method::Get, "/api/tasks"),
        "steer_task" => {
            let prompt = arguments
                .get("prompt")
                .and_then(Value::as_str)
                .filter(|prompt| !prompt.trim().is_empty())
                .ok_or("steer_task needs a `prompt`")?;
            let path = format!("/api/tasks/{}/steer", task()?);
            daemon.send(Method::Post(Some(json!({"prompt": prompt}))), &path)
        }
        "wait_task" => {
            let ms = arguments
                .get("timeoutMs")
                .map(|ms| {
                    ms.as_u64()
                        .ok_or("wait_task's `timeoutMs` is a whole number of milliseconds")
                })
                .transpose()?;
            let (path, wait) = match ms {
                Some(ms) => (
                    format!("/api/tasks/{}/wait?timeoutMs={ms}", task()?),
                    Duration::from_millis(ms).min(delegate::WAIT_LIMIT),
                ),
                None => (format!("/api/tasks/{}/wait", task()?), delegate::WAIT),
            };
            daemon.send(Method::Wait(wait + WAIT_SLACK), &path)
        }
        "cancel_task" => daemon.send(Method::Post(None), &format!("/api/tasks/{}/stop", task()?)),
        "remove_task" => daemon.send(Method::Delete, &format!("/api/tasks/{}", task()?)),
        _ => return Err(format!("no tool `{name}`")),
    };
    let is_error = said.is_err();
    let (Ok(text) | Err(text)) = said;
    Ok(json!({"content": [{"type": "text", "text": text}], "isError": is_error}))
}

enum Method {
    Get,
    /// A `GET` that may take this long, past the usual [`TIMEOUT`].
    Wait(Duration),
    Post(Option<Value>),
    Delete,
}

struct Daemon {
    base: String,
    agent: ureq::Agent,
}

impl Daemon {
    fn new(base: &str) -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(TIMEOUT))
            .build()
            .into();
        Self {
            base: base.trim_end_matches('/').to_owned(),
            agent,
        }
    }

    /// The daemon's answer, or what went wrong in words the main agent can act on.
    fn send(&self, method: Method, path: &str) -> Result<String, String> {
        let url = format!("{}{path}", self.base);
        let sent = match method {
            Method::Get => self.agent.get(&url).call(),
            Method::Wait(limit) => self
                .agent
                .get(&url)
                .config()
                .timeout_global(Some(limit))
                .build()
                .call(),
            Method::Delete => self.agent.delete(&url).call(),
            Method::Post(None) => self.agent.post(&url).send_empty(),
            Method::Post(Some(body)) => self
                .agent
                .post(&url)
                .header("content-type", "application/json")
                .send(body.to_string()),
        };
        let mut response =
            sent.map_err(|error| format!("could not reach yantrad at {}: {error}", self.base))?;
        let status = response.status();
        let body = response.body_mut().read_to_string().map_err(|error| {
            format!(
                "yantrad at {} sent an unreadable answer: {error}",
                self.base
            )
        })?;
        if status.is_success() {
            Ok(body)
        } else {
            Err(format!(
                "yantrad answered {}: {}",
                status.as_u16(),
                body.trim()
            ))
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::extract::{Path, RawQuery};
    use axum::http::StatusCode;
    use axum::routing::{get, post};

    async fn fake_daemon() -> String {
        async fn start(axum::Json(body): axum::Json<Value>) -> (StatusCode, String) {
            if body["harness"] == "opencode" {
                let started = json!({"id": "ab12cd34", "machine": body["machine"],
                    "harness": "opencode", "repo": body["repo"],
                    "worktree": "/home/u/.yantra/worktrees/ab12cd34", "branch": "yantra/ab12cd34"});
                (StatusCode::CREATED, started.to_string())
            } else {
                (
                    StatusCode::BAD_REQUEST,
                    "`claude` is not a harness Yantra drives over ACP".to_owned(),
                )
            }
        }
        async fn one(Path(id): Path<String>) -> (StatusCode, String) {
            if id == "ab12cd34" {
                (
                    StatusCode::OK,
                    json!({"id": id, "state": "completed", "lastMessage": "Fixed it.",
                           "summary": {"changed": ["a.rs"], "shortstat": "1 file changed"}})
                    .to_string(),
                )
            } else {
                (StatusCode::NOT_FOUND, format!("no task `{id}`"))
            }
        }
        let app = Router::new()
            .route(
                "/api/tasks",
                post(start).get(|| async { r#"[{"id":"ab12cd34","state":"running"}]"# }),
            )
            .route(
                "/api/tasks/{id}",
                get(one).delete(|Path(id): Path<String>| async move {
                    if id == "ab12cd34" {
                        (StatusCode::OK, r#"{"removed":true}"#.to_owned())
                    } else {
                        (StatusCode::NOT_FOUND, format!("no task `{id}`"))
                    }
                }),
            )
            .route("/api/tasks/{id}/stop", post(one))
            .route(
                "/api/tasks/{id}/steer",
                post(
                    |Path(id): Path<String>, axum::Json(body): axum::Json<Value>| async move {
                        if id == "ab12cd34" {
                            (
                                StatusCode::OK,
                                json!({"id": id, "steered": body}).to_string(),
                            )
                        } else {
                            (StatusCode::CONFLICT, format!("task `{id}` has ended"))
                        }
                    },
                ),
            )
            .route(
                "/api/tasks/{id}/wait",
                get(
                    |Path(id): Path<String>, RawQuery(query): RawQuery| async move {
                        json!({"id": id, "query": query, "waitTimedOut": false}).to_string()
                    },
                ),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port");
        let address = listener.local_addr().expect("an address");
        tokio::spawn(async move { axum::serve(listener, app).await });
        format!("http://{address}/")
    }

    /// Every line written, parsed.
    async fn exchange(daemon: String, lines: Vec<Value>) -> Vec<Value> {
        let input: String = lines.iter().map(|line| format!("{line}\n")).collect();
        tokio::task::spawn_blocking(move || {
            let mut output = Vec::new();
            serve(&daemon, input.as_bytes(), &mut output).expect("stdin ends cleanly");
            String::from_utf8(output)
                .expect("UTF-8")
                .lines()
                .map(|line| serde_json::from_str(line).expect("every line is one JSON message"))
                .collect()
        })
        .await
        .expect("the server thread")
    }

    async fn one_call(daemon: String, name: &str, arguments: Value) -> Value {
        let answers = exchange(
            daemon,
            vec![json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                        "params": {"name": name, "arguments": arguments}})],
        )
        .await;
        answers[0]["result"].clone()
    }

    fn text(result: &Value) -> &str {
        result["content"][0]["text"].as_str().expect("a text block")
    }

    #[tokio::test]
    async fn the_handshake_echoes_the_version_and_lists_seven_tools() {
        let answers = exchange(
            fake_daemon().await,
            vec![
                json!({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                       "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                  "clientInfo": {"name": "claude-code", "version": "2"}}}),
                json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
                json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            ],
        )
        .await;
        assert_eq!(
            answers.len(),
            2,
            "a notification gets no answer: {answers:?}"
        );
        assert_eq!(answers[0]["id"], 0);
        assert_eq!(answers[0]["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(answers[0]["result"]["capabilities"], json!({"tools": {}}));
        let names: Vec<&str> = answers[1]["result"]["tools"]
            .as_array()
            .expect("a list")
            .iter()
            .map(|tool| {
                assert_eq!(tool["inputSchema"]["type"], "object", "{tool}");
                tool["name"].as_str().expect("a name")
            })
            .collect();
        assert_eq!(
            names,
            [
                "start_task",
                "task_status",
                "list_tasks",
                "steer_task",
                "wait_task",
                "cancel_task",
                "remove_task"
            ]
        );
        let tools = &answers[1]["result"]["tools"];
        assert_eq!(tools[3]["inputSchema"]["required"], json!(["id", "prompt"]));
        assert_eq!(
            tools[4]["inputSchema"]["properties"]["timeoutMs"],
            json!({"type": "integer", "minimum": 0,
                   "description": "How long to wait, in milliseconds: 60000 if left out, 600000 at most"})
        );
    }

    #[tokio::test]
    async fn initialize_offers_its_newest_version_for_one_it_does_not_speak() {
        let initialize = |id: u64, params: Value| json!({"jsonrpc": "2.0", "id": id, "method": "initialize", "params": params});
        let answers = exchange(
            fake_daemon().await,
            vec![
                initialize(0, json!({"protocolVersion": "2024-11-05"})),
                initialize(1, json!({"protocolVersion": "1999-01-01"})),
                initialize(2, json!({})),
                initialize(3, json!({"protocolVersion": 7})),
            ],
        )
        .await;
        let versions: Vec<&Value> = answers
            .iter()
            .map(|answer| &answer["result"]["protocolVersion"])
            .collect();
        assert_eq!(
            versions,
            ["2024-11-05", "2025-11-25", "2025-11-25", "2025-11-25"]
        );
    }

    /// One bad line costs one parse error, and the next request is answered.
    #[tokio::test]
    async fn a_line_that_is_not_utf8_is_a_parse_error_and_serving_goes_on() {
        let daemon = fake_daemon().await;
        let mut input = b"\xff\xfe\n".to_vec();
        input.extend_from_slice(
            format!("{}\n", json!({"jsonrpc": "2.0", "id": 9, "method": "ping"})).as_bytes(),
        );
        let output = tokio::task::spawn_blocking(move || {
            let mut output = Vec::new();
            serve(&daemon, input.as_slice(), &mut output).map(|()| output)
        })
        .await
        .expect("the server thread")
        .expect("serve returns Ok");
        let answers: Vec<Value> = String::from_utf8(output)
            .expect("UTF-8")
            .lines()
            .map(|line| serde_json::from_str(line).expect("JSON"))
            .collect();
        assert_eq!(
            answers,
            [
                error(&Value::Null, PARSE_ERROR, "Parse error"),
                result(&json!(9), json!({})),
            ]
        );
    }

    #[tokio::test]
    async fn each_tool_returns_the_daemons_answer() {
        let daemon = fake_daemon().await;
        let started = one_call(
            daemon.clone(),
            "start_task",
            json!({"machine": "pi", "harness": "opencode", "repo": "~/r", "prompt": "fix it"}),
        )
        .await;
        assert_eq!(started["isError"], false, "{started}");
        let body: Value = serde_json::from_str(text(&started)).expect("JSON");
        assert_eq!(body["branch"], "yantra/ab12cd34");
        assert_eq!(body["repo"], "~/r");

        let status = one_call(daemon.clone(), "task_status", json!({"id": "ab12cd34"})).await;
        assert!(text(&status).contains("Fixed it."), "{status}");
        let listed = one_call(daemon.clone(), "list_tasks", json!({})).await;
        assert!(text(&listed).contains("running"), "{listed}");
        let stopped = one_call(daemon.clone(), "cancel_task", json!({"id": "ab12cd34"})).await;
        assert!(text(&stopped).contains("completed"), "{stopped}");
        let removed = one_call(daemon, "remove_task", json!({"id": "ab12cd34"})).await;
        assert_eq!(text(&removed), r#"{"removed":true}"#);
        assert_eq!(removed["isError"], false);
    }

    #[tokio::test]
    async fn a_refusal_from_the_daemon_is_a_tool_error_carrying_its_words() {
        let daemon = fake_daemon().await;
        for (name, arguments) in [
            ("task_status", json!({"id": "ffff0000"})),
            ("cancel_task", json!({"id": "ffff0000"})),
            ("remove_task", json!({"id": "ffff0000"})),
        ] {
            let refused = one_call(daemon.clone(), name, arguments).await;
            assert_eq!(refused["isError"], true, "{refused}");
            assert_eq!(text(&refused), "yantrad answered 404: no task `ffff0000`");
        }
        let refused = one_call(
            daemon,
            "start_task",
            json!({"machine": "pi", "harness": "claude", "repo": "~/r", "prompt": "x"}),
        )
        .await;
        assert_eq!(refused["isError"], true);
        assert!(
            text(&refused).starts_with("yantrad answered 400: `claude`"),
            "{refused}"
        );
    }

    #[tokio::test]
    async fn steer_and_wait_reach_their_routes_with_the_body_and_the_query() {
        let daemon = fake_daemon().await;
        let steered = one_call(
            daemon.clone(),
            "steer_task",
            json!({"id": "ab12cd34", "prompt": "and the docs"}),
        )
        .await;
        assert_eq!(steered["isError"], false, "{steered}");
        let body: Value = serde_json::from_str(text(&steered)).expect("JSON");
        assert_eq!(body["steered"], json!({"prompt": "and the docs"}));

        let waited = one_call(
            daemon.clone(),
            "wait_task",
            json!({"id": "ab12cd34", "timeoutMs": 1500}),
        )
        .await;
        let body: Value = serde_json::from_str(text(&waited)).expect("JSON");
        assert_eq!(body["query"], "timeoutMs=1500", "{waited}");
        assert_eq!(body["waitTimedOut"], false);
        let waited = one_call(daemon, "wait_task", json!({"id": "ab12cd34"})).await;
        let body: Value = serde_json::from_str(text(&waited)).expect("JSON");
        assert_eq!(body["query"], Value::Null, "the daemon's default: {waited}");
    }

    #[tokio::test]
    async fn a_steer_to_an_ended_task_is_a_tool_error_carrying_the_daemons_words() {
        let refused = one_call(
            fake_daemon().await,
            "steer_task",
            json!({"id": "ffff0000", "prompt": "more"}),
        )
        .await;
        assert_eq!(refused["isError"], true, "{refused}");
        assert_eq!(
            text(&refused),
            "yantrad answered 409: task `ffff0000` has ended"
        );
    }

    #[tokio::test]
    async fn a_steer_with_no_prompt_or_a_wait_with_a_bad_timeout_is_invalid_params() {
        let daemon = fake_daemon().await;
        let calls = [
            ("steer_task", json!({"id": "ab12cd34"})),
            ("steer_task", json!({"id": "ab12cd34", "prompt": "  "})),
            ("wait_task", json!({"id": "ab12cd34", "timeoutMs": -1})),
            ("wait_task", json!({"id": "ab12cd34", "timeoutMs": 1.5})),
            ("wait_task", json!({"id": "ab12cd34", "timeoutMs": "soon"})),
        ];
        let lines = calls
            .iter()
            .enumerate()
            .map(|(id, (name, arguments))| {
                json!({"jsonrpc": "2.0", "id": id, "method": "tools/call",
                       "params": {"name": name, "arguments": arguments}})
            })
            .collect();
        let answers = exchange(daemon, lines).await;
        assert_eq!(answers.len(), calls.len());
        for (answer, (name, arguments)) in answers.iter().zip(&calls) {
            assert_eq!(
                answer["error"]["code"], INVALID_PARAMS,
                "{name} {arguments}: {answer}"
            );
        }
    }

    #[tokio::test]
    async fn a_daemon_that_cannot_be_reached_is_named() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("an address");
        drop(listener);
        let refused = one_call(format!("http://{address}"), "list_tasks", json!({})).await;
        assert_eq!(refused["isError"], true);
        assert!(
            text(&refused).starts_with(&format!("could not reach yantrad at http://{address}: ")),
            "{refused}"
        );
    }

    #[tokio::test]
    async fn malformed_input_unknown_methods_and_bad_arguments_are_json_rpc_errors() {
        let daemon = fake_daemon().await;
        let input = "{not json\n".to_owned()
            + &[
                json!({"jsonrpc": "2.0", "id": 2, "method": "resources/list"}),
                json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                       "params": {"name": "rm_rf", "arguments": {}}}),
                json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                       "params": {"name": "task_status", "arguments": {"id": "../machines"}}}),
                json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                       "params": {"name": "start_task", "arguments": {"machine": "pi"}}}),
            ]
            .iter()
            .map(|line| format!("{line}\n"))
            .collect::<String>();
        let answers: Vec<Value> = tokio::task::spawn_blocking(move || {
            let mut output = Vec::new();
            serve(&daemon, input.as_bytes(), &mut output).expect("stdin ends cleanly");
            String::from_utf8(output)
                .expect("UTF-8")
                .lines()
                .map(|line| serde_json::from_str(line).expect("JSON"))
                .collect()
        })
        .await
        .expect("the server thread");
        let codes: Vec<(Value, i64)> = answers
            .iter()
            .map(|answer| {
                (
                    answer["id"].clone(),
                    answer["error"]["code"].as_i64().expect("an error"),
                )
            })
            .collect();
        assert_eq!(
            codes,
            [
                (Value::Null, PARSE_ERROR),
                (json!(2), METHOD_NOT_FOUND),
                (json!(3), INVALID_PARAMS),
                (json!(4), INVALID_PARAMS),
                (json!(5), INVALID_PARAMS),
            ]
        );
        assert_eq!(answers[4]["error"]["message"], "start_task needs `harness`");
    }
}
