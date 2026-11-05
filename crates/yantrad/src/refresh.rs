//! When to look. What a look *means* is [`yantra_core::snapshot`]'s (ADR-0012).
//!
//! Nothing here awaits ssh on behalf of a request: the tasks below look on
//! their own schedule and write into the snapshot, and a handler reads memory.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::RwLock;
use yantra_core::attention::Forge;
use yantra_core::github::{self, Github};
use yantra_core::inventory::{Inventory, MachineInfo, Os, Ownership};
use yantra_core::notify::Relay;
use yantra_core::snapshot::{Readiness, Reading, Snapshot};
use yantra_core::{doctor, sessions, status, workspace};

use crate::events::{self, Event, Events};
use crate::github::Grant;
use crate::heartbeat::Fleet;
use crate::notify::{Notifier, Teller, Viewers};
use crate::watch;

/// `ssh.rs` sets `ControlPersist=300`, so anything under five minutes keeps
/// every ssh master warm — the poll is what makes the fleet fast rather than a
/// tax on it. Q6 is why it is a constant: one owner, one fleet, nothing to tune.
const EVERY: Duration = Duration::from_secs(30);

/// How long a verb's wake waits before it looks again (Y-639). `up` and
/// `resume` return before `claude` registers: a fresh one took about 0.85 s to
/// appear on the laptop, and the Mac or a Pi is slower. The first look
/// after the wake then reads the agent as unclear, and this look corrects it.
const SETTLE: Duration = Duration::from_secs(5);

/// The looks that leave the tailnet, and where the sentence above inverts: a
/// GitHub poll warms nothing and is spent from the owner's own quota, which
/// their `gh` and their `git push` draw on too. GitHub asks for this directly
/// — `/notifications` answered `X-Poll-Interval: 60` on 2026-08-10, so `EVERY`
/// would poll it at twice the rate its server requests. Three classes share
/// it since Y-342: the inbox, the repository list, and the grant check.
const ATTENTION: Duration = Duration::from_secs(300);

/// M16 §3.6, after T3 Code: each watched PR is read every two minutes. The
/// reads are conditional, so a PR that did not change spends no quota.
const PULLS: Duration = Duration::from_secs(120);

/// ADR-0027 §2: the published version is read hourly and never on the
/// request path. One call an hour fits even GitHub's anonymous sixty.
const RELEASE: Duration = Duration::from_secs(3600);

pub type Model = Arc<RwLock<Snapshot>>;

/// One task per class. A fleet-wide session query costs a full `ConnectTimeout`
/// for every machine that is asleep, and the two cheap classes must not queue
/// behind it.
///
/// The agent class is the expensive one and the only one that is not fleet-wide
/// by construction, so [`yantra_core::status::fleet`] groups it by machine —
/// which is what keeps `EVERY` affordable as workspaces are added.
///
/// It is also the one the notifier reads: two consecutive agent readings are
/// the whole of its input, so `relay` adds a send to a loop that already exists
/// rather than a loop of its own.
///
/// The three classes the `grant` answers reach off the tailnet, and are the
/// ones not on `EVERY` — see [`ATTENTION`] for why. **They also wake when the
/// grant changes**, so a sign-in shows its repositories now and a logout
/// empties them now, rather than at the next tick.
pub fn spawn<I: Inventory + Send + Sync + 'static>(
    fleet: &Fleet,
    inventory: I,
    grant: Grant,
    relay: Option<Relay>,
    pulls_relay: Option<Relay>,
) {
    let model = &fleet.model;
    let viewers = fleet.viewers.clone();

    let machines = model.clone();
    let flips = fleet.events.clone();
    tokio::spawn(async move {
        loop {
            look_at_machines(&machines, &inventory, &flips).await;
            tokio::time::sleep(EVERY).await;
        }
    });

    let workspaces = model.clone();
    tokio::spawn(async move {
        loop {
            look_at_workspaces(&workspaces).await;
            tokio::time::sleep(EVERY).await;
        }
    });

    let sessions = model.clone();
    let chats = fleet.chats.clone();
    tokio::spawn(async move {
        loop {
            look_at_sessions(&sessions, &chats).await;
            tokio::time::sleep(EVERY).await;
        }
    });

    let agents = model.clone();
    let remembered = fleet.events.clone();
    let woken = fleet.look_at_agents.clone();
    tokio::spawn(async move {
        let mut notifier = Notifier::new(relay);
        let mut settling = false;
        loop {
            look_at_agents(&agents, &mut notifier, &viewers, &remembered).await;
            tick_or_verb(&woken, &mut settling).await;
        }
    });

    let readiness = model.clone();
    tokio::spawn(async move {
        loop {
            look_at_readiness(&readiness).await;
            tokio::time::sleep(EVERY).await;
        }
    });

    let attention = model.clone();
    let forge = grant.clone();
    tokio::spawn(async move {
        loop {
            look_at_attention(&attention, &forge).await;
            tick_or_change(&forge).await;
        }
    });

    let github = model.clone();
    let checked = grant.clone();
    tokio::spawn(async move {
        loop {
            look_at_github(&github, &checked).await;
            tick_or_change(&checked).await;
        }
    });

    let release = model.clone();
    let reader = grant.clone();
    tokio::spawn(async move {
        loop {
            look_at_release(&release, &reader, &Github::default()).await;
            tokio::time::sleep(RELEASE).await;
        }
    });

    let pulls = fleet.pulls.clone();
    let reading = grant.clone();
    let (watchers, told) = (fleet.viewers.clone(), fleet.events.clone());
    tokio::spawn(async move {
        let mut teller = Teller::new(pulls_relay);
        let github = Github::default();
        loop {
            let token = reading.token().await;
            watch::poll(&pulls, &github, token, &mut teller, &watchers, &told).await;
            tokio::time::sleep(PULLS).await;
        }
    });

    // Also the rebuild at start: the watch keeps nothing across a restart.
    // Only that first pass is a baseline; a PR found later is new.
    let found = fleet.pulls.clone();
    let finding = grant.clone();
    tokio::spawn(async move {
        let github = Github::default();
        let mut rebuilt = false;
        loop {
            let token = finding.token().await;
            rebuilt |= watch::discover(&found, &github, token, !rebuilt).await;
            tick_or_change(&finding).await;
        }
    });

    let repos = model.clone();
    tokio::spawn(async move {
        loop {
            look_at_repos(&repos, &grant).await;
            tick_or_change(&grant).await;
        }
    });
}

async fn tick_or_change(grant: &Grant) {
    tokio::select! {
        () = tokio::time::sleep(ATTENTION) => {}
        () = grant.changed() => {}
    }
}

/// A verb's wake costs two looks: one now, and one [`SETTLE`] later.
async fn tick_or_verb(woken: &tokio::sync::Notify, settling: &mut bool) {
    if std::mem::take(settling) {
        tokio::time::sleep(SETTLE).await;
        return;
    }
    tokio::select! {
        () = tokio::time::sleep(EVERY) => {}
        () = woken.notified() => *settling = true,
    }
}

/// The one diff this sweep makes (ADR-0025): a machine the last look had
/// online and this one does not is remembered as `unreachable`. The first look
/// after a start has nothing to diff against, and a look that failed says
/// nothing, for the notifier's reason — an unknown fleet is not a changed one.
async fn look_at_machines<I: Inventory>(model: &Model, inventory: &I, events: &Events) {
    let reading = Arc::new(Reading::new(inventory.machines().await));
    let before = model.write().await.machines.replace(reading.clone());

    let was_online = |id: &str| {
        before
            .as_deref()
            .map(Reading::value)
            .and_then(|looked| looked.as_ref().ok())
            .is_some_and(|machines| machines.iter().any(|m| m.id == id && m.online))
    };
    if let Ok(machines) = reading.value() {
        for machine in machines.iter().filter(|m| !m.online && was_online(&m.id)) {
            events::remember(events, Event::unreachable(&machine.name)).await;
        }
    }
}

async fn look_at_workspaces(model: &Model) {
    let reading = Reading::new(workspace::list());
    model.write().await.workspaces = Some(Arc::new(reading));
}

/// Also adopts each Chat keeper no task of this daemon reads, so a turn that
/// outlived a restart is read again within one pass (ADR-0035 decision 9).
async fn look_at_sessions(model: &Model, chats: &crate::chat::Registry) {
    let reading = Reading::new(sessions::list().await);
    if let Ok(machines) = reading.value() {
        for session in machines.iter().flat_map(|machine| &machine.keepers) {
            if !chats.holds(session)
                && let Some(keeper) = yantra_core::keep::Keeper::parse(session)
            {
                let chats = chats.clone();
                tokio::spawn(async move {
                    crate::chat::adopt(&chats, keeper.workspace(), keeper.thread()).await;
                });
            }
        }
    }
    model.write().await.sessions = Some(Arc::new(reading));
}

/// The dearest look of the five — twelve checks over ssh per machine — and the
/// reason it is a look rather than a handler: `doctor` costs a browser poll far
/// more than a session list does, and the rule about ssh on the request path is
/// this module's whole subject. The `term` is [`crate::write::term`]'s, because
/// nobody is sitting at this one either (I-36). An install runs it early (Y-386).
///
/// It also asks each online peer the dashboard counts as a machine (Y-579). The
/// peers come from the last machines reading, so this adds no `tailscale` call.
pub(crate) async fn look_at_readiness(model: &Model) {
    let peers = candidates(&*model.read().await);
    let reading = Reading::new(doctor::fleet_with(&peers, crate::write::term()).await);
    settle(&mut *model.write().await, reading);
}

/// `runsSessions` in `web/src/lib/platform.ts`: the checks feed the dashboard's
/// counts, and a node it does not admit is never counted (D7 S2, Y-404).
fn counted(machine: &MachineInfo) -> bool {
    machine.ownership == Ownership::Yours && matches!(machine.os, Os::Linux | Os::MacOs)
}

fn candidates(snapshot: &Snapshot) -> Vec<String> {
    let tailnet = snapshot.machines.as_deref().map(Reading::value);
    tailnet
        .and_then(|looked| looked.as_ref().ok())
        .into_iter()
        .flatten()
        .filter(|machine| machine.online && counted(machine))
        .map(|machine| machine.name.clone())
        .collect()
}

/// A sweep's reading lands here. A failed sweep says nothing about any machine,
/// so it changes no kept check. An `Ok` sweep drops only a name that neither it
/// nor the tailnet holds: `POST …/readiness` takes any name, so the map would
/// otherwise grow without limit. No tailnet reading means nothing is known to
/// be gone.
pub(crate) fn settle(snapshot: &mut Snapshot, reading: Readiness) {
    if let Ok(reports) = reading.value() {
        for report in reports {
            snapshot.keep(report.clone());
        }
        let tailnet = snapshot.machines.as_deref().map(Reading::value);
        if let Some(Ok(tailnet)) = tailnet {
            snapshot.checks.retain(|name, _| {
                reports.iter().any(|report| report.machine == *name)
                    || tailnet.iter().any(|machine| machine.name == *name)
            });
        }
    }
    snapshot.readiness = Some(Arc::new(reading));
}

/// Three round trips to GitHub, which is why it is here and not in a handler:
/// a browser polls whether or not anyone is looking. No grant is a failed
/// reading carrying why, never an empty inbox — nothing waiting and nothing
/// asked are the two answers this daemon must never fold together (R-23).
async fn look_at_attention<F: Forge>(model: &Model, forge: &F) {
    let reading = Reading::new(forge.attention().await);
    model.write().await.attention = Some(Arc::new(reading));
}

/// The one look that touches no machine in the fleet: whether the grant this
/// daemon holds is still accepted, which the readiness sweep beside it cannot
/// ask. Its own task because a local answer must not queue behind a
/// `ConnectTimeout` per asleep machine. A grant from the environment learns
/// its account here; one the daemon made already knows it.
async fn look_at_github(model: &Model, grant: &Grant) {
    let asked = match grant.token().await {
        None => None,
        Some(token) => Some(Github::default().account(&token).await),
    };
    if let Some(Ok(account)) = &asked {
        grant.learned(account.clone()).await;
    }
    let asked = asked.map(|asked| asked.map(|account| account.login));
    let reading = Reading::new(doctor::github(asked.as_ref()));
    model.write().await.github = Some(Arc::new(reading));
}

/// Every repository the grant can see, for New session to search **in the
/// browser**: a typed box polls, and a read handler never awaits the network.
async fn look_at_repos(model: &Model, grant: &Grant) {
    let repos = match grant.token().await {
        None => Err(github::Error::NoGrant),
        Some(token) => Github::default().repos(&token).await,
    };
    model.write().await.repos = Some(Arc::new(Reading::new(repos)));
}

/// The newest published release, with the grant when there is one and
/// anonymously when there is not (ADR-0027 §4).
async fn look_at_release(model: &Model, grant: &Grant, github: &Github) {
    let token = grant.token().await;
    let release = github.latest_release(token.as_ref()).await;
    model.write().await.release = Some(Arc::new(Reading::new(release)));
}

/// The reading lands in the model before anything is sent, so a browser never
/// waits on a relay — and a look that *failed* tells nobody anything, because
/// an unknown fleet is not a changed one (I-47).
async fn look_at_agents(
    model: &Model,
    notifier: &mut Notifier,
    viewers: &Viewers,
    events: &Events,
) {
    let reading = Arc::new(Reading::new(status::fleet().await));
    model.write().await.agents = Some(reading.clone());
    if let Ok(fleet) = reading.value() {
        notifier
            .tell(fleet, crate::notify::watched(viewers).await, events)
            .await;
    }
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets the daemon, where the same call would take it down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use std::net::IpAddr;
    use yantra_core::attention::{self, Attention};
    use yantra_core::inventory::Fake;
    use yantra_core::sessions::MachineSessions;

    fn machine(name: &str) -> MachineInfo {
        MachineInfo {
            ownership: Ownership::Yours,
            id: format!("n-{name}"),
            name: name.to_string(),
            dns_name: format!("{name}.example.ts.net."),
            os: Os::Linux,
            online: true,
            last_seen: None,
            expired: false,
            key_expires: None,
            addresses: Vec::new(),
        }
    }

    /// Y-639: a verb wakes the agent sweep, even one that lands while a look is
    /// running, and with no verb the sweep waits out `EVERY`.
    #[tokio::test(start_paused = true)]
    async fn a_verb_wakes_the_agent_sweep_before_every() {
        let woken = tokio::sync::Notify::new();
        let mut settling = false;
        let start = tokio::time::Instant::now();
        woken.notify_one();
        tick_or_verb(&woken, &mut settling).await;
        assert!(start.elapsed() < SETTLE);

        tick_or_verb(&woken, &mut settling).await;
        assert!(start.elapsed() >= SETTLE && start.elapsed() < EVERY);

        tick_or_verb(&woken, &mut settling).await;
        assert!(start.elapsed() >= SETTLE + EVERY);
    }

    /// Y-639: `up` returns before `claude` registers, so the look the verb
    /// wakes finds no agent. The sweep looks again before `EVERY`, and the
    /// agent reads as running then.
    #[tokio::test(start_paused = true)]
    async fn an_agent_that_registers_after_up_reads_as_running_before_every() {
        let woken = Arc::new(tokio::sync::Notify::new());
        let readings = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut registry = vec![true, false, false];
        let (waking, seen) = (woken.clone(), readings.clone());
        let sweep = tokio::spawn(async move {
            let mut settling = false;
            loop {
                let registered = registry.pop().unwrap_or(true);
                seen.lock()
                    .expect("readings")
                    .push((tokio::time::Instant::now(), registered));
                tick_or_verb(&waking, &mut settling).await;
            }
        });

        tokio::time::sleep(Duration::from_secs(1)).await;
        let up = tokio::time::Instant::now();
        woken.notify_one();
        tokio::time::sleep(SETTLE + Duration::from_secs(1)).await;
        sweep.abort();

        let readings = readings.lock().expect("readings").clone();
        let after: Vec<_> = readings.iter().filter(|(at, _)| *at >= up).collect();
        assert_eq!(after.len(), 2, "{readings:?}");
        assert!(!after[0].1, "the first look after up finds no agent");
        assert!(after[1].1, "the second look finds it");
        assert!(after[1].0 - up < EVERY);
    }

    /// I-47's lesson in the read model: a browser that arrives before the first
    /// refresh must be told nobody has looked, not that the tailnet is empty.
    #[tokio::test]
    async fn nobody_has_looked_yet_is_not_the_same_answer_as_nothing_is_there() {
        let model = Model::default();
        assert!(model.read().await.machines.is_none());

        look_at_machines(&model, &Fake::default(), &Events::default()).await;

        let reading = model.read().await.machines.clone().expect("looked");
        let machines = reading.value().as_ref().expect("the tailnet answered");
        assert!(machines.is_empty());
    }

    /// ADR-0025's one new diff: a machine that was online and is not now is an
    /// event, once — and the first look after a start, which has no previous
    /// reading, says nothing about a machine that is offline from the start.
    #[tokio::test]
    async fn a_machine_that_stops_being_online_is_remembered_once() {
        let model = Model::default();
        let events = Events::default();
        let looking = |online: bool| Fake {
            machines: vec![MachineInfo {
                ownership: yantra_core::inventory::Ownership::Yours,
                online,
                ..machine("pi")
            }],
            ..Fake::default()
        };

        look_at_machines(&model, &looking(false), &events).await;
        assert!(events.read().await.is_empty(), "nothing to diff against");

        look_at_machines(&model, &looking(true), &events).await;
        look_at_machines(&model, &looking(false), &events).await;
        look_at_machines(&model, &looking(false), &events).await;

        let remembered = events::newest_first(&events).await;
        assert_eq!(remembered.len(), 1, "{remembered:?}");
        assert_eq!(remembered[0].kind, "unreachable");
        assert_eq!(remembered[0].machine.as_deref(), Some("pi"));
        assert_eq!(remembered[0].workspace, None);
    }

    #[tokio::test]
    async fn a_reading_is_stamped_when_it_is_taken_and_ages_from_there() {
        let model = Model::default();
        let inventory = Fake {
            machines: vec![machine("pi")],
            ..Fake::default()
        };
        look_at_machines(&model, &inventory, &Events::default()).await;

        let reading = model.read().await.machines.clone().expect("looked");
        let first = reading.age();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(reading.age() >= first + Duration::from_millis(20));
    }

    /// A tailnet that cannot be asked is a fourth state, and folding it into
    /// "nobody has looked yet" would make a permanently broken daemon look like
    /// one that had just started.
    #[tokio::test]
    async fn a_look_that_failed_is_recorded_rather_than_left_looking_untaken() {
        struct Down;
        impl Inventory for Down {
            async fn machines(&self) -> Result<Vec<MachineInfo>, yantra_core::inventory::Error> {
                Err(yantra_core::inventory::Error::Command {
                    stderr: "failed to connect to local tailscaled".into(),
                })
            }
            async fn addresses(&self) -> Result<Vec<IpAddr>, yantra_core::inventory::Error> {
                unreachable!("the refresher only asks for machines")
            }
            async fn whois(
                &self,
                _address: IpAddr,
            ) -> Result<Option<yantra_core::inventory::Caller>, yantra_core::inventory::Error>
            {
                unreachable!("no write is authorised here")
            }
            async fn owner(&self) -> Result<u64, yantra_core::inventory::Error> {
                unreachable!("no write is authorised here")
            }
        }

        let model = Model::default();
        look_at_machines(&model, &Down, &Events::default()).await;

        let reading = model.read().await.machines.clone().expect("looked");
        let failure = reading.value().as_ref().expect_err("the look failed");
        assert!(failure.to_string().contains("tailscaled"));
    }

    /// Y-054's rule surviving the cache: the machine that timed out is in the
    /// answer a handler serves, carrying why.
    #[tokio::test]
    async fn a_machine_that_did_not_answer_is_reported_and_not_dropped() {
        let model = Model::default();
        model.write().await.sessions = Some(Arc::new(Reading::new(Ok(vec![
            MachineSessions {
                machine: "pi".into(),
                sessions: Ok(Vec::new()),
                keepers: Vec::new(),
            },
            MachineSessions {
                machine: "macbook".into(),
                sessions: Err(sessions::Error::Interrupted {
                    machine: "macbook".into(),
                    reason: "connection timed out".into(),
                }),
                keepers: Vec::new(),
            },
        ]))));

        let served = model.read().await.clone();
        let reading = served.sessions.expect("looked");
        let answers = reading.value().as_ref().expect("the fleet was asked");
        assert_eq!(
            answers
                .iter()
                .map(|a| a.machine.as_str())
                .collect::<Vec<_>>(),
            ["pi", "macbook"]
        );
        let unreachable = answers[1]
            .sessions
            .as_ref()
            .expect_err("macbook did not answer");
        assert!(unreachable.to_string().contains("connection timed out"));
    }

    fn report(name: &str, detail: &str) -> doctor::Report {
        doctor::Report {
            machine: name.to_string(),
            checks: vec![doctor::Check {
                check: "reachable",
                state: doctor::State::Present,
                detail: detail.to_string(),
                took_ms: None,
            }],
        }
    }

    fn detail(snapshot: &Snapshot, name: &str) -> String {
        snapshot.checks[name].value().checks[0].detail.clone()
    }

    fn on_the_tailnet(machines: Vec<MachineInfo>) -> Snapshot {
        Snapshot {
            machines: Some(Arc::new(Reading::new(Ok(machines)))),
            ..Snapshot::default()
        }
    }

    fn failed_sweep() -> Readiness {
        Reading::new(Err(doctor::Error::Interrupted {
            machine: "pi".into(),
            reason: "the task stopped".into(),
        }))
    }

    /// An unknown fleet is not a changed one, and the sweep beside it still
    /// reads as failed for a client that asks.
    #[test]
    fn a_failed_sweep_keeps_every_result_and_is_still_recorded() {
        let mut snapshot = on_the_tailnet(vec![machine("pi")]);
        settle(&mut snapshot, Reading::new(Ok(vec![report("pi", "old")])));

        settle(&mut snapshot, failed_sweep());

        assert_eq!(detail(&snapshot, "pi"), "old");
        let last = snapshot.readiness.expect("the sweep was recorded");
        assert!(last.value().is_err());
    }

    #[test]
    fn a_sweep_that_answered_replaces_the_report_the_machine_had() {
        let mut snapshot = on_the_tailnet(vec![machine("pi")]);
        settle(&mut snapshot, Reading::new(Ok(vec![report("pi", "old")])));
        settle(&mut snapshot, Reading::new(Ok(vec![report("pi", "new")])));
        assert_eq!(detail(&snapshot, "pi"), "new");
    }

    /// `POST …/readiness` takes any name, so this is what bounds the map.
    #[test]
    fn a_name_gone_from_the_tailnet_and_the_sweep_is_dropped() {
        let mut snapshot = on_the_tailnet(vec![machine("pi")]);
        snapshot.keep(report("typo", "eleven unknowns"));

        settle(&mut snapshot, Reading::new(Ok(vec![report("pi", "new")])));

        assert!(!snapshot.checks.contains_key("typo"));
        assert!(snapshot.checks.contains_key("pi"));
    }

    #[test]
    fn an_offline_machine_the_sweep_skipped_keeps_its_result() {
        let mut snapshot = on_the_tailnet(vec![MachineInfo {
            online: false,
            ..machine("pi")
        }]);
        snapshot.keep(report("pi", "from before it slept"));

        assert!(candidates(&snapshot).is_empty(), "offline is not asked");
        settle(&mut snapshot, Reading::new(Ok(Vec::new())));

        assert_eq!(detail(&snapshot, "pi"), "from before it slept");
    }

    /// With no tailnet reading nothing says a name is gone, so nothing goes.
    #[test]
    fn a_tailnet_that_could_not_be_read_drops_nothing() {
        let mut snapshot = Snapshot {
            machines: Some(Arc::new(Reading::new(Err(
                yantra_core::inventory::Error::Command {
                    stderr: "failed to connect to local tailscaled".into(),
                },
            )))),
            ..Snapshot::default()
        };
        snapshot.keep(report("pi", "kept"));

        assert!(candidates(&snapshot).is_empty());
        settle(&mut snapshot, Reading::new(Ok(Vec::new())));

        assert_eq!(detail(&snapshot, "pi"), "kept");
    }

    #[test]
    fn the_sweep_asks_the_tailnet_computers_and_no_phone() {
        let snapshot = on_the_tailnet(vec![
            machine("g14"),
            MachineInfo {
                os: Os::Ios,
                ..machine("iphone")
            },
        ]);
        assert_eq!(candidates(&snapshot), ["g14"]);
    }

    /// D7 S2: a node `runsSessions` does not admit gets no check and no count,
    /// and `GET /api/readiness` is what the Settings count divides by.
    #[test]
    fn the_sweep_asks_only_the_machines_the_dashboard_counts() {
        let snapshot = on_the_tailnet(vec![
            machine("g14"),
            MachineInfo {
                os: Os::MacOs,
                ..machine("mac")
            },
            MachineInfo {
                os: Os::Windows,
                ..machine("pc")
            },
            MachineInfo {
                os: Os::Other("freebsd".into()),
                ..machine("bsd")
            },
            MachineInfo {
                ownership: Ownership::Shared,
                ..machine("friend")
            },
            MachineInfo {
                ownership: Ownership::Tagged,
                ..machine("server")
            },
        ]);
        assert_eq!(candidates(&snapshot), ["g14", "mac"]);
    }

    /// The same shape as the port: settable nowhere, and low enough that every
    /// ssh master is still warm when the next look starts (`ControlPersist=300`).
    #[test]
    fn the_interval_is_a_constant_not_configuration() {
        assert_eq!(EVERY, Duration::from_secs(30));
        assert!(EVERY < Duration::from_secs(300));
    }

    /// GitHub's own floor, measured rather than chosen: `/notifications`
    /// answers `X-Poll-Interval: 60`, so the fleet's interval is one this
    /// daemon is asked not to use against that server.
    #[test]
    fn the_feed_is_polled_slower_than_the_fleet_because_the_quota_is_not_ours() {
        assert!(ATTENTION >= Duration::from_secs(60));
        assert!(ATTENTION > EVERY);
    }

    /// [`attention::Error`] carries a `serde_json::Error` and is not `Clone`,
    /// so the absent half is a `None` the fake turns into one.
    struct Inbox(Option<Attention>);

    impl Forge for Inbox {
        async fn attention(&self) -> Result<Attention, attention::Error> {
            self.0.clone().ok_or(attention::Error::NoGrant)
        }
    }

    #[tokio::test]
    async fn the_feed_is_a_reading_of_its_own_that_ages_from_when_it_was_taken() {
        let model = Model::default();
        assert!(model.read().await.attention.is_none());

        look_at_attention(
            &model,
            &Inbox(Some(Attention {
                notifications: 27,
                ..Attention::default()
            })),
        )
        .await;

        let reading = model.read().await.attention.clone().expect("looked");
        let first = reading.age();
        assert_eq!(
            reading.value().as_ref().expect("gh answered").notifications,
            27
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(reading.age() >= first + Duration::from_millis(20));
    }

    /// A daemon nobody has signed in is the commonest state this class has —
    /// and an empty inbox is what it must never look like, because nothing
    /// waiting is an answer a person acts on.
    #[tokio::test]
    async fn no_grant_is_a_failed_reading_and_not_an_empty_inbox() {
        let model = Model::default();
        look_at_attention(&model, &Inbox(None)).await;

        let reading = model.read().await.attention.clone().expect("looked");
        let failure = reading.value().as_ref().expect_err("the look failed");
        assert!(failure.to_string().contains("no GitHub grant"), "{failure}");
    }

    /// The same rule for the repository list: no grant is a failed look that
    /// names the remedy, and nothing is asked of GitHub to learn it.
    #[tokio::test]
    async fn repos_without_a_grant_are_a_failed_reading_that_names_the_login() {
        let model = Model::default();
        look_at_repos(&model, &Grant::default()).await;

        let reading = model.read().await.repos.clone().expect("looked");
        let failure = reading.value().as_ref().expect_err("the look failed");
        assert!(
            failure.to_string().contains("yantra github login"),
            "{failure}"
        );
    }

    /// No grant is *absent* on the check, earned without a network call.
    #[tokio::test]
    async fn the_grant_check_without_a_grant_is_absent_and_asks_nothing() {
        let model = Model::default();
        look_at_github(&model, &Grant::default()).await;

        let reading = model.read().await.github.clone().expect("looked");
        assert_eq!(reading.value().state, doctor::State::Absent);
        assert!(reading.value().detail.contains("yantra github login"));
    }

    /// ADR-0027 §2: a GitHub that could not be asked is a failed reading,
    /// which About draws as a failure and never as *current*.
    #[tokio::test]
    async fn a_release_read_that_failed_is_stored_as_failed() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let gone = format!("http://{}", listener.local_addr().expect("its address"));
        drop(listener);

        let model = Model::default();
        look_at_release(&model, &Grant::default(), &Github::at(&gone, &gone)).await;

        let reading = model.read().await.release.clone().expect("looked");
        let failure = reading.value().as_ref().expect_err("the look failed");
        assert!(
            matches!(failure, github::Error::Unreachable { .. }),
            "{failure}"
        );
    }

    #[test]
    fn the_release_is_read_hourly_and_no_faster_than_the_feed() {
        assert_eq!(RELEASE, Duration::from_secs(3600));
        assert!(RELEASE > ATTENTION);
    }
}
