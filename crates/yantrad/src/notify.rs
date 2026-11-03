//! When the diff runs, and what a send that fails costs.
//!
//! [`yantra_core::notify`] holds the decision; this holds the clock it does not
//! have. It runs off the agents loop in [`crate::refresh`] and **adds no poll,
//! no ssh and no timer of its own** — the two consecutive snapshots it needs are
//! already being taken.
//!
//! **Nothing here queues.** A notification that could not be sent is gone: no
//! retry, no replay, and no buffer that could grow while a relay is unreachable.
//! The one thing this side adds is a budget, because the sends are sequential
//! and the loop waits for them.
//!
//! **And nothing is pushed while someone is watching the page** (D3 §13). The
//! dashboard says so itself, on [`crate::write`]'s beacon; here that is one
//! bool, and the diff still runs under it — a change seen while a tab was open
//! is a change already told, not one owed later.
//!
//! **Every notification is remembered before any of that** ([ADR-0025]): the
//! diff runs with or without a relay, and what it produced goes into
//! [`crate::events`] first, so a send that is dropped, or never configured, is
//! still a remembered event.
//!
//! [ADR-0025]: ../../../docs/adr/0025-the-daemon-remembers-what-it-pushed.md

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;
use yantra_core::notify::{BODY_MAX, Message, Notification, Relay, Watch, post};
use yantra_core::status::Fleet;

use crate::events::{self, Event, Events};

/// The whole of what one look may spend telling someone, well under
/// `refresh::EVERY`. Without it a fleet where several things changed at once,
/// against a relay that accepts connections and never answers, would push the
/// next look out by a multiple of the per-send timeout.
const BUDGET: Duration = Duration::from_secs(5);

/// When a browser last said it was looking. Beside the snapshot and the beats,
/// **in memory** — a restart forgets it, which is correct: a restart forgets
/// the snapshot too, and the first look after a start already says nothing.
pub type Viewers = Arc<RwLock<Option<Instant>>>;

/// How long one beacon speaks for. Longer than the page's own interval, which
/// is `BEACON_MS` in [`web/src/useViewing.ts`](../../../web/src/useViewing.ts),
/// so a tab that misses a beat does not start pushing to a phone somebody is
/// holding — and short enough that a closed laptop is heard from again inside a
/// refresh period.
pub const WATCHED: Duration = Duration::from_secs(60);

pub async fn watched(viewers: &Viewers) -> bool {
    matches!(*viewers.read().await, Some(seen) if seen.elapsed() < WATCHED)
}

#[derive(Debug)]
pub struct Notifier {
    watch: Watch,
    teller: Teller,
}

impl Notifier {
    pub fn new(relay: Option<Relay>) -> Self {
        Self {
            watch: Watch::default(),
            teller: Teller::new(relay),
        }
    }

    /// Called once the reading is already in the model, so nothing a browser
    /// reads is waiting on a relay.
    ///
    /// **The diff runs whether or not anyone is watching**, and that is the
    /// whole of D3 §13: the notifications a watched look produced are dropped
    /// here rather than held, so closing the tab does not deliver a backlog of
    /// things the page already showed.
    pub async fn tell(&mut self, fleet: &Fleet, watched: bool, events: &Events) {
        let notifications = self.watch.look(fleet);
        for notification in &notifications {
            events::remember(events, Event::of(notification, fleet)).await;
        }
        let messages = notifications.iter().map(Notification::message).collect();
        self.teller.deliver(messages, watched).await;
    }
}

/// The relay and its quiet log: the rules every send from a refresh task
/// keeps. `None` is a daemon with no relay, which still remembers.
#[derive(Debug)]
pub struct Teller {
    relay: Option<Relay>,
    log: Log,
}

impl Teller {
    pub fn new(relay: Option<Relay>) -> Self {
        Self {
            relay,
            log: Log::default(),
        }
    }

    /// What the PR watch saw (Y-494): remembered, then sent as the agents'
    /// notifications are.
    pub async fn tell_pulls(&mut self, notes: &[PrNote], watched: bool, events: &Events) {
        for note in notes {
            events::remember(
                events,
                Event::pull(note.phase.kind(), &note.workspace, note.said()),
            )
            .await;
        }
        self.deliver(notes.iter().map(PrNote::message).collect(), watched)
            .await;
    }

    async fn deliver(&mut self, messages: Vec<Message>, watched: bool) {
        let Some(relay) = &self.relay else {
            return;
        };
        if messages.is_empty() {
            return;
        }
        if watched {
            tracing::debug!(
                "{} notification(s) not pushed: the dashboard is open",
                messages.len()
            );
            return;
        }
        let outcome = tokio::time::timeout(BUDGET, send(relay, messages))
            .await
            .unwrap_or(Err("the budget for this look ran out".to_owned()));
        if let Some(line) = self.log.line(outcome) {
            tracing::warn!("{line}");
        }
    }
}

/// What the PR watch tells, with [`yantra_core::notify::Phase`]'s fixed
/// headlines beside the agents' own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrPhase {
    CheckFailed,
    ChecksPassed,
    Reviewed,
}

impl PrPhase {
    pub fn headline(self) -> &'static str {
        match self {
            PrPhase::CheckFailed => "Check failed",
            PrPhase::ChecksPassed => "Checks passed",
            PrPhase::Reviewed => "PR reviewed",
        }
    }

    /// The event's `kind`, as `web/src/api.ts` spells it.
    pub fn kind(self) -> &'static str {
        match self {
            PrPhase::CheckFailed => "check_failed",
            PrPhase::ChecksPassed => "checks_passed",
            PrPhase::Reviewed => "reviewed",
        }
    }
}

/// A workspace and a PR number, and no repo, check output or review text:
/// a public relay is told no more than the agents notifier tells it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrNote {
    pub phase: PrPhase,
    pub workspace: String,
    pub number: u64,
}

impl PrNote {
    pub fn said(&self) -> String {
        let what = match self.phase {
            PrPhase::CheckFailed => "has a failed check",
            PrPhase::ChecksPassed => "passed its checks",
            PrPhase::Reviewed => "has a new review",
        };
        let said = format!("{}: PR #{} {what}", self.workspace, self.number);
        said.chars().take(BODY_MAX).collect()
    }

    pub fn message(&self) -> Message {
        Message {
            body: self.said(),
            title: Some(self.phase.headline().to_owned()),
            priority: None,
        }
    }
}

/// The first failure ends the pass: the rest of this look's notifications are
/// dropped rather than retried against a relay that has just said no.
async fn send(relay: &Relay, messages: Vec<Message>) -> Result<(), String> {
    for message in messages {
        post(relay, message)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// `yantra-agent`'s `Log` is the precedent: the first failure is said out loud
/// and every one after it is swallowed until something lands, so a relay that
/// is down for a day does not fill the journal with one line per look.
#[derive(Debug, Default)]
struct Log {
    quiet: bool,
}

impl Log {
    fn line(&mut self, outcome: Result<(), String>) -> Option<String> {
        match (outcome, self.quiet) {
            (Err(dropped), false) => {
                self.quiet = true;
                Some(format!(
                    "notification dropped, and further ones will be too — {dropped}"
                ))
            }
            (Ok(()), true) => {
                self.quiet = false;
                Some("notifications are landing again".to_owned())
            }
            _ => None,
        }
    }
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets the daemon, where the same call would take it down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::thread;
    use yantra_core::status::{MachineStatus, Report, Verdict};
    use yantra_core::workspace::Workspace;

    fn fleet(name: &str, verdict: Verdict) -> Fleet {
        let workspace = Workspace {
            name: name.to_owned(),
            machine: "cachyos-g14".to_owned(),
            repo: PathBuf::from("/srv/repo"),
            startup: Some("claude".to_owned()),
        };
        Fleet {
            machines: vec![MachineStatus {
                machine: "cachyos-g14".to_owned(),
                workspaces: vec![workspace.clone()],
                reports: Ok(vec![Report {
                    workspace,
                    pane: None,
                    agent: None,
                    verdict,
                }]),
            }],
            unusable: Vec::new(),
        }
    }

    /// The row's whole behaviour over one real socket: the first look after a
    /// start sends nothing at all, and the next one sends exactly what changed.
    /// Plain HTTP against a local listener, so it proves the request leaves and
    /// what is in it — and nothing about TLS or about ntfy.
    #[tokio::test]
    async fn a_fresh_daemon_sends_nothing_and_then_sends_only_what_changed() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let mut notifier = Notifier::new(Some(relay(address)));
        let events = Events::default();

        notifier
            .tell(&fleet("api", Verdict::Running), false, &events)
            .await;

        listener.set_nonblocking(true).expect("a nonblocking check");
        assert!(
            listener.accept().is_err(),
            "the first look after a start must not open a connection at all"
        );
        listener.set_nonblocking(false).expect("blocking again");
        assert!(
            events.read().await.is_empty(),
            "and remembers nothing either"
        );

        let served = thread::spawn(move || answer(&listener, "200 OK"));

        notifier
            .tell(&fleet("api", Verdict::AwaitingTrust), false, &events)
            .await;

        assert_eq!(
            served.join().expect("the listener thread"),
            "api: waiting at claude's trust prompt"
        );
        let remembered = events::newest_first(&events).await;
        assert_eq!(remembered.len(), 1);
        assert_eq!(remembered[0].kind, "awaiting_trust");
        assert_eq!(remembered[0].workspace.as_deref(), Some("api"));
        assert_eq!(remembered[0].machine.as_deref(), Some("cachyos-g14"));
        assert_eq!(remembered[0].said, "api: waiting at claude's trust prompt");
    }

    /// ADR-0025 §2 from both sides a send can fail on: no relay at all, and a
    /// relay that refused. Either way the event is there, because it was
    /// remembered before the send was tried.
    #[tokio::test]
    async fn an_event_is_remembered_with_no_relay_and_when_the_relay_refuses() {
        let events = Events::default();
        let mut quiet = Notifier::new(None);
        quiet
            .tell(&fleet("api", Verdict::Running), false, &events)
            .await;
        quiet
            .tell(
                &fleet("api", Verdict::Crashed { status: 2 }),
                false,
                &events,
            )
            .await;
        assert_eq!(events.read().await.len(), 1, "no relay, still remembered");

        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let served = thread::spawn(move || answer(&listener, "503 Service Unavailable"));
        let mut refused = Notifier::new(Some(relay(address)));
        refused
            .tell(&fleet("site", Verdict::Running), false, &events)
            .await;
        refused
            .tell(&fleet("site", Verdict::Finished), false, &events)
            .await;
        served.join().expect("the listener thread");

        let remembered = events::newest_first(&events).await;
        assert_eq!(remembered.len(), 2, "{remembered:?}");
        assert_eq!(remembered[0].kind, "finished");
        assert_eq!(remembered[1].kind, "crashed");
    }

    /// The rule that has no state to inspect, so it is asserted from the
    /// relay's side: a notification the relay refused is **gone**. When the next
    /// one lands, it is the one that just happened and not a backlog.
    #[tokio::test]
    async fn a_refused_notification_is_never_seen_again() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let served = thread::spawn(move || {
            ["503 Service Unavailable", "200 OK"]
                .map(|status| request(&listener, status))
                .to_vec()
        });
        let mut notifier = Notifier::new(Some(relay(address)));
        let events = Events::default();

        notifier
            .tell(&fleet("api", Verdict::Running), false, &events)
            .await;
        notifier
            .tell(&fleet("api", Verdict::AwaitingTrust), false, &events)
            .await;
        notifier
            .tell(&fleet("api", Verdict::Running), false, &events)
            .await;
        notifier
            .tell(
                &fleet("api", Verdict::Crashed { status: 1 }),
                false,
                &events,
            )
            .await;

        let seen = served.join().expect("the listener thread");
        assert_eq!(
            seen.iter().map(|request| body(request)).collect::<Vec<_>>(),
            [
                Some("api: waiting at claude's trust prompt".to_owned()),
                Some("api: The agent run failed.".to_owned())
            ],
            "the refused notification must not be replayed behind the next one"
        );
        assert!(
            seen[1].to_lowercase().contains("title: agent failed\r\n"),
            "{}",
            seen[1]
        );
        let said = events::newest_first(&events).await;
        assert_eq!(
            said[0].said, "api: crashed (exit 1)",
            "the event log keeps the verdict the relay is not told"
        );
    }

    /// D3 §13 in one test: while a tab is visible the event is on the page, so
    /// nothing reaches the relay — and it does not arrive late either, because
    /// the look that produced it already ran.
    #[tokio::test]
    async fn a_change_seen_while_the_page_was_open_is_never_pushed() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let mut notifier = Notifier::new(Some(relay(address)));
        let events = Events::default();

        notifier
            .tell(&fleet("api", Verdict::Running), true, &events)
            .await;
        notifier
            .tell(&fleet("api", Verdict::AwaitingTrust), true, &events)
            .await;
        // The tab is closed now, and the fleet has not changed since.
        notifier
            .tell(&fleet("api", Verdict::AwaitingTrust), false, &events)
            .await;

        listener.set_nonblocking(true).expect("a nonblocking check");
        assert!(
            listener.accept().is_err(),
            "a watched change must be dropped, not held for the next look"
        );
        assert_eq!(
            events.read().await.len(),
            1,
            "dropped from the relay, and still on the page's list"
        );
    }

    /// The window is what makes the beacon a *last seen* rather than a switch
    /// somebody has to turn off: a page that stopped saying anything is a page
    /// nobody is watching, within a minute.
    #[tokio::test]
    async fn a_beacon_older_than_the_window_is_no_longer_a_viewer() {
        let viewers = Viewers::default();
        assert!(!watched(&viewers).await, "nobody has said anything yet");

        *viewers.write().await = Some(Instant::now());
        assert!(watched(&viewers).await);

        *viewers.write().await = Instant::now().checked_sub(WATCHED);
        assert!(!watched(&viewers).await);
    }

    fn note(phase: PrPhase) -> PrNote {
        PrNote {
            phase,
            workspace: "web".to_owned(),
            number: 21,
        }
    }

    /// Y-494: a PR note is remembered under its kind and sent with its fixed
    /// headline and a body that names the workspace and the number only.
    #[tokio::test]
    async fn a_pr_note_is_remembered_then_sent_with_its_headline() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let served = thread::spawn(move || request(&listener, "200 OK"));
        let mut teller = Teller::new(Some(relay(address)));
        let events = Events::default();

        teller
            .tell_pulls(&[note(PrPhase::CheckFailed)], false, &events)
            .await;

        let seen = served.join().expect("the listener thread");
        assert_eq!(
            body(&seen).as_deref(),
            Some("web: PR #21 has a failed check")
        );
        assert!(
            seen.to_lowercase().contains("title: check failed\r\n"),
            "{seen}"
        );
        let remembered = events::newest_first(&events).await;
        assert_eq!(remembered[0].kind, "check_failed");
        assert_eq!(remembered[0].workspace.as_deref(), Some("web"));
        assert_eq!(remembered[0].machine, None);
    }

    #[test]
    fn each_pr_phase_has_its_headline_kind_and_a_body_cut_at_160() {
        let worded: Vec<_> = [
            PrPhase::CheckFailed,
            PrPhase::ChecksPassed,
            PrPhase::Reviewed,
        ]
        .map(|phase| (phase.headline(), phase.kind(), note(phase).said()))
        .to_vec();
        assert_eq!(
            worded,
            [
                (
                    "Check failed",
                    "check_failed",
                    "web: PR #21 has a failed check".to_owned()
                ),
                (
                    "Checks passed",
                    "checks_passed",
                    "web: PR #21 passed its checks".to_owned()
                ),
                (
                    "PR reviewed",
                    "reviewed",
                    "web: PR #21 has a new review".to_owned()
                ),
            ]
        );
        let long = PrNote {
            workspace: "w".repeat(300),
            ..note(PrPhase::Reviewed)
        };
        assert_eq!(long.message().body.chars().count(), 160);
    }

    /// D3 §13 for the PR watch: watched means not pushed, and still remembered.
    #[tokio::test]
    async fn a_pr_note_while_the_page_is_open_is_remembered_and_not_pushed() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let mut teller = Teller::new(Some(relay(address)));
        let events = Events::default();

        teller
            .tell_pulls(&[note(PrPhase::ChecksPassed)], true, &events)
            .await;

        listener.set_nonblocking(true).expect("a nonblocking check");
        assert!(listener.accept().is_err(), "nothing reached the relay");
        assert_eq!(events::newest_first(&events).await[0].kind, "checks_passed");
    }

    /// A refused send drops the note and is said once, as the agents' are.
    #[tokio::test]
    async fn a_refused_pr_note_is_dropped_and_not_retried() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let served = thread::spawn(move || {
            ["503 Service Unavailable", "200 OK"]
                .map(|status| request(&listener, status))
                .to_vec()
        });
        let mut teller = Teller::new(Some(relay(address)));
        let events = Events::default();

        teller
            .tell_pulls(
                &[note(PrPhase::CheckFailed), note(PrPhase::Reviewed)],
                false,
                &events,
            )
            .await;
        assert!(teller.log.quiet, "the drop was said");
        teller
            .tell_pulls(&[note(PrPhase::ChecksPassed)], false, &events)
            .await;

        let seen = served.join().expect("the listener thread");
        assert_eq!(
            seen.iter().map(|request| body(request)).collect::<Vec<_>>(),
            [
                Some("web: PR #21 has a failed check".to_owned()),
                Some("web: PR #21 passed its checks".to_owned()),
            ],
            "the review behind the refused send is gone"
        );
        assert_eq!(events.read().await.len(), 3);
    }

    #[test]
    fn a_relay_that_is_down_for_a_day_is_said_once() {
        let mut log = Log::default();
        let dropped = || Err("the relay could not be reached".to_owned());

        assert!(log.line(dropped()).is_some(), "the first failure is said");
        assert!(log.line(dropped()).is_none(), "the second is not");
        assert!(log.line(Ok(())).is_some(), "recovery is said");
        assert!(log.line(Ok(())).is_none(), "and then quiet again");
        assert!(log.line(dropped()).is_some(), "a second outage is said too");
    }

    fn relay(address: std::net::SocketAddr) -> Relay {
        Relay::new(format!("http://{address}/yantra-test"), None)
    }

    /// One connection, answered with `status`, and the body it carried. Headers
    /// and body arrive in separate writes, so it reads until the request is as
    /// long as it said it would be.
    fn answer(listener: &TcpListener, status: &str) -> String {
        body(&request(listener, status)).unwrap_or_default()
    }

    /// The whole request [`answer`] reads, headers and all.
    fn request(listener: &TcpListener, status: &str) -> String {
        let (mut stream, _) = listener.accept().expect("the notifier connects");
        let mut request = String::new();
        let mut byte = [0u8; 1];
        while body(&request).is_none() {
            match stream.read(&mut byte) {
                Ok(0) | Err(_) => break,
                Ok(_) => request.push(byte[0] as char),
            }
        }
        stream
            .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes())
            .expect("the relay answers");
        request
    }

    /// The body once all of it has arrived, and [`None`] until then.
    fn body(request: &str) -> Option<String> {
        let (headers, body) = request.split_once("\r\n\r\n")?;
        let length: usize = headers.lines().find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")?
                .trim()
                .parse()
                .ok()
        })?;
        (body.len() >= length).then(|| body.to_owned())
    }
}
