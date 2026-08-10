//! When to look. What a look *means* is [`yantra_core::snapshot`]'s (ADR-0012).
//!
//! Nothing here awaits ssh on behalf of a request: the tasks below look on
//! their own schedule and write into the snapshot, and a handler reads memory.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::RwLock;
use yantra_core::inventory::Inventory;
use yantra_core::notify::Relay;
use yantra_core::snapshot::{Reading, Snapshot};
use yantra_core::{doctor, sessions, status, workspace};

use crate::notify::Notifier;

/// `ssh.rs` sets `ControlPersist=300`, so anything under five minutes keeps
/// every ssh master warm — the poll is what makes the fleet fast rather than a
/// tax on it. Q6 is why it is a constant: one owner, one fleet, nothing to tune.
const EVERY: Duration = Duration::from_secs(30);

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
pub fn spawn<I: Inventory + Send + Sync + 'static>(
    model: &Model,
    inventory: I,
    relay: Option<Relay>,
) {
    let machines = model.clone();
    tokio::spawn(async move {
        loop {
            look_at_machines(&machines, &inventory).await;
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
    tokio::spawn(async move {
        let mut notifier = relay.map(Notifier::new);
        loop {
            look_at_agents(&agents, notifier.as_mut()).await;
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

    let github = model.clone();
    tokio::spawn(async move {
        loop {
            look_at_github(&github).await;
            tokio::time::sleep(EVERY).await;
        }
    });
}

async fn look_at_machines<I: Inventory>(model: &Model, inventory: &I) {
    let reading = Reading::new(inventory.machines().await);
    model.write().await.machines = Some(Arc::new(reading));
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

/// The one look that touches no machine in the fleet: `gh` runs here, so this is
/// what the readiness sweep beside it cannot ask. Its own task rather than a
/// line in that one because a local probe must not queue behind a `ConnectTimeout`
/// per asleep machine, and it is on a task at all because `gh auth status` is a
/// network call — the rule keeping ssh off the request path, for the same reason.
async fn look_at_github(model: &Model) {
    let reading = Reading::new(doctor::github().await);
    model.write().await.github = Some(Arc::new(reading));
}

/// The reading lands in the model before anything is sent, so a browser never
/// waits on a relay — and a look that *failed* tells nobody anything, because
/// an unknown fleet is not a changed one (I-47).
async fn look_at_agents(model: &Model, notifier: Option<&mut Notifier>) {
    let reading = Arc::new(Reading::new(status::fleet().await));
    model.write().await.agents = Some(reading.clone());
    if let (Some(notifier), Ok(fleet)) = (notifier, reading.value()) {
        notifier.tell(fleet).await;
    }
}

#[cfg(test)]
// `expect` in a test is a deliberate abort with a message; the workspace lint
// targets the daemon, where the same call would take it down.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use std::net::IpAddr;
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

        look_at_machines(&model, &Fake::default()).await;

        let reading = model.read().await.machines.clone().expect("looked");
        let machines = reading.value().as_ref().expect("the tailnet answered");
        assert!(machines.is_empty());
    }

    #[tokio::test]
    async fn a_reading_is_stamped_when_it_is_taken_and_ages_from_there() {
        let model = Model::default();
        let inventory = Fake {
            machines: vec![machine("pi")],
            ..Fake::default()
        };
        look_at_machines(&model, &inventory).await;

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
        look_at_machines(&model, &Down).await;

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
}
