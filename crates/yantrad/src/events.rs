//! The last events this daemon would have pushed, in memory
//! ([ADR-0025], Y-343).
//!
//! A ring of [`CAPACITY`] beside the beats: filled by the same path that sends
//! to the relay, **before** the send, so a dropped send is still a remembered
//! event — and by the machines sweep when a machine stops being online. Nothing
//! is written to disk, so a restart empties it, which the page says rather
//! than hides (I-59). Read and unread are the browser's.
//!
//! [ADR-0025]: ../../../docs/adr/0025-the-daemon-remembers-what-it-pushed.md

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::RwLock;
use yantra_core::install::{self, Outcome};
use yantra_core::notify::Notification;
use yantra_core::status::{Fleet, Verdict};

pub const CAPACITY: usize = 50;

pub type Events = Arc<RwLock<VecDeque<Event>>>;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Event {
    /// Unix seconds, when this daemon saw it.
    pub at: u64,
    /// A verdict as `/workspaces/{name}/status` spells it, `unreachable`, or
    /// `relay-test`.
    pub kind: &'static str,
    pub workspace: Option<String>,
    pub machine: Option<String>,
    /// The sentence the relay was, or would have been, sent.
    pub said: String,
}

impl Event {
    /// The relay's notification as an event, with the machine the fleet
    /// reading names for that workspace.
    pub fn of(notification: &Notification, fleet: &Fleet) -> Self {
        let machine = fleet
            .machines
            .iter()
            .find(|machine| {
                machine
                    .workspaces
                    .iter()
                    .any(|workspace| workspace.name == notification.workspace)
            })
            .map(|machine| machine.machine.clone());
        Self {
            at: now(),
            kind: kind(&notification.verdict),
            workspace: Some(notification.workspace.clone()),
            machine,
            said: notification.to_string(),
        }
    }

    pub fn unreachable(machine: &str) -> Self {
        Self {
            at: now(),
            kind: "unreachable",
            workspace: None,
            machine: Some(machine.to_owned()),
            said: format!("{machine} is no longer online"),
        }
    }

    pub fn relay_test() -> Self {
        Self {
            at: now(),
            kind: "relay-test",
            workspace: None,
            machine: None,
            said: yantra_core::notify::test_message().body,
        }
    }

    /// ADR-0028 §4: what an install did, and the command for whatever it left
    /// to a person. `installed` only when every basic is there now.
    pub fn install(report: &install::Report) -> Self {
        let mut parts = Vec::new();
        let mut commands: Vec<&str> = Vec::new();
        for step in &report.steps {
            match &step.outcome {
                Outcome::Present => {}
                Outcome::Installed => parts.push(format!("{} installed", step.tool)),
                Outcome::ForYou { because, command } => {
                    parts.push(format!("{} left for you: {because}", step.tool));
                    if let Some(command) = command.as_deref()
                        && !commands.contains(&command)
                    {
                        commands.push(command);
                    }
                }
                Outcome::Failed { output } => parts.push(format!(
                    "{} did not install: {}",
                    step.tool,
                    last(output, SAID_OUTPUT)
                )),
            }
        }
        if parts.is_empty() {
            parts.push("every basic was already there".to_owned());
        }
        let mut said = format!("{}: {}", report.machine, parts.join("; "));
        for command in commands {
            said.push_str(&format!(" — run `{command}` on {}", report.machine));
        }
        Self {
            at: now(),
            kind: if report.complete() {
                "installed"
            } else {
                "install_stopped"
            },
            workspace: None,
            machine: Some(report.machine.clone()),
            said,
        }
    }

    /// An install that could not be asked, or ran out of time.
    pub fn install_failed(machine: &str, reason: &str) -> Self {
        Self {
            at: now(),
            kind: "install_stopped",
            workspace: None,
            machine: Some(machine.to_owned()),
            said: format!("{machine}: the install did not finish: {reason}"),
        }
    }
}

/// How much of a failed installer's output a notification carries. The
/// library keeps more; a sentence on a phone needs the last line or two.
const SAID_OUTPUT: usize = 300;

fn last(text: &str, bytes: usize) -> &str {
    let mut from = text.len().saturating_sub(bytes);
    while !text.is_char_boundary(from) {
        from += 1;
    }
    &text[from..]
}

/// The same spelling as `AgentState` on `/workspaces/{name}/status`, so a
/// page has one vocabulary for a verdict.
fn kind(verdict: &Verdict) -> &'static str {
    match verdict {
        Verdict::NoSession => "no_session",
        Verdict::Running => "running",
        Verdict::Finished => "finished",
        Verdict::Stopped => "stopped",
        Verdict::Crashed { .. } => "crashed",
        Verdict::Killed { .. } => "killed",
        Verdict::NoAgent => "no_agent",
        Verdict::AwaitingTrust => "awaiting_trust",
        Verdict::Unclear { .. } => "unclear",
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or_default()
}

/// The oldest goes when the ring is full: a bound, not a queue.
pub async fn remember(events: &Events, event: Event) {
    let mut held = events.write().await;
    if held.len() == CAPACITY {
        held.pop_front();
    }
    held.push_back(event);
}

pub async fn newest_first(events: &Events) -> Vec<Event> {
    events.read().await.iter().rev().cloned().collect()
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn nth(n: usize) -> Event {
        Event {
            at: n as u64,
            kind: "finished",
            workspace: Some(format!("w{n}")),
            machine: None,
            said: format!("w{n}: finished"),
        }
    }

    /// ADR-0025's bound: fifty, and the oldest is what goes.
    #[tokio::test]
    async fn the_ring_holds_fifty_and_drops_the_oldest() {
        let events = Events::default();
        for n in 0..CAPACITY + 3 {
            remember(&events, nth(n)).await;
        }

        let listed = newest_first(&events).await;
        assert_eq!(listed.len(), CAPACITY);
        assert_eq!(listed[0], nth(CAPACITY + 2), "newest first");
        assert_eq!(listed[CAPACITY - 1], nth(3), "0, 1 and 2 are gone");
    }

    /// Two tools share one command, and the sentence names it once. The kind
    /// is `installed` only when nothing is left for a person.
    #[test]
    fn an_install_names_what_it_left_and_the_command_once() {
        use yantra_core::install::{Because, Report, Step, Tool};
        let left = Outcome::ForYou {
            because: Because::NeedsRoot,
            command: Some("sudo apk add tmux git".to_owned()),
        };
        let stopped = Event::install(&Report {
            machine: "pi".to_owned(),
            steps: vec![
                Step {
                    tool: Tool::Tmux,
                    outcome: left.clone(),
                },
                Step {
                    tool: Tool::Git,
                    outcome: left,
                },
                Step {
                    tool: Tool::Claude,
                    outcome: Outcome::Installed,
                },
            ],
        });
        assert_eq!(stopped.kind, "install_stopped");
        assert_eq!(stopped.machine.as_deref(), Some("pi"));
        assert_eq!(
            stopped.said.matches("sudo apk add tmux git").count(),
            1,
            "{}",
            stopped.said
        );
        assert!(
            stopped.said.contains("claude installed"),
            "{}",
            stopped.said
        );

        let done = Event::install(&Report {
            machine: "pi".to_owned(),
            steps: vec![Step {
                tool: Tool::Git,
                outcome: Outcome::Present,
            }],
        });
        assert_eq!(done.kind, "installed");
    }

    #[test]
    fn the_capacity_is_the_adrs() {
        assert_eq!(CAPACITY, 50);
    }
}
