//! The difference between two consecutive looks at the fleet, and the channel
//! that difference goes out on.
//!
//! **A notifier is a diff of consecutive snapshots and nothing more** — no poll,
//! no ssh, no timer of its own ([the M7 plan] §3.6). [`Verdict`] is the whole
//! vocabulary, and a telemetry threshold is not: ADR-0013's non-goals name this
//! milestone by hand — *whatever M7 sends over ntfy is about sessions, not about
//! a CPU crossing a line.*
//!
//! Two rules follow from the daemon persisting nothing, and both are the
//! difference between a useful notifier and one that gets muted in a week:
//!
//! - **The first look after a start says nothing.** There is no previous state
//!   to diff against, and a [`None`] read as *everything just changed* means
//!   every reboot mails a report about every session on the fleet.
//! - **A failed send drops that notification.** No queue, no retry, no replay —
//!   a queue is state on a box whose whole point is that it holds none.
//!
//! **Q16 was answered wider than it was asked** (Y-147): the relay is a general
//! publish channel and the fleet notifier is only its first caller. Anything
//! with something to say sends a [`Message`]; [`Notification`] renders into one
//! rather than being the only thing sendable. Yantra ships the mechanism and
//! invents no content, so what a relay is told is decided by whoever called and
//! by the URL the operator chose.
//!
//! [the M7 plan]: ../../../docs/plans/m7-appliance.md

use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

use crate::status::{Fleet, Verdict};

/// Shorter than any interval a caller would look on, because the caller waits
/// for this and a relay that is a black hole must not push the next look out.
const TIMEOUT: Duration = Duration::from_secs(3);

/// One workspace, and what it now is. **The two fields are the whole of what the
/// fleet notifier says**, which is the shape Q16's prior asked for and is now one
/// caller's choice rather than the channel's limit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    pub workspace: String,
    pub verdict: Verdict,
}

impl fmt::Display for Notification {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.workspace, phrase(&self.verdict))
    }
}

impl Notification {
    pub fn message(&self) -> Message {
        Message {
            body: self.to_string(),
            title: None,
            priority: None,
        }
    }
}

/// Every variant is named rather than wildcarded, so a new [`Verdict`] has to be
/// worded here before it can be sent anywhere.
fn phrase(verdict: &Verdict) -> String {
    match verdict {
        Verdict::AwaitingTrust => "waiting at claude's trust prompt".to_owned(),
        Verdict::Running => "running".to_owned(),
        Verdict::Finished => "finished".to_owned(),
        Verdict::Stopped => "stopped cleanly".to_owned(),
        Verdict::Crashed { status } => format!("crashed (exit {status})"),
        Verdict::Killed { signal } => format!("killed by SIG{signal}"),
        Verdict::NoSession => "the session is gone".to_owned(),
        Verdict::NoAgent => "no agent — the session was opened as a shell".to_owned(),
        Verdict::Unclear { because } => format!("unclear — {because}"),
    }
}

/// What the last look knew, per workspace. The only thing that survives a look,
/// and it is in memory: Y-044 stands, and nothing here asks about the past.
#[derive(Debug, Default)]
pub struct Watch {
    known: Option<BTreeMap<String, Verdict>>,
}

impl Watch {
    /// What is worth telling someone about, given what the last look knew.
    ///
    /// **The first call returns nothing**, because a fresh daemon has no
    /// previous state and must not announce the whole fleet as if it had just
    /// changed. A look that *failed* never reaches here — the caller has
    /// [`Result`] for that, and an unknown fleet is not a changed one (I-47).
    pub fn look(&mut self, fleet: &Fleet) -> Vec<Notification> {
        let before = self.known.take();
        let now = known(fleet, before.as_ref());
        let notifications = match &before {
            None => Vec::new(),
            Some(before) => now
                .iter()
                .filter(|(workspace, verdict)| notable(before.get(*workspace), verdict))
                .map(|(workspace, verdict)| Notification {
                    workspace: workspace.clone(),
                    verdict: verdict.clone(),
                })
                .collect(),
        };
        self.known = Some(now);
        notifications
    }
}

/// What this look knows, which is not the same as what it saw: **a machine that
/// could not be asked keeps the verdicts it had**, because an unknown state is
/// not a changed one. Folding the two together would announce every workspace on
/// a laptop as gone every time it slept, and then miss the crash it came back
/// with. A workspace the answering machine no longer lists is dropped — its file
/// was deleted, which is not something a session did.
fn known(fleet: &Fleet, before: Option<&BTreeMap<String, Verdict>>) -> BTreeMap<String, Verdict> {
    let mut known = BTreeMap::new();
    for machine in &fleet.machines {
        match &machine.reports {
            Ok(reports) => known.extend(
                reports
                    .iter()
                    .map(|report| (report.workspace.name.clone(), report.verdict.clone())),
            ),
            Err(_) => known.extend(machine.workspaces.iter().filter_map(|workspace| {
                let verdict = before?.get(&workspace.name)?;
                Some((workspace.name.clone(), verdict.clone()))
            })),
        }
    }
    known
}

/// [`Verdict::AwaitingTrust`] is the one that matters most (I-49): the session is
/// inert until a human answers it, and nothing else tells them. Everything else
/// worth sending is a [`Verdict::Running`] that stopped being one.
///
/// **Never [`Verdict::NoAgent`]**, which is not a failure, and never
/// [`Verdict::Stopped`] — that is the stop somebody asked for, and a notifier
/// that reports the button you just pressed is one you mute.
fn notable(before: Option<&Verdict>, after: &Verdict) -> bool {
    if matches!(after, Verdict::AwaitingTrust) {
        return !matches!(before, Some(Verdict::AwaitingTrust));
    }
    matches!(before, Some(Verdict::Running))
        && matches!(
            after,
            Verdict::Finished
                | Verdict::Crashed { .. }
                | Verdict::Killed { .. }
                | Verdict::Unclear { .. }
                | Verdict::NoSession
        )
}

/// What a caller wants published. `title` and `priority` are ntfy's `Title` and
/// `Priority` headers ([the M7 plan] §3.4), and 1 to 5 is the scale that server
/// documents.
///
/// **The body is the caller's and Yantra composes nothing into it.** §B4 lists
/// where a workspace's secret *value* may never reach — SQLite, a log, the API,
/// a terminal stream — and a third-party relay is on that list: a reference is
/// resolved at launch, on the machine that runs the agent, and never on the way
/// out of here.
///
/// [the M7 plan]: ../../../docs/plans/m7-appliance.md
#[derive(Debug, Clone)]
pub struct Message {
    pub body: String,
    pub title: Option<String>,
    pub priority: Option<u8>,
}

/// Where a message goes.
///
/// **Neither field is ever printed.** The token is a value Yantra was handed and
/// never stores (§B4, Q5), and on a public relay the topic in the URL is the
/// only password there is — so [`fmt::Debug`] is written by hand rather than
/// derived, and no error below carries either.
pub struct Relay {
    url: String,
    token: Option<String>,
}

impl Relay {
    pub fn new(url: String, token: Option<String>) -> Self {
        Self { url, token }
    }
}

/// The topic URL to publish to, and what authenticates against it.
pub const RELAY_URL: &str = "YANTRA_NTFY_URL";
pub const RELAY_TOKEN: &str = "YANTRA_NTFY_TOKEN";

/// **The environment is the only place either is read from** (§B4, and ADR-0013
/// §4's precedent for `YANTRA_DAEMON`): not a workspace field, not a file Yantra
/// writes, not the API.
pub fn from_env() -> Option<Relay> {
    configured(
        std::env::var(RELAY_URL).ok(),
        std::env::var(RELAY_TOKEN).ok(),
    )
}

/// Both halves are arguments rather than reads, so the rule is testable without
/// an environment variable — `yantrad`'s `dashboard` is the same shape.
fn configured(url: Option<String>, token: Option<String>) -> Option<Relay> {
    Some(Relay::new(url?, token))
}

impl fmt::Debug for Relay {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Relay")
            .field("url", &"<relay>")
            .field("token", &self.token.as_ref().map(|_| "<token>"))
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("the relay answered {status}")]
    Refused { status: u16 },

    #[error("the relay could not be reached: {reason}")]
    Unreachable { reason: String },
}

/// One attempt, and no more. A failure is the notification gone.
///
/// The send is blocking and runs on a blocking thread, because the caller's
/// runtime is serving terminals on its workers (I-13).
pub async fn post(relay: &Relay, message: Message) -> Result<(), Error> {
    let url = relay.url.clone();
    let token = relay.token.clone();
    tokio::task::spawn_blocking(move || send(&url, token.as_deref(), &message))
        .await
        .map_err(|_| Error::Unreachable {
            reason: "the send did not finish".to_owned(),
        })?
}

fn send(url: &str, token: Option<&str>, message: &Message) -> Result<(), Error> {
    let mut request = ureq::post(url)
        .config()
        .timeout_global(Some(TIMEOUT))
        .build();
    if let Some(token) = token {
        request = request.header("Authorization", &format!("Bearer {token}"));
    }
    if let Some(title) = &message.title {
        request = request.header("Title", title);
    }
    if let Some(priority) = message.priority {
        request = request.header("Priority", &priority.to_string());
    }
    match request.send(&message.body) {
        Ok(_) => Ok(()),
        Err(ureq::Error::StatusCode(status)) => Err(Error::Refused { status }),
        Err(error) => Err(Error::Unreachable {
            reason: reason(&error),
        }),
    }
}

/// The kind, never the message, for everything that could quote the destination
/// back: `BadUri` and `RequireHttpsOnly` both do, and the topic in it is the
/// only password a public relay has.
fn reason(error: &ureq::Error) -> String {
    match error {
        ureq::Error::Io(io) => io.to_string(),
        ureq::Error::Timeout(_) => "it did not answer in time".to_owned(),
        ureq::Error::HostNotFound => "the host does not resolve".to_owned(),
        ureq::Error::Tls(why) => (*why).to_owned(),
        _ => "the request did not complete".to_owned(),
    }
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets library code, where the same call would take the daemon down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use crate::status::{MachineStatus, Report};
    use crate::workspace::Workspace;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::path::PathBuf;
    use std::thread::{self, JoinHandle};

    fn workspace(name: &str, machine: &str) -> Workspace {
        Workspace {
            name: name.to_owned(),
            machine: machine.to_owned(),
            repo: PathBuf::from("/srv/repo"),
            startup: Some("claude".to_owned()),
        }
    }

    /// One machine that answered, with a verdict per workspace.
    fn answered(machine: &str, verdicts: &[(&str, Verdict)]) -> MachineStatus {
        MachineStatus {
            machine: machine.to_owned(),
            workspaces: verdicts
                .iter()
                .map(|(name, _)| workspace(name, machine))
                .collect(),
            reports: Ok(verdicts
                .iter()
                .map(|(name, verdict)| Report {
                    workspace: workspace(name, machine),
                    pane: None,
                    agent: None,
                    verdict: verdict.clone(),
                })
                .collect()),
        }
    }

    /// The same machine, asleep: its workspaces are still listed and none of
    /// them has an answer.
    fn unreachable(machine: &str, names: &[&str]) -> MachineStatus {
        MachineStatus {
            machine: machine.to_owned(),
            workspaces: names.iter().map(|name| workspace(name, machine)).collect(),
            reports: Err(crate::status::Error::Interrupted {
                machine: machine.to_owned(),
                reason: "connection timed out".to_owned(),
            }),
        }
    }

    fn fleet(machines: Vec<MachineStatus>) -> Fleet {
        Fleet {
            machines,
            unusable: Vec::new(),
        }
    }

    fn bodies(notifications: &[Notification]) -> Vec<String> {
        notifications.iter().map(Notification::to_string).collect()
    }

    /// The rule a fresh daemon lives or dies by: there is nothing to diff
    /// against, so a whole running fleet is not news.
    #[test]
    fn the_first_look_after_a_start_says_nothing() {
        let mut watch = Watch::default();

        let first = watch.look(&fleet(vec![answered(
            "pi",
            &[
                ("api", Verdict::Running),
                ("web", Verdict::Crashed { status: 1 }),
                ("docs", Verdict::AwaitingTrust),
            ],
        )]));

        assert!(bodies(&first).is_empty(), "{:?}", bodies(&first));
    }

    #[test]
    fn two_identical_looks_say_nothing() {
        let mut watch = Watch::default();
        let seen = || fleet(vec![answered("pi", &[("api", Verdict::Running)])]);
        watch.look(&seen());

        assert!(bodies(&watch.look(&seen())).is_empty());
    }

    /// I-49, and the reason this row exists: an agent at the trust dialog is
    /// doing nothing and nothing else says so.
    #[test]
    fn an_agent_that_reached_the_trust_dialog_is_the_notification() {
        let mut watch = Watch::default();
        watch.look(&fleet(vec![answered("pi", &[("api", Verdict::NoSession)])]));

        let changed = watch.look(&fleet(vec![answered(
            "pi",
            &[("api", Verdict::AwaitingTrust)],
        )]));

        assert_eq!(bodies(&changed), ["api: waiting at claude's trust prompt"]);
    }

    /// It is still true on the next look and it is not still news.
    #[test]
    fn a_dialog_nobody_answered_is_said_once() {
        let mut watch = Watch::default();
        let waiting = || fleet(vec![answered("pi", &[("api", Verdict::AwaitingTrust)])]);
        watch.look(&fleet(vec![answered("pi", &[("api", Verdict::NoSession)])]));
        watch.look(&waiting());

        assert!(bodies(&watch.look(&waiting())).is_empty());
    }

    #[test]
    fn a_running_agent_that_stopped_being_one_is_told() {
        for (verdict, expected) in [
            (Verdict::Finished, "api: finished"),
            (Verdict::Crashed { status: 1 }, "api: crashed (exit 1)"),
            (
                Verdict::Killed {
                    signal: "KILL".to_owned(),
                },
                "api: killed by SIGKILL",
            ),
            (Verdict::NoSession, "api: the session is gone"),
            (
                Verdict::Unclear {
                    because: "the pane is alive but claude knows of no agent in that directory",
                },
                "api: unclear — the pane is alive but claude knows of no agent in that directory",
            ),
        ] {
            let mut watch = Watch::default();
            watch.look(&fleet(vec![answered("pi", &[("api", Verdict::Running)])]));

            let changed = watch.look(&fleet(vec![answered("pi", &[("api", verdict.clone())])]));

            assert_eq!(bodies(&changed), [expected], "{verdict:?}");
        }
    }

    /// `NoAgent` is not a failure and `Stopped` is the stop that was asked for.
    /// ADR-0013's non-goals put the first out of scope by name; the second is
    /// what a notifier gets muted for.
    #[test]
    fn a_shell_and_a_clean_stop_are_not_failures_and_are_not_sent() {
        for verdict in [Verdict::NoAgent, Verdict::Stopped] {
            let mut watch = Watch::default();
            watch.look(&fleet(vec![answered("pi", &[("api", Verdict::Running)])]));

            let changed = watch.look(&fleet(vec![answered("pi", &[("api", verdict.clone())])]));

            assert!(bodies(&changed).is_empty(), "{verdict:?}");
        }
    }

    /// A workspace created between two looks has no previous state either, so
    /// only the one verdict that is news whatever came before it is sent.
    #[test]
    fn a_workspace_that_appeared_is_silent_unless_it_appeared_waiting() {
        let mut watch = Watch::default();
        watch.look(&fleet(vec![answered("pi", &[("api", Verdict::Running)])]));

        let quiet = watch.look(&fleet(vec![answered(
            "pi",
            &[("api", Verdict::Running), ("new", Verdict::NoSession)],
        )]));
        assert!(bodies(&quiet).is_empty(), "{:?}", bodies(&quiet));

        let waiting = watch.look(&fleet(vec![answered(
            "pi",
            &[
                ("api", Verdict::Running),
                ("new", Verdict::NoSession),
                ("fresh", Verdict::AwaitingTrust),
            ],
        )]));
        assert_eq!(
            bodies(&waiting),
            ["fresh: waiting at claude's trust prompt"]
        );
    }

    /// Deleting the file is not something the session did.
    #[test]
    fn a_workspace_that_vanished_says_nothing() {
        let mut watch = Watch::default();
        watch.look(&fleet(vec![answered(
            "pi",
            &[("api", Verdict::Running), ("old", Verdict::Running)],
        )]));

        let changed = watch.look(&fleet(vec![answered("pi", &[("api", Verdict::Running)])]));

        assert!(bodies(&changed).is_empty(), "{:?}", bodies(&changed));
    }

    /// The laptop that sleeps every night. Nothing is sent while it cannot be
    /// asked, and what it was doing is still there when it answers again — so
    /// the crash it comes back with is a change from `Running` and not from
    /// nothing.
    #[test]
    fn a_machine_that_went_unreachable_notifies_nothing_and_forgets_nothing() {
        let mut watch = Watch::default();
        watch.look(&fleet(vec![answered("pi", &[("api", Verdict::Running)])]));

        let asleep = watch.look(&fleet(vec![unreachable("pi", &["api"])]));
        assert!(bodies(&asleep).is_empty(), "{:?}", bodies(&asleep));

        let awake = watch.look(&fleet(vec![answered(
            "pi",
            &[("api", Verdict::Crashed { status: 137 })],
        )]));
        assert_eq!(bodies(&awake), ["api: crashed (exit 137)"]);
    }

    fn listener() -> (TcpListener, SocketAddr) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        (listener, address)
    }

    /// A real socket, not a mock (§B3) — what is under test is the request that
    /// leaves. It is plain HTTP on loopback, so it says nothing about TLS,
    /// nothing about the bundled root store, and nothing about ntfy accepting
    /// any of it.
    fn serve(listener: TcpListener, status: &'static str) -> JoinHandle<String> {
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("the notifier connects");
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !complete(&request) {
                match stream.read(&mut byte) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => request.push(byte[0]),
                }
            }
            stream
                .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes())
                .expect("the relay answers");
            String::from_utf8_lossy(&request).into_owned()
        })
    }

    /// Headers, then exactly the `Content-Length` the request declared.
    fn complete(request: &[u8]) -> bool {
        let text = String::from_utf8_lossy(request);
        let Some((headers, body)) = text.split_once("\r\n\r\n") else {
            return false;
        };
        headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")?
                    .trim()
                    .parse::<usize>()
                    .ok()
            })
            .is_some_and(|length| body.len() >= length)
    }

    /// What a real diff produced, rather than a `Notification` built by hand —
    /// so what the assertions below read is what would actually leave.
    fn notification() -> Notification {
        let mut watch = Watch::default();
        watch.look(&fleet(vec![answered(
            "cachyos-g14",
            &[("api", Verdict::NoSession)],
        )]));
        watch
            .look(&fleet(vec![answered(
                "cachyos-g14",
                &[("api", Verdict::AwaitingTrust)],
            )]))
            .pop()
            .expect("the dialog is news")
    }

    /// The fleet path, unchanged by the channel underneath it: one line, no
    /// `Title`, no `Priority`, and neither the machine nor the repo.
    #[tokio::test]
    async fn the_relay_reads_the_workspace_the_verdict_and_the_token() {
        let (listener, address) = listener();
        let served = serve(listener, "200 OK");
        let relay = Relay::new(
            format!("http://{address}/yantra-test"),
            Some("tk_notarealtoken".to_owned()),
        );

        post(&relay, notification().message())
            .await
            .expect("200 is sent");

        let request = served.join().expect("the listener thread");
        assert!(
            request.starts_with("POST /yantra-test HTTP/1.1\r\n"),
            "{request}"
        );
        let headers = request.to_lowercase();
        assert!(
            headers.contains("authorization: bearer tk_notarealtoken"),
            "{request}"
        );
        assert!(
            !headers.contains("title:") && !headers.contains("priority:"),
            "{request}"
        );
        assert!(
            request.ends_with("api: waiting at claude's trust prompt"),
            "{request}"
        );
        assert!(
            !request.contains("/srv/repo") && !request.contains("cachyos-g14"),
            "the fleet notifier still names neither the repo nor the machine — {request}"
        );
    }

    /// The channel the notifier is only the first caller of: the body is the
    /// caller's, and the two things ntfy carries beside it are headers.
    #[tokio::test]
    async fn a_message_reaches_the_wire_with_its_title_and_its_priority() {
        let (listener, address) = listener();
        let served = serve(listener, "200 OK");
        let relay = Relay::new(format!("http://{address}/yantra-test"), None);

        post(
            &relay,
            Message {
                body: "context is at 90 %".to_owned(),
                title: Some("y-147".to_owned()),
                priority: Some(4),
            },
        )
        .await
        .expect("200 is sent");

        // `ureq` writes header names lowercased, and HTTP says a reader may not
        // care — so the assertion does not either.
        let request = served.join().expect("the listener thread");
        let headers = request.to_lowercase();
        assert!(headers.contains("title: y-147\r\n"), "{request}");
        assert!(headers.contains("priority: 4\r\n"), "{request}");
        assert!(request.ends_with("context is at 90 %"), "{request}");
    }

    /// The daemon runs with nothing configured today, and that is a deployment
    /// rather than a fault.
    #[test]
    fn an_environment_that_names_no_url_configures_no_relay() {
        assert!(configured(None, Some("tk_notarealtoken".to_owned())).is_none());
    }

    #[tokio::test]
    async fn a_url_with_no_token_sends_no_authorization_header() {
        let (listener, address) = listener();
        let served = serve(listener, "200 OK");
        let relay = configured(Some(format!("http://{address}/yantra-test")), None)
            .expect("a url is a relay");

        post(
            &relay,
            Message {
                body: "hello".to_owned(),
                title: None,
                priority: None,
            },
        )
        .await
        .expect("200 is sent");

        let request = served.join().expect("the listener thread");
        assert!(
            !request.to_lowercase().contains("authorization:"),
            "{request}"
        );
    }

    #[tokio::test]
    async fn a_url_and_a_token_put_a_bearer_on_the_wire() {
        let (listener, address) = listener();
        let served = serve(listener, "200 OK");
        let relay = configured(
            Some(format!("http://{address}/yantra-test")),
            Some("tk_notarealtoken".to_owned()),
        )
        .expect("a url is a relay");

        post(
            &relay,
            Message {
                body: "hello".to_owned(),
                title: None,
                priority: None,
            },
        )
        .await
        .expect("200 is sent");

        let request = served.join().expect("the listener thread");
        assert!(
            request
                .to_lowercase()
                .contains("authorization: bearer tk_notarealtoken"),
            "{request}"
        );
    }

    /// §B4 and Q5. The one place a token could escape without anyone writing a
    /// log line for it is a derived `Debug`, and the destination is a secret of
    /// the same kind (Q16).
    #[test]
    fn neither_the_token_nor_the_topic_survives_being_printed() {
        let relay = Relay::new(
            "https://ntfy.sh/a-topic-nobody-guesses".to_owned(),
            Some("tk_notarealtoken".to_owned()),
        );

        let printed = format!("{relay:?}");

        assert!(!printed.contains("tk_notarealtoken"), "{printed}");
        assert!(!printed.contains("a-topic-nobody-guesses"), "{printed}");
        assert!(printed.contains("<token>"), "{printed}");
    }

    #[tokio::test]
    async fn a_relay_that_is_not_there_drops_the_notification() {
        let (listener, address) = listener();
        drop(listener);
        let relay = Relay::new(format!("http://{address}/yantra-test"), None);

        let dropped = post(&relay, notification().message())
            .await
            .expect_err("nothing is listening");

        assert!(matches!(dropped, Error::Unreachable { .. }), "{dropped}");
    }

    #[tokio::test]
    async fn a_relay_that_refuses_names_the_status_and_not_the_destination() {
        let (listener, address) = listener();
        let served = serve(listener, "403 Forbidden");
        let relay = Relay::new(
            format!("http://{address}/yantra-test"),
            Some("tk_notarealtoken".to_owned()),
        );

        let refused = post(&relay, notification().message())
            .await
            .expect_err("403 is not a delivered notification");

        assert!(
            matches!(refused, Error::Refused { status: 403 }),
            "{refused}"
        );
        let said = refused.to_string();
        assert!(
            !said.contains("tk_notarealtoken") && !said.contains("yantra-test"),
            "{said}"
        );
        served.join().expect("the listener thread");
    }
}
