//! When to look. What a look *means* is [`yantra_core::snapshot`]'s (ADR-0012).
//!
//! Nothing here awaits ssh on behalf of a request: the tasks below look on
//! their own schedule and write into the snapshot, and a handler reads memory.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::RwLock;
use yantra_core::attention::Forge;
use yantra_core::github::{self, Github};
use yantra_core::inventory::Inventory;
use yantra_core::notify::Relay;
use yantra_core::snapshot::{Reading, Snapshot};
use yantra_core::{doctor, sessions, status, workspace};

use crate::events::{self, Event, Events};
use crate::github::Grant;
use crate::heartbeat::Fleet;
use crate::notify::{Notifier, Viewers};

/// `ssh.rs` sets `ControlPersist=300`, so anything under five minutes keeps
/// every ssh master warm — the poll is what makes the fleet fast rather than a
/// tax on it. Q6 is why it is a constant: one owner, one fleet, nothing to tune.
const EVERY: Duration = Duration::from_secs(30);

/// The looks that leave the tailnet, and where the sentence above inverts: a
/// GitHub poll warms nothing and is spent from the owner's own quota, which
/// their `gh` and their `git push` draw on too. GitHub asks for this directly
/// — `/notifications` answered `X-Poll-Interval: 60` on 2026-08-10, so `EVERY`
/// would poll it at twice the rate its server requests. Three classes share
/// it since Y-342: the inbox, the repository list, and the grant check.
const ATTENTION: Duration = Duration::from_secs(300);

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
    tokio::spawn(async move {
        loop {
            look_at_sessions(&sessions).await;
            tokio::time::sleep(EVERY).await;
        }
    });

    let agents = model.clone();
    let remembered = fleet.events.clone();
    tokio::spawn(async move {
        let mut notifier = Notifier::new(relay);
        loop {
            look_at_agents(&agents, &mut notifier, &viewers, &remembered).await;
            tokio::time::sleep(EVERY).await;
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

async fn look_at_sessions(model: &Model) {
    let reading = Reading::new(sessions::list().await);
    model.write().await.sessions = Some(Arc::new(reading));
}

/// The dearest look of the five — nine checks over ssh per machine — and the
/// reason it is a look rather than a handler: `doctor` costs a browser poll far
/// more than a session list does, and the rule about ssh on the request path is
/// this module's whole subject. The `term` is [`crate::write::term`]'s, because
/// nobody is sitting at this one either (I-36).
async fn look_at_readiness(model: &Model) {
    let reading = Reading::new(doctor::fleet(crate::write::term()).await);
    model.write().await.readiness = Some(Arc::new(reading));
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
/// its login here; one the daemon made already knows it.
async fn look_at_github(model: &Model, grant: &Grant) {
    let asked = match grant.token().await {
        None => None,
        Some(token) => Some(Github::default().login_name(&token).await),
    };
    if let Some(Ok(login)) = &asked {
        grant.learned(login.clone()).await;
    }
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
    use yantra_core::inventory::{Fake, MachineInfo, Os};
    use yantra_core::sessions::MachineSessions;

    fn machine(name: &str) -> MachineInfo {
        MachineInfo {
            id: format!("n-{name}"),
            name: name.to_string(),
            dns_name: format!("{name}.example.ts.net."),
            os: Os::Linux,
            online: true,
            last_seen: None,
            expired: false,
            addresses: Vec::new(),
        }
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
            },
            MachineSessions {
                machine: "macbook".into(),
                sessions: Err(sessions::Error::Interrupted {
                    machine: "macbook".into(),
                    reason: "connection timed out".into(),
                }),
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
}
