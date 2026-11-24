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
//! **And nothing is pushed to a device that is being looked at** (D3 §13,
//! [ADR-0047] decision 6). The dashboard says so itself, on [`crate::write`]'s
//! beacon, and names its push endpoint when it has one. Web Push skips only
//! the devices that said so, and the relay skips a look that any dashboard
//! watched, because the daemon cannot tell which device a relay reaches. The
//! diff still runs — a change seen while a tab was open is a change already
//! told, not one owed later.
//!
//! **Every notification is remembered before any of that** ([ADR-0025]): the
//! diff runs with or without a relay, and what it produced goes into
//! [`crate::events`] first, so a send that is dropped, or never configured, is
//! still a remembered event.
//!
//! **A message goes two ways** ([ADR-0047]): to each installed dashboard by
//! Web Push, and to the ntfy relay when one is set. Every other rule above
//! binds both.
//!
//! [ADR-0025]: ../../../docs/adr/0025-the-daemon-remembers-what-it-pushed.md
//! [ADR-0047]: ../../../docs/adr/0047-the-dashboard-gets-web-push.md

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;
use yantra_core::notify::{BODY_MAX, Message, Notification, Relay, Watch, post};
use yantra_core::status::Fleet;

use crate::events::{self, Event, Events};
use crate::push::{DEVICES, ENDPOINT_MAX, Push};

/// The whole of what one look may spend telling someone, well under
/// `refresh::EVERY`. Without it a fleet where several things changed at once,
/// against a relay that accepts connections and never answers, would push the
/// next look out by a multiple of the per-send timeout.
const BUDGET: Duration = Duration::from_secs(5);

/// When a browser last said it was looking, and when each device that named
/// its push endpoint did. Beside the snapshot and the beats, **in memory** — a
/// restart forgets it, which is correct: a restart forgets the snapshot too,
/// and the first look after a start already says nothing.
pub type Viewers = Arc<RwLock<Seen>>;

/// An endpoint is a capability, so `Debug` prints how many and not which.
#[derive(Default)]
pub struct Seen {
    anyone: Option<Instant>,
    devices: HashMap<String, Instant>,
}

impl std::fmt::Debug for Seen {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Seen")
            .field("anyone", &self.anyone)
            .field("devices", &self.devices.len())
            .finish()
    }
}

impl Seen {
    /// One beacon. An endpoint that is too long, or one more than the store
    /// may hold, is not kept: that device gets a push it did not need.
    pub fn beacon(&mut self, endpoint: Option<String>) {
        let now = Instant::now();
        self.anyone = Some(now);
        self.devices.retain(|_, seen| seen.elapsed() < WATCHED);
        let Some(endpoint) = endpoint else {
            return;
        };
        let room = self.devices.len() < DEVICES || self.devices.contains_key(&endpoint);
        if endpoint.len() <= ENDPOINT_MAX && room {
            self.devices.insert(endpoint, now);
        }
    }
}

/// How long one beacon speaks for. Longer than the page's own interval, which
/// is `BEACON_MS` in [`web/src/useViewing.ts`](../../../web/src/useViewing.ts),
/// so a tab that misses a beat does not start pushing to a phone somebody is
/// holding — and short enough that a closed laptop is heard from again inside a
/// refresh period.
pub const WATCHED: Duration = Duration::from_secs(60);

/// What one look reads from the beacons. As with [`Seen`], `Debug` prints no
/// endpoint.
#[derive(Default, Clone, PartialEq, Eq)]
pub struct Watched {
    /// A dashboard is on screen somewhere. This is the relay's rule.
    pub anyone: bool,
    /// The push endpoints of the devices that are on screen.
    pub devices: HashSet<String>,
}

impl std::fmt::Debug for Watched {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Watched")
            .field("anyone", &self.anyone)
            .field("devices", &self.devices.len())
            .finish()
    }
}

pub async fn watched(viewers: &Viewers) -> Watched {
    let seen = viewers.read().await;
    let fresh = |at: &Instant| at.elapsed() < WATCHED;
    Watched {
        anyone: seen.anyone.as_ref().is_some_and(fresh),
        devices: seen
            .devices
            .iter()
            .filter(|(_, at)| fresh(at))
            .map(|(endpoint, _)| endpoint.clone())
            .collect(),
    }
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

    #[must_use]
    pub fn pushing(self, push: Option<Push>) -> Self {
        Self {
            teller: self.teller.pushing(push),
            ..self
        }
    }

    /// Called once the reading is already in the model, so nothing a browser
    /// reads is waiting on a relay.
    ///
    /// **The diff runs whether or not anyone is watching**, and that is the
    /// whole of D3 §13: what a watched look produced is dropped here for the
    /// devices that watched it rather than held, so closing the tab does not
    /// deliver a backlog of things the page already showed.
    pub async fn tell(&mut self, fleet: &Fleet, watched: &Watched, events: &Events) {
        let notifications = self.watch.look(fleet);
        for notification in &notifications {
            events::remember(events, Event::of(notification, fleet)).await;
        }
        let messages = notifications.iter().map(Notification::message).collect();
        self.teller.deliver(messages, watched).await;
    }
}

/// The relay, the installed dashboards and their quiet log: the rules every
/// send from a refresh task keeps. With neither, the daemon still remembers.
#[derive(Debug)]
pub struct Teller {
    relay: Option<Relay>,
    push: Option<Push>,
    log: Log,
}

impl Teller {
    pub fn new(relay: Option<Relay>) -> Self {
        Self {
            relay,
            push: None,
            log: Log::default(),
        }
    }

    #[must_use]
    pub fn pushing(self, push: Option<Push>) -> Self {
        Self { push, ..self }
    }

    /// What the PR watch saw (Y-494): remembered, then sent as the agents'
    /// notifications are.
    pub async fn tell_pulls(&mut self, notes: &[PrNote], watched: &Watched, events: &Events) {
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

    async fn deliver(&mut self, messages: Vec<Message>, watched: &Watched) {
        let relay = self.relay.as_ref().filter(|_| !watched.anyone);
        if (relay.is_none() && self.push.is_none()) || messages.is_empty() {
            return;
        }
        if watched.anyone {
            tracing::debug!(
                "{} notification(s) not sent to the relay or to {} device(s): a dashboard is open",
                messages.len(),
                watched.devices.len()
            );
        }
        let sending = send(self.push.as_ref(), relay, messages, &watched.devices);
        let outcome = tokio::time::timeout(BUDGET, sending)
            .await
            .unwrap_or(Err("the budget for this look ran out".to_owned()));
        // A look that left the relay out says nothing about the relay.
        if outcome.is_ok() && watched.anyone && self.relay.is_some() {
            return;
        }
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
            click: None,
            path: Some(format!(
                "/w/{}",
                yantra_core::notify::encoded(&self.workspace)
            )),
        }
    }
}

/// Every message is tried once, so one device that refuses does not cost the
/// relay the rest of the pass. The first failure is the answer.
async fn send(
    push: Option<&Push>,
    relay: Option<&Relay>,
    messages: Vec<Message>,
    watching: &HashSet<String>,
) -> Result<(), String> {
    let mut outcome = Ok(());
    for message in messages {
        outcome = outcome.and(told_but(push, relay, message, watching).await);
    }
    outcome
}

/// One message to every installed dashboard and to the relay, where each
/// exists (ADR-0047 decision 5). The chat's waits and the rooms' pauses call
/// it with their own rule about who is watching.
pub async fn told(
    push: Option<&Push>,
    relay: Option<&Relay>,
    message: Message,
) -> Result<(), String> {
    told_but(push, relay, message, &HashSet::new()).await
}

/// [`told`], less the devices in `watching`. Both sends are tried at once, so
/// a slow push service does not spend the relay's time. The first failure is
/// the answer.
async fn told_but(
    push: Option<&Push>,
    relay: Option<&Relay>,
    message: Message,
    watching: &HashSet<String>,
) -> Result<(), String> {
    let pushing = async {
        match push {
            Some(push) => push.send(&message, watching).await,
            None => Ok(()),
        }
    };
    let relaying = async {
        match relay {
            Some(relay) => post(relay, message.clone())
                .await
                .map_err(|error| error.to_string()),
            None => Ok(()),
        }
    };
    let (pushed, relayed) = tokio::join!(pushing, relaying);
    pushed.and(relayed)
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
            .tell(
                &fleet("api", Verdict::Running),
                &Watched::default(),
                &events,
            )
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
            .tell(
                &fleet("api", Verdict::AwaitingTrust),
                &Watched::default(),
                &events,
            )
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
            .tell(
                &fleet("api", Verdict::Running),
                &Watched::default(),
                &events,
            )
            .await;
        quiet
            .tell(
                &fleet("api", Verdict::Crashed { status: 2 }),
                &Watched::default(),
                &events,
            )
            .await;
        assert_eq!(events.read().await.len(), 1, "no relay, still remembered");

        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let served = thread::spawn(move || answer(&listener, "503 Service Unavailable"));
        let mut refused = Notifier::new(Some(relay(address)));
        refused
            .tell(
                &fleet("site", Verdict::Running),
                &Watched::default(),
                &events,
            )
            .await;
        refused
            .tell(
                &fleet("site", Verdict::Finished),
                &Watched::default(),
                &events,
            )
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
            .tell(
                &fleet("api", Verdict::Running),
                &Watched::default(),
                &events,
            )
            .await;
        notifier
            .tell(
                &fleet("api", Verdict::AwaitingTrust),
                &Watched::default(),
                &events,
            )
            .await;
        notifier
            .tell(
                &fleet("api", Verdict::Running),
                &Watched::default(),
                &events,
            )
            .await;
        notifier
            .tell(
                &fleet("api", Verdict::Crashed { status: 1 }),
                &Watched::default(),
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
            .tell(&fleet("api", Verdict::Running), &open(), &events)
            .await;
        notifier
            .tell(&fleet("api", Verdict::AwaitingTrust), &open(), &events)
            .await;
        // The tab is closed now, and the fleet has not changed since.
        notifier
            .tell(
                &fleet("api", Verdict::AwaitingTrust),
                &Watched::default(),
                &events,
            )
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

    /// ADR-0047 decision 5: an installed dashboard gets the same words with
    /// the page a tap opens, and nothing for a look that it watched.
    #[tokio::test]
    async fn a_change_is_pushed_to_an_installed_dashboard_unless_it_is_watched() {
        let (push, device, secret, auth, served) =
            crate::push::tests::pushing_to(&["201 Created"]).await;
        let mut notifier = Notifier::new(None).pushing(Some(push));
        let events = Events::default();
        let watching = on_screen(device.endpoint);

        notifier
            .tell(
                &fleet("api", Verdict::Running),
                &Watched::default(),
                &events,
            )
            .await;
        notifier
            .tell(&fleet("api", Verdict::AwaitingTrust), &watching, &events)
            .await;
        notifier
            .tell(
                &fleet("api", Verdict::Running),
                &Watched::default(),
                &events,
            )
            .await;
        notifier
            .tell(
                &fleet("api", Verdict::Crashed { status: 1 }),
                &Watched::default(),
                &events,
            )
            .await;

        let seen = served.join().expect("the listener thread");
        let text: serde_json::Value =
            serde_json::from_slice(&crate::push::tests::decrypt(&seen[0].1, &secret, &auth))
                .expect("JSON");
        assert_eq!(
            text,
            serde_json::json!({
                "title": "Agent failed",
                "body": "api: The agent run failed.",
                "url": "/w/api",
            }),
            "the watched trust prompt was dropped, and the crash was pushed"
        );
        assert_eq!(events.read().await.len(), 2);
    }

    /// Y-829, the row's test: a laptop tab on screen quiets the laptop and
    /// the relay, and the phone still gets the push.
    #[tokio::test]
    async fn a_phone_gets_the_push_while_a_laptop_tab_is_visible() {
        let (push, service, laptop, secret, auth) = laptop_and_phone().await;
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let mut notifier = Notifier::new(Some(relay(address))).pushing(Some(push));
        let events = Events::default();
        let viewers = Viewers::default();
        viewers.write().await.beacon(Some(laptop));
        let watching = watched(&viewers).await;
        let served = thread::spawn(move || {
            let seen = crate::push::tests::request(&service, "201 Created");
            (service, seen)
        });

        notifier
            .tell(&fleet("api", Verdict::Running), &watching, &events)
            .await;
        notifier
            .tell(&fleet("api", Verdict::AwaitingTrust), &watching, &events)
            .await;

        let (service, (head, body)) = served.join().expect("the push service");
        assert_eq!(path(&head), "/push/phone");
        let text: serde_json::Value =
            serde_json::from_slice(&crate::push::tests::decrypt(&body, &secret, &auth))
                .expect("JSON");
        assert_eq!(text["body"], "api: waiting at claude's trust prompt");
        assert!(silent(&service), "the laptop got a push");
        assert!(silent(&listener), "the relay was told");
        assert!(!notifier.teller.log.quiet);
    }

    /// A browser that is not subscribed names no device. Its beacon quiets
    /// the relay, and every device still gets the push.
    #[tokio::test]
    async fn a_beacon_that_names_no_device_quiets_only_the_relay() {
        let (push, service, ..) = laptop_and_phone().await;
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let mut notifier = Notifier::new(Some(relay(address))).pushing(Some(push));
        let events = Events::default();
        let viewers = Viewers::default();
        viewers.write().await.beacon(None);
        let watching = watched(&viewers).await;
        let served = thread::spawn(move || {
            let mut paths =
                [(); 2].map(|()| path(&crate::push::tests::request(&service, "201 Created").0));
            paths.sort();
            paths
        });

        notifier
            .tell(&fleet("api", Verdict::Running), &watching, &events)
            .await;
        notifier
            .tell(&fleet("api", Verdict::AwaitingTrust), &watching, &events)
            .await;

        assert_eq!(
            served.join().expect("the push service"),
            ["/push/abc", "/push/phone"]
        );
        assert!(silent(&listener), "the relay was told");
    }

    /// The relay was refusing before the laptop opened. A push that lands
    /// while the relay is left out does not say the relay is back.
    #[tokio::test]
    async fn a_watched_look_does_not_end_the_relays_quiet() {
        let (push, _, _, _, pushed) =
            crate::push::tests::pushing_to(&["201 Created", "201 Created"]).await;
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let relayed = thread::spawn(move || {
            request(&listener, "503 Service Unavailable");
            listener
        });
        let mut teller = Teller::new(Some(relay(address))).pushing(Some(push));
        let events = Events::default();

        teller
            .tell_pulls(&[note(PrPhase::CheckFailed)], &Watched::default(), &events)
            .await;
        teller
            .tell_pulls(&[note(PrPhase::Reviewed)], &open(), &events)
            .await;

        assert_eq!(pushed.join().expect("the push service").len(), 2);
        assert!(silent(&relayed.join().expect("the relay")));
        assert!(teller.log.quiet, "the relay is still down");
    }

    /// The window is what makes the beacon a *last seen* rather than a switch
    /// somebody has to turn off: a page that stopped saying anything is a page
    /// nobody is watching, within a minute. A device is the same.
    #[tokio::test]
    async fn a_beacon_older_than_the_window_is_no_longer_a_viewer() {
        let viewers = Viewers::default();
        assert_eq!(
            watched(&viewers).await,
            Watched::default(),
            "nobody has said anything yet"
        );

        let laptop = "https://push.example/laptop".to_owned();
        viewers.write().await.beacon(Some(laptop.clone()));
        assert_eq!(watched(&viewers).await, on_screen(laptop.clone()));

        let before = Instant::now()
            .checked_sub(WATCHED)
            .expect("a minute of uptime");
        viewers.write().await.devices.insert(laptop, before);
        assert_eq!(watched(&viewers).await, open(), "another tab still beacons");

        viewers.write().await.anyone = Some(before);
        assert_eq!(watched(&viewers).await, Watched::default());
    }

    /// The map is bounded as the store is, so a caller cannot grow it.
    #[tokio::test]
    async fn a_beacon_keeps_no_endpoint_that_is_too_long_stale_or_past_the_limit() {
        let mut seen = Seen::default();
        seen.beacon(Some("a".repeat(ENDPOINT_MAX + 1)));
        assert!(seen.devices.is_empty() && seen.anyone.is_some());

        let before = Instant::now()
            .checked_sub(WATCHED)
            .expect("a minute of uptime");
        seen.devices.insert("stale".to_owned(), before);
        for device in 0..=DEVICES {
            seen.beacon(Some(device.to_string()));
        }
        assert_eq!(seen.devices.len(), DEVICES);
        assert!(!seen.devices.contains_key("stale"));
        assert!(!seen.devices.contains_key(&DEVICES.to_string()));

        seen.beacon(Some("0".to_owned()));
        assert_eq!(seen.devices.len(), DEVICES, "a kept device beacons again");
    }

    /// The endpoint is a capability: a `Debug` line names none.
    #[tokio::test]
    async fn no_debug_line_prints_an_endpoint() {
        let viewers = Viewers::default();
        viewers
            .write()
            .await
            .beacon(Some("https://push.example/laptop".to_owned()));
        let printed = format!("{viewers:?} {:?}", watched(&viewers).await);
        assert!(!printed.contains("push.example"), "{printed}");
        assert!(printed.contains("devices: 1"), "{printed}");
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
            .tell_pulls(&[note(PrPhase::CheckFailed)], &Watched::default(), &events)
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

    /// D3 §13 for the PR watch: a watched note is remembered, and it goes to
    /// the phone alone while the laptop is on screen.
    #[tokio::test]
    async fn a_pr_note_while_the_laptop_is_open_is_remembered_and_pushed_to_the_phone() {
        let (push, service, laptop, ..) = laptop_and_phone().await;
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let mut teller = Teller::new(Some(relay(address))).pushing(Some(push));
        let events = Events::default();
        let watching = on_screen(laptop);
        let served = thread::spawn(move || {
            let seen = crate::push::tests::request(&service, "201 Created");
            (service, seen)
        });

        teller
            .tell_pulls(&[note(PrPhase::ChecksPassed)], &watching, &events)
            .await;

        let (service, (head, _)) = served.join().expect("the push service");
        assert_eq!(path(&head), "/push/phone");
        assert!(silent(&service), "the laptop got a push");
        assert!(silent(&listener), "the relay was told");
        assert_eq!(events::newest_first(&events).await[0].kind, "checks_passed");
    }

    /// A refused send drops the note and is said once, as the agents' are.
    /// The note behind it in the same pass is still tried.
    #[tokio::test]
    async fn a_refused_pr_note_is_dropped_and_not_retried() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let served = thread::spawn(move || {
            ["503 Service Unavailable", "200 OK", "200 OK"]
                .map(|status| request(&listener, status))
                .to_vec()
        });
        let mut teller = Teller::new(Some(relay(address)));
        let events = Events::default();

        teller
            .tell_pulls(
                &[note(PrPhase::CheckFailed), note(PrPhase::Reviewed)],
                &Watched::default(),
                &events,
            )
            .await;
        assert!(teller.log.quiet, "the drop was said");
        teller
            .tell_pulls(&[note(PrPhase::ChecksPassed)], &Watched::default(), &events)
            .await;

        let seen = served.join().expect("the listener thread");
        assert_eq!(
            seen.iter().map(|request| body(request)).collect::<Vec<_>>(),
            [
                Some("web: PR #21 has a failed check".to_owned()),
                Some("web: PR #21 has a new review".to_owned()),
                Some("web: PR #21 passed its checks".to_owned()),
            ],
            "the refused check is gone, and the review behind it was sent"
        );
        assert_eq!(events.read().await.len(), 3);
    }

    /// One device that refuses every push does not stop the pass: the relay
    /// gets both notes, and the failure is still said.
    #[tokio::test]
    async fn a_device_that_refuses_does_not_cost_the_relay_a_message() {
        let (push, _, _, _, pushed) =
            crate::push::tests::pushing_to(&["503 Service Unavailable", "503 Service Unavailable"])
                .await;
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let relayed =
            thread::spawn(move || ["200 OK", "200 OK"].map(|status| answer(&listener, status)));
        let mut teller = Teller::new(Some(relay(address))).pushing(Some(push));

        teller
            .tell_pulls(
                &[note(PrPhase::CheckFailed), note(PrPhase::Reviewed)],
                &Watched::default(),
                &Events::default(),
            )
            .await;

        assert_eq!(
            relayed.join().expect("the relay"),
            [
                "web: PR #21 has a failed check",
                "web: PR #21 has a new review"
            ]
        );
        assert_eq!(pushed.join().expect("the push service").len(), 2);
        assert!(teller.log.quiet, "the device's refusal was said");
    }

    /// The push service here answers only after the relay has its message.
    /// A push sent before the relay's would wait out its whole timeout.
    #[tokio::test]
    async fn a_slow_push_service_does_not_hold_the_relay() {
        let slow = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let (push, ..) =
            crate::push::tests::pushing_at(slow.local_addr().expect("the port it got")).await;
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("the port it got");
        let (relayed, wait) = std::sync::mpsc::channel();
        let pushed = thread::spawn(move || {
            let arrived = wait.recv_timeout(Duration::from_secs(10)).is_ok();
            crate::push::tests::request(&slow, "201 Created");
            arrived
        });
        let relaying = thread::spawn(move || {
            let said = answer(&listener, "200 OK");
            relayed.send(()).expect("the push service waits");
            said
        });

        let outcome = told(
            Some(&push),
            Some(&relay(address)),
            note(PrPhase::Reviewed).message(),
        )
        .await;

        assert_eq!(
            relaying.join().expect("the relay"),
            "web: PR #21 has a new review"
        );
        assert!(
            pushed.join().expect("the push service"),
            "the relay came first"
        );
        assert_eq!(outcome, Ok(()));
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

    /// A dashboard is on screen, and it named no device.
    fn open() -> Watched {
        Watched {
            anyone: true,
            devices: HashSet::new(),
        }
    }

    /// The dashboard of the device at `endpoint` is on screen.
    fn on_screen(endpoint: String) -> Watched {
        Watched {
            anyone: true,
            devices: HashSet::from([endpoint]),
        }
    }

    /// A `Push` with two devices at one push service: `/push/abc`, whose
    /// endpoint this gives as the laptop, and `/push/phone` with its keys.
    async fn laptop_and_phone() -> (Push, TcpListener, String, p256::SecretKey, [u8; 16]) {
        let service = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = service.local_addr().expect("the port it got");
        let (push, laptop, ..) = crate::push::tests::pushing_at(address).await;
        let (_, secret, auth) = crate::push::tests::another(&push, address, "phone").await;
        (push, service, laptop.endpoint, secret, auth)
    }

    /// Nothing has connected to `listener`.
    fn silent(listener: &TcpListener) -> bool {
        listener.set_nonblocking(true).expect("a nonblocking check");
        listener.accept().is_err()
    }

    /// The path in a request's first line.
    fn path(head: &str) -> String {
        head.split(' ').nth(1).unwrap_or_default().to_owned()
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
